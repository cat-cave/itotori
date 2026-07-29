import { z } from "zod";
import {
  CallLimitsSchema,
  CallPurposeSchema,
  ContextScopeValueSchema,
  ConversationMessageSchema,
  ModelProfileSchema,
  ProviderPolicySchema,
  ReasoningPolicySchema,
  RoleIdSchema,
  RunModeValueSchema,
  SamplingPolicySchema,
  TerminalSchemaRefSchema,
  ToolContractRefSchema,
} from "./calls-shared.js";
import { IdentifierSchema, Sha256Schema } from "./shared.js";

export const CALL_SPEC_SCHEMA_VERSION = "itotori.call-spec.v1" as const;

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

export type CallSpec = z.infer<typeof CallSpecSchema>;
