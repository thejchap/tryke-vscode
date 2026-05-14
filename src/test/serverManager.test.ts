import * as assert from "assert";
import * as cp from "child_process";
import { EventEmitter } from "events";
import {
  parsePidFromLsofOutput,
  parsePidFromNetstatOutput,
  hasActiveServer,
  stopServer,
  _getStateForTesting,
  _setStateForTesting,
} from "../serverManager";

// A minimal stand-in for cp.ChildProcess. We only need .pid and .kill — and
// to be referentially distinct so the state machine can compare procs by
// identity. Casting through `unknown` keeps the call sites honest about
// this being a fake.
function fakeProc(pid = 1234): cp.ChildProcess {
  const ee = new EventEmitter() as cp.ChildProcess;
  Object.assign(ee, {
    pid,
    kill: () => true,
  });
  return ee;
}

suite("parsePidFromLsofOutput", () => {
  test("parses a single PID line from `lsof -ti`", () => {
    assert.strictEqual(parsePidFromLsofOutput("12345\n"), 12345);
  });

  test("returns null for empty output", () => {
    assert.strictEqual(parsePidFromLsofOutput(""), null);
    assert.strictEqual(parsePidFromLsofOutput("   \n"), null);
  });

  test("returns the first PID when multiple processes hold the port", () => {
    assert.strictEqual(parsePidFromLsofOutput("100\n200\n300\n"), 100);
  });

  test("returns null when the first line isn't a number", () => {
    assert.strictEqual(parsePidFromLsofOutput("not-a-pid\n"), null);
  });

  test("trims surrounding whitespace", () => {
    assert.strictEqual(parsePidFromLsofOutput("  \n42\n  "), 42);
  });
});

suite("parsePidFromNetstatOutput", () => {
  // netstat -ano output sample. We require both the trailing PID and the
  // `:port ` substring on the same line; other ports must not match.
  const sample = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       948
  TCP    0.0.0.0:2337           0.0.0.0:0              LISTENING       12345
  TCP    0.0.0.0:5040           0.0.0.0:0              LISTENING       4096
  TCP    [::]:2337              [::]:0                 LISTENING       12345
`;

  test("returns the PID for the matching port", () => {
    assert.strictEqual(parsePidFromNetstatOutput(sample, 2337), 12345);
  });

  test("returns null when no line matches the port", () => {
    assert.strictEqual(parsePidFromNetstatOutput(sample, 9999), null);
  });

  test("does not match a port that's a substring of another", () => {
    // 040 is a suffix of 5040, but the `:port ` anchor saves us
    assert.strictEqual(parsePidFromNetstatOutput(sample, 40), null);
  });

  test("returns null on empty output", () => {
    assert.strictEqual(parsePidFromNetstatOutput("", 2337), null);
  });

  test("ignores ESTABLISHED rows even on the same port", () => {
    const established =
      "  TCP    0.0.0.0:2337           1.2.3.4:55555         ESTABLISHED     999\n";
    assert.strictEqual(parsePidFromNetstatOutput(established, 2337), null);
  });
});

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
    _setStateForTesting({
      kind: "starting",
      proc,
      ready: Promise.resolve(),
    });
    assert.strictEqual(hasActiveServer(), true);

    _setStateForTesting({ kind: "running", proc });
    assert.strictEqual(hasActiveServer(), true);
  });

  test("hasActiveServer is false while stopping or idle", () => {
    const proc = fakeProc();
    _setStateForTesting({ kind: "stopping", proc });
    assert.strictEqual(hasActiveServer(), false);

    _setStateForTesting({ kind: "idle" });
    assert.strictEqual(hasActiveServer(), false);
  });

  test("stopServer transitions running → stopping and SIGTERMs the proc", () => {
    let killed: NodeJS.Signals | number | undefined;
    const proc = fakeProc();
    proc.kill = (signal?: NodeJS.Signals | number) => {
      killed = signal;
      return true;
    };
    _setStateForTesting({ kind: "running", proc });

    stopServer();

    const state = _getStateForTesting();
    if (state.kind !== "stopping") {
      throw new Error(`expected stopping, got ${state.kind}`);
    }
    assert.strictEqual(state.proc, proc);
    assert.strictEqual(killed, "SIGTERM");
  });

  test("stopServer is a no-op when already idle", () => {
    _setStateForTesting({ kind: "idle" });
    stopServer();
    assert.strictEqual(_getStateForTesting().kind, "idle");
  });

  test("stopServer can interrupt a starting state", () => {
    const proc = fakeProc();
    let killed = false;
    proc.kill = () => {
      killed = true;
      return true;
    };
    _setStateForTesting({
      kind: "starting",
      proc,
      ready: new Promise(() => {
        /* never */
      }),
    });

    stopServer();

    assert.strictEqual(_getStateForTesting().kind, "stopping");
    assert.strictEqual(killed, true);
  });
});
