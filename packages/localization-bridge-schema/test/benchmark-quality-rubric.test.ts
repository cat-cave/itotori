import { describe, expect, it } from "vitest";
import {
  assertBenchmarkQualityRubric,
  BENCHMARK_QUALITY_RUBRIC,
  BENCHMARK_QUALITY_RUBRIC_ID,
  BENCHMARK_QUALITY_RUBRIC_VERSION,
  BENCHMARK_RUBRIC_DIMENSION_IDS,
  BENCHMARK_RUBRIC_SCORES,
  benchmarkRubricMqmBandForScore,
  benchmarkRubricQualitySeverityForScore,
  benchmarkRubricTaxonomyTargetForDimension,
  LOCALIZATION_QUALITY_CATEGORIES,
  LOCALIZATION_QUALITY_SEVERITIES,
  LOCALIZATION_QUALITY_TAXONOMY_ID,
  LOCALIZATION_QUALITY_TAXONOMY_VERSION,
  type BenchmarkRubricScore,
} from "../src/index.js";

// Ground-truth mirror of docs/itotori-translation-benchmark-methodology.md §2.
// If §2 changes, these expectations must change WITH it (a methodology change),
// which is exactly what should force a review of the artifact.

const SECTION_2_2_DIMENSIONS = [
  "adequacy",
  "callbacks_foreshadowing",
  "fluency",
  "register_politeness",
  "character_voice_consistency",
  "honorifics",
  "wordplay_puns_songs",
  "cultural_adaptation",
  "textbox_fit_wordwrap",
  "speaker_attribution",
  "choice_branch_correctness",
] as const;

// §2.1 scale → MQM-severity correspondence table.
const SECTION_2_1_MQM: Record<number, string> = {
  4: "no defect",
  3: "minor",
  2: "major",
  1: "between major and critical",
  0: "critical",
};

describe("BenchmarkQualityRubric — §2 conformance", () => {
  it("validates the shipped rubric", () => {
    expect(() => assertBenchmarkQualityRubric(BENCHMARK_QUALITY_RUBRIC)).not.toThrow();
  });

  it("is anchored on itotori-lqa-1 (shared vocabulary, not a rival)", () => {
    expect(BENCHMARK_QUALITY_RUBRIC.rubricId).toBe(BENCHMARK_QUALITY_RUBRIC_ID);
    expect(BENCHMARK_QUALITY_RUBRIC.rubricVersion).toBe(BENCHMARK_QUALITY_RUBRIC_VERSION);
    expect(BENCHMARK_QUALITY_RUBRIC.taxonomyId).toBe(LOCALIZATION_QUALITY_TAXONOMY_ID);
    expect(BENCHMARK_QUALITY_RUBRIC.taxonomyVersion).toBe(LOCALIZATION_QUALITY_TAXONOMY_VERSION);
  });

  it("enumerates EXACTLY the §2.2 dimensions (no additions, no omissions)", () => {
    const ids = BENCHMARK_QUALITY_RUBRIC.dimensions.map((d) => d.id);
    expect(ids).toEqual([...SECTION_2_2_DIMENSIONS]);
    expect([...BENCHMARK_RUBRIC_DIMENSION_IDS]).toEqual([...SECTION_2_2_DIMENSIONS]);
  });

  it("scores every dimension on the §2.1 0–4 scale", () => {
    expect([...BENCHMARK_RUBRIC_SCORES]).toEqual([0, 1, 2, 3, 4]);
    const scores = BENCHMARK_QUALITY_RUBRIC.scale.map((s) => s.score).sort((a, b) => a - b);
    expect(scores).toEqual([0, 1, 2, 3, 4]);
  });

  it("maps each score to the §2.1 MQM-severity correspondence exactly", () => {
    for (const entry of BENCHMARK_QUALITY_RUBRIC.scale) {
      expect(entry.mqmCorrespondence).toBe(SECTION_2_1_MQM[entry.score]);
    }
  });

  it("derives §2.1 MQM bands: 4=no defect, 3=minor, 2=major, 1=[major,critical], 0=critical", () => {
    expect(benchmarkRubricMqmBandForScore(4)).toEqual({ kind: "no_defect" });
    expect(benchmarkRubricMqmBandForScore(3)).toEqual({ kind: "severity", severity: "minor" });
    expect(benchmarkRubricMqmBandForScore(2)).toEqual({ kind: "severity", severity: "major" });
    expect(benchmarkRubricMqmBandForScore(1)).toEqual({
      kind: "between",
      lower: "major",
      upper: "critical",
    });
    expect(benchmarkRubricMqmBandForScore(0)).toEqual({ kind: "severity", severity: "critical" });
  });

  it("converts a judge score to a discrete itotori-lqa-1 severity for findings", () => {
    expect(benchmarkRubricQualitySeverityForScore(4)).toBeNull();
    expect(benchmarkRubricQualitySeverityForScore(3)).toBe("minor");
    expect(benchmarkRubricQualitySeverityForScore(2)).toBe("major");
    // §2.1 score 1 is a band; discrete emission uses the band's lower bound.
    expect(benchmarkRubricQualitySeverityForScore(1)).toBe("major");
    expect(benchmarkRubricQualitySeverityForScore(0)).toBe("critical");
    // Every discrete severity is a real taxonomy severity (no forked vocabulary).
    for (const score of BENCHMARK_RUBRIC_SCORES) {
      const severity = benchmarkRubricQualitySeverityForScore(score);
      if (severity !== null) {
        expect(LOCALIZATION_QUALITY_SEVERITIES).toContain(severity);
      }
    }
  });

  it("maps every dimension onto a real itotori-lqa-1 category", () => {
    for (const dimension of BENCHMARK_QUALITY_RUBRIC.dimensions) {
      expect(LOCALIZATION_QUALITY_CATEGORIES).toContain(dimension.taxonomyCategory);
    }
  });

  it("tags each dimension's taxonomy category per §2.2 (explicit vs reasoned)", () => {
    const target = (id: (typeof SECTION_2_2_DIMENSIONS)[number]) =>
      benchmarkRubricTaxonomyTargetForDimension(id);
    // §2.2-explicit mappings.
    expect(target("adequacy")).toEqual({ category: "accuracy" });
    expect(target("callbacks_foreshadowing")).toEqual({ category: "accuracy" });
    expect(target("fluency")).toEqual({ category: "style" });
    expect(target("register_politeness")).toEqual({ category: "tone_register" });
    expect(target("character_voice_consistency")).toEqual({
      category: "tone_register",
      subcategory: "speaker_voice_drift",
    });
    expect(target("honorifics")).toEqual({
      category: "tone_register",
      subcategory: "honorific_misuse",
    });
    expect(target("cultural_adaptation")).toEqual({ category: "locale_convention" });
    expect(target("textbox_fit_wordwrap")).toEqual({ category: "layout" });
    expect(target("choice_branch_correctness")).toEqual({
      category: "accuracy",
      subcategory: "choice_semantics_shift",
    });
    // Reasoned defaults for the two §2.2 dimensions §2 leaves untagged.
    expect(target("wordplay_puns_songs")).toEqual({ category: "style" });
    expect(target("speaker_attribution")).toEqual({
      category: "technical_integrity",
      subcategory: "asset_binding_broken",
    });
  });

  it("flags the reasoned-default mappings so they are auditable", () => {
    const reasoned = BENCHMARK_QUALITY_RUBRIC.dimensions
      .filter((d) => d.taxonomyMappingSource === "reasoned_default")
      .map((d) => d.id)
      .sort();
    expect(reasoned).toEqual(["speaker_attribution", "wordplay_puns_songs"]);
    for (const dimension of BENCHMARK_QUALITY_RUBRIC.dimensions) {
      if (dimension.taxonomyMappingSource === "reasoned_default") {
        expect(dimension.notes).toBeDefined();
      }
    }
  });

  it("marks the long-range dimensions (§2.2 marquee advantage)", () => {
    const longRange = BENCHMARK_QUALITY_RUBRIC.dimensions
      .filter((d) => d.longRange)
      .map((d) => d.id)
      .sort();
    expect(longRange).toEqual(["callbacks_foreshadowing", "character_voice_consistency"]);
  });

  it("marks the §2.2 technical dimensions also covered deterministically (§3)", () => {
    const alsoDeterministic = BENCHMARK_QUALITY_RUBRIC.dimensions
      .filter((d) => d.alsoDeterministic)
      .map((d) => d.id)
      .sort();
    expect(alsoDeterministic).toEqual([
      "choice_branch_correctness",
      "speaker_attribution",
      "textbox_fit_wordwrap",
    ]);
  });

  it("requires a citation below score 4 (§2.1)", () => {
    expect(BENCHMARK_QUALITY_RUBRIC.citationRequiredBelowScore).toBe(4);
  });

  it("reports per-dimension vectors only until §12 weighting is decided (§2.3)", () => {
    expect(BENCHMARK_QUALITY_RUBRIC.weighting.policy).toBe("per_dimension_vector_only");
    expect(BENCHMARK_QUALITY_RUBRIC.weighting.singleWeightedTotalReported).toBe(false);
  });
});

describe("BenchmarkQualityRubric — assertion rejects divergence", () => {
  const clone = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(BENCHMARK_QUALITY_RUBRIC)) as Record<string, unknown>;

  it("rejects a dropped dimension", () => {
    const bad = clone();
    (bad.dimensions as unknown[]).pop();
    expect(() => assertBenchmarkQualityRubric(bad)).toThrow();
  });

  it("rejects an added dimension", () => {
    const bad = clone();
    (bad.dimensions as unknown[]).push({
      id: "invented_dimension",
      title: "Invented",
      group: "technical",
      criterion: "x",
      taxonomyCategory: "accuracy",
      longRange: false,
      alsoDeterministic: false,
      taxonomyMappingSource: "section_2",
    });
    expect(() => assertBenchmarkQualityRubric(bad)).toThrow();
  });

  it("rejects a taxonomy category outside itotori-lqa-1", () => {
    const bad = clone();
    (bad.dimensions as Array<Record<string, unknown>>)[0].taxonomyCategory = "not_a_category";
    expect(() => assertBenchmarkQualityRubric(bad)).toThrow();
  });

  it("rejects a score outside 0–4", () => {
    const bad = clone();
    (bad.scale as Array<Record<string, unknown>>)[0].score = 5;
    expect(() => assertBenchmarkQualityRubric(bad)).toThrow();
  });

  it("rejects an MQM band severity outside the taxonomy severities", () => {
    const bad = clone();
    (bad.scale as Array<Record<string, unknown>>)[1].mqmBand = {
      kind: "severity",
      severity: "blocker",
    };
    expect(() => assertBenchmarkQualityRubric(bad)).toThrow();
  });

  it("rejects a single weighted total (premature weighting)", () => {
    const bad = clone();
    (bad.weighting as Record<string, unknown>).singleWeightedTotalReported = true;
    expect(() => assertBenchmarkQualityRubric(bad)).toThrow();
  });
});

// Type-level guard: BenchmarkRubricScore stays the 0–4 literal union.
const _scoreTypeGuard: BenchmarkRubricScore[] = [0, 1, 2, 3, 4];
void _scoreTypeGuard;
