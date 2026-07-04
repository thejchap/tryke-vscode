// Per-assertion gutter status.
//
// VS Code's Testing API renders exactly one status icon per TestItem — at the
// test function's line. tryke reports each `expect(...)` inside a test
// individually (soft assertions: a test keeps running past a failed expect and
// collects every failure), so a single failing test can carry a mix of passed
// and failed assertions. This module paints a pass/fail icon in the editor
// gutter next to each individual assertion line, using text-editor decorations
// (the one channel that lets us place a gutter icon on an arbitrary line).
//
// The status of an assertion is derived from a test result:
//   - passed test          → every `expected_assertions` line passed
//   - failed test          → `detail.assertions` lines failed; the remaining
//                            `expected_assertions` lines passed if they were
//                            executed (`detail.executed_lines`), otherwise they
//                            were never reached and get no marker
//   - other outcomes        → no per-assertion markers

import * as vscode from "vscode";
import * as path from "path";
import { TrykeTestResult } from "./types";

export type AssertionStatus = "passed" | "failed";

// A computed marker before URI resolution. `file` is the raw path string tryke
// attached to a failed assertion (relative to the worker cwd), or `null` when
// the marker belongs to the test's own file — in which case the caller resolves
// it against the TestItem's URI. `line` is 1-based, matching the wire format.
export interface AssertionMark {
  file: string | null;
  line: number;
  status: AssertionStatus;
}

// Pure derivation of per-assertion markers from a single test result. Kept free
// of vscode APIs so it can be unit-tested directly. Dedupes by file+line; a
// failed status always wins over a passed one at the same location.
export function computeAssertionMarks(result: TrykeTestResult): AssertionMark[] {
  const outcome = result.outcome;
  const marks = new Map<string, AssertionMark>();

  const put = (file: string | null, line: number, status: AssertionStatus) => {
    const key = `${file ?? ""}:${line}`;
    const existing = marks.get(key);
    if (existing?.status === "failed") {
      return; // failed wins — never downgrade to passed
    }
    if (status === "failed" || existing === undefined) {
      marks.set(key, { file, line, status });
    }
  };

  if (outcome.status === "passed") {
    for (const a of result.test.expected_assertions ?? []) {
      put(null, a.line, "passed");
    }
    return [...marks.values()];
  }

  if (outcome.status === "failed") {
    const detail = outcome.detail;
    // Lines that failed, tracked separately for the test's own file so we don't
    // re-mark an expected assertion that already failed as "passed".
    const failedOwnFileLines = new Set<number>();
    for (const a of detail.assertions ?? []) {
      put(a.file ?? null, a.line, "failed");
      if (a.file == null) {
        failedOwnFileLines.add(a.line);
      }
    }

    // executed_lines, when present, tells us which expects actually ran. A
    // failed test may have bailed (a raised exception, fail-fast) before
    // reaching later expects — those get no marker rather than a false pass.
    const executed =
      detail.executed_lines != null ? new Set(detail.executed_lines) : undefined;

    for (const a of result.test.expected_assertions ?? []) {
      if (failedOwnFileLines.has(a.line)) {
        continue;
      }
      if (executed !== undefined && !executed.has(a.line)) {
        continue;
      }
      put(null, a.line, "passed");
    }
    return [...marks.values()];
  }

  // passed-with-caveats and non-pass/fail outcomes (skipped, error, x_failed,
  // x_passed, todo) carry no meaningful per-assertion signal.
  return [];
}

// A resolved marker: a concrete editor location plus its status.
interface ResolvedMark {
  uriKey: string;
  line: number; // 0-based
  status: AssertionStatus;
}

function gutterIcon(svg: string): vscode.Uri {
  return vscode.Uri.parse(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  );
}

// Colors track VS Code's built-in testing icons (testing.iconPassed /
// testing.iconFailed) closely enough to read as "the same" status, and are
// legible on both light and dark backgrounds.
const PASS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill="none" stroke="#3fb950" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 8.5 6.5 12 13 4.5"/></svg>`;
const FAIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.25" fill="none" stroke="#f14c4c" stroke-width="1.5"/><path stroke="#f14c4c" stroke-width="1.75" stroke-linecap="round" d="M5.5 5.5 10.5 10.5M10.5 5.5 5.5 10.5"/></svg>`;

// Renders per-assertion gutter markers as text-editor decorations, keeping one
// entry per TestItem so re-running a single test only rewrites that test's
// markers and leaves its siblings in the same file untouched.
export class AssertionGutter implements vscode.Disposable {
  private readonly passType: vscode.TextEditorDecorationType;
  private readonly failType: vscode.TextEditorDecorationType;
  private readonly byTest = new Map<string, ResolvedMark[]>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.passType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: gutterIcon(PASS_SVG),
      gutterIconSize: "contain",
    });
    this.failType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: gutterIcon(FAIL_SVG),
      gutterIconSize: "contain",
    });
    this.disposables.push(
      this.passType,
      this.failType,
      // Editors opened after a run must pick up existing markers.
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          this.applyToEditor(editor);
        }
      }),
    );
  }

  // Replace the markers for one test with the ones derived from its result.
  record(
    testItem: vscode.TestItem,
    result: TrykeTestResult,
    workspaceRoot: string,
  ): void {
    // Dedupe by resolved (uri, line): a failed assertion and a passed expected
    // assertion can land on the same editor line under different raw file
    // strings (tryke stamps failed assertions with a relative path but leaves
    // the test's own expects fileless). Resolve first, then let failed win, so
    // a line never carries both a pass and a fail icon.
    const byLocation = new Map<string, ResolvedMark>();
    for (const mark of computeAssertionMarks(result)) {
      const uri = this.resolveUri(mark.file, testItem, workspaceRoot);
      if (!uri) {
        continue;
      }
      const line = Math.max(0, mark.line - 1);
      const uriKey = uri.toString();
      const key = `${uriKey}:${line}`;
      const existing = byLocation.get(key);
      if (existing?.status === "failed") {
        continue;
      }
      if (mark.status === "failed" || existing === undefined) {
        byLocation.set(key, { uriKey, line, status: mark.status });
      }
    }
    this.replaceTest(testItem.id, [...byLocation.values()]);
  }

  // Drop a test's markers — called when it is re-enqueued so stale icons clear
  // immediately rather than lingering until the new result lands.
  clearTest(testItem: vscode.TestItem): void {
    this.replaceTest(testItem.id, []);
  }

  // Wipe every marker (e.g. on controller disposal or a full reset).
  clearAll(): void {
    this.byTest.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.passType, []);
      editor.setDecorations(this.failType, []);
    }
  }

  private replaceTest(testId: string, marks: ResolvedMark[]): void {
    const affected = new Set<string>();
    for (const m of this.byTest.get(testId) ?? []) {
      affected.add(m.uriKey);
    }
    if (marks.length > 0) {
      this.byTest.set(testId, marks);
    } else {
      this.byTest.delete(testId);
    }
    for (const m of marks) {
      affected.add(m.uriKey);
    }
    for (const editor of vscode.window.visibleTextEditors) {
      if (affected.has(editor.document.uri.toString())) {
        this.applyToEditor(editor);
      }
    }
  }

  private applyToEditor(editor: vscode.TextEditor): void {
    const uriKey = editor.document.uri.toString();
    const passRanges: vscode.Range[] = [];
    const failRanges: vscode.Range[] = [];
    for (const marks of this.byTest.values()) {
      for (const m of marks) {
        if (m.uriKey !== uriKey) {
          continue;
        }
        const range = new vscode.Range(m.line, 0, m.line, 0);
        (m.status === "failed" ? failRanges : passRanges).push(range);
      }
    }
    editor.setDecorations(this.passType, passRanges);
    editor.setDecorations(this.failType, failRanges);
  }

  private resolveUri(
    file: string | null,
    testItem: vscode.TestItem,
    workspaceRoot: string,
  ): vscode.Uri | undefined {
    if (file != null && file !== "") {
      const abs = path.isAbsolute(file) ? file : path.join(workspaceRoot, file);
      return vscode.Uri.file(abs);
    }
    return testItem.uri;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.byTest.clear();
  }
}

// Lazily-created singleton. The decoration types are only built the first time
// a run reports a result, so importing this module (e.g. from unit tests that
// don't touch the gutter) has no side effects.
let instance: AssertionGutter | undefined;

export function assertionGutter(): AssertionGutter {
  return (instance ??= new AssertionGutter());
}

export function disposeAssertionGutter(): void {
  instance?.dispose();
  instance = undefined;
}
