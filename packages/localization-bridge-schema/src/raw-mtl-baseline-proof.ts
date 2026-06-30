// ITOTORI-117 — sanitized raw-MTL degenerate baseline proof artifact.
//
// The public, redistributable artifact the raw-MTL baseline proof emits in
// BOTH recorded mode (no creds) and opt-in live mode. It proves that a
// deliberately-naive raw machine-translation baseline runs through the SAME
// provider-proof path (ITOTORI-116) — the SAME token/cost/latency ledger and
// the SAME seeded-QA-oracle quality-report schema — as a structured Itotori
// draft, so alpha readiness has a real comparison point.
//
// It carries:
//   - `systemKind: "raw_mtl_baseline"` on BOTH the benchmark section and the
//     quality section (the acceptance label).
//   - the embedded `ProviderProofBundle` for the baseline run — validated by
//     the SAME `assertProviderProofBundle` the structured-draft path uses, so
//     there is exactly one ledger + quality-report contract.
//   - a benchmark section whose ledger + served-route + total-cost provenance
//     is COPIED VERBATIM from the embedded bundle's ledger (never re-derived
//     or fabricated — a divergence fails the assertion loudly).
//   - a quality section comparing the seeded oracle against the raw-MTL
//     baseline, the Itotori draft, the deterministic-QA detector, and the
//     LLM-QA detector — each scored with the SAME `ProviderProofQaOracleReport`
//     shape.
//
// Like the provider-proof bundle it embeds, it carries NO raw prompts, NO raw
// responses, NO API keys, and NO private corpus text — only ids, hashes,
// counts, statuses, (model, provider) pairs, ZDR posture, the real token/cost/
// latency ledger, and the seeded-oracle scoring reports.

import type { BenchmarkSystemKindV02, QualityDetectorKindV02 } from "./index.js";
import {
  assertProviderProofBundle,
  type ProviderProofBundle,
  type ProviderProofLedgerRow,
  type ProviderProofMode,
  type ProviderProofQaOracleReport,
} from "./provider-proof-bundle.js";

export const RAW_MTL_BASELINE_PROOF_SCHEMA_VERSION = "itotori.raw-mtl-baseline-proof.v0" as const;

/** The system-under-proof. The baseline is, by construction, raw_mtl_baseline. */
export const RAW_MTL_BASELINE_SYSTEM_KIND = "raw_mtl_baseline" as const;

// The benchmark/quality enum *values* this artifact validates against. These
// MIRROR `BENCHMARK_SYSTEM_KINDS` / `QUALITY_DETECTOR_KINDS` in ./index.ts;
// they are re-declared locally (typed against the canonical unions so the
// compiler rejects drift) to keep this module free of a runtime import cycle
// with index.ts (which `export *`s this file).
const COMPARISON_SYSTEM_KINDS: readonly BenchmarkSystemKindV02[] = [
  "raw_mtl_baseline",
  "itotori_draft",
  "itotori_repaired",
  "human_reference",
  "deterministic_fixture",
];
const COMPARISON_DETECTOR_KINDS: readonly QualityDetectorKindV02[] = [
  "deterministic_qa",
  "llm_qa",
  "human_review",
  "runtime_probe",
  "seeded_defect_oracle",
  "patch_verify",
  "schema_guard",
];

/**
 * One quality comparison: the seeded oracle scored against ONE (system,
 * detector) output. `comparisonId` is `${systemKind}:${detectorKind}` so a
 * report can address each cell unambiguously.
 */
export type RawMtlBaselineQualityComparisonEntry = {
  comparisonId: string;
  systemKind: BenchmarkSystemKindV02;
  detectorKind: QualityDetectorKindV02;
  oracle: ProviderProofQaOracleReport;
};

/**
 * The benchmark artifact section: systemKind + the baseline run's ledger,
 * served-route, and total-cost provenance. The ledger is the bundle's ledger
 * verbatim (the assertion enforces this — no fabricated cost/route).
 */
export type RawMtlBaselineBenchmarkSection = {
  systemKind: typeof RAW_MTL_BASELINE_SYSTEM_KIND;
  fixtureId: string;
  mode: ProviderProofMode;
  ledger: ProviderProofLedgerRow[];
  servedRoutes: string[];
  totalCostMicrosUsd: number;
};

/** The quality artifact section: systemKind + the cross-output oracle table. */
export type RawMtlBaselineQualitySection = {
  systemKind: typeof RAW_MTL_BASELINE_SYSTEM_KIND;
  seededDefectCount: number;
  comparisons: RawMtlBaselineQualityComparisonEntry[];
};

export type RawMtlBaselineProofArtifact = {
  schemaVersion: typeof RAW_MTL_BASELINE_PROOF_SCHEMA_VERSION;
  proofId: string;
  systemKind: typeof RAW_MTL_BASELINE_SYSTEM_KIND;
  mode: ProviderProofMode;
  baselineBundle: ProviderProofBundle;
  benchmark: RawMtlBaselineBenchmarkSection;
  quality: RawMtlBaselineQualitySection;
};

/**
 * Strict JSON Schema (draft-07) for `RawMtlBaselineProofArtifact`. The
 * embedded bundle keeps its own contract (validated by
 * `assertProviderProofBundle`); `additionalProperties:false` everywhere keeps
 * a raw prompt/response/key from ever riding along.
 */
export const RAW_MTL_BASELINE_PROOF_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "itotori://localization-bridge-schema/raw-mtl-baseline-proof.v0",
  title: "RawMtlBaselineProofArtifact",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "proofId",
    "systemKind",
    "mode",
    "baselineBundle",
    "benchmark",
    "quality",
  ],
  properties: {
    schemaVersion: { const: RAW_MTL_BASELINE_PROOF_SCHEMA_VERSION },
    proofId: { type: "string", minLength: 1 },
    systemKind: { const: RAW_MTL_BASELINE_SYSTEM_KIND },
    mode: { enum: ["recorded", "live"] },
    baselineBundle: { type: "object" },
    benchmark: { type: "object" },
    quality: { type: "object" },
  },
} as const;

// ---------------------------------------------------------------------------
// Validation surface
// ---------------------------------------------------------------------------

export class RawMtlBaselineProofValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly rule: string,
    public readonly detail: string,
  ) {
    super(`RawMtlBaselineProofArtifact.${path} failed rule '${rule}': ${detail}`);
    this.name = "RawMtlBaselineProofValidationError";
  }
}

function fail(path: string, rule: string, detail: string): never {
  throw new RawMtlBaselineProofValidationError(path, rule, detail);
}

function assertObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "type", "expected object");
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(path, "type", "expected non-empty string");
  }
  return value;
}

function assertNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(path, "type", "expected non-negative integer");
  }
  return value;
}

function assertFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "type", "expected finite number");
  }
  return value;
}

function assertEnum(value: unknown, allowed: readonly string[], path: string): string {
  const text = assertString(value, path);
  if (!allowed.includes(text)) {
    fail(path, "enum", `value '${text}' not in [${allowed.join(", ")}]`);
  }
  return text;
}

function assertStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    fail(path, "type", "expected array");
  }
  return value.map((entry, index) => assertString(entry, `${path}[${index}]`));
}

// The oracle shape MUST match `ProviderProofQaOracleReport` exactly — the
// SAME quality-report contract the structured-draft QA scoring uses.
function assertOracle(value: unknown, path: string): void {
  const record = assertObject(value, path);
  assertNonNegativeInteger(record.seededDefectCount, `${path}.seededDefectCount`);
  assertNonNegativeInteger(record.emittedFindingCount, `${path}.emittedFindingCount`);
  assertNonNegativeInteger(record.truePositives, `${path}.truePositives`);
  assertNonNegativeInteger(record.falsePositives, `${path}.falsePositives`);
  assertNonNegativeInteger(record.falseNegatives, `${path}.falseNegatives`);
  assertFiniteNumber(record.precision, `${path}.precision`);
  assertFiniteNumber(record.recall, `${path}.recall`);
  assertFiniteNumber(record.f1, `${path}.f1`);
  assertFiniteNumber(record.severityCalibration, `${path}.severityCalibration`);
  assertStringArray(record.matchedSeededDefectIds, `${path}.matchedSeededDefectIds`);
  assertStringArray(record.falseNegativeSeededDefectIds, `${path}.falseNegativeSeededDefectIds`);
  assertStringArray(record.falsePositiveBridgeUnitIds, `${path}.falsePositiveBridgeUnitIds`);
}

function assertComparisonEntry(value: unknown, path: string): { comparisonId: string } {
  const record = assertObject(value, path);
  const comparisonId = assertString(record.comparisonId, `${path}.comparisonId`);
  const systemKind = assertEnum(record.systemKind, COMPARISON_SYSTEM_KINDS, `${path}.systemKind`);
  const detectorKind = assertEnum(
    record.detectorKind,
    COMPARISON_DETECTOR_KINDS,
    `${path}.detectorKind`,
  );
  if (comparisonId !== `${systemKind}:${detectorKind}`) {
    fail(
      `${path}.comparisonId`,
      "const",
      `comparisonId must be '${systemKind}:${detectorKind}', got '${comparisonId}'`,
    );
  }
  assertOracle(record.oracle, `${path}.oracle`);
  return { comparisonId };
}

function assertLedgerRowShape(value: unknown, path: string): ProviderProofLedgerRow {
  const record = assertObject(value, path);
  return record as unknown as ProviderProofLedgerRow;
}

/**
 * Validate a parsed value against the `RawMtlBaselineProofArtifact` schema.
 * Throws `RawMtlBaselineProofValidationError` on the first divergence. The
 * embedded bundle is delegated to `assertProviderProofBundle` (one ledger +
 * quality contract); the benchmark ledger + cost provenance is cross-checked
 * against that bundle so no fabricated route/cost can ride along.
 */
export function assertRawMtlBaselineProofArtifact(
  value: unknown,
): asserts value is RawMtlBaselineProofArtifact {
  const record = assertObject(value, "");
  if (record.schemaVersion !== RAW_MTL_BASELINE_PROOF_SCHEMA_VERSION) {
    fail(
      "schemaVersion",
      "const",
      `expected ${RAW_MTL_BASELINE_PROOF_SCHEMA_VERSION}, got ${String(record.schemaVersion)}`,
    );
  }
  assertString(record.proofId, "proofId");
  if (record.systemKind !== RAW_MTL_BASELINE_SYSTEM_KIND) {
    fail("systemKind", "const", `expected ${RAW_MTL_BASELINE_SYSTEM_KIND}`);
  }
  const mode = assertEnum(record.mode, ["recorded", "live"], "mode");

  // Embedded bundle: the SAME contract as a structured-draft proof.
  assertProviderProofBundle(record.baselineBundle);
  const bundle = record.baselineBundle as ProviderProofBundle;
  if (bundle.mode !== mode) {
    fail(
      "baselineBundle.mode",
      "const",
      `bundle mode '${bundle.mode}' must equal artifact mode '${mode}'`,
    );
  }

  // Benchmark section: systemKind + ledger/route/cost provenance, copied from
  // the bundle's ledger VERBATIM (a divergence is a fabricated benchmark).
  const benchmark = assertObject(record.benchmark, "benchmark");
  if (benchmark.systemKind !== RAW_MTL_BASELINE_SYSTEM_KIND) {
    fail("benchmark.systemKind", "const", `expected ${RAW_MTL_BASELINE_SYSTEM_KIND}`);
  }
  assertString(benchmark.fixtureId, "benchmark.fixtureId");
  assertEnum(benchmark.mode, ["recorded", "live"], "benchmark.mode");
  if (!Array.isArray(benchmark.ledger)) {
    fail("benchmark.ledger", "type", "expected array");
  }
  const benchmarkLedger = benchmark.ledger.map((row, index) =>
    assertLedgerRowShape(row, `benchmark.ledger[${index}]`),
  );
  if (JSON.stringify(benchmarkLedger) !== JSON.stringify(bundle.ledger)) {
    fail(
      "benchmark.ledger",
      "const",
      "benchmark ledger must equal the embedded bundle ledger verbatim (no re-derived cost/route)",
    );
  }
  const expectedTotalCostMicros = bundle.ledger.reduce((sum, row) => sum + row.costMicrosUsd, 0);
  const totalCostMicrosUsd = assertNonNegativeInteger(
    benchmark.totalCostMicrosUsd,
    "benchmark.totalCostMicrosUsd",
  );
  if (totalCostMicrosUsd !== expectedTotalCostMicros) {
    fail(
      "benchmark.totalCostMicrosUsd",
      "const",
      `total cost ${totalCostMicrosUsd} must equal the summed ledger cost ${expectedTotalCostMicros}`,
    );
  }
  const expectedRoutes = bundle.ledger.map((row) => `${row.servedProvider}::${row.servedModel}`);
  const servedRoutes = assertStringArray(benchmark.servedRoutes, "benchmark.servedRoutes");
  if (JSON.stringify(servedRoutes) !== JSON.stringify(expectedRoutes)) {
    fail(
      "benchmark.servedRoutes",
      "const",
      "served routes must be derived from the bundle ledger's servedProvider::servedModel",
    );
  }

  // Quality section: systemKind + the cross-output oracle comparison table.
  const quality = assertObject(record.quality, "quality");
  if (quality.systemKind !== RAW_MTL_BASELINE_SYSTEM_KIND) {
    fail("quality.systemKind", "const", `expected ${RAW_MTL_BASELINE_SYSTEM_KIND}`);
  }
  assertNonNegativeInteger(quality.seededDefectCount, "quality.seededDefectCount");
  if (!Array.isArray(quality.comparisons) || quality.comparisons.length === 0) {
    fail("quality.comparisons", "minItems", "expected at least one comparison");
  }
  const ids = new Set<string>();
  let hasBaseline = false;
  quality.comparisons.forEach((entry, index) => {
    const { comparisonId } = assertComparisonEntry(entry, `quality.comparisons[${index}]`);
    if (ids.has(comparisonId)) {
      fail(`quality.comparisons[${index}].comparisonId`, "unique", `duplicate '${comparisonId}'`);
    }
    ids.add(comparisonId);
    if (comparisonId === `${RAW_MTL_BASELINE_SYSTEM_KIND}:llm_qa`) {
      hasBaseline = true;
    }
  });
  // The whole point: the raw-MTL baseline must itself appear, scored by the
  // SAME oracle as the systems it is compared against.
  if (!hasBaseline) {
    fail(
      "quality.comparisons",
      "required",
      `must include the '${RAW_MTL_BASELINE_SYSTEM_KIND}:llm_qa' comparison`,
    );
  }
}

export function parseRawMtlBaselineProofArtifact(raw: string): RawMtlBaselineProofArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(
      "",
      "json",
      `raw-mtl-baseline proof is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertRawMtlBaselineProofArtifact(parsed);
  return parsed;
}
