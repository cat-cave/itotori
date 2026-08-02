import {
  observeDeploymentInputs,
  type DeploymentObservation,
  type DeploymentScenarioObservation,
} from "./observation.js";
import {
  check,
  requireCaseValue,
  type BehaviorCellStepContext,
  type BehaviorCellStepExecutor,
  type BehaviorCellStepResult,
} from "../../drivers/behavior-cells/step-contract.js";
import { fixedSuccessEnabled } from "../../drivers/behavior-cells/fixed-success-mutation.js";

export const cell = "cell::platform.deployment-inputs-and-secrets-are-safe::all";

interface Execution {
  readonly observation: DeploymentObservation;
  readonly reasons: string[];
}

interface Result {
  readonly passed: boolean;
  readonly reason: string;
}

const executions = new WeakMap<object, Execution>();

function executionFor(execution: object): Execution {
  const current = executions.get(execution);
  if (current === undefined) throw new Error("deployment-inputs-not-observed");
  return current;
}

function deploymentInvariant(observation: DeploymentObservation): boolean {
  const missing = observation.missingRequiredDatabaseUrl;
  const controls = observation.negativeControls;
  const expectedIds = ["001", "002", "003", "004", "005", "006", "007", "008", "009", "010"];
  return (
    observation.configurationSchemaCount === 33 &&
    missing.typed &&
    missing.preReadiness &&
    missing.code === "missing-required-deployment-input" &&
    missing.inputName === "DATABASE_URL" &&
    missing.configWrites === 0 &&
    controls.unknownRefusedBeforeReadiness &&
    controls.malformedRefusedBeforeReadiness &&
    controls.insecureRefusedBeforeReadiness &&
    controls.diagnosticsRedacted &&
    observation.scenarios.length === expectedIds.length &&
    expectedIds.every((id) => observation.scenarios.some((scenario) => scenario.id === id))
  );
}

function result(passed: boolean, reason: string, observation: DeploymentObservation): Result {
  return {
    passed: passed && deploymentInvariant(observation),
    reason: deploymentInvariant(observation)
      ? reason
      : "deployment-inputs-global-safety-invariant-failed",
  };
}

function scenarioId(context: BehaviorCellStepContext): string {
  const expected = requireCaseValue(context.selected.values, "expected_outcome");
  if (expected === "exact accepted configuration") {
    return requireCaseValue(context.selected.values, "placement") === "managed" ? "002" : "001";
  }
  if (expected === "no partially ready service") return "003";
  if (expected === "no printed or retained secret") return "004";
  if (expected === "the supplied file remains byte-identical") return "005";
  if (expected === "every setting and value round-trips exactly") return "006";
  if (expected === "exact duplicate-setting diagnostic before readiness") return "007";
  if (expected === "exact malformed-value diagnostic before readiness") return "008";
  if (expected === "every supported credential character round-trips exactly") return "009";
  if (
    expected === "exact unsupported-form diagnostic before startup with no expansion or leakage"
  ) {
    return "010";
  }
  throw new Error("deployment-inputs-expected-outcome-unrecognized");
}

function scenarioFor(
  context: BehaviorCellStepContext,
  observation: DeploymentObservation,
): DeploymentScenarioObservation {
  const id = scenarioId(context);
  const scenario = observation.scenarios.find((candidate) => candidate.id === id);
  if (scenario === undefined) throw new Error(`deployment-inputs-scenario-missing:${id}`);
  return scenario;
}

function expectedOutcome(
  scenario: DeploymentScenarioObservation,
  expected: string,
  startupCase: string,
  observation: DeploymentObservation,
): Result {
  switch (expected) {
    case "exact accepted configuration":
      return result(
        scenario.startup === startupCase &&
          scenario.startup === "ready" &&
          scenario.exactAcceptedConfiguration &&
          scenario.documentedSettingCount === 1,
        "deployment-inputs-accepted-configuration-not-exact",
        observation,
      );
    case "no partially ready service":
      return result(
        scenario.startup === startupCase &&
          scenario.startup === "refused" &&
          !scenario.exactAcceptedConfiguration &&
          scenario.noPartialReadiness &&
          scenario.diagnosticCode === "unknown-setting",
        "deployment-inputs-unknown-setting-not-refused",
        observation,
      );
    case "no printed or retained secret":
      return result(
        scenario.startup === startupCase &&
          scenario.startup === "refused" &&
          scenario.noPartialReadiness &&
          scenario.secretRedacted &&
          scenario.diagnosticCode === "source-permissions-insecure",
        "deployment-inputs-insecure-secret-not-redacted",
        observation,
      );
    case "the supplied file remains byte-identical":
      return result(
        scenario.startup === startupCase &&
          scenario.startup === "interrupted" &&
          scenario.suppliedFileUntouched,
        "deployment-inputs-supplied-file-mutated",
        observation,
      );
    case "every setting and value round-trips exactly":
      return result(
        scenario.startup === startupCase &&
          scenario.startup === "ready" &&
          scenario.exactAcceptedConfiguration &&
          scenario.documentedSettingCount === observation.configurationSchemaCount,
        "deployment-inputs-full-configuration-not-exact",
        observation,
      );
    case "exact duplicate-setting diagnostic before readiness":
      return result(
        scenario.startup === startupCase &&
          scenario.startup === "refused" &&
          scenario.noPartialReadiness &&
          scenario.diagnosticCode === "duplicate-setting",
        "deployment-inputs-duplicate-not-refused",
        observation,
      );
    case "exact malformed-value diagnostic before readiness":
      return result(
        scenario.startup === startupCase &&
          scenario.startup === "refused" &&
          scenario.noPartialReadiness &&
          scenario.diagnosticCode === "non-unicode",
        "deployment-inputs-non-unicode-not-refused",
        observation,
      );
    case "every supported credential character round-trips exactly":
      return result(
        scenario.startup === startupCase &&
          scenario.startup === "ready" &&
          scenario.exactAcceptedConfiguration &&
          scenario.secretRedacted,
        "deployment-inputs-supported-credential-not-exact",
        observation,
      );
    case "exact unsupported-form diagnostic before startup with no expansion or leakage":
      return result(
        scenario.startup === startupCase &&
          scenario.startup === "refused" &&
          scenario.noPartialReadiness &&
          scenario.secretRedacted &&
          scenario.diagnosticCode === "unsupported-value-form",
        "deployment-inputs-unsupported-credential-not-refused",
        observation,
      );
    default:
      throw new Error("deployment-inputs-expected-outcome-unrecognized");
  }
}

function assertion(index: number, context: BehaviorCellStepContext): Result {
  const observation = executionFor(context.execution).observation;
  const scenario = scenarioFor(context, observation);
  if (index === 3) {
    const expected = requireCaseValue(context.selected.values, "expected_outcome");
    check(
      context.text === `documented values round-trip as ${expected}`,
      "deployment-inputs-expected-outcome-mismatch",
    );
    return expectedOutcome(
      scenario,
      expected,
      requireCaseValue(context.selected.values, "startup_case"),
      observation,
    );
  }
  if (index === 4) {
    check(
      context.text === "unknown, malformed, or insecure input fails before service readiness",
      "deployment-inputs-pre-readiness-mismatch",
    );
    return result(
      scenario.preReadinessRefusal,
      "deployment-inputs-pre-readiness-refusal-missing",
      observation,
    );
  }
  if (index === 5) {
    check(
      context.text ===
        "secret values never appear in logs, diagnostics, or retained temporary material",
      "deployment-inputs-secret-redaction-mismatch",
    );
    return result(scenario.secretRedacted, "deployment-inputs-secret-leaked", observation);
  }
  if (index === 6) {
    check(
      context.text ===
        "wrapper-created secret files are removed on every exit while explicitly supplied files remain untouched",
      "deployment-inputs-secret-file-cleanup-mismatch",
    );
    return result(
      scenario.wrapperSecretFileRemoved && scenario.suppliedFileUntouched,
      "deployment-inputs-secret-file-lifecycle-invalid",
      observation,
    );
  }
  throw new Error("unbound-deployment-inputs-step");
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
        `${requireCaseValue(selected.values, "placement")} receives configuration from ${requireCaseValue(
          selected.values,
          "config_source",
        )}`,
      "deployment-inputs-given-mismatch",
    );
    const observation = await observeDeploymentInputs(context.repositoryRoot, fixedSuccess);
    executions.set(context.execution, { observation, reasons: [] });
    return { observationCount: observation.observedFields };
  }
  if (index === 1) {
    check(
      text ===
        `a secret arrives from ${requireCaseValue(selected.values, "secret_source")} with ${requireCaseValue(
          selected.values,
          "value_case",
        )}`,
      "deployment-inputs-secret-given-mismatch",
    );
    return {};
  }
  if (index === 2) {
    const expected = requireCaseValue(selected.values, "startup_case");
    check(text === `startup ends as ${expected}`, "deployment-inputs-startup-mismatch");
    return {};
  }
  const execution = executionFor(context.execution);
  const outcome = assertion(index, context);
  if (!outcome.passed) execution.reasons.push(outcome.reason);
  const deferredFailure =
    index === 6 && execution.reasons.length > 0
      ? `deployment-inputs-conditions-failed:${execution.reasons.join(",")}`
      : undefined;
  if (index === 6) executions.delete(context.execution);
  return {
    assertionCount: 1,
    reasonCodes: outcome.passed ? [] : [outcome.reason],
    ...(deferredFailure === undefined ? {} : { deferredFailure }),
  };
};
