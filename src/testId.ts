import * as path from "path";

export interface TestIdInput {
  name: string;
  file_path?: string;
  module_path: string;
  groups?: string[];
  case_label?: string;
}

// Builds the canonical VS Code TestItem id for a tryke test.
// Format: "<relative-path>::<group>::...::<name>[<case_label>]" where the
// case_label suffix is only present for @test.cases-generated items.
export function buildTestId(test: TestIdInput, workspaceRoot: string): string {
  const filePath = test.file_path ?? test.module_path;
  const relPath = path.relative(workspaceRoot, path.resolve(workspaceRoot, filePath));
  const leaf = test.case_label ? `${test.name}[${test.case_label}]` : test.name;
  return [relPath, ...(test.groups ?? []), leaf].join("::");
}

// Strips a "[case_label]" suffix from a test name. Returns the bare name and
// label separately — used by the runner when it needs to find the underlying
// function while preserving the per-case identity.
export function splitCaseLabel(name: string): { name: string; caseLabel?: string } {
  const match = name.match(/^(.+)\[([^\]]*)\]$/);
  if (!match || match[1] === undefined || match[2] === undefined) {
    return { name };
  }
  return { name: match[1], caseLabel: match[2] };
}
