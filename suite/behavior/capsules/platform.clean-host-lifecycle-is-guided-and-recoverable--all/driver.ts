import { observeCleanHostLifecycle, type CleanHostObservation } from "./observation.js";
import {
  check,
  requireCaseValue,
  type BehaviorCellStepContext,
  type BehaviorCellStepExecutor,
  type BehaviorCellStepResult,
} from "../../drivers/behavior-cells/step-contract.js";
import { fixedSuccessEnabled } from "../../drivers/behavior-cells/fixed-success-mutation.js";

export const cell = "cell::platform.clean-host-lifecycle-is-guided-and-recoverable::all";

interface Execution {
  readonly observation: CleanHostObservation;
  readonly reasons: string[];
}

interface Result {
  readonly passed: boolean;
  readonly reason: string;
}

const executions = new WeakMap<object, Execution>();

function executionFor(execution: object): Execution {
  const value = executions.get(execution);
  if (value === undefined) throw new Error("clean-host-not-observed");
  return value;
}

function result(passed: boolean, reason: string, observation: CleanHostObservation): Result {
  return { passed: passed && observation.invalidSignatureRefused, reason };
}

function lifecycleOutcome(observation: CleanHostObservation, expected: string): Result {
  switch (expected) {
    case "ready documented installation":
      return result(observation.initialized, "clean-host-initialization-not-ready", observation);
    case "ready upgraded installation":
      return result(observation.upgraded, "clean-host-valid-update-not-ready", observation);
    case "no partial upgraded service":
      return result(
        observation.invalidSignatureRefused &&
          observation.dataSurvives &&
          observation.activePayloadTransitions &&
          observation.rollbackRecoversRetainedPayload,
        "clean-host-failed-update-not-recoverable",
        observation,
      );
    case "blocked before readiness":
      return result(
        observation.missingFontBlocked,
        "clean-host-missing-font-not-blocked",
        observation,
      );
    case "ready unchanged installation":
      return result(observation.rerunSingular, "clean-host-rerun-not-unchanged", observation);
    case "every documented command returns its declared outcome":
      return result(
        observation.commandsReady,
        "clean-host-installed-command-unavailable",
        observation,
      );
    case "update refused before replacement":
      return result(
        observation.invalidSignatureRefused,
        "clean-host-invalid-signature-accepted",
        observation,
      );
    default:
      return result(false, "clean-host-expected-lifecycle-outcome-unrecognized", observation);
  }
}

function fontOutcome(observation: CleanHostObservation, expected: string): Result {
  switch (expected) {
    case "exact missing-font diagnosis before evidence":
      return result(
        observation.missingFontBlocked,
        "clean-host-missing-font-diagnosis-absent",
        observation,
      );
    case "representative glyphs render without missing-glyph boxes":
    case "prior glyph rendering remains available":
      return result(observation.glyphsReady, "clean-host-glyphs-not-renderable", observation);
    default:
      return result(false, "clean-host-font-outcome-unrecognized", observation);
  }
}

function rerunOutcome(observation: CleanHostObservation, expected: string): Result {
  switch (expected) {
    case "no partial or duplicate state":
      return result(
        observation.missingFontBlocked,
        "clean-host-blocked-state-created",
        observation,
      );
    case "existing state remains singular":
    case "no destruction or duplication":
      return result(observation.rerunSingular, "clean-host-rerun-duplicated-state", observation);
    default:
      return result(false, "clean-host-rerun-outcome-unrecognized", observation);
  }
}

function runnableOutcome(observation: CleanHostObservation, expected: string): Result {
  switch (expected) {
    case "none":
      return result(
        observation.missingFontBlocked,
        "clean-host-missing-font-created-runnable-state",
        observation,
      );
    case "installed current":
    case "version-two":
      return result(
        observation.dataSurvives &&
          observation.activePayloadTransitions &&
          observation.rollbackRecoversRetainedPayload,
        "clean-host-prior-release-not-runnable",
        observation,
      );
    default:
      return result(false, "clean-host-runnable-version-unrecognized", observation);
  }
}

function assertion(index: number, context: BehaviorCellStepContext): Result {
  const observation = executionFor(context.execution).observation;
  if (index === 2) {
    const expected = requireCaseValue(context.selected.values, "lifecycle_outcome");
    check(
      context.text ===
        `required services, fonts, dependencies, and product commands end as ${expected}`,
      "clean-host-lifecycle-outcome-mismatch",
    );
    return lifecycleOutcome(observation, expected);
  }
  if (index === 3) {
    const expected = requireCaseValue(context.selected.values, "font_outcome");
    check(
      context.text ===
        `representative source and target glyphs end as ${expected} before proof capture`,
      "clean-host-font-outcome-mismatch",
    );
    return fontOutcome(observation, expected);
  }
  if (index === 4) {
    const expected = requireCaseValue(context.selected.values, "rerun_outcome");
    check(
      context.text === `repeating initialization ends as ${expected}`,
      "clean-host-rerun-outcome-mismatch",
    );
    return rerunOutcome(observation, expected);
  }
  const clauses = [
    "any ready installed client exercises help, initialize, extract, localize, patch, and validate",
    "any patch operation copies only selected output and no unrelated owned files",
    "the installed release exposes no test-only provider or failure control",
    `data survives or a failed update leaves ${requireCaseValue(context.selected.values, "runnable_version")}`,
    "every installed dependency has reproducible authorized provenance",
  ];
  const clause = clauses[index - 5];
  if (clause === undefined) throw new Error("unbound-clean-host-step");
  check(context.text === clause, `clean-host-step-${index - 4}-mismatch`);
  if (index === 5)
    return result(
      observation.commandsReady,
      "clean-host-installed-command-unavailable",
      observation,
    );
  if (index === 6)
    return result(
      observation.selectedOutputOnly,
      "clean-host-patch-copied-unselected-output",
      observation,
    );
  if (index === 7)
    return result(
      observation.noTestOnlyControl,
      "clean-host-test-only-control-exposed",
      observation,
    );
  if (index === 8)
    return runnableOutcome(
      observation,
      requireCaseValue(context.selected.values, "runnable_version"),
    );
  return result(
    observation.reproducibleProvenance,
    "clean-host-dependency-provenance-unverified",
    observation,
  );
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
        `clean supported ${requireCaseValue(selected.values, "host_profile")} has ${requireCaseValue(
          selected.values,
          "installed_version",
        )} and ${requireCaseValue(selected.values, "font_case")}`,
      "clean-host-given-mismatch",
    );
    const observation = observeCleanHostLifecycle(
      context.repositoryRoot,
      context.workRoot,
      fixedSuccess,
    );
    executions.set(context.execution, { observation, reasons: [] });
    return { observationCount: observation.observedFields };
  }
  if (index === 1) {
    check(
      text ===
        `the operator performs ${requireCaseValue(selected.values, "lifecycle_action")} using current user documentation`,
      "clean-host-when-mismatch",
    );
    return {};
  }
  const current = executionFor(context.execution);
  const outcome = assertion(index, context);
  if (!outcome.passed) current.reasons.push(outcome.reason);
  const deferredFailure =
    index === 9 && current.reasons.length > 0
      ? `clean-host-conditions-failed:${current.reasons.join(",")}`
      : undefined;
  if (index === 9) executions.delete(context.execution);
  return {
    assertionCount: 1,
    reasonCodes: outcome.passed ? [] : [outcome.reason],
    ...(deferredFailure === undefined ? {} : { deferredFailure }),
  };
};
