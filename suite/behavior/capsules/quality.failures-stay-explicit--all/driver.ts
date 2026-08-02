import {
  isExplicitNonSuccess,
  observeFailure,
  type FailureObservation,
} from "../../drivers/explicit-failure.js";
import {
  check,
  requireCaseValue,
  type BehaviorCellStepContext,
  type BehaviorCellStepExecutor,
  type BehaviorCellStepResult,
} from "../../drivers/behavior-cells/step-contract.js";
import { fixedSuccessEnabled } from "../../drivers/behavior-cells/fixed-success-mutation.js";

export const cell = "cell::quality.failures-stay-explicit::all";

const observations = new WeakMap<object, FailureObservation>();

function observationFor(execution: object): FailureObservation {
  const observation = observations.get(execution);
  if (observation === undefined) throw new Error("failure-not-observed");
  return observation;
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
    const operation = requireCaseValue(selected.values, "operation");
    const failureCase = requireCaseValue(selected.values, "failure_case");
    const entrypoint = requireCaseValue(selected.values, "entrypoint");
    check(
      text === `${operation} receives ${failureCase} through ${entrypoint}`,
      "failure-given-mismatch",
    );
    const observation = observeFailure(
      {
        operation,
        failureCase,
        entrypoint,
        repositoryRoot: context.repositoryRoot,
        workRoot: context.workRoot,
      },
      fixedSuccess,
    );
    observations.set(context.execution, observation);
    return { observationCount: observation.observedFields };
  }
  if (index === 1) {
    check(text === "the request settles", "failure-when-mismatch");
    observationFor(context.execution);
    return {};
  }
  const observation = observationFor(context.execution);
  if (index === 2) {
    const expected = requireCaseValue(selected.values, "failure_class");
    check(text === `the caller receives ${expected}`, "failure-class-step-mismatch");
    check(observation.failureClass === expected, "failure-class-mismatch");
  } else if (index === 3) {
    const expected = requireCaseValue(selected.values, "diagnostic_outcome");
    check(text === `the outcome contains ${expected}`, "failure-diagnostic-step-mismatch");
    check(observation.diagnostic === expected, "failure-diagnostic-mismatch");
  } else if (index === 4) {
    check(
      text === "no successful, skipped, defaulted, or fixed-empty result is reported",
      "failure-final-step-mismatch",
    );
    check(isExplicitNonSuccess(observation), "empty-or-successful-failure-result");
    observations.delete(context.execution);
  } else {
    throw new Error("unbound-explicit-failure-step");
  }
  return { assertionCount: 1 };
};
