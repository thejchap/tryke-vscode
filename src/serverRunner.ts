import * as vscode from "vscode";
import { TrykeConfig } from "./config";
import { TrykeClient } from "./client";
import { TrykeTestResult, RunParams } from "./types";
import { reportResult } from "./resultMapper";
import { ensureServer } from "./serverManager";
import { buildTestId } from "./testId";

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
  await ensureServer(config);

  const client = new TrykeClient();
  await client.connect(config.server.host, config.server.port);

  try {
    await runWithClient(client, request, testRun, testMap, config, workspaceRoot, token);
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
  const runId = generateRunId();
  try {
    // The RPC response (not run_complete) is the authoritative terminator:
    // broadcast notifications can be silently dropped under channel lag, but
    // the response cannot. Notifications are filtered by run_id so a
    // concurrent run on the same server can't pollute our results.
    const runPromise = new Promise<void>((resolve, reject) => {
      client.onNotification("run_start", (params) => {
        const p = params as { run_id?: string; tests: { name: string; file_path?: string; module_path: string; groups?: string[] }[] };
        if (p.run_id !== runId) {
          return;
        }
        if (p.tests) {
          for (const test of p.tests) {
            const testId = resolveTestId(test, workspaceRoot);
            const testItem = testMap.get(testId);
            if (testItem) {
              testRun.started(testItem);
            }
          }
        }
      });

      client.onNotification("test_complete", (params) => {
        const p = params as { run_id?: string; result: TrykeTestResult };
        if (p.run_id !== runId) {
          return;
        }
        const testId = resolveTestId(p.result.test, workspaceRoot);
        const testItem = testMap.get(testId);
        if (testItem) {
          reportResult(testRun, testItem, p.result);
        }
      });

      // On cancellation, resolve without disconnecting the persistent client
      const cancelSub = token.onCancellationRequested(() => {
        cancelSub.dispose();
        resolve();
      });

      const params = buildRunParams(request, workspaceRoot, config, runId);
      client.request("run", params).then(() => resolve(), reject);
    });
    await runPromise;
  } finally {
    client.clearNotificationHandlers();
  }
}

async function runWithClient(
  client: TrykeClient,
  request: vscode.TestRunRequest,
  testRun: vscode.TestRun,
  testMap: Map<string, vscode.TestItem>,
  config: TrykeConfig,
  workspaceRoot: string,
  token: vscode.CancellationToken,
): Promise<void> {
  const runId = generateRunId();
  return new Promise<void>((resolve, reject) => {
    // Register notification handlers before sending request
    client.onNotification("run_start", (params) => {
      const p = params as { run_id?: string; tests: { name: string; file_path?: string; module_path: string; groups?: string[] }[] };
      if (p.run_id !== runId) {
        return;
      }
      if (p.tests) {
        for (const test of p.tests) {
          const testId = resolveTestId(test, workspaceRoot);
          const testItem = testMap.get(testId);
          if (testItem) {
            testRun.started(testItem);
          }
        }
      }
    });

    client.onNotification("test_complete", (params) => {
      const p = params as { run_id?: string; result: TrykeTestResult };
      if (p.run_id !== runId) {
        return;
      }
      const testId = resolveTestId(p.result.test, workspaceRoot);
      const testItem = testMap.get(testId);
      if (testItem) {
        reportResult(testRun, testItem, p.result);
      }
    });

    token.onCancellationRequested(() => {
      client.disconnect();
      resolve();
    });

    const params = buildRunParams(request, workspaceRoot, config, runId);

    // RPC response is the authoritative terminator (not run_complete, which
    // can be dropped under broadcast channel lag).
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

function resolveTestId(
  test: {
    name: string;
    file_path?: string;
    module_path: string;
    groups?: string[];
    case_label?: string;
  },
  workspaceRoot: string,
): string {
  return buildTestId(test, workspaceRoot);
}
