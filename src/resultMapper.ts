import * as vscode from "vscode";
import { TrykeTestResult, TrykeTestOutcome, TrykeDuration } from "./types";

type FailedDetail = Extract<TrykeTestOutcome, { status: "failed" }>["detail"];

export function durationMs(d: TrykeDuration): number {
  return d.secs * 1000 + d.nanos / 1_000_000;
}

// One-word banner per outcome for the run-level digest. VS Code's Test
// Results panel displays "did not record any output" when the run's output
// stream stays empty, so we emit at minimum a `STATUS testId (Nms)` line
// per result. Per-test stdout/stderr is still routed to the test-scoped
// stream so the per-test view picks it up too.
const STATUS_BANNER: Record<TrykeTestOutcome["status"], string> = {
  passed: "PASS",
  failed: "FAIL",
  skipped: "SKIP",
  error: "ERROR",
  x_failed: "XFAIL",
  x_passed: "XPASS",
  todo: "TODO",
};

export function reportResult(
  testRun: vscode.TestRun,
  testItem: vscode.TestItem,
  result: TrykeTestResult,
): void {
  const ms = durationMs(result.duration);
  const outcome = result.outcome;
  let runLevelError: string | undefined;

  switch (outcome.status) {
    case "passed":
    case "x_failed":
      testRun.passed(testItem, ms);
      break;

    case "failed": {
      const messages = buildFailureMessages(outcome.detail, testItem);
      testRun.failed(testItem, messages, ms);
      runLevelError = outcome.detail.traceback ?? outcome.detail.message;
      break;
    }

    case "x_passed": {
      const msg = new vscode.TestMessage("Expected to fail but passed");
      testRun.failed(testItem, [msg], ms);
      runLevelError = "Expected to fail but passed";
      break;
    }

    case "error": {
      const msg = new vscode.TestMessage(outcome.detail.message);
      testRun.errored(testItem, [msg], ms);
      runLevelError = outcome.detail.message;
      break;
    }

    case "skipped":
    case "todo":
      testRun.skipped(testItem);
      break;
  }

  // Run-level digest line: `PASS <id> (Nms)` etc. Without this the Test
  // Results panel shows "did not record any output" for any run whose
  // tests have no stdout/stderr — which is most runs.
  const banner = STATUS_BANNER[outcome.status];
  testRun.appendOutput(`${banner} ${testItem.id} (${ms.toFixed(1)}ms)\r\n`);
  if (runLevelError !== undefined && runLevelError !== "") {
    // Indent multi-line error bodies so the banner line above is still
    // visually distinct in the output panel.
    const indented = runLevelError.replace(/\r?\n/g, "\r\n  ");
    testRun.appendOutput(`  ${indented}\r\n`);
  }

  // Per-test stdout/stderr is routed to the test-scoped stream so VS Code
  // can show it under that specific test's view.
  if (result.stdout != null && result.stdout !== "") {
    testRun.appendOutput(
      result.stdout.replace(/\n/g, "\r\n"),
      undefined,
      testItem,
    );
  }
  if (result.stderr != null && result.stderr !== "") {
    testRun.appendOutput(
      result.stderr.replace(/\n/g, "\r\n"),
      undefined,
      testItem,
    );
  }
}

export function buildFailureMessages(
  detail: FailedDetail,
  testItem: vscode.TestItem,
): vscode.TestMessage[] {
  const messages: vscode.TestMessage[] = [];

  if (detail.assertions?.length) {
    for (const assertion of detail.assertions) {
      const msg = vscode.TestMessage.diff(
        assertion.expression,
        assertion.expected,
        assertion.received,
      );
      if (assertion.file) {
        msg.location = new vscode.Location(
          vscode.Uri.file(assertion.file),
          new vscode.Position(assertion.line - 1, 0),
        );
      } else if (testItem.uri) {
        msg.location = new vscode.Location(
          testItem.uri,
          new vscode.Position(assertion.line - 1, 0),
        );
      }
      messages.push(msg);
    }
  } else {
    const msg = new vscode.TestMessage(
      detail.traceback ?? detail.message,
    );
    messages.push(msg);
  }

  return messages;
}
