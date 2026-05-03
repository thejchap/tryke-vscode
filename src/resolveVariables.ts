import * as os from "os";
import * as vscode from "vscode";

/**
 * Substitute the standard VS Code path-style variables in a config value.
 *
 * VS Code's settings system does NOT interpolate `${workspaceFolder}` and
 * friends inside string values — extensions that want this must do it
 * themselves. This is the same convention every well-behaved extension
 * follows (ms-python's `SystemVariables`, rust-analyzer, etc.).
 *
 * Supported variables (a deliberately small subset of the full
 * VS Code grammar):
 *
 * - `${workspaceFolder}` → workspace root (the one passed in).
 * - `${workspaceFolder:NAME}` → multi-root: a named folder by basename
 *   or by `WorkspaceFolder.name`.
 * - `${userHome}` → user home directory (`~`).
 * - `${env:VAR}` → process env, empty string when unset (matches
 *   VS Code's debug-config behavior).
 *
 * Unknown `${...}` references are left intact rather than silently
 * substituted with empty so a typo surfaces as a spawn-time path-not-
 * found rather than a confusingly-truncated path.
 */
export function resolveVariables(
  value: string,
  workspaceRoot: string | undefined,
): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
    if (name === "workspaceFolder") {
      return workspaceRoot ?? match;
    }
    if (name.startsWith("workspaceFolder:")) {
      const wanted = name.slice("workspaceFolder:".length);
      const folder = vscode.workspace.workspaceFolders?.find(
        (f) => f.name === wanted || basename(f.uri.fsPath) === wanted,
      );
      return folder?.uri.fsPath ?? match;
    }
    if (name === "userHome") {
      return os.homedir();
    }
    if (name.startsWith("env:")) {
      // Empty string for unset matches VS Code's `${env:VAR}` semantics
      // in launch.json and tasks.json — distinct from "leave intact".
      return process.env[name.slice("env:".length)] ?? "";
    }
    return match;
  });
}

function basename(p: string): string {
  // Inline rather than pulling `path` for one call — keeps the helper
  // testable without a file system mock.
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx === -1 ? p : p.slice(idx + 1);
}
