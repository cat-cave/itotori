import type { CallResult } from "../contracts/index.js";
import { sha256 } from "./canonical-json.js";
import type { ReasoningDetailsContinuityEvidence } from "./reasoning-details-continuity.js";
import {
  MODEL_PROFILE_CERTIFICATE_VERSION,
  ModelProfileCertificateSchema,
  certificateEvidenceHash,
  servedModelIsCertified,
  type ModelProfileCertificate,
  type RoleModelProfile,
} from "./role-model-profiles.js";

export interface ConformanceStepObservation {
  readonly outcomeKind: "terminal" | "tool-calls" | "invalid" | "refusal" | "truncation";
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cachedTokens: number | null;
  readonly billingState: "confirmed" | "billing_unknown";
  readonly billedUsd: string | null;
}

export interface LiveConformanceObservations {
  readonly probedAt: string;
  readonly result: CallResult;
  readonly steps: readonly ConformanceStepObservation[];
  readonly toolExecutionCount: number;
  readonly reasoning: ReasoningDetailsContinuityEvidence;
  /** Lookup count bound to the terminal result, not prior tool-loop steps. */
  readonly generationLookupAttempts: number;
}

/** Build a certificate only after every live dimension has coherent evidence. */
export function certifyLiveModelProfile(
  profile: RoleModelProfile,
  observations: LiveConformanceObservations,
): ModelProfileCertificate {
  const { result, steps, reasoning } = observations;
  const terminal = steps.at(-1);
  if (terminal?.outcomeKind !== "terminal") {
    throw new Error("conformance probe did not produce a strict structured terminal outcome");
  }
  if (
    !steps.some((step) => step.outcomeKind === "tool-calls") ||
    observations.toolExecutionCount < 1 ||
    !result.events.some((event) => event.kind === "tool-step-finished")
  ) {
    throw new Error("conformance probe did not complete a typed tool round-trip");
  }
  // The transcript itself must carry the terminal model step, not only the
  // separately-supplied steps row (audit §5(4)).
  if (
    !result.events.some(
      (event) => event.kind === "model-step-finished" && event.finishReason === "stop",
    )
  ) {
    throw new Error("conformance probe did not record a terminal model step in the transcript");
  }
  if (
    reasoning.receivedBatchCount < 1 ||
    reasoning.forwardedBatchCount < 1 ||
    reasoning.receivedDetailCount < 1 ||
    reasoning.forwardedDetailCount < 1 ||
    reasoning.exactForwardCount !== reasoning.forwardedBatchCount
  ) {
    throw new Error("conformance probe did not preserve opaque reasoning details exactly");
  }
  // Positive provider usage on the steps AND on the reconciled result usage
  // (audit §5(2): zeroed result.usage must fail).
  if (
    !hasProviderUsage(steps) ||
    result.usage === null ||
    result.usage.promptTokens < 1 ||
    result.usage.completionTokens < 1
  ) {
    throw new Error("conformance probe did not capture provider usage");
  }
  const billedUsdByStep = steps.map((step) => step.billedUsd);
  // Positive cost per step AND on the reconciled result billing (audit §5(3):
  // a zero result.billing.costUsd must fail).
  if (
    steps.some((step) => step.billingState !== "confirmed") ||
    billedUsdByStep.some((amount) => amount === null || Number(amount) <= 0) ||
    result.billing.status !== "confirmed" ||
    Number(result.billing.costUsd) <= 0
  ) {
    throw new Error("conformance probe did not capture provider-reported cost");
  }
  const reconciliation = certifyGenerationReconciliation(profile, result, observations);
  const checks = {
    strictStructuredFinish: "passed",
    typedToolRoundTrip: "passed",
    reasoningDetailsContinuity: "passed",
    usageCapture: "passed",
    costCapture: "passed",
    ...reconciliation.checks,
  } as const;
  const boundObservations = {
    physicalStepCount: steps.length,
    toolExecutionCount: observations.toolExecutionCount,
    reasoningDetailBatchCount: reasoning.receivedBatchCount,
    forwardedReasoningDetailBatchCount: reasoning.forwardedBatchCount,
    usage: sumUsage(steps),
    billedUsdByStep,
    ...reconciliation.observations,
  } as const;
  // ITOTORI-241 - bind the certificate to THIS live run: memoKey is the request
  // identity and transcriptHash hashes the actual dispatch transcript. Both are
  // taken from the real result, never caller-supplied, so a certificate cannot
  // be minted or tampered by hand.
  const memoKey = result.memoKey;
  const transcriptHash = sha256(result.events);
  const evidenceHash = certificateEvidenceHash({
    probedAt: observations.probedAt,
    subject: profile,
    checks,
    observations: boundObservations,
    memoKey,
    transcriptHash,
  });

  return ModelProfileCertificateSchema.parse({
    schemaVersion: MODEL_PROFILE_CERTIFICATE_VERSION,
    certificateStatus: "valid",
    probeMode: "live",
    probedAt: observations.probedAt,
    subject: profile,
    checks,
    observations: {
      ...boundObservations,
      runBinding: { memoKey, transcriptHash, evidenceHash },
    },
  });
}

function certifyGenerationReconciliation(
  profile: RoleModelProfile,
  result: CallResult,
  observations: LiveConformanceObservations,
): {
  readonly checks:
    | { readonly generationLookup: "deferred"; readonly servedPairVerification: "deferred" }
    | { readonly generationLookup: "passed"; readonly servedPairVerification: "passed" };
  readonly observations:
    | {
        readonly generationLookupAttempts: 0;
        readonly generationId: null;
        readonly served: { readonly status: "unknown" };
      }
    | {
        readonly generationLookupAttempts: 1;
        readonly generationId: string;
        readonly served: {
          readonly status: "confirmed";
          readonly model: string;
          readonly provider: string;
        };
      };
} {
  if (result.status !== "success") {
    throw new Error("conformance probe did not complete successfully");
  }
  if (
    result.verification === "explicit-unknown" &&
    result.generationId === null &&
    result.served.status === "unknown" &&
    observations.generationLookupAttempts === 0
  ) {
    return {
      checks: { generationLookup: "deferred", servedPairVerification: "deferred" },
      observations: {
        generationLookupAttempts: 0,
        generationId: null,
        served: { status: "unknown" },
      },
    };
  }
  if (
    result.verification === "verified" &&
    result.generationId !== null &&
    result.served.status === "confirmed" &&
    observations.generationLookupAttempts === 1
  ) {
    if (!servedModelIsCertified(result.served.model, profile.model)) {
      throw new Error("generation lookup served a model outside the certified model family");
    }
    return {
      checks: { generationLookup: "passed", servedPairVerification: "passed" },
      observations: {
        generationLookupAttempts: 1,
        generationId: result.generationId,
        served: result.served,
      },
    };
  }
  throw new Error("generation reconciliation evidence is neither deferred nor verified");
}

function hasProviderUsage(steps: readonly ConformanceStepObservation[]): boolean {
  return (
    steps.length > 0 &&
    steps.every(
      (step) =>
        step.promptTokens !== null &&
        step.promptTokens > 0 &&
        step.completionTokens !== null &&
        step.completionTokens > 0 &&
        step.reasoningTokens !== null &&
        step.cachedTokens !== null,
    )
  );
}

function sumUsage(steps: readonly ConformanceStepObservation[]) {
  return steps.reduce(
    (usage, step) => ({
      promptTokens: usage.promptTokens + requiredTokenCount(step.promptTokens),
      completionTokens: usage.completionTokens + requiredTokenCount(step.completionTokens),
      reasoningTokens: usage.reasoningTokens + requiredTokenCount(step.reasoningTokens),
      cachedTokens: usage.cachedTokens + requiredTokenCount(step.cachedTokens),
    }),
    { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
  );
}

function requiredTokenCount(value: number | null): number {
  if (value === null) throw new Error("provider token count is absent");
  return value;
}
