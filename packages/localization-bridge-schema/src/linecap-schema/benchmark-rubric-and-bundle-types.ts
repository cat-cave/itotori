import { BRIDGE_SCHEMA_VERSION_V02, Bcp47Locale, Uuid7 } from "./bridge-core-types.js";
import {
  LOCALIZATION_QUALITY_CATEGORIES,
  LOCALIZATION_QUALITY_SEVERITIES,
  LOCALIZATION_QUALITY_TAXONOMY_ID,
  LOCALIZATION_QUALITY_TAXONOMY_VERSION,
  LocalizationQualityCategoryV02,
  LocalizationQualitySeverityV02,
} from "./schema-enums.js";
import {
  BridgeAssetV02,
  HashStrategyV02,
  SourceGameRevisionV02,
  SourceRevisionV02,
} from "./bridge-context-types.js";
import { LocalizationUnitV02, PolicyRecordV02 } from "./localization-triage-types.js";
import {
  BENCHMARK_QUALITY_RUBRIC_ID,
  BENCHMARK_QUALITY_RUBRIC_VERSION,
  BENCHMARK_RUBRIC_CITATION_REQUIRED_BELOW_SCORE,
  BENCHMARK_RUBRIC_DIMENSION_GROUPS,
  BENCHMARK_RUBRIC_DIMENSION_IDS,
  BENCHMARK_RUBRIC_MAPPING_SOURCES,
  BENCHMARK_RUBRIC_SCORES,
  BenchmarkQualityRubric,
  BenchmarkRubricDimensionId,
  BenchmarkRubricMqmBand,
  BenchmarkRubricScore,
} from "./benchmark-types.js";
import {
  asArray,
  asRecord,
  assertOptionalString,
  assertString,
} from "./fixture-utility-validation.js";
import { assertBoolean, assertEnum, assertEqual } from "./validation-primitives.js";

export const BENCHMARK_QUALITY_RUBRIC: BenchmarkQualityRubric = {
  rubricId: BENCHMARK_QUALITY_RUBRIC_ID,
  rubricVersion: BENCHMARK_QUALITY_RUBRIC_VERSION,
  taxonomyId: LOCALIZATION_QUALITY_TAXONOMY_ID,
  taxonomyVersion: LOCALIZATION_QUALITY_TAXONOMY_VERSION,
  methodologyRef: "docs/itotori-translation-benchmark-methodology.md#2-the-quality-rubric",
  citationRequiredBelowScore: BENCHMARK_RUBRIC_CITATION_REQUIRED_BELOW_SCORE,
  scale: [
    {
      score: 4,
      anchor: "Ideal for this dimension in context; a careful pro would sign off.",
      mqmCorrespondence: "no defect",
      mqmBand: { kind: "no_defect" },
    },
    {
      score: 3,
      anchor: "Minor issue a target-language player might notice; core intent intact.",
      mqmCorrespondence: "minor",
      mqmBand: { kind: "severity", severity: "minor" },
    },
    {
      score: 2,
      anchor: "Material defect a player would notice; should be repaired before a quality claim.",
      mqmCorrespondence: "major",
      mqmBand: { kind: "severity", severity: "major" },
    },
    {
      score: 1,
      anchor: "Serious defect; meaning, voice, or usability substantially harmed.",
      mqmCorrespondence: "between major and critical",
      mqmBand: { kind: "between", lower: "major", upper: "critical" },
    },
    {
      score: 0,
      anchor:
        "Broken/unusable for this dimension: meaning inversion, unreadable, protected-content loss.",
      mqmCorrespondence: "critical",
      mqmBand: { kind: "severity", severity: "critical" },
    },
  ],
  dimensions: [
    {
      id: "adequacy",
      title: "Adequacy (in-context meaning)",
      group: "adequacy_accuracy",
      criterion:
        "Does the target preserve the source proposition GIVEN the decoded scene/speaker/branch context? Penalize mistranslation, omission, addition, over/under-specification, context misread.",
      taxonomyCategory: "accuracy",
      longRange: false,
      alsoDeterministic: false,
      taxonomyMappingSource: "section_2",
    },
    {
      id: "callbacks_foreshadowing",
      title: "Callbacks / foreshadowing consistency",
      group: "adequacy_accuracy",
      criterion:
        "Are setups, running gags, foreshadowed lines, and later payoffs rendered consistently ACROSS the work? A long-range accuracy dimension.",
      taxonomyCategory: "accuracy",
      longRange: true,
      conditionalScoring: "Scored only when the corpus alignment links a callback to its origin.",
      alsoDeterministic: false,
      taxonomyMappingSource: "section_2",
    },
    {
      id: "fluency",
      title: "Fluency / naturalness",
      group: "fluency",
      criterion:
        "Grammatical, idiomatic, readable target-language prose that fits the genre and narrative mode.",
      taxonomyCategory: "style",
      longRange: false,
      alsoDeterministic: false,
      taxonomyMappingSource: "section_2",
    },
    {
      id: "register_politeness",
      title: "Register + politeness (keigo → English)",
      group: "localization_craft",
      criterion:
        "Is Japanese formality/politeness (keigo, plain form, rough speech) rendered with an appropriate English register for the relationship and scene?",
      taxonomyCategory: "tone_register",
      longRange: false,
      alsoDeterministic: false,
      taxonomyMappingSource: "section_2",
    },
    {
      id: "character_voice_consistency",
      title: "Character-voice consistency (long-range)",
      group: "localization_craft",
      criterion:
        "Does a character keep a coherent, distinct English voice ACROSS the whole work, not just within a line? The marquee dimension; scored against multiple sampled lines for the same speaker drawn from different scenes/routes.",
      taxonomyCategory: "tone_register",
      taxonomySubcategory: "speaker_voice_drift",
      longRange: true,
      alsoDeterministic: false,
      taxonomyMappingSource: "section_2",
    },
    {
      id: "honorifics",
      title: "Honorifics handling",
      group: "localization_craft",
      criterion:
        "Are -san/-chan/-senpai/... and address forms handled per a declared, CONSISTENT policy (kept, dropped, or mapped), and applied uniformly? The policy choice is not scored; consistency and appropriateness to it are.",
      taxonomyCategory: "tone_register",
      taxonomySubcategory: "honorific_misuse",
      longRange: false,
      alsoDeterministic: false,
      taxonomyMappingSource: "section_2",
    },
    {
      id: "wordplay_puns_songs",
      title: "Wordplay / puns / songs",
      group: "localization_craft",
      criterion:
        "Are puns, rhymes, acrostics, dialect jokes, and song lyrics adapted so the EFFECT survives, rather than flattened or footnoted away? Highest-difficulty, lowest-frequency dimension.",
      taxonomyCategory: "style",
      longRange: false,
      alsoDeterministic: false,
      taxonomyMappingSource: "reasoned_default",
      notes:
        "§2.2 does not tag this dimension to an itotori-lqa-1 category. Mapped to `style` (target-language creative rendering; nearest MQM category via genre_voice_mismatch/unidiomatic) as a reasoned default — NOT a §2 directive. Flag for Trevor.",
    },
    {
      id: "cultural_adaptation",
      title: "Cultural adaptation",
      group: "localization_craft",
      criterion:
        "Are culture-bound references handled so a target player gets the intended intent without confusion or lost meaning?",
      taxonomyCategory: "locale_convention",
      longRange: false,
      alsoDeterministic: false,
      taxonomyMappingSource: "section_2",
    },
    {
      id: "textbox_fit_wordwrap",
      title: "Text-box fit / word-wrap",
      group: "technical",
      criterion:
        "Does the line fit its presentation slot without overflow/truncation, and wrap readably? The rubric scores the judgment call; §3 scores the mechanical fact.",
      taxonomyCategory: "layout",
      longRange: false,
      alsoDeterministic: true,
      taxonomyMappingSource: "section_2",
    },
    {
      id: "speaker_attribution",
      title: "Speaker attribution",
      group: "technical",
      criterion:
        "Is the line attributed to the correct speaker per decoded ground truth? The rubric scores the judgment call; §3 scores the mechanical fact.",
      taxonomyCategory: "technical_integrity",
      taxonomySubcategory: "asset_binding_broken",
      longRange: false,
      alsoDeterministic: true,
      taxonomyMappingSource: "reasoned_default",
      notes:
        "§2.2 does not tag this dimension to an itotori-lqa-1 category. Mapped to `technical_integrity.asset_binding_broken` ('Localized text is attached to the wrong asset, speaker, event, or UI element') — the exact taxonomy match — as a reasoned default. Flag for Trevor.",
    },
    {
      id: "choice_branch_correctness",
      title: "Choice / branch correctness",
      group: "technical",
      criterion:
        "Does a menu choice or branch option preserve the player's intended action and route? The rubric scores the judgment call; §3 scores the mechanical fact.",
      taxonomyCategory: "accuracy",
      taxonomySubcategory: "choice_semantics_shift",
      longRange: false,
      alsoDeterministic: true,
      taxonomyMappingSource: "section_2",
    },
  ],
  weighting: {
    policy: "per_dimension_vector_only",
    singleWeightedTotalReported: false,
    openDecisionRef: "docs/itotori-translation-benchmark-methodology.md#23-weighting",
  },
};

/** The §2.1 MQM-severity band for a rubric score. */
export function benchmarkRubricMqmBandForScore(
  score: BenchmarkRubricScore,
): BenchmarkRubricMqmBand {
  const anchor = BENCHMARK_QUALITY_RUBRIC.scale.find((entry) => entry.score === score);
  if (anchor === undefined) {
    throw new Error(`benchmarkRubricMqmBandForScore: ${String(score)} is not a rubric score`);
  }
  return anchor.mqmBand;
}

/**
 * Discrete `itotori-lqa-1` severity a rubric score converts into for finding
 * emission (`BenchmarkFindingRecordV02.qualitySeverity`). Returns `null` for a
 * score of 4 (no defect → no finding). Score 1 ("between major and critical",
 * §2.1) is emitted as `major`: the taxonomy reserves `critical` for the
 * unusable/inversion/blocker case that the rubric assigns to score 0, so
 * score 1 sits at the severe end of `major` rather than at `critical`. This is
 * the one reasoned call where §2.1 gives a band, not a single value; the full
 * band is preserved by {@link benchmarkRubricMqmBandForScore}.
 */
export function benchmarkRubricQualitySeverityForScore(
  score: BenchmarkRubricScore,
): LocalizationQualitySeverityV02 | null {
  const band = benchmarkRubricMqmBandForScore(score);
  switch (band.kind) {
    case "no_defect":
      return null;
    case "severity":
      return band.severity;
    case "between":
      return band.lower;
  }
}

export type BenchmarkRubricTaxonomyTarget = {
  category: LocalizationQualityCategoryV02;
  subcategory?: string;
};

/** The `itotori-lqa-1` category (+ subcategory) a dimension's findings carry. */
export function benchmarkRubricTaxonomyTargetForDimension(
  dimensionId: BenchmarkRubricDimensionId,
): BenchmarkRubricTaxonomyTarget {
  const dimension = BENCHMARK_QUALITY_RUBRIC.dimensions.find((entry) => entry.id === dimensionId);
  if (dimension === undefined) {
    throw new Error(
      `benchmarkRubricTaxonomyTargetForDimension: unknown dimension ${String(dimensionId)}`,
    );
  }
  return dimension.taxonomySubcategory === undefined
    ? { category: dimension.taxonomyCategory }
    : { category: dimension.taxonomyCategory, subcategory: dimension.taxonomySubcategory };
}

/**
 * Strict validation of a benchmark quality rubric. Throws on any divergence
 * from the §2 shape: the exact {0,1,2,3,4} scale, all §2.2 dimensions present
 * exactly once, every taxonomy mapping landing in the `itotori-lqa-1`
 * vocabulary, and the per-dimension-vector-only weighting policy.
 */
export function assertBenchmarkQualityRubric(
  value: unknown,
): asserts value is BenchmarkQualityRubric {
  const rubric = asRecord(value, "BenchmarkQualityRubric");
  assertEqual(rubric.rubricId, BENCHMARK_QUALITY_RUBRIC_ID, "BenchmarkQualityRubric.rubricId");
  assertEqual(
    rubric.rubricVersion,
    BENCHMARK_QUALITY_RUBRIC_VERSION,
    "BenchmarkQualityRubric.rubricVersion",
  );
  assertEqual(
    rubric.taxonomyId,
    LOCALIZATION_QUALITY_TAXONOMY_ID,
    "BenchmarkQualityRubric.taxonomyId",
  );
  assertEqual(
    rubric.taxonomyVersion,
    LOCALIZATION_QUALITY_TAXONOMY_VERSION,
    "BenchmarkQualityRubric.taxonomyVersion",
  );
  assertString(rubric.methodologyRef, "BenchmarkQualityRubric.methodologyRef");
  if (rubric.citationRequiredBelowScore !== BENCHMARK_RUBRIC_CITATION_REQUIRED_BELOW_SCORE) {
    throw new Error(
      `BenchmarkQualityRubric.citationRequiredBelowScore must be ${String(
        BENCHMARK_RUBRIC_CITATION_REQUIRED_BELOW_SCORE,
      )}`,
    );
  }

  const scale = asArray(rubric.scale, "BenchmarkQualityRubric.scale");
  if (scale.length !== BENCHMARK_RUBRIC_SCORES.length) {
    throw new Error(
      `BenchmarkQualityRubric.scale must have exactly ${BENCHMARK_RUBRIC_SCORES.length} anchors`,
    );
  }
  const seenScores = new Set<number>();
  for (const [index, entry] of scale.entries()) {
    const label = `BenchmarkQualityRubric.scale[${index}]`;
    const anchor = asRecord(entry, label);
    const score = anchor.score;
    if (
      typeof score !== "number" ||
      !(BENCHMARK_RUBRIC_SCORES as readonly number[]).includes(score)
    ) {
      throw new Error(`${label}.score must be one of: ${BENCHMARK_RUBRIC_SCORES.join(", ")}`);
    }
    if (seenScores.has(score)) {
      throw new Error(`${label}.score ${String(score)} is duplicated`);
    }
    seenScores.add(score);
    assertString(anchor.anchor, `${label}.anchor`);
    assertString(anchor.mqmCorrespondence, `${label}.mqmCorrespondence`);
    assertBenchmarkRubricMqmBand(anchor.mqmBand, `${label}.mqmBand`);
  }

  const dimensions = asArray(rubric.dimensions, "BenchmarkQualityRubric.dimensions");
  if (dimensions.length !== BENCHMARK_RUBRIC_DIMENSION_IDS.length) {
    throw new Error(
      `BenchmarkQualityRubric.dimensions must have exactly ${BENCHMARK_RUBRIC_DIMENSION_IDS.length} dimensions`,
    );
  }
  const seenDimensionIds = new Set<string>();
  for (const [index, entry] of dimensions.entries()) {
    const label = `BenchmarkQualityRubric.dimensions[${index}]`;
    const dimension = asRecord(entry, label);
    assertEnum(dimension.id, BENCHMARK_RUBRIC_DIMENSION_IDS, `${label}.id`);
    if (seenDimensionIds.has(dimension.id as string)) {
      throw new Error(`${label}.id ${String(dimension.id)} is duplicated`);
    }
    seenDimensionIds.add(dimension.id as string);
    assertString(dimension.title, `${label}.title`);
    assertEnum(dimension.group, BENCHMARK_RUBRIC_DIMENSION_GROUPS, `${label}.group`);
    assertString(dimension.criterion, `${label}.criterion`);
    assertEnum(
      dimension.taxonomyCategory,
      LOCALIZATION_QUALITY_CATEGORIES,
      `${label}.taxonomyCategory`,
    );
    assertOptionalString(dimension.taxonomySubcategory, `${label}.taxonomySubcategory`);
    assertBoolean(dimension.longRange, `${label}.longRange`);
    assertOptionalString(dimension.conditionalScoring, `${label}.conditionalScoring`);
    assertBoolean(dimension.alsoDeterministic, `${label}.alsoDeterministic`);
    assertEnum(
      dimension.taxonomyMappingSource,
      BENCHMARK_RUBRIC_MAPPING_SOURCES,
      `${label}.taxonomyMappingSource`,
    );
    assertOptionalString(dimension.notes, `${label}.notes`);
  }
  for (const id of BENCHMARK_RUBRIC_DIMENSION_IDS) {
    if (!seenDimensionIds.has(id)) {
      throw new Error(`BenchmarkQualityRubric.dimensions is missing §2.2 dimension '${id}'`);
    }
  }

  const weighting = asRecord(rubric.weighting, "BenchmarkQualityRubric.weighting");
  assertEqual(
    weighting.policy,
    "per_dimension_vector_only",
    "BenchmarkQualityRubric.weighting.policy",
  );
  if (weighting.singleWeightedTotalReported !== false) {
    throw new Error(
      "BenchmarkQualityRubric.weighting.singleWeightedTotalReported must be false (per-dimension vectors only until §12 weighting is decided)",
    );
  }
  assertString(weighting.openDecisionRef, "BenchmarkQualityRubric.weighting.openDecisionRef");
}

export function assertBenchmarkRubricMqmBand(
  value: unknown,
  label: string,
): asserts value is BenchmarkRubricMqmBand {
  const band = asRecord(value, label);
  const kind = band.kind;
  if (kind === "no_defect") {
    return;
  }
  if (kind === "severity") {
    assertEnum(band.severity, LOCALIZATION_QUALITY_SEVERITIES, `${label}.severity`);
    return;
  }
  if (kind === "between") {
    assertEnum(band.lower, LOCALIZATION_QUALITY_SEVERITIES, `${label}.lower`);
    assertEnum(band.upper, LOCALIZATION_QUALITY_SEVERITIES, `${label}.upper`);
    return;
  }
  throw new Error(`${label}.kind must be one of: no_defect, severity, between`);
}

export type BridgeBundleV02 = {
  schemaVersion: typeof BRIDGE_SCHEMA_VERSION_V02;
  bridgeId: Uuid7;
  sourceGame: SourceGameRevisionV02;
  sourceBundleHash: string;
  sourceBundleRevision: SourceRevisionV02;
  sourceLocale: Bcp47Locale;
  hashStrategy: HashStrategyV02;
  extractor: {
    name: string;
    version: string;
  };
  assets: BridgeAssetV02[];
  units: LocalizationUnitV02[];
  policyRecords: PolicyRecordV02[];
};
