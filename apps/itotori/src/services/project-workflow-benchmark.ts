import { createHash } from "node:crypto";
import type { BenchmarkArtifactLedgerInput, ProviderRunLedgerInput } from "@itotori/db";
import type { BenchmarkReportV02 } from "@itotori/localization-bridge-schema";

export function benchmarkArtifactInput(
  projectId: string,
  report: BenchmarkReportV02,
): BenchmarkArtifactLedgerInput {
  if (report.localeBranchId === undefined) {
    throw new Error("recordBenchmarkReport requires benchmarkReport.localeBranchId");
  }
  return {
    artifact: {
      artifactId: report.benchmarkRunId,
      projectId,
      localeBranchId: report.localeBranchId,
      artifactKind: "benchmark_report",
      metadata: {
        benchmarkName: report.benchmarkName,
        status: report.status,
        sourceLocale: report.sourceLocale,
        targetLocale: report.targetLocale,
        systemCount: report.systemsCompared.length,
        findingCount: report.findingRecords.length,
        penaltyTotal: report.penaltySummary.penaltyTotal,
        qaAgents: report.qaAgentEvaluations.map((evaluation) => ({
          qaAgentId: evaluation.qaAgentId,
          qaAgentVersion: evaluation.qaAgentVersion,
          evaluatedSystemId: evaluation.evaluatedSystemId,
          truePositives: 0,
          falsePositives: 0,
          falseNegatives: 0,
          seededPrecision: evaluation.metrics.seededPrecision,
          seededRecall: evaluation.metrics.seededRecall,
          f1: evaluation.metrics.f1,
          findingsEmitted: evaluation.metrics.findingsEmitted,
          scorableFindings: evaluation.metrics.scorableFindings,
        })),
      },
    },
    providerRuns: report.providerModelCostRecords.map((run) => providerRun(projectId, report, run)),
  };
}

function providerRun(
  projectId: string,
  report: BenchmarkReportV02,
  run: BenchmarkReportV02["providerModelCostRecords"][number],
): ProviderRunLedgerInput {
  const amountMicrosUsd = run.cost.amountMicrosUsd ?? 0;
  return {
    providerRunId: run.providerRunId,
    projectId,
    localeBranchId: report.localeBranchId!,
    systemId: run.systemId,
    taskKind: run.taskKind,
    startedAt: run.startedAt,
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    ...(run.latencyMs === undefined ? {} : { latencyMs: run.latencyMs }),
    status: run.status,
    provider: run.provider,
    prompt: {
      promptPresetId: run.prompt.promptPresetId,
      promptTemplateVersion: run.prompt.promptTemplateVersion,
      promptHash: run.prompt.promptHash ?? promptHash(report.benchmarkRunId, run),
      presetSchemaVersion: "benchmark-report-v0.2",
      configSnapshot: { source: "benchmark_report", benchmarkRunId: report.benchmarkRunId },
    },
    structuredOutputMode: run.structuredOutputMode,
    retryCount: run.retryCount,
    errorClasses: run.errorClasses,
    fallbackUsed: run.fallbackUsed,
    fallbackPlan: Array.from(
      new Set([
        run.provider.requestedModelId,
        ...(run.fallbackPlan ?? []),
        run.provider.actualModelId,
      ]),
    ),
    tokenUsage: run.tokenUsage,
    cost: {
      costKind: amountMicrosUsd === 0 ? "zero" : "billed",
      currency: run.cost.currency,
      amountMicrosUsd,
      ...(run.cost.pricingSnapshotId === undefined
        ? {}
        : { pricingSnapshotId: run.cost.pricingSnapshotId }),
    },
    routingPosture: { source: "benchmark_report", captured: false },
    adapterMetadata: {
      source: "benchmark_report",
      routeSettingsHash: run.provider.routeSettingsHash ?? null,
    },
  };
}

function promptHash(
  benchmarkRunId: string,
  run: BenchmarkReportV02["providerModelCostRecords"][number],
): string {
  return `sha256:${createHash("sha256")
    .update(`${benchmarkRunId}:${run.providerRunId}:${run.prompt.promptPresetId}`)
    .digest("hex")}`;
}
