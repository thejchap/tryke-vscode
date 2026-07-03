import * as vscode from "vscode";
import { TrykeConfig } from "./config";
import { runDirect } from "./directRunner";
import { runServer } from "./serverRunner";

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
  }
}
