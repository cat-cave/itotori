// Metric-caught sensitivity — judge-INDEPENDENT half of methodology §9.
//
// Proves that residue + layout-overflow sabotage is detected by REAL pure
// deterministic §3 metrics (untranslated-residue scan + wrap-compliance), with
// ZERO judge / qualityScoreFn involvement.
//
// Meaning-shift / voice-drift sabotage is deliberately OUT of scope here: those
// kinds have no deterministic metric (taxonomy `expectedDetectorKinds` list
// only llm_qa / human_review). A fixture-only sensitivity run that demotes
// them via a hand-scripted SABOTAGE_*_MARKER judge is judge-scripted — see
// methodology §9 sensitivity honesty and sabotage.ts.

import {
  BenchmarkSensitivityError,
  sabotageTranslation,
  type SabotageConfig,
  type SabotageDefectKind,
} from "./sabotage.js";

/** Residual source-script scan: Hiragana, Katakana, and CJK unified ideographs. */
const JP_SCRIPT_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/gu;

/** Count residual source-script codepoints in a string. Pure §3 residue helper. */
export function countResidualSourceScript(text: string): number {
  return (text.match(JP_SCRIPT_PATTERN) ?? []).length;
}

/** Engine text-box metrics for wrap-compliance. */
export type BoxMetrics = {
  columns: number;
  maxLines: number;
};

/** Greedy wrap result: line count + worst per-line overrun past `columns`. */
export type WrapFit = {
  lineCount: number;
  worstOverrun: number;
};

/**
 * Greedy word-wrap into lines no wider than `columns` monospace cells.
 * Pure — same input → same output. Mirrors methodology §3 wrap-compliance.
 */
export function wrapLines(text: string, columns: number): string[] {
  if (columns <= 0) {
    throw new BenchmarkSensitivityError("box columns must be positive");
  }
  const words = text.split(/\s+/u).filter((word) => word.length > 0);
  if (words.length === 0) {
    return [];
  }
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= columns) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

export function wrapOverrun(text: string, columns: number): WrapFit {
  const lines = wrapLines(text, columns);
  let worstOverrun = 0;
  for (const line of lines) {
    const overrun = line.length - columns;
    if (overrun > worstOverrun) {
      worstOverrun = overrun;
    }
  }
  return { lineCount: lines.length, worstOverrun };
}

/** True when the target overflows the box (unbreakable token or too many lines). */
export function overflowsBox(text: string, box: BoxMetrics): boolean {
  const { lineCount, worstOverrun } = wrapOverrun(text, box.columns);
  return worstOverrun > 0 || lineCount > box.maxLines;
}

/** Sabotage kinds that REAL deterministic metrics are expected to catch. */
export const METRIC_CAUGHT_SABOTAGE_KINDS = [
  "untranslated_residue",
  "layout_overflow",
] as const satisfies readonly SabotageDefectKind[];

/** Sabotage kinds that depend on an LLM judge / human review (NOT metrics). */
export const JUDGE_DEPENDENT_SABOTAGE_KINDS = [
  "meaning_shift",
  "voice_drift",
] as const satisfies readonly SabotageDefectKind[];

export type MetricCaughtUnit = {
  /** Clean (un-sabotaged) target text. */
  cleanText: string;
  /** Box metrics required when layout_overflow is among the sabotage kinds. */
  boxMetrics?: BoxMetrics;
};

export type MetricCaughtObservation = {
  kind: SabotageDefectKind;
  sabotagedText: string;
  /** Residue codepoints after sabotage (0 = clean of source script). */
  residualCodepoints: number;
  residueCaught: boolean;
  /** Whether wrap-compliance failed (only meaningful when boxMetrics present). */
  overflowCaught: boolean;
  /**
   * true when the sabotage kind is expected to be metric-caught AND the
   * matching metric fired. For judge-dependent kinds this is always false
   * (metrics correctly do NOT fire on marker-only meaning/voice sabotage).
   */
  metricCaught: boolean;
};

export type MetricCaughtSensitivityResult = {
  /**
   * true iff every METRIC-caught sabotage kind under test was detected by its
   * real deterministic metric, and the clean control was not already failing
   * that metric. Judge-dependent kinds are reported but do not gate `passed`.
   */
  passed: boolean;
  observations: MetricCaughtObservation[];
  /** Clean control residue count (must be 0 for a fair residue control). */
  cleanResidualCodepoints: number;
  /** Clean control overflow flag (must be false when box metrics are supplied). */
  cleanOverflows: boolean;
};

/**
 * Methodology §9 metric-caught sensitivity (judge-independent).
 *
 * For each requested sabotage kind, inject the defect, re-score with the pure
 * residue + wrap metrics ONLY (no judge, no qualityScoreFn), and record whether
 * the matching metric fired. `passed` requires that every metric-caught kind
 * in `kinds` was detected and that the clean control did not already fail.
 *
 * Meaning/voice kinds may be included for honesty reporting; they never
 * contribute to `passed` and their `metricCaught` is always false.
 */
export function runMetricCaughtSensitivityCheck(input: {
  unit: MetricCaughtUnit;
  kinds: readonly SabotageDefectKind[];
}): MetricCaughtSensitivityResult {
  if (input.kinds.length === 0) {
    throw new BenchmarkSensitivityError("sensitivity check requires at least one sabotage kind");
  }

  const { cleanText, boxMetrics } = input.unit;
  const cleanResidualCodepoints = countResidualSourceScript(cleanText);
  const cleanOverflows = boxMetrics === undefined ? false : overflowsBox(cleanText, boxMetrics);

  const observations: MetricCaughtObservation[] = input.kinds.map((kind) => {
    if (kind === "layout_overflow" && boxMetrics === undefined) {
      throw new BenchmarkSensitivityError(
        "layout_overflow sabotage requires unit.boxMetrics for wrap-compliance",
      );
    }
    const config: SabotageConfig = { kinds: [kind] };
    const sabotagedText = sabotageTranslation(cleanText, config);
    const residualCodepoints = countResidualSourceScript(sabotagedText);
    const residueCaught = residualCodepoints > 0;
    const overflowCaught =
      boxMetrics === undefined ? false : overflowsBox(sabotagedText, boxMetrics);

    const isMetricKind = (METRIC_CAUGHT_SABOTAGE_KINDS as readonly string[]).includes(kind);
    let metricCaught = false;
    if (isMetricKind) {
      if (kind === "untranslated_residue") {
        metricCaught = residueCaught && cleanResidualCodepoints === 0;
      } else if (kind === "layout_overflow") {
        metricCaught = overflowCaught && !cleanOverflows;
      }
    }

    return {
      kind,
      sabotagedText,
      residualCodepoints,
      residueCaught,
      overflowCaught,
      metricCaught,
    };
  });

  const metricKindsUnderTest = observations.filter((obs) =>
    (METRIC_CAUGHT_SABOTAGE_KINDS as readonly string[]).includes(obs.kind),
  );
  if (metricKindsUnderTest.length === 0) {
    throw new BenchmarkSensitivityError(
      "metric-caught sensitivity requires at least one of untranslated_residue | layout_overflow; " +
        "meaning_shift/voice_drift are judge-dependent and cannot alone pass this check",
    );
  }

  const passed = metricKindsUnderTest.every((obs) => obs.metricCaught);

  return {
    passed,
    observations,
    cleanResidualCodepoints,
    cleanOverflows,
  };
}
