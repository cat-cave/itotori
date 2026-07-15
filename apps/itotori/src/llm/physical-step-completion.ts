import type { CompletedLlmStep, LlmStepAttemptContext } from "@itotori/db";
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
  emptyUsage,
  invalidMemoOutcome,
  memoEncryptedRef,
  streamMemoOutcome,
  usageFromChunks,
  type PhysicalStepMemoOutcome,
} from "./physical-step-outcome.js";
import { terminalOutputSchema } from "./terminal-output.js";

type StructuredOutputResult = Awaited<ReturnType<AnyTextAdapter["structuredOutput"]>>;

export interface PhysicalStepIdentity {
  key: PhysicalStepMemoKey;
  requestJson: string;
  responseRef: (responseJson: string) => EncryptedPayloadRef;
}

export function completedStreamStep(
  spec: CallSpec,
  identity: PhysicalStepIdentity,
  chunks: readonly StreamChunk[],
  attempt: LlmStepAttemptContext,
  parentResponseEventId: string,
): CompletedLlmStep {
  const responseJson = canonicalJson(chunks);
  return completedStep(
    spec,
    identity,
    responseJson,
    streamMemoOutcome(spec, identity.key.memoKey, chunks),
    usageFromChunks(chunks),
    attempt,
    parentResponseEventId,
    new Date().toISOString(),
  );
}

export function completedStructuredStep(
  spec: CallSpec,
  identity: PhysicalStepIdentity,
  result: StructuredOutputResult,
  attempt: LlmStepAttemptContext,
  parentResponseEventId: string,
): CompletedLlmStep {
  const responseJson = canonicalJson(result);
  const parsed = terminalOutputSchema(spec.output).safeParse(result.data);
  const outcome = parsed.success
    ? ({ kind: "terminal", output: parsed.data } as const)
    : invalidMemoOutcome(
        "schema-failure",
        parsed.error.issues.map((issue) => issue.message),
      );
  return completedStep(
    spec,
    identity,
    responseJson,
    outcome,
    result.usage ?? emptyUsage(),
    attempt,
    parentResponseEventId,
    new Date().toISOString(),
  );
}

function completedStep(
  spec: CallSpec,
  identity: PhysicalStepIdentity,
  responseJson: string,
  outcome: PhysicalStepMemoOutcome,
  usage: TokenUsage,
  attempt: LlmStepAttemptContext,
  parentResponseEventId: string,
  completedAt: string,
): CompletedLlmStep {
  const responseEventId = sha256({
    memoKey: identity.key.memoKey,
    responseHash: sha256(responseJson),
  });
  const memoBilling = { status: "billing-unknown" as const };
  const normalizedUsage = {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    reasoningTokens: usage.completionTokensDetails?.reasoningTokens ?? 0,
    cachedTokens: usage.promptTokensDetails?.cachedTokens ?? 0,
  };
  const memo = PhysicalStepMemoSchema.parse({
    schemaVersion: PHYSICAL_STEP_MEMO_SCHEMA_VERSION,
    key: identity.key,
    value: {
      schemaVersion: PHYSICAL_STEP_MEMO_VALUE_SCHEMA_VERSION,
      memoKey: identity.key.memoKey,
      requestEncrypted: memoEncryptedRef(identity.key.memoKey, "request", identity.requestJson),
      responseEncrypted: identity.responseRef(responseJson),
      outcome,
      verification: {
        status: "quarantined",
        generationId: null,
        served: null,
        reason: "served route verification pending",
      },
      requestedModel: spec.requestedModel,
      providerPolicy: spec.providerPolicy,
      routerAttempts: [
        {
          ordinal: attempt.ordinal,
          provider: null,
          startedAt: attempt.startedAt,
          completedAt,
          httpStatus: 200,
          generationId: null,
          billing: memoBilling,
        },
      ],
      usage: normalizedUsage,
      billing: memoBilling,
      completedAt,
    },
  });
  return {
    kind: "completed",
    responseJson,
    outcomeJson: canonicalJson(memo),
    outcomeKind: outcome.kind,
    verificationStatus: "quarantined",
    generationId: null,
    requestedModel: spec.requestedModel,
    providerPolicy: spec.providerPolicy,
    servedModel: null,
    servedProvider: null,
    usage: normalizedUsage,
    billing: { status: "billing_unknown" },
    completedAt,
    responseEvent: {
      eventId: responseEventId,
      schemaVersion: CONVERSATION_EVENT_SCHEMA_VERSION,
      parentEventIds: [parentResponseEventId],
      snapshotKind: spec.localizationSnapshotId ? "localization" : "context",
      snapshotId: spec.localizationSnapshotId ?? spec.contextSnapshotId,
      actorRole: spec.roleId,
      bodyJson: canonicalJson({
        kind: "physical-model-response",
        memoKey: identity.key.memoKey,
        responseHash: sha256(responseJson),
        outcomeKind: outcome.kind,
      }),
    },
  };
}
