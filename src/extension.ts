import * as vscode from "vscode";
import { TrykeTestController } from "./controller";
import { stopServer } from "./serverManager";
import { getConfig } from "./config";

let controller: TrykeTestController | undefined;

export function activate(context: vscode.ExtensionContext) {
  controller = new TrykeTestController();
  context.subscriptions.push(controller);
}

export function deactivate() {
  const config = getConfig();
  if (config.server.autoStop) {
    stopServer();
  }
  controller = undefined;
}
