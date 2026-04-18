import * as cp from "child_process";
import { TrykeClient } from "./client";
import { TrykeConfig } from "./config";
import { log } from "./log";

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
    stdio: "ignore",
    detached: true,
  });

  serverProcess.unref();

  log("server: spawned pid", serverProcess.pid);

  serverProcess.on("error", (err) => {
    log("server: spawn error:", err.message);
    serverProcess = undefined;
  });

  serverProcess.on("exit", (code, signal) => {
    log("server: exited code =", code, "signal =", signal);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
