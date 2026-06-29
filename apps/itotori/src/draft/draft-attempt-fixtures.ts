// ITOTORI-077 - Draft attempt recorder fixtures.
//
// Three canonical shapes the recorder must round-trip cleanly:
//  - successfulAttemptFixture: one model, no fallback, live cost.
//  - fallbackChainFixture:     primary failed, fallback succeeded.
//  - recordedProviderFixture:  recorded mode (no live cost; 0.00).

import type {
  DraftAttemptFallbackChainEntry,
  DraftAttemptProviderLedgerContextRef,
  DraftAttemptProviderLedgerPolicyVersions,
} from "@itotori/db";
import type { ProviderRunRecord, TokenUsage } from "../providers/types.js";
import type {
  TranslationInvocationModelMetadata,
  TranslationInvocationResult,
  TranslationModelProfile,
} from "../agents/translation/shapes.js";
import type { TranslationDraft } from "@itotori/localization-bridge-schema";
import type { DraftAttemptRecorderArgs } from "./draft-attempt-recorder.js";

const FIXTURE_DRAFT_JOB_ATTEMPT_ID = "draft-job-attempt-fixture-01";
const FIXTURE_PROMPT_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const FIXTURE_DRAFTS: TranslationDraft[] = [
  {
    bridgeUnitId: "unit-fixture-1",
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    draftText: "Hello fixture",
    confidenceFloor: "medium",
    protectedSpanRefs: [],
    citationRefs: [],
    agentRationale: "fixture rationale",
  },
];

const FIXTURE_POLICY_VERSIONS: DraftAttemptProviderLedgerPolicyVersions = {
  styleGuide: "style-guide-v1",
  glossary: "glossary-v1",
};

const FIXTURE_CONTEXT_REFS: DraftAttemptProviderLedgerContextRef[] = [
  {
    contextArtifactId: "context-scene-001",
    category: "scene-summary",
    contentHash: "context-hash-001",
  },
];

function fixtureTokenUsage(): TokenUsage {
  return {
    tokenCountSource: "provider_reported",
    promptTokens: 480,
    completionTokens: 220,
    totalTokens: 700,
  };
}

function fixtureProviderRun(overrides: Partial<ProviderRunRecord> = {}): ProviderRunRecord {
  return {
    runId: "provider-run-success-01",
    taskKind: "draft_translation",
    startedAt: "2026-06-23T12:00:00.000Z",
    completedAt: "2026-06-23T12:00:01.200Z",
    latencyMs: 1200,
    status: "succeeded",
    provider: {
      providerFamily: "openrouter",
      endpointFamily: "chat-completions",
      providerName: "openrouter:test",
      requestedModelId: "anthropic/claude-3.5-sonnet",
      requestedProviderId: "anthropic",
      actualModelId: "anthropic/claude-3.5-sonnet",
      upstreamProvider: "anthropic",
    },
    structuredOutputMode: "json_schema",
    retryCount: 0,
    errorClasses: [],
    fallbackUsed: false,
    fallbackPlan: ["anthropic/claude-3.5-sonnet"],
    tokenUsage: fixtureTokenUsage(),
    cost: {
      costKind: "billed",
      currency: "USD",
      // ITOTORI-232 — authoritative full-precision cost; the recorder
      // persists this verbatim as cost_amount. 0.0125 USD = 12_500 micros.
      amountUsd: "0.0125",
      amountMicrosUsd: 12_500,
    },
    // ITOTORI-230 — canonical alpha posture for a fixture LIVE OR run.
    routingPosture: {
      only: ["anthropic"],
      allow_fallbacks: false,
      data_collection: "deny",
      zdr: true,
      require_parameters: true,
    },
    // ITOTORI-232 — `cost.amountUsd` (0.0125) mirrors `usage.cost` below,
    // so the recorder's cost_amount and usage_response_json->>'cost'
    // originate from the same value and the DB CHECK passes by construction.
    usageResponseJson: {
      prompt_tokens: 480,
      completion_tokens: 220,
      total_tokens: 700,
      cost: 0.0125,
    },
    prompt: {
      presetId: "itotori-translation-agent",
      templateVersion: "itotori-translation-agent-v1",
      promptHash: `sha256:${FIXTURE_PROMPT_HASH}`,
    },
    ...overrides,
  };
}

function fixtureModelProfile(): TranslationModelProfile {
  return {
    providerFamily: "openrouter",
    modelId: "anthropic/claude-3.5-sonnet",
    providerId: "anthropic",
    contextWindowTokens: 200_000,
    maxOutputTokens: 8_192,
  };
}

function fixtureModelMetadata(providerRun: ProviderRunRecord): TranslationInvocationModelMetadata {
  return {
    modelProfile: fixtureModelProfile(),
    providerIdentity: providerRun.provider,
    providerRun,
  };
}

function fixtureTranslationResult(
  providerRun: ProviderRunRecord,
  recordedArtifactId?: string,
): TranslationInvocationResult {
  const result: TranslationInvocationResult = {
    drafts: FIXTURE_DRAFTS,
    providerRunId: providerRun.runId,
    promptHashUsed: FIXTURE_PROMPT_HASH,
    modelMetadata: fixtureModelMetadata(providerRun),
    tokensIn: providerRun.tokenUsage.promptTokens ?? 0,
    tokensOut: providerRun.tokenUsage.completionTokens ?? 0,
  };
  if (recordedArtifactId !== undefined) {
    result.recordedArtifactId = recordedArtifactId;
  }
  return result;
}

export function successfulAttemptFixture(
  overrides: Partial<DraftAttemptRecorderArgs> = {},
): DraftAttemptRecorderArgs {
  const providerRun = fixtureProviderRun();
  return {
    draftJobAttemptId: FIXTURE_DRAFT_JOB_ATTEMPT_ID,
    translationResult: fixtureTranslationResult(providerRun),
    fallbackChain: [],
    latencyMs: providerRun.latencyMs,
    policyVersions: { ...FIXTURE_POLICY_VERSIONS },
    contextArtifactRefs: [...FIXTURE_CONTEXT_REFS],
    promptTemplateVersion: "itotori-translation-agent-v1",
    ...overrides,
  };
}

export function fallbackChainFixture(
  overrides: Partial<DraftAttemptRecorderArgs> = {},
): DraftAttemptRecorderArgs {
  const providerRun = fixtureProviderRun({
    runId: "provider-run-fallback-01",
    fallbackUsed: true,
    fallbackPlan: ["anthropic/claude-3.5-sonnet", "openai/gpt-4o-mini"],
    provider: {
      providerFamily: "openrouter",
      endpointFamily: "chat-completions",
      providerName: "openrouter:test",
      requestedModelId: "anthropic/claude-3.5-sonnet",
      requestedProviderId: "anthropic",
      actualModelId: "openai/gpt-4o-mini",
      upstreamProvider: "openai",
    },
    retryCount: 1,
    latencyMs: 2400,
    completedAt: "2026-06-23T12:00:02.400Z",
    // ITOTORI-232 — fallback fixture's billed cost is 0.0085 USD; the
    // authoritative `amountUsd` and `usageResponseJson.cost` carry the
    // same upstream value so cost_amount mirrors it on persist.
    cost: {
      costKind: "billed",
      currency: "USD",
      amountUsd: "0.0085",
      amountMicrosUsd: 8_500,
    },
    usageResponseJson: {
      prompt_tokens: 480,
      completion_tokens: 220,
      total_tokens: 700,
      cost: 0.0085,
    },
  });
  const fallbackChain: DraftAttemptFallbackChainEntry[] = [
    {
      modelProviderFamily: "openrouter",
      modelId: "anthropic/claude-3.5-sonnet",
      failureReason: "provider_http_error: upstream 503",
      attemptedAt: "2026-06-23T12:00:00.000Z",
    },
  ];
  return {
    draftJobAttemptId: FIXTURE_DRAFT_JOB_ATTEMPT_ID,
    translationResult: fixtureTranslationResult(providerRun),
    fallbackChain,
    latencyMs: providerRun.latencyMs,
    policyVersions: { ...FIXTURE_POLICY_VERSIONS },
    contextArtifactRefs: [...FIXTURE_CONTEXT_REFS],
    promptTemplateVersion: "itotori-translation-agent-v1",
    ...overrides,
  };
}

export function recordedProviderFixture(
  overrides: Partial<DraftAttemptRecorderArgs> = {},
): DraftAttemptRecorderArgs {
  const providerRun = fixtureProviderRun({
    runId: "provider-run-recorded-01",
    provider: {
      providerFamily: "recorded",
      endpointFamily: "recorded-fixture",
      providerName: "recorded:fixture-bundle",
      requestedModelId: "anthropic/claude-3.5-sonnet",
      requestedProviderId: "anthropic",
      actualModelId: "anthropic/claude-3.5-sonnet",
      upstreamProvider: "anthropic",
    },
    // ITOTORI-228 — recorded-mode fixture: the replayed providerRun.cost
    // mirrors the captured `usage.cost`. This synthetic fixture stands
    // in for a session that genuinely produced no charge upstream (no
    // LIVE OR call was ever taken to back it), so `ZERO_COST` is the
    // structurally honest mirror. A future re-record from a real LIVE
    // capture will replace this with the actual `usage.cost` value the
    // recorded-bundle response carries.
    cost: {
      costKind: "zero",
      currency: "USD",
      amountUsd: "0",
      amountMicrosUsd: 0,
    },
    // ITOTORI-232 — synthetic recorded fixture never backed a real OR
    // call, so usage carries no `cost` key. The partial-NULL CHECK
    // exempts the row. The sentinel key documents WHY no billed-cost
    // field exists ("the bundle was synthesised offline").
    usageResponseJson: {
      _synthetic_recorded_fixture: true,
      prompt_tokens: 480,
      completion_tokens: 220,
      total_tokens: 700,
    },
  });
  return {
    draftJobAttemptId: FIXTURE_DRAFT_JOB_ATTEMPT_ID,
    translationResult: fixtureTranslationResult(providerRun, "recorded-bundle-01"),
    fallbackChain: [],
    latencyMs: providerRun.latencyMs,
    recordedProviderBundleId: "recorded-bundle-01",
    policyVersions: { ...FIXTURE_POLICY_VERSIONS },
    contextArtifactRefs: [...FIXTURE_CONTEXT_REFS],
    promptTemplateVersion: "itotori-translation-agent-v1",
    ...overrides,
  };
}

export const DRAFT_ATTEMPT_FIXTURE_DRAFT_JOB_ATTEMPT_ID = FIXTURE_DRAFT_JOB_ATTEMPT_ID;
export const DRAFT_ATTEMPT_FIXTURE_PROMPT_HASH = FIXTURE_PROMPT_HASH;
