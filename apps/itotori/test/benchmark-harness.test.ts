// ITOTORI-026 — Benchmark harness integration regression suite.
//
// Proves the composition command (a) wires the five prerequisite subsystems —
// the REAL stage implementations (ITOTORI-090/091/092) — into ONE run that
// names every generated report, (b) sources the cost summary from the report's
// recomputed cost ledger (no hardcoded cost), and (c) propagates a per-stage
// failure as a VISIBLE failed stage that short-circuits the rest of the
// pipeline.

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
  loadBenchmarkStagesFixture,
  runBenchmarkHarnessCommand,
  type BenchmarkHarnessStage,
  type BenchmarkHarnessStageId,
  type BenchmarkStagesPublicFixture,
  type PublicBenchmarkHarnessFixtureInputs,
} from "../src/benchmark-harness/index.js";
import { runItotoriCliCommand, type ItotoriCliServices } from "../src/cli-handlers.js";

const repoRoot = new URL("../../../", import.meta.url);

function readRepoJson(repoRelativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(repoRelativePath, repoRoot), "utf8"));
}

const SEEDS_FIXTURE_PATH = "fixtures/catalog-benchmark-seeds/fixture.json";
const SETS_FIXTURE_PATH = "fixtures/catalog-benchmark-sets/fixture.json";
const STAGES_FIXTURE_PATH = "fixtures/benchmark-stages/public-fixture.json";

function stagesFixture(): BenchmarkStagesPublicFixture {
  return loadBenchmarkStagesFixture(readRepoJson(STAGES_FIXTURE_PATH));
}

function publicFixtureInputs(
  overrides?: Partial<BenchmarkStagesPublicFixture>,
): PublicBenchmarkHarnessFixtureInputs {
  const readModel = benchmarkSetReadModelFromSeedsFixture(readRepoJson(SEEDS_FIXTURE_PATH));
  return {
    benchmarkSetReadModel: readModel,
    benchmarkSetSelectionInput: benchmarkSetSelectionInputFromSetsFixture(
      readRepoJson(SETS_FIXTURE_PATH),
      readModel.targetLanguage,
    ),
    stagesFixture: { ...stagesFixture(), ...overrides },
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

/** Independent sum of the recorded provider-run costs (the ground truth). */
function summedRecordedCostMicros(fixture: BenchmarkStagesPublicFixture): number {
  let total = 0;
  for (const system of fixture.recordedSystems) {
    if (system.providerRun.cost.costKind !== "unknown") {
      total += system.providerRun.cost.amountMicrosUsd ?? 0;
    }
  }
  for (const agent of fixture.qaAgents) {
    if (agent.providerRun.cost.costKind !== "unknown") {
      total += agent.providerRun.cost.amountMicrosUsd ?? 0;
    }
  }
  return total;
}

describe("benchmark harness — public fixture composition", () => {
  it("wires all five real stages and names every generated report", async () => {
    const io = memoryIo();
    const stages = buildPublicBenchmarkHarnessStages(publicFixtureInputs());
    const manifest = await runBenchmarkHarnessCommand(runArgs(stages, io));

    assertBenchmarkHarnessRunManifest(manifest);
    expect(manifest.schemaVersion).toBe(BENCHMARK_HARNESS_RUN_MANIFEST_SCHEMA_VERSION);
    expect(manifest.status).toBe("succeeded");
    expect(manifest.failedStageId).toBeNull();

    expect(manifest.stages.map((stage) => stage.stageId)).toEqual([
      ...BENCHMARK_HARNESS_STAGE_ORDER,
    ]);
    expect(manifest.stages.every((stage) => stage.status === "succeeded")).toBe(true);

    expect(manifest.generatedReports).toHaveLength(BENCHMARK_HARNESS_STAGE_ORDER.length);
    for (const stageId of BENCHMARK_HARNESS_STAGE_ORDER) {
      const named = manifest.generatedReports.find((report) => report.stageId === stageId);
      expect(named).toBeDefined();
      expect(named?.artifactPath).toBe(`artifacts/test/benchmark-harness/${stageId}.json`);
      expect(named?.artifactHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(io.writes.has(named?.artifactPath ?? "")).toBe(true);
    }
    expect(io.writes.has("artifacts/test/benchmark-harness/run-manifest.json")).toBe(true);
  });

  it("consumes the ITOTORI-089 benchmark set manifest and records its id", async () => {
    const io = memoryIo();
    const manifest = await runBenchmarkHarnessCommand(
      runArgs(buildPublicBenchmarkHarnessStages(publicFixtureInputs()), io),
    );
    expect(manifest.benchmarkSetManifestId).toMatch(/^benchmark-set-sha256-[a-f0-9]{16}$/u);
    const selectionArtifact = io.writes.get(
      "artifacts/test/benchmark-harness/benchmark-set-selection.json",
    ) as { manifestId: string };
    expect(selectionArtifact.manifestId).toBe(manifest.benchmarkSetManifestId);
  });

  it("sources the cost summary from the report's recomputed ledger (no hardcoded cost)", async () => {
    const io = memoryIo();
    const fixture = stagesFixture();
    const manifest = await runBenchmarkHarnessCommand(
      runArgs(buildPublicBenchmarkHarnessStages(publicFixtureInputs()), io),
    );

    expect(manifest.costSummary).not.toBeNull();
    // The run total equals the sum of the REAL recorded provider-run costs:
    // assembleBenchmarkReport recomputes the ledger from those records and
    // assertBenchmarkReportV02 enforces the equality — cost flows from the
    // artifacts, never from a literal.
    expect(manifest.costSummary?.reportTotalMicrosUsd).toBe(summedRecordedCostMicros(fixture));
    expect(manifest.costSummary?.currency).toBe("USD");
    // The cost-quality artifact embeds the validated report carrying that ledger.
    const costArtifact = io.writes.get(
      "artifacts/test/benchmark-harness/cost-quality-report.json",
    ) as { report: { costLedger: { reportTotalMicrosUsd: number } } };
    expect(costArtifact.report.costLedger.reportTotalMicrosUsd).toBe(
      manifest.costSummary?.reportTotalMicrosUsd,
    );
  });

  it("computes QA-agent precision/recall and renders the QA-accuracy section", async () => {
    const io = memoryIo();
    await runBenchmarkHarnessCommand(
      runArgs(buildPublicBenchmarkHarnessStages(publicFixtureInputs()), io),
    );
    const costArtifact = io.writes.get(
      "artifacts/test/benchmark-harness/cost-quality-report.json",
    ) as {
      rendered: {
        qaAccuracy: { agents: Array<{ seededPrecision: number; seededRecall: number }> };
      };
    };
    const agent = costArtifact.rendered.qaAccuracy.agents[0];
    expect(agent?.seededPrecision).toBe(1);
    expect(agent?.seededRecall).toBe(1);
  });
});

describe("benchmark harness — failure propagation", () => {
  for (const failAt of BENCHMARK_HARNESS_STAGE_ORDER) {
    it(`keeps stage '${failAt}' visible as failed and short-circuits the rest`, async () => {
      const io = memoryIo();
      const manifest = await runBenchmarkHarnessCommand(
        runArgs(stagesWithInjectedFailure(failAt), io),
      );

      expect(manifest.status).toBe("failed");
      expect(manifest.failedStageId).toBe(failAt);

      const failIndex = BENCHMARK_HARNESS_STAGE_ORDER.indexOf(failAt);
      for (const [index, stageId] of BENCHMARK_HARNESS_STAGE_ORDER.entries()) {
        const record = manifest.stages.find((stage) => stage.stageId === stageId);
        expect(record).toBeDefined();
        if (index < failIndex) {
          expect(record?.status).toBe("succeeded");
          expect(manifest.generatedReports.some((report) => report.stageId === stageId)).toBe(true);
        } else if (index === failIndex) {
          expect(record?.status).toBe("failed");
          if (record?.status === "failed") {
            expect(record.failure.stageId).toBe(failAt);
            expect(record.failure.message).toContain(failAt);
          }
          expect(manifest.generatedReports.some((report) => report.stageId === stageId)).toBe(
            false,
          );
        } else {
          expect(record?.status).toBe("skipped_upstream_failed");
          if (record?.status === "skipped_upstream_failed") {
            expect(record.blockedByStageId).toBe(failAt);
          }
          expect(manifest.generatedReports.some((report) => report.stageId === stageId)).toBe(
            false,
          );
        }
      }
      expect(io.writes.has("artifacts/test/benchmark-harness/run-manifest.json")).toBe(true);
      if (failIndex <= BENCHMARK_HARNESS_STAGE_ORDER.indexOf("cost-quality-report")) {
        expect(manifest.costSummary).toBeNull();
      }
    });
  }

  it("fails the raw-mtl-baseline stage when no raw_mtl_baseline system is recorded", async () => {
    const io = memoryIo();
    const fixture = stagesFixture();
    const inputs = publicFixtureInputs({
      recordedSystems: fixture.recordedSystems.filter(
        (system) => system.systemKind !== "raw_mtl_baseline",
      ),
    });
    const manifest = await runBenchmarkHarnessCommand(
      runArgs(buildPublicBenchmarkHarnessStages(inputs), io),
    );
    expect(manifest.failedStageId).toBe("raw-mtl-baseline");
    const record = manifest.stages.find((stage) => stage.stageId === "raw-mtl-baseline");
    expect(record?.status).toBe("failed");
    if (record?.status === "failed") {
      expect(record.failure.message).toContain("raw_mtl_baseline");
    }
  });

  it("propagates a cost-quality renderer failure when a provider cost record is malformed (cost cannot be faked)", async () => {
    const io = memoryIo();
    const fixture = structuredClone(stagesFixture());
    // A non-integer micros amount cannot pass the schema's cost-record check;
    // the renderer's assertBenchmarkReportV02 rejects it. A faked cost cannot
    // be smuggled past the recompute.
    fixture.recordedSystems[1].providerRun.cost.amountMicrosUsd = 1570.5;
    const inputs: PublicBenchmarkHarnessFixtureInputs = {
      ...publicFixtureInputs(),
      stagesFixture: fixture,
    };
    const manifest = await runBenchmarkHarnessCommand(
      runArgs(buildPublicBenchmarkHarnessStages(inputs), io),
    );
    expect(manifest.status).toBe("failed");
    expect(manifest.failedStageId).toBe("cost-quality-report");
    expect(manifest.costSummary).toBeNull();
    const record = manifest.stages.find((stage) => stage.stageId === "cost-quality-report");
    expect(record?.status).toBe("failed");
  });

  it("fails the qa-agent-evaluation stage when the fixture names no QA agents", async () => {
    const io = memoryIo();
    const inputs = publicFixtureInputs({ qaAgents: [] });
    const stages = buildPublicBenchmarkHarnessStages(inputs);

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
      // Serve a stages fixture with no raw_mtl_baseline system so the second
      // stage fails.
      readJson: (path: string) => {
        if (path.includes("benchmark-stages")) {
          const fixture = structuredClone(readRepoJson(STAGES_FIXTURE_PATH)) as {
            recordedSystems: { systemKind: string }[];
          };
          fixture.recordedSystems = fixture.recordedSystems.filter(
            (system) => system.systemKind !== "raw_mtl_baseline",
          );
          return fixture;
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
    const manifest = writes.get("artifacts/test/cli-benchmark-harness-fail/run-manifest.json");
    assertBenchmarkHarnessRunManifest(manifest);
    expect(manifest.status).toBe("failed");
  });
});
