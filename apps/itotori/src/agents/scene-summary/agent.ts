import { createUuid7 } from "@itotori/db";
import { estimateTokens } from "../../batch-planner/token-estimator.js";
import { executeStructuredInvocation } from "../../orchestrator/invocation-supervisor.js";
import { assertReportedTokenCount } from "../../providers/token-accounting.js";
import type {
  ModelInvocationRequest,
  ModelInvocationResult,
  ModelMessage,
  ModelProvider,
  ProviderRunRecord,
} from "../../providers/types.js";
import { buildPrompt, PROMPT_TEMPLATE_VERSION_V1, promptHash } from "./prompt-template.js";
import {
  SceneSummaryEmptyInputError,
  SceneSummaryLocaleMismatchError,
  type SceneSummary,
  type SceneSummaryInput,
  type SceneSummaryOutput,
} from "./shapes.js";

export type GenerateSceneSummaryOptions = {
  provider: ModelProvider;
};

export async function generateSceneSummary(
  input: SceneSummaryInput,
  options: GenerateSceneSummaryOptions,
): Promise<SceneSummaryOutput> {
  if (input.units.length === 0) {
    throw new SceneSummaryEmptyInputError(input.sceneId);
  }
  // Locale enforcement. We accept only the project's source locale here —
  // a target locale would silently produce a target-language summary.
  if (!input.sourceLocale || input.sourceLocale.trim().length === 0) {
    throw new SceneSummaryLocaleMismatchError("<project sourceLocale>", input.sourceLocale ?? "");
  }

  const templateVersion = input.promptTemplateVersion ?? PROMPT_TEMPLATE_VERSION_V1;
  const rendered = buildPrompt(input);
  const hash = promptHash(rendered);

  const messages: ModelMessage[] = [
    { role: "system", content: rendered.systemText },
    { role: "user", content: rendered.userText },
  ];

  const request: ModelInvocationRequest = {
    taskKind: "experiment",
    modelId: input.modelProfile.modelId,
    providerId: input.modelProfile.providerId,
    inputClassification: "private_corpus",
    messages,
    prompt: {
      presetId: "itotori-scene-summary",
      templateVersion,
      promptHash: `sha256:${hash}`,
    },
    generation:
      input.modelProfile.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: input.modelProfile.maxOutputTokens },
  };

  const supervised: { invocation: ModelInvocationResult; parsed: string } =
    await executeStructuredInvocation(options.provider, {
      request,
      parse: (raw) => raw.trim(),
      validateParsed: () => undefined,
      successDecision: "advance",
    });
  const { invocation, parsed: summaryText } = supervised;
  const providerRun: ProviderRunRecord = invocation.providerRun;

  const now = (input.now ?? (() => new Date()))();

  // `inputTokenEstimate` is an explicit pre-flight estimate stored in a
  // field that names itself as such — honest provenance, not a real count.
  const inputTokenEstimate = estimateTokens(`${rendered.systemText}\n${rendered.userText}`);
  // `completionTokens` is a REAL count: throw on absence rather than
  // substitute an estimate (PROJECT LAW, mirror of assertBilledCost).
  const completionTokens = assertReportedTokenCount(
    providerRun.tokenUsage,
    "completionTokens",
    providerRun.runId,
  );

  const id = input.sceneSummaryId ?? createUuid7();
  const citedUnitIds = input.units.map((unit) => unit.bridgeUnitId);
  const citedUnitHashes = input.units.map((unit) => unit.sourceHash);

  const summary: SceneSummary = {
    id,
    projectId: input.projectId,
    localeBranchId: input.localeBranchId,
    sourceRevisionId: input.sourceRevisionId,
    sceneId: input.sceneId,
    summaryLocale: input.sourceLocale,
    summaryText,
    citedUnitIds,
    citedUnitHashes,
    modelProfile: input.modelProfile,
    promptTemplateVersion: templateVersion,
    promptHash: hash,
    inputTokenEstimate,
    completionTokens,
    generatedAt: now.toISOString(),
    status: "Fresh",
  };

  return { summary, providerRun };
}

export async function generateSceneSummaries(
  inputs: ReadonlyArray<SceneSummaryInput>,
  options: GenerateSceneSummaryOptions,
): Promise<SceneSummaryOutput[]> {
  const results: SceneSummaryOutput[] = [];
  for (const input of inputs) {
    const output = await generateSceneSummary(input, options);
    results.push(output);
  }
  return results;
}
