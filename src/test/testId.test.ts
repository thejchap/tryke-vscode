import * as assert from "assert";
import { buildTestId, splitCaseLabel } from "../testId";

suite("buildTestId", () => {
  const root = "/workspace/proj";

  test("plain test produces relPath::name", () => {
    const id = buildTestId(
      { name: "test_thing", file_path: "tests/test_a.py", module_path: "tests.test_a" },
      root,
    );
    assert.strictEqual(id, "tests/test_a.py::test_thing");
  });

  test("test inside describe groups is joined by ::", () => {
    const id = buildTestId(
      {
        name: "test_thing",
        file_path: "tests/test_a.py",
        module_path: "tests.test_a",
        groups: ["outer", "inner"],
      },
      root,
    );
    assert.strictEqual(id, "tests/test_a.py::outer::inner::test_thing");
  });

  test("@test.cases entry appends [case_label] to the leaf", () => {
    const id = buildTestId(
      {
        name: "square",
        file_path: "tests/test_cases.py",
        module_path: "tests.test_cases",
        case_label: "zero",
      },
      root,
    );
    assert.strictEqual(id, "tests/test_cases.py::square[zero]");
  });

  test("case_label survives describe-group nesting", () => {
    const id = buildTestId(
      {
        name: "square",
        file_path: "tests/test_cases.py",
        module_path: "tests.test_cases",
        groups: ["math"],
        case_label: "zero",
      },
      root,
    );
    assert.strictEqual(id, "tests/test_cases.py::math::square[zero]");
  });

  test("absolute file_path is normalized to a workspace-relative path", () => {
    const id = buildTestId(
      {
        name: "test_x",
        file_path: "/workspace/proj/tests/test_a.py",
        module_path: "tests.test_a",
      },
      root,
    );
    assert.strictEqual(id, "tests/test_a.py::test_x");
  });
});

suite("splitCaseLabel", () => {
  test("returns bare name unchanged when no suffix", () => {
    assert.deepStrictEqual(splitCaseLabel("square"), { name: "square" });
  });

  test("splits identifier-style label", () => {
    assert.deepStrictEqual(splitCaseLabel("square[zero]"), {
      name: "square",
      caseLabel: "zero",
    });
  });

  test("splits string-literal-style label with spaces and operators", () => {
    assert.deepStrictEqual(splitCaseLabel("add[2 + 3]"), {
      name: "add",
      caseLabel: "2 + 3",
    });
  });
});
