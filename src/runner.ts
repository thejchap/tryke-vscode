import * as vscode from "vscode";
import { TrykeConfig } from "./config";
import { runDirect } from "./directRunner";
import { runServer } from "./serverRunner";
import { hasActiveServer } from "./serverManager";

export type RunFn = (
  request: vscode.TestRunRequest,
  testRun: vscode.TestRun,
  testMap: Map<string, vscode.TestItem>,
  config: TrykeConfig,
  workspaceRoot: string,
  token: vscode.CancellationToken,
) => Promise<void>;

export function resolveRunner(config: TrykeConfig): RunFn {
  switch (config.mode) {
    case "direct":
      return runDirect;
    case "server":
      return runServer;
    case "auto":
      // The server's stdio session is private to this extension, so
      // "available" now means "we already have a live child" — there is
      // no external server to probe for anymore.
      return hasActiveServer() ? runServer : runDirect;
  }
}
