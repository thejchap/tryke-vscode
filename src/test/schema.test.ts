import * as assert from "assert";
import {
  JsonRpcMessageSchema,
  RunCompleteParamsSchema,
  RunStartParamsSchema,
  TestCompleteParamsSchema,
  TrykeEventSchema,
} from "../schema";

// A small captured ndjson stream. These shapes mirror what tryke's JSON
// reporter actually emits; if a future tryke release shifts the wire format,
// at least one of these round-trips will fail and surface the drift here
// rather than as a silent runtime cast.
const SAMPLE_EVENTS = [
  { event: "run_start", tests: [{ name: "test_x", module_path: "tests.x" }] },
  {
    event: "test_complete",
    result: {
      test: { name: "test_x", module_path: "tests.x" },
      outcome: { status: "passed" },
      duration: { secs: 0, nanos: 1_000_000 },
    },
  },
  {
    event: "test_complete",
    result: {
      test: { name: "test_y", module_path: "tests.x", case_label: "zero" },
      outcome: {
        status: "failed",
        detail: { message: "boom", traceback: "..." },
      },
      duration: { secs: 0, nanos: 0 },
    },
  },
  {
    event: "run_complete",
    summary: {
      passed: 1,
      failed: 1,
      skipped: 0,
      errors: 0,
      xfailed: 0,
      todo: 0,
      duration: { secs: 1, nanos: 0 },
      file_count: 1,
    },
  },
  {
    event: "discovery_warning",
    warning: { file_path: "tests/x.py", kind: "dynamic_imports", message: "..." },
  },
] as const;

suite("TrykeEventSchema", () => {
  test("round-trips every event in the captured ndjson sample", () => {
    for (const evt of SAMPLE_EVENTS) {
      const parsed = TrykeEventSchema.safeParse(evt);
      assert.ok(parsed.success, `failed to parse ${evt.event}: ${(!parsed.success && parsed.error.message) || ""}`);
    }
  });

  test("rejects an unknown `event` discriminator", () => {
    const parsed = TrykeEventSchema.safeParse({ event: "made_up", foo: 1 });
    assert.strictEqual(parsed.success, false);
  });

  test("rejects test_complete missing required `result.outcome.status`", () => {
    const parsed = TrykeEventSchema.safeParse({
      event: "test_complete",
      result: {
        test: { name: "x", module_path: "x" },
        outcome: {} as unknown,
        duration: { secs: 0, nanos: 0 },
      },
    });
    assert.strictEqual(parsed.success, false);
  });

  test("rejects a failed outcome missing `detail.message`", () => {
    const parsed = TrykeEventSchema.safeParse({
      event: "test_complete",
      result: {
        test: { name: "x", module_path: "x" },
        outcome: { status: "failed", detail: {} as unknown },
        duration: { secs: 0, nanos: 0 },
      },
    });
    assert.strictEqual(parsed.success, false);
  });
});

suite("JsonRpcMessageSchema", () => {
  test("accepts a response shape with id and result", () => {
    const parsed = JsonRpcMessageSchema.safeParse({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
    assert.strictEqual(parsed.success, true);
  });

  test("accepts a response shape with id and error", () => {
    const parsed = JsonRpcMessageSchema.safeParse({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "bad request" },
    });
    assert.strictEqual(parsed.success, true);
  });

  test("accepts a notification shape with method + params", () => {
    const parsed = JsonRpcMessageSchema.safeParse({
      jsonrpc: "2.0",
      method: "test_complete",
      params: { run_id: "x" },
    });
    assert.strictEqual(parsed.success, true);
  });

  test("rejects a missing jsonrpc version field", () => {
    const parsed = JsonRpcMessageSchema.safeParse({ id: 1, result: 1 });
    assert.strictEqual(parsed.success, false);
  });

  test("rejects a malformed envelope (no id, no method)", () => {
    const parsed = JsonRpcMessageSchema.safeParse({
      jsonrpc: "2.0",
      foo: "bar",
    });
    assert.strictEqual(parsed.success, false);
  });
});

suite("server notification param schemas", () => {
  test("RunStartParams requires run_id and tests array", () => {
    const ok = RunStartParamsSchema.safeParse({
      run_id: "run-1",
      tests: [{ name: "t", module_path: "x" }],
    });
    assert.strictEqual(ok.success, true);

    const noRunId = RunStartParamsSchema.safeParse({
      tests: [{ name: "t", module_path: "x" }],
    });
    assert.strictEqual(noRunId.success, false);
  });

  test("TestCompleteParams requires run_id and a full result", () => {
    const ok = TestCompleteParamsSchema.safeParse({
      run_id: "run-1",
      result: {
        test: { name: "t", module_path: "x" },
        outcome: { status: "passed" },
        duration: { secs: 0, nanos: 0 },
      },
    });
    assert.strictEqual(ok.success, true);
  });

  test("RunCompleteParams accepts an empty object (run_id is optional)", () => {
    const ok = RunCompleteParamsSchema.safeParse({});
    assert.strictEqual(ok.success, true);
  });

  test("RunCompleteParams accepts run_id when present", () => {
    const ok = RunCompleteParamsSchema.safeParse({ run_id: "run-1" });
    assert.strictEqual(ok.success, true);
    if (ok.success) {
      assert.strictEqual(ok.data.run_id, "run-1");
    }
  });
});
