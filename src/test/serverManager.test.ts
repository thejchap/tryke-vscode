import * as assert from "assert";
import * as cp from "child_process";
import { EventEmitter } from "events";
import { TrykeClient } from "../client";
import {
  hasActiveServer,
  stopServer,
  _getStateForTesting,
  _setStateForTesting,
} from "../serverManager";

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
});
