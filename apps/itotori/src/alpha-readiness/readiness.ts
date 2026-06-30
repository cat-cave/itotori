// ALPHA-003 — Alpha readiness cost and quality benchmark composition.
//
// This module owns NO scoring, routing, rendering, or cost math of its own. It
// COMPOSES the already-merged subsystems into a single alpha-readiness decision:
//
//   ITOTORI-026 benchmark harness  → the run manifest + named report artifacts
//                                     (benchmark-set selection, raw-MTL baseline,
//                                     deterministic QA, QA-agent eval, cost/quality
//                                     report). The harness already sources its cost
//                                     summary from the report's recomputed ledger.
//   ITOTORI-090/091/092 stages     → the validated `BenchmarkReportV02` embedded in
//                                     the cost-quality artifact (`assembleBenchmarkReport`
//                                     ran `assertBenchmarkReportV02`, recomputing the
//                                     cost ledger from the real provider-run records).
//   ITOTORI-100 / ITOTORI-039      → the provider experiment-report attachment:
//                                     served (model, provider) pairs + the artifact↔ledger
//                                     cost reconciliation (provider proof).
//
// The PUBLIC-fixture benchmark decides the alpha pass/fail. A private-local
// aggregate, if supplied, is recorded as supplementary evidence (presence + a
// content hash only — never its raw contents) and NEVER gates the decision and
// never substitutes for a missing public result.
//
// Every cost value flows from a real artifact/ledger; the ONLY permitted cost
// transform is integer-micros → USD (`/1e6`). No cost is approximated or
// hardcoded. Token counts carry their real provenance (`tokenCountSource`),
// restated verbatim from the validated provider-run records.

import type {
  BenchmarkCountBucketV02,
  BenchmarkProviderRunV02,
  BenchmarkReportV02,
} from "@itotori/localization-bridge-schema";
import type {
  BenchmarkHarnessNamedArtifact,
  BenchmarkHarnessRunManifest,
  BenchmarkHarnessStageId,
} from "../benchmark-harness/index.js";
import type {
  BenchmarkReportAttachment,
  ExperimentReportComposition,
} from "../experiment-report/index.js";
import type { RenderedBenchmarkReports } from "../benchmark-stages/index.js";

export const ALPHA_READINESS_REPORT_SCHEMA_VERSION = "itotori.alpha_readiness_report.v0.1" as const;

/** Convert integer micros-USD to USD. The ONLY permitted cost transform. */
function microsToUsd(micros: number): number {
  return micros / 1e6;
}

// ─────────────────────────────────────────────────────────────────────────
// Artifact links + gates.
// ─────────────────────────────────────────────────────────────────────────

/**
 * A named, on-disk artifact the readiness output LINKS to so a reviewer can
 * locate (and hash-verify) the exact composed evidence. `artifactHash` is the
 * harness-emitted content hash when the link points at a harness report.
 */
export type AlphaReadinessArtifactLink = {
  readonly role: string;
  readonly artifactPath: string;
  readonly artifactHash: string | null;
};

export type AlphaReadinessGateId =
  | "benchmark-run-succeeded"
  | "mtl-baseline-included"
  | "cost-ledger-attributed"
  | "quality-evidence-present"
  | "provider-proof-reconciled";

/**
 * One pass/fail gate. `detail` states only facts derived from the composed
 * artifacts (README-safe — no superlatives, no unverifiable claim).
 */
export type AlphaReadinessGate = {
  readonly id: AlphaReadinessGateId;
  readonly title: string;
  readonly status: "pass" | "fail";
  readonly detail: string;
};

export type AlphaReadinessFindingKind =
  | "gate_failed"
  | "missing_benchmark_artifact"
  | "experiment_composition_failed";

/** A structured failure that stays VISIBLE in the readiness output. */
export type AlphaReadinessFinding = {
  readonly kind: AlphaReadinessFindingKind;
  readonly gateId: AlphaReadinessGateId | null;
  readonly message: string;
};

// ─────────────────────────────────────────────────────────────────────────
// Cost report (deliverable).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Per provider-run cost row. Carries the (model, provider) identity + the
 * REAL token provenance (`tokenCountSource`); cost is the recorded amount, with
 * the only derivation being micros → USD.
 */
export type AlphaReadinessProviderRunCost = {
  readonly providerRunId: string;
  readonly systemId: string;
  readonly taskKind: string;
  readonly providerFamily: string;
  readonly providerName: string;
  readonly requestedModelId: string;
  readonly actualModelId: string;
  readonly upstreamProvider: string | null;
  readonly tokenCountSource: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
  readonly costKind: string;
  readonly amountMicrosUsd: number | null;
  readonly amountUsd: number | null;
};

/**
 * Cross-check restated VERBATIM from the ITOTORI-100/039 provider experiment
 * report: the artifact-recorded cost vs the provider-ledger cost. No value is
 * computed here — the USD strings are the ones ITOTORI-100 already derived.
 */
export type AlphaReadinessProviderProofReconciliation = {
  readonly experimentId: string;
  readonly reconciledInvocationCount: number;
  readonly artifactMicrosUsd: number;
  readonly artifactUsd: string;
  readonly ledgerMicrosUsd: number;
  readonly ledgerUsd: string;
};

export type AlphaReadinessCostReport = {
  readonly currency: "USD";
  /** The cost is SOURCED from the benchmark report's recomputed ledger. */
  readonly source: "benchmark_cost_ledger";
  readonly reportTotalMicrosUsd: number;
  readonly reportTotalUsd: number;
  readonly includesUnknownCost: boolean;
  readonly perSystem: ReadonlyArray<{
    readonly systemId: string;
    readonly totalMicrosUsd: number;
    readonly totalUsd: number;
  }>;
  readonly perProviderRun: readonly AlphaReadinessProviderRunCost[];
  /** Null when the provider-proof composition did not yield an attachment. */
  readonly providerProofReconciliation: AlphaReadinessProviderProofReconciliation | null;
};

// ─────────────────────────────────────────────────────────────────────────
// Quality report (deliverable).
// ─────────────────────────────────────────────────────────────────────────

export type AlphaReadinessQualityReport = {
  readonly rawMtlBaseline: RenderedBenchmarkReports["quality"]["rawMtlBaseline"];
  readonly deterministicQa: RenderedBenchmarkReports["quality"]["deterministicQa"];
  readonly qaAgentEvaluations: RenderedBenchmarkReports["quality"]["qaAgentEvaluations"];
  readonly countsByQualitySeverity: readonly BenchmarkCountBucketV02[];
  readonly countsByCategory: readonly BenchmarkCountBucketV02[];
  readonly penaltySummary: BenchmarkReportV02["penaltySummary"];
};

// ─────────────────────────────────────────────────────────────────────────
// Provider proof section.
// ─────────────────────────────────────────────────────────────────────────

export type AlphaReadinessProviderProof = {
  readonly status: "succeeded" | "failed";
  readonly experimentId: string;
  readonly servedPairs: ReadonlyArray<{
    readonly servedModelId: string;
    readonly servedProviderId: string;
  }>;
  readonly invocationCount: number;
  readonly succeededCount: number;
  readonly failedCount: number;
  readonly zdrEnforcedCount: number;
};

// ─────────────────────────────────────────────────────────────────────────
// Supplementary private-local section.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Supplementary private-local evidence. Records PRESENCE + a content hash and a
 * caller-declared label ONLY — never the raw contents — so a private corpus
 * result can never leak into the README-safe public output and can never gate
 * the alpha decision.
 */
export type AlphaReadinessSupplementaryPrivateLocal = {
  readonly provided: boolean;
  /** Always false: supplementary evidence never gates the alpha claim. */
  readonly gatesDecision: false;
  readonly note: string;
  readonly label: string | null;
  readonly aggregateSha256: string | null;
};

/** A pre-hashed handle to a private-local aggregate — never its raw contents. */
export type AlphaReadinessPrivateLocalHandle = {
  readonly label: string;
  readonly sha256: string;
};

// ─────────────────────────────────────────────────────────────────────────
// Top-level readiness report.
// ─────────────────────────────────────────────────────────────────────────

export type AlphaReadinessReport = {
  readonly schemaVersion: typeof ALPHA_READINESS_REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly benchmarkRunId: string;
  readonly benchmarkName: string;
  readonly decision: "pass" | "fail";
  readonly decidedBy: "public_fixture_benchmark";
  readonly gates: readonly AlphaReadinessGate[];
  readonly failedGateIds: readonly AlphaReadinessGateId[];
  readonly links: {
    readonly benchmarkRunManifest: AlphaReadinessArtifactLink;
    readonly benchmarkSeedSelection: AlphaReadinessArtifactLink;
    readonly qualityReport: AlphaReadinessArtifactLink;
    readonly providerProof: AlphaReadinessArtifactLink;
  };
  readonly mtlBaseline: {
    readonly included: boolean;
    readonly systems: RenderedBenchmarkReports["quality"]["rawMtlBaseline"];
  };
  readonly cost: AlphaReadinessCostReport;
  readonly quality: AlphaReadinessQualityReport;
  readonly providerProof: AlphaReadinessProviderProof | null;
  readonly supplementaryPrivateLocal: AlphaReadinessSupplementaryPrivateLocal;
  readonly findings: readonly AlphaReadinessFinding[];
};

export type AlphaReadinessCostQualityArtifact = {
  readonly report: BenchmarkReportV02;
  readonly rendered: RenderedBenchmarkReports;
};

export type AlphaReadinessComposeInput = {
  /** The ITOTORI-026 harness run manifest (names every report artifact). */
  readonly runManifest: BenchmarkHarnessRunManifest;
  /** The cost-quality stage artifact: the validated report + rendered sections. */
  readonly costQualityArtifact: AlphaReadinessCostQualityArtifact;
  /** The ITOTORI-039/100 provider experiment-report composition. */
  readonly experimentComposition: ExperimentReportComposition;
  /** On-disk path the provider-proof attachment was written to (for the link). */
  readonly providerProofArtifactPath: string;
  /** Caller-supplied for determinism — the composition never reads the clock. */
  readonly generatedAt: string;
  /** Optional supplementary handle. Pre-hashed; raw contents never enter here. */
  readonly privateLocalAggregate?: AlphaReadinessPrivateLocalHandle | null;
};

const SUPPLEMENTARY_NOTE =
  "Supplementary private-local evidence: recorded by presence + content hash only; " +
  "it never gates the alpha decision and never substitutes for a public result.";

/**
 * Compose the alpha readiness decision from the public-fixture benchmark
 * artifacts. Returns a report in EVERY case: a failed benchmark run, a missing
 * baseline, an unattributed cost, or a failed provider-proof composition is
 * recorded as a failing gate + structured finding (the decision flips to
 * `"fail"`), never by silently dropping the evidence.
 */
export function composeAlphaReadiness(input: AlphaReadinessComposeInput): AlphaReadinessReport {
  const { runManifest, costQualityArtifact, experimentComposition } = input;
  const { report, rendered } = costQualityArtifact;
  const findings: AlphaReadinessFinding[] = [];

  const links = buildLinks(input);
  const attachment = experimentComposition.attachment;

  // ── Gate: the public-fixture benchmark run succeeded end-to-end. ──────────
  const runSucceeded = runManifest.status === "succeeded" && runManifest.failedStageId === null;
  const benchmarkRunGate: AlphaReadinessGate = {
    id: "benchmark-run-succeeded",
    title: "Public-fixture benchmark run completed",
    status: runSucceeded ? "pass" : "fail",
    detail: runSucceeded
      ? `All ${runManifest.stages.length} harness stages succeeded; ${runManifest.generatedReports.length} report artifact(s) named.`
      : `Harness run status='${runManifest.status}', failed at stage '${runManifest.failedStageId ?? "unknown"}'.`,
  };

  // ── Gate: a raw-MTL baseline system is present in the comparison. ─────────
  const mtlSystems = rendered.quality.rawMtlBaseline.filter(
    (system) => system.systemKind === "raw_mtl_baseline",
  );
  const mtlIncluded = mtlSystems.length > 0;
  const mtlGate: AlphaReadinessGate = {
    id: "mtl-baseline-included",
    title: "Raw MTL baseline included",
    status: mtlIncluded ? "pass" : "fail",
    detail: mtlIncluded
      ? `Raw MTL baseline present: ${mtlSystems.map((s) => s.systemId).join(", ")}.`
      : "No raw_mtl_baseline system found among the compared systems.",
  };

  // ── Gate: the cost is fully attributed by the recomputed ledger. ──────────
  const ledger = report.costLedger;
  const costAttributed =
    runManifest.costSummary !== null &&
    ledger.includesUnknownCost === false &&
    ledger.totalsBySystem.length > 0;
  const costGate: AlphaReadinessGate = {
    id: "cost-ledger-attributed",
    title: "Cost fully attributed by the recomputed ledger",
    status: costAttributed ? "pass" : "fail",
    detail: costAttributed
      ? `Ledger total ${microsToUsd(ledger.reportTotalMicrosUsd).toFixed(6)} USD across ${ledger.totalsBySystem.length} system(s); no unattributed cost.`
      : `Cost ledger is incomplete (includesUnknownCost=${ledger.includesUnknownCost}, totalsBySystem=${ledger.totalsBySystem.length}).`,
  };

  // ── Gate: deterministic QA + QA-agent evidence are present. ───────────────
  const deterministicQaCount = rendered.quality.deterministicQa.length;
  const qaAgentCount = rendered.quality.qaAgentEvaluations.length;
  const qualityPresent = deterministicQaCount > 0 && qaAgentCount > 0;
  const qualityGate: AlphaReadinessGate = {
    id: "quality-evidence-present",
    title: "Deterministic QA and LLM QA evidence present",
    status: qualityPresent ? "pass" : "fail",
    detail: qualityPresent
      ? `${deterministicQaCount} deterministic QA result(s) and ${qaAgentCount} QA-agent evaluation(s) recorded.`
      : `Missing quality evidence (deterministicQa=${deterministicQaCount}, qaAgentEvaluations=${qaAgentCount}).`,
  };

  // ── Gate: provider proof composed + cost reconciled across the two sources. ─
  const providerProofOk =
    experimentComposition.status === "succeeded" &&
    attachment !== null &&
    attachment.servedPairs.length > 0;
  const providerGate: AlphaReadinessGate = {
    id: "provider-proof-reconciled",
    title: "Provider route proof composed and cost-reconciled",
    status: providerProofOk ? "pass" : "fail",
    detail:
      providerProofOk && attachment !== null
        ? `Experiment '${attachment.experimentId}' reconciled ${attachment.sections.costSummary.reconciledInvocationCount} invocation(s); ${attachment.servedPairs.length} served (model, provider) pair(s).`
        : `Provider experiment-report composition status='${experimentComposition.status}' with ${experimentComposition.findings.length} finding(s).`,
  };

  if (experimentComposition.status !== "succeeded") {
    findings.push({
      kind: "experiment_composition_failed",
      gateId: "provider-proof-reconciled",
      message: `provider experiment-report composition failed with ${experimentComposition.findings.length} finding(s): ${experimentComposition.findings
        .map((f) => `${f.kind}@'${f.artifactPath}'`)
        .join(", ")}`,
    });
  }

  const gates: AlphaReadinessGate[] = [
    benchmarkRunGate,
    mtlGate,
    costGate,
    qualityGate,
    providerGate,
  ];
  for (const gate of gates) {
    if (gate.status === "fail") {
      findings.push({
        kind: "gate_failed",
        gateId: gate.id,
        message: `gate '${gate.id}' (${gate.title}) failed: ${gate.detail}`,
      });
    }
  }
  if (links.benchmarkSeedSelection.artifactPath === "") {
    findings.push({
      kind: "missing_benchmark_artifact",
      gateId: null,
      message:
        "harness run manifest did not name a 'benchmark-set-selection' report artifact to link",
    });
  }

  const failedGateIds = gates.filter((g) => g.status === "fail").map((g) => g.id);
  const decision: "pass" | "fail" = failedGateIds.length === 0 ? "pass" : "fail";

  const handle = input.privateLocalAggregate ?? null;
  const supplementaryPrivateLocal: AlphaReadinessSupplementaryPrivateLocal = {
    provided: handle !== null,
    gatesDecision: false,
    note: SUPPLEMENTARY_NOTE,
    label: handle?.label ?? null,
    aggregateSha256: handle?.sha256 ?? null,
  };

  return {
    schemaVersion: ALPHA_READINESS_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    benchmarkRunId: runManifest.benchmarkRunId,
    benchmarkName: runManifest.benchmarkName,
    decision,
    decidedBy: "public_fixture_benchmark",
    gates,
    failedGateIds,
    links,
    mtlBaseline: { included: mtlIncluded, systems: mtlSystems },
    cost: buildCostReport(report, attachment),
    quality: buildQualityReport(rendered),
    providerProof: buildProviderProof(experimentComposition),
    supplementaryPrivateLocal,
    findings,
  };
}

function buildLinks(input: AlphaReadinessComposeInput): AlphaReadinessReport["links"] {
  const namedFor = (stageId: BenchmarkHarnessStageId): BenchmarkHarnessNamedArtifact | undefined =>
    input.runManifest.generatedReports.find((report) => report.stageId === stageId);
  const link = (
    role: string,
    named: BenchmarkHarnessNamedArtifact | undefined,
  ): AlphaReadinessArtifactLink => ({
    role,
    artifactPath: named?.artifactPath ?? "",
    artifactHash: named?.artifactHash ?? null,
  });
  return {
    benchmarkRunManifest: {
      role: "benchmark run manifest",
      artifactPath: joinArtifactPath(manifestDir(input.runManifest), "run-manifest.json"),
      artifactHash: null,
    },
    benchmarkSeedSelection: link("benchmark seed selection", namedFor("benchmark-set-selection")),
    qualityReport: link("quality report", namedFor("cost-quality-report")),
    providerProof: {
      role: "provider route proof",
      artifactPath: input.providerProofArtifactPath,
      artifactHash: null,
    },
  };
}

/**
 * Recover the harness output directory from a named report artifact path
 * (e.g. `.../benchmark-set-selection.json` → `...`). The run manifest sits in
 * that same directory. Falls back to the empty string only when no report was
 * named (already surfaced as a missing-artifact finding).
 */
function manifestDir(runManifest: BenchmarkHarnessRunManifest): string {
  const sample = runManifest.generatedReports[0]?.artifactPath;
  if (sample === undefined) {
    return "";
  }
  const sep = sample.lastIndexOf("/");
  return sep >= 0 ? sample.slice(0, sep) : "";
}

function joinArtifactPath(dir: string, file: string): string {
  if (dir === "") {
    return file;
  }
  return dir.endsWith("/") ? `${dir}${file}` : `${dir}/${file}`;
}

function buildCostReport(
  report: BenchmarkReportV02,
  attachment: BenchmarkReportAttachment | null,
): AlphaReadinessCostReport {
  const ledger = report.costLedger;
  const reconciliation: AlphaReadinessProviderProofReconciliation | null =
    attachment === null
      ? null
      : {
          experimentId: attachment.experimentId,
          reconciledInvocationCount: attachment.sections.costSummary.reconciledInvocationCount,
          artifactMicrosUsd: attachment.sections.costSummary.artifactMicrosUsd,
          artifactUsd: attachment.sections.costSummary.artifactUsd,
          ledgerMicrosUsd: attachment.sections.costSummary.ledgerMicrosUsd,
          ledgerUsd: attachment.sections.costSummary.ledgerUsd,
        };
  return {
    currency: "USD",
    source: "benchmark_cost_ledger",
    reportTotalMicrosUsd: ledger.reportTotalMicrosUsd,
    reportTotalUsd: microsToUsd(ledger.reportTotalMicrosUsd),
    includesUnknownCost: ledger.includesUnknownCost,
    perSystem: ledger.totalsBySystem.map((total) => ({
      systemId: total.systemId,
      totalMicrosUsd: total.totalMicrosUsd,
      totalUsd: microsToUsd(total.totalMicrosUsd),
    })),
    perProviderRun: report.providerModelCostRecords.map(providerRunCost),
    providerProofReconciliation: reconciliation,
  };
}

function providerRunCost(run: BenchmarkProviderRunV02): AlphaReadinessProviderRunCost {
  const amountMicrosUsd = run.cost.costKind === "unknown" ? null : (run.cost.amountMicrosUsd ?? 0);
  return {
    providerRunId: run.providerRunId,
    systemId: run.systemId,
    taskKind: run.taskKind,
    providerFamily: run.provider.providerFamily,
    providerName: run.provider.providerName,
    requestedModelId: run.provider.requestedModelId,
    actualModelId: run.provider.actualModelId,
    upstreamProvider: run.provider.upstreamProvider ?? null,
    tokenCountSource: run.tokenUsage.tokenCountSource,
    promptTokens: run.tokenUsage.promptTokens ?? null,
    completionTokens: run.tokenUsage.completionTokens ?? null,
    totalTokens: run.tokenUsage.totalTokens ?? null,
    costKind: run.cost.costKind,
    amountMicrosUsd,
    amountUsd: amountMicrosUsd === null ? null : microsToUsd(amountMicrosUsd),
  };
}

function buildQualityReport(rendered: RenderedBenchmarkReports): AlphaReadinessQualityReport {
  return {
    rawMtlBaseline: rendered.quality.rawMtlBaseline,
    deterministicQa: rendered.quality.deterministicQa,
    qaAgentEvaluations: rendered.quality.qaAgentEvaluations,
    countsByQualitySeverity: rendered.quality.countsByQualitySeverity,
    countsByCategory: rendered.quality.countsByCategory,
    penaltySummary: rendered.quality.penaltySummary,
  };
}

function buildProviderProof(
  composition: ExperimentReportComposition,
): AlphaReadinessProviderProof | null {
  const attachment = composition.attachment;
  if (attachment === null) {
    return null;
  }
  return {
    status: attachment.status,
    experimentId: attachment.experimentId,
    servedPairs: attachment.servedPairs.map((pair) => ({
      servedModelId: pair.servedModelId,
      servedProviderId: pair.servedProviderId,
    })),
    invocationCount: attachment.sections.providerRoute.invocationCount,
    succeededCount: attachment.sections.providerRoute.succeededCount,
    failedCount: attachment.sections.providerRoute.failedCount,
    zdrEnforcedCount: attachment.sections.providerRoute.zdrEnforcedCount,
  };
}
