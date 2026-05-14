import * as assert from "assert";
import { coerceDistOrNull, coerceEnum } from "../config";

const MODES = ["direct", "server", "auto"] as const;
const CHANGED = ["off", "only", "first"] as const;

suite("coerceEnum", () => {
  test("returns the value when it's a member of the allowed set", () => {
    assert.strictEqual(coerceEnum("server", MODES, "auto", "mode"), "server");
    assert.strictEqual(coerceEnum("only", CHANGED, "off", "changed"), "only");
  });

  test("falls back when the value is a string but not allowed", () => {
    assert.strictEqual(coerceEnum("nonsense", MODES, "auto", "mode"), "auto");
  });

  test("falls back on undefined", () => {
    assert.strictEqual(coerceEnum(undefined, MODES, "auto", "mode"), "auto");
  });

  test("falls back on null", () => {
    assert.strictEqual(coerceEnum(null, MODES, "auto", "mode"), "auto");
  });

  test("falls back on non-string types", () => {
    assert.strictEqual(coerceEnum(42, MODES, "auto", "mode"), "auto");
    assert.strictEqual(coerceEnum(true, MODES, "auto", "mode"), "auto");
    assert.strictEqual(coerceEnum({ x: 1 }, MODES, "auto", "mode"), "auto");
  });

  test("is case-sensitive (matches the enum's package.json declaration)", () => {
    assert.strictEqual(coerceEnum("AUTO", MODES, "direct", "mode"), "direct");
  });
});

suite("coerceDistOrNull", () => {
  test("null and undefined map to null", () => {
    assert.strictEqual(coerceDistOrNull(null), null);
    assert.strictEqual(coerceDistOrNull(undefined), null);
  });

  test("valid enum values pass through", () => {
    assert.strictEqual(coerceDistOrNull("test"), "test");
    assert.strictEqual(coerceDistOrNull("file"), "file");
    assert.strictEqual(coerceDistOrNull("group"), "group");
  });

  test("garbage falls back to null rather than crashing the runner", () => {
    assert.strictEqual(coerceDistOrNull("nonsense"), null);
    assert.strictEqual(coerceDistOrNull(42), null);
    assert.strictEqual(coerceDistOrNull({}), null);
  });
});
