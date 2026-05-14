// Python's `doctest` module produces a fixed-format text block per failure:
//
//   **********************************************************************
//   File "PATH", line N, in OBJECT
//   Failed example:
//       <example body, 4-space indented>
//   Expected:
//       <expected, 4-space indented>
//   Got:
//       <got, 4-space indented>
//
// or, when the example raised an exception:
//
//   **********************************************************************
//   File "PATH", line N, in OBJECT
//   Failed example:
//       <example body>
//   Exception raised:
//       Traceback (most recent call last):
//         File "/.../doctest.py", ...
//         File "<doctest OBJECT[i]>", ...
//       ExceptionType: message
//
// tryke ships this raw text as `outcome.detail.message` with no structured
// `assertions[]`. Parsing it lets us:
//   - anchor the inline TestMessage to the real failing line (not the
//     class definition the test item was created at),
//   - hide Python's internal `doctest.py` traceback frames,
//   - render the example as a code block and use TestMessage.diff() when
//     it's an Expected/Got mismatch.

export interface ParsedDoctestBlock {
  file: string;
  line: number;
  failedExample: string;
  // Exactly one of these will be set:
  expected?: string;
  got?: string;
  exceptionSummary?: string;
}

const SEPARATOR = /\n?^\*{40,}$\n?/m;
const SEPARATOR_GLOBAL = /\n?^\*{40,}$\n?/gm;

// Cheap pre-check before paying for the full parse. Keeps callers from
// running the regex split + per-block walk for every non-doctest failure.
export function looksLikeDoctestOutput(text: string): boolean {
  return SEPARATOR.test(text) && /^Failed example:$/m.test(text);
}

export function parseDoctestOutput(text: string): ParsedDoctestBlock[] {
  const blocks: ParsedDoctestBlock[] = [];
  for (const raw of text.split(SEPARATOR_GLOBAL)) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      continue;
    }
    const parsed = parseBlock(trimmed);
    if (parsed) {
      blocks.push(parsed);
    }
  }
  return blocks;
}

function parseBlock(block: string): ParsedDoctestBlock | undefined {
  // `File "PATH", line N, in OBJECT` — OBJECT is optional in some shapes
  // but the file+line are always present on doctest's report header.
  const header = block.match(/^File "(?<file>[^"]+)", line (?<line>\d+)/m);
  if (!header?.groups) {
    return undefined;
  }
  const file = header.groups.file ?? "";
  const lineNum = Number.parseInt(header.groups.line ?? "0", 10);
  if (file === "" || !Number.isFinite(lineNum)) {
    return undefined;
  }

  // Sections are introduced by these exact labels on their own line. Split
  // on the labels rather than on indentation so multi-line examples /
  // expected blocks survive intact.
  const sections = splitSections(block);

  const failedExample = sections.get("Failed example:");
  if (failedExample === undefined) {
    return undefined;
  }

  const expected = sections.get("Expected:");
  const got = sections.get("Got:");
  const exceptionRaw = sections.get("Exception raised:");

  const out: ParsedDoctestBlock = {
    file,
    line: lineNum,
    failedExample: dedent(failedExample),
  };
  if (expected !== undefined && got !== undefined) {
    out.expected = dedent(expected);
    out.got = dedent(got);
  } else if (exceptionRaw !== undefined) {
    out.exceptionSummary = summarizeTraceback(dedent(exceptionRaw));
  }
  return out;
}

const SECTION_LABELS = ["Failed example:", "Expected:", "Got:", "Exception raised:"];

function splitSections(block: string): Map<string, string> {
  const result = new Map<string, string>();
  const lines = block.split(/\r?\n/);

  let currentLabel: string | undefined;
  let currentBody: string[] = [];

  const flush = (): void => {
    if (currentLabel !== undefined) {
      result.set(currentLabel, currentBody.join("\n"));
    }
  };

  for (const line of lines) {
    if (SECTION_LABELS.includes(line)) {
      flush();
      currentLabel = line;
      currentBody = [];
    } else if (currentLabel !== undefined) {
      currentBody.push(line);
    }
  }
  flush();
  return result;
}

// Doctest output bodies are indented exactly 4 spaces. Strip that uniformly
// without touching deeper indentation within the body.
function dedent(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.startsWith("    ") ? line.slice(4) : line))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

// A doctest traceback always ends with the actual `ExceptionType: message`
// line. The frames above it are Python internals + the synthetic
// `<doctest OBJECT[i]>` frame for the example itself, neither of which
// help the reader. Surface only the exception line — the inline message
// stays compact and useful.
function summarizeTraceback(traceback: string): string {
  const lines = traceback
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line !== "");
  // Find the last line that looks like `Type: message`. Walk from the end
  // because nested exceptions can produce multi-block tracebacks and we
  // want the most-recent one.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    // Skip "Traceback (most recent call last):" itself and frame lines
    // (which start with `File ` or are indented).
    if (line.startsWith("File ") || line.startsWith(" ") || line === "Traceback (most recent call last):") {
      continue;
    }
    if (/^[\w.]+(Error|Exception|Warning)\b/.test(line) || /^[\w.]+:/.test(line)) {
      return line;
    }
  }
  // Couldn't find one — return the whole thing rather than nothing.
  return lines.join("\n");
}
