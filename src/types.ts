// Wire types — re-exported from `schema.ts` so the zod-inferred type and the
// runtime validator stay in lockstep. Anything that crosses the
// CLI/RPC/socket boundary lives in schema.ts; the types declared inline here
// are extension-internal and don't need runtime validation.

export type {
  TrykeExpectedAssertion,
  TrykeAssertion,
  TrykeTestItem,
  TrykeTestOutcome,
  TrykeDuration,
  TrykeTestResult,
  TrykeChangedSelectionSummary,
  TrykeRunSummary,
  TrykeDiscoveryWarningKind,
  TrykeDiscoveryWarning,
  TrykeEvent,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcMessage,
  RunStartParams,
  TestCompleteParams,
  RunCompleteParams,
  RunResponse,
} from "./schema";

// Outbound request — we send these, never receive them, so no schema needed.
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

// Outbound run params — sent on `run` requests. The run_id is required since
// tryke 0.0.24 (PR #54): the server broadcasts every run_start /
// test_complete / run_complete notification to all connected clients tagged
// with this id, so each client filters by the id it sent. Sending a `run`
// request without it returns INVALID_PARAMS.
export interface RunParams {
  run_id: string;
  tests?: string[];
  filter?: string;
  paths?: string[];
  markers?: string;
}

export interface DiscoverParams {
  root: string;
}

// Local-only types — used by discovery to bucket tests by file. Never
// crosses a wire boundary, so no schema.
import type { TrykeTestItem, TrykeDuration } from "./schema";

export interface TrykeFileDiscovery {
  file_path: string;
  tests: TrykeTestItem[];
}

export interface TrykeDiscoveryError {
  file_path: string;
  message: string;
  line_number?: number;
}

export interface TrykeDiscoveryResult {
  files: TrykeFileDiscovery[];
  errors: TrykeDiscoveryError[];
  duration: TrykeDuration;
}
