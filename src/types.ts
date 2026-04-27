// Mirrors tryke_types (tryke/crates/tryke_types/src/lib.rs)

export interface TrykeExpectedAssertion {
  subject: string;
  matcher: string;
  negated: boolean;
  args: string[];
  line: number;
  label?: string;
}

export interface TrykeAssertion {
  expression: string;
  file?: string;
  line: number;
  span_offset: number;
  span_length: number;
  expected: string;
  received: string;
  expected_arg_span?: [number, number];
}

export interface TrykeTestItem {
  name: string;
  module_path: string;
  file_path?: string;
  line_number?: number;
  display_name?: string;
  expected_assertions?: TrykeExpectedAssertion[];
  groups?: string[];
  skip?: string | boolean;
  todo?: string | boolean;
  xfail?: string | boolean;
  tags?: string[];
  doctest_object?: string;
  // Set by the discovery layer when this entry was generated from a
  // `@test.cases` decorator. The Rust side serializes it via
  // `#[serde(skip_serializing_if = "Option::is_none")]`, so it only appears
  // in JSON for parametrized cases.
  case_label?: string;
  case_index?: number;
}

// Tagged union: { status: "passed"|"failed"|..., detail?: ... }
export type TrykeTestOutcome =
  | { status: "passed" }
  | {
      status: "failed";
      detail: {
        message: string;
        traceback?: string;
        assertions?: TrykeAssertion[];
        executed_lines?: number[];
      };
    }
  | { status: "skipped"; detail?: { reason?: string } }
  | { status: "error"; detail: { message: string } }
  | { status: "x_failed"; detail?: { reason?: string } }
  | { status: "x_passed" }
  | { status: "todo"; detail?: { description?: string } };

export interface TrykeDuration {
  secs: number;
  nanos: number;
}

export interface TrykeTestResult {
  test: TrykeTestItem;
  outcome: TrykeTestOutcome;
  duration: TrykeDuration;
  stdout?: string;
  stderr?: string;
}

export interface TrykeChangedSelectionSummary {
  changed_files: number;
  affected_tests: number;
}

export interface TrykeRunSummary {
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  xfailed: number;
  todo: number;
  duration: TrykeDuration;
  discovery_duration?: TrykeDuration;
  test_duration?: TrykeDuration;
  file_count: number;
  start_time?: string;
  changed_selection?: TrykeChangedSelectionSummary;
}

export interface TrykeFileDiscovery {
  file_path: string;
  tests: TrykeTestItem[];
}

export interface TrykeDiscoveryResult {
  files: TrykeFileDiscovery[];
  errors: TrykeDiscoveryError[];
  duration: TrykeDuration;
}

export interface TrykeDiscoveryError {
  file_path: string;
  message: string;
  line_number?: number;
}

export type TrykeDiscoveryWarningKind = "dynamic_imports";

export interface TrykeDiscoveryWarning {
  file_path: string;
  kind: TrykeDiscoveryWarningKind;
  message: string;
}

// NDJSON events from tryke reporter (CLI direct mode).
// Note: the JSON reporter does not stamp these with run_id — only the
// JSON-RPC server broadcast notifications do.
export type TrykeEvent =
  | { event: "collect_complete"; tests: TrykeTestItem[] }
  | { event: "run_start"; tests: TrykeTestItem[] }
  | { event: "test_complete"; result: TrykeTestResult }
  | { event: "run_complete"; summary: TrykeRunSummary }
  | { event: "discovery_warning"; warning: TrykeDiscoveryWarning };

// JSON-RPC 2.0 protocol types (tryke_server/src/protocol.rs)
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

export interface JsonRpcNotification<T = unknown> {
  jsonrpc: "2.0";
  method: string;
  params: T;
}

// Server RPC param types
export interface RunParams {
  // Required since tryke 0.0.24 (PR #54): the server now broadcasts every
  // run_start / test_complete / run_complete notification to all connected
  // clients, tagged with this id, so each client must filter by the id it
  // sent. Sending a `run` request without it returns INVALID_PARAMS.
  run_id: string;
  tests?: string[];
  filter?: string;
  paths?: string[];
  markers?: string;
}

// Notification params broadcast over the JSON-RPC server channel.
// Every notification carries the run_id of the run that produced it; clients
// share the broadcast and must drop notifications for run_ids they didn't
// initiate.
export interface RunStartParams {
  run_id: string;
  tests: TrykeTestItem[];
}

export interface TestCompleteParams {
  run_id: string;
  result: TrykeTestResult;
}

export interface RunResponse {
  run_id: string;
  summary: TrykeRunSummary;
}

export interface DiscoverParams {
  root: string;
}
