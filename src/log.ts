import * as vscode from "vscode";

const channel = vscode.window.createOutputChannel("Tryke");

export function log(...args: unknown[]): void {
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" ");
  channel.appendLine(`[tryke] ${msg}`);
}
