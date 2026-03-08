import * as vscode from "vscode";
import * as path from "path";
import { TrykeConfig } from "./config";
import { TrykeClient } from "./client";
import { TrykeTestResult, RunParams } from "./types";
import { reportResult } from "./resultMapper";
import { ensureServer } from "./serverManager";
import { testIdFromResult } from "./directRunner";

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

async function runWithClient(
  client: TrykeClient,
  request: vscode.TestRunRequest,
  testRun: vscode.TestRun,
  testMap: Map<string, vscode.TestItem>,
  config: TrykeConfig,
  workspaceRoot: string,
  token: vscode.CancellationToken,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Register notification handlers before sending request
    client.onNotification("test_complete", (params) => {
      const { result } = params as { result: TrykeTestResult };
      const testId = resolveTestId(result.test, testMap, workspaceRoot);
      const testItem = testId ? testMap.get(testId) : undefined;
      if (testItem) {
        reportResult(testRun, testItem, result);
      }
    });

    client.onNotification("run_complete", () => {
      resolve();
    });

    token.onCancellationRequested(() => {
      client.disconnect();
      resolve();
    });

    // Build run params
    const params = buildRunParams(request, workspaceRoot);

    client.request("run", params).catch(reject);
  });
}

function buildRunParams(
  request: vscode.TestRunRequest,
  workspaceRoot: string,
): RunParams {
  if (!request.include?.length) {
    return {};
  }

  const tests: string[] = [];
  const paths: string[] = [];

  for (const item of request.include) {
    if (item.children.size > 0) {
      // File-level item
      if (item.uri) {
        paths.push(item.uri.fsPath);
      }
    } else {
      // Individual test — send as tryke test ID
      tests.push(item.id);
    }
  }

  const params: RunParams = {};
  if (tests.length > 0) {
    params.tests = tests;
  }
  if (paths.length > 0) {
    params.paths = paths;
  }
  return params;
}

function resolveTestId(
  test: { name: string; file_path?: string; module_path: string },
  testMap: Map<string, vscode.TestItem>,
  workspaceRoot: string,
): string | undefined {
  // Try relative path format first (matches discovery IDs)
  const filePath = test.file_path ?? test.module_path;
  const relPath = path.relative(workspaceRoot, filePath);
  const relId = `${relPath}::${test.name}`;
  if (testMap.has(relId)) {
    return relId;
  }

  // Try absolute path format (from directRunner's testIdFromResult)
  const absId = testIdFromResult(test);
  if (testMap.has(absId)) {
    return absId;
  }

  return undefined;
}
