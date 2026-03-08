import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import { TrykeEvent } from "./types";
import { TrykeConfig } from "./config";
import { reportResult } from "./resultMapper";

export async function runDirect(
  request: vscode.TestRunRequest,
  testRun: vscode.TestRun,
  testMap: Map<string, vscode.TestItem>,
  config: TrykeConfig,
  workspaceRoot: string,
  token: vscode.CancellationToken,
): Promise<void> {
  const args = buildArgs(request, config, workspaceRoot);

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
          handleEvent(event, testRun, testMap);
        } catch {
          // Skip non-JSON lines
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      testRun.appendOutput(data.toString().replace(/\n/g, "\r\n"));
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn ${config.command}: ${err.message}`));
    });

    proc.on("close", () => {
      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim()) as TrykeEvent;
          handleEvent(event, testRun, testMap);
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
): void {
  if (event.event === "test_complete") {
    const result = event.result;
    const testId = testIdFromResult(result.test);
    const testItem = testMap.get(testId);
    if (testItem) {
      reportResult(testRun, testItem, result);
    }
  }
}

function testIdFromResult(test: { name: string; file_path?: string; module_path: string }): string {
  // Test IDs match the format used in discovery: relative_path::test_name
  // Since we may not have workspaceRoot here, we use file_path or module_path as-is
  // The controller will try both formats
  const filePath = test.file_path ?? test.module_path;
  return `${filePath}::${test.name}`;
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
      if (item.children.size > 0) {
        // File-level item: run entire file
        if (item.uri) {
          paths.add(item.uri.fsPath);
        }
      } else {
        // Individual test: extract file path and name
        const parts = item.id.split("::");
        if (parts.length >= 2) {
          const filePath = path.resolve(workspaceRoot, parts[0]);
          paths.add(filePath);
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

export { testIdFromResult };
