import * as vscode from "vscode";
import * as cp from "child_process";
import { TrykeEvent } from "./types";
import { TrykeEventSchema } from "./schema";
import { TrykeConfig } from "./config";
import { reportResult } from "./resultMapper";
import { log } from "./log";
import { resolveVariables } from "./resolveVariables";
import { buildTestId, splitCaseLabel, TestIdInput } from "./testId";

export async function runDirect(
  request: vscode.TestRunRequest,
  testRun: vscode.TestRun,
  testMap: Map<string, vscode.TestItem>,
  config: TrykeConfig,
  workspaceRoot: string,
  token: vscode.CancellationToken,
): Promise<void> {
  const args = buildArgs(request, config, workspaceRoot);
  log("spawn:", config.command, args);

  return new Promise<void>((resolve, reject) => {
    const proc = cp.spawn(config.command, args, { cwd: workspaceRoot });

    token.onCancellationRequested(() => {
      proc.kill("SIGTERM");
    });

    let buffer = "";

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(trimmed);
        } catch {
          log("non-json stdout line:", trimmed.slice(0, 200));
          continue;
        }
        const parsed = TrykeEventSchema.safeParse(raw);
        if (!parsed.success) {
          log("dropping unexpected event shape:", parsed.error.message, "payload:", trimmed.slice(0, 200));
          continue;
        }
        log("event:", parsed.data.event);
        handleEvent(parsed.data, testRun, testMap, workspaceRoot);
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      log("stderr:", text.slice(0, 500));
      testRun.appendOutput(text.replace(/\n/g, "\r\n"));
    });

    proc.on("error", (err) => {
      log("spawn error:", err.message);
      reject(new Error(`Failed to spawn ${config.command}: ${err.message}`));
    });

    proc.on("close", (code) => {
      log("process closed with code", code);
      // Process any remaining buffer
      const tail = buffer.trim();
      if (tail) {
        try {
          const raw: unknown = JSON.parse(tail);
          const parsed = TrykeEventSchema.safeParse(raw);
          if (parsed.success) {
            handleEvent(parsed.data, testRun, testMap, workspaceRoot);
          } else {
            log("dropping trailing buffer:", parsed.error.message);
          }
        } catch (err) {
          log("trailing buffer not json:", err instanceof Error ? err.message : String(err));
        }
      }
      resolve();
    });
  });
}

function handleEvent(
  event: TrykeEvent,
  testRun: vscode.TestRun,
  testMap: Map<string, vscode.TestItem>,
  workspaceRoot: string,
): void {
  if (event.event === "run_start") {
    for (const test of event.tests) {
      const testId = testIdFromResult(test, workspaceRoot);
      const testItem = testMap.get(testId);
      if (testItem) {
        testRun.started(testItem);
      }
    }
  } else if (event.event === "test_complete") {
    const result = event.result;
    const testId = testIdFromResult(result.test, workspaceRoot);
    const testItem = testMap.get(testId);
    log("test_complete:", testId, "found:", !!testItem, "outcome:", result.outcome.status);
    if (!testItem) {
      log("testMap keys:", [...testMap.keys()]);
    }
    if (testItem) {
      reportResult(testRun, testItem, result);
    }
  } else if (event.event === "discovery_warning") {
    log("discovery warning:", event.warning.file_path, event.warning.kind, event.warning.message);
  }
}

function testIdFromResult(
  test: TestIdInput,
  workspaceRoot: string,
): string {
  return buildTestId(test, workspaceRoot);
}

export function buildArgs(
  request: vscode.TestRunRequest,
  config: TrykeConfig,
  workspaceRoot: string,
): string[] {
  const args = ["test", "--reporter", "json"];

  if (config.python) {
    args.push("--python", resolveVariables(config.python, workspaceRoot));
  }

  if (config.workers != null) {
    args.push("-j", String(config.workers));
  }

  if (config.failFast) {
    args.push("--fail-fast");
  }

  if (config.maxfail != null) {
    args.push("--maxfail", String(config.maxfail));
  }

  if (config.dist != null) {
    args.push("--dist", config.dist);
  }

  if (config.markers != null) {
    args.push("-m", config.markers);
  }

  if (config.changed === "only") {
    args.push("--changed");
  } else if (config.changed === "first") {
    args.push("--changed-first");
  }

  if (config.baseBranch != null) {
    args.push("--base-branch", config.baseBranch);
  }

  if (request.include?.length) {
    const paths = new Set<string>();
    const names: string[] = [];

    for (const item of request.include) {
      log("buildArgs item:", item.id, "children:", item.children.size);
      if (item.children.size > 0 && !item.id.includes("::")) {
        // File-level item — id is already a relative path
        paths.add(item.id);
      } else if (item.children.size > 0) {
        // Group/namespace item: collect leaf test names
        const [filePart] = item.id.split("::");
        if (filePart) {
          paths.add(filePart);
          collectLeafNames(item, names);
        }
      } else {
        // Individual test — id is "relPath::group1::...::testName[case]?"
        // Strip a `[case_label]` suffix before sending to `-k`: tryke's
        // filter expression syntax rejects brackets ("invalid filter
        // expression"), and tryke has no per-case CLI selector. Running
        // the parent function instead runs every case under it; the
        // result mapper still routes each `test_complete` to the right
        // TestItem, so the case the user clicked still gets a status.
        const parts = item.id.split("::");
        const filePart = parts[0];
        const leafPart = parts[parts.length - 1];
        if (parts.length >= 2 && filePart && leafPart) {
          paths.add(filePart);
          const { name } = splitCaseLabel(leafPart);
          names.push(name);
        }
      }
    }

    for (const p of paths) {
      args.push(p);
    }

    if (names.length > 0) {
      // De-dup so multiple selected cases of the same function don't
      // produce `-k "test_x or test_x or test_x"`.
      const unique = Array.from(new Set(names));
      args.push("-k", unique.join(" or "));
    }
  }

  args.push(...config.args);

  return args;
}

export function collectLeafNames(item: vscode.TestItem, names: string[]): void {
  if (item.children.size === 0) {
    const parts = item.id.split("::");
    const last = parts[parts.length - 1];
    if (last) {
      names.push(last);
    }
  } else {
    item.children.forEach((child) => collectLeafNames(child, names));
  }
}

export { testIdFromResult };
