import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import { TrykeEvent, TrykeTestItem, TrykeDiscoveryWarning } from "./types";
import { TrykeConfig } from "./config";
import { log } from "./log";
import { resolveVariables } from "./resolveVariables";
import { buildTestId } from "./testId";
import { findCaseLine, findDescribeLine, clearSourceCache } from "./sourceScan";

export interface LabelInput {
  name: string;
  display_name?: string;
  case_label?: string;
}

// `display_name` carries the @test("name") label (e.g. "basic"), while
// `case_label` carries the per-case label (e.g. "1 + 1"). Earlier code did
// `display_name ?? leafName`, which dropped the case label whenever a
// function-level display name was present — collapsing every case for a
// labelled @test.cases function onto the same row.
export function buildTestLabel(test: LabelInput): string {
  const baseName = test.display_name ?? test.name;
  return test.case_label ? `${baseName}[${test.case_label}]` : baseName;
}

export interface DiscoveryResult {
  rootItems: vscode.TestItem[];
  testMap: Map<string, vscode.TestItem>;
}

export async function discoverTests(
  controller: vscode.TestController,
  config: TrykeConfig,
  workspaceRoot: string,
): Promise<DiscoveryResult> {
  const testMap = new Map<string, vscode.TestItem>();
  const rootItems: vscode.TestItem[] = [];

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
    return { rootItems, testMap };
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

  // Build test tree. Items are NOT attached to `controller.items` here —
  // the caller swaps them in atomically once the full tree is built, so
  // there's no window where the test view is empty and a click resolves a
  // bare relative id like `tests/foo.py` against the wrong base.
  for (const [absPath, fileTests] of byFile) {
    const relPath = path.relative(workspaceRoot, absPath);
    const fileUri = vscode.Uri.file(absPath);
    const fileItem = controller.createTestItem(relPath, relPath, fileUri);
    rootItems.push(fileItem);
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
      const label = buildTestLabel(test);
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
  return { rootItems, testMap };
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
    const args = ["test", "--collect-only", "--reporter", "json"];
    if (config.python) {
      // Discovery shells out to `tryke test --collect-only`, which spawns
      // a worker — so it needs the same interpreter as a test run, otherwise
      // collection silently fails when the system python lacks the tryke
      // package and the test tree never populates.
      args.push("--python", resolveVariables(config.python, cwd));
    }
    args.push(...config.args);
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
