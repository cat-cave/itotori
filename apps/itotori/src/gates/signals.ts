// Signals — back-translation tripwire + voice fingerprint.
//
// These are METRICS, never release verdicts. A signal is a distinct type from
// {@link Defect}: it has no `gate`, no `origin`, no severity, and the
// facts-dominate join (./join.ts) accepts only Defects and reviewer verdicts —
// a Signal can NEVER enter a DefectBundle or block a release. Back-translation
// can only RAISE a semantic-risk flag that a source-aware reviewer may later
// turn into a defect; the voice fingerprint reports register drift for triage.
// Both are deterministic given their inputs.

import type { BackTranslateResult } from "../contracts/index.js";
import type { FactSnapshot } from "../prepass/index.js";

import { sjisByteLength } from "./byte-box.js";
import { stableDigest } from "./defect.js";
import { bindAccepted } from "./unit-index.js";
import type { AcceptedUnitOutput } from "./types.js";

export type Signal = {
  signalId: string;
  kind: "back-translation" | "voice";
  /** The unit / speaker / scene the metric describes. */
  scope: string;
  /** A raised risk flag — advisory only, never a verdict. */
  tripped: boolean;
  /** The deterministic measurement behind the flag. */
  metric: number;
  note: string;
};

const CONFIDENCE_RANK: Readonly<Record<"low" | "medium" | "high", number>> = {
  low: 0.25,
  medium: 0.5,
  high: 0.75,
};

/** Turn the diagnostic-only back-translation tool result into risk signals.
 * Emits nothing that can decide correctness — only raised risk flags. */
export function backTranslationSignals(result: BackTranslateResult): Signal[] {
  return result.signals.map((signal) => ({
    signalId: `signal:bt:${stableDigest(result.unitId, signal.kind, signal.note).slice(0, 20)}`,
    kind: "back-translation",
    scope: result.unitId,
    tripped: true,
    metric: CONFIDENCE_RANK[signal.confidence],
    note: `${signal.kind}: ${signal.note}`,
  }));
}

/**
 * A per-speaker voice-drift fingerprint: the coefficient of variation of the
 * accepted targets' Shift-JIS byte length within a speaker. A speaker whose CoV
 * exceeds `driftThreshold` is flagged as drifting — a triage signal, not a
 * defect. Speakers with fewer than two lines cannot vary and are skipped.
 */
export function voiceFingerprintSignals(
  snapshot: FactSnapshot,
  accepted: readonly AcceptedUnitOutput[],
  driftThreshold = 0.5,
): Signal[] {
  const bound = bindAccepted(snapshot, accepted);
  const bySpeaker = new Map<string, number[]>();
  for (const { fact, accepted: output } of bound.values()) {
    const speaker = fact.speaker;
    if (speaker == null || !("speakerId" in speaker)) {
      continue;
    }
    const lengths = bySpeaker.get(speaker.speakerId) ?? [];
    lengths.push(sjisByteLength(output.value.targetSkeleton));
    bySpeaker.set(speaker.speakerId, lengths);
  }

  const signals: Signal[] = [];
  for (const [speakerId, lengths] of bySpeaker) {
    if (lengths.length < 2) {
      continue;
    }
    const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
    const variance = lengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lengths.length;
    const cov = mean === 0 ? 0 : Math.sqrt(variance) / mean;
    signals.push({
      signalId: `signal:voice:${stableDigest(speakerId, lengths.length).slice(0, 20)}`,
      kind: "voice",
      scope: speakerId,
      tripped: cov > driftThreshold,
      metric: cov,
      note: `voice-length CoV ${cov.toFixed(3)} across ${lengths.length} lines (threshold ${driftThreshold})`,
    });
  }
  return signals;
}
