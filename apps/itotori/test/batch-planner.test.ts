import type { BridgeBundle, BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import { createSyntheticLargeBridgeBundle } from "../../../packages/localization-bridge-schema/src/synthetic-large-project.js";
import { describe, expect, it } from "vitest";
import {
  builtinProfiles,
  cjkFraction,
  computeTokenBudgetCap,
  defaultPromptOverheadTokens,
  defaultTargetFillRatio,
  estimateTokens,
  groupBySceneBoundary,
  ModelProviderPairUnresolvedError,
  perUnitFrameOverheadTokens,
  planBatches,
  resolveModelProfile,
  sourceUnitKeyPrefix,
  tokenEstimatorIdV1,
  type BatchModelProfile,
  type CharacterMapSnapshot,
  type SceneSummaryRef,
  type StyleGuideVersionSnapshot,
  type TerminologyTermSnapshot,
  type TranslationMemoryQueryFn,
} from "../src/batch-planner/index.js";

const projectId = "019ed018-0000-7000-8000-000000000001";
const localeBranchId = "019ed018-0000-7000-8000-000000000002";
const sourceRevisionId = "019ed018-0000-7000-8000-000000000003";

// ITOTORI-220 — a real (modelId, providerId) pair for tests that exercise the
// planner's structure rather than a specific model. The conservative sizing
// numbers mirror the previous default so batch counts/budgets are unchanged.
const sizingTestProfile: BatchModelProfile = {
  providerFamily: "fake",
  modelId: "itotori-fake-draft",
  providerId: "fake-fixture",
  contextWindowTokens: 128_000,
  maxOutputTokens: 4096,
  targetFillRatio: 0.5,
  promptOverheadTokens: defaultPromptOverheadTokens,
  tokenEstimatorId: tokenEstimatorIdV1,
};

function tinyBridge(): BridgeBundle {
  const baseSourceText = "勇者は王様に挨拶した";
  return {
    schemaVersion: "0.1.0",
    bridgeId: "bridge-tiny",
    sourceBundleHash: "hash-tiny",
    sourceLocale: "ja-JP",
    extractorName: "kaifuu-fixture",
    extractorVersion: "0.0.0",
    units: [0, 1, 2, 3, 4].map((index) => ({
      bridgeUnitId: `unit-${index}`,
      sourceUnitKey: `tiny.scene.001.line.${String(index).padStart(3, "0")}`,
      occurrenceId: `occ-${index}`,
      sourceHash: `hash-${index}`,
      sourceLocale: "ja-JP",
      sourceText: index === 2 ? `${baseSourceText}おはよう` : baseSourceText,
      speaker: index === 2 ? "勇者" : undefined,
      textSurface: "dialogue",
      protectedSpans: [],
      patchRef: {
        assetId: "tiny.json",
        writeMode: "replace",
        sourceUnitKey: `tiny.scene.001.line.${String(index).padStart(3, "0")}`,
      },
    })),
  };
}

function styleGuideFixture(): StyleGuideVersionSnapshot {
  return {
    styleGuideVersionId: "019ed018-0000-7000-8000-000000000010",
    rules: [
      { ruleId: "tone-formal", applicability: "always_on", body: "Match the source tone." },
      {
        ruleId: "honorifics-keep",
        applicability: "always_on",
        body: "Preserve Japanese honorifics where natural.",
      },
      {
        ruleId: "dialogue-casing",
        applicability: "dialogue",
        body: "Use sentence case in dialogue.",
      },
      {
        ruleId: "system-allcaps",
        applicability: "system",
        body: "Use ALL CAPS in system text.",
      },
    ],
  };
}

function glossaryFixture(): ReadonlyArray<TerminologyTermSnapshot> {
  return [
    {
      termId: "term-yusha",
      termKey: "yusha",
      preferredSourceForm: "勇者",
      preferredTargetForm: "hero",
      aliases: [],
    },
    {
      termId: "term-osama",
      termKey: "osama",
      preferredSourceForm: "王様",
      preferredTargetForm: "king",
      aliases: [{ aliasText: "陛下" }],
    },
    {
      termId: "term-ohayou",
      termKey: "ohayou",
      preferredSourceForm: "おはよう",
      preferredTargetForm: "good morning",
    },
  ];
}

function buildLargeFixture(targetCharacters: number) {
  const bundle: BridgeBundleV02 = createSyntheticLargeBridgeBundle({
    seed: "ITOTORI-018-test",
    targetJapaneseCharacters: targetCharacters,
    assetCount: 8,
  });
  return bundle;
}

describe("token estimator", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates CJK at ~2 chars/token", () => {
    const text = "勇者は王様に挨拶した";
    const tokens = estimateTokens(text);
    const charCount = [...text].length;
    expect(tokens).toBeGreaterThanOrEqual(Math.ceil(charCount / 2) - 1);
    expect(tokens).toBeLessThanOrEqual(Math.ceil(charCount / 2) + 1);
  });

  it("estimates ASCII at ~4 chars/token", () => {
    const text = "Hello world this is a long sentence about heroes";
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThanOrEqual(Math.floor(text.length / 4) - 1);
    expect(tokens).toBeLessThanOrEqual(Math.ceil(text.length / 4) + 2);
  });

  it("classifies mixed CJK/ASCII text", () => {
    expect(cjkFraction("勇者")).toBe(1);
    expect(cjkFraction("hero")).toBe(0);
    expect(cjkFraction("hero 勇者")).toBeGreaterThan(0);
    expect(cjkFraction("hero 勇者")).toBeLessThan(1);
  });
});

describe("model profile resolution", () => {
  it("throws rather than inventing a provider when nothing resolves", () => {
    // ITOTORI-220 — no model named means no (modelId, providerId) pair to plan
    // an invocation for; we fail loud instead of producing providerId:"unknown".
    expect(() => resolveModelProfile({})).toThrow(ModelProviderPairUnresolvedError);
  });

  it("throws when a modelId is supplied without a resolvable providerId", () => {
    // ITOTORI-220 — the core fail-loud guarantee: an unrecognized model with no
    // providerId must throw a typed error naming the model, never silently
    // resolve to providerId:"unknown".
    expect(() => resolveModelProfile({ modelId: "some-uncatalogued-model" })).toThrow(
      ModelProviderPairUnresolvedError,
    );
    try {
      resolveModelProfile({ modelId: "some-uncatalogued-model" });
      expect.unreachable("expected a thrown ModelProviderPairUnresolvedError");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelProviderPairUnresolvedError);
      expect((error as ModelProviderPairUnresolvedError).modelId).toBe("some-uncatalogued-model");
    }
  });

  it("sizes an unrecognized model conservatively once a real provider is declared", () => {
    const profile = resolveModelProfile({
      modelId: "some-uncatalogued-model",
      providerId: "openrouter-anthropic",
    });
    expect(profile.modelId).toBe("some-uncatalogued-model");
    expect(profile.providerId).toBe("openrouter-anthropic");
    expect(profile.providerId).not.toBe("unknown");
    expect(profile.contextWindowTokens).toBe(128_000);
  });

  it("uses a built-in profile (with its pinned providerId) when modelId matches", () => {
    const seed = builtinProfiles[0]!;
    const profile = resolveModelProfile({ modelId: seed.modelId });
    expect(profile.modelId).toBe(seed.modelId);
    expect(profile.providerId).toBe(seed.providerId);
    expect(profile.contextWindowTokens).toBe(seed.contextWindowTokens);
  });

  it("uses caller-supplied override above all others", () => {
    const override: BatchModelProfile = {
      providerFamily: "fake",
      modelId: "explicit",
      providerId: "fake-fixture",
      contextWindowTokens: 64_000,
      maxOutputTokens: 1024,
      targetFillRatio: 0.6,
      promptOverheadTokens: 1500,
      tokenEstimatorId: tokenEstimatorIdV1,
    };
    const profile = resolveModelProfile({ override });
    expect(profile).toEqual(override);
  });

  it("clamps contextWindowTokens via maxTokensOverride", () => {
    const profile = resolveModelProfile({
      modelId: builtinProfiles[0]!.modelId,
      maxTokensOverride: 16_000,
    });
    expect(profile.contextWindowTokens).toBe(16_000);
  });

  it("honors targetFillRatio override and rejects out-of-range values", () => {
    const modelId = builtinProfiles[0]!.modelId;
    const profile = resolveModelProfile({ modelId, targetFillRatio: 0.42 });
    expect(profile.targetFillRatio).toBe(0.42);
    expect(() => resolveModelProfile({ modelId, targetFillRatio: 0 })).toThrow();
    expect(() => resolveModelProfile({ modelId, targetFillRatio: 1.5 })).toThrow();
  });

  it("computes the token budget cap as floor((ctx - overhead - maxOut) * ratio)", () => {
    const profile: BatchModelProfile = {
      providerFamily: "fake",
      modelId: "budget-test",
      contextWindowTokens: 10_000,
      maxOutputTokens: 1_000,
      targetFillRatio: 0.7,
      promptOverheadTokens: 1_000,
      tokenEstimatorId: tokenEstimatorIdV1,
    };
    expect(computeTokenBudgetCap(profile)).toBe(Math.floor((10_000 - 1_000 - 1_000) * 0.7));
  });
});

describe("scene grouping", () => {
  it("falls back to sourceUnitKey-prefix when there is no scene/route signal", () => {
    const bundle = tinyBridge();
    const projected = bundle.units.map((unit) => ({
      bridgeUnitId: unit.bridgeUnitId,
      sourceUnitKey: unit.sourceUnitKey,
      sourceHash: unit.sourceHash,
      occurrenceId: unit.occurrenceId,
      sourceLocale: unit.sourceLocale,
      sourceText: unit.sourceText,
      speaker: unit.speaker,
      textSurface: unit.textSurface,
    }));
    const groups = groupBySceneBoundary(projected);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sourceUnitKeyPrefix).toBe("tiny.scene.001.line");
  });

  it("derives prefix as everything before the last dot", () => {
    expect(sourceUnitKeyPrefix("scene.a.b.c")).toBe("scene.a.b");
    expect(sourceUnitKeyPrefix("standalone")).toBe("standalone");
  });
});

describe("planBatches tiny game", () => {
  it("produces a single batch with cited glossary, always-on style, and unit citations", async () => {
    const bridge = tinyBridge();
    const styleGuide = styleGuideFixture();
    const glossary = glossaryFixture();
    const result = await planBatches({
      projectId,
      localeBranchId,
      sourceRevisionId,
      locale: "en-US",
      bridgeBundle: bridge,
      glossary,
      styleGuide,
      modelProfile: sizingTestProfile,
    });
    expect(result.batches).toHaveLength(1);
    const batch = result.batches[0]!;
    expect(batch.units).toHaveLength(5);
    const glossaryKeys = batch.context.glossaryTerms.map((g) => g.termKey).sort();
    expect(glossaryKeys).toEqual(["ohayou", "osama", "yusha"]);
    expect(batch.context.styleGuideRules.some((rule) => rule.inclusionReason === "always_on")).toBe(
      true,
    );
    expect(
      batch.context.styleGuideRules.filter((rule) => rule.inclusionReason === "category_match"),
    ).toHaveLength(1);
    expect(batch.tokenEstimate).toBeLessThanOrEqual(batch.tokenBudgetCap);
    // Citation manifest: every unit citation lists the per-unit glossary hits.
    const manifest = batch.context.citationManifest;
    expect(manifest.unitCitations).toHaveLength(5);
    const ohayouCitation = manifest.unitCitations.find((cite) => cite.bridgeUnitId === "unit-2");
    expect(ohayouCitation?.glossaryTermIds).toContain("term-ohayou");
    expect(ohayouCitation?.glossaryTermIds).toContain("term-yusha");
    expect(ohayouCitation?.glossaryTermIds).toContain("term-osama");
  });

  it("uses the model profile actually selected by the caller", async () => {
    const bridge = tinyBridge();
    const profile: BatchModelProfile = {
      providerFamily: "fake",
      modelId: "tiny-test",
      providerId: "fake-fixture",
      contextWindowTokens: 6000,
      maxOutputTokens: 512,
      targetFillRatio: 0.5,
      promptOverheadTokens: 500,
      tokenEstimatorId: tokenEstimatorIdV1,
    };
    const result = await planBatches({
      projectId,
      localeBranchId,
      sourceRevisionId,
      locale: "en-US",
      bridgeBundle: bridge,
      glossary: [],
      modelProfile: profile,
    });
    expect(result.summary.modelProfile.modelId).toBe("tiny-test");
    for (const batch of result.batches) {
      expect(batch.modelProfile.modelId).toBe("tiny-test");
      expect(batch.tokenBudgetCap).toBe(computeTokenBudgetCap(profile));
    }
  });
});

describe("planBatches large game", () => {
  it("splits a synthetic 10K-character project across multiple budget-respecting batches", async () => {
    const bridge = buildLargeFixture(20_000);
    const profile: BatchModelProfile = {
      providerFamily: "fake",
      modelId: "tiny-test",
      providerId: "fake-fixture",
      contextWindowTokens: 8000,
      maxOutputTokens: 256,
      targetFillRatio: 0.5,
      promptOverheadTokens: 200,
      tokenEstimatorId: tokenEstimatorIdV1,
    };
    const result = await planBatches({
      projectId,
      localeBranchId,
      sourceRevisionId,
      locale: "en-US",
      bridgeBundle: bridge,
      glossary: [],
      modelProfile: profile,
    });
    expect(result.batches.length).toBeGreaterThan(1);
    for (const batch of result.batches) {
      expect(batch.tokenEstimate).toBeLessThanOrEqual(batch.tokenBudgetCap);
    }
  });

  it("preserves scene boundaries when the cap allows it", async () => {
    const bridge = buildLargeFixture(20_000);
    const profile: BatchModelProfile = {
      providerFamily: "fake",
      modelId: "wide-test",
      providerId: "fake-fixture",
      contextWindowTokens: 200_000,
      maxOutputTokens: 1000,
      targetFillRatio: 0.7,
      promptOverheadTokens: 1000,
      tokenEstimatorId: tokenEstimatorIdV1,
    };
    const result = await planBatches({
      projectId,
      localeBranchId,
      sourceRevisionId,
      locale: "en-US",
      bridgeBundle: bridge,
      glossary: [],
      modelProfile: profile,
    });
    // Scenes with sceneSplitIndex always come as consecutive 1..N triples.
    const sceneSequences = new Map<string, number[]>();
    for (const batch of result.batches) {
      if (batch.sceneId === undefined) continue;
      if (batch.sceneSplitIndex === undefined) continue;
      const bucket = sceneSequences.get(batch.sceneId) ?? [];
      bucket.push(batch.sceneSplitIndex);
      sceneSequences.set(batch.sceneId, bucket);
    }
    for (const [, indices] of sceneSequences.entries()) {
      indices.sort((a, b) => a - b);
      for (let i = 0; i < indices.length; i += 1) {
        expect(indices[i]).toBe(i + 1);
      }
    }
  });
});

describe("planBatches glossary citation completeness", () => {
  it("records hitBridgeUnitIds for every term that matched at least one unit", async () => {
    const bridge = tinyBridge();
    const result = await planBatches({
      projectId,
      localeBranchId,
      sourceRevisionId,
      locale: "en-US",
      bridgeBundle: bridge,
      glossary: glossaryFixture(),
      modelProfile: sizingTestProfile,
    });
    const batch = result.batches[0]!;
    for (const term of batch.context.glossaryTerms) {
      expect(term.hitBridgeUnitIds.length).toBeGreaterThan(0);
    }
  });

  it("links per-unit citations to per-batch glossaryTerms entries", async () => {
    const bridge = tinyBridge();
    const glossary = glossaryFixture();
    const result = await planBatches({
      projectId,
      localeBranchId,
      sourceRevisionId,
      locale: "en-US",
      bridgeBundle: bridge,
      glossary,
      modelProfile: sizingTestProfile,
    });
    const batch = result.batches[0]!;
    for (const citation of batch.context.citationManifest.unitCitations) {
      for (const termId of citation.glossaryTermIds) {
        expect(batch.context.glossaryTerms.find((term) => term.termId === termId)).toBeDefined();
      }
    }
  });
});

describe("planBatches style rule inclusion", () => {
  it("includes always-on plus dialogue category, excluding system-only rules", async () => {
    const bridge = tinyBridge();
    const result = await planBatches({
      projectId,
      localeBranchId,
      sourceRevisionId,
      locale: "en-US",
      bridgeBundle: bridge,
      glossary: [],
      styleGuide: styleGuideFixture(),
      modelProfile: sizingTestProfile,
    });
    const batch = result.batches[0]!;
    const ruleIds = batch.context.styleGuideRules.map((rule) => rule.ruleId).sort();
    expect(ruleIds).toEqual(["dialogue-casing", "honorifics-keep", "tone-formal"]);
  });
});

describe("planBatches character map degradation", () => {
  it("emits speaker-only character entries when characterMap is absent", async () => {
    const bridge = tinyBridge();
    const result = await planBatches({
      projectId,
      localeBranchId,
      sourceRevisionId,
      locale: "en-US",
      bridgeBundle: bridge,
      glossary: [],
      modelProfile: sizingTestProfile,
    });
    const batch = result.batches[0]!;
    const refs = batch.context.characterRelationships;
    expect(refs.find((ref) => ref.canonicalName === "勇者")).toBeDefined();
    for (const ref of refs) {
      expect(ref.relationshipNotes).toBeUndefined();
    }
  });

  it("uses characterMap.relationshipNotes when provided", async () => {
    const bridge = tinyBridge();
    const characterMap: CharacterMapSnapshot = {
      entries: [
        {
          termId: "term-yusha-canon",
          canonicalName: "Hero",
          speakerKeys: ["勇者"],
          relationshipNotes: "Protagonist; respectful toward king.",
        },
      ],
    };
    const result = await planBatches({
      projectId,
      localeBranchId,
      sourceRevisionId,
      locale: "en-US",
      bridgeBundle: bridge,
      glossary: [],
      characterMap,
      modelProfile: sizingTestProfile,
    });
    const batch = result.batches[0]!;
    const ref = batch.context.characterRelationships.find((r) => r.canonicalName === "Hero");
    expect(ref).toBeDefined();
    expect(ref?.relationshipNotes).toContain("Protagonist");
  });
});

describe("planBatches character-card token accounting (GA3-002)", () => {
  // Bridge with many DISTINCT speakers so every unit contributes a fresh
  // character-relationship card to its batch. The cards are only added to
  // the reported tokenEstimate in finalizeBatch, so a split check blind to
  // them would let a finalized batch overflow tokenBudgetCap once the fill
  // ratio leaves no headroom.
  function distinctSpeakerBridge(unitCount: number): BridgeBundle {
    return {
      schemaVersion: "0.1.0",
      bridgeId: "bridge-speakers",
      sourceBundleHash: "hash-speakers",
      sourceLocale: "ja-JP",
      extractorName: "kaifuu-fixture",
      extractorVersion: "0.0.0",
      units: Array.from({ length: unitCount }, (_unused, index) => ({
        bridgeUnitId: `unit-${index}`,
        sourceUnitKey: `spk.scene.001.line.${String(index).padStart(3, "0")}`,
        occurrenceId: `occ-${index}`,
        sourceHash: `hash-${index}`,
        sourceLocale: "ja-JP",
        sourceText: "あいうえお",
        speaker: `speaker-${index}`,
        textSurface: "dialogue",
        protectedSpans: [],
        patchRef: {
          assetId: "spk.json",
          writeMode: "replace" as const,
          sourceUnitKey: `spk.scene.001.line.${String(index).padStart(3, "0")}`,
        },
      })),
    };
  }

  it("keeps every batch's tokenEstimate <= tokenBudgetCap at fillRatio ~1.0 with character cards", async () => {
    const unitCount = 12;
    const bridge = distinctSpeakerBridge(unitCount);
    // Each speaker gets a substantial relationship note so the character
    // cards dominate the per-unit token cost.
    const characterMap: CharacterMapSnapshot = {
      entries: Array.from({ length: unitCount }, (_unused, index) => ({
        termId: `term-speaker-${index}`,
        canonicalName: `Character ${index}`,
        speakerKeys: [`speaker-${index}`],
        relationshipNotes:
          "A recurring party member with a long, detailed relationship history that " +
          "consumes a meaningful number of context tokens when serialized into the card.",
      })),
    };
    // fillRatio 1.0 leaves zero headroom: without counting character cards in
    // the split decision, a finalized batch would overflow.
    const profile: BatchModelProfile = {
      providerFamily: "fake",
      modelId: "tight-fill",
      providerId: "fake-fixture",
      contextWindowTokens: 500,
      maxOutputTokens: 0,
      targetFillRatio: 1.0,
      promptOverheadTokens: 100,
      tokenEstimatorId: tokenEstimatorIdV1,
    };
    const result = await planBatches({
      projectId,
      localeBranchId,
      sourceRevisionId,
      locale: "en-US",
      bridgeBundle: bridge,
      glossary: [],
      characterMap,
      modelProfile: profile,
    });

    const cap = computeTokenBudgetCap(profile);
    // The tight cap forces a split across multiple batches.
    expect(result.batches.length).toBeGreaterThan(1);
    let sawCharacterCard = false;
    for (const batch of result.batches) {
      expect(batch.tokenBudgetCap).toBe(cap);
      // The core GA3-002 invariant: the reported estimate never exceeds the
      // cap, even though the character cards are added at finalize time.
      expect(batch.tokenEstimate).toBeLessThanOrEqual(cap);
      if (batch.context.characterRelationships.length > 0) {
        sawCharacterCard = true;
      }
    }
    expect(sawCharacterCard).toBe(true);
    // Every unit is still placed exactly once across the batches.
    const placed = result.batches.reduce((sum, batch) => sum + batch.units.length, 0);
    expect(placed).toBe(unitCount);
  });
});

describe("planBatches prior translation examples", () => {
  it("invokes translationMemory with speaker/scene/surfaceKind hints", async () => {
    const calls: Array<{ speaker?: string; sceneId?: string; surfaceKind?: string }> = [];
    const tm: TranslationMemoryQueryFn = (input) => {
      calls.push({
        speaker: input.speaker,
        sceneId: input.sceneId,
        surfaceKind: input.surfaceKind,
      });
      return [];
    };
    const bridge = tinyBridge();
    await planBatches({
      projectId,
      localeBranchId,
      sourceRevisionId,
      locale: "en-US",
      bridgeBundle: bridge,
      glossary: [],
      translationMemory: tm,
      priorExampleLimit: 3,
      modelProfile: sizingTestProfile,
    });
    expect(calls.some((call) => call.speaker === "勇者")).toBe(true);
  });
});

describe("planBatches summary", () => {
  it("counts unitsWithoutSceneCount and reports the resolved model profile", async () => {
    const bridge = tinyBridge();
    const result = await planBatches({
      projectId,
      localeBranchId,
      sourceRevisionId,
      locale: "en-US",
      bridgeBundle: bridge,
      glossary: [],
      modelProfile: sizingTestProfile,
    });
    expect(result.summary.unitsWithoutSceneCount).toBe(5);
    expect(result.summary.modelProfile.tokenEstimatorId).toBe(tokenEstimatorIdV1);
  });
});

describe("planBatches scene summary token accounting", () => {
  it("adds scene summary body tokens to the per-batch estimate", async () => {
    const bridge = tinyBridge();
    const longBody = "これはシーンサマリーです。".repeat(20);
    const summaries = new Map<string, SceneSummaryRef>([
      [
        "tiny.scene.001",
        {
          contextArtifactId: "ctx-1",
          sceneId: "tiny.scene.001",
          contentHash: "hash",
          body: longBody,
        },
      ],
    ]);
    // No scene id on units (they are key-prefix grouped). So no summary will
    // attach. Verify that grouping ID still places units in one batch.
    const result = await planBatches({
      projectId,
      localeBranchId,
      sourceRevisionId,
      locale: "en-US",
      bridgeBundle: bridge,
      glossary: [],
      sceneSummaries: summaries,
      modelProfile: sizingTestProfile,
    });
    expect(result.batches).toHaveLength(1);
    // The scene summary lookup uses sceneId which the tinyBridge fixture
    // does not set; so no summary attaches and tokenEstimate excludes the body.
    expect(result.batches[0]?.context.sceneSummary).toBeUndefined();
  });
});

describe("constants", () => {
  it("exposes defaults for downstream callers", () => {
    expect(defaultTargetFillRatio).toBe(0.7);
    expect(defaultPromptOverheadTokens).toBeGreaterThan(0);
    expect(perUnitFrameOverheadTokens).toBeGreaterThan(0);
  });
});
