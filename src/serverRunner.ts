import * as vscode from "vscode";
import { TrykeConfig } from "./config";
import { TrykeClient } from "./client";
import { RunParams, RunStartParams, TestCompleteParams } from "./types";
import { reportResult } from "./resultMapper";
import { ensureServer } from "./serverManager";
import { buildTestId } from "./testId";
import { log } from "./log";

let runCounter = 0;

function generateRunId(): string {
  runCounter += 1;
  return `vscode-${process.pid}-${Date.now().toString(36)}-${runCounter}`;
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
    // The RPC response (not run_complete) is the authoritative terminator:
    // broadcast notifications can be silently dropped under channel lag, but
    // the response cannot. Notifications are filtered by run_id so a
    // concurrent run on the same server can't pollute our results.
    client.onNotification("run_start", (params) => {
      const { run_id, tests } = params as RunStartParams;
      if (run_id !== runId) {
        return;
      }
      if (!tests) {
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
      const { run_id, result } = params as TestCompleteParams;
      if (run_id !== runId) {
        return;
      }
      const testId = buildTestId(result.test, workspaceRoot);
      const testItem = testMap.get(testId);
      if (testItem) {
        reportResult(testRun, testItem, result);
      }
    });

    const cancelSub = token.onCancellationRequested(() => {
      cancelSub.dispose();
      if (disconnectOnCancel) {
        client.disconnect();
      }
      resolve();
    });

    const params = buildRunParams(request, workspaceRoot, config, runId);
    client.request("run", params).then(() => resolve(), reject);
  });
}

function buildRunParams(
  request: vscode.TestRunRequest,
  workspaceRoot: string,
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

function collectLeafServerIds(item: vscode.TestItem, ids: string[]): void {
  if (item.children.size === 0) {
    // Strip groups: send file::name (tryke's expected ID format)
    const parts = item.id.split("::");
    ids.push(`${parts[0]}::${parts[parts.length - 1]}`);
  } else {
    item.children.forEach((child) => collectLeafServerIds(child, ids));
  }
}
