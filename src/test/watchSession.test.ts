import * as assert from "assert";
import { isInScope } from "../watchSession";

suite("isInScope", () => {
  test("exact match is in scope", () => {
    const include = new Set(["tests/a.py::test_x"]);
    assert.strictEqual(isInScope("tests/a.py::test_x", include), true);
  });

  test("file-level include covers all children", () => {
    const include = new Set(["tests/a.py"]);
    assert.strictEqual(isInScope("tests/a.py::test_x", include), true);
    assert.strictEqual(isInScope("tests/a.py::group::test_y", include), true);
  });

  test("group-level include covers all descendants", () => {
    const include = new Set(["tests/a.py::math"]);
    assert.strictEqual(isInScope("tests/a.py::math::test_add", include), true);
    assert.strictEqual(isInScope("tests/a.py::math::nested::test_sub", include), true);
  });

  test("nested group-level include is honored", () => {
    const include = new Set(["tests/a.py::outer::inner"]);
    assert.strictEqual(isInScope("tests/a.py::outer::inner::test_x", include), true);
    assert.strictEqual(isInScope("tests/a.py::outer::test_x", include), false);
  });

  test("unrelated test is not in scope", () => {
    const include = new Set(["tests/a.py::test_x"]);
    assert.strictEqual(isInScope("tests/a.py::test_y", include), false);
    assert.strictEqual(isInScope("tests/b.py::test_x", include), false);
  });

  test("[case_label] leaves are matched as exact ids", () => {
    const include = new Set(["tests/cases.py::square[zero]"]);
    assert.strictEqual(isInScope("tests/cases.py::square[zero]", include), true);
    assert.strictEqual(isInScope("tests/cases.py::square[one]", include), false);
  });

  test("file include with case-label leaf is in scope", () => {
    const include = new Set(["tests/cases.py"]);
    assert.strictEqual(isInScope("tests/cases.py::square[zero]", include), true);
  });

  test("similar-prefix file is not a false positive", () => {
    // "tests/a.py" must NOT cover "tests/a_extra.py::test_x" — split happens
    // on `::`, so this case is covered by the prefix-on-`::` walk.
    const include = new Set(["tests/a.py"]);
    assert.strictEqual(isInScope("tests/a_extra.py::test_x", include), false);
  });

  test("empty include set never matches", () => {
    const include = new Set<string>();
    assert.strictEqual(isInScope("tests/a.py::test_x", include), false);
    assert.strictEqual(isInScope("tests/a.py", include), false);
  });
});
