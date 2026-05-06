import * as vscode from "vscode";
import { log } from "./log";

const MODES = ["direct", "server", "auto"] as const;
const CHANGED = ["off", "only", "first"] as const;
const DIST = ["test", "file", "group"] as const;
const LOG_LEVELS = ["off", "error", "warn", "info", "debug", "trace"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface TrykeConfig {
  command: string;
  python: string | null;
  mode: (typeof MODES)[number];
  server: {
    host: string;
    port: number;
    autoStart: boolean;
    autoStop: boolean;
    logLevel: LogLevel;
  };
  workers: number | null;
  failFast: boolean;
  maxfail: number | null;
  dist: (typeof DIST)[number] | null;
  markers: string | null;
  changed: (typeof CHANGED)[number];
  baseBranch: string | null;
  args: string[];
}

// vscode validates `enum`-typed settings against package.json at the UI
// layer, but a settings.json edit can still slip junk past — the runtime
// `cfg.get(...)` call returns whatever string is on disk. Coerce here so a
// typo in settings degrades to a logged warning + the default rather than a
// surprise in the runner.
export function coerceEnum<T extends readonly string[]>(
  raw: unknown,
  allowed: T,
  fallback: T[number],
  setting: string,
): T[number] {
  if (typeof raw === "string" && (allowed as readonly string[]).includes(raw)) {
    return raw;
  }
  log(
    `config: invalid value for tryke.${setting}:`,
    JSON.stringify(raw),
    "— falling back to",
    fallback,
  );
  return fallback;
}

export function getConfig(): TrykeConfig {
  const cfg = vscode.workspace.getConfiguration("tryke");
  return {
    command: cfg.get<string>("command", "tryke"),
    python: cfg.get<string | null>("python", null),
    mode: coerceEnum(cfg.get("mode"), MODES, "auto", "mode"),
    server: {
      host: cfg.get<string>("server.host", "127.0.0.1"),
      port: cfg.get<number>("server.port", 2337),
      autoStart: cfg.get<boolean>("server.autoStart", true),
      autoStop: cfg.get<boolean>("server.autoStop", true),
      logLevel: coerceEnum(
        cfg.get("server.logLevel"),
        LOG_LEVELS,
        "info",
        "server.logLevel",
      ),
    },
    workers: cfg.get<number | null>("workers", null),
    failFast: cfg.get<boolean>("failFast", false),
    maxfail: cfg.get<number | null>("maxfail", null),
    dist: coerceDistOrNull(cfg.get("dist")),
    markers: cfg.get<string | null>("markers", null),
    changed: coerceEnum(cfg.get("changed"), CHANGED, "off", "changed"),
    baseBranch: cfg.get<string | null>("baseBranch", null),
    args: cfg.get<string[]>("args", []),
  };
}

// `dist` allows null in addition to the enum, so it doesn't fit the generic
// coerceEnum signature.
export function coerceDistOrNull(raw: unknown): (typeof DIST)[number] | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === "string" && (DIST as readonly string[]).includes(raw)) {
    return raw as (typeof DIST)[number];
  }
  log(
    "config: invalid value for tryke.dist:",
    JSON.stringify(raw),
    "— falling back to null",
  );
  return null;
}
