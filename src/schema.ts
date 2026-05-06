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

export const TrykeExpectedAssertionSchema = z.object({
  subject: z.string(),
  matcher: z.string(),
  negated: z.boolean(),
  args: z.array(z.string()),
  line: z.number(),
  label: z.string().optional(),
});

export const TrykeAssertionSchema = z.object({
  expression: z.string(),
  file: z.string().optional(),
  line: z.number(),
  span_offset: z.number(),
  span_length: z.number(),
  expected: z.string(),
  received: z.string(),
  expected_arg_span: z.tuple([z.number(), z.number()]).optional(),
});

export const TrykeTestItemSchema = z.object({
  name: z.string(),
  module_path: z.string(),
  file_path: z.string().optional(),
  line_number: z.number().optional(),
  display_name: z.string().optional(),
  expected_assertions: z.array(TrykeExpectedAssertionSchema).optional(),
  groups: z.array(z.string()).optional(),
  skip: z.union([z.string(), z.boolean()]).optional(),
  todo: z.union([z.string(), z.boolean()]).optional(),
  xfail: z.union([z.string(), z.boolean()]).optional(),
  tags: z.array(z.string()).optional(),
  doctest_object: z.string().optional(),
  case_label: z.string().optional(),
  case_index: z.number().optional(),
});

export const TrykeTestOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("passed") }),
  z.object({
    status: z.literal("failed"),
    detail: z.object({
      message: z.string(),
      traceback: z.string().optional(),
      assertions: z.array(TrykeAssertionSchema).optional(),
      executed_lines: z.array(z.number()).optional(),
    }),
  }),
  z.object({
    status: z.literal("skipped"),
    detail: z.object({ reason: z.string().optional() }).optional(),
  }),
  z.object({
    status: z.literal("error"),
    detail: z.object({ message: z.string() }),
  }),
  z.object({
    status: z.literal("x_failed"),
    detail: z.object({ reason: z.string().optional() }).optional(),
  }),
  z.object({ status: z.literal("x_passed") }),
  z.object({
    status: z.literal("todo"),
    detail: z.object({ description: z.string().optional() }).optional(),
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
  stdout: z.string().optional(),
  stderr: z.string().optional(),
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
  discovery_duration: TrykeDurationSchema.optional(),
  test_duration: TrykeDurationSchema.optional(),
  file_count: z.number(),
  start_time: z.string().optional(),
  changed_selection: TrykeChangedSelectionSummarySchema.optional(),
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
  run_id: z.string().optional(),
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
