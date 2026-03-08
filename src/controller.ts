import * as vscode from "vscode";
import { getConfig } from "./config";
import { discoverTests } from "./discovery";
import { resolveRunner } from "./runner";

export class TrykeTestController implements vscode.Disposable {
  private controller: vscode.TestController;
  private testMap = new Map<string, vscode.TestItem>();
  private watcher: vscode.FileSystemWatcher;
  private debounceTimer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.controller = vscode.tests.createTestController("tryke", "Tryke");

    this.controller.resolveHandler = async () => {
      await this.discover();
    };

    const runProfile = this.controller.createRunProfile(
      "Run Tests",
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runTests(request, token),
      true,
    );
    this.disposables.push(runProfile);

    this.watcher = vscode.workspace.createFileSystemWatcher("**/*.py");
    const debouncedDiscover = () => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => this.discover(), 300);
    };
    this.watcher.onDidChange(debouncedDiscover);
    this.watcher.onDidCreate(debouncedDiscover);
    this.watcher.onDidDelete(debouncedDiscover);
    this.disposables.push(this.watcher);
  }

  private async discover(): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }

    const config = getConfig();

    // Clear existing items
    this.controller.items.replace([]);
    this.testMap.clear();

    try {
      this.testMap = await discoverTests(
        this.controller,
        config,
        workspaceRoot,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showWarningMessage(`Tryke discovery failed: ${msg}`);
    }
  }

  private async runTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }

    const config = getConfig();
    const testRun = this.controller.createTestRun(request);

    // Mark included tests as enqueued
    const items = request.include ?? this.getAllTestItems();
    for (const item of items) {
      testRun.enqueued(item);
      item.children.forEach((child) => testRun.enqueued(child));
    }

    try {
      const runner = await resolveRunner(config);
      await runner(request, testRun, this.testMap, config, workspaceRoot, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Tryke run failed: ${msg}`);
    } finally {
      testRun.end();
    }
  }

  private getAllTestItems(): vscode.TestItem[] {
    const items: vscode.TestItem[] = [];
    this.controller.items.forEach((item) => items.push(item));
    return items;
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.controller.dispose();
  }
}
