// ITOTORI-092 — Cost and quality report renderer.
//
// Assembles the upstream benchmark stage outputs (raw-MTL baseline,
// deterministic QA, QA-agent evaluation) plus the provider ledger into a single
// `BenchmarkReportV02`, then COMPOSES `assertBenchmarkReportV02` from
// @itotori/localization-bridge-schema — the authority that recomputes the cost
// ledger, count buckets, penalty summary, and QA-agent coverage from the real
// records and rejects any inconsistency. A throw here is a visible renderer
// failure (cost cannot be faked).
//
// The renderer then projects the VALIDATED report into structured cost /
// quality / provider-fallback / QA-accuracy sections. Cost values come ONLY
// from the validated ledger and the real provider-run cost records (micros→USD
// is a /1e6 conversion, never a hardcoded amount); the sections carry aggregate
// counts and provenance, never raw prompt/response logs.

import {
  assertBenchmarkReportV02,
  computeBenchmarkCostLedgerV02,
  type BenchmarkCountBucketV02,
  type BenchmarkFindingRecordV02,
  type BenchmarkInputRefV02,
  type BenchmarkProviderRunV02,
  type BenchmarkReportV02,
  type BenchmarkCommandLineV02,
  type BenchmarkRunStatusV02,
  type BenchmarkToolVersionV02,
  type HumanEvaluationResultV02,
  type LocalizationQualitySeverityV02,
} from "@itotori/localization-bridge-schema";
import type { DeterministicQaResult } from "./deterministic-qa.js";
import type { QaAgentCalibrationSummary, QaAgentEvaluationResult } from "./qa-agent-evaluation.js";
import type { RawMtlBaselineResult } from "./raw-mtl-baseline.js";

const TAXONOMY_ID = "itotori-lqa-1" as const;
const TAXONOMY_VERSION = "itotori-quality-taxonomy-0.1.0" as const;
const BRIDGE_SCHEMA_VERSION = "0.2.0" as const;

// Taxonomy severity weights (NOT costs) — used to recompute the penalty
// summary so it matches the schema's own recomputation exactly.
const SEVERITY_WEIGHTS: Record<LocalizationQualitySeverityV02, number> = {
  critical: 25,
  major: 5,
  minor: 1,
  neutral: 0,
};

export type BenchmarkReportRenderInput = {
  benchmarkRunId: string;
  benchmarkName: string;
  createdAt: string;
  status: BenchmarkRunStatusV02;
  sourceLocale: string;
  targetLocale: string;
  // ITOTORI-059 — REQUIRED at the itotori recording boundary: a benchmark run
  // is always scoped to the locale branch it drafted/scored, never to a bare
  // target locale or the whole project. The assembled report (and its cost
  // ledger) carry this so two branches sharing a target locale stay distinct.
  localeBranchId: string;
  engineProfile: string;
  gitCommit: string;
  deterministicSeed?: string;
  toolVersions: BenchmarkToolVersionV02[];
  commandLines: BenchmarkCommandLineV02[];
  fixtureOrCorpusRefs: BenchmarkInputRefV02[];
  rawMtl: RawMtlBaselineResult;
  deterministicQa: DeterministicQaResult;
  qaAgent: QaAgentEvaluationResult;
  humanEvaluationResults: HumanEvaluationResultV02[];
  knownBlindSpots: string[];
  /**
   * §10 composition. The blind-judge-panel (§4) and deterministic-metric-suite
   * (§3) findings are not produced by the ITOTORI-090 deterministic-qa / QA-agent
   * stages; the judge-panel node deferred composing them into the top-level
   * report to §10. The actionable-backlog node adjudicates the judge findings
   * (unknown_unadjudicated → a real rootCause) and hands the full adjudicated set
   * back here (`BenchmarkImprovementBacklog.adjudicatedFindings`). They are folded
   * into `findingRecords` (deduped by findingId) so the report's counts + penalty
   * cover them. Cost is untouched — findings never feed the ledger, which stays
   * single-source in `computeBenchmarkCostLedgerV02`.
   */
  backlogFindings?: BenchmarkFindingRecordV02[];
};

/**
 * Assemble a `BenchmarkReportV02` from the stage outputs and validate it.
 * Throws (via `assertBenchmarkReportV02`) when any recomputed total — cost
 * ledger, counts, penalty, QA coverage — disagrees with the underlying records.
 */
export function assembleBenchmarkReport(input: BenchmarkReportRenderInput): BenchmarkReportV02 {
  const providerModelCostRecords: BenchmarkProviderRunV02[] = [
    ...input.rawMtl.providerRuns,
    ...input.qaAgent.providerRuns,
  ];
  // §10 composition: the ITOTORI-090/091 stage findings PLUS the adjudicated
  // §3/§4 backlog findings, deduped by findingId (a finding could be reported by
  // more than one path; the id is content-addressed so dedup is safe).
  const findingRecords: BenchmarkFindingRecordV02[] = dedupeFindingsById([
    ...input.deterministicQa.findings,
    ...input.qaAgent.findings,
    ...(input.backlogFindings ?? []),
  ]);

  // The cost ledger is built by the schema's single authoritative recompute —
  // the same function `assertBenchmarkReportV02` uses to validate it below, so
  // the assembled field can never disagree with the validator.
  const costLedger = computeBenchmarkCostLedgerV02(providerModelCostRecords, input.localeBranchId);
  const severities = findingRecords.map((finding) => finding.qualitySeverity);
  const { totalSourceCharacterCount, totalSourceUnitCount } = sumCorpusTotals(
    input.fixtureOrCorpusRefs,
  );

  const report: BenchmarkReportV02 = {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    benchmarkRunId: input.benchmarkRunId,
    taxonomyId: TAXONOMY_ID,
    taxonomyVersion: TAXONOMY_VERSION,
    createdAt: input.createdAt,
    benchmarkName: input.benchmarkName,
    status: input.status,
    fixtureOrCorpusRefs: input.fixtureOrCorpusRefs,
    sourceLocale: input.sourceLocale,
    targetLocale: input.targetLocale,
    localeBranchId: input.localeBranchId,
    engineProfile: input.engineProfile,
    gitCommit: input.gitCommit,
    bridgeSchemaVersion: BRIDGE_SCHEMA_VERSION,
    ...(input.deterministicSeed !== undefined
      ? { deterministicSeed: input.deterministicSeed }
      : {}),
    toolVersions: input.toolVersions,
    commandLines: input.commandLines,
    systemsCompared: input.rawMtl.systems,
    providerModelCostRecords,
    costLedger,
    seededDefectOracle: input.qaAgent.seededDefectOracle,
    findingRecords,
    countsByQualitySeverity: tally(findingRecords.map((finding) => finding.qualitySeverity)),
    countsByCategory: tally(findingRecords.map((finding) => finding.category)),
    countsByRootCause: tally(findingRecords.map((finding) => finding.rootCause)),
    countsByDetectorKind: tally(findingRecords.map((finding) => finding.detectorKind)),
    countsByAdjudicationState: tally(findingRecords.map((finding) => finding.adjudicationState)),
    penaltySummary: computePenalty(severities, totalSourceCharacterCount, totalSourceUnitCount),
    deterministicQaResults: input.deterministicQa.results,
    qaAgentEvaluations: input.qaAgent.evaluations,
    humanEvaluationResults: input.humanEvaluationResults,
    knownBlindSpots: input.knownBlindSpots,
  };

  assertBenchmarkReportV02(report);
  return report;
}

export type RenderedProviderRunCost = {
  providerRunId: string;
  systemId: string;
  taskKind: string;
  providerFamily: string;
  providerName: string;
  requestedModelId: string;
  actualModelId: string;
  upstreamProvider: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costKind: string;
  amountMicrosUsd: number | null;
  amountUsd: number | null;
  retryCount: number;
  fallbackUsed: boolean;
  fallbackChain: string[];
  dataPolicyFlags: string[];
};

export type RenderedCostReport = {
  currency: "USD";
  reportTotalMicrosUsd: number;
  reportTotalUsd: number;
  includesUnknownCost: boolean;
  perSystem: Array<{ systemId: string; totalMicrosUsd: number; totalUsd: number }>;
  perProviderRun: RenderedProviderRunCost[];
};

export type RenderedQualityReport = {
  rawMtlBaseline: Array<{ systemId: string; systemKind: string; unitCount: number }>;
  deterministicQa: Array<{
    evaluatedSystemId: string;
    checkName: string;
    ruleCount: number;
    passedRuleCount: number;
    failedRuleCount: number;
    findingCount: number;
  }>;
  qaAgentEvaluations: Array<{
    qaAgentId: string;
    evaluatedSystemId: string;
    seededPrecision: number;
    seededRecall: number;
    f1: number;
    categoryAccuracy: number;
    qualitySeverityAccuracy: number;
    rootCauseAccuracy: number;
    criticalRecall: number;
  }>;
  countsByQualitySeverity: BenchmarkCountBucketV02[];
  countsByCategory: BenchmarkCountBucketV02[];
  penaltySummary: BenchmarkReportV02["penaltySummary"];
};

export type RenderedProviderReport = {
  providers: Array<{
    providerRunId: string;
    systemId: string;
    providerFamily: string;
    providerName: string;
    requestedModelId: string;
    actualModelId: string;
    fallbackUsed: boolean;
    fallbackChain: string[];
    retryCount: number;
    errorClasses: string[];
  }>;
};

export type RenderedQaAccuracyReport = {
  agents: Array<{
    qaAgentId: string;
    evaluatedSystemId: string;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    matchedSeededDefectIds: string[];
    falseNegativeSeededDefectIds: string[];
    seededPrecision: number;
    seededRecall: number;
  }>;
};

export type RenderedBenchmarkReports = {
  benchmarkRunId: string;
  benchmarkName: string;
  cost: RenderedCostReport;
  quality: RenderedQualityReport;
  providers: RenderedProviderReport;
  qaAccuracy: RenderedQaAccuracyReport;
};

/**
 * Project a VALIDATED report (+ the QA-agent calibration stage output) into the
 * structured cost / quality / provider-fallback / QA-accuracy report sections.
 */
export function renderBenchmarkReports(
  report: BenchmarkReportV02,
  calibration: QaAgentCalibrationSummary[],
): RenderedBenchmarkReports {
  return {
    benchmarkRunId: report.benchmarkRunId,
    benchmarkName: report.benchmarkName,
    cost: renderCostReport(report),
    quality: renderQualityReport(report),
    providers: renderProviderReport(report),
    qaAccuracy: renderQaAccuracyReport(calibration),
  };
}

function renderCostReport(report: BenchmarkReportV02): RenderedCostReport {
  return {
    currency: "USD",
    reportTotalMicrosUsd: report.costLedger.reportTotalMicrosUsd,
    reportTotalUsd: microsToUsd(report.costLedger.reportTotalMicrosUsd),
    includesUnknownCost: report.costLedger.includesUnknownCost,
    perSystem: report.costLedger.totalsBySystem.map((total) => ({
      systemId: total.systemId,
      totalMicrosUsd: total.totalMicrosUsd,
      totalUsd: microsToUsd(total.totalMicrosUsd),
    })),
    perProviderRun: report.providerModelCostRecords.map((run) => {
      const amountMicrosUsd =
        run.cost.costKind === "unknown" ? null : (run.cost.amountMicrosUsd ?? 0);
      return {
        providerRunId: run.providerRunId,
        systemId: run.systemId,
        taskKind: run.taskKind,
        providerFamily: run.provider.providerFamily,
        providerName: run.provider.providerName,
        requestedModelId: run.provider.requestedModelId,
        actualModelId: run.provider.actualModelId,
        upstreamProvider: run.provider.upstreamProvider ?? null,
        promptTokens: run.tokenUsage.promptTokens ?? null,
        completionTokens: run.tokenUsage.completionTokens ?? null,
        totalTokens: run.tokenUsage.totalTokens ?? null,
        costKind: run.cost.costKind,
        amountMicrosUsd,
        amountUsd: amountMicrosUsd === null ? null : microsToUsd(amountMicrosUsd),
        retryCount: run.retryCount,
        fallbackUsed: run.fallbackUsed,
        fallbackChain: run.fallbackPlan ?? [],
        dataPolicyFlags: dataPolicyFlags(run),
      };
    }),
  };
}

function renderQualityReport(report: BenchmarkReportV02): RenderedQualityReport {
  return {
    rawMtlBaseline: report.systemsCompared.map((system) => ({
      systemId: system.systemId,
      systemKind: system.systemKind,
      unitCount: report.fixtureOrCorpusRefs.reduce((sum, ref) => sum + ref.sourceUnitCount, 0),
    })),
    deterministicQa: report.deterministicQaResults.map((result) => ({
      evaluatedSystemId: result.evaluatedSystemId,
      checkName: result.checkName,
      ruleCount: result.ruleCount,
      passedRuleCount: result.passedRuleCount,
      failedRuleCount: result.failedRuleCount,
      findingCount: result.findingIds.length,
    })),
    qaAgentEvaluations: report.qaAgentEvaluations.map((evaluation) => ({
      qaAgentId: evaluation.qaAgentId,
      evaluatedSystemId: evaluation.evaluatedSystemId,
      seededPrecision: evaluation.metrics.seededPrecision,
      seededRecall: evaluation.metrics.seededRecall,
      f1: evaluation.metrics.f1,
      categoryAccuracy: evaluation.metrics.categoryAccuracy,
      qualitySeverityAccuracy: evaluation.metrics.qualitySeverityAccuracy,
      rootCauseAccuracy: evaluation.metrics.rootCauseAccuracy,
      criticalRecall: evaluation.metrics.criticalRecall,
    })),
    countsByQualitySeverity: report.countsByQualitySeverity,
    countsByCategory: report.countsByCategory,
    penaltySummary: report.penaltySummary,
  };
}

function renderProviderReport(report: BenchmarkReportV02): RenderedProviderReport {
  return {
    providers: report.providerModelCostRecords.map((run) => ({
      providerRunId: run.providerRunId,
      systemId: run.systemId,
      providerFamily: run.provider.providerFamily,
      providerName: run.provider.providerName,
      requestedModelId: run.provider.requestedModelId,
      actualModelId: run.provider.actualModelId,
      fallbackUsed: run.fallbackUsed,
      fallbackChain: run.fallbackPlan ?? [],
      retryCount: run.retryCount,
      errorClasses: run.errorClasses,
    })),
  };
}

function renderQaAccuracyReport(
  calibration: QaAgentCalibrationSummary[],
): RenderedQaAccuracyReport {
  return {
    agents: calibration.map((summary) => ({
      qaAgentId: summary.qaAgentId,
      evaluatedSystemId: summary.evaluatedSystemId,
      truePositives: summary.truePositives,
      falsePositives: summary.falsePositives,
      falseNegatives: summary.falseNegatives,
      matchedSeededDefectIds: summary.matchedSeededDefectIds,
      falseNegativeSeededDefectIds: summary.falseNegativeSeededDefectIds,
      seededPrecision: summary.metrics.seededPrecision,
      seededRecall: summary.metrics.seededRecall,
    })),
  };
}

function computePenalty(
  severities: LocalizationQualitySeverityV02[],
  totalSourceCharacterCount: number,
  totalSourceUnitCount: number,
): BenchmarkReportV02["penaltySummary"] {
  const penaltyTotal = severities.reduce((sum, severity) => sum + SEVERITY_WEIGHTS[severity], 0);
  return {
    penaltyTotal,
    penaltyPerThousandSourceChars:
      totalSourceCharacterCount === 0 ? 0 : (penaltyTotal / totalSourceCharacterCount) * 1000,
    penaltyPerHundredSourceUnits:
      totalSourceUnitCount === 0 ? 0 : (penaltyTotal / totalSourceUnitCount) * 100,
  };
}

/** Dedupe findings by their content-addressed id, preserving first-seen order. */
function dedupeFindingsById(findings: BenchmarkFindingRecordV02[]): BenchmarkFindingRecordV02[] {
  const seen = new Set<string>();
  const out: BenchmarkFindingRecordV02[] = [];
  for (const finding of findings) {
    if (seen.has(finding.findingId)) {
      continue;
    }
    seen.add(finding.findingId);
    out.push(finding);
  }
  return out;
}

function tally<T extends string>(values: readonly T[]): Array<BenchmarkCountBucketV02<T>> {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].map(([bucket, count]) => ({ bucket, count }));
}

function sumCorpusTotals(refs: BenchmarkInputRefV02[]): {
  totalSourceCharacterCount: number;
  totalSourceUnitCount: number;
} {
  let totalSourceCharacterCount = 0;
  let totalSourceUnitCount = 0;
  for (const ref of refs) {
    totalSourceCharacterCount += ref.sourceCharacterCount;
    totalSourceUnitCount += ref.sourceUnitCount;
  }
  return { totalSourceCharacterCount, totalSourceUnitCount };
}

function dataPolicyFlags(run: BenchmarkProviderRunV02): string[] {
  const flags: string[] = [];
  if (
    run.provider.providerFamily === "recorded" ||
    run.provider.providerFamily === "external_mtl"
  ) {
    flags.push("recorded_replay");
  }
  if (run.cost.costKind === "zero") {
    flags.push("zero_cost");
  }
  if (run.fallbackUsed) {
    flags.push("fallback_used");
  }
  if (run.retryCount > 0) {
    flags.push("retried");
  }
  return flags;
}

/** Convert integer micros-USD to USD. The ONLY permitted cost transform. */
function microsToUsd(micros: number): number {
  return micros / 1e6;
}
