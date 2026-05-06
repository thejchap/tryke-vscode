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
  client: TrykeClient,
  request: vscode.TestRunRequest,
  testRun: vscode.TestRun,
  testMap: Map<string, vscode.TestItem>,
  config: TrykeConfig,
  workspaceRoot: string,
  token: vscode.CancellationToken,
): Promise<void> {
  client.clearNotificationHandlers();
  try {
    await dispatchRun(client, request, testRun, testMap, config, workspaceRoot, token, false);
  } finally {
    client.clearNotificationHandlers();
  }
}

async function dispatchRun(
  client: TrykeClient,
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

  return new Promise<void>((resolve, reject) => {
    // Notifications are filtered by run_id so a concurrent run on the same
    // server can't pollute our results.
    client.onNotification("run_start", (params) => {
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
    });

    client.onNotification("test_complete", (params) => {
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
    });

    // See RUN_COMPLETE_GRACE_MS at module top for why we wait at all.
    let runCompleteSeen = false;
    let runCompleteResolve: (() => void) | undefined;
    const runCompletePromise = new Promise<void>((res) => {
      runCompleteResolve = res;
    });
    client.onNotification("run_complete", (params) => {
      const parsed = RunCompleteParamsSchema.safeParse(params);
      if (!parsed.success) {
        log("server: dropping malformed run_complete:", parsed.error.message);
        return;
      }
      const { run_id } = parsed.data;
      if (run_id !== undefined && run_id !== runId) {
        return;
      }
      runCompleteSeen = true;
      runCompleteResolve?.();
    });

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
