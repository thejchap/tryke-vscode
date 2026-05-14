import * as assert from "assert";
import * as vscode from "vscode";
import {
  buildRunParams,
  collectLeafServerIds,
  dispatchRun,
  DispatchClient,
} from "../serverRunner";
import type { TrykeConfig } from "../config";

function defaultConfig(overrides: Partial<TrykeConfig> = {}): TrykeConfig {
  return {
    command: "tryke",
    python: null,
    mode: "auto",
    server: { host: "127.0.0.1", port: 2337, autoStart: true, autoStop: true, logLevel: "info" },
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

interface ChildBag {
  size: number;
  forEach: (cb: (child: vscode.TestItem) => void) => void;
}
function bag(items: vscode.TestItem[]): ChildBag {
  return { size: items.length, forEach: (cb) => items.forEach(cb) };
}
function item(id: string, children: vscode.TestItem[] = []): vscode.TestItem {
  return {
    id,
    children: bag(children) as unknown as vscode.TestItemCollection,
  } as unknown as vscode.TestItem;
}
function request(include?: vscode.TestItem[]): vscode.TestRunRequest {
  return { include } as unknown as vscode.TestRunRequest;
}

suite("buildRunParams", () => {
  test("baseline: only run_id when nothing is selected", () => {
    const params = buildRunParams(request(), defaultConfig(), "run-1");
    assert.deepStrictEqual(params, { run_id: "run-1" });
  });

  test("markers from config flow through", () => {
    const params = buildRunParams(request(), defaultConfig({ markers: "slow" }), "run-1");
    assert.strictEqual(params.markers, "slow");
  });

  test("file-level selection produces paths only", () => {
    const file = item("tests/a.py", [item("tests/a.py::test_x")]);
    const params = buildRunParams(request([file]), defaultConfig(), "run-1");
    assert.deepStrictEqual(params.paths, ["tests/a.py"]);
    assert.strictEqual(params.tests, undefined);
  });

  test("group-level selection collects leaf server IDs (file::name, no groups)", () => {
    const leafA = item("tests/a.py::math::test_add");
    const leafB = item("tests/a.py::math::test_sub");
    const group = item("tests/a.py::math", [leafA, leafB]);
    const params = buildRunParams(request([group]), defaultConfig(), "run-1");
    assert.deepStrictEqual(params.tests, ["tests/a.py::test_add", "tests/a.py::test_sub"]);
    assert.strictEqual(params.paths, undefined);
  });

  test("leaf-only selection sends file::name regardless of nesting", () => {
    const leaf = item("tests/a.py::outer::inner::test_x");
    const params = buildRunParams(request([leaf]), defaultConfig(), "run-1");
    assert.deepStrictEqual(params.tests, ["tests/a.py::test_x"]);
  });

  test("mixed file + group + leaf populates both arrays", () => {
    const file = item("tests/a.py", [item("tests/a.py::test_x")]);
    const group = item("tests/b.py::g", [item("tests/b.py::g::test_y")]);
    const leaf = item("tests/c.py::test_z");
    const params = buildRunParams(request([file, group, leaf]), defaultConfig(), "run-1");
    assert.deepStrictEqual(params.paths, ["tests/a.py"]);
    assert.deepStrictEqual(params.tests, ["tests/b.py::test_y", "tests/c.py::test_z"]);
  });

  test("run_id is always echoed back", () => {
    const params = buildRunParams(request(), defaultConfig(), "vscode-1234-abcd-1");
    assert.strictEqual(params.run_id, "vscode-1234-abcd-1");
  });
});

suite("collectLeafServerIds", () => {
  test("flattens nested groups onto file::name", () => {
    const leafX = item("tests/a.py::outer::inner::test_x");
    const inner = item("tests/a.py::outer::inner", [leafX]);
    const outer = item("tests/a.py::outer", [inner]);
    const ids: string[] = [];
    collectLeafServerIds(outer, ids);
    assert.deepStrictEqual(ids, ["tests/a.py::test_x"]);
  });

  test("preserves [case_label] suffix on the leaf", () => {
    const leaf = item("tests/cases.py::square[zero]");
    const ids: string[] = [];
    collectLeafServerIds(leaf, ids);
    assert.deepStrictEqual(ids, ["tests/cases.py::square[zero]"]);
  });
});

// Minimal DispatchClient that tracks attached/detached handlers so a test
// can assert dispatchRun cleans up after itself. `request` invokes every
// installed `run_complete` handler before resolving so dispatchRun doesn't
// stall waiting on the broadcast — mirrors the real server's "flush
// notifications, then respond" order from the test's perspective.
class TrackingClient implements DispatchClient {
  attached = new Map<string, Set<(p: unknown) => void>>();
  onNotification(method: string, handler: (p: unknown) => void): void {
    let s = this.attached.get(method);
    if (!s) {
      s = new Set();
      this.attached.set(method, s);
    }
    s.add(handler);
  }
  offNotification(method: string, handler: (p: unknown) => void): void {
    this.attached.get(method)?.delete(handler);
  }
  request<T = unknown>(_method: string, params?: unknown): Promise<T> {
    const runId = (params as { run_id: string }).run_id;
    for (const h of this.attached.get("run_complete") ?? []) {
      h({ run_id: runId, summary: { passed: 0, failed: 0, skipped: 0 } });
    }
    return Promise.resolve(undefined as T);
  }
  disconnect(): void {}
  totalAttached(): number {
    let n = 0;
    for (const s of this.attached.values()) {
      n += s.size;
    }
    return n;
  }
}

suite("dispatchRun handler lifecycle", () => {
  test("removes every notification handler it registered once the run resolves", async () => {
    const client = new TrackingClient();
    const testMap = new Map<string, vscode.TestItem>();
    const testRun = {
      started: () => undefined,
      enqueued: () => undefined,
      passed: () => undefined,
      failed: () => undefined,
      errored: () => undefined,
      skipped: () => undefined,
      appendOutput: () => undefined,
      end: () => undefined,
    } as unknown as vscode.TestRun;
    const token = new vscode.CancellationTokenSource().token;

    await dispatchRun(
      client,
      request(),
      testRun,
      testMap,
      defaultConfig(),
      "/workspace",
      token,
      false,
    );

    assert.strictEqual(
      client.totalAttached(),
      0,
      "dispatchRun must offNotification every handler it onNotification'd — " +
        "otherwise a persistent client (watch mode) accumulates stale handlers per rerun",
    );
  });

  test("removes handlers when the run is cancelled before the RPC resolves", async () => {
    // Stub the request so it never resolves on its own — only cancellation
    // will end the run.
    const client = new TrackingClient();
    client.request = <T = unknown>(): Promise<T> => new Promise<T>(() => undefined);

    const tokenSource = new vscode.CancellationTokenSource();
    const testRun = {
      started: () => undefined,
      enqueued: () => undefined,
      passed: () => undefined,
      failed: () => undefined,
      errored: () => undefined,
      skipped: () => undefined,
      appendOutput: () => undefined,
      end: () => undefined,
    } as unknown as vscode.TestRun;

    const runP = dispatchRun(
      client,
      request(),
      testRun,
      new Map(),
      defaultConfig(),
      "/workspace",
      tokenSource.token,
      false,
    );
    tokenSource.cancel();
    await runP;

    assert.strictEqual(client.totalAttached(), 0);
  });
});
