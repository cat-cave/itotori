// benchmark-deterministic-metric-suite (§3) — character-voice style fingerprint.
//
// Per speaker, a quantitative style fingerprint (mean sentence length,
// contraction rate, politeness-marker rate) is computed per SCENE, and the
// intra-speaker VARIANCE across scenes is reported as a drift proxy (§3:
// "Deterministic and reference-free; complements the subjective long-range
// voice dimension"). Spread is measured as a scale-free coefficient of
// variation so terse and verbose speakers are comparable; a speaker whose
// worst per-feature CV exceeds the configured threshold is flagged as drifting.

import { buildMetricFinding } from "./findings.js";
import { coefficientOfVariation, mean, styleFeatures } from "./text-utils.js";
import type { MetricSystemInput, ScoredMetricOutcome } from "./types.js";

const CHECK_VERSION = "0.1.0";

type SceneFeatures = {
  meanSentenceLength: number;
  contractionRate: number;
  politenessRate: number;
};

/**
 * §3 character-voice style fingerprint. Returns a per-system drift score
 * (fraction of evaluated speakers whose voice stays consistent across scenes)
 * plus a `speaker_voice_drift` finding for each speaker over the threshold.
 * Only speakers appearing in ≥2 scenes are evaluated (variance is undefined
 * for a single scene).
 */
export function voiceStyleFingerprint(
  system: MetricSystemInput,
  driftThreshold: number,
): ScoredMetricOutcome {
  const findings: ScoredMetricOutcome["findings"] = [];

  // speakerId -> sceneId -> per-unit feature vectors (insertion-ordered).
  const bySpeaker = new Map<string, Map<string, SceneFeatures[]>>();
  const representativeUnit = new Map<string, { unitId: string; label: string }>();

  for (const unit of system.units) {
    if (unit.speakerId === undefined || unit.sceneId === undefined) {
      continue;
    }
    if (!representativeUnit.has(unit.speakerId)) {
      representativeUnit.set(unit.speakerId, { unitId: unit.unitId, label: unit.label });
    }
    let byScene = bySpeaker.get(unit.speakerId);
    if (byScene === undefined) {
      byScene = new Map<string, SceneFeatures[]>();
      bySpeaker.set(unit.speakerId, byScene);
    }
    const sceneUnits = byScene.get(unit.sceneId) ?? [];
    sceneUnits.push(styleFeatures(unit.targetText));
    byScene.set(unit.sceneId, sceneUnits);
  }

  let evaluatedSpeakers = 0;
  let consistentSpeakers = 0;
  let worstDriftOverall = 0;

  for (const [speakerId, byScene] of bySpeaker) {
    if (byScene.size < 2) {
      continue;
    }
    evaluatedSpeakers += 1;
    const sentenceLengths: number[] = [];
    const contractionRates: number[] = [];
    const politenessRates: number[] = [];
    for (const sceneUnits of byScene.values()) {
      sentenceLengths.push(mean(sceneUnits.map((f) => f.meanSentenceLength)));
      contractionRates.push(mean(sceneUnits.map((f) => f.contractionRate)));
      politenessRates.push(mean(sceneUnits.map((f) => f.politenessRate)));
    }
    const driftScore = Math.max(
      coefficientOfVariation(sentenceLengths),
      coefficientOfVariation(contractionRates),
      coefficientOfVariation(politenessRates),
    );
    if (driftScore > worstDriftOverall) {
      worstDriftOverall = driftScore;
    }
    if (driftScore <= driftThreshold) {
      consistentSpeakers += 1;
      continue;
    }
    const rep = representativeUnit.get(speakerId) ?? { unitId: speakerId, label: speakerId };
    findings.push(
      buildMetricFinding({
        systemId: system.systemId,
        checkName: "voice-style-fingerprint",
        checkVersion: CHECK_VERSION,
        unitId: rep.unitId,
        label: rep.label,
        discriminator: `speaker:${speakerId}`,
        violation: {
          category: "tone_register",
          qualitySubcategory: "speaker_voice_drift",
          qualitySeverity: "minor",
          rootCause: "prompt_or_context_pack_error",
          expectedValue: `speaker '${speakerId}' style CV <= ${driftThreshold} across scenes`,
          observedValue: `speaker '${speakerId}' worst-feature style CV ${driftScore.toFixed(4)} across ${byScene.size} scenes`,
          rationale: `Speaker '${speakerId}' style fingerprint varies across scenes (worst-feature coefficient of variation ${driftScore.toFixed(4)} > ${driftThreshold}); possible long-range voice drift.`,
        },
      }),
    );
  }

  const drifting = evaluatedSpeakers - consistentSpeakers;
  return {
    metricId: "voice-style-fingerprint",
    checkName: "voice-style-fingerprint",
    checkVersion: CHECK_VERSION,
    ruleCount: evaluatedSpeakers,
    passedRuleCount: consistentSpeakers,
    failedRuleCount: drifting,
    score: evaluatedSpeakers === 0 ? 1 : consistentSpeakers / evaluatedSpeakers,
    detail: {
      evaluatedSpeakers,
      consistentSpeakers,
      driftingSpeakers: drifting,
      worstDriftCoefficient: worstDriftOverall,
    },
    findings,
  };
}
