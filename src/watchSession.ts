import * as vscode from "vscode";
import * as path from "path";
import { TrykeConfig } from "./config";
import { TrykeClient } from "./client";
import { runDirect } from "./directRunner";
import { runServerWithClient } from "./serverRunner";
import { ensureServer, hasActiveServer } from "./serverManager";
import { log } from "./log";

type RunMode = "direct" | "server";

// Reconnect policy: try a small number of times with exponential backoff
// before giving up and disposing the session. Without a cap, a server that
// stays down (e.g. tryke binary uninstalled mid-watch) would leave the
// session in a half-built state — `client` reassigned but never connected,
// so every subsequent re-run throws "Not connected".
const RECONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 200;

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
    this.runMode = this.resolveMode();
    log("watch: mode resolved to", this.runMode);

    // For server mode, hold on to the shared stdio session owned by
    // serverManager for the life of the watch.
    if (this.runMode === "server") {
      this.client = await ensureServer(this.config, this.workspaceRoot);
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

  private resolveMode(): RunMode {
    if (this.config.mode === "direct") {
      return "direct";
    }
    if (this.config.mode === "server") {
      return "server";
    }
    // Auto: use the server when the extension already has a live child.
    // The stdio session is private to this extension, so there's no
    // external server to probe for.
    return hasActiveServer() ? "server" : "direct";
  }

  private onFileChanged(uri: vscode.Uri): void {
    if (this.disposed) {
      return;
    }
    const relPath = path.relative(this.workspaceRoot, uri.fsPath);
    this.pendingChanges.add(relPath);

    // Skip the extension-side debounce in server mode — the tryke server
    // already debounces watch-mode reruns internally, so the extra 500ms
    // wait just adds latency. `runMode` is the resolved mode (auto already
    // collapsed into direct/server in start()), so this catches auto→server.
    if (this.runMode === "server") {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = undefined;
      }
      if (!this.running) {
        void this.executePendingRun();
      }
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      if (!this.running) {
        void this.executePendingRun();
      }
    }, 500);
  }

  private async executePendingRun(): Promise<void> {
    // Loop instead of recursing: changes that arrive while a run is in
    // flight accumulate in `pendingChanges` and are picked up on the next
    // iteration. The previous tail-recursive shape had no depth bound, so a
    // tight save loop on a flaky server could grow the call stack.
    while (!this.disposed && this.pendingChanges.size > 0) {
      this.running = true;
      const changedFiles = new Set(this.pendingChanges);
      this.pendingChanges.clear();

      try {
        const affectedItems = this.findAffectedItems(changedFiles);
        if (affectedItems.length === 0) {
          log("watch: no affected tests for changed files:", [...changedFiles]);
          continue;
        }

        log(
          "watch: re-running",
          affectedItems.length,
          "items for",
          changedFiles.size,
          "changed files",
        );

        const newRequest = new vscode.TestRunRequest(
          affectedItems,
          this.request.exclude,
          this.request.profile,
        );
        await this.executeRun(newRequest);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("watch: re-run failed:", msg);

        if (this.runMode === "server" && this.client) {
          const reconnected = await this.attemptReconnect();
          if (!reconnected) {
            log("watch: giving up after exhausting reconnect attempts — disposing session");
            this.running = false;
            this.dispose();
            return;
          }
        }
      } finally {
        this.running = false;
      }
    }
  }

  // Returns true on a successful reconnect, false if all attempts fail. On
  // failure leaves `this.client = undefined` so the next executeRun won't
  // try to drive a dead session. The session itself belongs to
  // serverManager — "reconnect" here means asking it for a live server
  // (respawning the child if the previous one died) and re-adopting the
  // shared client.
  private async attemptReconnect(): Promise<boolean> {
    this.client = undefined;
    for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt++) {
      if (this.disposed) {
        return false;
      }
      try {
        this.client = await ensureServer(this.config, this.workspaceRoot);
        log("watch: reconnected to server on attempt", attempt);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("watch: reconnect attempt", attempt, "failed:", msg);
        if (attempt < RECONNECT_MAX_ATTEMPTS) {
          // Exponential backoff: 200ms, 400ms, 800ms.
          const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    return false;
  }

  private findAffectedItems(changedFiles: Set<string>): vscode.TestItem[] {
    const items: vscode.TestItem[] = [];
    const originalInclude = this.request.include;

    if (originalInclude?.length) {
      // Scoped watch: only re-run tests in changed files that are within the original scope
      const includeIds = new Set(originalInclude.map((i) => i.id));
      for (const [id, item] of this.getTestMap()) {
        const [filePart] = id.split("::");
        if (filePart && changedFiles.has(filePart) && isInScope(id, includeIds)) {
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
    // Drop our reference only — the client is serverManager's shared
    // stdio session; disconnecting it here would shut the server down
    // for everyone else.
    this.client = undefined;
    if (this.resolveStart) {
      this.resolveStart();
    }
  }
}

export function isInScope(testId: string, includeIds: Set<string>): boolean {
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
