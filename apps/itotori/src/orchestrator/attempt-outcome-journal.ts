// p0-core-attempt-and-outcome-journal -- physical provider-call capture.
//
// The agentic-loop bundle intentionally retains its stage-level telemetry for
// human-readable summaries. That telemetry may aggregate a bounded structured
// retry, though, so it is not a durable execution journal. This small wrapper
// sits at the provider-factory boundary, where every physical `invoke()` is
// still observable, and emits one record per actual provider run.

import type {
  AgenticLoopAttemptOutcomeObserver,
  AgenticLoopProviderFactory,
  PairChoice,
} from "./agentic-loop.js";
import type { AgenticLoopStageName } from "@itotori/localization-bridge-schema";
import {
  ModelProviderError,
  providerRunFromThrownError,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ModelProvider,
  type ProviderRunRecord,
} from "../providers/types.js";

export type DrivenAttemptValidationResult =
  | "accepted"
  | "schema_invalid"
  | "semantic_invalid"
  | "provider_failed"
  | "not_evaluated";

export type DrivenAttemptRetryDecision = "retry" | "advance" | "write" | "pause";

/**
 * One physical provider dispatch. Decimal costs remain strings all the way to
 * Postgres; no float or micros conversion is permitted at this boundary.
 */
export type DrivenLlmAttemptRecord = {
  attemptId: string;
  runId: string;
  bridgeUnitId: string;
  stage: AgenticLoopStageName;
  agentLabel: string;
  logicalCallId: string;
  attemptIndex: number;
  /** Pair requested by the stage policy, retained separately from the serve. */
  requestedModelId: string;
  requestedProviderId: string;
  modelId: string;
  providerId: string;
  providerRunId: string;
  costUsd: string;
  costKind: "billed" | "provider_estimate" | "zero";
  usageResponseJson: Record<string, unknown>;
  tokensIn: number | null;
  tokensOut: number | null;
  tokenCountSource: string;
  /** Null means the provider supplied no cache annotation; it is not zero. */
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheDiscountMicrosUsd: number | null;
  fallbackUsed: boolean;
  fallbackPlan: string[];
  zdr: boolean;
  finishState: string | null;
  refusalState: string | null;
  validationResult: DrivenAttemptValidationResult;
  failureClass: string | null;
  retryDecision: DrivenAttemptRetryDecision | null;
  /** The current retry façade has no observed delay; do not invent one. */
  retryDelayMs: number | null;
  artifactRef: string | null;
  errorClasses: string[];
  startedAt: string;
  completedAt: string;
};

export type CapturedProviderAttempts = {
  providerFactory: AgenticLoopProviderFactory;
  /** Receives semantic parser/partial outcomes from the agentic loop. */
  attemptOutcomeObserver: AgenticLoopAttemptOutcomeObserver;
  attempts: readonly DrivenLlmAttemptRecord[];
  /** Finalizes successful logical calls after loop-side semantic annotations. */
  markSuccessful(): void;
  /** Finalizes a failed unit without reclassifying earlier successful calls. */
  markFailed(error: unknown): void;
};

type AttemptFailureAnnotation = {
  stage: AgenticLoopStageName;
  agentLabel: string;
  error: unknown;
  retryDecision: "advance" | "pause";
};

/**
 * Decorate the loop's provider factory so every physical invocation is
 * captured without changing retry behavior. A single factory construction is a
 * logical call; a structured-output retry therefore receives increasing
 * `attemptIndex` values under the same `logicalCallId`.
 */
export function capturePhysicalProviderAttempts(args: {
  runId: string;
  bridgeUnitId: string;
  source: AgenticLoopProviderFactory;
}): CapturedProviderAttempts {
  const attempts: DrivenLlmAttemptRecord[] = [];
  const failureAnnotations: AttemptFailureAnnotation[] = [];
  let logicalCallSequence = 0;

  const providerFactory: AgenticLoopProviderFactory = (factoryInput) => {
    const inner = args.source(factoryInput);
    logicalCallSequence += 1;
    const logicalCallId = [
      args.runId,
      args.bridgeUnitId,
      factoryInput.stage,
      factoryInput.agentLabel,
      String(logicalCallSequence),
    ].join(":");
    let attemptIndex = 0;

    return new CapturingModelProvider({
      inner,
      runId: args.runId,
      bridgeUnitId: args.bridgeUnitId,
      stage: factoryInput.stage,
      agentLabel: factoryInput.agentLabel,
      pair: factoryInput.pair,
      logicalCallId,
      nextAttemptIndex: () => {
        attemptIndex += 1;
        return attemptIndex;
      },
      sink: attempts,
    });
  };

  return {
    providerFactory,
    attempts,
    attemptOutcomeObserver: {
      markFailedAttempt: (annotation) => {
        failureAnnotations.push(annotation);
      },
    },
    markSuccessful: () => {
      finalizeAttemptValidation(attempts);
      applyFailureAnnotations(attempts, failureAnnotations);
    },
    markFailed: (error) => {
      finalizeAttemptValidation(attempts);
      applyFailureAnnotations(attempts, failureAnnotations);
      applyTerminalFailure(attempts, error);
    },
  };
}

class CapturingModelProvider implements ModelProvider {
  readonly descriptor;

  constructor(
    private readonly args: {
      inner: ModelProvider;
      runId: string;
      bridgeUnitId: string;
      stage: AgenticLoopStageName;
      agentLabel: string;
      pair: PairChoice;
      logicalCallId: string;
      nextAttemptIndex: () => number;
      sink: DrivenLlmAttemptRecord[];
    },
  ) {
    this.descriptor = args.inner.descriptor;
  }

  async invoke(request: ModelInvocationRequest): Promise<ModelInvocationResult> {
    const attemptIndex = this.args.nextAttemptIndex();
    try {
      const result = await this.args.inner.invoke(request);
      this.args.sink.push(
        recordFromProviderRun({
          runId: this.args.runId,
          bridgeUnitId: this.args.bridgeUnitId,
          stage: this.args.stage,
          agentLabel: this.args.agentLabel,
          pair: this.args.pair,
          logicalCallId: this.args.logicalCallId,
          attemptIndex,
          providerRun: result.providerRun,
          finishState: result.finishReason,
          failureClass: null,
        }),
      );
      return result;
    } catch (error) {
      const providerRun = providerRunFromThrownError(error);
      if (providerRun !== undefined) {
        this.args.sink.push(
          recordFromProviderRun({
            runId: this.args.runId,
            bridgeUnitId: this.args.bridgeUnitId,
            stage: this.args.stage,
            agentLabel: this.args.agentLabel,
            pair: this.args.pair,
            logicalCallId: this.args.logicalCallId,
            attemptIndex,
            providerRun,
            // A raw artifact/filesystem error can arrive after OpenRouter has
            // completed the physical call. Preserve that distinction instead
            // of claiming the remote provider produced this failure.
            finishState: error instanceof ModelProviderError ? "provider_error" : "post_call_error",
            failureClass: errorClassOf(error),
          }),
        );
      }
      throw error;
    }
  }
}

function recordFromProviderRun(args: {
  runId: string;
  bridgeUnitId: string;
  stage: AgenticLoopStageName;
  agentLabel: string;
  pair: PairChoice;
  logicalCallId: string;
  attemptIndex: number;
  providerRun: ProviderRunRecord;
  finishState: string;
  failureClass: string | null;
}): DrivenLlmAttemptRecord {
  const usage = args.providerRun.tokenUsage;
  const providerId =
    args.providerRun.provider.upstreamProvider ?? args.providerRun.provider.requestedProviderId;
  return {
    // Provider run ids are physical-call identities and candidate.attemptId
    // already points at the successful one, so use the same durable key.
    attemptId: args.providerRun.runId,
    runId: args.runId,
    bridgeUnitId: args.bridgeUnitId,
    stage: args.stage,
    agentLabel: args.agentLabel,
    logicalCallId: args.logicalCallId,
    attemptIndex: args.attemptIndex,
    requestedModelId: args.providerRun.provider.requestedModelId,
    requestedProviderId: args.providerRun.provider.requestedProviderId,
    modelId: args.providerRun.provider.actualModelId,
    providerId,
    providerRunId: args.providerRun.runId,
    costUsd: args.providerRun.cost.amountUsd,
    costKind: args.providerRun.cost.costKind,
    usageResponseJson: args.providerRun.usageResponseJson,
    tokensIn: usage.promptTokens ?? null,
    tokensOut: usage.completionTokens ?? null,
    tokenCountSource: usage.tokenCountSource,
    cacheReadTokens: usage.cacheReadTokens ?? null,
    cacheWriteTokens: usage.cacheWriteTokens ?? null,
    cacheDiscountMicrosUsd: args.providerRun.cost.cacheDiscountMicrosUsd ?? null,
    fallbackUsed: args.providerRun.fallbackUsed,
    fallbackPlan: args.providerRun.fallbackPlan.slice(),
    zdr: args.providerRun.routingPosture.zdr,
    finishState: args.finishState,
    refusalState: isRefusal(args.finishState) ? args.finishState : null,
    validationResult: args.failureClass === null ? "not_evaluated" : "provider_failed",
    failureClass: args.failureClass,
    retryDecision: null,
    retryDelayMs: null,
    // The live recorder is keyed by provider run id. Keep a stable opaque ref
    // even when a caller uses a fake/recorded provider instead of local files.
    artifactRef: `provider-run:${args.providerRun.runId}`,
    errorClasses: args.providerRun.errorClasses.slice(),
    startedAt: args.providerRun.startedAt,
    completedAt: args.providerRun.completedAt,
  };
}

function finalizeAttemptValidation(attempts: DrivenLlmAttemptRecord[]): void {
  const byLogicalCall = new Map<string, DrivenLlmAttemptRecord[]>();
  for (const attempt of attempts) {
    const group = byLogicalCall.get(attempt.logicalCallId) ?? [];
    group.push(attempt);
    byLogicalCall.set(attempt.logicalCallId, group);
  }

  for (const group of byLogicalCall.values()) {
    group.sort((left, right) => left.attemptIndex - right.attemptIndex);
    const lastIndex = group.length - 1;
    for (const [index, attempt] of group.entries()) {
      if (attempt.validationResult === "provider_failed") {
        attempt.retryDecision = index < lastIndex ? "retry" : "pause";
        continue;
      }
      if (index < lastIndex) {
        // The only current in-agent retry is bounded structured-output repair,
        // so an earlier completed call is known to have failed schema
        // validation. Node 3 will own broader retry classification.
        attempt.validationResult = "schema_invalid";
        attempt.failureClass = "schema_validation";
        attempt.retryDecision = "retry";
        continue;
      }
      attempt.validationResult = "accepted";
      attempt.retryDecision = isWriteStage(attempt.stage) ? "write" : "advance";
    }
  }
}

function applyFailureAnnotations(
  attempts: DrivenLlmAttemptRecord[],
  annotations: readonly AttemptFailureAnnotation[],
): void {
  for (const annotation of annotations) {
    const attempt = findAnnotatedAttempt(attempts, annotation);
    if (attempt === undefined) {
      continue;
    }
    if (attempt.validationResult === "provider_failed") {
      // Preserve the provider's exact failure class while retaining the loop's
      // actual advancement decision (for example, a dropped enrichment).
      attempt.retryDecision = annotation.retryDecision;
      continue;
    }
    attempt.validationResult = "semantic_invalid";
    attempt.failureClass = errorClassOf(annotation.error);
    attempt.retryDecision = annotation.retryDecision;
  }
}

function applyTerminalFailure(attempts: DrivenLlmAttemptRecord[], error: unknown): void {
  const providerRunId = providerRunIdOf(error);
  if (providerRunId === undefined) {
    // The executor may fail after a complete loop (for example while projecting
    // an outcome). Without a provider-run identity, changing any physical row
    // would be a fabrication; retain the loop-observed classifications above.
    return;
  }
  const attempt = attempts.find((candidate) => candidate.providerRunId === providerRunId);
  if (attempt === undefined || attempt.validationResult === "provider_failed") {
    return;
  }
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
  // Loop-side annotations are emitted immediately around one known stage/agent
  // invocation. Resolve the latest physical call for that logical leaf, not
  // every historical call with the same label.
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index]!;
    if (attempt.stage === annotation.stage && attempt.agentLabel === annotation.agentLabel) {
      return attempt;
    }
  }
  return undefined;
}

function isWriteStage(stage: AgenticLoopStageName): boolean {
  return stage === "translation" || stage === "repair";
}

function isRefusal(finishState: string): boolean {
  return /refusal|content[_-]?filter|safety/iu.test(finishState);
}

function errorClassOf(error: unknown): string {
  if (error instanceof ModelProviderError) {
    return error.code;
  }
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  return "unknown_error";
}

function providerRunIdOf(error: unknown): string | undefined {
  const providerRun = providerRunFromThrownError(error);
  if (providerRun !== undefined) {
    return providerRun.runId;
  }
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const value = (error as { providerRunId?: unknown }).providerRunId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
