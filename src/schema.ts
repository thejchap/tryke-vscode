// Runtime schemas for everything that crosses a process or socket boundary.
//
// Tryke evolves independently — the run_id rollout in PR #54 already broke
// wire compat once. zod gives us schema + inferred types from one source so a
// shape drift on the tryke side surfaces as a logged validation error here
// instead of a TypeScript cast silently producing `undefined.foo`.
//
// The hand-written interfaces in `types.ts` mirror the same Rust types in
// tryke. Where both exist, the inferred type from these schemas is the
// authoritative one and `types.ts` re-exports it.

import { z } from "zod";

// Rust `Option<T>` without `#[serde(skip_serializing_if = "Option::is_none")]`
// — i.e. most Option fields on the tryke side — serializes `None` as the
// literal `null`, not as an absent key. `.optional()` only accepts absent;
// `.nullish()` accepts both null AND absent, which is what we want for any
// field that maps to a Rust Option regardless of skip attribute. Without
// this, e.g. an `expect(...)` without a label arrives as `"label": null`
// and the whole event fails validation — collect_complete then drops
// every discovered test and the Test Explorer goes empty.
// Consumers in this repo already handle null via `??` / truthy checks.

export const TrykeExpectedAssertionSchema = z.object({
  subject: z.string(),
  matcher: z.string(),
  negated: z.boolean(),
  args: z.array(z.string()),
  line: z.number(),
  label: z.string().nullish(),
});

export const TrykeAssertionSchema = z.object({
  expression: z.string(),
  file: z.string().nullish(),
  line: z.number(),
  span_offset: z.number(),
  span_length: z.number(),
  expected: z.string(),
  received: z.string(),
  expected_arg_span: z.tuple([z.number(), z.number()]).nullish(),
});

export const TrykeTestItemSchema = z.object({
  name: z.string(),
  module_path: z.string(),
  file_path: z.string().nullish(),
  line_number: z.number().nullish(),
  display_name: z.string().nullish(),
  expected_assertions: z.array(TrykeExpectedAssertionSchema).nullish(),
  groups: z.array(z.string()).nullish(),
  skip: z.union([z.string(), z.boolean()]).nullish(),
  todo: z.union([z.string(), z.boolean()]).nullish(),
  xfail: z.union([z.string(), z.boolean()]).nullish(),
  tags: z.array(z.string()).nullish(),
  doctest_object: z.string().nullish(),
  case_label: z.string().nullish(),
  case_index: z.number().nullish(),
});

export const TrykeTestOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("passed") }),
  z.object({
    status: z.literal("failed"),
    detail: z.object({
      message: z.string(),
      traceback: z.string().nullish(),
      assertions: z.array(TrykeAssertionSchema).nullish(),
      executed_lines: z.array(z.number()).nullish(),
    }),
  }),
  z.object({
    status: z.literal("skipped"),
    detail: z.object({ reason: z.string().nullish() }).nullish(),
  }),
  z.object({
    status: z.literal("error"),
    detail: z.object({ message: z.string() }),
  }),
  z.object({
    status: z.literal("x_failed"),
    detail: z.object({ reason: z.string().nullish() }).nullish(),
  }),
  z.object({ status: z.literal("x_passed") }),
  z.object({
    status: z.literal("todo"),
    detail: z.object({ description: z.string().nullish() }).nullish(),
  }),
]);

export const TrykeDurationSchema = z.object({
  secs: z.number(),
  nanos: z.number(),
});

export const TrykeTestResultSchema = z.object({
  test: TrykeTestItemSchema,
  outcome: TrykeTestOutcomeSchema,
  duration: TrykeDurationSchema,
  stdout: z.string().nullish(),
  stderr: z.string().nullish(),
});

export const TrykeChangedSelectionSummarySchema = z.object({
  changed_files: z.number(),
  affected_tests: z.number(),
});

export const TrykeRunSummarySchema = z.object({
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  errors: z.number(),
  xfailed: z.number(),
  todo: z.number(),
  duration: TrykeDurationSchema,
  discovery_duration: TrykeDurationSchema.nullish(),
  test_duration: TrykeDurationSchema.nullish(),
  file_count: z.number(),
  start_time: z.string().nullish(),
  changed_selection: TrykeChangedSelectionSummarySchema.nullish(),
});

export const TrykeDiscoveryWarningKindSchema = z.literal("dynamic_imports");

export const TrykeDiscoveryWarningSchema = z.object({
  file_path: z.string(),
  kind: TrykeDiscoveryWarningKindSchema,
  message: z.string(),
});

// NDJSON events from the tryke reporter. The CLI reporter does not stamp
// these with run_id — that field is only on the JSON-RPC server broadcast
// notifications below.
export const TrykeEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("collect_complete"), tests: z.array(TrykeTestItemSchema) }),
  z.object({ event: z.literal("run_start"), tests: z.array(TrykeTestItemSchema) }),
  z.object({ event: z.literal("test_complete"), result: TrykeTestResultSchema }),
  z.object({ event: z.literal("run_complete"), summary: TrykeRunSummarySchema }),
  z.object({ event: z.literal("discovery_warning"), warning: TrykeDiscoveryWarningSchema }),
]);

// JSON-RPC 2.0
export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
    })
    .optional(),
});

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown(),
});

// A response has `id`, a notification has `method` instead. The server's
// own protocol doesn't send requests at us, only responses + notifications.
export const JsonRpcMessageSchema = z.union([
  JsonRpcResponseSchema,
  JsonRpcNotificationSchema,
]);

// Server RPC param types — broadcast notifications carry the run_id of the
// run that produced them; clients share the broadcast and must drop
// notifications for run_ids they didn't initiate.
export const RunStartParamsSchema = z.object({
  run_id: z.string(),
  tests: z.array(TrykeTestItemSchema),
});

export const TestCompleteParamsSchema = z.object({
  run_id: z.string(),
  result: TrykeTestResultSchema,
});

export const RunCompleteParamsSchema = z.object({
  run_id: z.string().nullish(),
});

export const RunResponseSchema = z.object({
  run_id: z.string(),
  summary: TrykeRunSummarySchema,
});

// Inferred types — these are the canonical TS types for the wire format.
export type TrykeExpectedAssertion = z.infer<typeof TrykeExpectedAssertionSchema>;
export type TrykeAssertion = z.infer<typeof TrykeAssertionSchema>;
export type TrykeTestItem = z.infer<typeof TrykeTestItemSchema>;
export type TrykeTestOutcome = z.infer<typeof TrykeTestOutcomeSchema>;
export type TrykeDuration = z.infer<typeof TrykeDurationSchema>;
export type TrykeTestResult = z.infer<typeof TrykeTestResultSchema>;
export type TrykeChangedSelectionSummary = z.infer<typeof TrykeChangedSelectionSummarySchema>;
export type TrykeRunSummary = z.infer<typeof TrykeRunSummarySchema>;
export type TrykeDiscoveryWarningKind = z.infer<typeof TrykeDiscoveryWarningKindSchema>;
export type TrykeDiscoveryWarning = z.infer<typeof TrykeDiscoveryWarningSchema>;
export type TrykeEvent = z.infer<typeof TrykeEventSchema>;
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;
export type JsonRpcMessage = z.infer<typeof JsonRpcMessageSchema>;
export type RunStartParams = z.infer<typeof RunStartParamsSchema>;
export type TestCompleteParams = z.infer<typeof TestCompleteParamsSchema>;
export type RunCompleteParams = z.infer<typeof RunCompleteParamsSchema>;
export type RunResponse = z.infer<typeof RunResponseSchema>;
