import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import { TrykeEvent, TrykeTestItem } from "./types";
import { TrykeConfig } from "./config";
import { log } from "./log";

export async function discoverTests(
  controller: vscode.TestController,
  config: TrykeConfig,
  workspaceRoot: string,
): Promise<Map<string, vscode.TestItem>> {
  const testMap = new Map<string, vscode.TestItem>();

  const tests = await collectTests(config, workspaceRoot);
  log("discovery: collected", tests.length, "tests in", workspaceRoot);
  if (!tests.length) {
    return testMap;
  }

  // Group tests by file (resolved to absolute paths)
  const byFile = new Map<string, TrykeTestItem[]>();
  for (const test of tests) {
    const rawPath = test.file_path ?? test.module_path;
    const absPath = path.resolve(workspaceRoot, rawPath);
    let group = byFile.get(absPath);
    if (!group) {
      group = [];
      byFile.set(absPath, group);
    }
    group.push(test);
  }

  // Build test tree
  for (const [absPath, fileTests] of byFile) {
    const relPath = path.relative(workspaceRoot, absPath);
    const fileUri = vscode.Uri.file(absPath);
    const fileItem = controller.createTestItem(relPath, relPath, fileUri);
    controller.items.add(fileItem);
    testMap.set(relPath, fileItem);

    for (const test of fileTests) {
      const testId = `${relPath}::${test.name}`;
      const label = test.display_name ?? test.name;
      const testItem = controller.createTestItem(testId, label, fileUri);

      if (test.line_number != null) {
        testItem.range = new vscode.Range(
          new vscode.Position(test.line_number - 1, 0),
          new vscode.Position(test.line_number - 1, 0),
        );
      }

      fileItem.children.add(testItem);
      testMap.set(testId, testItem);
    }
  }

  log("discovery: testMap keys:", [...testMap.keys()]);
  return testMap;
}

function collectTests(
  config: TrykeConfig,
  cwd: string,
): Promise<TrykeTestItem[]> {
  return new Promise((resolve, reject) => {
    const args = ["test", "--collect-only", "--reporter", "json", ...config.args];
    const proc = cp.spawn(config.command, args, { cwd });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn ${config.command}: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `${config.command} exited with code ${code}: ${stderr.trim()}`,
          ),
        );
        return;
      }

      const tests: TrykeTestItem[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const event = JSON.parse(trimmed) as TrykeEvent;
          if (event.event === "collect_complete") {
            tests.push(...event.tests);
          }
        } catch {
          // Skip non-JSON lines
        }
      }
      resolve(tests);
    });
  });
}
