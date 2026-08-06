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
  observeAuthenticateSessionBehavior,
  scenarioResult,
  type AuthenticateSessionObservation,
  type ConditionResult,
} from "./observation.js";

export const cell = "cell::account.authenticate-session::all";

interface Execution {
  readonly observation: AuthenticateSessionObservation;
  readonly reasonCodes: string[];
}

const executions = new WeakMap<object, Execution>();

function executionFor(execution: object): Execution {
  const current = executions.get(execution);
  if (current === undefined) throw new Error("authenticate-session-not-observed");
  return current;
}

function failedReasons(...results: readonly ConditionResult[]): readonly string[] {
  return results.filter(({ passed }) => !passed).map(({ reason }) => reason);
}

/** Map a Gherkin row to the product scenarios that must hold for its outcomes. */
function caseScenarios(values: Readonly<Record<string, string>>): readonly string[] {
  const claim = requireCaseValue(values, "claim_case");
  const action = requireCaseValue(values, "protocol_action");
  const protocol = requireCaseValue(values, "identity_protocol");
  const authOutcome = requireCaseValue(values, "authentication_outcome");

  if (
    claim.includes("forged") ||
    claim.includes("wrong") ||
    claim.includes("invalid") ||
    claim.includes("replayed") ||
    claim.includes("expired") ||
    claim.includes("unsigned")
  ) {
    return protocol === "enterprise SSO"
      ? ["samlForgeryDenied", "forgedDenied"]
      : ["oidcForgeryDenied", "forgedDenied"];
  }
  if (claim.includes("disabled")) {
    return ["disableVoidsAuthority"];
  }
  if (action === "rotate credential") {
    return ["rotationReplaces"];
  }
  if (action === "log out") {
    return ["selectedLogoutIsolation", "revocationEndsAccess"];
  }
  if (action === "link identity") {
    return ["groupsQuarantined", "sessionIsolation"];
  }
  if (authOutcome.includes("denied by the saved SSO policy")) {
    return ["ssoPolicyHeld", "oidcForgeryDenied"];
  }
  if (protocol === "enterprise SSO") {
    return ["samlForgeryDenied", "opaqueLogin", "groupsQuarantined"];
  }
  if (protocol === "OIDC" || protocol === "browser identity") {
    return ["opaqueLogin", "groupsQuarantined", "providerTokensIsolated"];
  }
  return ["localLoginOpaque", "opaqueLogin", "sessionIsolation"];
}

function outcomeMatches(
  observation: AuthenticateSessionObservation,
  values: Readonly<Record<string, string>>,
): readonly ConditionResult[] {
  return caseScenarios(values).map((name) => scenarioResult(observation, name));
}

function groupMatches(
  observation: AuthenticateSessionObservation,
  values: Readonly<Record<string, string>>,
): ConditionResult {
  const group = requireCaseValue(values, "group_outcome");
  if (
    group.includes("quarantined") ||
    group.includes("no undeclared") ||
    group.includes("no provider authority")
  ) {
    return scenarioResult(observation, "groupsQuarantined");
  }
  return { passed: true, reason: "group-outcome" };
}

function sessionMatches(
  observation: AuthenticateSessionObservation,
  values: Readonly<Record<string, string>>,
): ConditionResult {
  const session = requireCaseValue(values, "session_outcome");
  if (session.includes("no session")) {
    return scenarioResult(observation, "forgedDenied");
  }
  if (session.includes("prior credential is denied")) {
    return scenarioResult(observation, "rotationReplaces");
  }
  if (session.includes("inactive") || session.includes("disabled")) {
    return scenarioResult(observation, "disableVoidsAuthority");
  }
  if (session.includes("another principal") || session.includes("remain active")) {
    return scenarioResult(observation, "selectedLogoutIsolation");
  }
  if (session.includes("bound to one principal")) {
    return scenarioResult(observation, "sessionIsolation");
  }
  return scenarioResult(observation, "sessionIsolation");
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
        `${requireCaseValue(selected.values, "identity_protocol")} through ${requireCaseValue(
          selected.values,
          "provider_case",
        )} presents ${requireCaseValue(selected.values, "claim_case")} for ${requireCaseValue(
          selected.values,
          "actor_kind",
        )}`,
      "authenticate-session-given-mismatch",
    );
    const observation = await observeAuthenticateSessionBehavior(
      context.repositoryRoot,
      fixedSuccess,
    );
    executions.set(context.execution, { observation, reasonCodes: [] });
    return { observationCount: observation.observedFields };
  }
  const execution = executionFor(context.execution);
  const observation = execution.observation;
  if (index === 1) {
    check(
      text === `the account policy is ${requireCaseValue(selected.values, "policy_case")}`,
      "authenticate-session-policy-mismatch",
    );
    return {};
  }
  if (index === 2) {
    check(
      text ===
        `the actor performs ${requireCaseValue(selected.values, "protocol_action")} for ${requireCaseValue(
          selected.values,
          "session_target",
        )}`,
      "authenticate-session-when-mismatch",
    );
    return {};
  }

  let results: readonly ConditionResult[];
  if (index === 3) {
    check(
      text ===
        `authentication ends as ${requireCaseValue(selected.values, "authentication_outcome")}`,
      "authenticate-session-auth-outcome-mismatch",
    );
    results = outcomeMatches(observation, selected.values);
  } else if (index === 4) {
    check(
      text ===
        `external group or role data ends as ${requireCaseValue(selected.values, "group_outcome")}`,
      "authenticate-session-group-outcome-mismatch",
    );
    results = [groupMatches(observation, selected.values)];
  } else if (index === 5) {
    check(
      text === `session isolation ends as ${requireCaseValue(selected.values, "session_outcome")}`,
      "authenticate-session-session-outcome-mismatch",
    );
    results = [sessionMatches(observation, selected.values)];
  } else if (index === 6) {
    check(
      text === "opaque session credential material cannot be recovered from stored state",
      "authenticate-session-opaque-mismatch",
    );
    results = [
      invariantResult(observation, "opaqueCredential"),
      scenarioResult(observation, "providerTokensIsolated"),
    ];
  } else if (index === 7) {
    check(
      text === "replayed, expired, or forged claims expose no session",
      "authenticate-session-forged-mismatch",
    );
    results = [invariantResult(observation, "forgedExposesNoSession")];
  } else if (index === 8) {
    check(
      text === "a revoked or ended session no longer authorizes requests",
      "authenticate-session-revoked-mismatch",
    );
    results = [invariantResult(observation, "revokedNoLongerAuthorizes")];
  } else {
    throw new Error("unbound-authenticate-session-step");
  }

  const reasonCodes = failedReasons(...results);
  execution.reasonCodes.push(...reasonCodes);
  const deferredFailure =
    index === 8 && execution.reasonCodes.length > 0
      ? `authenticate-session-conditions-failed:${execution.reasonCodes.join(",")}`
      : undefined;
  if (index === 8) executions.delete(context.execution);
  return {
    assertionCount: 1,
    reasonCodes,
    ...(deferredFailure === undefined ? {} : { deferredFailure }),
  };
};
