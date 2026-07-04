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

// The exact codicon glyphs VS Code's Testing API renders for test status —
// `pass` (check-in-circle) and `error` (filled circle with an ✕) — so the
// per-assertion markers read as the same icons, just at assertion granularity.
// Colored with VS Code's own testing.iconPassed / testing.iconFailed values
// (#73c991 / #f14c4c), which its defaults use for both light and dark themes.
const PASS_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="#73c991"><path d="M10.6484 5.64648C10.8434 5.45148 11.1605 5.45148 11.3555 5.64648C11.5498 5.84137 11.5499 6.15766 11.3555 6.35254L7.35547 10.3525C7.25747 10.4495 7.12898 10.499 7.00098 10.499C6.87299 10.499 6.74545 10.4505 6.64746 10.3525L4.64746 8.35254C4.45247 8.15754 4.45248 7.84148 4.64746 7.64648C4.84246 7.45148 5.15949 7.45148 5.35449 7.64648L7 9.29199L10.6465 5.64648H10.6484Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M8 1C11.86 1 15 4.14 15 8C15 11.86 11.86 15 8 15C4.14 15 1 11.86 1 8C1 4.14 4.14 1 8 1ZM8 2C4.691 2 2 4.691 2 8C2 11.309 4.691 14 8 14C11.309 14 14 11.309 14 8C14 4.691 11.309 2 8 2Z"/></svg>`;
const FAIL_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="#f14c4c"><path d="M8 1C4.14 1 1 4.14 1 8C1 11.86 4.14 15 8 15C11.86 15 15 11.86 15 8C15 4.14 11.86 1 8 1ZM8 14C4.691 14 2 11.309 2 8C2 4.691 4.691 2 8 2C11.309 2 14 4.691 14 8C14 11.309 11.309 14 8 14ZM10.854 5.854L8.708 8L10.854 10.146C11.049 10.341 11.049 10.658 10.854 10.853C10.756 10.951 10.628 10.999 10.5 10.999C10.372 10.999 10.244 10.95 10.146 10.853L8 8.707L5.854 10.853C5.756 10.951 5.628 10.999 5.5 10.999C5.372 10.999 5.244 10.95 5.146 10.853C4.951 10.658 4.951 10.341 5.146 10.146L7.292 8L5.146 5.854C4.951 5.659 4.951 5.342 5.146 5.147C5.341 4.952 5.658 4.952 5.853 5.147L7.999 7.293L10.145 5.147C10.34 4.952 10.657 4.952 10.852 5.147C11.047 5.342 11.047 5.659 10.852 5.854H10.854Z"/></svg>`;

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
      gutterIconSize: "auto",
    });
    this.failType = vscode.window.createTextEditorDecorationType({
      gutterIconPath: gutterIcon(FAIL_SVG),
      gutterIconSize: "auto",
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
    const lineCount = editor.document.lineCount;
    const passRanges: vscode.Range[] = [];
    const failRanges: vscode.Range[] = [];
    for (const marks of this.byTest.values()) {
      for (const m of marks) {
        if (m.uriKey !== uriKey) {
          continue;
        }
        // The document can have shrunk since the run (the user edited the
        // file, or tryke reported a stale line). Skip markers past the end
        // rather than decorate an out-of-bounds line.
        if (m.line >= lineCount) {
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
