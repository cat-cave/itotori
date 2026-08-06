import {
  check,
  requireCaseValue,
  type BehaviorCellStepContext,
  type BehaviorCellStepExecutor,
  type BehaviorCellStepResult,
} from "../../drivers/behavior-cells/step-contract.js";
import { fixedSuccessEnabled } from "../../drivers/behavior-cells/fixed-success-mutation.js";
import {
  invariantResult,
  observeAdministerAccessBehavior,
  scenarioResult,
  type AdministerAccessObservation,
  type ConditionResult,
} from "./observation.js";

export const cell = "cell::account.administer-access::all";

interface Execution {
  readonly observation: AdministerAccessObservation;
  readonly reasonCodes: string[];
}

const executions = new WeakMap<object, Execution>();

function executionFor(execution: object): Execution {
  const current = executions.get(execution);
  if (current === undefined) throw new Error("administer-access-not-observed");
  return current;
}

function failedReasons(...results: readonly ConditionResult[]): readonly string[] {
  return results.filter(({ passed }) => !passed).map(({ reason }) => reason);
}

function caseScenarios(values: Readonly<Record<string, string>>): readonly string[] {
  const action = requireCaseValue(values, "admin_action");
  const auth = requireCaseValue(values, "authorization_case");
  const scope = requireCaseValue(values, "resource_scope");
  const capacity = requireCaseValue(values, "capacity_case");
  const subject = requireCaseValue(values, "subject_case");

  if (auth === "denied" || auth.includes("denied")) {
    return ["memberDeniedAdmin", "foreignUnavailable"];
  }
  if (scope.includes("foreign") || auth.includes("another scope")) {
    return ["crossTenantGrantDenied", "crossTenantListDenied", "foreignUnavailable"];
  }
  if (action === "invite member" || action === "accept invitation") {
    if (capacity.includes("seat limit")) return ["seatCapacityView"];
    if (subject.includes("expired") || subject.includes("duplicate")) {
      return ["inviteAccept", "auditAppendOnly"];
    }
    return ["inviteAccept", "auditAppendOnly"];
  }
  if (action === "revoke grant") {
    return ["revokeRemovesAccess", "auditAppendOnly"];
  }
  if (action === "grant project permission") {
    if (subject.includes("disabled")) return ["disableEndsAccess"];
    return ["inviteAccept", "revokeRemovesAccess"];
  }
  if (action === "revoke selected session") {
    return ["sessionAdminRevoke", "auditAppendOnly"];
  }
  if (action === "disable principal") {
    return ["disableEndsAccess", "sessionAdminRevoke"];
  }
  if (action === "save SSO policy" || action.includes("SSO")) {
    return ["memberDeniedAdmin", "auditAppendOnly"];
  }
  if (action === "add existing identities") {
    return ["collisionFreeMemberships"];
  }
  if (action === "migrate legacy ownership") {
    return ["collisionFreeMemberships", "auditAppendOnly"];
  }
  if (action.includes("read and write")) {
    return ["foreignUnavailable", "memberDeniedAdmin", "revokeRemovesAccess"];
  }
  if (action === "resolve overlapping grants") {
    return ["revokeRemovesAccess", "inviteAccept"];
  }
  if (action === "update allowed field") {
    return ["memberDeniedAdmin", "revokeRemovesAccess"];
  }
  return ["inviteAccept", "crossTenantListDenied", "auditAppendOnly"];
}

function transactionMatches(
  observation: AdministerAccessObservation,
  values: Readonly<Record<string, string>>,
): readonly ConditionResult[] {
  return caseScenarios(values).map((name) => scenarioResult(observation, name));
}

function responseMatches(
  observation: AdministerAccessObservation,
  values: Readonly<Record<string, string>>,
): ConditionResult {
  const response = requireCaseValue(values, "response_outcome");
  if (
    response.includes("denial") ||
    response.includes("refused") ||
    response.includes("scope-denial")
  ) {
    return scenarioResult(observation, "memberDeniedAdmin");
  }
  if (response.includes("seat-capacity") || response.includes("billing")) {
    return scenarioResult(observation, "seatCapacityView");
  }
  if (response.includes("session")) {
    return scenarioResult(observation, "sessionAdminRevoke");
  }
  return scenarioResult(observation, "inviteAccept");
}

function auditMatches(
  observation: AdministerAccessObservation,
  values: Readonly<Record<string, string>>,
): ConditionResult {
  const audit = requireCaseValue(values, "audit_outcome");
  if (audit.includes("denied") || audit.includes("refused")) {
    return scenarioResult(observation, "auditAppendOnly");
  }
  return scenarioResult(observation, "auditAppendOnly");
}

export const executeCellStep: BehaviorCellStepExecutor = async (
  context: BehaviorCellStepContext,
): Promise<BehaviorCellStepResult> => {
  const { index, selected, text } = context;
  if (index === 0) {
    const fixedSuccess = fixedSuccessEnabled(
      context.mode,
      context.mutationArtifactPath,
      selected.cell,
    );
    check(
      text ===
        `${requireCaseValue(selected.values, "admin_state")} attempts ${requireCaseValue(
          selected.values,
          "admin_action",
        )} for ${requireCaseValue(selected.values, "resource_scope")}`,
      "administer-access-given-mismatch",
    );
    const observation = await observeAdministerAccessBehavior(context.repositoryRoot, fixedSuccess);
    executions.set(context.execution, { observation, reasonCodes: [] });
    return { observationCount: observation.observedFields };
  }
  const execution = executionFor(context.execution);
  const observation = execution.observation;
  if (index === 1) {
    check(
      text ===
        `the request has ${requireCaseValue(selected.values, "authorization_case")}, ${requireCaseValue(
          selected.values,
          "subject_case",
        )}, and ${requireCaseValue(selected.values, "capacity_case")}`,
      "administer-access-request-mismatch",
    );
    return {};
  }
  if (index === 2) {
    check(text === "the access change commits", "administer-access-when-mismatch");
    return {};
  }

  let results: readonly ConditionResult[];
  if (index === 3) {
    check(
      text ===
        `membership, grant, session, seat, billing view, and audit effects are ${requireCaseValue(
          selected.values,
          "transaction_outcome",
        )}`,
      "administer-access-transaction-mismatch",
    );
    results = transactionMatches(observation, selected.values);
  } else if (index === 4) {
    check(
      text === `the response exposes ${requireCaseValue(selected.values, "response_outcome")}`,
      "administer-access-response-mismatch",
    );
    results = [responseMatches(observation, selected.values)];
  } else if (index === 5) {
    check(
      text === `audit history ends as ${requireCaseValue(selected.values, "audit_outcome")}`,
      "administer-access-audit-outcome-mismatch",
    );
    results = [auditMatches(observation, selected.values)];
  } else if (index === 6) {
    check(
      text ===
        "every declared audit event is append-only and retains actor, target, outcome, and exact order",
      "administer-access-audit-append-mismatch",
    );
    results = [invariantResult(observation, "auditRetained")];
  } else if (index === 7) {
    check(
      text ===
        "disabling or removing a principal immediately ends every active session and protected read or write",
      "administer-access-disable-mismatch",
    );
    results = [invariantResult(observation, "disableEndsSessions")];
  } else if (index === 8) {
    check(
      text ===
        "local and federated principal identities remain collision-free across authorized accounts",
      "administer-access-collision-mismatch",
    );
    results = [invariantResult(observation, "collisionFree")];
  } else if (index === 9) {
    check(
      text === "billing or identity-provider groups grant no undeclared application authority",
      "administer-access-undeclared-mismatch",
    );
    results = [invariantResult(observation, "noUndeclaredAuthority")];
  } else if (index === 10) {
    check(
      text ===
        "every protected catalog, run, review, Wiki, asset, settings, and billing action independently enforces its effective read and write authority",
      "administer-access-protected-mismatch",
    );
    results = [invariantResult(observation, "protectedActionsEnforced")];
  } else if (index === 11) {
    check(
      text === "another account's resources remain unavailable",
      "administer-access-foreign-mismatch",
    );
    results = [
      invariantResult(observation, "foreignResourcesUnavailable"),
      invariantResult(observation, "crossTenantRefused"),
    ];
  } else {
    throw new Error("unbound-administer-access-step");
  }

  const reasonCodes = failedReasons(...results);
  execution.reasonCodes.push(...reasonCodes);
  const deferredFailure =
    index === 11 && execution.reasonCodes.length > 0
      ? `administer-access-conditions-failed:${execution.reasonCodes.join(",")}`
      : undefined;
  if (index === 11) executions.delete(context.execution);
  return {
    assertionCount: 1,
    reasonCodes,
    ...(deferredFailure === undefined ? {} : { deferredFailure }),
  };
};
