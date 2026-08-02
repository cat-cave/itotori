import {
  artifactActionResult,
  artifactConditionResult,
  observeImmutableArtifactBehavior,
  type ArtifactConditionResult,
  type ImmutableArtifactObservation,
} from "../../drivers/immutable-artifact.js";
import {
  check,
  requireCaseValue,
  type BehaviorCellStepContext,
  type BehaviorCellStepExecutor,
  type BehaviorCellStepResult,
} from "../../drivers/behavior-cells/step-contract.js";
import { fixedSuccessEnabled } from "../../drivers/behavior-cells/fixed-success-mutation.js";

export const cell = "cell::platform.artifacts-are-immutable-and-retained-by-policy::all";

interface ArtifactExecution {
  readonly observation: ImmutableArtifactObservation;
  readonly reasonCodes: string[];
}

const executions = new WeakMap<object, ArtifactExecution>();

function executionFor(execution: object): ArtifactExecution {
  const current = executions.get(execution);
  if (current === undefined) throw new Error("artifact-not-observed");
  return current;
}

function failedReasons(...results: readonly ArtifactConditionResult[]): readonly string[] {
  return results.filter(({ passed }) => !passed).map(({ reason }) => reason);
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
        `${requireCaseValue(selected.values, "actor")} handles ${requireCaseValue(
          selected.values,
          "artifact_kind",
        )} with ${requireCaseValue(selected.values, "privacy_class")} classification and ${requireCaseValue(
          selected.values,
          "retention_policy",
        )}`,
      "artifact-given-mismatch",
    );
    const observation = await observeImmutableArtifactBehavior(
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
      text === `the actor performs ${requireCaseValue(selected.values, "artifact_action")}`,
      "artifact-when-mismatch",
    );
    return {};
  }
  let results: readonly ArtifactConditionResult[];
  if (index === 2) {
    check(
      text ===
        `hash identity, immutability, and authorization end as ${requireCaseValue(
          selected.values,
          "expected_outcome",
        )}`,
      "artifact-outcome-mismatch",
    );
    results = [
      artifactActionResult(observation, requireCaseValue(selected.values, "artifact_action")),
      artifactConditionResult(observation, "authorized-retention"),
    ];
  } else if (index === 3) {
    check(text === "expiry removes only unreferenced eligible content", "artifact-expiry-mismatch");
    results = [artifactConditionResult(observation, "expiry")];
  } else if (index === 4) {
    check(
      text ===
        "any authorized prune records its exact scope and preserves required referential evidence",
      "artifact-prune-mismatch",
    );
    results = [artifactConditionResult(observation, "prune")];
  } else if (index === 5) {
    check(
      text === "retained lineage never points to missing content as if it were available",
      "artifact-lineage-mismatch",
    );
    results = [artifactConditionResult(observation, "lineage")];
  } else if (index === 6) {
    check(
      text === "every retained audit event preserves its actor, target, outcome, and append order",
      "artifact-audit-mismatch",
    );
    results = [
      artifactConditionResult(observation, "audit"),
      artifactConditionResult(observation, "incompatible-version"),
    ];
  } else {
    throw new Error("unbound-immutable-artifact-step");
  }
  const reasonCodes = failedReasons(...results);
  execution.reasonCodes.push(...reasonCodes);
  const deferredFailure =
    index === 6 && execution.reasonCodes.length > 0
      ? `immutable-artifact-conditions-failed:${execution.reasonCodes.join(",")}`
      : undefined;
  if (index === 6) executions.delete(context.execution);
  return {
    assertionCount: 1,
    reasonCodes,
    ...(deferredFailure === undefined ? {} : { deferredFailure }),
  };
};
