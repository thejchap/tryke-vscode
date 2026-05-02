import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findCaseLine, findDescribeLine, clearSourceCache } from "../sourceScan";

function tmpFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tryke-vscode-srcscan-"));
  const file = path.join(dir, "sample.py");
  fs.writeFileSync(file, content);
  return file;
}

suite("findCaseLine", () => {
  test("locates a typed `t.test.case(\"label\", ...)` declaration", () => {
    const file = tmpFile(
      [
        "with t.describe('Math'):",
        "    @t.test.cases(",
        "        t.test.case('zero', n=0, want=0),",
        "        t.test.case('one', n=1, want=1),",
        "    )",
        "    def square(n: int, want: int) -> None: ...",
      ].join("\n"),
    );
    clearSourceCache();
    // startLine = decorated function line (6, 1-based)
    assert.strictEqual(findCaseLine(file, "zero", 6), 3);
    assert.strictEqual(findCaseLine(file, "one", 6), 4);
  });

  test("locates a tuple-list case `('label', {...})`", () => {
    const file = tmpFile(
      [
        "@t.test.cases([",
        "    ('zero', {'n': 0}),",
        "    ('one', {'n': 1}),",
        "])",
        "def square(n): ...",
      ].join("\n"),
    );
    clearSourceCache();
    assert.strictEqual(findCaseLine(file, "zero", 5), 2);
    assert.strictEqual(findCaseLine(file, "one", 5), 3);
  });

  test("locates a kwargs case `label={...}`", () => {
    const file = tmpFile(
      [
        "@t.test.cases(",
        "    zero={'n': 0},",
        "    one={'n': 1},",
        ")",
        "def square(n): ...",
      ].join("\n"),
    );
    clearSourceCache();
    assert.strictEqual(findCaseLine(file, "zero", 5), 2);
    assert.strictEqual(findCaseLine(file, "one", 5), 3);
  });

  test("falls back to startLine when no match is found", () => {
    const file = tmpFile("def square(): ...\n");
    clearSourceCache();
    assert.strictEqual(findCaseLine(file, "missing", 1), 1);
  });

  test("treats label as a literal even when it has regex metachars", () => {
    const file = tmpFile(
      [
        "@t.test.cases(",
        "    t.test.case('1 + 2', a=1, b=2),",
        ")",
        "def add(a, b): ...",
      ].join("\n"),
    );
    clearSourceCache();
    assert.strictEqual(findCaseLine(file, "1 + 2", 4), 2);
  });
});

suite("findDescribeLine", () => {
  test("locates a positional `with t.describe(\"name\"):`", () => {
    const file = tmpFile(
      [
        "import tryke as t",
        "",
        "with t.describe('Channel'):",
        "    @t.test",
        "    def basic(): ...",
      ].join("\n"),
    );
    clearSourceCache();
    assert.strictEqual(findDescribeLine(file, "Channel", 5), 3);
  });

  test("locates a kwarg `with t.describe(name=\"name\"):`", () => {
    const file = tmpFile(
      [
        "with t.describe(name='Channel'):",
        "    @t.test",
        "    def basic(): ...",
      ].join("\n"),
    );
    clearSourceCache();
    assert.strictEqual(findDescribeLine(file, "Channel", 3), 1);
  });

  test("picks the closest preceding describe when there are multiple", () => {
    const file = tmpFile(
      [
        "with t.describe('A'):",      // 1
        "    @t.test",                  // 2
        "    def a(): ...",             // 3
        "",                              // 4
        "with t.describe('B'):",      // 5
        "    @t.test",                  // 6
        "    def b(): ...",             // 7
      ].join("\n"),
    );
    clearSourceCache();
    // anchorLine = function under B (7). Closest preceding describe is line 5.
    assert.strictEqual(findDescribeLine(file, "B", 7), 5);
    // anchorLine = function under A (3). Closest preceding describe is line 1.
    assert.strictEqual(findDescribeLine(file, "A", 3), 1);
  });

  test("returns undefined when no describe matches", () => {
    const file = tmpFile("with t.describe('Other'): pass\n");
    clearSourceCache();
    assert.strictEqual(findDescribeLine(file, "Channel", 1), undefined);
  });
});
