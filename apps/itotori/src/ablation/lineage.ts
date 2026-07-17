// Lineage isolation — the pure-MTL ablation's telemetry is quarantined.
//
// A benchmark control arm is only honest if its cost / latency / attempt / quality
// numbers never leak into the qualifying (production / pilot) lineage they are the
// control FOR. This module tags a run's physical-attempt lineage with its class
// (derived from the policy, not a flag) and provides the ONE fold into the
// qualifying metrics ledger — which refuses an ablation-tagged contribution. There
// is no alternate path: mixing is a thrown error, not a silent sum.

import type { ResolvedRunPolicy } from "../run-policy/index.js";
import { lineageClassOf } from "./policy.js";
import {
  AblationLineageIsolationError,
  type AblationRunReport,
  type LineageClass,
  type TaggedLineage,
} from "./types.js";

/** Tag a resolved run's lineage with its class. The class is DERIVED from the
 * policy's bible basis via `lineageClassOf`; a caller cannot override it. This is
 * the single point at which a run's attempts become attributable to `qualifying`
 * or `ablation`. */
export function tagLineage(policy: ResolvedRunPolicy, report: AblationRunReport): TaggedLineage {
  return {
    lineageClass: lineageClassOf(policy),
    runMode: policy.runMode,
    bibleBasis: policy.bibleBasis,
    attempts: report.attemptLineage,
    finalizedUnitCount: report.finalized.length,
  };
}

/** The rolled-up metrics for the QUALIFYING lineage only — the production / pilot
 * runs a benchmark measures against. It aggregates attempt counts and run counts;
 * an ablation contribution is structurally excluded (see `foldQualifyingLineage`).
 * `contributingClasses` is the audit trail — it can only ever contain
 * `qualifying`. */
export interface QualifyingMetrics {
  readonly runCount: number;
  readonly attemptCount: number;
  readonly finalizedUnitCount: number;
  readonly contributingClasses: readonly LineageClass[];
}

/** The empty qualifying ledger — the identity a fold starts from. */
export const EMPTY_QUALIFYING_METRICS: QualifyingMetrics = Object.freeze({
  runCount: 0,
  attemptCount: 0,
  finalizedUnitCount: 0,
  contributingClasses: Object.freeze([]),
});

/**
 * Fold ONE run's tagged lineage into the qualifying metrics ledger. An ablation
 * contribution is REFUSED — its attempts / cost / latency / quality can never be
 * summed into a qualifying run's metrics. Only a `qualifying` contribution is
 * accepted; the returned ledger's `contributingClasses` therefore never contains
 * `ablation`. Removing this guard would let ablation telemetry pollute the
 * qualifying totals — which the isolation test asserts must throw.
 */
export function foldQualifyingLineage(
  base: QualifyingMetrics,
  contribution: TaggedLineage,
): QualifyingMetrics {
  if (contribution.lineageClass !== "qualifying") {
    throw new AblationLineageIsolationError(contribution.lineageClass);
  }
  return {
    runCount: base.runCount + 1,
    attemptCount: base.attemptCount + contribution.attempts.length,
    finalizedUnitCount: base.finalizedUnitCount + contribution.finalizedUnitCount,
    contributingClasses: [...base.contributingClasses, contribution.lineageClass],
  };
}

/** A dedicated sink for the ABLATION lineage — the isolated counterpart to the
 * qualifying ledger. It accepts only ablation contributions, so the two ledgers
 * are mutually exclusive by construction and an ablation run's telemetry lives
 * exclusively here. */
export function collectAblationLineage(
  base: QualifyingMetrics,
  contribution: TaggedLineage,
): QualifyingMetrics {
  if (contribution.lineageClass !== "ablation") {
    throw new AblationLineageIsolationError(contribution.lineageClass);
  }
  return {
    runCount: base.runCount + 1,
    attemptCount: base.attemptCount + contribution.attempts.length,
    finalizedUnitCount: base.finalizedUnitCount + contribution.finalizedUnitCount,
    contributingClasses: [...base.contributingClasses, contribution.lineageClass],
  };
}
