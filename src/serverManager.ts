import * as cp from "child_process";
import { TrykeClient } from "./client";
import { TrykeConfig } from "./config";

let serverProcess: cp.ChildProcess | undefined;

export async function ensureServer(config: TrykeConfig): Promise<void> {
  // Try to connect and ping
  if (await tryPing(config.server.host, config.server.port)) {
    return;
  }

  if (!config.server.autoStart) {
    throw new Error(
      `Cannot connect to tryke server at ${config.server.host}:${config.server.port} and autoStart is disabled`,
    );
  }

  // Spawn server
  serverProcess = cp.spawn(
    config.command,
    ["server", "--port", String(config.server.port)],
    {
      stdio: "ignore",
      detached: true,
    },
  );

  serverProcess.unref();

  serverProcess.on("error", () => {
    serverProcess = undefined;
  });

  serverProcess.on("exit", () => {
    serverProcess = undefined;
  });

  // Poll for server readiness
  const timeout = 10_000;
  const interval = 200;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (await tryPing(config.server.host, config.server.port)) {
      return;
    }
    await sleep(interval);
  }

  throw new Error("Timed out waiting for tryke server to start");
}

export function stopServer(): void {
  if (serverProcess) {
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
  } catch {
    client.disconnect();
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
