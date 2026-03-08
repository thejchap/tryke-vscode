import * as vscode from "vscode";
import { TrykeConfig } from "./config";
import { TrykeClient } from "./client";
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

export async function resolveRunner(config: TrykeConfig): Promise<RunFn> {
  switch (config.mode) {
    case "direct":
      return runDirect;
    case "server":
      return runServer;
    case "auto":
      return (await canPingServer(config)) ? runServer : runDirect;
  }
}

async function canPingServer(config: TrykeConfig): Promise<boolean> {
  const client = new TrykeClient();
  try {
    await client.connect(config.server.host, config.server.port);
    await client.request("ping");
    client.disconnect();
    return true;
  } catch {
    client.disconnect();
    return false;
  }
}
