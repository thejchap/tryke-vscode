import * as vscode from "vscode";
import { TrykeTestController } from "./controller";
import { ensureServer, stopServer, stopServerAndWait } from "./serverManager";
import { getConfig } from "./config";
import { log } from "./log";

let controller: TrykeTestController | undefined;

export function activate(context: vscode.ExtensionContext) {
  controller = new TrykeTestController();
  context.subscriptions.push(controller);

  context.subscriptions.push(
    vscode.commands.registerCommand("tryke.restartServer", async () => {
      const config = getConfig();
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        vscode.window.showErrorMessage("Tryke: open a workspace folder first.");
        return;
      }
      log("command: tryke.restartServer");
      try {
        await stopServerAndWait();
        await ensureServer(config, workspaceRoot);
        vscode.window.showInformationMessage("Tryke server restarted.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("command: tryke.restartServer failed —", msg);
        vscode.window.showErrorMessage(`Tryke: failed to restart server — ${msg}`);
      }
    }),
    vscode.commands.registerCommand("tryke.stopServer", async () => {
      log("command: tryke.stopServer");
      try {
        await stopServerAndWait();
        vscode.window.showInformationMessage("Tryke server stopped.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("command: tryke.stopServer failed —", msg);
        vscode.window.showErrorMessage(`Tryke: failed to stop server — ${msg}`);
      }
    }),
    vscode.commands.registerCommand("tryke.startServer", async () => {
      const config = getConfig();
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) {
        vscode.window.showErrorMessage("Tryke: open a workspace folder first.");
        return;
      }
      log("command: tryke.startServer");
      try {
        await ensureServer(config, workspaceRoot);
        vscode.window.showInformationMessage("Tryke server started.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("command: tryke.startServer failed —", msg);
        vscode.window.showErrorMessage(`Tryke: failed to start server — ${msg}`);
      }
    }),
  );
}

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function deactivate() {
  const config = getConfig();
  if (config.server.autoStop) {
    stopServer();
  }
  controller = undefined;
}
