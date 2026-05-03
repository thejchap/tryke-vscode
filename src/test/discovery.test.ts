import * as assert from "assert";
import { buildTestLabel } from "../discovery";

suite("buildTestLabel", () => {
  test("uses the bare function name when no display_name or case_label", () => {
    assert.strictEqual(buildTestLabel({ name: "test_basic" }), "test_basic");
  });

  test("uses display_name in place of name when present", () => {
    assert.strictEqual(
      buildTestLabel({ name: "test_basic", display_name: "addition works" }),
      "addition works",
    );
  });

  test("suffixes case_label onto the bare name", () => {
    assert.strictEqual(
      buildTestLabel({ name: "square", case_label: "zero" }),
      "square[zero]",
    );
  });

  // Regression: the old `display_name ?? leafName` swallowed the case
  // label whenever `display_name` was set, collapsing every case for a
  // labelled `@test("basic").cases(...)` function onto the same row.
  test("composes display_name AND case_label", () => {
    assert.strictEqual(
      buildTestLabel({
        name: "labelled_addition",
        display_name: "basic",
        case_label: "1 + 1",
      }),
      "basic[1 + 1]",
    );
  });
});
