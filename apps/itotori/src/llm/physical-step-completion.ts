import {
  conversationEventId,
  type CompletedLlmStep,
  type LlmStepAttemptContext,
  type LlmStepBilling,
} from "@itotori/db";
import type { AnyTextAdapter, StreamChunk, TokenUsage } from "@tanstack/ai";
import {
  CONVERSATION_EVENT_SCHEMA_VERSION,
  PHYSICAL_STEP_MEMO_SCHEMA_VERSION,
  PHYSICAL_STEP_MEMO_VALUE_SCHEMA_VERSION,
  PhysicalStepMemoSchema,
  type CallSpec,
  type EncryptedPayloadRef,
  type PhysicalStepMemoKey,
} from "../contracts/index.js";
import { canonicalJson, sha256 } from "./canonical-json.js";
import {
  invalidMemoOutcome,
  memoEncryptedRef,
  streamMemoOutcome,
  usageFromChunks,
  type PhysicalStepMemoOutcome,
} from "./physical-step-outcome.js";
import {
  reconcileGenerationMetadata,
  type GenerationMetadataSource,
  type GenerationReconciliation,
} from "./generation-metadata.js";
import { terminalOutputSchema } from "./terminal-output.js";

type StructuredOutputResult = Awaited<ReturnType<AnyTextAdapter["structuredOutput"]>>;

export interface PhysicalStepIdentity {
  key: PhysicalStepMemoKey;
  requestJson: string;
  responseRef: (responseJson: string) => EncryptedPayloadRef;
}

export async function completedStreamStep(
  spec: CallSpec,
  identity: PhysicalStepIdentity,
  chunks: readonly StreamChunk[],
  attempt: LlmStepAttemptContext,
  parentResponseEventId: string,
  metadataSource: GenerationMetadataSource,
): Promise<CompletedLlmStep> {
  const responseJson = canonicalJson(chunks);
  const metadata = await reconcileGenerationMetadata(chunks, metadataSource);
  return completedStep(
    spec,
    identity,
    responseJson,
    streamMemoOutcome(spec, identity.key.memoKey, chunks),
    usageFromChunks(chunks),
    attempt,
    parentResponseEventId,
    new Date().toISOString(),
    metadata,
  );
}

export async function completedStructuredStep(
  spec: CallSpec,
  identity: PhysicalStepIdentity,
  result: StructuredOutputResult,
  attempt: LlmStepAttemptContext,
  parentResponseEventId: string,
  metadataSource: GenerationMetadataSource,
): Promise<CompletedLlmStep> {
  const responseJson = canonicalJson(result);
  const parsed = terminalOutputSchema(spec.output).safeParse(result.data);
  const outcome = parsed.success
    ? ({ kind: "terminal", output: parsed.data } as const)
    : invalidMemoOutcome(
        "schema-failure",
        parsed.error.issues.map((issue) => issue.message),
      );
  const metadata = await reconcileGenerationMetadata([], metadataSource);
  const usageBilling = billingFromUsage(result.usage);
  return completedStep(
    spec,
    identity,
    responseJson,
    outcome,
    result.usage,
    attempt,
    parentResponseEventId,
    new Date().toISOString(),
    metadata.billing.status === "confirmed"
      ? metadata
      : {
          ...metadata,
          billing: usageBilling.billing,
          reportedCostUsd: usageBilling.reportedCostUsd,
        },
  );
}

function completedStep(
  spec: CallSpec,
  identity: PhysicalStepIdentity,
  responseJson: string,
  outcome: PhysicalStepMemoOutcome,
  usage: TokenUsage | undefined | null,
  attempt: LlmStepAttemptContext,
  parentResponseEventId: string,
  completedAt: string,
  metadata: GenerationReconciliation,
): CompletedLlmStep {
  const responseEventBody = {
    kind: "physical-model-response",
    memoKey: identity.key.memoKey,
    responseHash: sha256(responseJson),
    outcomeKind: outcome.kind,
  } as const;
  const snapshotId = spec.localizationSnapshotId ?? spec.contextSnapshotId;
  const parentEventIds = [parentResponseEventId];
  const responseEventId = conversationEventId({
    parentIds: parentEventIds,
    kind: "assistant",
    snapshotId,
    role: spec.roleId,
    body: responseEventBody,
    memoKey: identity.key.memoKey,
  });
  const memoBilling = contractBilling(metadata.billing);
  const normalizedUsage = usage
    ? {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        reasoningTokens: usage.completionTokensDetails?.reasoningTokens ?? 0,
        cachedTokens: usage.promptTokensDetails?.cachedTokens ?? 0,
      }
    : null;
  const memo = PhysicalStepMemoSchema.parse({
    schemaVersion: PHYSICAL_STEP_MEMO_SCHEMA_VERSION,
    key: identity.key,
    value: {
      schemaVersion: PHYSICAL_STEP_MEMO_VALUE_SCHEMA_VERSION,
      memoKey: identity.key.memoKey,
      requestEncrypted: memoEncryptedRef(identity.key.memoKey, "request", identity.requestJson),
      responseEncrypted: identity.responseRef(responseJson),
      outcome,
      verification:
        metadata.generationId !== null && metadata.served.status === "confirmed"
          ? {
              status: "verified",
              generationId: metadata.generationId,
              served: metadata.served,
            }
          : {
              status: "quarantined",
              generationId: metadata.generationId,
              served: metadata.served,
              reason: "generation ID and schema-valid served route were not both present",
            },
      requestedModel: spec.requestedModel,
      providerPolicy: spec.providerPolicy,
      routerAttempts: metadata.routerAttempts.map((routerAttempt) => ({
        ...routerAttempt,
        startedAt: attempt.startedAt,
        completedAt,
        generationId: metadata.generationId,
        billing: memoBilling,
      })),
      usage: metadata.usage ?? normalizedUsage,
      billing: memoBilling,
      completedAt,
    },
  });
  return {
    kind: "completed",
    responseJson,
    outcomeJson: canonicalJson(memo),
    outcomeKind: outcome.kind,
    generationId: metadata.generationId,
    requestedModel: spec.requestedModel,
    providerPolicy: spec.providerPolicy,
    served: metadata.served,
    routerAttempts: metadata.routerAttempts,
    usage: metadata.usage ?? normalizedUsage,
    billing: metadata.billing,
    reportedCostUsd: metadata.reportedCostUsd,
    completedAt,
    responseEvent: {
      eventId: responseEventId,
      schemaVersion: CONVERSATION_EVENT_SCHEMA_VERSION,
      parentEventIds,
      snapshotKind: spec.localizationSnapshotId ? "localization" : "context",
      snapshotId,
      actorRole: spec.roleId,
      bodyJson: canonicalJson(responseEventBody),
    },
  };
}

function contractBilling(billing: LlmStepBilling) {
  return billing.status === "confirmed"
    ? ({ status: "confirmed", costUsd: billing.costUsd } as const)
    : ({ status: "billing-unknown" } as const);
}

function billingFromUsage(usage: TokenUsage | undefined): {
  billing: LlmStepBilling;
  reportedCostUsd: string | null;
} {
  const cost = usage?.cost;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    return { billing: { status: "billing_unknown" }, reportedCostUsd: null };
  }
  const fixed = cost.toFixed(12);
  if (Number(fixed) !== cost) {
    return { billing: { status: "billing_unknown" }, reportedCostUsd: null };
  }
  const costUsd = fixed.replace(/(?:\.0+|(?<fraction>\.\d*?)0+)$/u, "$<fraction>");
  return {
    billing: { status: "confirmed", costUsd },
    reportedCostUsd: costUsd,
  };
}
