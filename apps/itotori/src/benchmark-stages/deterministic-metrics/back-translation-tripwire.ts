// benchmark-deterministic-metric-suite (§3) — back-translation TRIPWIRE.
//
// Per methodology §3, back-translation is a cheap gross-meaning-loss TRIPWIRE,
// NOT a ranking score: "it launders one MT model's opinion", so it is "a cheap
// tripwire for gross meaning loss, reported as a signal", never a quality
// score. Accordingly this module:
//   - takes the INJECTED machine back-translation of the target (the real ZDR
//     MT round-trip lives OUTSIDE this deterministic layer; here the round-trip
//     result is an input), and
//   - computes a DETERMINISTIC source↔back-translation character-bigram Dice
//     similarity, tripping only when it falls below the configured floor, and
//   - returns a `TripwireOutcome` that has NO `score` field — the suite never
//     folds it into any contestant ranking score.

import { buildMetricFinding } from "./findings.js";
import { characterBigramDice } from "./text-utils.js";
import type { BackTranslationTripwire, MetricSystemInput, TripwireOutcome } from "./types.js";

const CHECK_VERSION = "0.1.0";
export const BACK_TRANSLATION_CHECK_NAME = "back-translation-tripwire";

/**
 * §3 back-translation gross-meaning-loss tripwire for one contestant system.
 * Emits a signal finding for each unit whose back-translation drifts grossly
 * from the decoded source. Deliberately returns no ranking score.
 */
export function backTranslationTripwire(system: MetricSystemInput, floor: number): TripwireOutcome {
  const tripwires: BackTranslationTripwire[] = [];
  const findings: TripwireOutcome["findings"] = [];
  let evaluated = 0;
  let tripped = 0;

  for (const unit of system.units) {
    if (unit.backTranslation === undefined) {
      continue;
    }
    evaluated += 1;
    const similarity = characterBigramDice(unit.sourceText, unit.backTranslation);
    const isTripped = similarity < floor;
    tripwires.push({
      systemId: system.systemId,
      unitId: unit.unitId,
      label: unit.label,
      similarity,
      threshold: floor,
      tripped: isTripped,
    });
    if (!isTripped) {
      continue;
    }
    tripped += 1;
    findings.push(
      buildMetricFinding({
        systemId: system.systemId,
        checkName: BACK_TRANSLATION_CHECK_NAME,
        checkVersion: CHECK_VERSION,
        unitId: unit.unitId,
        label: unit.label,
        discriminator: "back-translation",
        violation: {
          category: "accuracy",
          qualitySubcategory: "mistranslation",
          qualitySeverity: "major",
          rootCause: "model_draft_error",
          expectedValue: `back-translation↔source similarity >= ${floor}`,
          observedValue: `back-translation↔source similarity ${similarity.toFixed(4)}`,
          rationale: `Back-translation tripwire: target back-translates to source-language text only ${similarity.toFixed(4)} similar to the decoded source (< ${floor}); possible gross meaning loss. Tripwire signal only — not a quality score.`,
        },
      }),
    );
  }

  return {
    checkName: BACK_TRANSLATION_CHECK_NAME,
    checkVersion: CHECK_VERSION,
    ruleCount: evaluated,
    passedRuleCount: evaluated - tripped,
    failedRuleCount: tripped,
    tripwires,
    findings,
  };
}
