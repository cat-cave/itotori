import { z } from "zod";
import {
  DEFECT_BUNDLE_SCHEMA_VERSION,
  DRAFT_BATCH_SCHEMA_VERSION,
  REVIEW_VERDICT_SCHEMA_VERSION,
  DefectBundleSchema,
  DraftBatchSchema,
  ReviewVerdictSchema,
} from "./outputs.js";
import {
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  LOCALIZATION_SNAPSHOT_SCHEMA_VERSION,
} from "./context.js";
import { DispatchEventSchema } from "./dispatch-events.js";
import {
  ContextScopeValueSchema,
  DecimalUsdSchema,
  EncryptedPayloadRefSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  NonEmptyTextSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  ProviderPolicySchema,
  RoleIdSchema,
  RunModeValueSchema,
  Sha256Schema,
  ShortTextSchema,
  TokenUsageSchema,
  ToolNameSchema,
} from "./shared.js";
import { ToolResultSchema } from "./tools.js";
import {
  LOCALIZED_RENDERING_SCHEMA_VERSION,
  WIKI_OBJECT_SCHEMA_VERSION,
  LocalizedRenderingSchema,
  WikiObjectSchema,
} from "./wiki.js";

export const CALL_SPEC_SCHEMA_VERSION = "itotori.call-spec.v1" as const;
export const CALL_RESULT_SCHEMA_VERSION = "itotori.call-result.v2" as const;
export const PHYSICAL_STEP_MEMO_KEY_SCHEMA_VERSION = "itotori.physical-step-memo-key.v1" as const;
export const PHYSICAL_STEP_MEMO_VALUE_SCHEMA_VERSION =
  "itotori.physical-step-memo-value.v2" as const;
export const PHYSICAL_STEP_MEMO_SCHEMA_VERSION = "itotori.physical-step-memo.v2" as const;

export const CallPurposeSchema = z.enum(["analysis", "draft", "review", "repair", "judge"]);
export const ModelProfileSchema = z.enum(["draft", "reasoning", "reviewer", "judge"]);
export const ReasoningEffortSchema = z.enum(["none", "low", "medium", "high"]);

const SchemaRefSchema = z
  .object({
    name: IdentifierSchema,
    schemaVersion: z.string().min(1).max(128),
    schemaHash: Sha256Schema,
  })
  .strict();

export const ToolContractRefSchema = z
  .object({
    name: ToolNameSchema,
    input: SchemaRefSchema,
    output: SchemaRefSchema,
    implementationVersion: z.string().min(1).max(128),
  })
  .strict();

export const TerminalSchemaRefSchema = z.discriminatedUnion("name", [
  z
    .object({
      name: z.literal("wiki-object"),
      schemaVersion: z.literal(WIKI_OBJECT_SCHEMA_VERSION),
      schemaHash: Sha256Schema,
    })
    .strict(),
  z
    .object({
      name: z.literal("localized-rendering"),
      schemaVersion: z.literal(LOCALIZED_RENDERING_SCHEMA_VERSION),
      schemaHash: Sha256Schema,
    })
    .strict(),
  z
    .object({
      name: z.literal("draft-batch"),
      schemaVersion: z.literal(DRAFT_BATCH_SCHEMA_VERSION),
      schemaHash: Sha256Schema,
    })
    .strict(),
  z
    .object({
      name: z.literal("review-verdict"),
      schemaVersion: z.literal(REVIEW_VERDICT_SCHEMA_VERSION),
      schemaHash: Sha256Schema,
    })
    .strict(),
  z
    .object({
      name: z.literal("defect-bundle"),
      schemaVersion: z.literal(DEFECT_BUNDLE_SCHEMA_VERSION),
      schemaHash: Sha256Schema,
    })
    .strict(),
]);

export const TerminalOutputSchema = z.union([
  WikiObjectSchema,
  LocalizedRenderingSchema,
  DraftBatchSchema,
  ReviewVerdictSchema,
  DefectBundleSchema,
]);

const TextMessageSchema = z
  .object({
    kind: z.literal("text"),
    eventId: Sha256Schema,
    role: z.enum(["system", "user", "assistant"]),
    contentEncrypted: EncryptedPayloadRefSchema,
  })
  .strict();

const ToolCallSchema = z
  .object({
    toolCallId: IdentifierSchema,
    tool: ToolNameSchema,
    argumentsSchema: SchemaRefSchema,
    argumentsEncrypted: EncryptedPayloadRefSchema,
    argumentsHash: Sha256Schema,
  })
  .strict();

const ToolCallMessageSchema = z
  .object({
    kind: z.literal("tool-calls"),
    eventId: Sha256Schema,
    role: z.literal("assistant"),
    calls: z.array(ToolCallSchema).min(1).max(8),
  })
  .strict();

const ToolResultMessageSchema = z
  .object({
    kind: z.literal("tool-result"),
    eventId: Sha256Schema,
    role: z.literal("tool"),
    toolCallId: IdentifierSchema,
    result: ToolResultSchema,
  })
  .strict();

const ReasoningMessageSchema = z
  .object({
    kind: z.literal("opaque-reasoning"),
    eventId: Sha256Schema,
    role: z.literal("assistant"),
    modelProfile: ModelProfileSchema,
    contentEncrypted: EncryptedPayloadRefSchema,
  })
  .strict();

export const ConversationMessageSchema = z.discriminatedUnion("kind", [
  TextMessageSchema,
  ToolCallMessageSchema,
  ToolResultMessageSchema,
  ReasoningMessageSchema,
]);

export const ReasoningPolicySchema = z
  .object({
    effort: ReasoningEffortSchema,
  })
  .strict();

export const SamplingPolicySchema = z
  .object({
    temperature: z.number().min(0).max(2),
    topP: z.number().min(0).max(1),
    seed: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const CallLimitsSchema = z
  .object({
    maxSteps: z.number().int().min(1).max(4),
    maxToolCalls: z.number().int().min(0).max(8),
    maxParallelTools: z.number().int().min(1).max(4),
    maxOutputTokens: z.number().int().min(1).max(131_072),
    timeoutClass: z.enum(["normal", "deep"]),
  })
  .strict();

export const CallSpecSchema = z
  .object({
    schemaVersion: z.literal(CALL_SPEC_SCHEMA_VERSION),
    purpose: CallPurposeSchema,
    roleId: RoleIdSchema,
    modelProfile: ModelProfileSchema,
    modelProfileVersion: z.string().min(1).max(128),
    requestedModel: IdentifierSchema,
    providerPolicy: ProviderPolicySchema,
    parentEventId: Sha256Schema,
    contextSnapshotId: Sha256Schema,
    localizationSnapshotId: Sha256Schema.nullable(),
    messages: z.array(ConversationMessageSchema).min(1).max(1_024),
    tools: z.array(ToolContractRefSchema).max(10),
    output: TerminalSchemaRefSchema,
    promptVersion: z.string().min(1).max(128),
    reasoning: ReasoningPolicySchema,
    sampling: SamplingPolicySchema,
    limits: CallLimitsSchema,
    sampleId: IdentifierSchema.nullable(),
    runMode: RunModeValueSchema,
    contextScope: ContextScopeValueSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const toolNames = value.tools.map((tool) => tool.name);
    if (new Set(toolNames).size !== toolNames.length) {
      context.addIssue({ code: "custom", message: "tool allowlist entries must be unique" });
    }
    if (toolNames.includes("web_search") && value.roleId !== "A7") {
      context.addIssue({ code: "custom", message: "web_search is restricted to A7" });
    }
    if (value.runMode !== "test-dev" && value.contextScope.startsWith("narrowed:")) {
      context.addIssue({ code: "custom", message: "quality calls require whole-game context" });
    }
  });

// ITOTORI-241 - the requested route records only the model. The provider
// policy names NO provider (capability + ZDR + automatic fallback), so
// there is no requested provider order to record; the actually-served
// (model, provider) pair is captured separately as `served` telemetry.
const RequestedRouteSchema = z
  .object({
    model: IdentifierSchema,
  })
  .strict();

const RouteValueSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value, "route value must not have outer whitespace");

const ConfirmedServedPairSchema = z
  .object({
    status: z.literal("confirmed"),
    model: RouteValueSchema,
    provider: RouteValueSchema,
  })
  .strict()
  .refine(
    (value) => value.model !== "unknown" && value.provider !== "unknown",
    "confirmed served route cannot use an unknown sentinel",
  );

export const ServedPairSchema = z.discriminatedUnion("status", [
  ConfirmedServedPairSchema,
  z.object({ status: z.literal("unknown") }).strict(),
]);

const BillingSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("confirmed"), costUsd: DecimalUsdSchema }).strict(),
  z.object({ status: z.literal("billing-unknown") }).strict(),
]);

const ValidationDefectSchema = z
  .object({
    path: z.array(z.union([z.string().max(256), NonNegativeIntegerSchema])).max(64),
    code: z.enum(["invalid-tool-arguments", "invalid-json", "schema", "semantic"]),
    message: ShortTextSchema,
  })
  .strict();

const DispatchEventsSchema = z.array(DispatchEventSchema).max(32);

const CallResultBaseShape = {
  schemaVersion: z.literal(CALL_RESULT_SCHEMA_VERSION),
  memoKey: Sha256Schema,
  requested: RequestedRouteSchema,
  memoHit: z.boolean(),
} as const;

export const CallResultSchema = z.union([
  z
    .object({
      ...CallResultBaseShape,
      status: z.literal("success"),
      value: TerminalOutputSchema,
      responseEventId: Sha256Schema,
      served: ConfirmedServedPairSchema,
      generationId: IdentifierSchema,
      verification: z.literal("verified"),
      usage: TokenUsageSchema,
      billing: BillingSchema,
      events: DispatchEventsSchema,
    })
    .strict(),
  z
    .object({
      ...CallResultBaseShape,
      status: z.literal("failure"),
      failureKind: z.enum([
        "refusal",
        "truncation",
        "empty-output",
        "invalid-tool-arguments",
        "invalid-json",
        "schema-failure",
        "configuration",
        "permission",
        "step-limit",
        "transport",
        "http",
        "cancelled",
        "retries-exhausted",
        "spend-admission",
        "quarantined",
      ]),
      responseEventId: Sha256Schema.nullable(),
      responseEncrypted: EncryptedPayloadRefSchema.nullable(),
      served: ServedPairSchema,
      generationId: IdentifierSchema.nullable(),
      verification: z.enum(["unverified", "quarantined", "verified"]),
      usage: TokenUsageSchema.nullable(),
      billing: BillingSchema,
      defects: z.array(ValidationDefectSchema).max(256),
      events: DispatchEventsSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.verification === "verified" &&
        (value.generationId === null || value.served.status !== "confirmed")
      ) {
        context.addIssue({
          code: "custom",
          message: "verified failures still require confirmed generation and served route",
        });
      }
    }),
]);

const ProjectedMessageRefSchema = z
  .object({
    eventId: Sha256Schema,
    eventHash: Sha256Schema,
  })
  .strict();

const SnapshotKeyMaterialSchema = z
  .object({
    contextSnapshotId: Sha256Schema,
    contextSnapshotSchemaVersion: z.literal(CONTEXT_SNAPSHOT_SCHEMA_VERSION),
    localizationSnapshotId: Sha256Schema.nullable(),
    localizationSnapshotSchemaVersion: z.literal(LOCALIZATION_SNAPSHOT_SCHEMA_VERSION).nullable(),
    decodeRevisionHash: Sha256Schema,
    glossaryRevisionHash: Sha256Schema,
    styleRevisionHash: Sha256Schema,
    acceptedOutputHeadHash: Sha256Schema.nullable(),
  })
  .strict();

const MemoSemanticMaterialSchema = z
  .object({
    substrate: z
      .object({
        name: z.literal("tanstack-ai"),
        version: z.string().min(1).max(128),
        openRouterAdapterVersion: z.string().min(1).max(128),
      })
      .strict(),
    purpose: CallPurposeSchema,
    roleId: RoleIdSchema,
    modelProfile: ModelProfileSchema,
    modelProfileVersion: z.string().min(1).max(128),
    requestedModel: IdentifierSchema,
    providerPolicy: ProviderPolicySchema,
    parentEventHash: Sha256Schema,
    projectedMessages: z.array(ProjectedMessageRefSchema).min(1).max(1_024),
    promptVersion: z.string().min(1).max(128),
    tools: z.array(ToolContractRefSchema).max(10),
    orderedToolResultHashes: z.array(Sha256Schema).max(8),
    terminalSchema: TerminalSchemaRefSchema,
    reasoning: ReasoningPolicySchema,
    sampling: SamplingPolicySchema,
    limits: CallLimitsSchema,
    snapshots: SnapshotKeyMaterialSchema,
    sampleId: IdentifierSchema.nullable(),
  })
  .strict();

export const PhysicalStepMemoKeySchema = z
  .object({
    schemaVersion: z.literal(PHYSICAL_STEP_MEMO_KEY_SCHEMA_VERSION),
    memoKey: Sha256Schema,
    semanticHash: Sha256Schema,
    semantic: MemoSemanticMaterialSchema,
  })
  .strict();

const MemoToolCallSchema = z
  .object({
    toolCallId: IdentifierSchema,
    tool: ToolNameSchema,
    argumentsSchema: SchemaRefSchema,
    argumentsEncrypted: EncryptedPayloadRefSchema,
    argumentsHash: Sha256Schema,
  })
  .strict();

const MemoOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terminal"), output: TerminalOutputSchema }).strict(),
  z
    .object({
      kind: z.literal("tool-calls"),
      calls: z.array(MemoToolCallSchema).min(1).max(8),
    })
    .strict(),
  z
    .object({
      kind: z.literal("invalid"),
      failureKind: z.enum(["invalid-json", "schema-failure", "invalid-tool-arguments"]),
      defects: z.array(ValidationDefectSchema).min(1).max(256),
    })
    .strict(),
  z.object({ kind: z.literal("refusal"), reason: NonEmptyTextSchema }).strict(),
  z.object({ kind: z.literal("truncation"), reason: NonEmptyTextSchema }).strict(),
]);

const ResponseVerificationSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("verified"),
      generationId: IdentifierSchema,
      served: ConfirmedServedPairSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("quarantined"),
      generationId: IdentifierSchema.nullable(),
      served: ServedPairSchema,
      reason: ShortTextSchema,
    })
    .strict(),
]);

const RouterAttemptSchema = z
  .object({
    ordinal: PositiveIntegerSchema,
    model: RouteValueSchema,
    provider: RouteValueSchema,
    startedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema,
    httpStatus: z.number().int().min(100).max(599).nullable(),
    generationId: IdentifierSchema.nullable(),
    billing: BillingSchema,
  })
  .strict();

export const PhysicalStepMemoValueSchema = z
  .object({
    schemaVersion: z.literal(PHYSICAL_STEP_MEMO_VALUE_SCHEMA_VERSION),
    memoKey: Sha256Schema,
    requestEncrypted: EncryptedPayloadRefSchema,
    responseEncrypted: EncryptedPayloadRefSchema,
    outcome: MemoOutcomeSchema,
    verification: ResponseVerificationSchema,
    requestedModel: IdentifierSchema,
    providerPolicy: ProviderPolicySchema,
    routerAttempts: z.array(RouterAttemptSchema).max(64),
    usage: TokenUsageSchema.nullable(),
    billing: BillingSchema,
    completedAt: IsoDateTimeSchema,
  })
  .strict();

export const PhysicalStepMemoSchema = z
  .object({
    schemaVersion: z.literal(PHYSICAL_STEP_MEMO_SCHEMA_VERSION),
    key: PhysicalStepMemoKeySchema,
    value: PhysicalStepMemoValueSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.key.memoKey !== value.value.memoKey) {
      context.addIssue({ code: "custom", message: "memo key and value identity must match" });
    }
  });

export type CallSpec = z.infer<typeof CallSpecSchema>;
export type CallResult = z.infer<typeof CallResultSchema>;
export type TerminalOutput = z.infer<typeof TerminalOutputSchema>;
export type PhysicalStepMemoKey = z.infer<typeof PhysicalStepMemoKeySchema>;
export type PhysicalStepMemoValue = z.infer<typeof PhysicalStepMemoValueSchema>;
export type PhysicalStepMemo = z.infer<typeof PhysicalStepMemoSchema>;
