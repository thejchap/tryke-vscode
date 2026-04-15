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
  maxfail: number | null;
  dist: "test" | "file" | "group" | null;
  markers: string | null;
  changed: "off" | "only" | "first";
  baseBranch: string | null;
  args: string[];
}

export function getConfig(): TrykeConfig {
  const cfg = vscode.workspace.getConfiguration("tryke");
  return {
    command: cfg.get<string>("command", "tryke"),
    mode: cfg.get<"direct" | "server" | "auto">("mode", "auto"),
    server: {
      host: cfg.get<string>("server.host", "127.0.0.1"),
      port: cfg.get<number>("server.port", 2337),
      autoStart: cfg.get<boolean>("server.autoStart", true),
      autoStop: cfg.get<boolean>("server.autoStop", true),
    },
    workers: cfg.get<number | null>("workers", null),
    failFast: cfg.get<boolean>("failFast", false),
    maxfail: cfg.get<number | null>("maxfail", null),
    dist: cfg.get<"test" | "file" | "group" | null>("dist", null),
    markers: cfg.get<string | null>("markers", null),
    changed: cfg.get<"off" | "only" | "first">("changed", "off"),
    baseBranch: cfg.get<string | null>("baseBranch", null),
    args: cfg.get<string[]>("args", []),
  };
}
