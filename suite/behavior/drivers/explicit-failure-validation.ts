import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validateFailureState } from "./explicit-failure-state-validation.js";

interface FailureIdentity {
  readonly operation: string;
  readonly failureCase: string;
  readonly entrypoint: string;
}

export interface BoundaryExpectation extends FailureIdentity {
  readonly probe: string;
  readonly disposition: "failed" | "paused";
  readonly failureClass: string;
  readonly diagnostic: string;
  readonly sourceCode: string;
  readonly nextAction: string;
  readonly httpStatus: number;
  readonly apiCode: string;
}

export interface FactValidation {
  readonly observedFields: number;
  readonly boundaryProofCount: number;
}

function expectation(
  operation: string,
  failureCase: string,
  entrypoint: string,
  probe: string,
  disposition: "failed" | "paused",
  failureClass: string,
  diagnostic: string,
  sourceCode: string,
  nextAction: string,
  httpStatus: number,
  apiCode: string,
): BoundaryExpectation {
  return {
    operation,
    failureCase,
    entrypoint,
    probe,
    disposition,
    failureClass,
    diagnostic,
    sourceCode,
    nextAction,
    httpStatus,
    apiCode,
  };
}

const EXPECTATIONS: readonly BoundaryExpectation[] = [
  expectation(
    "standard extraction",
    "missing required input",
    "command boundary",
    "missing-input",
    "failed",
    "missing input",
    "safe actionable remediation",
    "missing_required_input",
    "provide-required-input",
    400,
    "bad_request",
  ),
  expectation(
    "start localization",
    "unavailable provider",
    "HTTP boundary",
    "provider-unavailable",
    "paused",
    "operational pause",
    "safe resumable next action",
    "provider_unavailable",
    "retry-provider-request",
    503,
    "workflow_failed",
  ),
  expectation(
    "patch production",
    "unsupported source profile",
    "rendered interface",
    "unsupported-profile",
    "failed",
    "unsupported profile",
    "exact declared limitation",
    "unsupported_source_profile",
    "select-registered-profile",
    422,
    "workflow_failed",
  ),
  expectation(
    "standard extraction",
    "malformed owned input",
    "command boundary",
    "malformed-input",
    "failed",
    "invalid input",
    "exact invalid-input reason",
    "malformed_owned_input",
    "repair-input-shape",
    400,
    "bad_request",
  ),
  expectation(
    "patched playback",
    "unknown in-profile operation",
    "runtime boundary",
    "unsupported-operation",
    "failed",
    "in-profile defect",
    "exact unsupported operation",
    "unknown_in_profile_operation",
    "repair-in-profile-operation",
    422,
    "workflow_failed",
  ),
  expectation(
    "patch production",
    "changed source revision",
    "command boundary",
    "stale-source",
    "failed",
    "stale source",
    "exact source mismatch",
    "changed_source_revision",
    "regenerate-from-current-source",
    409,
    "workflow_failed",
  ),
  expectation(
    "publish evidence",
    "disallowed disclosure",
    "HTTP boundary",
    "privacy-denial",
    "failed",
    "privacy denial",
    "safe policy reason",
    "disallowed_disclosure",
    "request-approved-disclosure",
    403,
    "forbidden",
  ),
  expectation(
    "administer account",
    "absent effective grant",
    "HTTP boundary",
    "permission-denial",
    "failed",
    "permission denial",
    "safe authority reason",
    "absent_effective_grant",
    "request-required-grant",
    403,
    "forbidden",
  ),
  expectation(
    "provider request",
    "declared deadline reached",
    "HTTP boundary",
    "deadline",
    "failed",
    "timeout",
    "safe retry guidance",
    "declared_deadline_reached",
    "retry-provider-request",
    504,
    "workflow_failed",
  ),
  expectation(
    "localization run",
    "authorized cancellation",
    "HTTP boundary",
    "cancelled",
    "failed",
    "cancellation",
    "durable cancelled state",
    "authorized_cancellation",
    "inspect-cancelled-run",
    409,
    "workflow_failed",
  ),
  expectation(
    "localization run",
    "exact cap exhausted",
    "HTTP boundary",
    "budget-refusal",
    "failed",
    "budget refusal",
    "exact remaining allowance",
    "exact_cap_exhausted",
    "increase-cap-or-reduce-scope",
    429,
    "workflow_failed",
  ),
  expectation(
    "persisted operation",
    "unexpected service fault",
    "HTTP boundary",
    "internal-failure",
    "failed",
    "internal failure",
    "safe incident reference",
    "unexpected_service_fault",
    "report-incident-reference",
    500,
    "internal_error",
  ),
  expectation(
    "runtime asset read",
    "required asset absent",
    "runtime boundary",
    "missing-asset",
    "failed",
    "missing asset",
    "exact missing-asset result",
    "required_asset_absent",
    "restore-required-asset",
    404,
    "not_found",
  ),
  expectation(
    "runtime asset read",
    "protected asset cannot decrypt",
    "runtime boundary",
    "decryption-failure",
    "failed",
    "decryption failure",
    "exact protected-asset result",
    "protected_asset_cannot_decrypt",
    "verify-protected-asset-key",
    422,
    "workflow_failed",
  ),
  expectation(
    "source preparation",
    "tampered, oversized, timed-out, cancelled, or unapproved helper",
    "command boundary",
    "preparation-failure",
    "failed",
    "exact preparation failure",
    "distinct stable safe diagnostic",
    "helper_identity_mismatch",
    "verify-helper-identity",
    422,
    "workflow_failed",
  ),
  expectation(
    "localization outcome",
    "in-profile defect whose message names another failure class",
    "HTTP boundary",
    "misleading-message",
    "failed",
    "in-profile defect",
    "evidence-derived class and exact next action",
    "in_profile_defect",
    "repair-in-profile-operation",
    422,
    "workflow_failed",
  ),
];

export function expectedBoundary(identity: FailureIdentity): BoundaryExpectation | undefined {
  return EXPECTATIONS.find(
    (entry) =>
      entry.operation === identity.operation &&
      entry.failureCase === identity.failureCase &&
      entry.entrypoint === identity.entrypoint,
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class Verifier {
  count = 0;

  expect(condition: boolean, code: string): void {
    if (!condition) throw new Error(code);
    this.count += 1;
  }
}

function parseRecord(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value)) throw new Error("scratch-observation-invalid");
  return value;
}

function fieldCount(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((total, entry) => total + fieldCount(entry), 0);
  if (isRecord(value)) {
    return Object.values(value).reduce<number>((total, entry) => total + 1 + fieldCount(entry), 0);
  }
  return 0;
}

function validateWire(
  selected: BoundaryExpectation,
  facts: Record<string, unknown>,
  proof: Verifier,
): void {
  if (selected.entrypoint !== "HTTP boundary") {
    proof.expect(facts.wire === undefined, "unexpected-http-wire");
    return;
  }
  proof.expect(isRecord(facts.wire), "http-wire-missing");
  if (!isRecord(facts.wire)) throw new Error("http-wire-missing");
  proof.expect(facts.wire.status === selected.httpStatus, "http-status-mismatch");
  proof.expect(facts.wire.code === selected.apiCode, "http-code-mismatch");
  proof.expect(
    typeof facts.wire.responseBytes === "number" && facts.wire.responseBytes > 0,
    "http-response-empty",
  );
}

function validateProbe(
  selected: BoundaryExpectation,
  facts: Record<string, unknown>,
  scratchRoot: string,
  proof: Verifier,
): void {
  switch (selected.probe) {
    case "missing-input": {
      proof.expect(
        Array.isArray(facts.commands) && facts.commands.length === 4,
        "private-command-count",
      );
      if (!Array.isArray(facts.commands)) throw new Error("private-command-facts");
      for (const command of facts.commands) {
        proof.expect(isRecord(command), "private-command-fact");
        if (!isRecord(command)) throw new Error("private-command-fact");
        proof.expect(command.status === 1, "private-command-status");
        proof.expect(command.stdoutBytes === 0, "private-command-stdout");
        proof.expect(command.safeDiagnostic === true, "private-command-diagnostic");
        proof.expect(command.outputWritten === false, "private-command-effect");
      }
      break;
    }
    case "provider-unavailable": {
      proof.expect(facts.providerStatus === 503 && facts.providerRequests === 1, "provider-fact");
      const state = parseRecord(resolve(scratchRoot, "provider-state.json"));
      proof.expect(state.state === "paused", "provider-state");
      proof.expect(state.nextAction === selected.nextAction, "provider-next-action");
      break;
    }
    case "unsupported-profile": {
      proof.expect(facts.errorName === "LocalizationTargetPolicyError", "profile-error-type");
      const rendered = readFileSync(resolve(scratchRoot, "profile-refusal.html"), "utf8");
      proof.expect(rendered.includes(selected.failureClass), "profile-render-class");
      proof.expect(rendered.includes(selected.nextAction), "profile-render-action");
      break;
    }
    case "malformed-input":
      proof.expect(facts.command === "itotori.patchback-produce", "patchback-command-not-executed");
      proof.expect(facts.errorName === "MalformedOwnedInputError", "parser-error-type");
      proof.expect(facts.inputReadCalls === 1, "command-input-read-count");
      proof.expect(facts.outputWriteCalls === 0, "command-output-write-count");
      break;
    case "unsupported-operation":
      proof.expect(facts.errorName === "PatchRuntimeLaunchError", "runtime-error-type");
      proof.expect(facts.errorCode === "unsupported_runtime_operation", "runtime-error-code");
      proof.expect(facts.handlerCalls === 0, "runtime-handler-called");
      break;
    case "stale-source":
      proof.expect(facts.mismatch === true, "stale-source-fact");
      proof.expect(
        facts.command === "itotori.patchback-produce",
        "stale-patchback-command-not-executed",
      );
      proof.expect(facts.inputReadCalls === 1, "stale-command-input-read-count");
      proof.expect(facts.nativeCalls === 0, "stale-command-native-call-count");
      proof.expect(facts.outputWriteCalls === 0, "stale-command-output-write-count");
      proof.expect(facts.errorName === "PatchbackBindingError", "stale-source-error-type");
      proof.expect(facts.errorCode === "source-hash-mismatch", "stale-source-error-code");
      proof.expect(
        typeof facts.plannedHash === "string" &&
          typeof facts.currentHash === "string" &&
          facts.plannedHash !== facts.currentHash,
        "stale-source-digests",
      );
      break;
    case "privacy-denial":
      proof.expect(facts.errorName === "EgressDeniedError", "privacy-error-type");
      proof.expect(facts.errorCode === "operator-egress-disabled", "privacy-error-code");
      proof.expect(facts.policyChecks === 1, "privacy-policy-check");
      break;
    case "permission-denial":
      proof.expect(facts.errorName === "AuthorizationError", "permission-error-type");
      proof.expect(facts.permissionChecks === 1, "permission-check-count");
      proof.expect(facts.permission === "auth.permissions.manage", "permission-checked");
      break;
    case "deadline":
      proof.expect(
        facts.providerRequests === 1 && facts.pendingObserved === true,
        "deadline-pending",
      );
      proof.expect(facts.abortName === "TimeoutError", "deadline-abort-type");
      break;
    case "cancelled": {
      proof.expect(facts.workerOutcome === "cancelled", "worker-not-cancelled");
      const state = parseRecord(resolve(scratchRoot, "cancelled-state.json"));
      proof.expect(state.state === "cancelled" && state.transition === 1, "cancelled-state");
      break;
    }
    case "budget-refusal":
      proof.expect(
        facts.cap === 100 && facts.spent === 35 && facts.reserved === 25,
        "cap-ledger-facts",
      );
      proof.expect(facts.requested === 41 && facts.remaining === 40, "cap-arithmetic-facts");
      proof.expect(facts.remainingAllowanceMicrosUsd === 40, "cap-wire-allowance");
      break;
    case "internal-failure":
      proof.expect(facts.rawLeaked === false, "internal-raw-leak");
      proof.expect(
        typeof facts.incidentReference === "string" &&
          /^incident:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
            facts.incidentReference,
          ),
        "internal-incident-reference",
      );
      break;
    case "missing-asset":
      proof.expect(facts.fileErrorCode === "ENOENT" && facts.bytesRead === 0, "missing-asset-read");
      break;
    case "decryption-failure":
      proof.expect(facts.algorithm === "aes-256-gcm", "decryption-algorithm");
      proof.expect(facts.authenticationFailed === true, "decryption-auth-result");
      proof.expect(
        typeof facts.stagedBytes === "number" && facts.stagedBytes > 0,
        "decryption-stage",
      );
      break;
    case "preparation-failure": {
      proof.expect(
        facts.identityMismatch === true && facts.oversized === true,
        "helper-input-facts",
      );
      proof.expect(facts.deadlineSignal === "SIGTERM", "helper-deadline-fact");
      proof.expect(facts.cancellationSignal === "SIGTERM", "helper-cancellation-fact");
      proof.expect(facts.approvedRegistryContainsHelper === false, "helper-approval-fact");
      proof.expect(Array.isArray(facts.helperSourceCodes), "helper-codes-missing");
      if (!Array.isArray(facts.helperSourceCodes)) throw new Error("helper-codes-missing");
      proof.expect(facts.helperSourceCodes.length === 5, "helper-code-count");
      proof.expect(new Set(facts.helperSourceCodes).size === 5, "helper-codes-not-distinct");
      break;
    }
    case "misleading-message":
      proof.expect(facts.messageNamesOtherClasses === true, "misleading-message-not-seeded");
      break;
    default:
      throw new Error("probe-not-validated");
  }
}

export function validateCandidate(
  identity: FailureIdentity,
  value: Record<string, unknown>,
  scratchRoot: string,
): FactValidation {
  const selected = expectedBoundary(identity);
  if (selected === undefined) throw new Error("candidate-tuple-not-declared");
  const proof = new Verifier();
  proof.expect(value.disposition === selected.disposition, "candidate-disposition");
  proof.expect(value.failureClass === selected.failureClass, "candidate-class");
  proof.expect(value.diagnostic === selected.diagnostic, "candidate-diagnostic");
  proof.expect(value.sourceCode === selected.sourceCode, "candidate-source-code");
  proof.expect(value.nextAction === selected.nextAction, "candidate-next-action");
  proof.expect(value.httpStatus === selected.httpStatus, "candidate-http-status");
  proof.expect(value.apiCode === selected.apiCode, "candidate-api-code");
  proof.expect(isRecord(value.facts), "candidate-facts-missing");
  if (!isRecord(value.facts)) throw new Error("candidate-facts-missing");
  validateFailureState(selected, value.facts, scratchRoot, proof);
  validateWire(selected, value.facts, proof);
  validateProbe(selected, value.facts, scratchRoot, proof);
  return { observedFields: fieldCount(value), boundaryProofCount: proof.count };
}
