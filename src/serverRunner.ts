import * as vscode from "vscode";
import * as crypto from "crypto";
import { TrykeConfig } from "./config";
import { TrykeClient } from "./client";
import { RunParams } from "./types";
import {
  RunStartParamsSchema,
  TestCompleteParamsSchema,
  RunCompleteParamsSchema,
} from "./schema";
import { reportResult } from "./resultMapper";
import { ensureServer } from "./serverManager";
import { buildTestId } from "./testId";
import { log } from "./log";

// How long to wait for the server's `run_complete` notification after the
// `run` RPC response has come back. The server flushes the response before
// it broadcasts its tail of `test_complete` and `run_complete` notifications,
// so resolving on the response alone calls `testRun.end()` before per-test
// outcomes arrive ("did not record any output" in the panel). 2s is well
// above any normal flush latency on a healthy connection; if it hits, the
// server has almost certainly crashed mid-run and this is the recovery path.
const RUN_COMPLETE_GRACE_MS = 2000;

function generateRunId(): string {
  return `vscode-${crypto.randomUUID()}`;
}

// The minimal client surface dispatchRun needs. TrykeClient implements this;
// tests pass an in-memory fake to drive the dispatcher without a real socket.
export interface DispatchClient {
  onNotification(method: string, handler: (params: unknown) => void): void;
  offNotification(method: string, handler: (params: unknown) => void): void;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  disconnect(): void;
}


export async function runServer(
  request: vscode.TestRunRequest,
  testRun: vscode.TestRun,
  testMap: Map<string, vscode.TestItem>,
  config: TrykeConfig,
  workspaceRoot: string,
  token: vscode.CancellationToken,
): Promise<void> {
  await ensureServer(config, workspaceRoot);

  const client = new TrykeClient();
  await client.connect(config.server.host, config.server.port);

  try {
    await dispatchRun(client, request, testRun, testMap, config, workspaceRoot, token, true);
  } finally {
    client.disconnect();
  }
}

/** Run tests using an existing persistent client (for watch mode). */
export async function runServerWithClient(
  client: DispatchClient,
  request: vscode.TestRunRequest,
  testRun: vscode.TestRun,
  testMap: Map<string, vscode.TestItem>,
  config: TrykeConfig,
  workspaceRoot: string,
  token: vscode.CancellationToken,
): Promise<void> {
  // The persistent client's notification handlers are owned by `dispatchRun`
  // — it registers a fresh set per call and removes them itself once the
  // run is fully drained. Don't clear here: doing so would race a trailing
  // `test_complete` that's still in flight on the wire when the previous
  // run resolved, dropping it before the next handler set is installed.
  await dispatchRun(client, request, testRun, testMap, config, workspaceRoot, token, false);
}

export async function dispatchRun(
  client: DispatchClient,
  request: vscode.TestRunRequest,
  testRun: vscode.TestRun,
  testMap: Map<string, vscode.TestItem>,
  config: TrykeConfig,
  workspaceRoot: string,
  token: vscode.CancellationToken,
  disconnectOnCancel: boolean,
): Promise<void> {
  const runId = generateRunId();
  log("server: dispatching run with run_id", runId);

  // Notifications are filtered by run_id so a concurrent run on the same
  // server can't pollute our results. Save handler refs as named consts so
  // we can offNotification them in the finally — without that, every
  // watch-mode rerun on a persistent client would leave another set of
  // handlers attached, and the next run would process each notification
  // against a growing list of (mostly inert) closures.
  const onRunStart = (params: unknown): void => {
    const parsed = RunStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      log("server: dropping malformed run_start:", parsed.error.message);
      return;
    }
    const { run_id, tests } = parsed.data;
    if (run_id !== runId) {
      return;
    }
    for (const test of tests) {
      const testId = buildTestId(test, workspaceRoot);
      const testItem = testMap.get(testId);
      if (testItem) {
        testRun.started(testItem);
      }
    }
  };

  const onTestComplete = (params: unknown): void => {
    const parsed = TestCompleteParamsSchema.safeParse(params);
    if (!parsed.success) {
      log("server: dropping malformed test_complete:", parsed.error.message);
      return;
    }
    const { run_id, result } = parsed.data;
    if (run_id !== runId) {
      return;
    }
    const testId = buildTestId(result.test, workspaceRoot);
    const testItem = testMap.get(testId);
    if (testItem) {
      reportResult(testRun, testItem, result);
    }
  };

  // See RUN_COMPLETE_GRACE_MS at module top for why we wait at all.
  let runCompleteSeen = false;
  let runCompleteResolve: (() => void) | undefined;
  const runCompletePromise = new Promise<void>((res) => {
    runCompleteResolve = res;
  });
  const onRunComplete = (params: unknown): void => {
    const parsed = RunCompleteParamsSchema.safeParse(params);
    if (!parsed.success) {
      log("server: dropping malformed run_complete:", parsed.error.message);
      return;
    }
    const { run_id } = parsed.data;
    // Treat `null` (from a Rust Option emitted without skip) the same as
    // `undefined` (truly absent) — both mean "untagged broadcast", which
    // older servers and notifications without an originating run still
    // emit. Either way: accept rather than drop on a per-run filter.
    if (run_id != null && run_id !== runId) {
      return;
    }
    runCompleteSeen = true;
    runCompleteResolve?.();
  };

  client.onNotification("run_start", onRunStart);
  client.onNotification("test_complete", onTestComplete);
  client.onNotification("run_complete", onRunComplete);

  try {
    await new Promise<void>((resolve, reject) => {
      const cancelSub = token.onCancellationRequested(() => {
        cancelSub.dispose();
        if (disconnectOnCancel) {
          client.disconnect();
        }
        resolve();
      });

      const params = buildRunParams(request, config, runId);
      client.request("run", params).then(async () => {
        if (!runCompleteSeen) {
          await Promise.race([
            runCompletePromise,
            new Promise<void>((res) => setTimeout(res, RUN_COMPLETE_GRACE_MS)),
          ]);
        }
        resolve();
      }, reject);
    });
  } finally {
    client.offNotification("run_start", onRunStart);
    client.offNotification("test_complete", onTestComplete);
    client.offNotification("run_complete", onRunComplete);
  }
}

export function buildRunParams(
  request: vscode.TestRunRequest,
  config: TrykeConfig,
  runId: string,
): RunParams {
  const params: RunParams = { run_id: runId };

  if (config.markers != null) {
    params.markers = config.markers;
  }

  if (!request.include?.length) {
    return params;
  }

  const tests: string[] = [];
  const paths: string[] = [];

  for (const item of request.include) {
    if (item.children.size > 0 && !item.id.includes("::")) {
      // File-level item — id is already a relative path
      paths.push(item.id);
    } else if (item.children.size > 0) {
      // Group/namespace item: collect leaf test IDs
      collectLeafServerIds(item, tests);
    } else {
      // Individual test — send as tryke test ID (file::name, no groups)
      const parts = item.id.split("::");
      tests.push(`${parts[0]}::${parts[parts.length - 1]}`);
    }
  }

  if (tests.length > 0) {
    params.tests = tests;
  }
  if (paths.length > 0) {
    params.paths = paths;
  }
  return params;
}

export function collectLeafServerIds(item: vscode.TestItem, ids: string[]): void {
  if (item.children.size === 0) {
    // Strip groups: send file::name (tryke's expected ID format)
    const parts = item.id.split("::");
    ids.push(`${parts[0]}::${parts[parts.length - 1]}`);
  } else {
    item.children.forEach((child) => collectLeafServerIds(child, ids));
  }
}
