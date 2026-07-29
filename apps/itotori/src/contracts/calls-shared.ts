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
  ContextScopeValueSchema,
  EncryptedPayloadRefSchema,
  IdentifierSchema,
  ProviderPolicySchema,
  RoleIdSchema,
  RunModeValueSchema,
  Sha256Schema,
  ToolNameSchema,
} from "./shared.js";
import { ToolResultSchema } from "./tools.js";
import {
  LOCALIZED_RENDERING_SCHEMA_VERSION,
  WIKI_OBJECT_SCHEMA_VERSION,
  LocalizedRenderingSchema,
  WikiObjectKindSchema,
  WikiObjectSchema,
} from "./wiki.js";

export const CallPurposeSchema = z.enum(["analysis", "draft", "review", "repair", "judge"]);
export const ModelProfileSchema = z.enum(["draft", "reasoning", "reviewer", "judge"]);
export const ReasoningEffortSchema = z.enum(["none", "low", "medium", "high"]);
export const SchemaRefSchema = z
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
      /** Optional only for older generic callers; authoring roles must set it. */
      kind: WikiObjectKindSchema.optional(),
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

export { ContextScopeValueSchema, ProviderPolicySchema, RoleIdSchema, RunModeValueSchema };
