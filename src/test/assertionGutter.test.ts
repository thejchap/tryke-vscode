import * as assert from "assert";
import { computeAssertionMarks, AssertionMark } from "../assertionGutter";
import type {
  TrykeTestResult,
  TrykeTestOutcome,
  TrykeExpectedAssertion,
  TrykeAssertion,
} from "../types";

function expected(line: number): TrykeExpectedAssertion {
  return {
    subject: "x",
    matcher: "to_equal",
    negated: false,
    args: ["1"],
    line,
  };
}

function failedAssertion(
  line: number,
  file: string | null = null,
): TrykeAssertion {
  return {
    expression: "expect(x).to_equal(1)",
    file,
    line,
    span_offset: 0,
    span_length: 0,
    expected: "1",
    received: "2",
  };
}

function result(
  outcome: TrykeTestOutcome,
  expected_assertions: TrykeExpectedAssertion[] = [],
): TrykeTestResult {
  return {
    test: { name: "t", module_path: "tests.x", expected_assertions },
    outcome,
    duration: { secs: 0, nanos: 0 },
  };
}

function sortMarks(marks: AssertionMark[]): AssertionMark[] {
  return [...marks].sort((a, b) => a.line - b.line);
}

suite("computeAssertionMarks", () => {
  test("passed test marks every expected assertion as passed", () => {
    const marks = sortMarks(
      computeAssertionMarks(
        result({ status: "passed" }, [expected(10), expected(11)]),
      ),
    );
    assert.deepStrictEqual(marks, [
      { file: null, line: 10, status: "passed" },
      { file: null, line: 11, status: "passed" },
    ]);
  });

  test("failed test marks failing lines failed and others passed", () => {
    const outcome: TrykeTestOutcome = {
      status: "failed",
      detail: {
        message: "boom",
        assertions: [failedAssertion(11)],
        executed_lines: [10, 11, 12],
      },
    };
    const marks = sortMarks(
      computeAssertionMarks(
        result(outcome, [expected(10), expected(11), expected(12)]),
      ),
    );
    assert.deepStrictEqual(marks, [
      { file: null, line: 10, status: "passed" },
      { file: null, line: 11, status: "failed" },
      { file: null, line: 12, status: "passed" },
    ]);
  });

  test("unexecuted expected assertions get no marker", () => {
    const outcome: TrykeTestOutcome = {
      status: "failed",
      detail: {
        message: "boom",
        assertions: [failedAssertion(10)],
        // Test bailed after line 10; lines 11/12 never ran.
        executed_lines: [10],
      },
    };
    const marks = sortMarks(
      computeAssertionMarks(
        result(outcome, [expected(10), expected(11), expected(12)]),
      ),
    );
    assert.deepStrictEqual(marks, [{ file: null, line: 10, status: "failed" }]);
  });

  test("absent executed_lines assumes expected assertions ran (soft asserts)", () => {
    const outcome: TrykeTestOutcome = {
      status: "failed",
      detail: {
        message: "boom",
        assertions: [failedAssertion(11)],
      },
    };
    const marks = sortMarks(
      computeAssertionMarks(result(outcome, [expected(10), expected(11)])),
    );
    assert.deepStrictEqual(marks, [
      { file: null, line: 10, status: "passed" },
      { file: null, line: 11, status: "failed" },
    ]);
  });

  test("failed status wins when a line is both expected and failed", () => {
    const outcome: TrykeTestOutcome = {
      status: "failed",
      detail: {
        message: "boom",
        assertions: [failedAssertion(10)],
        executed_lines: [10],
      },
    };
    const marks = computeAssertionMarks(result(outcome, [expected(10)]));
    assert.deepStrictEqual(marks, [{ file: null, line: 10, status: "failed" }]);
  });

  test("cross-file failed assertion keeps its own file", () => {
    const outcome: TrykeTestOutcome = {
      status: "failed",
      detail: {
        message: "boom",
        assertions: [failedAssertion(42, "src/other.py")],
      },
    };
    const marks = computeAssertionMarks(result(outcome, []));
    assert.deepStrictEqual(marks, [
      { file: "src/other.py", line: 42, status: "failed" },
    ]);
  });

  test("non pass/fail outcomes produce no markers", () => {
    for (const outcome of [
      { status: "skipped" } as const,
      { status: "error", detail: { message: "e" } } as const,
      { status: "x_passed" } as const,
    ]) {
      assert.deepStrictEqual(
        computeAssertionMarks(result(outcome, [expected(1)])),
        [],
      );
    }
  });
});
