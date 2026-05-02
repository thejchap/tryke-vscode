import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import { TrykeEvent, TrykeTestItem, TrykeDiscoveryWarning } from "./types";
import { TrykeConfig } from "./config";
import { log } from "./log";
import { buildTestId } from "./testId";
import { findCaseLine, findDescribeLine, clearSourceCache } from "./sourceScan";

export async function discoverTests(
  controller: vscode.TestController,
  config: TrykeConfig,
  workspaceRoot: string,
): Promise<Map<string, vscode.TestItem>> {
  const testMap = new Map<string, vscode.TestItem>();

  // Tryke's CLI doesn't report per-case line numbers (every case shares the
  // decorated function's line), so discovery scans the source for each
  // `t.test.case("label", ...)` site. Clear the cache so any file edits
  // since the last discovery are picked up.
  clearSourceCache();

  const { tests, warnings } = await collectTests(config, workspaceRoot);
  log("discovery: collected", tests.length, "tests in", workspaceRoot);
  for (const warning of warnings) {
    log("discovery warning:", warning.file_path, warning.kind, warning.message);
  }
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

    // Sort tests so that tests in the same group are adjacent
    fileTests.sort((a, b) => {
      const ag = (a.groups ?? []).join("::");
      const bg = (b.groups ?? []).join("::");
      return ag < bg ? -1 : ag > bg ? 1 : 0;
    });

    for (const test of fileTests) {
      const parent = getOrCreateGroup(
        controller,
        fileItem,
        relPath,
        absPath,
        fileUri,
        test,
        testMap,
      );

      const testId = buildTestId(test, workspaceRoot);
      const leafName = test.case_label ? `${test.name}[${test.case_label}]` : test.name;
      const label = test.display_name ?? leafName;
      const testItem = controller.createTestItem(testId, label, fileUri);

      // For parametrized cases, `line_number` is the decorated function's
      // line — every case for the same function would otherwise share it,
      // collapsing all per-case gutter signs onto one row. Scan the
      // source for the exact `t.test.case("label", ...)` declaration so
      // each case gets a per-line range.
      let line = test.line_number;
      if (line != null && test.case_label) {
        line = findCaseLine(absPath, test.case_label, line);
      }
      if (line != null) {
        testItem.range = new vscode.Range(
          new vscode.Position(line - 1, 0),
          new vscode.Position(line - 1, 0),
        );
      }

      parent.children.add(testItem);
      testMap.set(testId, testItem);
    }
  }

  log("discovery: testMap keys:", [...testMap.keys()]);
  return testMap;
}

function getOrCreateGroup(
  controller: vscode.TestController,
  fileItem: vscode.TestItem,
  relPath: string,
  absPath: string,
  fileUri: vscode.Uri,
  test: TrykeTestItem,
  testMap: Map<string, vscode.TestItem>,
): vscode.TestItem {
  let parent = fileItem;
  let idPrefix = relPath;
  const groups = test.groups ?? [];

  for (const groupName of groups) {
    idPrefix = `${idPrefix}::${groupName}`;
    const existing = testMap.get(idPrefix);
    if (existing) {
      parent = existing;
      continue;
    }
    // Pin the namespace to its `with t.describe("name"):` line so the
    // gutter gets a sign on the describe block. Use the first child
    // test's line as the search anchor — multiple describes in one file
    // get disambiguated by proximity.
    const groupItem = controller.createTestItem(idPrefix, groupName, fileUri);
    if (test.line_number != null) {
      const describeLine = findDescribeLine(absPath, groupName, test.line_number);
      if (describeLine != null) {
        groupItem.range = new vscode.Range(
          new vscode.Position(describeLine - 1, 0),
          new vscode.Position(describeLine - 1, 0),
        );
      }
    }
    parent.children.add(groupItem);
    testMap.set(idPrefix, groupItem);
    parent = groupItem;
  }

  return parent;
}

interface CollectResult {
  tests: TrykeTestItem[];
  warnings: TrykeDiscoveryWarning[];
}

function collectTests(
  config: TrykeConfig,
  cwd: string,
): Promise<CollectResult> {
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
      const warnings: TrykeDiscoveryWarning[] = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const event = JSON.parse(trimmed) as TrykeEvent;
          if (event.event === "collect_complete") {
            tests.push(...event.tests);
          } else if (event.event === "discovery_warning") {
            warnings.push(event.warning);
          }
        } catch {
          // Skip non-JSON lines
        }
      }
      resolve({ tests, warnings });
    });
  });
}
