import * as fs from "fs";

const sourceCache = new Map<string, string[]>();

// Read a file's lines once and cache the array. Per-case line resolution has
// to look at every case on a decorator, so reading the file once up-front
// beats streaming it per case.
export function readLines(filePath: string): string[] {
  const cached = sourceCache.get(filePath);
  if (cached) {
    return cached;
  }
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const lines = content.split(/\r?\n/);
  sourceCache.set(filePath, lines);
  return lines;
}

export function clearSourceCache(filePath?: string): void {
  if (filePath) {
    sourceCache.delete(filePath);
  } else {
    sourceCache.clear();
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The literal substrings that identify the *origin line* of a single case
// inside a `@t.test.cases(...)` decorator. We require the literal label
// string (with quotes where applicable) so a label that happens to appear
// in an unrelated test body further down doesn't win.
function caseLinePatterns(label: string): RegExp[] {
  const escaped = escapeRegex(label);
  return [
    new RegExp(`test\\.case\\("${escaped}"`),
    new RegExp(`test\\.case\\('${escaped}'`),
    new RegExp(`\\("${escaped}"\\s*,`),
    new RegExp(`\\('${escaped}'\\s*,`),
    new RegExp(`^\\s*${escaped}\\s*=`),
  ];
}

// Locate the line that declares the case whose label is `label`. Anchored
// near `startLine` (the decorated function's line) so a label that happens
// to appear in an unrelated test body further down doesn't win. Falls back
// to `startLine` when nothing matches.
//
// `startLine` is 1-based; return value is 1-based.
export function findCaseLine(filePath: string, label: string, startLine: number): number {
  const lines = readLines(filePath);
  if (lines.length === 0) {
    return startLine;
  }
  const patterns = caseLinePatterns(label);
  const lo = Math.max(1, startLine - 60);
  const hi = Math.min(lines.length, startLine + 120);
  let best: number | undefined;
  for (let i = lo; i <= hi; i++) {
    const line = lines[i - 1];
    if (line === undefined) {
      continue;
    }
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        if (best === undefined || Math.abs(i - startLine) < Math.abs(best - startLine)) {
          best = i;
        }
        break;
      }
    }
  }
  return best ?? startLine;
}

// Locate the `with t.describe("name"):` (or `name="name"`) line for a
// describe-block group. Returns 1-based line number, or undefined if no
// match is found — caller falls back to leaving the namespace rangeless.
//
// `anchorLine` is the line of the first child test, used to bias the
// search toward the closest preceding `with` clause when a file has
// multiple describes.
export function findDescribeLine(
  filePath: string,
  groupName: string,
  anchorLine: number,
): number | undefined {
  const lines = readLines(filePath);
  if (lines.length === 0) {
    return undefined;
  }
  const escaped = escapeRegex(groupName);
  // Match: `with [t.|tryke.]describe("Group"):` or
  //        `with [t.|tryke.]describe(name="Group"):` or
  //        symbol-aliased `with describe("Group"):`.
  const patterns = [
    new RegExp(`\\bdescribe\\s*\\(\\s*["']${escaped}["']`),
    new RegExp(`\\bdescribe\\s*\\(\\s*name\\s*=\\s*["']${escaped}["']`),
  ];
  // Search the whole file but prefer the match closest to (and at or before)
  // anchorLine — that's the describe() the test actually lives inside.
  let best: number | undefined;
  for (let i = 1; i <= lines.length; i++) {
    const line = lines[i - 1];
    if (line === undefined) {
      continue;
    }
    if (!patterns.some((p) => p.test(line))) {
      continue;
    }
    if (best === undefined) {
      best = i;
      continue;
    }
    const bestDist = anchorLine - best;
    const newDist = anchorLine - i;
    // Prefer the latest describe at or before the anchor; if both are
    // after the anchor, prefer the earliest.
    const bestPreceding = bestDist >= 0;
    const newPreceding = newDist >= 0;
    if (newPreceding && (!bestPreceding || newDist < bestDist)) {
      best = i;
    } else if (!bestPreceding && !newPreceding && i < best) {
      best = i;
    }
  }
  return best;
}
