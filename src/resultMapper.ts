import * as path from "path";
import * as vscode from "vscode";
import { TrykeTestResult, TrykeTestOutcome, TrykeDuration } from "./types";
import {
  ParsedDoctestBlock,
  looksLikeDoctestOutput,
  parseDoctestOutput,
} from "./doctest";

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
  workspaceRoot: string,
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
      const messages = buildFailureMessages(outcome.detail, testItem, workspaceRoot);
      testRun.failed(testItem, messages, ms);
      runLevelError = summarizeFailedForDigest(outcome.detail);
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
  workspaceRoot: string,
): vscode.TestMessage[] {
  const messages: vscode.TestMessage[] = [];

  if (detail.assertions?.length) {
    for (const assertion of detail.assertions) {
      const msg = vscode.TestMessage.diff(
        assertion.expression,
        assertion.expected,
        assertion.received,
      );
      const uri = resolveAssertionUri(assertion.file, testItem, workspaceRoot);
      if (uri) {
        msg.location = new vscode.Location(
          uri,
          new vscode.Position(Math.max(0, assertion.line - 1), 0),
        );
      }
      messages.push(msg);
    }
  } else if (looksLikeDoctestOutput(detail.message)) {
    // Python doctest output. tryke ships it as the raw multi-block text
    // (asterisk separator, File "..." header, Failed example:, etc.) with
    // no structured assertions[]. Parse it so the inline marker lands on
    // the real failing line and Python's `doctest.py` internal traceback
    // frames don't leak into the editor decoration.
    const blocks = parseDoctestOutput(detail.message);
    if (blocks.length > 0) {
      for (const block of blocks) {
        messages.push(buildDoctestMessage(block, testItem, workspaceRoot));
      }
    } else {
      messages.push(buildFallbackMessage(detail, testItem));
    }
  } else {
    // Fallback when tryke didn't emit a structured assertion (e.g. an
    // unstructured `assert` or a non-expect failure). Anchor to the test
    // item itself so the message still renders inline in the editor — a
    // location-less TestMessage only appears in the bottom panel.
    messages.push(buildFallbackMessage(detail, testItem));
  }

  return messages;
}

// Format a `failed` detail for the run-level digest line. For doctest
// output the raw `detail.message` is a multi-block dump with asterisk
// separators and Python's internal `doctest.py` traceback frames; that
// landed in the Test Results panel as a wall of text. Parse it down to
// one `file:line  example → cause` line per failing example.
function summarizeFailedForDigest(detail: FailedDetail): string {
  if (looksLikeDoctestOutput(detail.message)) {
    const blocks = parseDoctestOutput(detail.message);
    if (blocks.length > 0) {
      return blocks.map(summarizeDoctestBlock).join("\n");
    }
  }
  return detail.traceback ?? detail.message;
}

function summarizeDoctestBlock(block: ParsedDoctestBlock): string {
  const where = `${block.file}:${block.line}`;
  const example = block.failedExample.split(/\r?\n/)[0] ?? block.failedExample;
  if (block.exceptionSummary !== undefined && block.exceptionSummary !== "") {
    return `${where}  ${example}\n  raised: ${block.exceptionSummary}`;
  }
  if (block.expected !== undefined && block.got !== undefined) {
    return `${where}  ${example}\n  expected: ${oneLine(block.expected)}\n  got: ${oneLine(block.got)}`;
  }
  return `${where}  ${example}`;
}

function oneLine(text: string): string {
  return text.split(/\r?\n/).join(" ⏎ ");
}

function buildFallbackMessage(
  detail: FailedDetail,
  testItem: vscode.TestItem,
): vscode.TestMessage {
  const text = detail.traceback ?? detail.message;
  const msg = new vscode.TestMessage(text);
  if (testItem.uri && testItem.range) {
    msg.location = new vscode.Location(testItem.uri, testItem.range);
  } else if (testItem.uri) {
    msg.location = new vscode.Location(testItem.uri, new vscode.Position(0, 0));
  }
  return msg;
}

function buildDoctestMessage(
  block: ParsedDoctestBlock,
  testItem: vscode.TestItem,
  workspaceRoot: string,
): vscode.TestMessage {
  let msg: vscode.TestMessage;
  if (block.expected !== undefined && block.got !== undefined) {
    // doctest's Expected/Got is a direct comparison — TestMessage.diff()
    // gets us the structured diff view in the panel "for free".
    msg = vscode.TestMessage.diff(block.failedExample, block.expected, block.got);
  } else {
    const body = new vscode.MarkdownString();
    body.appendMarkdown("**Failed example:**\n\n");
    body.appendCodeblock(block.failedExample, "python");
    if (block.exceptionSummary !== undefined && block.exceptionSummary !== "") {
      body.appendMarkdown("\n**Raised:**\n\n");
      body.appendCodeblock(block.exceptionSummary, "text");
    }
    msg = new vscode.TestMessage(body);
  }

  const uri = resolveAssertionUri(block.file, testItem, workspaceRoot);
  if (uri) {
    msg.location = new vscode.Location(
      uri,
      new vscode.Position(Math.max(0, block.line - 1), 0),
    );
  }
  return msg;
}

// tryke serializes assertion.file as a path that's been made relative to
// the worker's cwd (see tryke_runner::worker::convert_assertion). The
// extension then receives e.g. `"src/flowby/channels.py"`, and
// `vscode.Uri.file("src/flowby/channels.py")` produces
// `file:///src/flowby/channels.py` — a path that doesn't exist on disk.
// VS Code can't render an inline TestMessage at a non-existent location,
// so the diff only appears in the bottom panel. Resolve relative paths
// against the workspace root before constructing the URI; fall back to
// the testItem's own URI if the field is absent.
function resolveAssertionUri(
  file: string | null | undefined,
  testItem: vscode.TestItem,
  workspaceRoot: string,
): vscode.Uri | undefined {
  if (file != null && file !== "") {
    const abs = path.isAbsolute(file) ? file : path.join(workspaceRoot, file);
    return vscode.Uri.file(abs);
  }
  return testItem.uri;
}
