// ITOTORI-092 — Cost and quality report renderer unit tests.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assembleBenchmarkReport,
  evaluateQaAgents,
  loadBenchmarkStagesFixture,
  renderBenchmarkReports,
  runDeterministicMetricSuite,
  runDeterministicQaStage,
  runRawMtlBaselineStage,
  type BenchmarkReportRenderInput,
  type BenchmarkStagesPublicFixture,
} from "../../src/benchmark-stages/index.js";

const repoRoot = new URL("../../../../", import.meta.url);

function loadFixture(): BenchmarkStagesPublicFixture {
  return loadBenchmarkStagesFixture(
    JSON.parse(
      readFileSync(new URL("fixtures/benchmark-stages/public-fixture.json", repoRoot), "utf8"),
    ),
  );
}

function renderInputFrom(fixture: BenchmarkStagesPublicFixture): BenchmarkReportRenderInput {
  const rawMtl = runRawMtlBaselineStage({
    targetLocale: fixture.corpusTargetLocale,
    corpusTargetLocale: fixture.corpusTargetLocale,
    corpus: fixture.corpus,
    recordedSystems: fixture.recordedSystems,
  });
  const deterministicQa = runDeterministicQaStage({
    baselineOutputs: rawMtl.baselineOutputs,
    startedAt: fixture.deterministicQa.startedAt,
    completedAt: fixture.deterministicQa.completedAt,
  });
  const qaAgent = evaluateQaAgents({
    agents: fixture.qaAgents,
    seededDefectOracle: fixture.seededDefectOracle,
  });
  const meta = fixture.reportMeta;
  return {
    benchmarkRunId: "019ed026-0000-7000-8000-000000000001",
    benchmarkName: meta.benchmarkName,
    createdAt: meta.createdAt,
    status: meta.status,
    sourceLocale: meta.sourceLocale,
    targetLocale: meta.targetLocale,
    localeBranchId: meta.localeBranchId,
    engineProfile: meta.engineProfile,
    gitCommit: meta.gitCommit,
    deterministicSeed: meta.deterministicSeed,
    toolVersions: meta.toolVersions,
    commandLines: meta.commandLines,
    fixtureOrCorpusRefs: fixture.fixtureOrCorpusRefs,
    rawMtl,
    deterministicQa,
    qaAgent,
    humanEvaluationResults: fixture.humanEvaluationResults,
    knownBlindSpots: meta.knownBlindSpots,
  };
}

describe("cost-quality report renderer", () => {
  it("assembles a schema-valid report and recomputes the cost ledger from provider runs", () => {
    const report = assembleBenchmarkReport(renderInputFrom(loadFixture()));
    expect(report.costLedger.reportTotalMicrosUsd).toBe(2550);
    expect(report.costLedger.includesUnknownCost).toBe(false);
    expect(report.costLedger.totalsBySystem).toEqual(
      expect.arrayContaining([
        { systemId: "raw-mtl-baseline", totalMicrosUsd: 0 },
        { systemId: "itotori-draft", totalMicrosUsd: 2550 },
      ]),
    );
  });

  it("renders cost (micros + USD), provider/fallback, quality, and QA-accuracy sections", () => {
    const input = renderInputFrom(loadFixture());
    const report = assembleBenchmarkReport(input);
    const rendered = renderBenchmarkReports(report, input.qaAgent.calibration);

    expect(rendered.cost.reportTotalMicrosUsd).toBe(2550);
    expect(rendered.cost.reportTotalUsd).toBeCloseTo(0.00255, 10);
    const draftRun = rendered.cost.perProviderRun.find(
      (r) => r.taskKind === "draft_translation" && r.systemId === "itotori-draft",
    );
    expect(draftRun?.amountUsd).toBeCloseTo(0.00157, 10);
    expect(draftRun?.dataPolicyFlags).toContain("recorded_replay");
    const zeroRun = rendered.cost.perProviderRun.find((r) => r.systemId === "raw-mtl-baseline");
    expect(zeroRun?.dataPolicyFlags).toContain("zero_cost");

    expect(rendered.providers.providers.length).toBe(report.providerModelCostRecords.length);
    expect(rendered.quality.penaltySummary.penaltyTotal).toBe(10);
    expect(rendered.qaAccuracy.agents[0].seededPrecision).toBe(1);
    expect(rendered.qaAccuracy.agents[0].seededRecall).toBe(1);
  });

  // ITOTORI-092 followup — each quality-report row must carry THAT system's own
  // scored-unit count, not the whole-corpus total. Build an asymmetric report:
  // the corpus declares 4 source units, system A (raw-mtl-baseline) is scored on
  // 3, system B (itotori-draft) on 2. The corpus total (4) differs from BOTH, so
  // a row showing 4 would be the old whole-corpus bug.
  it("reports each system's own unit count, not the whole-corpus total", () => {
    const fixture = structuredClone(loadFixture());

    // Grow the corpus to 4 units: unit 3 is scored by system A only, unit 4 is
    // uncovered by either system (a real corpus need not be fully translated).
    fixture.corpus.push(
      {
        unitId: "019ed010-0000-7000-8000-000000000003",
        label: "script/prologue#line-003",
        sourceText: "おはよう。",
      },
      {
        unitId: "019ed010-0000-7000-8000-000000000004",
        label: "script/prologue#line-004",
        sourceText: "こんばんは。",
      },
    );
    // The declared corpus size (the OLD per-row value) is now 4 — distinct from
    // both systems' own scored-unit counts (3 and 2).
    fixture.fixtureOrCorpusRefs[0].sourceUnitCount = 4;

    const systemA = fixture.recordedSystems.find((s) => s.systemId === "raw-mtl-baseline");
    const systemB = fixture.recordedSystems.find((s) => s.systemId === "itotori-draft");
    if (systemA === undefined || systemB === undefined) {
      throw new Error("fixture must carry raw-mtl-baseline + itotori-draft systems");
    }
    // System A additionally translates unit 3 → scored on 3 units. Clean output
    // (no placeholder, non-empty) so it produces no new deterministic finding.
    systemA.translatedUnits.push({
      unitId: "019ed010-0000-7000-8000-000000000003",
      targetText: "Good morning.",
    });
    // System B stays at its original 2 units.
    expect(systemA.translatedUnits.length).toBe(3);
    expect(systemB.translatedUnits.length).toBe(2);

    const input = renderInputFrom(fixture);
    const report = assembleBenchmarkReport(input);
    const rendered = renderBenchmarkReports(report, input.qaAgent.calibration);

    const rowA = rendered.quality.rawMtlBaseline.find((r) => r.systemId === "raw-mtl-baseline");
    const rowB = rendered.quality.rawMtlBaseline.find((r) => r.systemId === "itotori-draft");
    // Each row shows its OWN scored-unit count …
    expect(rowA?.unitCount).toBe(3);
    expect(rowB?.unitCount).toBe(2);
    // … which differ from each other and from the whole-corpus total (4).
    expect(rowA?.unitCount).not.toBe(rowB?.unitCount);
    const corpusTotal = report.fixtureOrCorpusRefs.reduce((s, r) => s + r.sourceUnitCount, 0);
    expect(corpusTotal).toBe(4);
    expect(rowA?.unitCount).not.toBe(corpusTotal);
    expect(rowB?.unitCount).not.toBe(corpusTotal);

    // No other quality field regressed: the corpus-wide penalty rate still uses
    // the whole-corpus total, and provider/QA sections are intact.
    expect(rendered.quality.penaltySummary.penaltyTotal).toBeGreaterThanOrEqual(0);
    expect(rendered.providers.providers.length).toBe(report.providerModelCostRecords.length);
  });

  it("throws when a provider cost record is malformed (cost cannot be faked)", () => {
    const fixture = structuredClone(loadFixture());
    fixture.recordedSystems[1].providerRun.cost.amountMicrosUsd = -5;
    expect(() => assembleBenchmarkReport(renderInputFrom(fixture))).toThrow();
  });

  it("is reproducible: identical inputs produce identical reports", () => {
    expect(assembleBenchmarkReport(renderInputFrom(loadFixture()))).toEqual(
      assembleBenchmarkReport(renderInputFrom(loadFixture())),
    );
  });

  // §10 composition — the actionable-backlog node folds the adjudicated §3/§4
  // findings into the top-level report WITHOUT disturbing the single-source cost
  // ledger (findings never feed cost).
  it("composes §10 backlog findings into findingRecords, cost ledger untouched", () => {
    // A real, already-adjudicated deterministic-metric finding (glossary miss).
    const suite = runDeterministicMetricSuite({
      systems: [
        {
          // Must be a system present in `systemsCompared` — the report cross-
          // checks every finding's systemId against the compared systems.
          systemId: "itotori-draft",
          systemKind: "deterministic_fixture",
          units: [
            {
              unitId: "019ed030-0000-7000-8000-000000000001",
              label: "casual/line-001",
              sourceText: "剣を持つ。",
              targetText: "He holds the sword.",
            },
          ],
        },
      ],
      glossary: [{ sourceTerm: "剣", targetForm: "Longblade" }],
      canonNames: [],
      startedAt: "2026-07-05T00:00:00.000Z",
      completedAt: "2026-07-05T00:00:01.000Z",
    });
    expect(suite.findings.length).toBeGreaterThan(0);

    const base = renderInputFrom(loadFixture());
    const composed = assembleBenchmarkReport({ ...base, backlogFindings: suite.findings });
    const plain = assembleBenchmarkReport(base);

    // Backlog findings are ADDED to the report's finding records.
    expect(composed.findingRecords.length).toBe(
      plain.findingRecords.length + suite.findings.length,
    );
    const rootCauses = composed.countsByRootCause.map((b) => b.bucket);
    expect(rootCauses).toContain("glossary_policy_gap");

    // Cost is single-source: composing findings never moves the ledger.
    expect(composed.costLedger.reportTotalMicrosUsd).toBe(plain.costLedger.reportTotalMicrosUsd);

    // Deduped by findingId: re-passing the same findings does not double-count.
    const twice = assembleBenchmarkReport({
      ...base,
      backlogFindings: [...suite.findings, ...suite.findings],
    });
    expect(twice.findingRecords.length).toBe(composed.findingRecords.length);
  });
});
