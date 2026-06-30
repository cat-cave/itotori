// ITOTORI-026 — Benchmark harness integration regression suite.
//
// Proves the composition command (a) wires the five prerequisite
// subsystems into ONE run that names every generated report, (b) sources
// the cost summary from the composed report's validated cost ledger (no
// hardcoded cost), and (c) propagates a per-stage failure as a VISIBLE
// failed stage that short-circuits the rest of the pipeline.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BENCHMARK_HARNESS_RUN_MANIFEST_SCHEMA_VERSION,
  BENCHMARK_HARNESS_STAGE_ORDER,
  BenchmarkHarnessMissingCompositionError,
  BenchmarkHarnessStageConfigurationError,
  assertBenchmarkHarnessRunManifest,
  benchmarkSetReadModelFromSeedsFixture,
  benchmarkSetSelectionInputFromSetsFixture,
  buildPublicBenchmarkHarnessStages,
  runBenchmarkHarnessCommand,
  type BenchmarkHarnessStage,
  type BenchmarkHarnessStageId,
  type PublicBenchmarkHarnessFixtureInputs,
} from "../src/benchmark-harness/index.js";
import { runItotoriCliCommand, type ItotoriCliServices } from "../src/cli-handlers.js";

const repoRoot = new URL("../../../", import.meta.url);

function readRepoJson(repoRelativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(repoRelativePath, repoRoot), "utf8"));
}

const SEEDS_FIXTURE_PATH = "fixtures/catalog-benchmark-seeds/fixture.json";
const SETS_FIXTURE_PATH = "fixtures/catalog-benchmark-sets/fixture.json";
const REPORT_FIXTURE_PATH =
  "packages/localization-bridge-schema/test/examples/benchmark-report-v0.2.json";

function publicFixtureInputs(): PublicBenchmarkHarnessFixtureInputs {
  const readModel = benchmarkSetReadModelFromSeedsFixture(readRepoJson(SEEDS_FIXTURE_PATH));
  return {
    benchmarkSetReadModel: readModel,
    benchmarkSetSelectionInput: benchmarkSetSelectionInputFromSetsFixture(
      readRepoJson(SETS_FIXTURE_PATH),
      readModel.targetLanguage,
    ),
    benchmarkReport: readRepoJson(REPORT_FIXTURE_PATH),
  };
}

function memoryIo(): {
  writes: Map<string, unknown>;
  writeJson(path: string, value: unknown): void;
} {
  const writes = new Map<string, unknown>();
  return { writes, writeJson: (path, value) => writes.set(path, value) };
}

function runArgs(stages: BenchmarkHarnessStage[], io: { writeJson(p: string, v: unknown): void }) {
  return {
    benchmarkRunId: "019ed026-0000-7000-8000-000000000001",
    benchmarkName: "itotori-026 benchmark harness regression",
    generatedAt: "2026-06-26T00:00:00.000Z",
    outputDir: "artifacts/test/benchmark-harness",
    stages,
    io,
  };
}

function throwingStage(stageId: BenchmarkHarnessStageId): BenchmarkHarnessStage {
  return {
    stageId,
    run: async () => {
      throw new Error(`injected failure in stage '${stageId}'`);
    },
  };
}

/** Real public stages with exactly one stage swapped for a thrower. */
function stagesWithInjectedFailure(failAt: BenchmarkHarnessStageId): BenchmarkHarnessStage[] {
  return buildPublicBenchmarkHarnessStages(publicFixtureInputs()).map((stage) =>
    stage.stageId === failAt ? throwingStage(failAt) : stage,
  );
}

describe("benchmark harness — public fixture composition", () => {
  it("wires all five stages and names every generated report", async () => {
    const io = memoryIo();
    const stages = buildPublicBenchmarkHarnessStages(publicFixtureInputs());
    const manifest = await runBenchmarkHarnessCommand(runArgs(stages, io));

    assertBenchmarkHarnessRunManifest(manifest);
    expect(manifest.schemaVersion).toBe(BENCHMARK_HARNESS_RUN_MANIFEST_SCHEMA_VERSION);
    expect(manifest.status).toBe("succeeded");
    expect(manifest.failedStageId).toBeNull();

    // Every pipeline position ran and succeeded, in order.
    expect(manifest.stages.map((stage) => stage.stageId)).toEqual([
      ...BENCHMARK_HARNESS_STAGE_ORDER,
    ]);
    expect(manifest.stages.every((stage) => stage.status === "succeeded")).toBe(true);

    // The run manifest NAMES all five generated reports by path + hash.
    expect(manifest.generatedReports).toHaveLength(BENCHMARK_HARNESS_STAGE_ORDER.length);
    for (const stageId of BENCHMARK_HARNESS_STAGE_ORDER) {
      const named = manifest.generatedReports.find((report) => report.stageId === stageId);
      expect(named).toBeDefined();
      expect(named?.artifactPath).toBe(`artifacts/test/benchmark-harness/${stageId}.json`);
      expect(named?.artifactHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
      // The named artifact path was actually written.
      expect(io.writes.has(named?.artifactPath ?? "")).toBe(true);
    }
    expect(io.writes.has("artifacts/test/benchmark-harness/run-manifest.json")).toBe(true);
  });

  it("consumes the ITOTORI-089 benchmark set manifest and records its id", async () => {
    const io = memoryIo();
    const inputs = publicFixtureInputs();
    const manifest = await runBenchmarkHarnessCommand(
      runArgs(buildPublicBenchmarkHarnessStages(inputs), io),
    );
    expect(manifest.benchmarkSetManifestId).toMatch(/^benchmark-set-sha256-[a-f0-9]{16}$/u);
    // The named benchmark-set report is the same manifest the harness consumed.
    const selectionArtifact = io.writes.get(
      "artifacts/test/benchmark-harness/benchmark-set-selection.json",
    ) as { manifestId: string };
    expect(selectionArtifact.manifestId).toBe(manifest.benchmarkSetManifestId);
  });

  it("sources the cost summary from the composed report's validated ledger (no hardcoded cost)", async () => {
    const io = memoryIo();
    const report = readRepoJson(REPORT_FIXTURE_PATH) as {
      costLedger: { reportTotalMicrosUsd: number; totalsBySystem: { totalMicrosUsd: number }[] };
      providerModelCostRecords: { cost: { amountMicrosUsd?: number; costKind: string } }[];
    };
    const manifest = await runBenchmarkHarnessCommand(
      runArgs(buildPublicBenchmarkHarnessStages(publicFixtureInputs()), io),
    );

    expect(manifest.costSummary).not.toBeNull();
    // The run total equals the composed report's ledger total ...
    expect(manifest.costSummary?.reportTotalMicrosUsd).toBe(report.costLedger.reportTotalMicrosUsd);
    // ... which itself equals the sum of the real provider-run cost records
    // (assertBenchmarkReportV02 recomputes & enforces this — cost flows from
    // the composed artifact rather than from a literal).
    const summedProviderCost = report.providerModelCostRecords.reduce(
      (total, providerRun) =>
        providerRun.cost.costKind === "unknown"
          ? total
          : total + (providerRun.cost.amountMicrosUsd ?? 0),
      0,
    );
    expect(manifest.costSummary?.reportTotalMicrosUsd).toBe(summedProviderCost);
    expect(manifest.costSummary?.currency).toBe("USD");
  });
});

describe("benchmark harness — failure propagation", () => {
  for (const failAt of BENCHMARK_HARNESS_STAGE_ORDER) {
    it(`keeps stage '${failAt}' visible as failed and short-circuits the rest`, async () => {
      const io = memoryIo();
      const manifest = await runBenchmarkHarnessCommand(
        runArgs(stagesWithInjectedFailure(failAt), io),
      );

      // The command still RETURNS a manifest — failure is reported, not thrown away.
      expect(manifest.status).toBe("failed");
      expect(manifest.failedStageId).toBe(failAt);

      const failIndex = BENCHMARK_HARNESS_STAGE_ORDER.indexOf(failAt);
      for (const [index, stageId] of BENCHMARK_HARNESS_STAGE_ORDER.entries()) {
        const record = manifest.stages.find((stage) => stage.stageId === stageId);
        expect(record).toBeDefined();
        if (index < failIndex) {
          // Earlier stages stay succeeded and their reports stay named.
          expect(record?.status).toBe("succeeded");
          expect(manifest.generatedReports.some((report) => report.stageId === stageId)).toBe(true);
        } else if (index === failIndex) {
          // The failed stage is VISIBLE with a structured failure.
          expect(record?.status).toBe("failed");
          if (record?.status === "failed") {
            expect(record.failure.stageId).toBe(failAt);
            expect(record.failure.message).toContain(failAt);
          }
          // A failed stage emits no named report.
          expect(manifest.generatedReports.some((report) => report.stageId === stageId)).toBe(
            false,
          );
        } else {
          // Downstream stages are skipped — but RECORDED, never dropped.
          expect(record?.status).toBe("skipped_upstream_failed");
          if (record?.status === "skipped_upstream_failed") {
            expect(record.blockedByStageId).toBe(failAt);
          }
          expect(manifest.generatedReports.some((report) => report.stageId === stageId)).toBe(
            false,
          );
        }
      }
      // The run manifest is still written so the failure is auditable.
      expect(io.writes.has("artifacts/test/benchmark-harness/run-manifest.json")).toBe(true);
      // No cost summary when the cost-quality renderer never ran.
      if (failIndex <= BENCHMARK_HARNESS_STAGE_ORDER.indexOf("cost-quality-report")) {
        expect(manifest.costSummary).toBeNull();
      }
    });
  }

  it("propagates a cost-quality renderer failure when the ledger is tampered (cost cannot be faked)", async () => {
    const io = memoryIo();
    const inputs = publicFixtureInputs();
    const tamperedReport = structuredClone(inputs.benchmarkReport) as {
      costLedger: { reportTotalMicrosUsd: number };
    };
    // Break the ledger total so it no longer matches the provider-run costs.
    tamperedReport.costLedger.reportTotalMicrosUsd =
      tamperedReport.costLedger.reportTotalMicrosUsd + 1;
    const stages = buildPublicBenchmarkHarnessStages({
      ...inputs,
      benchmarkReport: tamperedReport,
    });

    const manifest = await runBenchmarkHarnessCommand(runArgs(stages, io));
    expect(manifest.status).toBe("failed");
    expect(manifest.failedStageId).toBe("cost-quality-report");
    expect(manifest.costSummary).toBeNull();
    const record = manifest.stages.find((stage) => stage.stageId === "cost-quality-report");
    expect(record?.status).toBe("failed");
  });

  it("fails the qa-agent-evaluation stage when the composed report names no evaluations", async () => {
    const io = memoryIo();
    const inputs = publicFixtureInputs();
    const report = structuredClone(inputs.benchmarkReport) as { qaAgentEvaluations: unknown[] };
    report.qaAgentEvaluations = [];
    const stages = buildPublicBenchmarkHarnessStages({ ...inputs, benchmarkReport: report });

    let missingError: unknown;
    const probeStages = stages.map((stage) =>
      stage.stageId === "qa-agent-evaluation"
        ? {
            stageId: stage.stageId,
            run: async (context: Parameters<typeof stage.run>[0]) => {
              try {
                return await stage.run(context);
              } catch (error) {
                missingError = error;
                throw error;
              }
            },
          }
        : stage,
    );
    const manifest = await runBenchmarkHarnessCommand(runArgs(probeStages, io));
    expect(manifest.failedStageId).toBe("qa-agent-evaluation");
    expect(missingError).toBeInstanceOf(BenchmarkHarnessMissingCompositionError);
  });

  it("refuses to run with a missing pipeline stage (configuration error)", async () => {
    const io = memoryIo();
    const stages = buildPublicBenchmarkHarnessStages(publicFixtureInputs()).filter(
      (stage) => stage.stageId !== "deterministic-qa",
    );
    await expect(runBenchmarkHarnessCommand(runArgs(stages, io))).rejects.toBeInstanceOf(
      BenchmarkHarnessStageConfigurationError,
    );
  });
});

describe("benchmark harness — CLI dispatch", () => {
  function cliDependencies(io: {
    readJson(p: string): unknown;
    writeJson(p: string, v: unknown): void;
  }) {
    return {
      io,
      migrateDatabase: async () => {},
      withServices: async <T>(
        _callback: (services: ItotoriCliServices) => Promise<T>,
      ): Promise<T> => {
        throw new Error("benchmark-harness-run must not require database services");
      },
    };
  }

  it("runs the public-fixture benchmark-harness-run command and writes a succeeded manifest", async () => {
    const writes = new Map<string, unknown>();
    const io = {
      readJson: (path: string) => readRepoJson(path),
      writeJson: (path: string, value: unknown) => writes.set(path, value),
    };
    await runItotoriCliCommand(
      ["benchmark-harness-run", "--output-dir", "artifacts/test/cli-benchmark-harness"],
      cliDependencies(io),
    );
    const manifest = writes.get("artifacts/test/cli-benchmark-harness/run-manifest.json");
    assertBenchmarkHarnessRunManifest(manifest);
    expect(manifest.status).toBe("succeeded");
    expect(manifest.generatedReports).toHaveLength(BENCHMARK_HARNESS_STAGE_ORDER.length);
  });

  it("escalates a failed pipeline to a thrown error (failure stays visible at the process level)", async () => {
    const writes = new Map<string, unknown>();
    const io = {
      // Serve a report with no raw_mtl_baseline system so the second stage fails.
      readJson: (path: string) => {
        if (path.includes("benchmark-report")) {
          const report = structuredClone(readRepoJson(REPORT_FIXTURE_PATH)) as {
            systemsCompared: { systemKind: string }[];
          };
          report.systemsCompared = report.systemsCompared.filter(
            (system) => system.systemKind !== "raw_mtl_baseline",
          );
          return report;
        }
        return readRepoJson(path);
      },
      writeJson: (path: string, value: unknown) => writes.set(path, value),
    };
    await expect(
      runItotoriCliCommand(
        ["benchmark-harness-run", "--output-dir", "artifacts/test/cli-benchmark-harness-fail"],
        cliDependencies(io),
      ),
    ).rejects.toThrow(/benchmark-harness run failed at stage 'raw-mtl-baseline'/u);
    // The manifest was still written before the escalation — failure is auditable.
    const manifest = writes.get("artifacts/test/cli-benchmark-harness-fail/run-manifest.json");
    assertBenchmarkHarnessRunManifest(manifest);
    expect(manifest.status).toBe("failed");
  });
});
