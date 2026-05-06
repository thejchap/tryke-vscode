import * as cp from "child_process";
import { TrykeClient } from "./client";
import { TrykeConfig } from "./config";
import { log, logServer } from "./log";
import { resolveVariables } from "./resolveVariables";

// State of the spawned tryke server process. Encoded as a discriminated
// union so every transition is explicit; the previous shape was a single
// `let serverProcess: ChildProcess | undefined` mutated from five places
// (ensureServer, stopServer, killServerOnPort, the spawn `error` handler,
// the spawn `exit` handler) which made races hard to reason about — e.g.
// two `ensureServer` calls landing in the same tick both saw `undefined`
// and both spawned.
export type ServerState =
  | { kind: "idle" }
  | { kind: "starting"; proc: cp.ChildProcess; ready: Promise<void> }
  | { kind: "running"; proc: cp.ChildProcess }
  | { kind: "stopping"; proc: cp.ChildProcess };

let state: ServerState = { kind: "idle" };

function transition(next: ServerState): void {
  log("server: state", state.kind, "→", next.kind);
  state = next;
}

// Test-only accessors. Production callers should go through `hasActiveServer`.
export function _getStateForTesting(): ServerState {
  return state;
}
export function _setStateForTesting(next: ServerState): void {
  state = next;
}

export async function ensureServer(
  config: TrykeConfig,
  workspaceRoot: string,
): Promise<void> {
  const endpoint = `${config.server.host}:${config.server.port}`;
  log("server: ensureServer at", endpoint);

  if (await tryPing(config.server.host, config.server.port)) {
    log("server: reusing existing server at", endpoint);
    return;
  }

  // Concurrent ensureServer calls: piggy-back on the in-flight start
  // rather than spawning a second process that would race the first to
  // bind the port.
  if (state.kind === "starting") {
    log("server: ensureServer awaiting in-flight start");
    return state.ready;
  }

  if (!config.server.autoStart) {
    log("server: no existing server at", endpoint, "and autoStart is disabled");
    throw new Error(
      `Cannot connect to tryke server at ${endpoint} and autoStart is disabled`,
    );
  }

  // Pass `--root` AND set `cwd` to the workspace. tryke writes its discovery
  // cache to `<root>/.tryke/cache/discovery-v1.bin` and falls back to cwd
  // when `--root` isn't passed; on macOS the extension host's cwd is often
  // `/`, which is read-only, so the cache write fails and discovery has to
  // start from scratch on every server restart.
  const spawnArgs = [
    "server",
    "--port",
    String(config.server.port),
    "--root",
    workspaceRoot,
  ];
  if (config.python) {
    // Without this, tryke uses bare `python`/`python3` from PATH, which won't
    // have the project's tryke python package installed if the venv isn't
    // already active in the spawning environment — workers fail to start.
    // `resolveVariables` substitutes `${workspaceFolder}` / `${userHome}` /
    // `${env:VAR}` so users can write a portable config value.
    spawnArgs.push("--python", resolveVariables(config.python, workspaceRoot));
  }
  // Map `tryke.server.logLevel` to `TRYKE_LOG=<level>`. Unlike `RUST_LOG`,
  // this propagates to the spawned python workers too, so worker stderr
  // shows up in the same output panel as the rust runtime's logs.
  const trykeLog = config.server.logLevel;
  log(
    "server: spawning",
    config.command,
    spawnArgs.join(" "),
    "in",
    workspaceRoot,
    "TRYKE_LOG=" + trykeLog,
  );

  const proc = cp.spawn(config.command, spawnArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    cwd: workspaceRoot,
    env: { ...process.env, TRYKE_LOG: trykeLog },
  });

  proc.unref();

  pipeToServerChannel(proc.stdout, "stdout");
  pipeToServerChannel(proc.stderr, "stderr");

  logServer(`--- server starting: ${config.command} ${spawnArgs.join(" ")} (pid ${proc.pid}) ---`);
  log("server: spawned pid", proc.pid);

  proc.on("error", (err) => {
    log("server: spawn error:", err.message);
    logServer(`--- server spawn error: ${err.message} ---`);
    if (currentProc() === proc) {
      transition({ kind: "idle" });
    }
  });

  proc.on("exit", (code, signal) => {
    log("server: exited code =", code, "signal =", signal);
    logServer(`--- server exited code=${code} signal=${signal} ---`);
    if (currentProc() === proc) {
      transition({ kind: "idle" });
    }
  });

  const ready = waitForReady(config.server.host, config.server.port);
  transition({ kind: "starting", proc, ready });

  try {
    await ready;
  } catch (err) {
    if (currentProc() === proc) {
      transition({ kind: "idle" });
    }
    throw err;
  }

  // The exit handler may have already moved us back to idle if the server
  // crashed during the readiness wait. Only promote to running if we still
  // own this proc. Read through `_getStateForTesting()` so TS doesn't
  // narrow `state` based on the pre-await snapshot — handlers that fired
  // during the await can have transitioned us elsewhere.
  const after = _getStateForTesting();
  if (after.kind === "starting" && after.proc === proc) {
    transition({ kind: "running", proc });
  }
}

export function stopServer(): void {
  if (state.kind === "running" || state.kind === "starting") {
    const { proc } = state;
    log("server: stopping pid", proc.pid);
    transition({ kind: "stopping", proc });
    proc.kill("SIGTERM");
  }
}

/**
 * True iff the extension currently tracks a live server child process.
 *
 * This only catches servers spawned by *this* extension instance — it does
 * not detect a foreign server (e.g. one started by `tryke server` in a
 * terminal). It is good enough for "are we in server mode right now?"
 * gating where the worst case of a false negative is one extra debounced
 * dispatch.
 */
export function hasActiveServer(): boolean {
  return state.kind === "starting" || state.kind === "running";
}

/**
 * Kill whatever (if anything) is listening on the tryke server port.
 *
 * First tries the proc we spawned ourselves (in any active state); then
 * falls back to looking the PID up with `lsof` (macOS/Linux) or
 * `netstat`/`taskkill` (Windows) so foreign / stale servers — e.g.
 * leftovers from a previous session with a different tryke binary — can be
 * cleared without manual shell gymnastics. Waits until the port is free
 * (or the timeout expires).
 */
export async function killServerOnPort(
  host: string,
  port: number,
): Promise<void> {
  const tracked = currentProc();
  if (tracked) {
    log("server: killing tracked pid", tracked.pid);
    transition({ kind: "stopping", proc: tracked });
    tracked.kill("SIGTERM");
  }

  const foreignPid = findPidOnPort(port);
  if (foreignPid !== null) {
    log("server: killing foreign pid", foreignPid, "on port", port);
    try {
      process.kill(foreignPid, "SIGTERM");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("server: failed to SIGTERM pid", foreignPid, "—", msg);
    }
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await tryPing(host, port))) {
      log("server: port", port, "is free");
      return;
    }
    await sleep(150);
  }
  log("server: port", port, "still held after 5s — something else has it");
}

function currentProc(): cp.ChildProcess | undefined {
  if (state.kind === "starting" || state.kind === "running" || state.kind === "stopping") {
    return state.proc;
  }
  return undefined;
}

async function waitForReady(host: string, port: number): Promise<void> {
  const timeout = 10_000;
  const interval = 200;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await tryPing(host, port)) {
      log("server: ready after", Date.now() - start, "ms");
      return;
    }
    await sleep(interval);
  }
  log("server: timed out waiting for readiness after", timeout, "ms");
  throw new Error("Timed out waiting for tryke server to start");
}

async function tryPing(host: string, port: number): Promise<boolean> {
  const client = new TrykeClient();
  try {
    await client.connect(host, port);
    await client.request("ping");
    client.disconnect();
    return true;
  } catch (err) {
    client.disconnect();
    const msg = err instanceof Error ? err.message : String(err);
    log("server: ping failed for", `${host}:${port}`, "—", msg);
    return false;
  }
}

function findPidOnPort(port: number): number | null {
  if (process.platform === "win32") {
    return findPidOnPortWindows(port);
  }
  return findPidOnPortUnix(port);
}

// Parses `lsof -ti tcp:<port> -sTCP:LISTEN` output: a newline-separated list
// of PIDs (just numbers, one per line). Returns the first valid PID, or null.
export function parsePidFromLsofOutput(out: string): number | null {
  const trimmed = out.trim();
  if (!trimmed) {
    return null;
  }
  const [firstLine] = trimmed.split("\n");
  if (!firstLine) {
    return null;
  }
  const pid = parseInt(firstLine, 10);
  return Number.isFinite(pid) ? pid : null;
}

// Parses `netstat -ano` output for the LISTENING entry on the given port.
// netstat columns vary across locales; we anchor on the trailing PID and
// require the local-address column to contain `:<port> ` so a different port
// number elsewhere in the table doesn't match.
export function parsePidFromNetstatOutput(
  out: string,
  port: number,
): number | null {
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/LISTENING\s+(\d+)\s*$/);
    if (match && match[1] && line.includes(`:${port} `)) {
      return parseInt(match[1], 10);
    }
  }
  return null;
}

function findPidOnPortUnix(port: number): number | null {
  try {
    const out = cp
      .execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
        stdio: ["ignore", "pipe", "ignore"],
      })
      .toString();
    return parsePidFromLsofOutput(out);
  } catch {
    return null;
  }
}

function findPidOnPortWindows(port: number): number | null {
  try {
    const out = cp
      .execFileSync("netstat", ["-ano"], {
        stdio: ["ignore", "pipe", "ignore"],
      })
      .toString();
    return parsePidFromNetstatOutput(out, port);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pipeToServerChannel(
  stream: NodeJS.ReadableStream | null,
  label: "stdout" | "stderr",
): void {
  if (!stream) {
    return;
  }
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      logServer(label === "stderr" ? `[stderr] ${line}` : line);
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      logServer(label === "stderr" ? `[stderr] ${buffer}` : buffer);
      buffer = "";
    }
  });
}
