import * as vscode from "vscode";
import * as cp from "child_process";
import { TrykeEvent } from "./types";
import { TrykeConfig } from "./config";
import { reportResult } from "./resultMapper";
import { log } from "./log";
import { buildTestId } from "./testId";

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
        try {
          const event = JSON.parse(trimmed) as TrykeEvent;
          log("event:", event.event, "event" in event ? JSON.stringify(event).slice(0, 300) : "");
          handleEvent(event, testRun, testMap, workspaceRoot);
        } catch {
          log("non-json stdout line:", trimmed.slice(0, 200));
        }
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
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim()) as TrykeEvent;
          handleEvent(event, testRun, testMap, workspaceRoot);
        } catch {
          // ignore
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
  if (event.event === "test_complete") {
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
  }
}

function testIdFromResult(
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

function buildArgs(
  request: vscode.TestRunRequest,
  config: TrykeConfig,
  workspaceRoot: string,
): string[] {
  const args = ["test", "--reporter", "json"];

  if (config.workers != null) {
    args.push("-j", String(config.workers));
  }

  if (config.failFast) {
    args.push("--fail-fast");
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
        const filePart = item.id.split("::")[0];
        paths.add(filePart);
        collectLeafNames(item, names);
      } else {
        // Individual test — id is "relPath::group1::...::testName"
        const parts = item.id.split("::");
        if (parts.length >= 2) {
          paths.add(parts[0]);
          names.push(parts[parts.length - 1]);
        }
      }
    }

    for (const p of paths) {
      args.push(p);
    }

    if (names.length > 0) {
      args.push("-k", names.join(" or "));
    }
  }

  args.push(...config.args);

  return args;
}

function collectLeafNames(item: vscode.TestItem, names: string[]): void {
  if (item.children.size === 0) {
    const parts = item.id.split("::");
    names.push(parts[parts.length - 1]);
  } else {
    item.children.forEach((child) => collectLeafNames(child, names));
  }
}

export { testIdFromResult };
