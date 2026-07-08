// ITOTORI-027 — derive the persisted benchmark-report dashboard summary
// (QA-agent calibration + cost/quality headline) from a real
// BenchmarkReportV02.
//
// The summary is computed at benchmark-record time and stored in the
// benchmark_report artifact's metadata, so the cost & quality dashboard
// reads REAL recorded data — never a re-estimate. QA false
// positives / false negatives are derived deterministically from the
// report's own seeded-defect oracle + finding records (the same match
// logic the benchmark harness uses), so the dashboard can represent
// them without re-running the benchmark.

import type {
  BenchmarkFindingRecordV02,
  BenchmarkReportV02,
} from "@itotori/localization-bridge-schema";
import type { BenchmarkQaAgentSummary } from "@itotori/db";

/**
 * The JSON shape persisted under the benchmark_report artifact's
 * `metadata` column. The DB read model (`listBenchmarkReports`) parses
 * this back into a `BenchmarkReportSummary`; keeping the shapes aligned
 * is asserted by `benchmark-report-summary.test.ts`.
 */
export type BenchmarkReportMetadata = {
  schemaVersion: string;
  benchmarkName: string;
  status: string;
  createdAt: string;
  sourceLocale: string;
  targetLocale: string;
  systemCount: number;
  findingCount: number;
  penaltyTotal: number;
  qaAgents: BenchmarkQaAgentSummary[];
};

export function summarizeBenchmarkReportMetadata(
  report: BenchmarkReportV02,
): BenchmarkReportMetadata {
  return {
    schemaVersion: report.schemaVersion,
    benchmarkName: report.benchmarkName,
    status: report.status,
    createdAt: report.createdAt,
    sourceLocale: report.sourceLocale,
    targetLocale: report.targetLocale,
    systemCount: report.systemsCompared.length,
    findingCount: report.findingRecords.length,
    penaltyTotal: report.penaltySummary.penaltyTotal,
    qaAgents: summarizeQaAgents(report),
  };
}

/**
 * Per-(qa agent, evaluated system) calibration derived from the
 * report's oracle + finding records:
 *   - truePositives  : the agent's findings that matched a seeded defect
 *   - falsePositives : the agent's findings on an un-seeded location that
 *                      COULD be scored against the oracle (eligible). Findings
 *                      stamped `unscorable: true` by the harness are EXCLUDED
 *                      from the false-positive count — same exclusion the
 *                      in-memory harness applies (`recorded.unscorable !== true`
 *                      before counting the unit as a FP).
 *   - falseNegatives : seeded defects no finding of the agent covered
 * This mirrors the harness's location-based matching (a finding carries
 * `seededDefectId` when the harness matched it to the oracle) so the
 * dashboard's FP/FN representation is faithful to the recorded run —
 * `summarizeQaAgents` can be derived purely from the persisted findings
 * + oracle without re-running the harness (ITOTORI-027).
 */
export function summarizeQaAgents(report: BenchmarkReportV02): BenchmarkQaAgentSummary[] {
  const findingById = new Map<string, BenchmarkFindingRecordV02>(
    report.findingRecords.map((finding) => [finding.findingId, finding]),
  );
  return report.qaAgentEvaluations.map((evaluation) => {
    const agentFindingIds = new Set(evaluation.findingIds);
    let truePositives = 0;
    let falsePositives = 0;
    for (const findingId of evaluation.findingIds) {
      const finding = findingById.get(findingId);
      if (finding === undefined) {
        continue;
      }
      if (finding.seededDefectId !== undefined) {
        truePositives += 1;
      } else if (finding.unscorable !== true) {
        // ITOTORI-027 — mirror the harness's `else if (recorded.unscorable !==
        // true)` branch: a finding the harness classified as unscorable is
        // intentionally NOT counted as a false positive here. The harness
        // stamps `unscorable: true` on the persisted record (see
        // `buildLlmQaFinding`), so this exclusion is reproducible from the
        // persisted data alone.
        falsePositives += 1;
      }
    }
    const falseNegatives = report.seededDefectOracle.filter(
      (seed) => !seed.matchedFindingIds.some((findingId) => agentFindingIds.has(findingId)),
    ).length;
    return {
      qaAgentId: evaluation.qaAgentId,
      qaAgentVersion: evaluation.qaAgentVersion,
      evaluatedSystemId: evaluation.evaluatedSystemId,
      truePositives,
      falsePositives,
      falseNegatives,
      seededPrecision: evaluation.metrics.seededPrecision,
      seededRecall: evaluation.metrics.seededRecall,
      f1: evaluation.metrics.f1,
      findingsEmitted: evaluation.metrics.findingsEmitted,
      scorableFindings: evaluation.metrics.scorableFindings,
    };
  });
}
