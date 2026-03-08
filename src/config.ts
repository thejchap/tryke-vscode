import * as vscode from "vscode";

export interface TrykeConfig {
  command: string;
  mode: "direct" | "server" | "auto";
  server: {
    host: string;
    port: number;
    autoStart: boolean;
    autoStop: boolean;
  };
  workers: number | null;
  failFast: boolean;
  args: string[];
}

export function getConfig(): TrykeConfig {
  const cfg = vscode.workspace.getConfiguration("tryke");
  return {
    command: cfg.get<string>("command", "tryke"),
    mode: cfg.get<"direct" | "server" | "auto">("mode", "auto"),
    server: {
      host: cfg.get<string>("server.host", "127.0.0.1"),
      port: cfg.get<number>("server.port", 9876),
      autoStart: cfg.get<boolean>("server.autoStart", true),
      autoStop: cfg.get<boolean>("server.autoStop", true),
    },
    workers: cfg.get<number | null>("workers", null),
    failFast: cfg.get<boolean>("failFast", false),
    args: cfg.get<string[]>("args", []),
  };
}
