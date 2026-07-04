import * as assert from "assert";
import * as cp from "child_process";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { TrykeClient } from "../client";
import {
  buildServerArgs,
  ensureServer,
  hasActiveServer,
  stopServer,
  _getStateForTesting,
  _setSpawnForTesting,
  _setStateForTesting,
} from "../serverManager";
import type { TrykeConfig } from "../config";

function defaultConfig(overrides: Partial<TrykeConfig> = {}): TrykeConfig {
  return {
    command: "tryke",
    python: null,
    mode: "server",
    server: { logLevel: "info" },
    workers: null,
    failFast: false,
    maxfail: null,
    dist: null,
    markers: null,
    changed: "off",
    baseBranch: null,
    args: [],
    ...overrides,
  };
}

suite("buildServerArgs", () => {
  test("passes root, python, and workers to the server child", () => {
    const args = buildServerArgs(
      defaultConfig({
        python: "${workspaceFolder}/.venv/bin/python",
        workers: 2,
      }),
      "/workspace/proj",
    );

    assert.deepStrictEqual(args, [
      "server",
      "--root",
      "/workspace/proj",
      "--python",
      "/workspace/proj/.venv/bin/python",
      "--workers",
      "2",
    ]);
  });
});

// A minimal stand-in for cp.ChildProcess. We only need .pid, .kill,
// .exitCode, and event emission — and to be referentially distinct so the
// state machine can compare procs by identity. Casting through `unknown`
// keeps the call sites honest about this being a fake.
function fakeProc(pid = 1234): cp.ChildProcess {
  const ee = new EventEmitter() as cp.ChildProcess;
  Object.assign(ee, {
    pid,
    exitCode: null,
    killed: false,
    kill: () => true,
  });
  return ee;
}

function markExited(proc: cp.ChildProcess): void {
  Object.defineProperty(proc, "exitCode", {
    configurable: true,
    value: 0,
  });
}

function fakeReadyProc(pid = 5678): cp.ChildProcess {
  const proc = fakeProc(pid);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()) as {
      id: number;
      method: string;
    };
    if (request.method === "ping") {
      stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result: null }) + "\n",
      );
    }
  });
  Object.assign(proc, {
    stdin,
    stdout,
    stderr,
    unref: () => proc,
  });
  return proc;
}

// Like fakeReadyProc, but answers `ping` with a JSON-RPC error so the
// readiness probe rejects instead of resolving.
function fakeFailingReadyProc(pid = 7777): cp.ChildProcess {
  const proc = fakeProc(pid);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()) as {
      id: number;
      method: string;
    };
    if (request.method === "ping") {
      stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -1, message: "not ready" },
        }) + "\n",
      );
    }
  });
  Object.assign(proc, { stdin, stdout, stderr, unref: () => proc });
  return proc;
}

// The state machine only ever calls disconnect() on the client during a
// stop, so a spy for that one method is all the fake needs.
function fakeClient(onDisconnect?: () => void): TrykeClient {
  return {
    disconnect: () => onDisconnect?.(),
  } as unknown as TrykeClient;
}

suite("server state machine", () => {
  teardown(() => {
    _setStateForTesting({ kind: "idle" });
    _setSpawnForTesting(undefined);
  });

  test("starts in idle state with no active server", () => {
    _setStateForTesting({ kind: "idle" });
    assert.strictEqual(_getStateForTesting().kind, "idle");
    assert.strictEqual(hasActiveServer(), false);
  });

  test("hasActiveServer is true while starting or running", () => {
    const proc = fakeProc();
    const client = fakeClient();
    _setStateForTesting({
      kind: "starting",
      proc,
      client,
      ready: Promise.resolve(client),
    });
    assert.strictEqual(hasActiveServer(), true);

    _setStateForTesting({ kind: "running", proc, client });
    assert.strictEqual(hasActiveServer(), true);
  });

  test("hasActiveServer is false while stopping or idle", () => {
    const proc = fakeProc();
    _setStateForTesting({ kind: "stopping", proc });
    assert.strictEqual(hasActiveServer(), false);

    _setStateForTesting({ kind: "idle" });
    assert.strictEqual(hasActiveServer(), false);
  });

  test("stopServer transitions running → stopping and disconnects the session", () => {
    let disconnected = false;
    const proc = fakeProc();
    _setStateForTesting({
      kind: "running",
      proc,
      client: fakeClient(() => {
        disconnected = true;
      }),
    });

    stopServer();

    const state = _getStateForTesting();
    if (state.kind !== "stopping") {
      throw new Error(`expected stopping, got ${state.kind}`);
    }
    assert.strictEqual(state.proc, proc);
    // EOF on the server's stdin (via disconnect) is the shutdown signal;
    // SIGTERM only fires later if the process ignores it.
    assert.strictEqual(disconnected, true);
  });

  test("stopServer is a no-op when already idle", () => {
    _setStateForTesting({ kind: "idle" });
    stopServer();
    assert.strictEqual(_getStateForTesting().kind, "idle");
  });

  test("stopServer can interrupt a starting state", () => {
    const proc = fakeProc();
    let disconnected = false;
    const client = fakeClient(() => {
      disconnected = true;
    });
    _setStateForTesting({
      kind: "starting",
      proc,
      client,
      ready: new Promise(() => {
        /* never */
      }),
    });

    stopServer();

    assert.strictEqual(_getStateForTesting().kind, "stopping");
    assert.strictEqual(disconnected, true);
  });

  test("concurrent starts after a stop share one replacement server", async () => {
    const stoppingProc = fakeProc(1000);
    stoppingProc.once("exit", () => {
      _setStateForTesting({ kind: "idle" });
    });
    _setStateForTesting({ kind: "stopping", proc: stoppingProc });

    let spawnCount = 0;
    let replacement: cp.ChildProcess | undefined;
    _setSpawnForTesting(((...args: Parameters<typeof cp.spawn>) => {
      void args;
      spawnCount++;
      replacement = fakeReadyProc(2000);
      return replacement;
    }) as typeof cp.spawn);

    const first = ensureServer(defaultConfig(), "/workspace");
    const second = ensureServer(defaultConfig(), "/workspace");

    markExited(stoppingProc);
    stoppingProc.emit("exit", 0, null);

    const [firstClient, secondClient] = await Promise.all([first, second]);
    assert.strictEqual(spawnCount, 1);
    assert.strictEqual(firstClient, secondClient);

    stopServer();
    if (replacement) {
      markExited(replacement);
      replacement.emit("exit", 0, null);
    }
  });

  test("readiness failure tears down via the stop path, not idle + bare SIGTERM", async () => {
    _setStateForTesting({ kind: "idle" });
    let failing: cp.ChildProcess | undefined;
    _setSpawnForTesting(((...args: Parameters<typeof cp.spawn>) => {
      void args;
      failing = fakeFailingReadyProc(7777);
      return failing;
    }) as typeof cp.spawn);

    await assert.rejects(ensureServer(defaultConfig(), "/workspace"), /not ready/i);

    // Routed through stopServer(): state is `stopping` (so a concurrent
    // ensureServer waits for this child) rather than `idle` (which would let it
    // spawn a second server while this one is still dying).
    const state = _getStateForTesting();
    assert.strictEqual(state.kind, "stopping", `expected stopping, got ${state.kind}`);

    // Let the exit fire so teardown returns us to idle for the next test.
    if (failing) {
      markExited(failing);
      failing.emit("exit", 0, null);
    }
    assert.strictEqual(_getStateForTesting().kind, "idle");
  });
});
