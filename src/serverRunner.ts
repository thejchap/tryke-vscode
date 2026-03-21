import * as vscode from "vscode";
import * as path from "path";
import { TrykeConfig } from "./config";
import { TrykeClient } from "./client";
import { TrykeTestResult, RunParams } from "./types";
import { reportResult } from "./resultMapper";
import { ensureServer } from "./serverManager";


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
      const testId = resolveTestId(result.test, workspaceRoot);
      const testItem = testMap.get(testId);
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

  const params: RunParams = {};
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
  test: { name: string; file_path?: string; module_path: string; groups?: string[] },
  workspaceRoot: string,
): string {
  const filePath = test.file_path ?? test.module_path;
  const absPath = path.resolve(workspaceRoot, filePath);
  const relPath = path.relative(workspaceRoot, absPath);
  return [relPath, ...(test.groups ?? []), test.name].join("::");
}
