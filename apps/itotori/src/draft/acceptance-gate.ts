// ITOTORI-076 — Draft acceptance gate.
//
// Runs between the TranslationAgent (ITOTORI-075) and the draft job
// repository (ITOTORI-074). Per draft job attempt:
//
//   1. Validate EACH draft's protected spans via
//      `DraftProtectedSpanValidator`. The validator accumulates
//      violations across spans rather than throwing on the first.
//   2. If all drafts validate → call
//      `markAttemptSucceeded(...)` and return `{ accepted: true }`.
//   3. Otherwise → classify via `RetryPolicy`, call
//      `markAttemptFailed(..., retryable, ...)`, and return the
//      rejection details (so the orchestrator can decide whether to
//      enqueue another attempt).
//
// The gate does NOT itself decide whether to retry — that's the
// orchestrator's job. It only:
//   - records the terminal/retryable status on this attempt;
//   - hands the caller a typed `RetryClassification` it can route on.
//
// The gate also handles non-protected-span failures (schema validation,
// provider partial / capability / timeout / rate-limit) via the SAME
// classifier — the helper is `routeFailedAttempt(...)`.

import type { AuthorizationActor, ItotoriDraftJobRepositoryPort } from "@itotori/db";
import type { TranslationDraft } from "@itotori/localization-bridge-schema";
import type { TranslationBridgeUnit } from "../agents/translation/shapes.js";
import {
  DraftProtectedSpanValidator,
  type DraftProtectedSpanViolation,
  type DraftSourceProtectedSpan,
} from "./protected-span-validator.js";
import { RetryPolicy, type DraftFailure, type RetryClassification } from "./retry-policy.js";

export type AcceptDraftArgs = {
  drafts: ReadonlyArray<TranslationDraft>;
  sourceBridgeUnits: ReadonlyArray<TranslationBridgeUnit>;
  sourceProtectedSpansBySource: ReadonlyMap<string, ReadonlyArray<DraftSourceProtectedSpan>>;
  validator: DraftProtectedSpanValidator;
  retryPolicy: RetryPolicy;
  repository: ItotoriDraftJobRepositoryPort;
  draftJobAttemptId: string;
  attemptIndexCurrent: number;
  actor: AuthorizationActor;
  endedAt: Date;
  providerRunId?: string;
  recordedProviderArtifactId?: string;
};

export type AcceptDraftResult =
  | { accepted: true }
  | {
      accepted: false;
      classification: RetryClassification;
      violations: ReadonlyArray<DraftProtectedSpanViolation>;
    };

/**
 * Run the acceptance gate over a batch of drafts. Calls
 * `markAttemptSucceeded` xor `markAttemptFailed` exactly once.
 *
 * The caller is responsible for ensuring `draftJobAttemptId`
 * corresponds to a running attempt — the repository will throw
 * `DraftJobRepositoryError` otherwise.
 */
export async function acceptOrRejectDraft(args: AcceptDraftArgs): Promise<AcceptDraftResult> {
  const bridgeUnitById = new Map<string, TranslationBridgeUnit>();
  for (const unit of args.sourceBridgeUnits) {
    bridgeUnitById.set(unit.bridgeUnitId, unit);
  }

  const violations: DraftProtectedSpanViolation[] = [];
  for (const draft of args.drafts) {
    const bridgeUnit = bridgeUnitById.get(draft.bridgeUnitId);
    if (bridgeUnit === undefined) {
      // The translation agent already rejects unknown bridgeUnitIds
      // before this gate runs; if we somehow see one here, surface a
      // typed violation rather than silently dropping the draft.
      violations.push({
        kind: "span_deleted",
        spanRefId: "(unknown-bridge-unit)",
        spanKind: "source_unit",
        bridgeUnitId: draft.bridgeUnitId,
        detail: `draft cites bridge unit '${draft.bridgeUnitId}' not present in sourceBridgeUnits`,
        evidence: { observedRanges: [] },
      });
      continue;
    }
    const sourceSpans = args.sourceProtectedSpansBySource.get(draft.bridgeUnitId) ?? [];
    const result = args.validator.validate({
      sourceBridgeUnit: bridgeUnit,
      draftText: draft.draftText,
      draftProtectedSpanRefs: draft.protectedSpanRefs,
      sourceProtectedSpans: sourceSpans,
    });
    if (!result.accepted) {
      violations.push(...result.violations);
    }
  }

  if (violations.length === 0) {
    await args.repository.markAttemptSucceeded(
      args.actor,
      args.draftJobAttemptId,
      args.endedAt,
      args.providerRunId,
      args.recordedProviderArtifactId,
    );
    return { accepted: true };
  }

  const failure: DraftFailure = {
    kind: "protected_span",
    violations,
    attemptIndexCurrent: args.attemptIndexCurrent,
  };
  const classification = args.retryPolicy.classify(failure);
  await args.repository.markAttemptFailed(
    args.actor,
    args.draftJobAttemptId,
    summarizeViolations(violations),
    classification.retryable,
    args.endedAt,
  );
  return { accepted: false, classification, violations };
}

/**
 * Route a non-protected-span draft failure (schema validation, provider
 * partial / capability / timeout / rate-limit) through the same retry
 * classifier + repository write the protected-span path uses.
 *
 * Returned to the caller as the classification so the orchestrator can
 * decide whether to enqueue another attempt.
 */
export async function routeFailedAttempt(args: {
  failure: DraftFailure;
  retryPolicy: RetryPolicy;
  repository: ItotoriDraftJobRepositoryPort;
  draftJobAttemptId: string;
  actor: AuthorizationActor;
  endedAt: Date;
}): Promise<RetryClassification> {
  const classification = args.retryPolicy.classify(args.failure);
  const failureReason = formatFailureReason(args.failure);
  await args.repository.markAttemptFailed(
    args.actor,
    args.draftJobAttemptId,
    failureReason,
    classification.retryable,
    args.endedAt,
  );
  return classification;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeViolations(violations: ReadonlyArray<DraftProtectedSpanViolation>): string {
  const parts = violations.map((v) => `${v.kind}@${v.bridgeUnitId}:${v.spanRefId}(${v.spanKind})`);
  return `protected_span violations: ${parts.join(", ")}`;
}

function formatFailureReason(failure: DraftFailure): string {
  switch (failure.kind) {
    case "schema_validation":
      return `schema_validation: path='${failure.error.path}' rule='${failure.error.rule}': ${failure.error.detail}`;
    case "protected_span":
      return summarizeViolations(failure.violations);
    case "provider_partial":
      return `provider_partial: finishReason='${failure.error.finishReason}': ${failure.error.detail}`;
    case "provider_capability":
      return `provider_capability: provider='${failure.error.providerName}' family='${failure.error.providerFamily}': ${failure.error.detail}`;
    case "provider_timeout":
      return `provider_timeout after ${failure.durationMs}ms (attemptIndex=${failure.attemptIndexCurrent})`;
    case "provider_rate_limit": {
      const tail =
        failure.retryAfterMs !== undefined ? ` retryAfterMs=${failure.retryAfterMs}` : "";
      return `provider_rate_limit at attemptIndex=${failure.attemptIndexCurrent}${tail}`;
    }
    default:
      return assertNever(failure);
  }
}

function assertNever(value: never): never {
  throw new Error(`exhaustiveness check failed: unexpected value ${String(value)}`);
}
