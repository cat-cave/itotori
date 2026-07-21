// Methodology §9 metric-caught sensitivity — judge-INDEPENDENT assertions.
//
// Path (b) of benchmark-sensitivity-metric-caught-meaning-shift:
// residue/overflow sabotage is caught by REAL pure §3 metrics (no
// qualityScoreFn, no scripted SABOTAGE_*_MARKER judge). Meaning/voice
// sabotage is documented as judge-dependent: the same metrics correctly do
// NOT fire on marker-only meaning/voice sabotage.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_RESIDUE_MARKER,
  JUDGE_DEPENDENT_SABOTAGE_KINDS,
  METRIC_CAUGHT_SABOTAGE_KINDS,
  SABOTAGE_MEANING_MARKER,
  SABOTAGE_REGISTER_MARKER,
  countResidualSourceScript,
  overflowsBox,
  runMetricCaughtSensitivityCheck,
  sabotageTranslation,
  type BoxMetrics,
} from "../src/benchmark-sensitivity/index.js";

const CLEAN = "Mornin' there, Rin.";
// Wide enough that meaning/voice marker preambles do NOT trip wrap-compliance
// (those kinds are judge-dependent). Tight enough that layout_overflow (5×
// repeat) still overflows — so the metric-caught assertion is non-vacuous.
const BOX: BoxMetrics = { columns: 40, maxLines: 2 };

describe("§9 sabotage injector", () => {
  it("injects residue + overflow deterministically; stamps meaning/voice markers", () => {
    expect(sabotageTranslation(CLEAN, { kinds: ["untranslated_residue"] })).toContain(
      DEFAULT_RESIDUE_MARKER,
    );
    expect(sabotageTranslation(CLEAN, { kinds: ["meaning_shift"] })).toContain(
      SABOTAGE_MEANING_MARKER,
    );
    expect(sabotageTranslation(CLEAN, { kinds: ["voice_drift"] })).toContain(
      SABOTAGE_REGISTER_MARKER,
    );
    const overflowed = sabotageTranslation(CLEAN, { kinds: ["layout_overflow"] });
    expect(overflowed.length).toBeGreaterThan(CLEAN.length * 3);
    // Pure / order-stable.
    expect(sabotageTranslation(CLEAN, { kinds: ["untranslated_residue"] })).toBe(
      sabotageTranslation(CLEAN, { kinds: ["untranslated_residue"] }),
    );
  });
});

describe("§9 metric-caught sensitivity — independent of any scripted judge", () => {
  it("residue sabotage alone is caught by the untranslated-residue metric", () => {
    const result = runMetricCaughtSensitivityCheck({
      unit: { cleanText: CLEAN, boxMetrics: BOX },
      kinds: ["untranslated_residue"],
    });
    expect(result.passed).toBe(true);
    expect(result.cleanResidualCodepoints).toBe(0);
    const obs = result.observations[0]!;
    expect(obs.kind).toBe("untranslated_residue");
    expect(obs.residueCaught).toBe(true);
    expect(obs.metricCaught).toBe(true);
    expect(obs.residualCodepoints).toBeGreaterThan(0);
    // No judge involved: detection is pure codepoint scan.
    expect(countResidualSourceScript(obs.sabotagedText)).toBe(obs.residualCodepoints);
  });

  it("layout_overflow sabotage alone is caught by wrap-compliance", () => {
    const result = runMetricCaughtSensitivityCheck({
      unit: { cleanText: CLEAN, boxMetrics: BOX },
      kinds: ["layout_overflow"],
    });
    expect(result.passed).toBe(true);
    expect(result.cleanOverflows).toBe(false);
    const obs = result.observations[0]!;
    expect(obs.kind).toBe("layout_overflow");
    expect(obs.overflowCaught).toBe(true);
    expect(obs.metricCaught).toBe(true);
    expect(overflowsBox(obs.sabotagedText, BOX)).toBe(true);
    expect(overflowsBox(CLEAN, BOX)).toBe(false);
  });

  it("both metric-caught kinds pass independently of a scripted judge", () => {
    // The entire assertion surface is the pure metric suite — there is no
    // qualityScoreFn, no SABOTAGE_*_MARKER recognition, no FixtureJudge.
    const result = runMetricCaughtSensitivityCheck({
      unit: { cleanText: CLEAN, boxMetrics: BOX },
      kinds: [...METRIC_CAUGHT_SABOTAGE_KINDS],
    });
    expect(result.passed).toBe(true);
    for (const obs of result.observations) {
      expect(obs.metricCaught).toBe(true);
    }
  });

  it("meaning_shift / voice_drift are NOT metric-caught (judge-dependent)", () => {
    // Honesty: marker-only meaning/voice sabotage is not attributed to a
    // metric. A fixture qualityScoreFn that keys on SABOTAGE_*_MARKER is a
    // test double for the LLM judge — fixture-only demotion on these kinds
    // is judge-scripted, not metric-caught. Use a generous box so the formal
    // prefix does not incidentally trip wrap-compliance.
    const generousBox: BoxMetrics = { columns: 120, maxLines: 8 };
    const result = runMetricCaughtSensitivityCheck({
      unit: { cleanText: CLEAN, boxMetrics: generousBox },
      kinds: [...JUDGE_DEPENDENT_SABOTAGE_KINDS, "untranslated_residue"],
    });
    // Overall still passes because residue is metric-caught.
    expect(result.passed).toBe(true);
    for (const kind of JUDGE_DEPENDENT_SABOTAGE_KINDS) {
      const obs = result.observations.find((o) => o.kind === kind)!;
      expect(obs.metricCaught).toBe(false);
      expect(obs.residueCaught).toBe(false);
      expect(obs.overflowCaught).toBe(false);
      // Markers are present for a scripted judge double, but metrics ignore them.
      if (kind === "meaning_shift") {
        expect(obs.sabotagedText).toContain(SABOTAGE_MEANING_MARKER);
      } else {
        expect(obs.sabotagedText).toContain(SABOTAGE_REGISTER_MARKER);
      }
    }
  });

  it("refuses a judge-only kind list (cannot claim metric-caught sensitivity)", () => {
    expect(() =>
      runMetricCaughtSensitivityCheck({
        unit: { cleanText: CLEAN, boxMetrics: BOX },
        kinds: ["meaning_shift", "voice_drift"],
      }),
    ).toThrow(/judge-dependent/i);
  });
});
