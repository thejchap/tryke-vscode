import * as vscode from "vscode";
import { TrykeTestResult, TrykeDuration } from "./types";

export function durationMs(d: TrykeDuration): number {
  return d.secs * 1000 + d.nanos / 1_000_000;
}

export function reportResult(
  testRun: vscode.TestRun,
  testItem: vscode.TestItem,
  result: TrykeTestResult,
): void {
  const ms = durationMs(result.duration);
  const outcome = result.outcome;

  switch (outcome.status) {
    case "passed":
    case "x_failed":
      testRun.passed(testItem, ms);
      break;

    case "failed": {
      const messages = buildFailureMessages(outcome.detail, testItem);
      testRun.failed(testItem, messages, ms);
      break;
    }

    case "x_passed": {
      const msg = new vscode.TestMessage("Expected to fail but passed");
      testRun.failed(testItem, [msg], ms);
      break;
    }

    case "error": {
      const msg = new vscode.TestMessage(
        outcome.detail.traceback ?? outcome.detail.message,
      );
      testRun.errored(testItem, [msg], ms);
      break;
    }

    case "skipped":
    case "todo":
      testRun.skipped(testItem);
      break;
  }

  // Append stdout/stderr
  if (result.stdout) {
    testRun.appendOutput(
      result.stdout.replace(/\n/g, "\r\n"),
      undefined,
      testItem,
    );
  }
  if (result.stderr) {
    testRun.appendOutput(
      result.stderr.replace(/\n/g, "\r\n"),
      undefined,
      testItem,
    );
  }
}

function buildFailureMessages(
  detail: { message: string; traceback?: string; assertions?: { expression: string; file?: string; line: number; span_offset: number; span_length: number; expected: string; received: string }[] },
  testItem: vscode.TestItem,
): vscode.TestMessage[] {
  const messages: vscode.TestMessage[] = [];

  if (detail.assertions?.length) {
    for (const assertion of detail.assertions) {
      const msg = vscode.TestMessage.diff(
        assertion.expression,
        assertion.received,
        assertion.expected,
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
