// ITOTORI-026 — Public, deterministic composition fixture for the benchmark
// harness.
//
// Builds the five pipeline stages from PUBLIC fixture inputs only — no
// private-local corpora, no live provider credentials. Each stage's `run()`
// COMPOSES a REAL benchmark stage implementation (ITOTORI-090/091/092); the
// harness owns no scoring, routing, or rendering of its own:
//
//   benchmark-set-selection : `selectBenchmarkSet` (ITOTORI-089) over the
//                             public catalog-benchmark-seeds read model.
//   raw-mtl-baseline        : `runRawMtlBaselineStage` (ITOTORI-090) over the
//                             selected manifest's target locale + recorded MTL
//                             outputs.
//   deterministic-qa        : `runDeterministicQaStage` (ITOTORI-090) over the
//                             baseline outputs from the upstream stage.
//   qa-agent-evaluation     : `evaluateQaAgents` (ITOTORI-091) over recorded
//                             QA-agent findings + the seeded-defect oracle.
//   cost-quality-report     : `assembleBenchmarkReport` + `renderBenchmarkReports`
//                             (ITOTORI-092) — `assembleBenchmarkReport` composes
//                             `assertBenchmarkReportV02`, which recomputes the
//                             cost ledger from the real provider-run cost
//                             records and rejects a tampered/inconsistent one.
//
// The harness fabricates no cost: the run cost summary is SOURCED from the
// validated report's recomputed `costLedger`. A stage throws when its named
// prerequisite output is missing/invalid, which the orchestrator records as a
// visible failed stage (failure propagation).
//
// Report-shape validation is NOT deferred to the final cost-quality stage: each
// intermediate stage validates the report SLICE it produces (compared
// systems + provider-run cost records, deterministic-QA results, QA-agent
// evaluations) against the v0.2 schema at its ORIGIN via `assertReportSlice`.
// A malformed slice therefore fails at the stage that emitted it — with an
// error naming exactly where — rather than being carried downstream and only
// rejected by `assertBenchmarkReportV02` at the final stage. The final stage
// still owns the whole-report, cross-slice checks (cost-ledger recompute,
// referential integrity); the per-slice checks add no duplicate recompute.

import type { CatalogBenchmarkSeedFinderReadModel } from "@itotori/db";
import {
  assertBenchmarkComparedSystemV02,
  assertBenchmarkProviderRunV02,
  assertDeterministicQaResultV02,
  assertQaAgentEvaluationV02,
} from "@itotori/localization-bridge-schema";
import {
  assembleBenchmarkReport,
  evaluateQaAgents,
  renderBenchmarkReports,
  runDeterministicQaStage,
  runRawMtlBaselineStage,
  type BenchmarkStagesPublicFixture,
  type DeterministicQaResult,
  type QaAgentEvaluationResult,
  type RawMtlBaselineResult,
} from "../benchmark-stages/index.js";
import {
  assertBenchmarkSetManifest,
  assertBenchmarkSetManifestPublicSafe,
  selectBenchmarkSet,
  type BenchmarkSetCapabilityFilters,
  type BenchmarkSetManifest,
  type BenchmarkSetRunParameters,
  type BenchmarkSetSelectionInput,
} from "../benchmark-set/index.js";
import type {
  BenchmarkHarnessCostSummary,
  BenchmarkHarnessStage,
  BenchmarkHarnessStageContext,
  BenchmarkHarnessStageId,
  BenchmarkHarnessStageOutput,
} from "./run-command.js";

export const DEFAULT_PUBLIC_BENCHMARK_SEEDS_FIXTURE_PATH =
  "fixtures/catalog-benchmark-seeds/fixture.json";
export const DEFAULT_PUBLIC_BENCHMARK_SETS_FIXTURE_PATH =
  "fixtures/catalog-benchmark-sets/fixture.json";
export const DEFAULT_PUBLIC_BENCHMARK_STAGES_FIXTURE_PATH =
  "fixtures/benchmark-stages/public-fixture.json";

/**
 * Thrown when a stage cannot produce the composed output it is meant to emit
 * (e.g. a fixture carrying zero QA agents, so the QA-agent stage would yield
 * zero evaluations). Surfaces as a visible failed stage rather than an
 * empty/skipped one.
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
  /** Public ingredient fixture the real stages consume. */
  stagesFixture: BenchmarkStagesPublicFixture;
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
    deterministicQaStage(),
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
    run: async (context) => {
      const manifest = upstreamArtifact<BenchmarkSetManifest>(
        context,
        "benchmark-set-selection",
        "raw-mtl-baseline",
      );
      const result = runRawMtlBaselineStage({
        targetLocale: manifest.targetLocale,
        corpusTargetLocale: inputs.stagesFixture.corpusTargetLocale,
        corpus: inputs.stagesFixture.corpus,
        recordedSystems: inputs.stagesFixture.recordedSystems,
      });
      // Validate the report slice at its ORIGIN. The compared systems and
      // provider-run cost records this stage emits become `systemsCompared` /
      // `providerModelCostRecords` in the final BenchmarkReportV02; validating
      // them here makes a malformed slice fail at THIS stage rather than being
      // carried downstream and only surfacing at the final cost-quality stage.
      assertReportSlice(
        result.systems,
        "raw-mtl-baseline.systems",
        assertBenchmarkComparedSystemV02,
      );
      assertReportSlice(
        result.providerRuns,
        "raw-mtl-baseline.providerRuns",
        assertBenchmarkProviderRunV02,
      );
      return {
        artifactKind: "raw-mtl-baseline-report",
        label: "Raw MTL baseline compared systems",
        artifact: result,
      };
    },
  };
}

function deterministicQaStage(): BenchmarkHarnessStage {
  return {
    stageId: "deterministic-qa",
    run: async (context) => {
      const baseline = upstreamArtifact<RawMtlBaselineResult>(
        context,
        "raw-mtl-baseline",
        "deterministic-qa",
      );
      const result = runDeterministicQaStage({
        baselineOutputs: baseline.baselineOutputs,
        startedAt: "2026-06-28T12:01:05.000Z",
        completedAt: "2026-06-28T12:01:05.100Z",
      });
      // Validate the report slice at its ORIGIN: these results become
      // `deterministicQaResults` in the final report, so a malformed one must
      // fail HERE, not be deferred to the cost-quality stage.
      assertReportSlice(result.results, "deterministic-qa.results", assertDeterministicQaResultV02);
      return {
        artifactKind: "deterministic-qa-report",
        label: "Deterministic QA results",
        artifact: result,
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
      if (inputs.stagesFixture.qaAgents.length === 0) {
        throw new BenchmarkHarnessMissingCompositionError(
          "qa-agent-evaluation",
          "public fixture carries zero recorded QA agents to evaluate",
        );
      }
      const result = evaluateQaAgents({
        agents: inputs.stagesFixture.qaAgents,
        seededDefectOracle: inputs.stagesFixture.seededDefectOracle,
      });
      if (result.evaluations.length === 0) {
        throw new BenchmarkHarnessMissingCompositionError(
          "qa-agent-evaluation",
          "QA-agent evaluation produced zero evaluations",
        );
      }
      // Validate the report slice at its ORIGIN: these evaluations and their
      // provider-run cost records become `qaAgentEvaluations` /
      // `providerModelCostRecords` in the final report; a malformed one must
      // fail HERE, not be deferred to the cost-quality stage.
      assertReportSlice(
        result.evaluations,
        "qa-agent-evaluation.evaluations",
        assertQaAgentEvaluationV02,
      );
      assertReportSlice(
        result.providerRuns,
        "qa-agent-evaluation.providerRuns",
        assertBenchmarkProviderRunV02,
      );
      return {
        artifactKind: "qa-agent-evaluation-report",
        label: "QA-agent evaluations",
        artifact: result,
      };
    },
  };
}

function costQualityReportStage(
  inputs: PublicBenchmarkHarnessFixtureInputs,
): BenchmarkHarnessStage {
  return {
    stageId: "cost-quality-report",
    run: async (context) => {
      const rawMtl = upstreamArtifact<RawMtlBaselineResult>(
        context,
        "raw-mtl-baseline",
        "cost-quality-report",
      );
      const deterministicQa = upstreamArtifact<DeterministicQaResult>(
        context,
        "deterministic-qa",
        "cost-quality-report",
      );
      const qaAgent = upstreamArtifact<QaAgentEvaluationResult>(
        context,
        "qa-agent-evaluation",
        "cost-quality-report",
      );
      const meta = inputs.stagesFixture.reportMeta;
      // assembleBenchmarkReport COMPOSES assertBenchmarkReportV02 — it recomputes
      // the cost ledger from the real provider-run cost records and throws on any
      // inconsistency. A throw here is a visible cost-quality-renderer failure.
      const report = assembleBenchmarkReport({
        benchmarkRunId: context.benchmarkRunId,
        benchmarkName: meta.benchmarkName,
        createdAt: meta.createdAt,
        status: meta.status,
        sourceLocale: meta.sourceLocale,
        targetLocale: meta.targetLocale,
        localeBranchId: meta.localeBranchId,
        engineProfile: meta.engineProfile,
        gitCommit: meta.gitCommit,
        ...(meta.deterministicSeed !== undefined
          ? { deterministicSeed: meta.deterministicSeed }
          : {}),
        toolVersions: meta.toolVersions,
        commandLines: meta.commandLines,
        fixtureOrCorpusRefs: inputs.stagesFixture.fixtureOrCorpusRefs,
        rawMtl,
        deterministicQa,
        qaAgent,
        humanEvaluationResults: inputs.stagesFixture.humanEvaluationResults,
        knownBlindSpots: meta.knownBlindSpots,
      });
      const rendered = renderBenchmarkReports(report, qaAgent.calibration);
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
        artifact: { report, rendered },
        costSummary,
      };
    },
  };
}

/**
 * Assert every element of a report slice at its ORIGINATING stage, applying the
 * schema's per-element validator with an indexed label. This moves report-shape
 * validation forward from the final cost-quality stage (which composes
 * `assembleBenchmarkReport` → `assertBenchmarkReportV02`) to the stage that
 * produces the slice, so a malformed element fails EARLY with an error that
 * names exactly where it went wrong. The final-stage validation still owns the
 * cross-slice, whole-report checks (cost-ledger recompute, referential
 * integrity); this adds only cheap, deterministic per-element structural
 * validation at the source — no duplicate recompute.
 */
function assertReportSlice<T>(
  elements: readonly T[],
  label: string,
  assertElement: (value: unknown, label: string) => void,
): void {
  elements.forEach((element, index) => {
    assertElement(element, `${label}[${index}]`);
  });
}

function upstreamArtifact<T>(
  context: BenchmarkHarnessStageContext,
  fromStageId: BenchmarkHarnessStageId,
  stageId: BenchmarkHarnessStageId,
): T {
  const output: BenchmarkHarnessStageOutput | undefined = context.upstream.get(fromStageId);
  if (output === undefined) {
    throw new BenchmarkHarnessMissingCompositionError(
      stageId,
      `missing upstream '${fromStageId}' output to compose`,
    );
  }
  return output.artifact as T;
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
