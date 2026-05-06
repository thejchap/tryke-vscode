import * as assert from "assert";
import * as vscode from "vscode";
import { buildArgs, collectLeafNames } from "../directRunner";
import type { TrykeConfig } from "../config";

const ROOT = "/workspace/proj";

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

// Hand-rolled stub: vscode.TestItem children is a TestItemCollection with
// forEach/size — buildArgs only needs those.
interface ChildBag {
  size: number;
  forEach: (cb: (child: vscode.TestItem) => void) => void;
}

function bag(items: vscode.TestItem[]): ChildBag {
  return {
    size: items.length,
    forEach: (cb) => items.forEach(cb),
  };
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

suite("buildArgs", () => {
  test("baseline: just `test --reporter json`", () => {
    const args = buildArgs(request(), defaultConfig(), ROOT);
    assert.deepStrictEqual(args, ["test", "--reporter", "json"]);
  });

  test("config.python pushes --python with variable substitution", () => {
    const args = buildArgs(request(), defaultConfig({ python: "${workspaceFolder}/.venv/bin/python3" }), ROOT);
    assert.deepStrictEqual(args, [
      "test", "--reporter", "json",
      "--python", `${ROOT}/.venv/bin/python3`,
    ]);
  });

  test("workers, failFast, maxfail map to -j / --fail-fast / --maxfail", () => {
    const args = buildArgs(
      request(),
      defaultConfig({ workers: 4, failFast: true, maxfail: 2 }),
      ROOT,
    );
    assert.deepStrictEqual(args, [
      "test", "--reporter", "json",
      "-j", "4",
      "--fail-fast",
      "--maxfail", "2",
    ]);
  });

  test("dist + markers", () => {
    const args = buildArgs(
      request(),
      defaultConfig({ dist: "file", markers: "slow and not network" }),
      ROOT,
    );
    assert.deepStrictEqual(args, [
      "test", "--reporter", "json",
      "--dist", "file",
      "-m", "slow and not network",
    ]);
  });

  test("changed='only' → --changed", () => {
    const args = buildArgs(request(), defaultConfig({ changed: "only" }), ROOT);
    assert.ok(args.includes("--changed"));
    assert.ok(!args.includes("--changed-first"));
  });

  test("changed='first' → --changed-first", () => {
    const args = buildArgs(request(), defaultConfig({ changed: "first" }), ROOT);
    assert.ok(args.includes("--changed-first"));
    assert.ok(!args.includes("--changed"));
  });

  test("baseBranch maps to --base-branch", () => {
    const args = buildArgs(request(), defaultConfig({ baseBranch: "main" }), ROOT);
    assert.deepStrictEqual(args.slice(-2), ["--base-branch", "main"]);
  });

  test("config.args is appended verbatim at the end", () => {
    const args = buildArgs(request(), defaultConfig({ args: ["--quiet", "-x"] }), ROOT);
    assert.deepStrictEqual(args.slice(-2), ["--quiet", "-x"]);
  });

  test("file-level selection → bare path", () => {
    const args = buildArgs(
      request([item("tests/test_a.py", [item("tests/test_a.py::test_x")])]),
      defaultConfig(),
      ROOT,
    );
    assert.ok(args.includes("tests/test_a.py"));
    assert.ok(!args.includes("-k"));
  });

  test("group-level selection sends path + -k of leaf names", () => {
    const leaf1 = item("tests/test_a.py::math::test_add");
    const leaf2 = item("tests/test_a.py::math::test_sub");
    const group = item("tests/test_a.py::math", [leaf1, leaf2]);
    const args = buildArgs(request([group]), defaultConfig(), ROOT);
    assert.ok(args.includes("tests/test_a.py"));
    const kIdx = args.indexOf("-k");
    assert.notStrictEqual(kIdx, -1);
    assert.strictEqual(args[kIdx + 1], "test_add or test_sub");
  });

  test("leaf-only selection sends path + -k", () => {
    const leaf = item("tests/test_a.py::test_thing");
    const args = buildArgs(request([leaf]), defaultConfig(), ROOT);
    assert.ok(args.includes("tests/test_a.py"));
    const kIdx = args.indexOf("-k");
    assert.strictEqual(args[kIdx + 1], "test_thing");
  });

  test("[case_label] suffix is stripped before -k since tryke -k rejects brackets", () => {
    const leaf = item("tests/test_cases.py::square[zero]");
    const args = buildArgs(request([leaf]), defaultConfig(), ROOT);
    const kIdx = args.indexOf("-k");
    assert.strictEqual(args[kIdx + 1], "square");
  });

  test("multiple cases of the same function de-dup in -k", () => {
    const a = item("tests/test_cases.py::square[zero]");
    const b = item("tests/test_cases.py::square[one]");
    const c = item("tests/test_cases.py::square[two]");
    const args = buildArgs(request([a, b, c]), defaultConfig(), ROOT);
    const kIdx = args.indexOf("-k");
    assert.strictEqual(args[kIdx + 1], "square");
  });

  test("mixed cases + non-parametrized still de-dup correctly", () => {
    const cased = item("tests/test_cases.py::square[zero]");
    const plain = item("tests/test_cases.py::test_other");
    const args = buildArgs(request([cased, plain]), defaultConfig(), ROOT);
    const kIdx = args.indexOf("-k");
    const expr = args[kIdx + 1];
    assert.ok(expr === "square or test_other" || expr === "test_other or square");
  });

  test("file-level item without `::` in id is treated as a path", () => {
    const fileItem = item("tests/test_a.py", [item("tests/test_a.py::test_x")]);
    const args = buildArgs(request([fileItem]), defaultConfig(), ROOT);
    assert.ok(args.includes("tests/test_a.py"));
    assert.ok(!args.includes("-k"));
  });
});

suite("collectLeafNames", () => {
  test("returns the bare name for a single leaf", () => {
    const names: string[] = [];
    collectLeafNames(item("tests/a.py::test_x"), names);
    assert.deepStrictEqual(names, ["test_x"]);
  });

  test("recurses into children for groups", () => {
    const leafA = item("tests/a.py::g::test_a");
    const leafB = item("tests/a.py::g::test_b");
    const group = item("tests/a.py::g", [leafA, leafB]);
    const names: string[] = [];
    collectLeafNames(group, names);
    assert.deepStrictEqual(names, ["test_a", "test_b"]);
  });

  test("nested groups are flattened", () => {
    const leafX = item("tests/a.py::outer::inner::test_x");
    const inner = item("tests/a.py::outer::inner", [leafX]);
    const outer = item("tests/a.py::outer", [inner]);
    const names: string[] = [];
    collectLeafNames(outer, names);
    assert.deepStrictEqual(names, ["test_x"]);
  });
});
