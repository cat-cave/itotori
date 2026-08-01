import { AuthorizationError } from "./authorization-permissions-and-local-user.js";
import { ItotoriProjectRunCostCapError } from "./repositories/project-run-repository-internal.js";

/** Stable evidence-derived codes. Message prose is never classification input. */
export type ExplicitFailureCode =
  | "missing_required_input"
  | "provider_unavailable"
  | "unsupported_source_profile"
  | "malformed_owned_input"
  | "unknown_in_profile_operation"
  | "changed_source_revision"
  | "disallowed_disclosure"
  | "absent_effective_grant"
  | "declared_deadline_reached"
  | "authorized_cancellation"
  | "exact_cap_exhausted"
  | "unexpected_service_fault"
  | "required_asset_absent"
  | "protected_asset_cannot_decrypt"
  | "helper_identity_mismatch"
  | "helper_input_too_large"
  | "helper_deadline_reached"
  | "helper_cancelled"
  | "helper_not_approved"
  | "in_profile_defect";

export type ExplicitFailureDisposition = "failed" | "paused";

export interface ExplicitFailureClassification {
  readonly code: ExplicitFailureCode;
  readonly disposition: ExplicitFailureDisposition;
  readonly failureClass: string;
  readonly diagnosticOutcome: string;
  readonly nextAction: string;
  readonly httpStatus: number;
  readonly apiCode:
    | "bad_request"
    | "forbidden"
    | "not_found"
    | "workflow_failed"
    | "internal_error";
  readonly remainingAllowanceMicrosUsd: number | null;
}

type ClassificationWithoutCode = Omit<
  ExplicitFailureClassification,
  "code" | "remainingAllowanceMicrosUsd"
>;

const FAILED = "failed";
const WORKFLOW_FAILED = "workflow_failed";

const CLASSIFICATIONS: Readonly<Record<ExplicitFailureCode, ClassificationWithoutCode>> = {
  missing_required_input: {
    disposition: FAILED,
    failureClass: "missing input",
    diagnosticOutcome: "safe actionable remediation",
    nextAction: "provide-required-input",
    httpStatus: 400,
    apiCode: "bad_request",
  },
  provider_unavailable: {
    disposition: "paused",
    failureClass: "operational pause",
    diagnosticOutcome: "safe resumable next action",
    nextAction: "retry-provider-request",
    httpStatus: 503,
    apiCode: WORKFLOW_FAILED,
  },
  unsupported_source_profile: {
    disposition: FAILED,
    failureClass: "unsupported profile",
    diagnosticOutcome: "exact declared limitation",
    nextAction: "select-registered-profile",
    httpStatus: 422,
    apiCode: WORKFLOW_FAILED,
  },
  malformed_owned_input: {
    disposition: FAILED,
    failureClass: "invalid input",
    diagnosticOutcome: "exact invalid-input reason",
    nextAction: "repair-input-shape",
    httpStatus: 400,
    apiCode: "bad_request",
  },
  unknown_in_profile_operation: {
    disposition: FAILED,
    failureClass: "in-profile defect",
    diagnosticOutcome: "exact unsupported operation",
    nextAction: "repair-in-profile-operation",
    httpStatus: 422,
    apiCode: WORKFLOW_FAILED,
  },
  changed_source_revision: {
    disposition: FAILED,
    failureClass: "stale source",
    diagnosticOutcome: "exact source mismatch",
    nextAction: "regenerate-from-current-source",
    httpStatus: 409,
    apiCode: WORKFLOW_FAILED,
  },
  disallowed_disclosure: {
    disposition: FAILED,
    failureClass: "privacy denial",
    diagnosticOutcome: "safe policy reason",
    nextAction: "request-approved-disclosure",
    httpStatus: 403,
    apiCode: "forbidden",
  },
  absent_effective_grant: {
    disposition: FAILED,
    failureClass: "permission denial",
    diagnosticOutcome: "safe authority reason",
    nextAction: "request-required-grant",
    httpStatus: 403,
    apiCode: "forbidden",
  },
  declared_deadline_reached: {
    disposition: FAILED,
    failureClass: "timeout",
    diagnosticOutcome: "safe retry guidance",
    nextAction: "retry-provider-request",
    httpStatus: 504,
    apiCode: WORKFLOW_FAILED,
  },
  authorized_cancellation: {
    disposition: FAILED,
    failureClass: "cancellation",
    diagnosticOutcome: "durable cancelled state",
    nextAction: "inspect-cancelled-run",
    httpStatus: 409,
    apiCode: WORKFLOW_FAILED,
  },
  exact_cap_exhausted: {
    disposition: FAILED,
    failureClass: "budget refusal",
    diagnosticOutcome: "exact remaining allowance",
    nextAction: "increase-cap-or-reduce-scope",
    httpStatus: 429,
    apiCode: WORKFLOW_FAILED,
  },
  unexpected_service_fault: {
    disposition: FAILED,
    failureClass: "internal failure",
    diagnosticOutcome: "safe incident reference",
    nextAction: "report-incident-reference",
    httpStatus: 500,
    apiCode: "internal_error",
  },
  required_asset_absent: {
    disposition: FAILED,
    failureClass: "missing asset",
    diagnosticOutcome: "exact missing-asset result",
    nextAction: "restore-required-asset",
    httpStatus: 404,
    apiCode: "not_found",
  },
  protected_asset_cannot_decrypt: {
    disposition: FAILED,
    failureClass: "decryption failure",
    diagnosticOutcome: "exact protected-asset result",
    nextAction: "verify-protected-asset-key",
    httpStatus: 422,
    apiCode: WORKFLOW_FAILED,
  },
  helper_identity_mismatch: helper("verify-helper-identity"),
  helper_input_too_large: helper("reduce-helper-input"),
  helper_deadline_reached: helper("inspect-helper-deadline"),
  helper_cancelled: helper("retry-helper-after-cancellation"),
  helper_not_approved: helper("approve-helper-identity"),
  in_profile_defect: {
    disposition: FAILED,
    failureClass: "in-profile defect",
    diagnosticOutcome: "evidence-derived class and exact next action",
    nextAction: "repair-in-profile-operation",
    httpStatus: 422,
    apiCode: WORKFLOW_FAILED,
  },
};

function helper(nextAction: string): ClassificationWithoutCode {
  return {
    disposition: FAILED,
    failureClass: "exact preparation failure",
    diagnosticOutcome: "distinct stable safe diagnostic",
    nextAction,
    httpStatus: 422,
    apiCode: WORKFLOW_FAILED,
  };
}

/** Base for source-specific faults; only concrete domain constructors are public. */
export abstract class ExplicitFailureSourceError extends Error {
  protected constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

export class MissingRequiredInputError extends ExplicitFailureSourceError {
  constructor(readonly inputName: string) {
    super("MissingRequiredInputError", `required input is absent: ${inputName}`);
  }
}

export class ProviderUnavailableError extends ExplicitFailureSourceError {
  constructor(readonly status: number) {
    super("ProviderUnavailableError", `provider request returned ${status}`);
  }
}

export class UnsupportedSourceProfileError extends ExplicitFailureSourceError {
  constructor(readonly profileId: string) {
    super("UnsupportedSourceProfileError", `source profile is not registered: ${profileId}`);
  }
}

export class MalformedOwnedInputError extends ExplicitFailureSourceError {
  constructor() {
    super("MalformedOwnedInputError", "owned JSON input is malformed");
  }
}

export class InProfileOperationError extends ExplicitFailureSourceError {
  constructor(readonly operation: string) {
    super("InProfileOperationError", `operation is not supported in profile: ${operation}`);
  }
}

export class SourceRevisionChangedError extends ExplicitFailureSourceError {
  constructor() {
    super("SourceRevisionChangedError", "source revision changed before commitment");
  }
}

export class DisclosurePolicyError extends ExplicitFailureSourceError {
  constructor(readonly policy: string) {
    super("DisclosurePolicyError", `disclosure policy refused publication: ${policy}`);
  }
}

export class ProviderDeadlineError extends ExplicitFailureSourceError {
  constructor(readonly deadlineMs: number) {
    super("ProviderDeadlineError", `provider deadline reached after ${deadlineMs}ms`);
  }
}

export class AuthorizedCancellationError extends ExplicitFailureSourceError {
  constructor(readonly runId: string) {
    super("AuthorizedCancellationError", `run was cancelled: ${runId}`);
  }
}

export class RequiredAssetError extends ExplicitFailureSourceError {
  constructor(readonly assetId: string) {
    super("RequiredAssetError", `required runtime asset is absent: ${assetId}`);
  }
}

export class ProtectedAssetDecryptionError extends ExplicitFailureSourceError {
  constructor(readonly assetId: string) {
    super(
      "ProtectedAssetDecryptionError",
      `protected runtime asset cannot be decrypted: ${assetId}`,
    );
  }
}

export type HelperPreparationFailureKind =
  | "identity-mismatch"
  | "input-too-large"
  | "deadline-reached"
  | "cancelled"
  | "not-approved";

export class HelperPreparationError extends ExplicitFailureSourceError {
  constructor(readonly kind: HelperPreparationFailureKind) {
    super("HelperPreparationError", `source preparation helper refused: ${kind}`);
  }
}

export class InProfileDefectError extends ExplicitFailureSourceError {
  constructor(
    readonly nextAction: string,
    message = "in-profile operation defect",
  ) {
    super("InProfileDefectError", message);
  }
}

export function isExplicitFailureSourceError(error: unknown): error is ExplicitFailureSourceError {
  return error instanceof ExplicitFailureSourceError;
}

export function hasExplicitFailureEvidence(error: unknown): boolean {
  return (
    isExplicitFailureSourceError(error) ||
    error instanceof AuthorizationError ||
    error instanceof ItotoriProjectRunCostCapError
  );
}

/** Classify from typed evidence only; unknown faults fail closed as internal. */
export function classifyExplicitFailure(error: unknown): ExplicitFailureClassification {
  const code = evidenceCode(error);
  return {
    code,
    ...CLASSIFICATIONS[code],
    remainingAllowanceMicrosUsd:
      error instanceof ItotoriProjectRunCostCapError ? error.remainingMicrosUsd : null,
  };
}

export function explicitFailurePublicMessage(
  classification: ExplicitFailureClassification,
): string {
  const remaining =
    classification.remainingAllowanceMicrosUsd === null
      ? ""
      : `; remaining allowance ${classification.remainingAllowanceMicrosUsd} micros`;
  return `${classification.failureClass}: ${classification.diagnosticOutcome}${remaining}; next action ${classification.nextAction}`;
}

function evidenceCode(error: unknown): ExplicitFailureCode {
  if (error instanceof MissingRequiredInputError) return "missing_required_input";
  if (error instanceof ProviderUnavailableError) return "provider_unavailable";
  if (error instanceof UnsupportedSourceProfileError) return "unsupported_source_profile";
  if (error instanceof MalformedOwnedInputError) return "malformed_owned_input";
  if (error instanceof InProfileOperationError) return "unknown_in_profile_operation";
  if (error instanceof SourceRevisionChangedError) return "changed_source_revision";
  if (error instanceof DisclosurePolicyError) return "disallowed_disclosure";
  if (error instanceof AuthorizationError) return "absent_effective_grant";
  if (error instanceof ProviderDeadlineError) return "declared_deadline_reached";
  if (error instanceof AuthorizedCancellationError) return "authorized_cancellation";
  if (error instanceof ItotoriProjectRunCostCapError) return "exact_cap_exhausted";
  if (error instanceof RequiredAssetError) return "required_asset_absent";
  if (error instanceof ProtectedAssetDecryptionError) return "protected_asset_cannot_decrypt";
  if (error instanceof HelperPreparationError) return helperCode(error.kind);
  if (error instanceof InProfileDefectError) return "in_profile_defect";
  return "unexpected_service_fault";
}

function helperCode(kind: HelperPreparationFailureKind): ExplicitFailureCode {
  switch (kind) {
    case "identity-mismatch":
      return "helper_identity_mismatch";
    case "input-too-large":
      return "helper_input_too_large";
    case "deadline-reached":
      return "helper_deadline_reached";
    case "cancelled":
      return "helper_cancelled";
    case "not-approved":
      return "helper_not_approved";
  }
}
