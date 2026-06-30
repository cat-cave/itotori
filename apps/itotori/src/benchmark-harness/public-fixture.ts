// ITOTORI-026 — Public, deterministic cost-and-quality composition
// fixture for the benchmark harness.
//
// Builds the five pipeline stages from PUBLIC fixture inputs only — no
// private-local corpora, no live provider credentials. Each stage's
// `run()` COMPOSES an existing prerequisite output:
//
//   benchmark-set-selection : `selectBenchmarkSet` (ITOTORI-089) over the
//                             public catalog-benchmark-seeds read model.
//   raw-mtl-baseline        : the `raw_mtl_baseline` compared system(s) +
//                             their provider-run cost records, extracted
//                             from the composed cost/quality report.
//   deterministic-qa        : the report's `deterministicQaResults`.
//   qa-agent-evaluation     : the report's `qaAgentEvaluations`.
//   cost-quality-report     : `assertBenchmarkReportV02` (the renderer /
//                             validator that recomputes the cost ledger
//                             from the real provider-run cost records),
//                             handing the validated ledger up as the run
//                             cost summary.
//
// The harness fabricates no cost: the cost summary is sourced from the
// composed report's validated `costLedger`. A stage throws when its named
// prerequisite output is missing/invalid, which the orchestrator records
// as a visible failed stage (failure propagation).

import type { CatalogBenchmarkSeedFinderReadModel } from "@itotori/db";
import { assertBenchmarkReportV02 } from "@itotori/localization-bridge-schema";
import {
  assertBenchmarkSetManifest,
  assertBenchmarkSetManifestPublicSafe,
  selectBenchmarkSet,
  type BenchmarkSetCapabilityFilters,
  type BenchmarkSetRunParameters,
  type BenchmarkSetSelectionInput,
} from "../benchmark-set/index.js";
import type {
  BenchmarkHarnessCostSummary,
  BenchmarkHarnessStage,
  BenchmarkHarnessStageId,
} from "./run-command.js";

export const DEFAULT_PUBLIC_BENCHMARK_SEEDS_FIXTURE_PATH =
  "fixtures/catalog-benchmark-seeds/fixture.json";
export const DEFAULT_PUBLIC_BENCHMARK_SETS_FIXTURE_PATH =
  "fixtures/catalog-benchmark-sets/fixture.json";
export const DEFAULT_PUBLIC_BENCHMARK_REPORT_FIXTURE_PATH =
  "packages/localization-bridge-schema/test/examples/benchmark-report-v0.2.json";

/**
 * Thrown when a stage cannot find the prerequisite output it is meant to
 * COMPOSE (e.g. a report carrying zero `qaAgentEvaluations`). Surfaces as
 * a visible failed stage rather than an empty/skipped one.
 */
export class BenchmarkHarnessMissingCompositionError extends Error {
  constructor(
    readonly stageId: BenchmarkHarnessStageId,
    detail: string,
  ) {
    super(`benchmark-harness stage '${stageId}' refused: ${detail}`);
    this.name = "BenchmarkHarnessMissingCompositionError";
  }
}

export type PublicBenchmarkHarnessFixtureInputs = {
  /** Public read model for ITOTORI-089 benchmark set selection. */
  benchmarkSetReadModel: CatalogBenchmarkSeedFinderReadModel;
  /** Selection parameters fed to `selectBenchmarkSet`. */
  benchmarkSetSelectionInput: BenchmarkSetSelectionInput;
  /**
   * The composed cost/quality report (a `BenchmarkReportV02`). Passed as
   * `unknown` so the cost-quality-report stage is the authority that runs
   * the schema validator on it — stages never trust the shape blindly.
   */
  benchmarkReport: unknown;
};

/**
 * Build the five composing stages. Pure: all fixture I/O happens in the
 * caller, so the regression suite can drive the same builder with crafted
 * inputs to exercise each stage's failure path.
 */
export function buildPublicBenchmarkHarnessStages(
  inputs: PublicBenchmarkHarnessFixtureInputs,
): BenchmarkHarnessStage[] {
  return [
    benchmarkSetSelectionStage(inputs),
    rawMtlBaselineStage(inputs),
    deterministicQaStage(inputs),
    qaAgentEvaluationStage(inputs),
    costQualityReportStage(inputs),
  ];
}

function benchmarkSetSelectionStage(
  inputs: PublicBenchmarkHarnessFixtureInputs,
): BenchmarkHarnessStage {
  return {
    stageId: "benchmark-set-selection",
    run: async () => {
      const manifest = selectBenchmarkSet(
        inputs.benchmarkSetReadModel,
        inputs.benchmarkSetSelectionInput,
      );
      // Re-run the public-safety gate: the run manifest names this artifact
      // for downstream consumers, so it must carry no private/local detail.
      assertBenchmarkSetManifest(manifest);
      assertBenchmarkSetManifestPublicSafe(manifest);
      return {
        artifactKind: "benchmark-set-manifest",
        label: `Benchmark set ${manifest.manifestId}`,
        artifact: manifest,
        benchmarkSetManifestId: manifest.manifestId,
      };
    },
  };
}

function rawMtlBaselineStage(inputs: PublicBenchmarkHarnessFixtureInputs): BenchmarkHarnessStage {
  return {
    stageId: "raw-mtl-baseline",
    run: async () => {
      const report = asRecord(inputs.benchmarkReport, "benchmarkReport");
      const systems = asArray(report.systemsCompared, "benchmarkReport.systemsCompared");
      const baselineSystems = systems.filter(
        (system) => asRecord(system, "system").systemKind === "raw_mtl_baseline",
      );
      if (baselineSystems.length === 0) {
        throw new BenchmarkHarnessMissingCompositionError(
          "raw-mtl-baseline",
          "composed report has no compared system with systemKind 'raw_mtl_baseline'",
        );
      }
      const baselineSystemIds = new Set(
        baselineSystems.map((system) => asRecord(system, "system").systemId),
      );
      const providerRuns = asArray(
        report.providerModelCostRecords,
        "benchmarkReport.providerModelCostRecords",
      ).filter((run) => baselineSystemIds.has(asRecord(run, "providerRun").systemId));
      return {
        artifactKind: "raw-mtl-baseline-report",
        label: "Raw MTL baseline compared systems",
        artifact: { systems: baselineSystems, providerRuns },
      };
    },
  };
}

function deterministicQaStage(inputs: PublicBenchmarkHarnessFixtureInputs): BenchmarkHarnessStage {
  return {
    stageId: "deterministic-qa",
    run: async () => {
      const report = asRecord(inputs.benchmarkReport, "benchmarkReport");
      const results = asArray(
        report.deterministicQaResults,
        "benchmarkReport.deterministicQaResults",
      );
      if (results.length === 0) {
        throw new BenchmarkHarnessMissingCompositionError(
          "deterministic-qa",
          "composed report carries zero deterministicQaResults",
        );
      }
      return {
        artifactKind: "deterministic-qa-report",
        label: "Deterministic QA results",
        artifact: { deterministicQaResults: results },
      };
    },
  };
}

function qaAgentEvaluationStage(
  inputs: PublicBenchmarkHarnessFixtureInputs,
): BenchmarkHarnessStage {
  return {
    stageId: "qa-agent-evaluation",
    run: async () => {
      const report = asRecord(inputs.benchmarkReport, "benchmarkReport");
      const evaluations = asArray(report.qaAgentEvaluations, "benchmarkReport.qaAgentEvaluations");
      if (evaluations.length === 0) {
        throw new BenchmarkHarnessMissingCompositionError(
          "qa-agent-evaluation",
          "composed report carries zero qaAgentEvaluations",
        );
      }
      return {
        artifactKind: "qa-agent-evaluation-report",
        label: "QA-agent evaluations",
        artifact: { qaAgentEvaluations: evaluations },
      };
    },
  };
}

function costQualityReportStage(
  inputs: PublicBenchmarkHarnessFixtureInputs,
): BenchmarkHarnessStage {
  return {
    stageId: "cost-quality-report",
    run: async () => {
      const report = inputs.benchmarkReport;
      // The renderer/validator: recomputes the cost ledger from the real
      // provider-run cost records and rejects a tampered/inconsistent
      // ledger. A throw here is a visible cost-quality-renderer failure.
      assertBenchmarkReportV02(report);
      const ledger = report.costLedger;
      const costSummary: BenchmarkHarnessCostSummary = {
        currency: "USD",
        reportTotalMicrosUsd: ledger.reportTotalMicrosUsd,
        includesUnknownCost: ledger.includesUnknownCost,
        totalsBySystem: ledger.totalsBySystem.map((total) => ({
          systemId: total.systemId,
          totalMicrosUsd: total.totalMicrosUsd,
        })),
      };
      return {
        artifactKind: "benchmark-report",
        label: report.benchmarkName,
        artifact: report,
        costSummary,
      };
    },
  };
}

/**
 * Project the public catalog-benchmark-seeds fixture into the read model
 * `selectBenchmarkSet` consumes. The fixture stores it under
 * `expectedDefaultReadModel`.
 */
export function benchmarkSetReadModelFromSeedsFixture(
  fixture: unknown,
): CatalogBenchmarkSeedFinderReadModel {
  const record = asRecord(fixture, "catalog-benchmark-seeds fixture");
  return asRecord(
    record.expectedDefaultReadModel,
    "catalog-benchmark-seeds fixture.expectedDefaultReadModel",
  ) as unknown as CatalogBenchmarkSeedFinderReadModel;
}

/**
 * Project the public catalog-benchmark-sets fixture into a selection
 * input. Uses the fixture's first case's capability filters so the public
 * run is fully determined by checked-in fixtures.
 */
export function benchmarkSetSelectionInputFromSetsFixture(
  fixture: unknown,
  targetLocale: string,
): BenchmarkSetSelectionInput {
  const record = asRecord(fixture, "catalog-benchmark-sets fixture");
  const cases = asArray(record.cases, "catalog-benchmark-sets fixture.cases");
  const firstCase = asRecord(cases[0], "catalog-benchmark-sets fixture.cases[0]");
  return {
    targetLocale,
    selectedAt: asString(record.selectedAt, "catalog-benchmark-sets fixture.selectedAt"),
    sourceFixtureIds: asStringArray(
      record.sourceFixtureIds,
      "catalog-benchmark-sets fixture.sourceFixtureIds",
    ),
    runParameters: record.runParameters as BenchmarkSetRunParameters,
    capabilityFilters: firstCase.capabilityFilters as Partial<BenchmarkSetCapabilityFilters>,
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function asStringArray(value: unknown, label: string): string[] {
  return asArray(value, label).map((entry, index) => asString(entry, `${label}[${index}]`));
}
