import { describe, expect, it } from "vitest";
import type { BenchmarkReportV02 } from "@itotori/localization-bridge-schema";
import {
  summarizeBenchmarkReportMetadata,
  summarizeQaAgents,
} from "../src/benchmark-report-summary.js";
import { benchmarkReportFixture } from "./api-fixtures.js";

describe("summarizeBenchmarkReportMetadata", () => {
  it("derives the persisted dashboard summary from the real benchmark report", () => {
    const metadata = summarizeBenchmarkReportMetadata(benchmarkReportFixture);
    expect(metadata).toMatchObject({
      schemaVersion: benchmarkReportFixture.schemaVersion,
      benchmarkName: benchmarkReportFixture.benchmarkName,
      status: benchmarkReportFixture.status,
      createdAt: benchmarkReportFixture.createdAt,
      sourceLocale: benchmarkReportFixture.sourceLocale,
      targetLocale: benchmarkReportFixture.targetLocale,
      systemCount: benchmarkReportFixture.systemsCompared.length,
      findingCount: benchmarkReportFixture.findingRecords.length,
      penaltyTotal: benchmarkReportFixture.penaltySummary.penaltyTotal,
    });
    // The real fixture's QA agent matched its single seeded defect.
    expect(metadata.qaAgents).toEqual([
      expect.objectContaining({
        qaAgentId: "terminology-qa-agent",
        evaluatedSystemId: "itotori-draft",
        truePositives: 1,
        falsePositives: 0,
        falseNegatives: 0,
      }),
    ]);
  });

  it("counts false positives and false negatives from the oracle", () => {
    const report = {
      findingRecords: [{ findingId: "f1", seededDefectId: "s1" }, { findingId: "f2" }],
      seededDefectOracle: [
        { seededDefectId: "s1", matchedFindingIds: ["f1"] },
        { seededDefectId: "s2", matchedFindingIds: [] },
      ],
      qaAgentEvaluations: [
        {
          qaAgentId: "agent-a",
          qaAgentVersion: "1.0.0",
          evaluatedSystemId: "sys",
          findingIds: ["f1", "f2"],
          metrics: {
            seededPrecision: 0.5,
            seededRecall: 0.5,
            f1: 0.5,
            findingsEmitted: 2,
            scorableFindings: 2,
          },
        },
      ],
    } as unknown as BenchmarkReportV02;

    expect(summarizeQaAgents(report)).toEqual([
      {
        qaAgentId: "agent-a",
        qaAgentVersion: "1.0.0",
        evaluatedSystemId: "sys",
        truePositives: 1,
        falsePositives: 1,
        falseNegatives: 1,
        seededPrecision: 0.5,
        seededRecall: 0.5,
        f1: 0.5,
        findingsEmitted: 2,
        scorableFindings: 2,
      },
    ]);
  });

  // ITOTORI-027 — the harness excludes unscorable findings from the FP count
  // (`evaluateQaAgents`: `else if (recorded.unscorable !== true) { ... push FP ... }`).
  // `buildLlmQaFinding` persists `unscorable: true` on the finding record,
  // so `summarizeQaAgents` can replay that exclusion from the persisted
  // data alone — the dashboard does NOT have to re-run the harness.
  it("excludes persisted unscorable findings from the false-positive count", () => {
    const report = {
      findingRecords: [
        { findingId: "f1", seededDefectId: "s1" },
        // unscorable finding on an un-seeded unit — must be excluded from FP
        { findingId: "f2", unscorable: true },
        // normal finding on an un-seeded unit — is a false positive
        { findingId: "f3" },
      ],
      seededDefectOracle: [
        { seededDefectId: "s1", matchedFindingIds: ["f1"] },
        { seededDefectId: "s2", matchedFindingIds: [] },
      ],
      qaAgentEvaluations: [
        {
          qaAgentId: "agent-a",
          qaAgentVersion: "1.0.0",
          evaluatedSystemId: "sys",
          findingIds: ["f1", "f2", "f3"],
          metrics: {
            seededPrecision: 1,
            seededRecall: 0.5,
            f1: 1 / 1.5,
            findingsEmitted: 3,
            scorableFindings: 2,
          },
        },
      ],
    } as unknown as BenchmarkReportV02;

    expect(summarizeQaAgents(report)).toEqual([
      {
        qaAgentId: "agent-a",
        qaAgentVersion: "1.0.0",
        evaluatedSystemId: "sys",
        // f1 TP, f2 unscorable (NOT counted), f3 FP
        truePositives: 1,
        falsePositives: 1,
        falseNegatives: 1,
        seededPrecision: 1,
        seededRecall: 0.5,
        f1: 1 / 1.5,
        findingsEmitted: 3,
        scorableFindings: 2,
      },
    ]);
  });
});
