import * as assert from "assert";
import * as vscode from "vscode";
import { buildRunParams, collectLeafServerIds } from "../serverRunner";
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
