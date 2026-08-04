export interface LlmSpendExposureReport {
  admissionScope: string;
  confirmedCostUsd: string;
  billingUnknownAttemptCount: number;
  boundedInFlightExposureUsd: string;
  inFlightAttemptCount: number;
  exhaustedRetryStepCount: number;
}

export type LlmSpendAdmissionDenyReason = "profile-cap" | "run-share" | "profile-cohort-busy";

export interface LlmSpendAdmissionDiagnostic {
  readonly reason: LlmSpendAdmissionDenyReason;
  readonly scope: string;
  readonly capUsd: string;
  readonly confirmedCostUsd: string;
  readonly reservedExposureUsd: string;
  readonly requestedExposureUsd: string;
}

export class LlmRetriesExhaustedError extends Error {
  constructor(
    readonly memoKey: string,
    readonly attemptCount = 3,
  ) {
    super(`physical model step exhausted ${attemptCount} attempts for ${memoKey}`);
    this.name = "LlmRetriesExhaustedError";
  }
}

export class LlmPhysicalStepFailedError extends Error {
  constructor(
    readonly memoKey: string,
    readonly failureClass: "permanent" | "in-flight",
    readonly attemptStatus: string,
    readonly httpStatus: number | null,
  ) {
    super(`physical model step ${failureClass} failure prevents dispatch for ${memoKey}`);
    this.name = "LlmPhysicalStepFailedError";
  }
}

export class LlmSpendAdmissionDeniedError extends Error {
  constructor(
    readonly diagnostic: LlmSpendAdmissionDiagnostic,
    readonly report: LlmSpendExposureReport,
  ) {
    super(
      `spend admission ${diagnostic.reason} denied for ${diagnostic.scope}: ` +
        `cap ${diagnostic.capUsd}, confirmed ${diagnostic.confirmedCostUsd}, ` +
        `reserved ${diagnostic.reservedExposureUsd}, request ${diagnostic.requestedExposureUsd}`,
    );
    this.name = "LlmSpendAdmissionDeniedError";
  }
}
