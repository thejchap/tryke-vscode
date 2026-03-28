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
}

// Tagged union: { status: "passed"|"failed"|..., detail?: ... }
export type TrykeTestOutcome =
  | { status: "passed" }
  | { status: "failed"; detail: { message: string; traceback?: string; assertions?: TrykeAssertion[] } }
  | { status: "skipped"; detail?: { reason?: string } }
  | { status: "error"; detail: { message: string; traceback?: string } }
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

// NDJSON events from tryke reporter
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
  tests?: string[];
  filter?: string;
  paths?: string[];
  markers?: string;
}

export interface DiscoverParams {
  root: string;
}
