// ITOTORI-077 - Draft attempt recorder fixtures.
//
// Three canonical shapes the recorder must round-trip cleanly:
//  - successfulAttemptFixture: one model, no fallback.
//  - fallbackChainFixture:     primary failed, fallback succeeded.
//  - recordedProviderFixture:  recorded mode (recorded-bundle id present).
//
// PROJECT LAW (Trevor, 2026-06-25): a model cost is NEVER approximated or
// fabricated — it is only ever the verbatim `usage.cost` of a real
// OpenRouter call. These fixtures are SYNTHETIC: no live OR call was ever
// taken to back them, so they carry the canonical `ZERO_COST` sentinel and
// a `_synthetic_fixture` usage marker (no `cost` key) instead of an invented
// dollar amount. This is the structurally honest mirror of "no real charge
// was observed". A test that needs a non-zero billed cost must source it
// from a captured recorded-bundle artifact under
// apps/itotori/test/fixtures/recorded-bundles/, never from a literal here.

import type {
  DraftAttemptFallbackChainEntry,
  DraftAttemptProviderLedgerContextRef,
  DraftAttemptProviderLedgerPolicyVersions,
} from "@itotori/db";
import type { ProviderRunRecord, TokenUsage } from "../providers/types.js";
import { ZERO_COST } from "../providers/cost.js";
import { assertReportedTokenUsage } from "../providers/token-accounting.js";
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
    // PROJECT LAW: no fabricated cost. This synthetic fixture never backed a
    // real OR call, so the only honest cost is the canonical ZERO_COST
    // sentinel — never an invented dollar amount. The recorder persists
    // `amountUsd` ("0") verbatim as cost_amount.
    cost: { ...ZERO_COST },
    // ITOTORI-230 — canonical alpha posture for a fixture OR run.
    routingPosture: {
      order: ["anthropic"],
      allow_fallbacks: true,
      data_collection: "deny",
      zdr: true,
      require_parameters: true,
    },
    // Synthetic fixture: no real OR call, so usage carries NO `cost` key.
    // The partial-NULL migration-0041 CHECK exempts the row; the
    // `_synthetic_fixture` marker documents WHY no billed-cost field exists.
    usageResponseJson: {
      _synthetic_fixture: true,
      prompt_tokens: 480,
      completion_tokens: 220,
      total_tokens: 700,
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
  // PROJECT LAW (general-audit-1): fixtures carry REAL token counts drawn
  // from the provider run via the same guard production uses — never a
  // `?? 0` coercion.
  const { tokensIn, tokensOut } = assertReportedTokenUsage(
    providerRun.tokenUsage,
    providerRun.runId,
  );
  const result: TranslationInvocationResult = {
    drafts: FIXTURE_DRAFTS,
    providerRunId: providerRun.runId,
    promptHashUsed: FIXTURE_PROMPT_HASH,
    modelMetadata: fixtureModelMetadata(providerRun),
    tokensIn,
    tokensOut,
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
    // Cost + usage inherit the base synthetic ZERO_COST shape (no fabricated
    // amount). The fallback fixture exercises the fallback-chain / actual-
    // model plumbing, not a billed-cost value.
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
    // ITOTORI-228 — recorded-mode fixture. Cost inherits the base synthetic
    // ZERO_COST shape: this fixture stands in for a session that genuinely
    // produced no charge upstream (no LIVE OR call was ever taken to back
    // it), so `ZERO_COST` is the structurally honest mirror. A future
    // re-record from a real LIVE capture will replace this with the actual
    // `usage.cost` value the recorded-bundle response carries.
    //
    // The usage marker is recorded-specific so the offline-synthesis origin
    // is self-documenting (no `cost` key → partial-NULL CHECK exempts the row).
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
