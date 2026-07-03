import * as cp from "child_process";
import { TrykeClient } from "./client";
import { TrykeConfig } from "./config";
import { log, logServer } from "./log";
import { resolveVariables } from "./resolveVariables";

// How long to wait for the initial `ping` response after spawning. The
// server answers only after its worker pool is warm and initial discovery
// has run, which can take a while on a cold interpreter / large project.
const READY_TIMEOUT_MS = 30_000;

// After asking the server to exit (EOF on its stdin), how long to wait for
// a voluntary exit before escalating to SIGTERM.
const SHUTDOWN_GRACE_MS = 3_000;

// State of the spawned tryke server process. The server speaks JSON-RPC
// over its own stdio, so the process and the client are one unit: exactly
// one session exists per server, owned here and shared by every runner.
// Encoded as a discriminated union so every transition is explicit; the
// previous shape was a single `let serverProcess: ChildProcess | undefined`
// mutated from several places, which made races hard to reason about —
// e.g. two `ensureServer` calls landing in the same tick both saw
// `undefined` and both spawned.
export type ServerState =
  | { kind: "idle" }
  | {
      kind: "starting";
      proc: cp.ChildProcess;
      client: TrykeClient;
      ready: Promise<TrykeClient>;
    }
  | { kind: "running"; proc: cp.ChildProcess; client: TrykeClient }
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

/**
 * Ensure a server child is running and return the shared client bound to
 * its stdio. The server is always a child of this extension host — stdio
 * is a single private session, so there is no such thing as attaching to
 * a foreign server anymore.
 */
export async function ensureServer(
  config: TrykeConfig,
  workspaceRoot: string,
): Promise<TrykeClient> {
  if (state.kind === "running") {
    return state.client;
  }

  // Concurrent ensureServer calls: piggy-back on the in-flight start
  // rather than spawning a second process.
  if (state.kind === "starting") {
    log("server: ensureServer awaiting in-flight start");
    return state.ready;
  }

  if (!config.server.autoStart) {
    log("server: no running server and autoStart is disabled");
    throw new Error(
      "No tryke server is running and autoStart is disabled",
    );
  }

  // Pass `--root` AND set `cwd` to the workspace. tryke writes its discovery
  // cache to `<root>/.tryke/cache/discovery-v1.bin` and falls back to cwd
  // when `--root` isn't passed; on macOS the extension host's cwd is often
  // `/`, which is read-only, so the cache write fails and discovery has to
  // start from scratch on every server restart.
  const spawnArgs = ["server", "--root", workspaceRoot];
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

  // stdin/stdout are the RPC session — the extension owns them for the
  // life of the process. Only stderr carries human-readable logs now.
  const proc = cp.spawn(config.command, spawnArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: workspaceRoot,
    env: { ...process.env, TRYKE_LOG: trykeLog },
  });

  pipeToServerChannel(proc.stderr);

  logServer(`--- server starting: ${config.command} ${spawnArgs.join(" ")} (pid ${proc.pid}) ---`);
  log("server: spawned pid", proc.pid);

  const client = new TrykeClient();
  client.attach(proc.stdin, proc.stdout);

  proc.on("error", (err) => {
    log("server: spawn error:", err.message);
    logServer(`--- server spawn error: ${err.message} ---`);
    if (currentProc() === proc) {
      client.disconnect();
      transition({ kind: "idle" });
    }
  });

  proc.on("exit", (code, signal) => {
    log("server: exited code =", code, "signal =", signal);
    logServer(`--- server exited code=${code} signal=${signal} ---`);
    // Reject anything still in flight — the session died with the process.
    client.disconnect();
    if (currentProc() === proc) {
      transition({ kind: "idle" });
    }
  });

  const ready = waitForReady(client);
  transition({ kind: "starting", proc, client, ready });

  try {
    await ready;
  } catch (err) {
    if (currentProc() === proc) {
      transition({ kind: "idle" });
    }
    proc.kill("SIGTERM");
    throw err;
  }

  // The exit handler may have already moved us back to idle if the server
  // crashed during the readiness wait. Only promote to running if we still
  // own this proc. Read through `_getStateForTesting()` so TS doesn't
  // narrow `state` based on the pre-await snapshot — handlers that fired
  // during the await can have transitioned us elsewhere.
  const after = _getStateForTesting();
  if (after.kind === "starting" && after.proc === proc) {
    transition({ kind: "running", proc, client });
  }
  return client;
}

/**
 * Ask the server to shut down. EOF on its stdin is the protocol's
 * shutdown signal; SIGTERM is the escalation for a server that doesn't
 * exit within the grace window.
 */
export function stopServer(): void {
  if (state.kind === "running" || state.kind === "starting") {
    const { proc, client } = state;
    log("server: stopping pid", proc.pid);
    transition({ kind: "stopping", proc });
    // disconnect() half-closes the server's stdin — the LSP-style
    // shutdown signal — after flushing any queued frame.
    client.disconnect();
    const escalate = setTimeout(() => {
      if (proc.exitCode === null && !proc.killed) {
        log("server: pid", proc.pid, "still alive after EOF — sending SIGTERM");
        proc.kill("SIGTERM");
      }
    }, SHUTDOWN_GRACE_MS);
    // Don't let the escalation timer hold the process open.
    escalate.unref();
    proc.once("exit", () => clearTimeout(escalate));
  }
}

/**
 * Stop the server and resolve once the process has actually exited (or
 * the wait times out). Used by the stop/restart commands so a follow-up
 * `ensureServer` doesn't race the dying process.
 */
export async function stopServerAndWait(): Promise<void> {
  const proc = currentProc();
  stopServer();
  if (!proc || proc.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      log("server: pid", proc.pid, "did not exit within grace — continuing anyway");
      resolve();
    }, SHUTDOWN_GRACE_MS + 2_000);
    timeout.unref();
    proc.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

/**
 * True iff the extension currently tracks a live server child process.
 *
 * With the stdio transport the extension is the only possible client, so
 * this is authoritative — there is no foreign-server case anymore.
 */
export function hasActiveServer(): boolean {
  return state.kind === "starting" || state.kind === "running";
}

function currentProc(): cp.ChildProcess | undefined {
  if (state.kind === "starting" || state.kind === "running" || state.kind === "stopping") {
    return state.proc;
  }
  return undefined;
}

// A single `ping` request doubles as the readiness probe: the server
// reads requests as soon as it starts but only responds once its worker
// pool is warm and initial discovery has completed, so the response IS
// the ready signal — no polling loop needed on a same-process pipe.
async function waitForReady(client: TrykeClient): Promise<TrykeClient> {
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    const t = setTimeout(
      () => reject(new Error("Timed out waiting for tryke server to start")),
      READY_TIMEOUT_MS,
    );
    t.unref();
    timer = t;
  });
  try {
    await Promise.race([client.request("ping"), timeout]);
    log("server: ready after", Date.now() - start, "ms");
    return client;
  } finally {
    clearTimeout(timer);
  }
}

function pipeToServerChannel(stream: NodeJS.ReadableStream | null): void {
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
      logServer(line);
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      logServer(buffer);
      buffer = "";
    }
  });
}
