import * as cp from "child_process";
import { TrykeClient } from "./client";
import { TrykeConfig } from "./config";
import { log, logServer } from "./log";

let serverProcess: cp.ChildProcess | undefined;

export async function ensureServer(config: TrykeConfig): Promise<void> {
  const endpoint = `${config.server.host}:${config.server.port}`;
  log("server: ensureServer at", endpoint);

  if (await tryPing(config.server.host, config.server.port)) {
    log("server: reusing existing server at", endpoint);
    return;
  }

  if (!config.server.autoStart) {
    log("server: no existing server at", endpoint, "and autoStart is disabled");
    throw new Error(
      `Cannot connect to tryke server at ${endpoint} and autoStart is disabled`,
    );
  }

  const spawnArgs = ["server", "--port", String(config.server.port)];
  log("server: spawning", config.command, spawnArgs.join(" "));

  serverProcess = cp.spawn(config.command, spawnArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  serverProcess.unref();

  pipeToServerChannel(serverProcess.stdout, "stdout");
  pipeToServerChannel(serverProcess.stderr, "stderr");

  logServer(`--- server starting: ${config.command} ${spawnArgs.join(" ")} (pid ${serverProcess.pid}) ---`);
  log("server: spawned pid", serverProcess.pid);

  serverProcess.on("error", (err) => {
    log("server: spawn error:", err.message);
    logServer(`--- server spawn error: ${err.message} ---`);
    serverProcess = undefined;
  });

  serverProcess.on("exit", (code, signal) => {
    log("server: exited code =", code, "signal =", signal);
    logServer(`--- server exited code=${code} signal=${signal} ---`);
    serverProcess = undefined;
  });

  const timeout = 10_000;
  const interval = 200;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (await tryPing(config.server.host, config.server.port)) {
      log("server: ready after", Date.now() - start, "ms");
      return;
    }
    await sleep(interval);
  }

  log("server: timed out waiting for readiness after", timeout, "ms");
  throw new Error("Timed out waiting for tryke server to start");
}

export function stopServer(): void {
  if (serverProcess) {
    log("server: stopping pid", serverProcess.pid);
    serverProcess.kill("SIGTERM");
    serverProcess = undefined;
  }
}

/**
 * Kill whatever (if anything) is listening on the tryke server port.
 *
 * First tries the `serverProcess` we spawned ourselves; then falls back to
 * looking the PID up with `lsof` (macOS/Linux) or `netstat`/`taskkill`
 * (Windows) so foreign / stale servers — e.g. leftovers from a previous
 * session with a different tryke binary — can be cleared without manual
 * shell gymnastics. Waits until the port is free (or the timeout expires).
 */
export async function killServerOnPort(
  host: string,
  port: number,
): Promise<void> {
  if (serverProcess) {
    const pid = serverProcess.pid;
    log("server: killing tracked pid", pid);
    serverProcess.kill("SIGTERM");
    serverProcess = undefined;
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

function findPidOnPortUnix(port: number): number | null {
  try {
    const out = cp
      .execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
        stdio: ["ignore", "pipe", "ignore"],
      })
      .toString()
      .trim();
    if (!out) {
      return null;
    }
    const pid = parseInt(out.split("\n")[0], 10);
    return Number.isFinite(pid) ? pid : null;
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
    for (const line of out.split(/\r?\n/)) {
      const match = line.match(/LISTENING\s+(\d+)\s*$/);
      if (match && line.includes(`:${port} `)) {
        return parseInt(match[1], 10);
      }
    }
    return null;
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
