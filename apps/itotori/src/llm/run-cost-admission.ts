import type { LlmStepAttemptContext, LlmStepExecution } from "@itotori/db";

import type { PhysicalAttemptCostObserver } from "./physical-attempt-policy.js";

/** Turn a pre-provider run-cost rejection into a terminal durable attempt. */
export async function startRunCostAdmission(input: {
  readonly observer: PhysicalAttemptCostObserver | undefined;
  readonly memoKey: string;
  readonly attempt: LlmStepAttemptContext;
  readonly maxAttemptExposureUsd: string;
}): Promise<{ readonly error: unknown; readonly execution: LlmStepExecution } | undefined> {
  try {
    await input.observer?.onAttemptStarted({
      memoKey: input.memoKey,
      attempt: input.attempt,
      maxAttemptExposureUsd: input.maxAttemptExposureUsd,
    });
    return undefined;
  } catch (error: unknown) {
    return {
      error,
      execution: {
        kind: "incomplete",
        responseJson: null,
        attemptStatus: "transport-error",
        httpStatus: null,
        generationId: null,
        served: { status: "unknown" },
        routerAttempts: [],
        usage: null,
        billing: { status: "billing_unknown" },
        reportedCostUsd: null,
        failure: {
          classification: "permanent",
          kind: "transport",
          httpStatus: null,
          retryAfterMs: null,
        },
        completedAt: new Date().toISOString(),
      },
    };
  }
}
