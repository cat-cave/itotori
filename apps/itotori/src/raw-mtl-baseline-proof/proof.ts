// ITOTORI-117 — raw-MTL degenerate baseline proof builder.
//
// COMPOSES the ITOTORI-116 provider-proof harness output (a
// `ProviderProofBundle`, recorded OR live) into a sanitized
// `RawMtlBaselineProofArtifact` tagged `systemKind: "raw_mtl_baseline"`. It
// reuses, never reimplements:
//   - the harness ledger (the bundle's `ledger` is copied VERBATIM into the
//     benchmark section — same token/cost/latency/route/retry/fallback/
//     prompt-hash provenance as a structured draft),
//   - the harness's OWN seeded-QA-oracle score for the baseline cell
//     (`bundle.qaOracle`, already computed by `scoreQaAgainstOracle`), so the
//     baseline is scored by the SAME oracle path in recorded AND live mode
//     without ever exposing the baseline's raw QA findings,
//   - the same `scoreQaAgainstOracle` scorer for the comparison cells.
//
// The quality section compares the seeded oracle against the raw-MTL baseline,
// the Itotori draft, the deterministic-QA detector, and the LLM-QA detector —
// so alpha readiness has a real, like-for-like comparison point. No raw
// prompts/responses/keys/private text ever enter the artifact.

import {
  RAW_MTL_BASELINE_SYSTEM_KIND,
  RAW_MTL_BASELINE_PROOF_SCHEMA_VERSION,
  assertRawMtlBaselineProofArtifact,
  type BenchmarkSystemKindV02,
  type ProviderProofBundle,
  type ProviderProofSeededDefect,
  type QaFinding,
  type QualityDetectorKindV02,
  type RawMtlBaselineProofArtifact,
  type RawMtlBaselineQualityComparisonEntry,
} from "@itotori/localization-bridge-schema";
import { scoreQaAgainstOracle } from "../provider-proof/index.js";

/**
 * One (system, detector) output to score against the seeded oracle. `findings`
 * is the validated QA-finding set the detector emitted over that system's
 * output (the SAME `QaFinding[]` the structured-draft QA role produces).
 */
export type RawMtlBaselineComparisonInput = {
  systemKind: BenchmarkSystemKindV02;
  detectorKind: QualityDetectorKindV02;
  findings: QaFinding[];
};

export type RawMtlBaselineProofInput = {
  /** The raw-MTL baseline run, already through the ITOTORI-116 harness. */
  baselineBundle: ProviderProofBundle;
  /** The seeded-defect oracle shared by every compared output. */
  seededDefects: ProviderProofSeededDefect[];
  /**
   * The comparison cells OTHER than the baseline's own LLM-QA (which is taken
   * from `baselineBundle.qaOracle`): typically the Itotori draft's LLM-QA and
   * the deterministic-QA detector, so the oracle can compare them all.
   */
  comparisons: RawMtlBaselineComparisonInput[];
};

export class RawMtlBaselineProofError extends Error {
  constructor(detail: string) {
    super(`raw-mtl-baseline proof refused: ${detail}`);
    this.name = "RawMtlBaselineProofError";
  }
}

const BASELINE_LLM_QA_ID = `${RAW_MTL_BASELINE_SYSTEM_KIND}:llm_qa` as const;

/**
 * Build the sanitized `RawMtlBaselineProofArtifact` from a baseline bundle +
 * the comparison cells. The emitted artifact is held to its strict shared
 * contract via `assertRawMtlBaselineProofArtifact`.
 */
export function buildRawMtlBaselineProofArtifact(
  input: RawMtlBaselineProofInput,
): RawMtlBaselineProofArtifact {
  const bundle = input.baselineBundle;

  // The baseline cell reuses the harness's OWN oracle score. It must have been
  // computed over the same seeded oracle this artifact reports against.
  if (bundle.qaOracle.seededDefectCount !== input.seededDefects.length) {
    throw new RawMtlBaselineProofError(
      `baseline bundle oracle seededDefectCount ${bundle.qaOracle.seededDefectCount} does not match seededDefects ${input.seededDefects.length}`,
    );
  }

  // Provenance is the bundle ledger, verbatim — never re-derived or faked.
  const ledger = bundle.ledger.map((row) => ({ ...row }));
  const servedRoutes = ledger.map((row) => `${row.servedProvider}::${row.servedModel}`);
  const totalCostMicrosUsd = ledger.reduce((sum, row) => sum + row.costMicrosUsd, 0);

  const seen = new Set<string>([BASELINE_LLM_QA_ID]);
  const comparisons: RawMtlBaselineQualityComparisonEntry[] = [
    {
      comparisonId: BASELINE_LLM_QA_ID,
      systemKind: RAW_MTL_BASELINE_SYSTEM_KIND,
      detectorKind: "llm_qa",
      oracle: bundle.qaOracle,
    },
  ];

  for (const comparison of input.comparisons) {
    const comparisonId = `${comparison.systemKind}:${comparison.detectorKind}`;
    if (seen.has(comparisonId)) {
      throw new RawMtlBaselineProofError(`duplicate comparison '${comparisonId}'`);
    }
    seen.add(comparisonId);
    comparisons.push({
      comparisonId,
      systemKind: comparison.systemKind,
      detectorKind: comparison.detectorKind,
      oracle: scoreQaAgainstOracle(input.seededDefects, comparison.findings),
    });
  }

  const artifact: RawMtlBaselineProofArtifact = {
    schemaVersion: RAW_MTL_BASELINE_PROOF_SCHEMA_VERSION,
    proofId: `raw-mtl-baseline-proof:${bundle.mode}:${bundle.fixtureId}`,
    systemKind: RAW_MTL_BASELINE_SYSTEM_KIND,
    mode: bundle.mode,
    baselineBundle: bundle,
    benchmark: {
      systemKind: RAW_MTL_BASELINE_SYSTEM_KIND,
      fixtureId: bundle.fixtureId,
      mode: bundle.mode,
      ledger,
      servedRoutes,
      totalCostMicrosUsd,
    },
    quality: {
      systemKind: RAW_MTL_BASELINE_SYSTEM_KIND,
      seededDefectCount: input.seededDefects.length,
      comparisons,
    },
  };
  assertRawMtlBaselineProofArtifact(artifact);
  return artifact;
}
