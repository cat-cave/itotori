import { describe, expect, it } from "vitest";
import {
  catalogOpportunityFactorValues,
  catalogOpportunityWeightsVersion,
  scoreCatalogOpportunity,
  type CatalogOpportunityFactorName,
  type CatalogOpportunityScoreInput,
} from "../src/services/catalog-opportunity-ranking.js";

const requiredFactors = Object.values(catalogOpportunityFactorValues);

describe("scoreCatalogOpportunity", () => {
  it("returns an explicit deterministic factor breakdown for every opportunity signal", () => {
    const score = scoreCatalogOpportunity({
      translationCompleteness: "no_english",
      localOwnership: "owned",
      dlsiteDemand: "very_high",
      platformLanguageConflict: "none",
      marketPrevalence: "public_and_local_aggregate",
      adapterReadiness: "patch_supported",
      runtimeEvidenceReadiness: "public_and_aggregate",
      existingTranslationStatus: "none",
      benchmarkUsefulness: "high",
      unknownEvidence: "present",
      evidenceRefs: {
        translation_completeness: ["language-status-1"],
        adapter_readiness: ["rpg-maker-mv"],
      },
    });

    expect(score).toMatchObject({
      weightsVersion: catalogOpportunityWeightsVersion,
      decision: "candidate",
      score: 100,
    });
    expect(score.factors.map((factor) => factor.factor)).toEqual(requiredFactors);
    expect(score.explanationCodes).toEqual([
      "translation_completeness:no_english",
      "local_ownership:owned",
      "dlsite_demand:very_high",
      "platform_language_conflict:none",
      "market_prevalence:public_and_local_aggregate",
      "adapter_readiness:patch_supported",
      "runtime_evidence_readiness:public_and_aggregate",
      "existing_translation_status:none",
      "benchmark_usefulness:high",
      "unknown_evidence:present",
    ]);
    expect(factorScore(score.factors, "unknown_evidence")).toBe(0);
    expect(score.factors).toContainEqual(
      expect.objectContaining({
        factor: "translation_completeness",
        weight: 30,
        rawValue: 1,
        weightedScore: 30,
        evidenceRefs: ["language-status-1"],
      }),
    );
  });

  it("demotes platform-language conflicts before they can be treated as candidates", () => {
    const base = candidateInput();
    const clean = scoreCatalogOpportunity(base);
    const conflicted = scoreCatalogOpportunity({
      ...base,
      platformLanguageConflict: "open_platform_language_conflict",
      evidenceRefs: {
        platform_language_conflict: ["conflict-1"],
      },
    });

    expect(clean.decision).toBe("candidate");
    expect(conflicted.decision).toBe("demoted");
    expect(conflicted.score).toBeLessThan(clean.score);
    expect(conflicted.factors).toContainEqual(
      expect.objectContaining({
        factor: "platform_language_conflict",
        weightedScore: -60,
        evidenceRefs: ["conflict-1"],
      }),
    );
  });

  it("excludes already complete translations and keeps unknown evidence diagnostic-only", () => {
    const unknownEvidence = scoreCatalogOpportunity({
      ...candidateInput(),
      unknownEvidence: "present",
    });
    const knownEvidence = scoreCatalogOpportunity({
      ...candidateInput(),
      unknownEvidence: "none",
    });
    const complete = scoreCatalogOpportunity({
      ...candidateInput(),
      existingTranslationStatus: "official_or_complete",
    });

    expect(unknownEvidence.score).toBe(knownEvidence.score);
    expect(factorScore(unknownEvidence.factors, "unknown_evidence")).toBe(0);
    expect(complete.decision).toBe("excluded");
    expect(complete.score).toBeLessThan(knownEvidence.score);
  });
});

function candidateInput(): CatalogOpportunityScoreInput {
  return {
    translationCompleteness: "mtl_only",
    localOwnership: "owned",
    dlsiteDemand: "high",
    platformLanguageConflict: "none",
    marketPrevalence: "public_only",
    adapterReadiness: "extract_supported",
    runtimeEvidenceReadiness: "public_fixture",
    existingTranslationStatus: "mtl",
    benchmarkUsefulness: "medium",
    unknownEvidence: "none",
  };
}

function factorScore(
  factors: Array<{ factor: CatalogOpportunityFactorName; weightedScore: number }>,
  name: CatalogOpportunityFactorName,
): number {
  const factor = factors.find((row) => row.factor === name);
  if (factor === undefined) {
    throw new Error(`missing factor ${name}`);
  }
  return factor.weightedScore;
}
