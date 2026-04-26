import * as vscode from "vscode";
import * as path from "path";
import { TrykeConfig } from "./config";
import { TrykeClient } from "./client";
import { runDirect } from "./directRunner";
import { runServerWithClient } from "./serverRunner";
import { ensureServer } from "./serverManager";
import { log } from "./log";

type RunMode = "direct" | "server";

export class WatchSession implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private pendingChanges = new Set<string>();
  private debounceTimer: NodeJS.Timeout | undefined;
  private running = false;
  private disposed = false;
  private resolveStart: (() => void) | undefined;
  private client: TrykeClient | undefined;
  private runMode: RunMode = "direct";

  constructor(
    private controller: vscode.TestController,
    private request: vscode.TestRunRequest,
    private getTestMap: () => Map<string, vscode.TestItem>,
    private config: TrykeConfig,
    private workspaceRoot: string,
    private token: vscode.CancellationToken,
  ) {}

  async start(): Promise<void> {
    // Resolve runner mode once
    this.runMode = await this.resolveMode();
    log("watch: mode resolved to", this.runMode);

    // For server mode, establish a persistent connection
    if (this.runMode === "server") {
      await ensureServer(this.config, this.workspaceRoot);
      this.client = new TrykeClient();
      await this.client.connect(this.config.server.host, this.config.server.port);
    }

    // Run initial test set
    await this.executeRun(this.request);

    // Set up file watcher
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*.py");
    this.watcher.onDidChange((uri) => this.onFileChanged(uri));
    this.watcher.onDidCreate((uri) => this.onFileChanged(uri));
    this.watcher.onDidDelete((uri) => this.onFileChanged(uri));

    // Wire up cancellation
    this.token.onCancellationRequested(() => this.dispose());

    // Block until cancelled
    return new Promise<void>((resolve) => {
      if (this.disposed) {
        resolve();
        return;
      }
      this.resolveStart = resolve;
    });
  }

  private async resolveMode(): Promise<RunMode> {
    if (this.config.mode === "direct") {
      return "direct";
    }
    if (this.config.mode === "server") {
      return "server";
    }
    // Auto: try to ping server
    const client = new TrykeClient();
    try {
      await client.connect(this.config.server.host, this.config.server.port);
      await client.request("ping");
      client.disconnect();
      return "server";
    } catch {
      client.disconnect();
      return "direct";
    }
  }

  private onFileChanged(uri: vscode.Uri): void {
    if (this.disposed) {
      return;
    }
    const relPath = path.relative(this.workspaceRoot, uri.fsPath);
    this.pendingChanges.add(relPath);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      if (!this.running) {
        this.executePendingRun();
      }
    }, 500);
  }

  private async executePendingRun(): Promise<void> {
    if (this.disposed || this.pendingChanges.size === 0) {
      return;
    }

    this.running = true;
    const changedFiles = new Set(this.pendingChanges);
    this.pendingChanges.clear();

    try {
      // Find test items that belong to changed files
      const affectedItems = this.findAffectedItems(changedFiles);
      if (affectedItems.length === 0) {
        log("watch: no affected tests for changed files:", [...changedFiles]);
        return;
      }

      log("watch: re-running", affectedItems.length, "items for", changedFiles.size, "changed files");

      const newRequest = new vscode.TestRunRequest(
        affectedItems,
        this.request.exclude,
        this.request.profile,
      );
      await this.executeRun(newRequest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("watch: re-run failed:", msg);

      // If server connection lost, try to reconnect
      if (this.runMode === "server" && this.client) {
        try {
          this.client.disconnect();
          await ensureServer(this.config, this.workspaceRoot);
          this.client = new TrykeClient();
          await this.client.connect(this.config.server.host, this.config.server.port);
          log("watch: reconnected to server");
        } catch {
          log("watch: reconnection failed");
        }
      }
    } finally {
      this.running = false;

      // Check if more changes accumulated during the run
      if (this.pendingChanges.size > 0 && !this.disposed) {
        await this.executePendingRun();
      }
    }
  }

  private findAffectedItems(changedFiles: Set<string>): vscode.TestItem[] {
    const items: vscode.TestItem[] = [];
    const originalInclude = this.request.include;

    if (originalInclude?.length) {
      // Scoped watch: only re-run tests in changed files that are within the original scope
      const includeIds = new Set(originalInclude.map((i) => i.id));
      for (const [id, item] of this.getTestMap()) {
        const filePart = id.split("::")[0];
        if (changedFiles.has(filePart) && isInScope(id, includeIds)) {
          // Only add file-level or leaf items to avoid duplicates
          if (!id.includes("::") || item.children.size === 0) {
            items.push(item);
          }
        }
      }
    } else {
      // Global watch: re-run file-level items for changed files
      for (const [id, item] of this.getTestMap()) {
        if (!id.includes("::") && changedFiles.has(id)) {
          items.push(item);
        }
      }
    }

    return items;
  }

  private async executeRun(request: vscode.TestRunRequest): Promise<void> {
    const testRun = this.controller.createTestRun(request);

    // Enqueue items
    const items = request.include ?? this.getAllTestItems();
    for (const item of items) {
      testRun.enqueued(item);
      item.children.forEach((child) => testRun.enqueued(child));
    }

    try {
      if (this.runMode === "server" && this.client) {
        await runServerWithClient(
          this.client,
          request,
          testRun,
          this.getTestMap(),
          this.config,
          this.workspaceRoot,
          this.token,
        );
      } else {
        await runDirect(
          request,
          testRun,
          this.getTestMap(),
          this.config,
          this.workspaceRoot,
          this.token,
        );
      }
    } finally {
      testRun.end();
    }
  }

  private getAllTestItems(): vscode.TestItem[] {
    const items: vscode.TestItem[] = [];
    this.controller.items.forEach((item) => items.push(item));
    return items;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    if (this.watcher) {
      this.watcher.dispose();
    }
    if (this.client) {
      this.client.disconnect();
      this.client = undefined;
    }
    if (this.resolveStart) {
      this.resolveStart();
    }
  }
}

function isInScope(testId: string, includeIds: Set<string>): boolean {
  // Check exact match
  if (includeIds.has(testId)) {
    return true;
  }

  // Check if any prefix of the test ID is in the include set
  // (e.g., file-level or group-level include covers all children)
  const parts = testId.split("::");
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join("::");
    if (includeIds.has(prefix)) {
      return true;
    }
  }

  return false;
}
