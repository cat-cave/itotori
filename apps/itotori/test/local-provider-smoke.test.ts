// ITOTORI-036 — local OpenAI-compatible provider (LM Studio-style) smoke.
//
// Proves, with NO live network call (a deterministic mock fetch stands in
// for the localhost /v1/chat/completions endpoint), that:
//
//   1. the local adapter can DRAFT (TranslationAgent) and QA (QaAgent)
//      fixture batches through the same ModelProvider seam OpenRouter uses,
//   2. its capability GAPS vs the OpenRouter provider are reported
//      explicitly (visible, not silently assumed-equivalent), and
//   3. its cost is recorded as costKind:"zero" (an explicit cost KIND, not
//      a hardcoded literal) and a MIXED run does NOT corrupt the OpenRouter
//      real-cost aggregate report — the local zero rows sum to 0 and stay
//      tagged in a separate cost-kind bucket.

import { describe, expect, it, vi } from "vitest";
import {
  makeStructuredTranslationDraftOutputFixture,
  representativeTranslationDraftsFixture,
  TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE,
  TRANSLATION_FIXTURE_DRAFT_JOB_ATTEMPT_ID,
  TRANSLATION_FIXTURE_DRAFT_JOB_ID,
  TRANSLATION_FIXTURE_LOCALE_BRANCH_ID,
  TRANSLATION_FIXTURE_PROJECT_ID,
  TRANSLATION_FIXTURE_SOURCE_LOCALE,
  TRANSLATION_FIXTURE_TARGET_LOCALE,
  TranslationAgent,
  type TranslationBridgeUnit,
  type TranslationInvocationInput,
  type TranslationModelProfile,
  type TranslationProtectedSpanInput,
} from "../src/agents/translation/index.js";
import {
  makeStructuredQaFindingOutputFixture,
  QaAgent,
  representativeQaFindingsFixture,
  type QaBridgeUnit,
  type QaInvocationInput,
  type QaModelProfile,
} from "../src/agents/qa/index.js";
import {
  describeLocalProviderCapabilityGaps,
  LocalOpenAICompatibleProvider,
  localOpenAICompatibleDefaultCapabilities,
  OpenRouterModelProvider,
  summarizeLocalProviderCapabilityGaps,
} from "../src/providers/index.js";
import type {
  ModelInvocationRequest,
  ProviderRunArtifact,
  ProviderRunArtifactRecorder,
} from "../src/providers/types.js";
import { aggregateProviderRunArtifacts } from "../src/telemetry/provider-run-artifact-source.js";

const FIXED_ACTOR = { userId: "local-user" };
const LOCAL_BASE_URL = "http://127.0.0.1:1234/v1";
const LOCAL_MODEL_ID = "local-model";
const LOCAL_PROVIDER_ID = "lmstudio";

// --------------------------------------------------------------------------
// In-memory artifact recorder shared across providers so the mixed-run cost
// aggregate observes local (zero) + OpenRouter (billed) runs together.
// --------------------------------------------------------------------------
function memoryRecorder(): ProviderRunArtifactRecorder & { artifacts: ProviderRunArtifact[] } {
  const artifacts: ProviderRunArtifact[] = [];
  return {
    artifacts,
    recordProviderRun: async (artifact: ProviderRunArtifact) => {
      artifacts.push(artifact);
    },
  };
}

// A deterministic mock of the localhost OpenAI-compatible chat-completions
// endpoint. Returns `content` verbatim as choices[0].message.content with a
// clean `stop` and provider-reported token usage. No `cost` key: local
// inference never bills (the adapter records costKind:"zero").
function mockLocalEndpoint(content: string): typeof fetch {
  return vi.fn(async () => {
    return new Response(
      JSON.stringify({
        model: LOCAL_MODEL_ID,
        choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
        usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

function buildLocalProvider(
  content: string,
  recorder: ProviderRunArtifactRecorder,
): LocalOpenAICompatibleProvider {
  return new LocalOpenAICompatibleProvider({
    modelId: LOCAL_MODEL_ID,
    providerName: LOCAL_PROVIDER_ID,
    baseUrl: LOCAL_BASE_URL,
    fetch: mockLocalEndpoint(content),
    // The DEFAULT local sheet (plainJsonExtraction:"supported", everything
    // else untested/unsupported) is enough to drive the agents via the
    // plain_json ZDR-fallback mode — no capability override needed.
    capabilities: localOpenAICompatibleDefaultCapabilities,
    live: { enabled: true, artifactRecorder: recorder, rawCapture: "disabled" },
  });
}

// --------------------------------------------------------------------------
// Draft / QA input fixtures (self-contained; mirror the agent unit tests).
// --------------------------------------------------------------------------
function localTranslationProfile(): TranslationModelProfile {
  return {
    providerFamily: "local-openai-compatible",
    modelId: LOCAL_MODEL_ID,
    providerId: LOCAL_PROVIDER_ID,
    contextWindowTokens: 16000,
    maxOutputTokens: 1024,
  };
}

function translationUnits(): TranslationBridgeUnit[] {
  return [
    {
      bridgeUnitId: `${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}01`,
      sourceUnitKey: "scene.001.line.001",
      sourceText: "こんにちは、{player}。",
      sourceHash: "src-hash-1",
      speaker: "narration",
    },
    {
      bridgeUnitId: `${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}02`,
      sourceUnitKey: "scene.001.line.002",
      sourceText: "勇者は王様に挨拶した。",
      sourceHash: "src-hash-2",
      speaker: "narration",
    },
    {
      bridgeUnitId: `${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}03`,
      sourceUnitKey: "scene.001.line.003",
      sourceText: "魔王城の<ruby>入口</ruby>に到着した。",
      sourceHash: "src-hash-3",
      speaker: "narration",
    },
  ];
}

function translationProtectedSpans(): Map<string, TranslationProtectedSpanInput[]> {
  return new Map<string, TranslationProtectedSpanInput[]>([
    [
      `${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}01`,
      [{ refId: "span-greeting-placeholder", sourceText: "{player}" }],
    ],
    [`${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}02`, []],
    [
      `${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}03`,
      [
        { refId: "span-ruby-open", sourceText: "<ruby>" },
        { refId: "span-ruby-close", sourceText: "</ruby>" },
      ],
    ],
  ]);
}

function translationInput(): TranslationInvocationInput {
  return {
    draftJobId: TRANSLATION_FIXTURE_DRAFT_JOB_ID,
    draftJobAttemptId: TRANSLATION_FIXTURE_DRAFT_JOB_ATTEMPT_ID,
    projectId: TRANSLATION_FIXTURE_PROJECT_ID,
    localeBranchId: TRANSLATION_FIXTURE_LOCALE_BRANCH_ID,
    sourceLocale: TRANSLATION_FIXTURE_SOURCE_LOCALE,
    targetLocale: TRANSLATION_FIXTURE_TARGET_LOCALE,
    sourceBridgeUnits: translationUnits(),
    protectedSpansBySource: translationProtectedSpans(),
    glossary: [
      {
        termId: "glossary:term-greeting",
        preferredSourceForm: "こんにちは",
        preferredTargetForm: "Hello",
        policyAction: "localize",
      },
      {
        termId: "glossary:term-yusha",
        preferredSourceForm: "勇者",
        preferredTargetForm: "hero",
        policyAction: "localize",
      },
    ],
    styleGuide: [{ ruleId: "tone-001", section: "tone", guidance: "Use a formal register." }],
    contextArtifactRefs: ["context-artifact:scene-summary-001"],
    modelProfile: localTranslationProfile(),
    promptTemplateVersion: "itotori-translation-agent-v1",
  };
}

function localQaProfile(): QaModelProfile {
  return {
    providerFamily: "local-openai-compatible",
    modelId: LOCAL_MODEL_ID,
    providerId: LOCAL_PROVIDER_ID,
    contextWindowTokens: 16000,
    maxOutputTokens: 1024,
  };
}

// QA findings from representativeQaFindingsFixture() cite bridge units a01..a04.
const QA_UNIT_BASE = "019ed079-0000-7000-8000-000000000a";
function qaUnits(): QaBridgeUnit[] {
  return [1, 2, 3, 4].map((n) => {
    const suffix = n.toString().padStart(2, "0");
    return {
      bridgeUnitId: `${QA_UNIT_BASE}${suffix}`,
      sourceUnitKey: `scene.001.line.${suffix}`,
      sourceText: "こんにちは、{player}。",
      sourceHash: `src-hash-${n}`,
      draftText: "Hello.",
      draftHash: `drf-hash-${n}`,
      speaker: "narration",
    };
  });
}

function qaInput(): QaInvocationInput {
  return {
    draftJobId: "019ed079-0000-7000-8000-000000000d00",
    projectId: "019ed079-0000-7000-8000-000000000001",
    localeBranchId: "019ed079-0000-7000-8000-000000000002",
    sourceRevisionId: "019ed079-0000-7000-8000-000000000003",
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    units: qaUnits(),
    glossary: [
      {
        termId: "019ed079-0000-7000-8000-00000000b001",
        preferredSourceForm: "勇者",
        preferredTargetForm: "hero",
        policyAction: "localize",
      },
    ],
    styleGuide: [{ ruleId: "tone-001", section: "tone", guidance: "Use a formal register." }],
    modelProfile: localQaProfile(),
    qaPromptVersion: "itotori-qa-agent-v1",
  };
}

// A billed OpenRouter chat-completion response (mock fetch). `usageCost` is a
// synthetic per-call spend that stands in for the real usage.cost the live
// wire returns; it exercises the billed cost-report path.
function billedOpenRouterResponse(usageCost: number): Response {
  return new Response(
    JSON.stringify({
      id: "gen-local-smoke",
      model: "deepseek/deepseek-v4-flash",
      provider: "fireworks",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: usageCost }, // itotori-225-audit-allow: synthetic mock-wire usage.cost, not a real captured billed amount
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function openRouterRequest(): ModelInvocationRequest {
  return {
    taskKind: "experiment",
    modelId: "deepseek/deepseek-v4-flash",
    providerId: "fireworks",
    inputClassification: "synthetic_public",
    prompt: {
      presetId: "itotori-036-smoke",
      templateVersion: "1.0.0",
      promptHash: `sha256:${"a".repeat(64)}`,
    },
    messages: [{ role: "user", content: "hello" }],
  };
}

// --------------------------------------------------------------------------
describe("ITOTORI-036 local provider: draft + QA loops (no live call)", () => {
  it("drafts a fixture batch through TranslationAgent using the local endpoint", async () => {
    const recorder = memoryRecorder();
    const drafts = representativeTranslationDraftsFixture();
    const provider = buildLocalProvider(
      JSON.stringify(makeStructuredTranslationDraftOutputFixture(drafts)),
      recorder,
    );
    const result = await new TranslationAgent({ provider }).invokeTranslation(
      FIXED_ACTOR,
      translationInput(),
    );

    expect(result.drafts).toEqual(drafts);
    expect(result.tokensIn).toBe(24);
    expect(result.tokensOut).toBe(12);
    expect(result.modelMetadata.providerRun.provider.providerFamily).toBe(
      "local-openai-compatible",
    );
    // Local runs record an explicit ZERO cost KIND — never a billed amount.
    expect(result.modelMetadata.providerRun.cost).toMatchObject({
      costKind: "zero",
      amountMicrosUsd: 0,
      amountUsd: "0",
    });
    expect(recorder.artifacts).toHaveLength(1);
    expect(recorder.artifacts[0]?.run.provider.requestedProviderId).toBe(LOCAL_PROVIDER_ID);
  });

  it("QAs a fixture batch through QaAgent using the local endpoint", async () => {
    const recorder = memoryRecorder();
    const findings = representativeQaFindingsFixture();
    const provider = buildLocalProvider(
      JSON.stringify(makeStructuredQaFindingOutputFixture(findings)),
      recorder,
    );
    const result = await new QaAgent({ provider }).invokeQa(FIXED_ACTOR, qaInput());

    expect(result.findings).toEqual(findings);
    expect(result.modelMetadata.providerRun.taskKind).toBe("llm_qa");
    expect(result.modelMetadata.providerRun.cost.costKind).toBe("zero");
    expect(recorder.artifacts).toHaveLength(1);
  });
});

describe("ITOTORI-036 local provider: capability gaps are visible", () => {
  it("reports the headline gaps vs the OpenRouter provider", () => {
    const provider = buildLocalProvider("{}", memoryRecorder());
    const report = describeLocalProviderCapabilityGaps(provider.descriptor);

    expect(report.hasRealBilledCost).toBe(false);
    expect(report.hasZeroDataRetentionAttestation).toBe(false);
    const axes = report.gaps.map((g) => g.axis);
    // The two headline gaps the task calls out: no real cost, no ZDR attestation.
    expect(axes).toContain("cost.billed");
    expect(axes).toContain("routing.zeroDataRetentionRouting");
    // Routing / structured-output / tool gaps are surfaced too.
    expect(axes).toContain("routing.providerRouting");
    expect(axes).toContain("routing.modelFallbacks");
    expect(axes).toContain("structuredOutputs.jsonSchema");
    expect(axes).toContain("toolCalls.support");

    const costGap = report.gaps.find((g) => g.axis === "cost.billed");
    expect(costGap).toMatchObject({ dimension: "cost", kind: "hard_gap", localStatus: "zero" });
    const zdrGap = report.gaps.find((g) => g.axis === "routing.zeroDataRetentionRouting");
    expect(zdrGap).toMatchObject({ dimension: "privacy", kind: "hard_gap" });

    // Human-readable surface is non-empty and deterministic.
    const lines = summarizeLocalProviderCapabilityGaps(report);
    expect(lines[0]).toContain("realBilledCost=false");
    expect(lines).toEqual(summarizeLocalProviderCapabilityGaps(report));
    expect(lines.length).toBe(report.gaps.length + 1);
  });
});

describe("ITOTORI-036 cost accounting: local zero must not corrupt OpenRouter reports", () => {
  it("a mixed run keeps the OpenRouter real-cost aggregate intact", async () => {
    const recorder = memoryRecorder();

    // Two billed OpenRouter runs (real cost path) → the OpenRouter report.
    const orCosts = [0.000042, 0.000007];
    const responses = orCosts.map((c) => billedOpenRouterResponse(c));
    let call = 0;
    const httpClient = vi.fn(async () => responses[call++]!) as unknown as typeof fetch;
    const orProvider = new OpenRouterModelProvider({
      env: { OPENROUTER_API_KEY: "abc", OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1" },
      httpClient,
      artifactRecorder: recorder,
    });
    await orProvider.invoke(openRouterRequest());
    await orProvider.invoke(openRouterRequest());

    // Snapshot the OpenRouter-ONLY report before any local run is recorded.
    const orOnlyArtifacts = [...recorder.artifacts];
    const orOnly = aggregateProviderRunArtifacts(orOnlyArtifacts);
    const orPairKey = Object.keys(orOnly.summary.byPair)[0]!;

    // Now DRAFT + QA through the local endpoint into the SAME recorder.
    await new TranslationAgent({
      provider: buildLocalProvider(
        JSON.stringify(
          makeStructuredTranslationDraftOutputFixture(representativeTranslationDraftsFixture()),
        ),
        recorder,
      ),
    }).invokeTranslation(FIXED_ACTOR, translationInput());
    await new QaAgent({
      provider: buildLocalProvider(
        JSON.stringify(makeStructuredQaFindingOutputFixture(representativeQaFindingsFixture())),
        recorder,
      ),
    }).invokeQa(FIXED_ACTOR, qaInput());

    const mixed = aggregateProviderRunArtifacts(recorder.artifacts);

    // (1) The overall billed total is UNCHANGED by the local zero runs.
    expect(mixed.summary.totalCostUsd).toBe(orOnly.summary.totalCostUsd);
    expect(Number(mixed.summary.totalCostUsd)).toBeCloseTo(orCosts[0]! + orCosts[1]!, 12);

    // (2) The OpenRouter pair's per-pair cost row is byte-identical.
    expect(mixed.summary.byPair[orPairKey]).toEqual(orOnly.summary.byPair[orPairKey]);

    // (3) The local pair appears as its OWN pair, contributing ZERO cost,
    //     tagged in a separate cost-kind bucket — never merged into billed.
    const localPairKey = Object.keys(mixed.summary.byPair).find((k) => k !== orPairKey)!;
    expect(mixed.summary.byPair[localPairKey]!.totalCostUsd).toBe("0.00000000");

    const orCostKinds = mixed.costKindRows.filter((r) => r.pair === orPairKey);
    expect(orCostKinds).toEqual([
      expect.objectContaining({ costKind: "billed", invocationCount: 2 }),
    ]);
    const localCostKinds = mixed.costKindRows.filter((r) => r.pair === localPairKey);
    expect(localCostKinds).toEqual([
      expect.objectContaining({ costKind: "zero", amountMicrosUsd: 0 }),
    ]);
    // No billed row ever attributed to the local pair.
    expect(localCostKinds.some((r) => r.costKind === "billed")).toBe(false);
  });
});
