// benchmark-deterministic-metric-suite (§3) — unit tests.
//
// Every metric must: (a) score a clean contestant output 1.0 with no findings,
// (b) detect the specific failure it targets on a synthetic fixture (scoring
// worse + emitting a finding in the right taxonomy vocabulary), and (c) be
// reproducible (same input → byte-identical output). Back-translation must be a
// tripwire, not a score.

import { describe, expect, it } from "vitest";
import {
  LOCALIZATION_QUALITY_CATEGORIES,
  LOCALIZATION_ROOT_CAUSES,
  QUALITY_DETECTOR_KINDS,
} from "@itotori/localization-bridge-schema";
import {
  BACK_TRANSLATION_CHECK_NAME,
  DeterministicMetricSuiteError,
  backTranslationTripwire,
  choiceBranchCorrectness,
  glossaryConsistency,
  namedEntityConsistency,
  runDeterministicMetricSuite,
  speakerAttribution,
  untranslatedResidue,
  voiceStyleFingerprint,
  wrapCompliance,
  type CanonTerm,
  type MetricSystemInput,
  type MetricUnit,
} from "../../src/benchmark-stages/index.js";

let unitCounter = 0;
function uid(): string {
  unitCounter += 1;
  return `019ed010-0000-7000-8000-${unitCounter.toString(16).padStart(12, "0")}`;
}

function unit(partial: Omit<MetricUnit, "unitId" | "label"> & { label?: string }): MetricUnit {
  return { unitId: uid(), label: partial.label ?? "line", ...partial };
}

function system(units: MetricUnit[], systemId = "itotori-on"): MetricSystemInput {
  return { systemId, systemKind: "itotori_draft", units };
}

const GLOSSARY: CanonTerm[] = [{ sourceTerm: "剣", targetForm: "Longblade" }];
const CANON_NAMES: CanonTerm[] = [{ sourceTerm: "巴", targetForm: "Tomoe" }];

describe("glossary/terminology consistency (§3)", () => {
  it("scores a consistent contestant 1.0 with no findings", () => {
    const out = glossaryConsistency(
      system([
        unit({ sourceText: "剣を取れ。剣だ。", targetText: "Take the Longblade. The Longblade." }),
      ]),
      GLOSSARY,
    );
    expect(out.score).toBe(1);
    expect(out.findings).toHaveLength(0);
  });

  it("scores glossary drift worse and flags glossary_violation", () => {
    const drift = glossaryConsistency(
      system([unit({ sourceText: "剣を取れ。", targetText: "Take the sword." })]),
      GLOSSARY,
    );
    const consistent = glossaryConsistency(
      system([unit({ sourceText: "剣を取れ。", targetText: "Take the Longblade." })]),
      GLOSSARY,
    );
    expect(drift.score).toBeLessThan(consistent.score);
    expect(drift.findings[0]?.qualitySubcategory).toBe("glossary_violation");
    expect(drift.findings[0]?.category).toBe("terminology");
  });
});

describe("named-entity consistency (§3)", () => {
  it("flags a non-canon name spelling and scores worse", () => {
    const off = namedEntityConsistency(
      system([unit({ sourceText: "巴が笑う。", targetText: "Tomoya laughs." })]),
      CANON_NAMES,
    );
    const canon = namedEntityConsistency(
      system([unit({ sourceText: "巴が笑う。", targetText: "Tomoe laughs." })]),
      CANON_NAMES,
    );
    expect(canon.score).toBe(1);
    expect(off.score).toBeLessThan(1);
    expect(off.findings[0]?.qualitySubcategory).toBe("canon_name_violation");
  });
});

describe("text-box / word-wrap compliance (§3)", () => {
  const box = { columns: 12, maxLines: 2 };
  it("passes text that fits the box", () => {
    const out = wrapCompliance(
      system([unit({ sourceText: "s", targetText: "Hi there ok", boxMetrics: box })]),
    );
    expect(out.score).toBe(1);
    expect(out.findings).toHaveLength(0);
  });

  it("fails an overflowing line and reports the worst overrun", () => {
    const overflow = wrapCompliance(
      system([
        unit({ sourceText: "s", targetText: "Supercalifragilistic monologue", boxMetrics: box }),
      ]),
    );
    expect(overflow.score).toBeLessThan(1);
    expect(overflow.detail.worstOverrunColumns).toBeGreaterThan(0);
    expect(overflow.findings[0]?.qualitySubcategory).toBe("overflow_or_truncation");
    expect(overflow.findings[0]?.category).toBe("layout");
  });
});

describe("speaker-attribution correctness (§3)", () => {
  it("passes when attribution matches the decode", () => {
    const out = speakerAttribution(
      system([
        unit({ sourceText: "s", targetText: "t", decodedSpeaker: "Rin", attributedSpeaker: "Rin" }),
      ]),
    );
    expect(out.score).toBe(1);
  });

  it("flags a mis-attributed speaker", () => {
    const out = speakerAttribution(
      system([
        unit({ sourceText: "s", targetText: "t", decodedSpeaker: "Rin", attributedSpeaker: "Sae" }),
      ]),
    );
    expect(out.score).toBe(0);
    expect(out.findings[0]?.qualitySubcategory).toBe("context_misread");
  });
});

describe("choice/branch correctness (§3)", () => {
  const expected = [{ branchTarget: "goto-2050" }, { branchTarget: "goto-2060" }];
  it("passes when branch targets are preserved in order", () => {
    const out = choiceBranchCorrectness(
      system([
        unit({
          sourceText: "s",
          targetText: "t",
          choice: { expectedOptions: expected, actualOptions: expected },
        }),
      ]),
    );
    expect(out.score).toBe(1);
  });

  it("flags a reordered / shifted branch mapping", () => {
    const shifted = [{ branchTarget: "goto-2060" }, { branchTarget: "goto-2050" }];
    const out = choiceBranchCorrectness(
      system([
        unit({
          sourceText: "s",
          targetText: "t",
          choice: { expectedOptions: expected, actualOptions: shifted },
        }),
      ]),
    );
    expect(out.score).toBe(0);
    expect(out.findings[0]?.qualitySubcategory).toBe("choice_semantics_shift");
  });
});

describe("untranslated-residue detection (§3)", () => {
  it("passes fully translated text", () => {
    const out = untranslatedResidue(system([unit({ sourceText: "剣", targetText: "Sword." })]));
    expect(out.score).toBe(1);
  });

  it("flags residual source script outside protected spans", () => {
    const out = untranslatedResidue(
      system([unit({ sourceText: "剣", targetText: "Take the 剣 now." })]),
    );
    expect(out.score).toBeLessThan(1);
    expect(out.detail.residualCodepoints).toBe(1);
    expect(out.findings[0]?.qualitySubcategory).toBe("omission");
  });

  it("does not flag residue inside declared protected spans", () => {
    const out = untranslatedResidue(
      system([unit({ sourceText: "剣", targetText: "Hello {巴}!", protectedSpans: ["{巴}"] })]),
    );
    expect(out.score).toBe(1);
    expect(out.findings).toHaveLength(0);
  });
});

describe("character-voice style fingerprint (§3)", () => {
  const driftThreshold = 0.5;
  it("does not flag a speaker whose voice is stable across scenes", () => {
    const out = voiceStyleFingerprint(
      system([
        unit({
          sourceText: "s",
          targetText: "I can't stay long, sorry.",
          speakerId: "Rin",
          sceneId: "A",
        }),
        unit({
          sourceText: "s",
          targetText: "I won't be able to help, sadly.",
          speakerId: "Rin",
          sceneId: "B",
        }),
      ]),
      driftThreshold,
    );
    expect(out.score).toBe(1);
    expect(out.findings).toHaveLength(0);
  });

  it("flags a speaker whose fingerprint swings across scenes", () => {
    const out = voiceStyleFingerprint(
      system([
        unit({ sourceText: "s", targetText: "Yeah.", speakerId: "Rin", sceneId: "A" }),
        unit({
          sourceText: "s",
          targetText:
            "Would you please be so kind as to consider, sir, this most elaborate and thoroughly formal proposition that I have prepared.",
          speakerId: "Rin",
          sceneId: "B",
        }),
      ]),
      driftThreshold,
    );
    expect(out.score).toBeLessThan(1);
    expect(out.findings[0]?.qualitySubcategory).toBe("speaker_voice_drift");
    expect(out.detail.worstDriftCoefficient).toBeGreaterThan(driftThreshold);
  });
});

describe("back-translation TRIPWIRE (§3, not a score)", () => {
  const floor = 0.3;
  it("does not trip when the back-translation is faithful to the source", () => {
    const out = backTranslationTripwire(
      system([
        unit({
          sourceText: "剣を取れ、勇者よ。",
          targetText: "t",
          backTranslation: "剣を取れ、勇者よ。",
        }),
      ]),
      floor,
    );
    expect(out.tripwires[0]?.tripped).toBe(false);
    expect(out.findings).toHaveLength(0);
  });

  it("trips on gross meaning loss and emits a signal finding", () => {
    const out = backTranslationTripwire(
      system([
        unit({
          sourceText: "剣を取れ、勇者よ。",
          targetText: "t",
          backTranslation: "今日は良い天気ですね。",
        }),
      ]),
      floor,
    );
    expect(out.tripwires[0]?.tripped).toBe(true);
    expect(out.findings[0]?.qualitySubcategory).toBe("mistranslation");
    // Structural proof it is a tripwire, not a score: no `score` field exists.
    expect("score" in out).toBe(false);
  });
});

function fullSystem(
  systemId: string,
  targets: { sword: string; residue?: string },
): MetricSystemInput {
  return system(
    [
      unit({
        sourceText: "剣を取れ。",
        targetText: targets.sword,
        decodedSpeaker: "Rin",
        attributedSpeaker: "Rin",
        boxMetrics: { columns: 40, maxLines: 3 },
        speakerId: "Rin",
        sceneId: "A",
      }),
      unit({
        sourceText: "巴が来る。",
        targetText: targets.residue ?? "Tomoe is coming.",
        decodedSpeaker: "Rin",
        attributedSpeaker: "Rin",
        speakerId: "Rin",
        sceneId: "B",
        backTranslation: "巴が来る。",
      }),
    ],
    systemId,
  );
}

describe("deterministic metric suite runner (§3)", () => {
  const suiteInput = () => ({
    systems: [
      fullSystem("itotori-on", { sword: "Take the Longblade." }),
      fullSystem("raw-mtl", { sword: "Take the sword.", residue: "巴 is coming." }),
    ],
    glossary: GLOSSARY,
    canonNames: CANON_NAMES,
    startedAt: "2026-07-05T00:00:00.000Z",
    completedAt: "2026-07-05T00:00:01.000Z",
  });

  it("emits one DeterministicQaResult per (system, metric) including the tripwire", () => {
    const result = runDeterministicMetricSuite(suiteInput());
    // 7 scored metrics + 1 tripwire check = 8 checks per system, 2 systems.
    expect(result.results).toHaveLength(16);
    const checkNames = new Set(result.results.map((r) => r.checkName));
    expect(checkNames.has(BACK_TRANSLATION_CHECK_NAME)).toBe(true);
    for (const r of result.results) {
      expect(r.passedRuleCount + r.failedRuleCount).toBe(r.ruleCount);
    }
  });

  it("keeps back-translation OUT of the comparable scores (tripwire, not a score)", () => {
    const result = runDeterministicMetricSuite(suiteInput());
    expect(result.scores.some((s) => s.checkName === BACK_TRANSLATION_CHECK_NAME)).toBe(false);
    // 7 scored metrics per system, 2 systems.
    expect(result.scores).toHaveLength(14);
    expect(result.tripwires.length).toBeGreaterThan(0);
  });

  it("scores are comparable across contestants (glossary drift ranks raw-mtl below itotori)", () => {
    const result = runDeterministicMetricSuite(suiteInput());
    const on = result.scores.find(
      (s) => s.systemId === "itotori-on" && s.metricId === "glossary-consistency",
    );
    const mtl = result.scores.find(
      (s) => s.systemId === "raw-mtl" && s.metricId === "glossary-consistency",
    );
    expect(on?.score).toBe(1);
    expect(mtl?.score).toBeLessThan(1);
  });

  it("records the effective config for reproducibility", () => {
    const result = runDeterministicMetricSuite(suiteInput());
    expect(result.config.backTranslationTripwireFloor).toBe(0.3);
    expect(result.config.voiceDriftThreshold).toBe(0.5);
  });

  it("is reproducible: same input → byte-identical output", () => {
    const input = suiteInput();
    expect(runDeterministicMetricSuite(input)).toEqual(runDeterministicMetricSuite(input));
  });

  it("emits only itotori-lqa-1 vocabulary (no forked taxonomy)", () => {
    const result = runDeterministicMetricSuite(suiteInput());
    for (const f of result.findings) {
      expect(f.taxonomyId).toBe("itotori-lqa-1");
      expect(QUALITY_DETECTOR_KINDS).toContain(f.detectorKind);
      expect(LOCALIZATION_QUALITY_CATEGORIES).toContain(f.category);
      expect(LOCALIZATION_ROOT_CAUSES).toContain(f.rootCause);
      expect(f.detectorKind).toBe("deterministic_qa");
    }
  });

  it("refuses empty systems and zero-unit systems", () => {
    expect(() => runDeterministicMetricSuite({ ...suiteInput(), systems: [] })).toThrow(
      DeterministicMetricSuiteError,
    );
    expect(() =>
      runDeterministicMetricSuite({
        ...suiteInput(),
        systems: [{ systemId: "empty", systemKind: "itotori_draft", units: [] }],
      }),
    ).toThrow(DeterministicMetricSuiteError);
  });
});
