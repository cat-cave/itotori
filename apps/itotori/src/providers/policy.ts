import {
  type ModelCapabilities,
  ModelProviderError,
  type ProviderDataHandlingPolicy,
  type ProviderInputClassification,
} from "./types.js";

export type ProviderPolicyDecision = {
  allowed: boolean;
  reasons: string[];
};

export function evaluateProviderInputPolicy(
  policy: ProviderDataHandlingPolicy,
  inputClassification: ProviderInputClassification,
  accountPrivacy: ModelCapabilities["accountPrivacy"],
): ProviderPolicyDecision {
  if (inputClassification === "synthetic_public" || inputClassification === "public") {
    return { allowed: true, reasons: [] };
  }

  // ITOTORI-225 — the cost-tier gate is gone. Cost is a per-request fact
  // (see ProviderCost), not a per-policy axis. The privacy-only checks
  // below survive until ITOTORI-227 replaces the whole policy seam with a
  // dedicated privacy posture.
  const reasons: string[] = [];
  if (policy.promptLogging !== "disabled" && policy.promptLogging !== "not_applicable") {
    reasons.push(`prompt logging is ${policy.promptLogging}`);
  }
  if (policy.completionLogging !== "disabled" && policy.completionLogging !== "not_applicable") {
    reasons.push(`completion logging is ${policy.completionLogging}`);
  }
  if (policy.retention === "prompt_or_completion" || policy.retention === "unknown") {
    reasons.push(`retention is ${policy.retention}`);
  }
  if (policy.trainingUse !== "deny" && policy.trainingUse !== "not_applicable") {
    reasons.push(`training use is ${policy.trainingUse}`);
  }
  if (policy.dataCollection !== "deny" && policy.dataCollection !== "not_applicable") {
    reasons.push(`provider data collection is ${policy.dataCollection}`);
  }
  if (accountPrivacy) {
    if (accountPrivacy.inputOutputLogging !== "disabled") {
      reasons.push(`account input/output logging is ${accountPrivacy.inputOutputLogging}`);
    }
    if (accountPrivacy.useOfInputsOutputs !== "deny") {
      reasons.push(`account use of inputs/outputs is ${accountPrivacy.useOfInputsOutputs}`);
    }
    if (accountPrivacy.providerDataPolicyFilters !== "enabled") {
      reasons.push(
        `account provider data policy filters are ${accountPrivacy.providerDataPolicyFilters}`,
      );
    }
  }

  return { allowed: reasons.length === 0, reasons };
}

export function assertProviderInputAllowed(
  capabilities: ModelCapabilities,
  inputClassification: ProviderInputClassification,
): void {
  const decision = evaluateProviderInputPolicy(
    capabilities.dataHandling,
    inputClassification,
    capabilities.accountPrivacy,
  );
  if (!decision.allowed) {
    throw new ModelProviderError(
      `provider policy blocks ${inputClassification} input: ${decision.reasons.join("; ")}`,
      "policy_blocked",
      false,
    );
  }
}

export const safeLocalDataHandlingPolicy: ProviderDataHandlingPolicy = {
  promptLogging: "not_applicable",
  completionLogging: "not_applicable",
  retention: "not_applicable",
  trainingUse: "not_applicable",
  dataCollection: "not_applicable",
  rawCaptureDefault: "disabled",
};

export const deterministicFixtureDataHandlingPolicy: ProviderDataHandlingPolicy = {
  promptLogging: "not_applicable",
  completionLogging: "not_applicable",
  retention: "not_applicable",
  trainingUse: "not_applicable",
  dataCollection: "not_applicable",
  rawCaptureDefault: "disabled",
};
