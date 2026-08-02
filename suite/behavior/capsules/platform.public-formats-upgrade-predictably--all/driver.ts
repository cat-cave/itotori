import {
  observePublicFormatBehavior,
  publicFormatConditionResult,
  publicFormatOutcomeResult,
  type PublicFormatConditionResult,
  type PublicFormatObservation,
} from "../../drivers/public-format.js";
import {
  check,
  requireCaseValue,
  type BehaviorCellStepContext,
  type BehaviorCellStepExecutor,
  type BehaviorCellStepResult,
} from "../../drivers/behavior-cells/step-contract.js";
import { fixedSuccessEnabled } from "../../drivers/behavior-cells/fixed-success-mutation.js";

export const cell = "cell::platform.public-formats-upgrade-predictably::all";

interface PublicFormatExecution {
  readonly observation: PublicFormatObservation;
  readonly reasonCodes: string[];
}

const executions = new WeakMap<object, PublicFormatExecution>();

function executionFor(execution: object): PublicFormatExecution {
  const current = executions.get(execution);
  if (current === undefined) throw new Error("public-format-not-observed");
  return current;
}

function failedReasons(result: PublicFormatConditionResult): readonly string[] {
  return result.passed ? [] : [result.reason];
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
        `${requireCaseValue(selected.values, "consumer")} holds ${requireCaseValue(
          selected.values,
          "format_kind",
        )} at ${requireCaseValue(selected.values, "from_version")}`,
      "public-format-given-mismatch",
    );
    const observation = observePublicFormatBehavior(context.repositoryRoot, fixedSuccess);
    executions.set(context.execution, { observation, reasonCodes: [] });
    return { observationCount: observation.observedFields };
  }
  const execution = executionFor(context.execution);
  const observation = execution.observation;
  if (index === 1) {
    check(
      text ===
        `version ${requireCaseValue(selected.values, "to_version")} reads or migrates ${requireCaseValue(
          selected.values,
          "compatibility_case",
        )}`,
      "public-format-when-mismatch",
    );
    return {};
  }
  const clauses = [
    `every exposed boundary returns ${requireCaseValue(selected.values, "expected_outcome")}`,
    "an incompatible case names the exact migration or version requirement",
    "no boundary silently interprets the same version differently",
    "rejected requests create no persisted effect",
    "package, command, service, and produced-artifact versions agree without placeholder values",
  ];
  const clause = clauses[index - 2];
  if (clause === undefined) throw new Error("unbound-public-format-step");
  check(text === clause, `public-format-step-${index - 1}-mismatch`);
  const result =
    index === 2
      ? publicFormatOutcomeResult(
          observation,
          requireCaseValue(selected.values, "expected_outcome"),
        )
      : index === 3
        ? publicFormatConditionResult(observation, "typed-incompatibility")
        : index === 4
          ? publicFormatConditionResult(observation, "one-negotiated-meaning")
          : index === 5
            ? publicFormatConditionResult(observation, "no-persisted-effect")
            : publicFormatConditionResult(observation, "version-agreement");
  const reasonCodes = failedReasons(result);
  execution.reasonCodes.push(...reasonCodes);
  const deferredFailure =
    index === 6 && execution.reasonCodes.length > 0
      ? `public-format-conditions-failed:${execution.reasonCodes.join(",")}`
      : undefined;
  if (index === 6) executions.delete(context.execution);
  return {
    assertionCount: 1,
    reasonCodes,
    ...(deferredFailure === undefined ? {} : { deferredFailure }),
  };
};
