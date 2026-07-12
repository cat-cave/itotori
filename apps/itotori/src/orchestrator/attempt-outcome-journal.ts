// Durable physical-attempt capture at the provider-factory boundary.
//
// InvocationSupervisor owns dispatch and classification. This adapter keeps
// node 2's lossless journal projection, forwards the supervisor's pre-dispatch
// and completion lifecycle to durable storage, and retains an in-memory view
// used to build candidate provenance and stage telemetry.

import { randomUUID } from "node:crypto";
import type {
  AgenticLoopAttemptOutcomeObserver,
  AgenticLoopProviderFactory,
} from "./agentic-loop.js";
import {
  InvocationSupervisor,
  supervisedModelProvider,
  type InvocationAttemptCompleted,
  type InvocationCostAdmission,
  type InvocationLifecycle,
  type InvocationRetryPolicy,
} from "./invocation-supervisor.js";
import { providerRunFromThrownError, type ProviderRunRecord } from "../providers/types.js";

export type DrivenAttemptValidationResult =
  | "accepted"
  | "schema_invalid"
  | "semantic_invalid"
  | "provider_failed"
  | "not_evaluated";

export type DrivenAttemptRetryDecision = "retry" | "advance" | "write" | "pause";

/** One physical provider dispatch, including interrupted attempts with unknown billing facts. */
export type DrivenLlmAttemptRecord = {
  attemptId: string;
  runId: string;
  bridgeUnitId: string;
  stage: string;
  agentLabel: string;
  logicalCallId: string;
  attemptIndex: number;
  requestedModelId: string;
  requestedProviderId: string;
  modelId: string | null;
  providerId: string | null;
  providerRunId: string;
  costUsd: string | null;
  costKind: "billed" | "provider_estimate" | "zero" | null;
  usageResponseJson: Record<string, unknown> | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokenCountSource: string | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheDiscountMicrosUsd: number | null;
  fallbackUsed: boolean | null;
  fallbackPlan: string[] | null;
  zdr: boolean;
  finishState: string | null;
  refusalState: string | null;
  validationResult: DrivenAttemptValidationResult;
  failureClass: string | null;
  retryDecision: DrivenAttemptRetryDecision | null;
  retryDelayMs: number | null;
  artifactRef: string | null;
  errorClasses: string[];
  startedAt: string;
  completedAt: string | null;
};

export type CapturedProviderAttempts = {
  providerFactory: AgenticLoopProviderFactory;
  attemptOutcomeObserver: AgenticLoopAttemptOutcomeObserver;
  attempts: readonly DrivenLlmAttemptRecord[];
  markSuccessful(): void;
  markFailed(error: unknown): void;
};

type AttemptFailureAnnotation = {
  stage: string;
  agentLabel: string;
  error: unknown;
  retryDecision: "advance" | "pause";
};

/**
 * A factory construction is one logical call. Every physical retry beneath it
 * receives a stable logicalCallId and increasing attempt index. Durable hooks
 * run synchronously around dispatch, so completed units are no longer the
 * first persistence boundary.
 */
export function capturePhysicalProviderAttempts(args: {
  runId: string;
  bridgeUnitId: string;
  source: AgenticLoopProviderFactory;
  lifecycle?: InvocationLifecycle;
  costAdmission?: InvocationCostAdmission;
  retryPolicy?: Partial<InvocationRetryPolicy>;
}): CapturedProviderAttempts {
  const attempts: DrivenLlmAttemptRecord[] = [];
  const failureAnnotations: AttemptFailureAnnotation[] = [];
  let logicalCallSequence = 0;

  const providerFactory: AgenticLoopProviderFactory = (factoryInput) => {
    logicalCallSequence += 1;
    const logicalCallId = [
      args.runId,
      args.bridgeUnitId,
      factoryInput.stage,
      factoryInput.agentLabel,
      String(logicalCallSequence),
      randomUUID(),
    ].join(":");
    const lifecycle: InvocationLifecycle = {
      attemptStarted: async (attempt) => {
        return await args.lifecycle?.attemptStarted(attempt);
      },
      attemptCompleted: async (attempt) => {
        const record = recordFromCompletedAttempt(attempt);
        const existingIndex = attempts.findIndex(
          (candidate) => candidate.attemptId === record.attemptId,
        );
        if (existingIndex >= 0) attempts[existingIndex] = record;
        else attempts.push(record);
        await args.lifecycle?.attemptCompleted(attempt);
      },
      pauseRun: async (runId, blocker) => {
        await args.lifecycle?.pauseRun(runId, blocker);
      },
    };
    const supervisor = new InvocationSupervisor({
      provider: args.source(factoryInput),
      context: {
        runId: args.runId,
        bridgeUnitId: args.bridgeUnitId,
        stage: factoryInput.stage,
        agentLabel: factoryInput.agentLabel,
        logicalCallId,
        modelId: factoryInput.pair.pair.modelId,
        providerId: factoryInput.pair.pair.providerId,
        fallbackModels: factoryInput.pair.fallbackModels,
        maximumCostUsd: factoryInput.pair.maxPriceUsd,
        ...(factoryInput.pair.maximumBillableCostUsd !== undefined
          ? { maximumBillableCostUsd: factoryInput.pair.maximumBillableCostUsd }
          : {}),
        zdr: factoryInput.pair.zdr,
      },
      lifecycle,
      ...(args.costAdmission !== undefined ? { costAdmission: args.costAdmission } : {}),
      ...(args.retryPolicy !== undefined ? { retryPolicy: args.retryPolicy } : {}),
    });
    return supervisedModelProvider(supervisor);
  };

  return {
    providerFactory,
    attempts,
    attemptOutcomeObserver: {
      markFailedAttempt: (annotation) => failureAnnotations.push(annotation),
    },
    markSuccessful: () => applyFailureAnnotations(attempts, failureAnnotations),
    markFailed: (error) => {
      applyFailureAnnotations(attempts, failureAnnotations);
      applyTerminalFailure(attempts, error);
    },
  };
}

function recordFromCompletedAttempt(attempt: InvocationAttemptCompleted): DrivenLlmAttemptRecord {
  const run = attempt.providerRun;
  const usage = run?.tokenUsage;
  return {
    attemptId: attempt.attemptId,
    runId: attempt.runId,
    bridgeUnitId: attempt.bridgeUnitId,
    stage: attempt.stage,
    agentLabel: attempt.agentLabel,
    logicalCallId: attempt.logicalCallId,
    attemptIndex: attempt.attemptIndex,
    requestedModelId: attempt.requestedModelId,
    requestedProviderId: attempt.requestedProviderId,
    modelId: run?.provider.actualModelId ?? null,
    providerId:
      run === undefined
        ? null
        : (run.provider.upstreamProvider ?? run.provider.requestedProviderId),
    providerRunId: attempt.providerRunId,
    costUsd: run?.cost.amountUsd ?? null,
    costKind: run?.cost.costKind ?? null,
    usageResponseJson: run?.usageResponseJson ?? null,
    tokensIn: usage?.promptTokens ?? null,
    tokensOut: usage?.completionTokens ?? null,
    tokenCountSource: usage?.tokenCountSource ?? null,
    cacheReadTokens: usage?.cacheReadTokens ?? null,
    cacheWriteTokens: usage?.cacheWriteTokens ?? null,
    cacheDiscountMicrosUsd: run?.cost.cacheDiscountMicrosUsd ?? null,
    fallbackUsed: run?.fallbackUsed ?? null,
    fallbackPlan: run === undefined ? null : run.fallbackPlan.slice(),
    zdr: run?.routingPosture.zdr ?? attempt.zdr,
    finishState: attempt.finishState,
    refusalState: attempt.refusalState,
    validationResult: attempt.validationResult,
    failureClass: attempt.failureClass,
    retryDecision: attempt.retryDecision,
    retryDelayMs: attempt.retryDelayMs,
    artifactRef: attempt.artifactRef,
    errorClasses: run?.errorClasses.slice() ?? [],
    startedAt: run?.startedAt ?? attempt.startedAt,
    completedAt: run?.completedAt ?? attempt.completedAt,
  };
}

function applyFailureAnnotations(
  attempts: DrivenLlmAttemptRecord[],
  annotations: readonly AttemptFailureAnnotation[],
): void {
  for (const annotation of annotations) {
    const attempt = findAnnotatedAttempt(attempts, annotation);
    if (attempt === undefined) continue;
    if (attempt.validationResult !== "provider_failed") {
      attempt.validationResult = "semantic_invalid";
      attempt.failureClass = errorClassOf(annotation.error);
    }
    attempt.retryDecision = annotation.retryDecision;
  }
}

function applyTerminalFailure(attempts: DrivenLlmAttemptRecord[], error: unknown): void {
  const providerRunId = providerRunIdOf(error);
  if (providerRunId === undefined) return;
  const attempt = attempts.find((candidate) => candidate.providerRunId === providerRunId);
  if (attempt === undefined || attempt.validationResult === "provider_failed") return;
  attempt.validationResult = "semantic_invalid";
  attempt.failureClass = errorClassOf(error);
  attempt.retryDecision = "pause";
}

function findAnnotatedAttempt(
  attempts: readonly DrivenLlmAttemptRecord[],
  annotation: AttemptFailureAnnotation,
): DrivenLlmAttemptRecord | undefined {
  const providerRunId = providerRunIdOf(annotation.error);
  if (providerRunId !== undefined) {
    return attempts.find((attempt) => attempt.providerRunId === providerRunId);
  }
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index]!;
    if (attempt.stage === annotation.stage && attempt.agentLabel === annotation.agentLabel) {
      return attempt;
    }
  }
  return undefined;
}

function errorClassOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  if (error instanceof Error && error.name.length > 0) return error.name;
  return "unknown_error";
}

function providerRunIdOf(error: unknown): string | undefined {
  const providerRun = providerRunFromThrownError(error);
  if (providerRun !== undefined) return providerRun.runId;
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { providerRunId?: unknown }).providerRunId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Compatibility utility retained for telemetry adapters that hold a run directly. */
export function completedAttemptProviderRun(
  attempt: InvocationAttemptCompleted,
): ProviderRunRecord | undefined {
  return attempt.providerRun;
}
