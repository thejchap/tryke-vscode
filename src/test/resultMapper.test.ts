import * as assert from "assert";
import * as vscode from "vscode";
import {
  buildFailureMessages,
  durationMs,
  reportResult,
} from "../resultMapper";
import type { TrykeTestResult, TrykeTestOutcome } from "../types";

type FailedDetail = Extract<TrykeTestOutcome, { status: "failed" }>["detail"];

interface PassedCall {
  kind: "passed";
  ms: number | undefined;
}
interface FailedCall {
  kind: "failed";
  messages: vscode.TestMessage[];
  ms: number | undefined;
}
interface ErroredCall {
  kind: "errored";
  messages: vscode.TestMessage[];
  ms: number | undefined;
}
interface SkippedCall {
  kind: "skipped";
}
interface OutputCall {
  kind: "output";
  text: string;
}
type Call = PassedCall | FailedCall | ErroredCall | SkippedCall | OutputCall;

// Hand-rolled stub: vscode.tests.createTestController is heavy and the
// methods we touch are all "fire-and-record" sinks. Capture every call with
// just enough detail to assert on the shape.
function makeStubRun(): { run: vscode.TestRun; calls: Call[] } {
  const calls: Call[] = [];
  const run = {
    enqueued: () => undefined,
    started: () => undefined,
    skipped: () => calls.push({ kind: "skipped" }),
    failed: (
      _item: vscode.TestItem,
      messages: vscode.TestMessage | readonly vscode.TestMessage[],
      ms?: number,
    ) =>
      calls.push({
        kind: "failed",
        messages: Array.isArray(messages)
          ? [...(messages as readonly vscode.TestMessage[])]
          : [messages as vscode.TestMessage],
        ms,
      }),
    errored: (
      _item: vscode.TestItem,
      messages: vscode.TestMessage | readonly vscode.TestMessage[],
      ms?: number,
    ) =>
      calls.push({
        kind: "errored",
        messages: Array.isArray(messages)
          ? [...(messages as readonly vscode.TestMessage[])]
          : [messages as vscode.TestMessage],
        ms,
      }),
    passed: (_item: vscode.TestItem, ms?: number) =>
      calls.push({ kind: "passed", ms }),
    appendOutput: (text: string) => calls.push({ kind: "output", text }),
    end: () => undefined,
    name: undefined,
    isPersisted: false,
    token: { isCancellationRequested: false } as vscode.CancellationToken,
  } as unknown as vscode.TestRun;
  return { run, calls };
}

// vscode.TestMessage.message is `string | MarkdownString`. Coerce to a flat
// string for assertion regexes without tripping no-base-to-string.
function messageText(m: vscode.TestMessage | undefined): string {
  if (!m) {
    return "";
  }
  const msg = m.message;
  if (typeof msg === "string") {
    return msg;
  }
  return msg.value;
}

function makeStubItem(uri?: vscode.Uri): vscode.TestItem {
  return {
    id: "tests/x.py::t",
    label: "t",
    uri,
    children: { size: 0 } as unknown as vscode.TestItemCollection,
  } as unknown as vscode.TestItem;
}

function result(
  outcome: TrykeTestOutcome,
  extras: Partial<TrykeTestResult> = {},
): TrykeTestResult {
  return {
    test: { name: "t", module_path: "tests.x" },
    outcome,
    duration: { secs: 0, nanos: 0 },
    ...extras,
  };
}

suite("durationMs", () => {
  test("converts whole seconds", () => {
    assert.strictEqual(durationMs({ secs: 2, nanos: 0 }), 2000);
  });

  test("converts sub-millisecond nanos", () => {
    assert.strictEqual(durationMs({ secs: 0, nanos: 500_000 }), 0.5);
  });

  test("sums secs and nanos", () => {
    assert.strictEqual(durationMs({ secs: 1, nanos: 250_000_000 }), 1250);
  });

  test("zero duration is zero ms", () => {
    assert.strictEqual(durationMs({ secs: 0, nanos: 0 }), 0);
  });
});

suite("reportResult", () => {
  test("passed fires testRun.passed with duration", () => {
    const { run, calls } = makeStubRun();
    reportResult(run, makeStubItem(), result({ status: "passed" }, { duration: { secs: 0, nanos: 5_000_000 } }));
    assert.deepStrictEqual(calls, [{ kind: "passed", ms: 5 }]);
  });

  test("x_failed (expected failure that did fail) is recorded as passed", () => {
    const { run, calls } = makeStubRun();
    reportResult(run, makeStubItem(), result({ status: "x_failed" }));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]?.kind, "passed");
  });

  test("x_passed (expected failure that passed) is recorded as failed", () => {
    const { run, calls } = makeStubRun();
    reportResult(run, makeStubItem(), result({ status: "x_passed" }));
    assert.strictEqual(calls.length, 1);
    const call = calls[0] as FailedCall;
    assert.strictEqual(call.kind, "failed");
    assert.strictEqual(call.messages.length, 1);
    assert.match(messageText(call.messages[0]), /Expected to fail but passed/);
  });

  test("error fires testRun.errored with the detail message", () => {
    const { run, calls } = makeStubRun();
    reportResult(
      run,
      makeStubItem(),
      result({ status: "error", detail: { message: "import error" } }),
    );
    assert.strictEqual(calls.length, 1);
    const call = calls[0] as ErroredCall;
    assert.strictEqual(call.kind, "errored");
    assert.strictEqual(messageText(call.messages[0]), "import error");
  });

  test("skipped and todo both call testRun.skipped", () => {
    for (const status of ["skipped", "todo"] as const) {
      const { run, calls } = makeStubRun();
      reportResult(run, makeStubItem(), result({ status }));
      assert.deepStrictEqual(calls, [{ kind: "skipped" }]);
    }
  });

  test("failed forwards the failure messages", () => {
    const { run, calls } = makeStubRun();
    reportResult(
      run,
      makeStubItem(),
      result({ status: "failed", detail: { message: "boom" } }),
    );
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]?.kind, "failed");
  });

  test("stdout and stderr are appended with CRLF normalization", () => {
    const { run, calls } = makeStubRun();
    reportResult(
      run,
      makeStubItem(),
      result({ status: "passed" }, { stdout: "a\nb", stderr: "x\ny" }),
    );
    const outputs = calls.filter((c): c is OutputCall => c.kind === "output");
    assert.deepStrictEqual(
      outputs.map((c) => c.text),
      ["a\r\nb", "x\r\ny"],
    );
  });

  test("empty stdout/stderr are not appended", () => {
    const { run, calls } = makeStubRun();
    reportResult(
      run,
      makeStubItem(),
      result({ status: "passed" }, { stdout: "", stderr: "" }),
    );
    assert.strictEqual(calls.filter((c) => c.kind === "output").length, 0);
  });
});

suite("buildFailureMessages", () => {
  test("falls back to detail.message when there are no assertions", () => {
    const detail: FailedDetail = { message: "raw failure" };
    const messages = buildFailureMessages(detail, makeStubItem());
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messageText(messages[0]), "raw failure");
  });

  test("prefers traceback over message when present", () => {
    const detail: FailedDetail = {
      message: "short",
      traceback: "Traceback (most recent call last):\n  File ...",
    };
    const messages = buildFailureMessages(detail, makeStubItem());
    assert.strictEqual(messages.length, 1);
    assert.match(messageText(messages[0]), /Traceback/);
  });

  test("emits one diff message per assertion", () => {
    const detail: FailedDetail = {
      message: "...",
      assertions: [
        {
          expression: "expect(x).to_equal(1)",
          line: 12,
          span_offset: 0,
          span_length: 10,
          expected: "1",
          received: "2",
        },
        {
          expression: "expect(y).to_equal(3)",
          line: 14,
          span_offset: 0,
          span_length: 10,
          expected: "3",
          received: "4",
        },
      ],
    };
    const messages = buildFailureMessages(detail, makeStubItem());
    assert.strictEqual(messages.length, 2);
  });

  test("uses assertion.file location when present", () => {
    const detail: FailedDetail = {
      message: "...",
      assertions: [
        {
          expression: "e",
          file: "/abs/path/to/test.py",
          line: 7,
          span_offset: 0,
          span_length: 1,
          expected: "1",
          received: "2",
        },
      ],
    };
    const messages = buildFailureMessages(detail, makeStubItem());
    const loc = messages[0]?.location;
    assert.ok(loc);
    assert.strictEqual(loc.uri.fsPath, "/abs/path/to/test.py");
    assert.strictEqual(loc.range.start.line, 6);
  });

  test("falls back to testItem.uri when assertion.file is missing", () => {
    const itemUri = vscode.Uri.file("/abs/test.py");
    const detail: FailedDetail = {
      message: "...",
      assertions: [
        {
          expression: "e",
          line: 9,
          span_offset: 0,
          span_length: 1,
          expected: "1",
          received: "2",
        },
      ],
    };
    const messages = buildFailureMessages(detail, makeStubItem(itemUri));
    const loc = messages[0]?.location;
    assert.ok(loc);
    assert.strictEqual(loc.uri.fsPath, itemUri.fsPath);
    assert.strictEqual(loc.range.start.line, 8);
  });

  test("emits no location when neither assertion.file nor testItem.uri is set", () => {
    const detail: FailedDetail = {
      message: "...",
      assertions: [
        {
          expression: "e",
          line: 1,
          span_offset: 0,
          span_length: 1,
          expected: "1",
          received: "2",
        },
      ],
    };
    const messages = buildFailureMessages(detail, makeStubItem());
    assert.strictEqual(messages[0]?.location, undefined);
  });
});
