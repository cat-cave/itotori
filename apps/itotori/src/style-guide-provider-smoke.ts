import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  projectStyleGuideConversationToPolicyDraft,
  validateStyleGuideConversationTranscript,
  type StyleGuideConversationDiagnostic,
  type StyleGuideConversationTranscript,
  type StyleGuideProjectedVersionDraft,
} from "@itotori/localization-bridge-schema";
import {
  OpenRouterProvider,
  openRouterApiKeyFromEnv,
  openRouterDefaultCapabilities,
  type JsonObject,
  type ModelCapabilities,
  type ModelInvocationRequest,
  type ModelInvocationResult,
  type ProviderLiveRunOptions,
  type ProviderRunArtifact,
  type ProviderRunArtifactRecorder,
  type ProviderRunRecord,
} from "./providers/index.js";

export const STYLE_GUIDE_PROVIDER_SMOKE_SCHEMA_VERSION =
  "itotori.style-guide-provider-smoke.v0" as const;
export const STYLE_GUIDE_SUGGESTION_TOOL_NAME = "emit_style_guide_suggestion";
export const STYLE_GUIDE_LIVE_PROVIDER_SMOKE_FLAG = "ITOTORI_STYLE_GUIDE_LIVE_PROVIDER_SMOKE";
export const STYLE_GUIDE_LIVE_PROVIDER_MODEL_ENV = "ITOTORI_STYLE_GUIDE_PROVIDER_MODEL";

export type StyleGuideProviderSmokeFixture = {
  schemaVersion: typeof STYLE_GUIDE_PROVIDER_SMOKE_SCHEMA_VERSION;
  fixtureId: string;
  providerResult: {
    finishReason: string;
    contentJson: unknown;
  };
  providerRun: ProviderRunRecord;
  expected: {
    acceptedProposalIds: string[];
    ruleIds: string[];
  };
};

export type ParsedStyleGuideSuggestion = {
  transcript: StyleGuideConversationTranscript;
  projectedVersion: StyleGuideProjectedVersionDraft;
  diagnostics: StyleGuideConversationDiagnostic[];
};

export type StyleGuideProviderSmokeResult =
  | {
      status: "passed";
      mode: "recorded" | "live";
      fixtureId: string;
      parsed: ParsedStyleGuideSuggestion;
      providerRun: ProviderRunRecord;
      artifacts: ProviderRunArtifact[];
    }
  | {
      status: "skipped";
      mode: "live";
      reason: "missing_opt_in" | "missing_provider_credential";
    };

export type StyleGuideProviderSmokeOptions = {
  fixture?: StyleGuideProviderSmokeFixture;
  fixturePath?: string;
  env?: Record<string, string | undefined>;
  mode?: "recorded" | "live";
  fetch?: typeof fetch;
  live?: ProviderLiveRunOptions;
};

const defaultFixtureUrl = new URL(
  "../../../fixtures/itotori-style-guide/provider-smoke-suggestion.json",
  import.meta.url,
);

export async function runStyleGuideProviderSmoke(
  options: StyleGuideProviderSmokeOptions = {},
): Promise<StyleGuideProviderSmokeResult> {
  const mode = options.mode ?? "recorded";
  if (mode === "recorded") {
    return runRecordedStyleGuideProviderSmoke(
      options.fixture ?? readSmokeFixture(options.fixturePath),
    );
  }
  return runLiveStyleGuideProviderSmoke(options);
}

export function runRecordedStyleGuideProviderSmoke(
  fixture: StyleGuideProviderSmokeFixture,
): StyleGuideProviderSmokeResult {
  assertSmokeFixture(fixture);
  const result: ModelInvocationResult = {
    content: JSON.stringify(fixture.providerResult.contentJson),
    toolCalls: [],
    finishReason: fixture.providerResult.finishReason,
    providerRun: fixture.providerRun,
  };
  const parsed = parseStyleGuideSuggestionFromProviderResult(result);
  assertStyleGuideProviderSmokeLedger(fixture.providerRun);
  assertExpectedStyleGuideSuggestion(parsed, fixture.expected);
  return {
    status: "passed",
    mode: "recorded",
    fixtureId: fixture.fixtureId,
    parsed,
    providerRun: fixture.providerRun,
    artifacts: [],
  };
}

export async function runLiveStyleGuideProviderSmoke(
  options: StyleGuideProviderSmokeOptions = {},
): Promise<StyleGuideProviderSmokeResult> {
  const env = options.env ?? process.env;
  if (env[STYLE_GUIDE_LIVE_PROVIDER_SMOKE_FLAG] !== "1") {
    return { status: "skipped", mode: "live", reason: "missing_opt_in" };
  }
  const apiKey = openRouterApiKeyFromEnv(env);
  if (!apiKey) {
    return { status: "skipped", mode: "live", reason: "missing_provider_credential" };
  }

  const recorder = memoryRecorder();
  const providerOptions: ConstructorParameters<typeof OpenRouterProvider>[0] = {
    modelId: env[STYLE_GUIDE_LIVE_PROVIDER_MODEL_ENV] ?? "deepseek/deepseek-v4-flash",
    apiKey,
    capabilities: styleGuideLiveSmokeCapabilities(),
    routing: { allowFallbacks: true, dataCollection: "deny" },
    live: options.live ?? { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
  };
  if (options.fetch !== undefined) {
    providerOptions.fetch = options.fetch;
  }
  const provider = new OpenRouterProvider({
    ...providerOptions,
  });
  const request = styleGuideSuggestionRequest(provider.descriptor.defaultModelId);
  const result = await provider.invoke(request);
  const parsed = parseStyleGuideSuggestionFromProviderResult(result);
  assertStyleGuideProviderSmokeLedger(result.providerRun);
  return {
    status: "passed",
    mode: "live",
    fixtureId: "style-guide-live-provider-smoke",
    parsed,
    providerRun: result.providerRun,
    artifacts: recorder.artifacts,
  };
}

export function parseStyleGuideSuggestionFromProviderResult(
  result: ModelInvocationResult,
): ParsedStyleGuideSuggestion {
  const value =
    result.providerRun.structuredOutputMode === "tool_call_arguments"
      ? parseToolCallSuggestion(result)
      : parseJsonContent(result.content);
  const diagnostics = validateStyleGuideConversationTranscript(value);
  if (diagnostics.length > 0) {
    const first = diagnostics[0] ?? {
      turnId: "transcript",
      field: "$",
      rule: "style_guide_conversation.unknown",
      message: "style-guide suggestion failed validation",
    };
    throw new Error(
      `style-guide suggestion validation failed at ${first.field} (${first.rule}): ${first.message}`,
    );
  }
  return {
    transcript: value as StyleGuideConversationTranscript,
    projectedVersion: projectStyleGuideConversationToPolicyDraft(value),
    diagnostics,
  };
}

export function styleGuideSuggestionRequest(modelId: string): ModelInvocationRequest {
  return {
    taskKind: "experiment",
    modelId,
    inputClassification: "synthetic_public",
    prompt: {
      presetId: "itotori-style-guide-smoke-v1",
      templateVersion: "1.0.0",
      promptHash: "sha256:6464646464646464646464646464646464646464646464646464646464646464",
      schemaVersion: "itotori.prompt-preset.v0",
      configSnapshot: {
        fixtureId: "style-guide-live-provider-smoke",
        output: "style-guide conversation transcript",
      },
    },
    preset: {
      slug: "openrouter/itotori-style-guide-smoke",
      version: "2026-06-19",
      configHash: "sha256:6565656565656565656565656565656565656565656565656565656565656565",
      configSnapshot: {
        route: "style-guide-smoke",
        rawCapture: "disabled",
      },
    },
    messages: [
      {
        role: "system",
        content:
          "Return only a valid JSON style-guide conversation transcript for the synthetic public Itotori fixture.",
      },
      {
        role: "user",
        content: JSON.stringify({
          projectId: "019ed064-0000-7000-8000-000000000001",
          localeBranchId: "019ed064-0000-7000-8000-000000000010",
          basePolicyVersionId: "019ed064-0000-7000-8000-000000000020",
          projectedStyleGuideVersionId: "019ed064-0000-7000-8000-000000000030",
          targetLocale: "en-US",
          requestedRules: ["tone", "protectedSpans"],
        }),
      },
    ],
    structuredOutput: {
      mode: "json_schema",
      name: "itotori_style_guide_suggestion",
      strict: true,
      schema: styleGuideSuggestionJsonSchema(),
    },
    generation: {
      temperature: 0,
      maxOutputTokens: 1600,
    },
    fallbackModels: [],
  };
}

export function assertStyleGuideProviderSmokeLedger(run: ProviderRunRecord): void {
  const missing: string[] = [];
  if (!run.provider.providerFamily) {
    missing.push("provider.providerFamily");
  }
  if (!run.provider.providerName) {
    missing.push("provider.providerName");
  }
  if (!run.provider.requestedModelId || !run.provider.actualModelId) {
    missing.push("provider model identity");
  }
  if (run.fallbackPlan.length === 0) {
    missing.push("fallbackPlan");
  }
  if (!Number.isInteger(run.retryCount) || run.retryCount < 0) {
    missing.push("retryCount");
  }
  if (run.tokenUsage.tokenCountSource === "unknown" || run.tokenUsage.totalTokens === undefined) {
    missing.push("tokenUsage estimate");
  }
  if (run.cost.costKind === "unknown" || run.cost.amountMicrosUsd === undefined) {
    missing.push("cost estimate");
  }
  if (run.dataHandling.dataCollection === "unknown" || run.dataHandling.trainingUse === "unknown") {
    missing.push("data-policy flags");
  }
  if (run.dataHandling.rawCaptureDefault !== "disabled") {
    missing.push("raw capture disabled flag");
  }
  if (missing.length > 0) {
    throw new Error(`style-guide provider smoke ledger missing ${missing.join(", ")}`);
  }
}

export function readSmokeFixture(
  path = fileURLToPath(defaultFixtureUrl),
): StyleGuideProviderSmokeFixture {
  return JSON.parse(readFileSync(path, "utf8")) as StyleGuideProviderSmokeFixture;
}

function parseJsonContent(content: string | null): unknown {
  if (content === null || content.trim().length === 0) {
    throw new Error("style-guide suggestion content is empty");
  }
  return JSON.parse(content) as unknown;
}

function parseToolCallSuggestion(result: ModelInvocationResult): unknown {
  const toolCall = result.toolCalls.find((call) => call.name === STYLE_GUIDE_SUGGESTION_TOOL_NAME);
  if (!toolCall) {
    throw new Error(`style-guide suggestion tool call ${STYLE_GUIDE_SUGGESTION_TOOL_NAME} missing`);
  }
  return JSON.parse(toolCall.argumentsJson) as unknown;
}

function assertExpectedStyleGuideSuggestion(
  parsed: ParsedStyleGuideSuggestion,
  expected: StyleGuideProviderSmokeFixture["expected"],
): void {
  if (
    JSON.stringify(parsed.projectedVersion.acceptedProposalIds) !==
    JSON.stringify(expected.acceptedProposalIds)
  ) {
    throw new Error("style-guide suggestion accepted proposals did not match the recorded fixture");
  }
  const ruleIds = Object.values(parsed.projectedVersion.policy.sections)
    .flat()
    .map((rule) => rule.ruleId);
  for (const expectedRuleId of expected.ruleIds) {
    if (!ruleIds.includes(expectedRuleId)) {
      throw new Error(`style-guide suggestion missing expected rule ${expectedRuleId}`);
    }
  }
}

function assertSmokeFixture(value: StyleGuideProviderSmokeFixture): void {
  if (value.schemaVersion !== STYLE_GUIDE_PROVIDER_SMOKE_SCHEMA_VERSION) {
    throw new Error("style-guide provider smoke fixture schema version mismatch");
  }
}

function styleGuideLiveSmokeCapabilities(): ModelCapabilities {
  return {
    ...openRouterDefaultCapabilities,
    structuredOutputs: {
      ...openRouterDefaultCapabilities.structuredOutputs,
      jsonSchema: "supported",
      preferredModes: ["json_schema"],
    },
    dataHandling: {
      costTier: "paid",
      promptLogging: "disabled",
      completionLogging: "disabled",
      retention: "metadata_only",
      trainingUse: "deny",
      dataCollection: "deny",
      rawCaptureDefault: "disabled",
    },
    accountPrivacy: {
      inputOutputLogging: "disabled",
      useOfInputsOutputs: "deny",
      providerDataPolicyFilters: "enabled",
      metadataCollection: "expected",
      euRouting: "unknown",
    },
  };
}

function styleGuideSuggestionJsonSchema(): JsonObject {
  return {
    type: "object",
    required: [
      "schemaVersion",
      "transcriptId",
      "projectId",
      "localeBranchId",
      "targetLocale",
      "basePolicyVersionId",
      "projectedStyleGuideVersionId",
      "recordingMode",
      "turns",
      "proposals",
    ],
    additionalProperties: true,
    properties: {
      schemaVersion: { const: "itotori.style-guide-conversation.v0" },
      transcriptId: { type: "string" },
      projectId: { type: "string" },
      localeBranchId: { type: "string" },
      targetLocale: { type: "string" },
      basePolicyVersionId: { type: "string" },
      projectedStyleGuideVersionId: { type: "string" },
      recordingMode: { enum: ["public_fixture", "human_entered"] },
      turns: { type: "array" },
      proposals: { type: "array" },
    },
  };
}

function memoryRecorder(): ProviderRunArtifactRecorder & { artifacts: ProviderRunArtifact[] } {
  const artifacts: ProviderRunArtifact[] = [];
  return {
    artifacts,
    recordProviderRun: async (artifact: ProviderRunArtifact) => {
      artifacts.push(artifact);
    },
  };
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  const result = await runStyleGuideProviderSmoke({ mode: live ? "live" : "recorded" });
  const summary =
    result.status === "passed"
      ? {
          status: result.status,
          mode: result.mode,
          fixtureId: result.fixtureId,
          provider: result.providerRun.provider.providerName,
          model: result.providerRun.provider.actualModelId,
          acceptedProposalIds: result.parsed.projectedVersion.acceptedProposalIds,
        }
      : result;
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
