import { z } from "zod";
import {
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  LOCALIZATION_SNAPSHOT_SCHEMA_VERSION,
} from "./context.js";
import { DispatchEventSchema } from "./dispatch-events.js";
import {
  CallLimitsSchema,
  CallPurposeSchema,
  ModelProfileSchema,
  ReasoningPolicySchema,
  SamplingPolicySchema,
  SchemaRefSchema,
  TerminalOutputSchema,
  TerminalSchemaRefSchema,
  ToolContractRefSchema,
} from "./calls-shared.js";
import {
  DecimalUsdSchema,
  EncryptedPayloadRefSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  NonEmptyTextSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  ProviderPolicySchema,
  RoleIdSchema,
  Sha256Schema,
  ShortTextSchema,
  TokenUsageSchema,
  ToolNameSchema,
} from "./shared.js";

export const CALL_RESULT_SCHEMA_VERSION = "itotori.call-result.v2" as const;
export const PHYSICAL_STEP_MEMO_KEY_SCHEMA_VERSION = "itotori.physical-step-memo-key.v1" as const;
export const PHYSICAL_STEP_MEMO_VALUE_SCHEMA_VERSION =
  "itotori.physical-step-memo-value.v2" as const;
export const PHYSICAL_STEP_MEMO_SCHEMA_VERSION = "itotori.physical-step-memo.v2" as const;

// policy - the requested route records only the model. The provider
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
      served: ServedPairSchema,
      generationId: IdentifierSchema.nullable(),
      verification: z.enum(["verified", "explicit-unknown"]),
      usage: TokenUsageSchema,
      billing: BillingSchema,
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
          message: "verified success requires a generation ID and confirmed served route",
        });
      }
      if (
        value.verification === "explicit-unknown" &&
        value.generationId !== null &&
        value.served.status === "confirmed"
      ) {
        context.addIssue({
          code: "custom",
          message: "complete served metadata must be marked verified",
        });
      }
    }),
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
        "gate-rejection",
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
      verification: z.enum(["unverified", "quarantined", "explicit-unknown", "verified"]),
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
      status: z.literal("explicit-unknown"),
      generationId: IdentifierSchema.nullable(),
      served: ServedPairSchema,
    })
    .strict()
    .refine(
      (value) => value.generationId === null || value.served.status === "unknown",
      "complete served metadata must be verified",
    ),
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

export type CallResult = z.infer<typeof CallResultSchema>;
export type TerminalOutput = z.infer<typeof TerminalOutputSchema>;
export type PhysicalStepMemoKey = z.infer<typeof PhysicalStepMemoKeySchema>;
export type PhysicalStepMemoValue = z.infer<typeof PhysicalStepMemoValueSchema>;
export type PhysicalStepMemo = z.infer<typeof PhysicalStepMemoSchema>;
