// ITOTORI-075 — Recorded-provider replay integration test for the
// translation seam.
//
// Builds a stub recorded bundle keyed on the deterministic promptHash
// and asserts that:
//   1. The translation agent successfully replays the bundle into a
//      typed TranslationInvocationResult that carries the expected
//      drafts AND the recordedArtifactId of the bundle.
//   2. Same input + same bundle → same `drafts` byte-equal across two
//      consecutive invocations (full reproducibility).
//   3. A bundle miss (wrong promptHash, etc.) is surfaced as a
//      RecordedBundleMissingError rather than silent fallback.

import { describe, expect, it } from "vitest";
import {
  STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
  type TranslationDraft,
} from "@itotori/localization-bridge-schema";
import {
  RecordedBundleMissingError,
  RecordedModelProvider,
  type RecordedProviderBundle,
} from "../src/providers/recorded.js";
import {
  buildTranslationPrompt,
  makeStructuredTranslationDraftOutputFixture,
  TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE,
  TRANSLATION_FIXTURE_DRAFT_JOB_ATTEMPT_ID,
  TRANSLATION_FIXTURE_DRAFT_JOB_ID,
  TRANSLATION_FIXTURE_LOCALE_BRANCH_ID,
  TRANSLATION_FIXTURE_PROJECT_ID,
  TRANSLATION_FIXTURE_SOURCE_LOCALE,
  TRANSLATION_FIXTURE_TARGET_LOCALE,
  TranslationAgent,
  translationPromptHash,
  type TranslationBridgeUnit,
  type TranslationInvocationInput,
  type TranslationModelProfile,
  type TranslationProtectedSpanInput,
} from "../src/agents/translation/index.js";

const FIXED_ACTOR = { userId: "local-user" };
const FIXED_NOW = (): Date => new Date("2026-06-24T12:00:00Z");

function modelProfile(): TranslationModelProfile {
  return {
    providerFamily: "fake",
    modelId: "itotori-fake-translation-v0",
    contextWindowTokens: 16000,
    maxOutputTokens: 1024,
  };
}

function unitsForRecordedTest(): TranslationBridgeUnit[] {
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
  ];
}

function protectedSpansForRecordedTest(): Map<string, TranslationProtectedSpanInput[]> {
  return new Map<string, TranslationProtectedSpanInput[]>([
    [
      `${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}01`,
      [{ refId: "span-greeting-placeholder", sourceText: "{player}" }],
    ],
    [`${TRANSLATION_FIXTURE_BRIDGE_UNIT_BASE}02`, []],
  ]);
}

function recordedInputFixture(): TranslationInvocationInput {
  return {
    draftJobId: TRANSLATION_FIXTURE_DRAFT_JOB_ID,
    draftJobAttemptId: TRANSLATION_FIXTURE_DRAFT_JOB_ATTEMPT_ID,
    projectId: TRANSLATION_FIXTURE_PROJECT_ID,
    localeBranchId: TRANSLATION_FIXTURE_LOCALE_BRANCH_ID,
    sourceLocale: TRANSLATION_FIXTURE_SOURCE_LOCALE,
    targetLocale: TRANSLATION_FIXTURE_TARGET_LOCALE,
    sourceBridgeUnits: unitsForRecordedTest(),
    protectedSpansBySource: protectedSpansForRecordedTest(),
    glossary: [
      {
        termId: "glossary:term-yusha",
        preferredSourceForm: "勇者",
        preferredTargetForm: "hero",
        policyAction: "localize",
      },
    ],
    styleGuide: [
      {
        ruleId: "tone-001",
        section: "tone",
        guidance: "Use a formal register throughout the story.",
      },
    ],
    contextArtifactRefs: ["context-artifact:scene-summary-001"],
    modelProfile: modelProfile(),
    promptTemplateVersion: "itotori-translation-agent-v1",
    now: FIXED_NOW,
  };
}

function recordedDrafts(input: TranslationInvocationInput): TranslationDraft[] {
  return [
    {
      bridgeUnitId: input.sourceBridgeUnits[0]!.bridgeUnitId,
      sourceLocale: input.sourceLocale,
      targetLocale: input.targetLocale,
      draftText: "Hello, {player}.",
      protectedSpanRefs: [{ refId: "span-greeting-placeholder", startInDraft: 7, endInDraft: 15 }],
      citationRefs: [],
      agentRationale: "Localised greeting, kept placeholder byte-equal.",
      confidenceFloor: "high",
    },
    {
      bridgeUnitId: input.sourceBridgeUnits[1]!.bridgeUnitId,
      sourceLocale: input.sourceLocale,
      targetLocale: input.targetLocale,
      draftText: "The hero greeted the king.",
      protectedSpanRefs: [],
      citationRefs: ["glossary:term-yusha"],
      agentRationale: "Applied glossary preferred form 'hero' for 勇者.",
      confidenceFloor: "medium",
    },
  ];
}

function bundleFor(
  input: TranslationInvocationInput,
  drafts: TranslationDraft[],
): RecordedProviderBundle {
  const rendered = buildTranslationPrompt(input);
  const promptHashKey = `sha256:${translationPromptHash(rendered)}`;
  return {
    bundleId: "translation-bundle-fixture-001",
    capturedProviderFamily: "openrouter",
    capturedProviderName: "openrouter:translation-judge",
    capturedRequestedModelId: input.modelProfile.modelId,
    capturedActualModelId: "openrouter:claude-opus-fixture",
    responses: {
      [promptHashKey]: {
        content: JSON.stringify(makeStructuredTranslationDraftOutputFixture(drafts)),
        finishReason: "stop",
        tokenUsage: {
          tokenCountSource: "provider_reported",
          promptTokens: 2048,
          completionTokens: 384,
          totalTokens: 2432,
        },
      },
    },
  };
}

describe("TranslationAgent + RecordedModelProvider integration", () => {
  it("REPRODUCIBILITY: same input + same bundle yields byte-equal drafts across two invocations", async () => {
    const input = recordedInputFixture();
    const drafts = recordedDrafts(input);
    const bundle = bundleFor(input, drafts);
    const provider = new RecordedModelProvider({ bundle });
    const agent = new TranslationAgent({ provider });

    const first = await agent.invokeTranslation(FIXED_ACTOR, input);
    const second = await agent.invokeTranslation(FIXED_ACTOR, input);

    expect(JSON.stringify(first.drafts)).toEqual(JSON.stringify(second.drafts));
    expect(first.drafts).toEqual(drafts);
    expect(first.recordedArtifactId).toBe(bundle.bundleId);
    expect(second.recordedArtifactId).toBe(bundle.bundleId);
    expect(first.promptHashUsed).toEqual(second.promptHashUsed);
    expect(first.modelMetadata.providerIdentity.providerName).toBe(bundle.capturedProviderName);
    expect(first.modelMetadata.providerIdentity.providerFamily).toBe(bundle.capturedProviderFamily);
    expect(first.modelMetadata.providerIdentity.actualModelId).toBe(bundle.capturedActualModelId);
    expect(first.tokensIn).toBe(2048);
    expect(first.tokensOut).toBe(384);
    expect(makeStructuredTranslationDraftOutputFixture(first.drafts).schemaVersion).toBe(
      STRUCTURED_TRANSLATION_DRAFT_OUTPUT_SCHEMA_VERSION,
    );
  });

  it("recorded replay keys responses on the deterministic prompt hash", async () => {
    const input = recordedInputFixture();
    const drafts = recordedDrafts(input);
    const bundle = bundleFor(input, drafts);
    // Re-derive the expected key independently to assert the agent
    // uses the same canonical hash as the bundle authority.
    const rendered = buildTranslationPrompt(input);
    const expectedKey = `sha256:${translationPromptHash(rendered)}`;
    expect(Object.keys(bundle.responses)).toEqual([expectedKey]);

    const provider = new RecordedModelProvider({ bundle });
    const agent = new TranslationAgent({ provider });
    const result = await agent.invokeTranslation(FIXED_ACTOR, input);
    expect(result.drafts).toEqual(drafts);
  });

  it("surfaces a bundle miss as RecordedBundleMissingError (no silent fallback)", async () => {
    const input = recordedInputFixture();
    const drafts = recordedDrafts(input);
    const bundle: RecordedProviderBundle = {
      bundleId: "translation-bundle-fixture-miss",
      capturedProviderFamily: "openrouter",
      capturedProviderName: "openrouter:translation-judge",
      capturedRequestedModelId: input.modelProfile.modelId,
      capturedActualModelId: "openrouter:claude-opus-fixture",
      responses: {
        ["sha256:wrong-key-no-match"]: {
          content: JSON.stringify(makeStructuredTranslationDraftOutputFixture(drafts)),
          finishReason: "stop",
        },
      },
    };
    const provider = new RecordedModelProvider({ bundle });
    const agent = new TranslationAgent({ provider });
    const error = await agent.invokeTranslation(FIXED_ACTOR, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RecordedBundleMissingError);
    if (error instanceof RecordedBundleMissingError) {
      expect(error.bundleId).toBe("translation-bundle-fixture-miss");
      expect(error.availableKeys).toEqual(["sha256:wrong-key-no-match"]);
    }
  });
});
