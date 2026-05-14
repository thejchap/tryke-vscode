import * as assert from "assert";
import {
  ParsedDoctestBlock,
  looksLikeDoctestOutput,
  parseDoctestOutput,
} from "../doctest";

// Captured from Python 3.13's `doctest.DocTestRunner` directly. The format
// is stable across stdlib versions, but anchoring tests on the exact bytes
// emitted by the runtime is the only way to catch a future Python release
// quietly renaming a label or shifting indentation.
const EXPECTED_GOT_BLOCK = [
  "**********************************************************************",
  'File "/tmp/dt_sample.py", line 3, in fn',
  "Failed example:",
  "    fn() + 0",
  "Expected:",
  "    1",
  "Got:",
  "    2",
  "",
].join("\n");

const EXCEPTION_BLOCK = [
  "**********************************************************************",
  'File "/tmp/dt_sample.py", line 6, in fn',
  "Failed example:",
  '    raise ValueError("boom")',
  "Exception raised:",
  "    Traceback (most recent call last):",
  '      File "/Users/x/.pyenv/versions/3.12.8/lib/python3.12/doctest.py", line 1368, in __run',
  '        exec(compile(example.source, filename, "single",',
  '      File "<doctest fn[1]>", line 1, in <module>',
  '        raise ValueError("boom")',
  "    ValueError: boom",
  "",
].join("\n");

const COMBINED = EXPECTED_GOT_BLOCK + EXCEPTION_BLOCK;

suite("looksLikeDoctestOutput", () => {
  test("recognises a single-block expected/got failure", () => {
    assert.strictEqual(looksLikeDoctestOutput(EXPECTED_GOT_BLOCK), true);
  });

  test("recognises the exception-raised variant", () => {
    assert.strictEqual(looksLikeDoctestOutput(EXCEPTION_BLOCK), true);
  });

  test("rejects an unrelated traceback that has no asterisk header", () => {
    const traceback = [
      "Traceback (most recent call last):",
      '  File "x.py", line 1, in <module>',
      "    raise ValueError",
      "ValueError",
    ].join("\n");
    assert.strictEqual(looksLikeDoctestOutput(traceback), false);
  });

  test("rejects plain message text", () => {
    assert.strictEqual(looksLikeDoctestOutput("expected 1, got 2"), false);
  });
});

suite("parseDoctestOutput — expected/got", () => {
  const blocks = parseDoctestOutput(EXPECTED_GOT_BLOCK);

  test("yields exactly one block", () => {
    assert.strictEqual(blocks.length, 1);
  });

  test("extracts the file path verbatim", () => {
    assert.strictEqual(blocks[0]!.file, "/tmp/dt_sample.py");
  });

  test("extracts the 1-indexed line number from the header", () => {
    assert.strictEqual(blocks[0]!.line, 3);
  });

  test("dedents the failed example", () => {
    assert.strictEqual(blocks[0]!.failedExample, "fn() + 0");
  });

  test("dedents Expected and Got separately", () => {
    assert.strictEqual(blocks[0]!.expected, "1");
    assert.strictEqual(blocks[0]!.got, "2");
  });

  test("leaves exceptionSummary unset", () => {
    assert.strictEqual(blocks[0]!.exceptionSummary, undefined);
  });
});

suite("parseDoctestOutput — exception raised", () => {
  const blocks = parseDoctestOutput(EXCEPTION_BLOCK);

  test("yields exactly one block", () => {
    assert.strictEqual(blocks.length, 1);
  });

  test("collapses the traceback to just `ExceptionType: message`", () => {
    // The doctest internals (`File ".../doctest.py"`, the synthetic
    // `<doctest fn[1]>` frame) are noise; the meaningful line is the
    // ValueError at the bottom.
    assert.strictEqual(blocks[0]!.exceptionSummary, "ValueError: boom");
  });

  test("does not populate expected / got for the exception variant", () => {
    assert.strictEqual(blocks[0]!.expected, undefined);
    assert.strictEqual(blocks[0]!.got, undefined);
  });
});

suite("parseDoctestOutput — multiple blocks in one message", () => {
  const blocks = parseDoctestOutput(COMBINED);

  test("yields one block per failure", () => {
    assert.strictEqual(blocks.length, 2);
  });

  test("preserves per-block file:line on each entry", () => {
    assert.deepStrictEqual(
      blocks.map((b: ParsedDoctestBlock) => `${b.file}:${b.line}`),
      ["/tmp/dt_sample.py:3", "/tmp/dt_sample.py:6"],
    );
  });
});

suite("parseDoctestOutput — degenerate input", () => {
  test("returns empty for unrelated text instead of throwing", () => {
    assert.deepStrictEqual(parseDoctestOutput("not doctest"), []);
  });

  test("skips a block that's missing the File header", () => {
    const broken = [
      "**********************************************************************",
      "Failed example:",
      "    fn()",
      "Expected:",
      "    1",
      "Got:",
      "    2",
    ].join("\n");
    assert.deepStrictEqual(parseDoctestOutput(broken), []);
  });

  test("skips a block that's missing the Failed example section", () => {
    const broken = [
      "**********************************************************************",
      'File "/x.py", line 1, in fn',
      "Some other output we don't recognise",
    ].join("\n");
    assert.deepStrictEqual(parseDoctestOutput(broken), []);
  });
});
