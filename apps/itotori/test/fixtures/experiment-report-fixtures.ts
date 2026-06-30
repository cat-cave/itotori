// ITOTORI-039 — PUBLIC fixtures for the experiment benchmark report
// composition command. The "provider route report fixture" deliverable.
//
// Everything here is built from `synthetic_public` ITOTORI-099 artifacts
// (reused from the ITOTORI-100 route-reliability fixtures): NO raw prompt
// text, NO response text, NO API key — only ids, hashes, counts, statuses,
// provider slugs, and verbatim captured cost/token numbers. Safe for the
// public test tree (no live creds / private corpora). The cost literals it
// transitively carries live under `test/`, where the no-hardcoded-cost audit
// exempts them — they stand in for REAL captured spend the composition only
// RESTATES, never fabricates.

import { fileURLToPath } from "node:url";
import {
  EXPERIMENT_MATRIX_RUN_MANIFEST_SCHEMA_VERSION,
  type ExperimentCostSummary,
  type ExperimentInvocationArtifact,
  type ExperimentMatrixRunManifest,
} from "../../src/experiment-matrix/runner.js";
import {
  renderProviderRouteReport,
  type ProviderRouteReport,
} from "../../src/route-reliability/index.js";
import { fallbackRetryArtifacts, fallbackRetryLedger } from "./route-reliability-fixtures.js";

export const FIXTURE_EXPERIMENT_ID = "itotori-100-fixture";
export const FIXTURE_GENERATED_AT = "2026-06-30T00:00:00.000Z";

/** The on-disk locations of the committed public composition fixtures. */
export const FIXTURE_MANIFEST_PATH = fileURLToPath(
  new URL(
    "../../../../fixtures/itotori-experiment-report/experiment-matrix-run-manifest.json",
    import.meta.url,
  ),
);
export const FIXTURE_ROUTE_REPORT_PATH = fileURLToPath(
  new URL(
    "../../../../fixtures/itotori-experiment-report/provider-route-report.json",
    import.meta.url,
  ),
);

/** Sum the captured costs the same way the ITOTORI-099 runner does (no literal). */
export function summarizeFixtureCost(
  artifacts: readonly ExperimentInvocationArtifact[],
): ExperimentCostSummary {
  let totalMicrosUsd = 0;
  let billedInvocationCount = 0;
  let zeroCostInvocationCount = 0;
  for (const artifact of artifacts) {
    totalMicrosUsd += artifact.providerRun.cost.amountMicrosUsd;
    if (artifact.providerRun.cost.costKind === "billed") billedInvocationCount += 1;
    else zeroCostInvocationCount += 1;
  }
  const whole = Math.floor(totalMicrosUsd / 1_000_000);
  const fraction = (totalMicrosUsd % 1_000_000).toString().padStart(6, "0").replace(/0+$/u, "");
  return {
    currency: "USD",
    totalMicrosUsd,
    totalUsd: fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`,
    billedInvocationCount,
    zeroCostInvocationCount,
  };
}

/**
 * A complete ITOTORI-099 experiment-matrix run manifest wrapping the
 * synthetic-public fallback/retry artifacts — the ITOTORI-099 side of the
 * composition. `costSummary` is summed from the artifacts (never a literal).
 */
export function publicExperimentManifest(
  artifacts: readonly ExperimentInvocationArtifact[] = fallbackRetryArtifacts(),
): ExperimentMatrixRunManifest {
  return {
    schemaVersion: EXPERIMENT_MATRIX_RUN_MANIFEST_SCHEMA_VERSION,
    experimentId: FIXTURE_EXPERIMENT_ID,
    configHash: `sha256:${"a1b2c3d4".repeat(8)}`,
    mode: "recorded",
    generatedAt: FIXTURE_GENERATED_AT,
    status: "succeeded",
    plannedInvocationCount: artifacts.length,
    artifacts: [...artifacts],
    findings: [],
    costSummary: summarizeFixtureCost(artifacts),
  };
}

/**
 * The ITOTORI-100 provider route report rendered over the SAME artifacts +
 * the reconciling provider ledger — the ITOTORI-100 side of the composition.
 */
export function publicProviderRouteReport(
  artifacts: readonly ExperimentInvocationArtifact[] = fallbackRetryArtifacts(),
): ProviderRouteReport {
  return renderProviderRouteReport({
    experimentId: FIXTURE_EXPERIMENT_ID,
    generatedAt: FIXTURE_GENERATED_AT,
    artifacts: [...artifacts],
    ledgerEntries: fallbackRetryLedger(),
  });
}

/**
 * An in-memory {@link ComposedArtifactReader}-compatible map keyed by the two
 * fixture refs' paths, so a test can prove the composition reads named
 * artifacts WITHOUT touching the filesystem or any provider credentials.
 */
export function fixtureArtifactReader(
  overrides: { manifest?: unknown; routeReport?: unknown } = {},
): Record<string, unknown> {
  return {
    [FIXTURE_MANIFEST_PATH]: overrides.manifest ?? publicExperimentManifest(),
    [FIXTURE_ROUTE_REPORT_PATH]: overrides.routeReport ?? publicProviderRouteReport(),
  };
}
