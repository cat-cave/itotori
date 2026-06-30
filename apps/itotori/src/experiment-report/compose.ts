// ITOTORI-039 — Provider experiment reporting integration.
//
// ONE composition command that COMPOSES (does not reimplement) two
// just-merged prerequisite outputs into a single benchmark report
// attachment that NAMES the exact composed artifacts:
//
//   ITOTORI-099 experiment-matrix run manifest
//     (`ExperimentMatrixRunManifest` — the recorded provenance artifacts +
//      the experiment-level cost summary sourced verbatim from replayed
//      captured costs)
//   ITOTORI-100 provider route report
//     (`ProviderRouteReport` — reliability / fallback / retry /
//      structured-output support keyed by the REAL SERVED route, plus the
//      cost reconciliation of those artifacts against the provider ledger)
//
// This module owns NO experiment running, NO route rendering, and NO cost
// computation of its own. Its sole jobs are:
//
//   1. READ the two named artifacts through an injected reader. A read that
//      throws (a missing file) or returns a structurally-invalid payload is
//      a STRUCTURED finding that NAMES the artifact (name + path) — never a
//      silent skip (PROJECT LAW).
//
//   2. DETECT a STALE provider report. The ITOTORI-100 reliability +
//      structured-output sections are a pure function of the ITOTORI-099
//      artifacts; we RE-DERIVE them from the manifest's artifacts using the
//      ITOTORI-100 renderers and require byte-equality. A provider report
//      rendered from a DIFFERENT (older) artifact set diverges and FAILS
//      with a finding naming the provider-route report. An experimentId
//      mismatch and a cost cross-check mismatch are likewise named findings.
//
//   3. COMPOSE the benchmark report attachment: the provider-route,
//      fallback, retry, structured-output-support, and cost-summary
//      sections, plus the RECORDED served (model, provider) pairs taken from
//      the artifacts. Every cost number is restated VERBATIM from the
//      composed artifacts (the experiment cost summary + the route cost
//      reconciliation); the only arithmetic is integer micros→USD (`/1e6`)
//      borrowed from ITOTORI-100. No cost is fabricated, hardcoded, or
//      approximated — `node scripts/audit-no-hardcoded-cost.mjs` stays
//      exit 0.
//
// The attachment carries ONLY ids / hashes / counts / statuses / modes /
// provider names / verbatim cost+token numbers — never raw prompt or
// response text or credentials (the ITOTORI-099 artifacts carry none by
// construction; see ExperimentArtifactRedaction). Safe for public fixtures.

import type {
  ExperimentInvocationArtifact,
  ExperimentMatrixRunManifest,
} from "../experiment-matrix/runner.js";
import { EXPERIMENT_MATRIX_RUN_MANIFEST_SCHEMA_VERSION } from "../experiment-matrix/runner.js";
import {
  microsToUsdDecimalString,
  PROVIDER_ROUTE_REPORT_SCHEMA_VERSION,
  renderRouteReliability,
  renderStructuredOutputSupport,
  type ProviderRouteReliabilityReport,
  type ProviderRouteReport,
  type ProviderRouteServedKey,
  type RouteCostReconciliationRow,
  type StructuredOutputSupportReport,
  type StructuredOutputSupportReportRow,
} from "../route-reliability/index.js";
import { canonicalServedProviderId } from "../telemetry/provider-run-artifact-source.js";

export const EXPERIMENT_BENCHMARK_ATTACHMENT_SCHEMA_VERSION =
  "itotori.experiment_benchmark_attachment.v0.1" as const;

/** Checked-in PUBLIC composition inputs (synthetic, no live credentials). */
export const DEFAULT_PUBLIC_EXPERIMENT_MANIFEST_FIXTURE_PATH =
  "fixtures/itotori-experiment-report/experiment-matrix-run-manifest.json";
export const DEFAULT_PUBLIC_PROVIDER_ROUTE_REPORT_FIXTURE_PATH =
  "fixtures/itotori-experiment-report/provider-route-report.json";

// ─────────────────────────────────────────────────────────────────────────
// Artifact references + reader.
// ─────────────────────────────────────────────────────────────────────────

/**
 * A named reference to one composed input artifact. `artifactName` is the
 * human role ("experiment-matrix run manifest"); `artifactPath` is the
 * on-disk path (or fixture id) the reader resolves. BOTH are quoted in any
 * missing/invalid/stale finding so the diagnostic NAMES the artifact.
 */
export type ComposedArtifactRef = {
  readonly artifactName: string;
  readonly artifactPath: string;
};

/**
 * Loads + parses one named artifact. THROWS to signal "missing": a thrown
 * read (e.g. ENOENT) is caught by the command and turned into a
 * `missing_artifact` finding that names the artifact. The real CLI passes a
 * `JSON.parse(readFileSync(...))` reader; a fixture passes an in-memory map.
 */
export type ComposedArtifactReader = (ref: ComposedArtifactRef) => unknown;

export type ExperimentReportComposeInput = {
  readonly experimentManifestRef: ComposedArtifactRef;
  readonly providerRouteReportRef: ComposedArtifactRef;
  readonly readArtifact: ComposedArtifactReader;
  /** Caller-supplied for determinism — the command never reads the clock. */
  readonly generatedAt: string;
  readonly log?: (message: string) => void;
};

// ─────────────────────────────────────────────────────────────────────────
// Findings.
// ─────────────────────────────────────────────────────────────────────────

export type ExperimentReportFindingKind =
  | "missing_artifact"
  | "invalid_artifact"
  | "experiment_run_failed"
  | "experiment_id_mismatch"
  | "stale_provider_report"
  | "provider_proof_unreconciled"
  | "cost_cross_check_mismatch";

/**
 * A structured composition failure. EVERY finding NAMES the offending
 * artifact (`artifactName` + `artifactPath`); a field-level finding also
 * names the `field`. This is the "fail with diagnostics naming the missing
 * artifact" contract — never a silent skip.
 */
export type ExperimentReportFinding = {
  readonly kind: ExperimentReportFindingKind;
  readonly artifactName: string;
  readonly artifactPath: string;
  readonly field: string | null;
  readonly message: string;
};

// ─────────────────────────────────────────────────────────────────────────
// Benchmark report attachment schema (the deliverable).
// ─────────────────────────────────────────────────────────────────────────

/** A RECORDED served (model, provider) pair, taken verbatim from an artifact. */
export type ServedModelProviderPair = {
  readonly servedModelId: string;
  readonly servedProviderId: string;
};

export type ProviderRouteSectionRow = {
  readonly servedProvider: string;
  readonly servedModel: string;
  readonly requestedPairs: readonly string[];
  readonly servedDivergesFromRequested: boolean;
  readonly invocationCount: number;
  readonly succeededCount: number;
  readonly failedCount: number;
  readonly partialCount: number;
  readonly skippedCount: number;
  readonly zdrEnforcedCount: number;
};

export type ProviderRouteSection = {
  readonly byServedRoute: Record<ProviderRouteServedKey, ProviderRouteSectionRow>;
  readonly invocationCount: number;
  readonly succeededCount: number;
  readonly failedCount: number;
  readonly partialCount: number;
  readonly skippedCount: number;
  readonly zdrEnforcedCount: number;
};

export type FallbackSectionRow = {
  readonly servedProvider: string;
  readonly servedModel: string;
  readonly fallbackInvocationCount: number;
  readonly fallbackPlans: readonly string[];
};

export type FallbackSection = {
  readonly byServedRoute: Record<ProviderRouteServedKey, FallbackSectionRow>;
  readonly fallbackInvocationCount: number;
};

export type RetrySectionRow = {
  readonly servedProvider: string;
  readonly servedModel: string;
  readonly retriedInvocationCount: number;
  readonly totalRetryCount: number;
};

export type RetrySection = {
  readonly byServedRoute: Record<ProviderRouteServedKey, RetrySectionRow>;
  readonly retriedInvocationCount: number;
  readonly totalRetryCount: number;
};

export type StructuredOutputSupportSection = {
  readonly rows: readonly StructuredOutputSupportReportRow[];
};

/**
 * Cost summary section. The `experiment*` fields are restated VERBATIM from
 * the ITOTORI-099 manifest cost summary (summed from real replayed captured
 * costs); the `reconciled*` / `artifact*` / `ledger*` fields are restated
 * VERBATIM from the ITOTORI-100 cost reconciliation (artifact cost
 * cross-checked against the provider ledger). No value is computed here
 * beyond the integer micros→USD derivation ITOTORI-100 already owns.
 */
export type CostSummarySection = {
  readonly currency: "USD";
  readonly experimentTotalMicrosUsd: number;
  readonly experimentTotalUsd: string;
  readonly billedInvocationCount: number;
  readonly zeroCostInvocationCount: number;
  readonly reconciledInvocationCount: number;
  readonly artifactMicrosUsd: number;
  readonly artifactUsd: string;
  readonly ledgerMicrosUsd: number;
  readonly ledgerUsd: string;
  readonly byServedRoute: Record<ProviderRouteServedKey, RouteCostReconciliationRow>;
};

export type BenchmarkReportAttachment = {
  readonly schemaVersion: typeof EXPERIMENT_BENCHMARK_ATTACHMENT_SCHEMA_VERSION;
  readonly attachmentKind: "provider_experiment_report";
  readonly experimentId: string;
  readonly generatedAt: string;
  readonly status: "succeeded" | "failed";
  readonly source: {
    readonly experimentManifest: {
      readonly artifactName: string;
      readonly artifactPath: string;
      readonly schemaVersion: string;
      readonly configHash: string;
      readonly mode: "recorded" | "live";
      readonly generatedAt: string;
      readonly runStatus: "succeeded" | "failed";
      readonly artifactCount: number;
    };
    readonly providerRouteReport: {
      readonly artifactName: string;
      readonly artifactPath: string;
      readonly schemaVersion: string;
      readonly generatedAt: string;
    };
  };
  /** RECORDED served (model, provider) pairs, deduped + sorted, from the artifacts. */
  readonly servedPairs: readonly ServedModelProviderPair[];
  readonly sections: {
    readonly providerRoute: ProviderRouteSection;
    readonly fallback: FallbackSection;
    readonly retry: RetrySection;
    readonly structuredOutputSupport: StructuredOutputSupportSection;
    readonly costSummary: CostSummarySection;
  };
  readonly findings: readonly ExperimentReportFinding[];
};

/**
 * The composition outcome. `attachment` is non-null whenever BOTH artifacts
 * were readable + structurally valid (even when a staleness / cross-check
 * finding flips `status` to `"failed"` — the diagnostics are embedded in the
 * attachment so they stay inspectable). It is `null` only when an artifact
 * could not be read or parsed, in which case there is no artifact set to
 * build sections from and the finding names the unreadable artifact.
 */
export type ExperimentReportComposition = {
  readonly status: "succeeded" | "failed";
  readonly attachment: BenchmarkReportAttachment | null;
  readonly findings: readonly ExperimentReportFinding[];
};

// ─────────────────────────────────────────────────────────────────────────
// The composition command.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Compose an ITOTORI-099 experiment-matrix run manifest and an ITOTORI-100
 * provider route report into a benchmark report attachment. Returns a
 * composition in EVERY case (including failure): a missing artifact, a
 * failed experiment run, a stale provider report, or a cost cross-check
 * mismatch is reported as a structured finding that NAMES the artifact, never
 * by silently dropping it. Use {@link assertExperimentReportComposed} to
 * escalate a failed composition to a throw (a CLI raises a non-zero exit).
 */
export function composeExperimentBenchmarkReport(
  input: ExperimentReportComposeInput,
): ExperimentReportComposition {
  const log = input.log ?? (() => {});
  const findings: ExperimentReportFinding[] = [];

  // ── READ + validate the ITOTORI-099 experiment-matrix run manifest. ──────
  const manifest = readManifest(input, findings, log);
  if (manifest === null) {
    return { status: "failed", attachment: null, findings };
  }

  // ── READ + validate the ITOTORI-100 provider route report. ───────────────
  const routeReport = readRouteReport(input, findings, log);
  if (routeReport === null) {
    return { status: "failed", attachment: null, findings };
  }

  // ── A failed ITOTORI-099 run has no clean artifact set to attach. ────────
  if (manifest.status !== "succeeded") {
    findings.push({
      kind: "experiment_run_failed",
      artifactName: input.experimentManifestRef.artifactName,
      artifactPath: input.experimentManifestRef.artifactPath,
      field: "status",
      message: `experiment-matrix run manifest '${input.experimentManifestRef.artifactPath}' has status='${manifest.status}' with ${manifest.findings.length} run finding(s); refusing to attach a failed experiment run`,
    });
  }

  // ── experimentId must agree across the two composed artifacts. ───────────
  if (routeReport.experimentId !== manifest.experimentId) {
    findings.push({
      kind: "experiment_id_mismatch",
      artifactName: input.providerRouteReportRef.artifactName,
      artifactPath: input.providerRouteReportRef.artifactPath,
      field: "experimentId",
      message: `provider route report '${input.providerRouteReportRef.artifactPath}' experimentId='${routeReport.experimentId}' does not match experiment-matrix manifest experimentId='${manifest.experimentId}'`,
    });
  }

  // ── STALENESS: re-derive the ITOTORI-100 artifact-only sections from THIS
  // manifest's artifacts and require byte-equality. A provider report
  // rendered from a different (older) artifact set diverges. ───────────────
  detectStaleProviderReport(input, manifest.artifacts, routeReport, findings);

  // ── Provider-proof integrity + cost cross-check. ─────────────────────────
  detectCostInconsistency(input, manifest, routeReport, findings);

  const attachment = buildAttachment(input, manifest, routeReport, findings);
  log(
    `experiment-report: experiment '${manifest.experimentId}' status=${attachment.status} servedPairs=${attachment.servedPairs.length} findings=${findings.length}`,
  );
  return { status: attachment.status, attachment, findings };
}

/**
 * Thrown by {@link assertExperimentReportComposed} when a composition
 * carried any finding. The message NAMES every offending artifact + field so
 * the failure stays visible at the process level. Never a silent pass.
 */
export class ExperimentReportCompositionError extends Error {
  constructor(public readonly findings: readonly ExperimentReportFinding[]) {
    super(
      `experiment benchmark report composition FAILED with ${findings.length} finding(s): ${findings
        .map((f) => `${f.kind}@artifact:'${f.artifactPath}'${f.field ? `/field:${f.field}` : ""}`)
        .join(", ")}`,
    );
    this.name = "ExperimentReportCompositionError";
  }
}

export function assertExperimentReportComposed(
  composition: ExperimentReportComposition,
): asserts composition is ExperimentReportComposition & {
  status: "succeeded";
  attachment: BenchmarkReportAttachment;
} {
  if (composition.status !== "succeeded" || composition.findings.length > 0) {
    throw new ExperimentReportCompositionError(composition.findings);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Reading + structural validation.
// ─────────────────────────────────────────────────────────────────────────

function readManifest(
  input: ExperimentReportComposeInput,
  findings: ExperimentReportFinding[],
  log: (message: string) => void,
): ExperimentMatrixRunManifest | null {
  const ref = input.experimentManifestRef;
  let raw: unknown;
  try {
    raw = input.readArtifact(ref);
  } catch (error) {
    findings.push(missing(ref, "experiment-matrix run manifest", error));
    log(`experiment-report: experiment-matrix manifest '${ref.artifactPath}' MISSING`);
    return null;
  }
  const reason = manifestShapeError(raw);
  if (reason !== null) {
    findings.push(invalid(ref, reason));
    log(`experiment-report: experiment-matrix manifest '${ref.artifactPath}' INVALID — ${reason}`);
    return null;
  }
  return raw as ExperimentMatrixRunManifest;
}

function readRouteReport(
  input: ExperimentReportComposeInput,
  findings: ExperimentReportFinding[],
  log: (message: string) => void,
): ProviderRouteReport | null {
  const ref = input.providerRouteReportRef;
  let raw: unknown;
  try {
    raw = input.readArtifact(ref);
  } catch (error) {
    findings.push(missing(ref, "provider route report", error));
    log(`experiment-report: provider route report '${ref.artifactPath}' MISSING`);
    return null;
  }
  const reason = routeReportShapeError(raw);
  if (reason !== null) {
    findings.push(invalid(ref, reason));
    log(`experiment-report: provider route report '${ref.artifactPath}' INVALID — ${reason}`);
    return null;
  }
  return raw as ProviderRouteReport;
}

function manifestShapeError(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "expected a JSON object";
  }
  const m = value as Record<string, unknown>;
  if (m.schemaVersion !== EXPERIMENT_MATRIX_RUN_MANIFEST_SCHEMA_VERSION) {
    return `schemaVersion must be '${EXPERIMENT_MATRIX_RUN_MANIFEST_SCHEMA_VERSION}' (got ${JSON.stringify(m.schemaVersion)})`;
  }
  if (typeof m.experimentId !== "string" || m.experimentId.length === 0) {
    return "experimentId must be a non-empty string";
  }
  if (m.status !== "succeeded" && m.status !== "failed") {
    return "status must be 'succeeded' or 'failed'";
  }
  if (!Array.isArray(m.artifacts)) {
    return "artifacts must be an array";
  }
  if (!Array.isArray(m.findings)) {
    return "findings must be an array";
  }
  if (typeof m.costSummary !== "object" || m.costSummary === null) {
    return "costSummary must be an object";
  }
  return null;
}

function routeReportShapeError(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "expected a JSON object";
  }
  const r = value as Record<string, unknown>;
  if (r.schemaVersion !== PROVIDER_ROUTE_REPORT_SCHEMA_VERSION) {
    return `schemaVersion must be '${PROVIDER_ROUTE_REPORT_SCHEMA_VERSION}' (got ${JSON.stringify(r.schemaVersion)})`;
  }
  if (typeof r.experimentId !== "string" || r.experimentId.length === 0) {
    return "experimentId must be a non-empty string";
  }
  for (const key of ["reliability", "structuredOutputSupport", "costReconciliation"] as const) {
    if (typeof r[key] !== "object" || r[key] === null) {
      return `${key} section must be an object`;
    }
  }
  const cost = r.costReconciliation as Record<string, unknown>;
  if (!Array.isArray(cost.findings)) {
    return "costReconciliation.findings must be an array";
  }
  return null;
}

function missing(ref: ComposedArtifactRef, role: string, error: unknown): ExperimentReportFinding {
  return {
    kind: "missing_artifact",
    artifactName: ref.artifactName,
    artifactPath: ref.artifactPath,
    field: null,
    message: `${role} artifact '${ref.artifactPath}' (${ref.artifactName}) could not be read: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function invalid(ref: ComposedArtifactRef, reason: string): ExperimentReportFinding {
  return {
    kind: "invalid_artifact",
    artifactName: ref.artifactName,
    artifactPath: ref.artifactPath,
    field: null,
    message: `artifact '${ref.artifactPath}' (${ref.artifactName}) is structurally invalid: ${reason}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Staleness detection (compose ITOTORI-100 renderers — do not reimplement).
// ─────────────────────────────────────────────────────────────────────────

function detectStaleProviderReport(
  input: ExperimentReportComposeInput,
  artifacts: readonly ExperimentInvocationArtifact[],
  routeReport: ProviderRouteReport,
  findings: ExperimentReportFinding[],
): void {
  const ref = input.providerRouteReportRef;

  // The reliability + structured-output sections are a PURE function of the
  // ITOTORI-099 artifacts. Re-render them from THIS manifest's artifacts with
  // the supplied report's own generatedAt + experimentId, then compare the
  // artifact-derived bodies. Any divergence ⇒ the report was rendered from a
  // different (stale) artifact set.
  const expectedReliability = renderRouteReliability({
    experimentId: routeReport.experimentId,
    generatedAt: routeReport.reliability.generatedAt,
    artifacts,
  });
  if (!sectionMatches(expectedReliability, routeReport.reliability)) {
    findings.push({
      kind: "stale_provider_report",
      artifactName: ref.artifactName,
      artifactPath: ref.artifactPath,
      field: "reliability",
      message: `provider route report '${ref.artifactPath}' is STALE: its reliability section does not match the section re-derived from the experiment-matrix manifest's ${artifacts.length} artifact(s); regenerate the provider route report from the current experiment run`,
    });
  }

  const expectedStructured = renderStructuredOutputSupport({
    experimentId: routeReport.experimentId,
    generatedAt: routeReport.structuredOutputSupport.generatedAt,
    artifacts,
  });
  if (!structuredMatches(expectedStructured, routeReport.structuredOutputSupport)) {
    findings.push({
      kind: "stale_provider_report",
      artifactName: ref.artifactName,
      artifactPath: ref.artifactPath,
      field: "structuredOutputSupport",
      message: `provider route report '${ref.artifactPath}' is STALE: its structured-output-support section does not match the section re-derived from the experiment-matrix manifest's ${artifacts.length} artifact(s); regenerate the provider route report from the current experiment run`,
    });
  }
}

/** Compare the artifact-derived body of a reliability report (ignore header). */
function sectionMatches(
  a: ProviderRouteReliabilityReport,
  b: ProviderRouteReliabilityReport,
): boolean {
  return (
    canonical(a.byServedRoute) === canonical(b.byServedRoute) &&
    canonical(a.totals) === canonical(b.totals)
  );
}

function structuredMatches(
  a: StructuredOutputSupportReport,
  b: StructuredOutputSupportReport,
): boolean {
  return canonical(a.rows) === canonical(b.rows);
}

/** Stable JSON for structural comparison (the ITOTORI-100 renderers emit
 *  deterministically-ordered output, so key order is already canonical). */
function canonical(value: unknown): string {
  return JSON.stringify(value);
}

// ─────────────────────────────────────────────────────────────────────────
// Cost cross-check (cost ONLY from the composed artifacts).
// ─────────────────────────────────────────────────────────────────────────

function detectCostInconsistency(
  input: ExperimentReportComposeInput,
  manifest: ExperimentMatrixRunManifest,
  routeReport: ProviderRouteReport,
  findings: ExperimentReportFinding[],
): void {
  const ref = input.providerRouteReportRef;
  const cost = routeReport.costReconciliation;

  // A provider report carrying its OWN reconciliation findings is a
  // provider-proof problem (artifact↔ledger disagreement): surface it so the
  // composed cost section is not trusted blindly.
  if (cost.findings.length > 0) {
    findings.push({
      kind: "provider_proof_unreconciled",
      artifactName: ref.artifactName,
      artifactPath: ref.artifactPath,
      field: "costReconciliation.findings",
      message: `provider route report '${ref.artifactPath}' carries ${cost.findings.length} unreconciled provider-proof finding(s) (e.g. ${cost.findings[0]?.message ?? "?"}); the composed cost summary cannot be trusted until they are resolved`,
    });
    return;
  }

  // The route report reconciled EVERY artifact ⇒ its summed artifact cost
  // must equal the experiment manifest's summed captured cost (both sourced
  // verbatim from the same replayed costs). A divergence means the report was
  // reconciled against a different artifact set (stale) or a different ledger.
  if (cost.artifactInvocationCount !== manifest.artifacts.length) {
    findings.push({
      kind: "cost_cross_check_mismatch",
      artifactName: ref.artifactName,
      artifactPath: ref.artifactPath,
      field: "costReconciliation.artifactInvocationCount",
      message: `provider route report '${ref.artifactPath}' reconciled ${cost.artifactInvocationCount} invocation(s) but the experiment-matrix manifest carries ${manifest.artifacts.length} artifact(s)`,
    });
    return;
  }
  if (cost.artifactMicrosUsd !== manifest.costSummary.totalMicrosUsd) {
    findings.push({
      kind: "cost_cross_check_mismatch",
      artifactName: ref.artifactName,
      artifactPath: ref.artifactPath,
      field: "costReconciliation.artifactMicrosUsd",
      message: `cost cross-check mismatch: provider route report '${ref.artifactPath}' summed ${cost.artifactMicrosUsd} micros over reconciled artifacts but the experiment-matrix manifest cost summary totals ${manifest.costSummary.totalMicrosUsd} micros`,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Attachment assembly.
// ─────────────────────────────────────────────────────────────────────────

function buildAttachment(
  input: ExperimentReportComposeInput,
  manifest: ExperimentMatrixRunManifest,
  routeReport: ProviderRouteReport,
  findings: ExperimentReportFinding[],
): BenchmarkReportAttachment {
  const reliability = routeReport.reliability;
  const providerRoute: ProviderRouteSection = {
    byServedRoute: mapValues(reliability.byServedRoute, (row) => ({
      servedProvider: row.servedProvider,
      servedModel: row.servedModel,
      requestedPairs: row.requestedPairs,
      servedDivergesFromRequested: row.servedDivergesFromRequested,
      invocationCount: row.invocationCount,
      succeededCount: row.succeededCount,
      failedCount: row.failedCount,
      partialCount: row.partialCount,
      skippedCount: row.skippedCount,
      zdrEnforcedCount: row.zdrEnforcedCount,
    })),
    invocationCount: reliability.totals.invocationCount,
    succeededCount: reliability.totals.succeededCount,
    failedCount: reliability.totals.failedCount,
    partialCount: reliability.totals.partialCount,
    skippedCount: reliability.totals.skippedCount,
    zdrEnforcedCount: reliability.totals.zdrEnforcedCount,
  };

  const fallback: FallbackSection = {
    byServedRoute: mapValues(reliability.byServedRoute, (row) => ({
      servedProvider: row.servedProvider,
      servedModel: row.servedModel,
      fallbackInvocationCount: row.fallbackInvocationCount,
      fallbackPlans: row.fallbackPlans,
    })),
    fallbackInvocationCount: reliability.totals.fallbackInvocationCount,
  };

  const retry: RetrySection = {
    byServedRoute: mapValues(reliability.byServedRoute, (row) => ({
      servedProvider: row.servedProvider,
      servedModel: row.servedModel,
      retriedInvocationCount: row.retriedInvocationCount,
      totalRetryCount: row.totalRetryCount,
    })),
    retriedInvocationCount: reliability.totals.retriedInvocationCount,
    totalRetryCount: reliability.totals.totalRetryCount,
  };

  const structuredOutputSupport: StructuredOutputSupportSection = {
    rows: routeReport.structuredOutputSupport.rows,
  };

  // Cost: experiment-level totals restated from the ITOTORI-099 manifest
  // cost summary; reconciliation totals restated from the ITOTORI-100 cost
  // reconciliation. Both are verbatim real captured cost; micros→USD only.
  const recon = routeReport.costReconciliation;
  const costSummary: CostSummarySection = {
    currency: "USD",
    experimentTotalMicrosUsd: manifest.costSummary.totalMicrosUsd,
    experimentTotalUsd: microsToUsdDecimalString(manifest.costSummary.totalMicrosUsd),
    billedInvocationCount: manifest.costSummary.billedInvocationCount,
    zeroCostInvocationCount: manifest.costSummary.zeroCostInvocationCount,
    reconciledInvocationCount: recon.reconciledInvocationCount,
    artifactMicrosUsd: recon.artifactMicrosUsd,
    artifactUsd: recon.artifactUsd,
    ledgerMicrosUsd: recon.ledgerMicrosUsd,
    ledgerUsd: recon.ledgerUsd,
    byServedRoute: recon.byServedRoute,
  };

  return {
    schemaVersion: EXPERIMENT_BENCHMARK_ATTACHMENT_SCHEMA_VERSION,
    attachmentKind: "provider_experiment_report",
    experimentId: manifest.experimentId,
    generatedAt: input.generatedAt,
    status: findings.length === 0 ? "succeeded" : "failed",
    source: {
      experimentManifest: {
        artifactName: input.experimentManifestRef.artifactName,
        artifactPath: input.experimentManifestRef.artifactPath,
        schemaVersion: manifest.schemaVersion,
        configHash: manifest.configHash,
        mode: manifest.mode,
        generatedAt: manifest.generatedAt,
        runStatus: manifest.status,
        artifactCount: manifest.artifacts.length,
      },
      providerRouteReport: {
        artifactName: input.providerRouteReportRef.artifactName,
        artifactPath: input.providerRouteReportRef.artifactPath,
        schemaVersion: routeReport.schemaVersion,
        generatedAt: routeReport.generatedAt,
      },
    },
    servedPairs: recordedServedPairs(manifest.artifacts),
    sections: {
      providerRoute,
      fallback,
      retry,
      structuredOutputSupport,
      costSummary,
    },
    findings,
  };
}

/**
 * The RECORDED served (model, provider) pairs taken verbatim from the
 * artifacts — `actualModelId` + the canonicalized served `upstreamProvider`
 * (the upstream OR actually served through, NOT the requested pin). Deduped +
 * sorted for a stable attachment.
 */
function recordedServedPairs(
  artifacts: readonly ExperimentInvocationArtifact[],
): ServedModelProviderPair[] {
  const seen = new Map<string, ServedModelProviderPair>();
  for (const artifact of artifacts) {
    const servedProviderId = canonicalServedProviderId(artifact.providerRun.upstreamProvider);
    const servedModelId = artifact.providerRun.actualModelId;
    seen.set(`${servedProviderId}::${servedModelId}`, { servedModelId, servedProviderId });
  }
  return [...seen.values()].sort((a, b) =>
    `${a.servedProviderId}::${a.servedModelId}`.localeCompare(
      `${b.servedProviderId}::${b.servedModelId}`,
    ),
  );
}

function mapValues<V, W>(
  record: Record<ProviderRouteServedKey, V>,
  fn: (value: V) => W,
): Record<ProviderRouteServedKey, W> {
  const out: Record<ProviderRouteServedKey, W> = {};
  for (const key of Object.keys(record).sort() as ProviderRouteServedKey[]) {
    out[key] = fn(record[key]!);
  }
  return out;
}
