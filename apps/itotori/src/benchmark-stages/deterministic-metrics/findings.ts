// benchmark-deterministic-metric-suite (§3) — shared finding builder.
//
// Every deterministic metric emits its violations as `itotori-lqa-1`
// findings with `detectorKind: "deterministic_qa"` so the metric layer
// composes with the blind-panel findings in one `BenchmarkReportV02`
// (methodology §3: "All deterministic outputs are emitted as itotori-lqa-1
// findings with a deterministic_qa / patch_verify / runtime_probe detector
// kind"). This mirrors the existing ITOTORI-090 deterministic-qa stage
// finding shape verbatim so the vocabulary is shared, not forked.

import type {
  BenchmarkFindingRecordV02,
  LocalizationQualityCategoryV02,
  LocalizationQualitySeverityV02,
  LocalizationRootCauseV02,
} from "@itotori/localization-bridge-schema";
import { deterministicUuid7 } from "../ids.js";

/** The `itotori-lqa-1` taxonomy id/version every metric finding declares. */
export const TAXONOMY_ID = "itotori-lqa-1" as const;
export const TAXONOMY_VERSION = "itotori-quality-taxonomy-0.1.0" as const;

/** A single metric violation, expressed in the shared taxonomy vocabulary. */
export type MetricViolation = {
  category: LocalizationQualityCategoryV02;
  qualitySubcategory: string;
  qualitySeverity: LocalizationQualitySeverityV02;
  rootCause: LocalizationRootCauseV02;
  expectedValue: string;
  observedValue: string;
  rationale: string;
};

/**
 * Build one `deterministic_qa` finding for a failed metric check on a unit.
 * All ids are content-addressed (system + check + unit + a discriminator) so a
 * re-run over the same input yields byte-identical findings.
 */
export function buildMetricFinding(args: {
  systemId: string;
  checkName: string;
  checkVersion: string;
  unitId: string;
  label: string;
  /** A stable discriminator so a check can emit >1 finding per unit. */
  discriminator: string;
  violation: MetricViolation;
}): BenchmarkFindingRecordV02 {
  const { systemId, checkName, checkVersion, unitId, label, discriminator, violation } = args;
  const seed = [systemId, checkName, unitId, discriminator];
  const findingId = deterministicUuid7("metric-finding", ...seed);
  const provenanceId = deterministicUuid7("metric-provenance", ...seed);
  const evidenceId = deterministicUuid7("metric-evidence", ...seed);
  const checkId = deterministicUuid7("metric-check", checkName);
  return {
    findingId,
    systemId,
    taxonomyId: TAXONOMY_ID,
    taxonomyVersion: TAXONOMY_VERSION,
    detectorKind: "deterministic_qa",
    category: violation.category,
    qualitySubcategory: violation.qualitySubcategory,
    qualitySeverity: violation.qualitySeverity,
    rootCause: violation.rootCause,
    adjudicationState: "confirmed",
    affectedRefs: [{ subjectKind: "bridge_unit", subjectId: unitId, label }],
    evidence: [
      {
        evidenceId,
        evidenceKind: "validator_message",
        summary: `${checkName} failed on ${label}`,
        subjectRef: { subjectKind: "bridge_unit", subjectId: unitId, label },
        expectedValue: violation.expectedValue,
        observedValue: violation.observedValue,
        provenanceIds: [provenanceId],
      },
    ],
    provenance: [
      {
        provenanceId,
        provenanceKind: "deterministic_check",
        checkId,
        checkName,
        checkVersion,
      },
    ],
    reviewerRationale: violation.rationale,
  };
}
