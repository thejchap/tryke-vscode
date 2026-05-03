import * as vscode from "vscode";
import { getConfig } from "./config";
import { discoverTests } from "./discovery";
import { resolveRunner } from "./runner";
import { runDirect } from "./directRunner";
import { hasActiveServer } from "./serverManager";
import { WatchSession } from "./watchSession";

export class TrykeTestController implements vscode.Disposable {
  private controller: vscode.TestController;
  private testMap = new Map<string, vscode.TestItem>();
  private watcher: vscode.FileSystemWatcher;
  private debounceTimer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];
  // Incremented for each active WatchSession. While > 0, the
  // controller-level watcher skips its rediscover so the active session
  // owns file-change handling — otherwise the two watchers race and the
  // controller's `items.replace` invalidates the TestItem references the
  // session is mid-run on.
  private activeWatchSessions = 0;

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
      undefined,
      true, // supportsContinuousRun
    );
    this.disposables.push(runProfile);

    const changedProfile = this.controller.createRunProfile(
      "Run Changed Tests",
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runChangedTests(request, token),
      false,
    );
    this.disposables.push(changedProfile);

    this.watcher = vscode.workspace.createFileSystemWatcher("**/*.py");
    const onChange = () => {
      if (this.activeWatchSessions > 0) {
        return;
      }
      // Skip the extension-side debounce in server mode — the tryke server
      // already debounces file-change-driven re-discovery internally, so the
      // extra 300ms wait just adds latency. Gate is: raw mode === "server",
      // or mode === "auto" with an extension-spawned server currently live.
      const mode = getConfig().mode;
      const inServerMode =
        mode === "server" || (mode === "auto" && hasActiveServer());
      if (inServerMode) {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
          this.debounceTimer = undefined;
        }
        void this.discover();
        return;
      }
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => this.discover(), 300);
    };
    this.watcher.onDidChange(onChange);
    this.watcher.onDidCreate(onChange);
    this.watcher.onDidDelete(onChange);
    this.disposables.push(this.watcher);
  }

  // Exposed for unit tests so the gate behavior can be exercised without
  // running a full WatchSession.
  hasActiveWatchSession(): boolean {
    return this.activeWatchSessions > 0;
  }

  private async discover(): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }

    const config = getConfig();

    // Atomic swap: keep the existing tree visible while the new one is
    // being collected, then replace in one shot. The old approach
    // `items.replace([])` then awaiting discovery left the tree empty for
    // the duration of the rediscover, which surfaced as "file not found"
    // when a click landed in that window.
    try {
      const result = await discoverTests(this.controller, config, workspaceRoot);
      this.testMap = result.testMap;
      this.controller.items.replace(result.rootItems);
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

    if (request.continuous) {
      const session = new WatchSession(
        this.controller,
        request,
        () => this.testMap,
        config,
        workspaceRoot,
        token,
      );
      this.disposables.push(session);
      this.activeWatchSessions += 1;
      try {
        await session.start();
      } finally {
        this.activeWatchSessions = Math.max(0, this.activeWatchSessions - 1);
      }
      return;
    }

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

  private async runChangedTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }

    const config = getConfig();
    const changedConfig = { ...config, changed: "only" as const };

    const testRun = this.controller.createTestRun(request);

    const items = request.include ?? this.getAllTestItems();
    for (const item of items) {
      testRun.enqueued(item);
      item.children.forEach((child) => testRun.enqueued(child));
    }

    try {
      await runDirect(request, testRun, this.testMap, changedConfig, workspaceRoot, token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Tryke changed run failed: ${msg}`);
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
