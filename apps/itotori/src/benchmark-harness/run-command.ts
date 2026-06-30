// ITOTORI-026 — Benchmark harness integration.
//
// ONE command that WIRES (composes — does not reimplement) the five
// prerequisite benchmark subsystems into a single run that names the
// exact composed benchmark artifacts:
//
//   benchmark set selection  (ITOTORI-089 `selectBenchmarkSet`)
//     → raw MTL baseline      (the `raw_mtl_baseline` compared system +
//                              its provider-run cost records)
//     → deterministic QA      (`deterministicQaResults`)
//     → QA-agent evaluation   (`qaAgentEvaluations`)
//     → cost/quality report   (`assertBenchmarkReportV02` — the renderer/
//                              validator that recomputes the cost ledger
//                              from the real provider-run cost records).
//
// This module is the orchestration SHELL only. It owns NO scoring, NO
// provider routing, NO corpus selection, and NO report rendering of its
// own — every stage is an injected port (`BenchmarkHarnessStage`) whose
// `run()` composes an existing prerequisite output. The shell's sole
// jobs are:
//   1. run the stages in their fixed pipeline order,
//   2. persist each stage's generated report artifact,
//   3. surface a per-stage failure as a STRUCTURED, VISIBLE failed stage
//      and short-circuit the remaining stages as `skipped_upstream_failed`
//      (failure propagation — never swallowed, never silently skipped),
//   4. emit a run manifest that NAMES every generated report artifact and
//      carries the cost summary SOURCED from the composed report's
//      validated cost ledger (no hardcoded / approximated cost).

import { createHash } from "node:crypto";

export const BENCHMARK_HARNESS_RUN_MANIFEST_SCHEMA_VERSION =
  "itotori.benchmark_harness_run_manifest.v0.1" as const;

/**
 * The fixed pipeline order. The integration WIRES exactly these five
 * prerequisite subsystems; the order encodes the data-flow dependency
 * (selection feeds the baseline, the baseline + QA feed the report).
 */
export const BENCHMARK_HARNESS_STAGE_ORDER = [
  "benchmark-set-selection",
  "raw-mtl-baseline",
  "deterministic-qa",
  "qa-agent-evaluation",
  "cost-quality-report",
] as const;

export type BenchmarkHarnessStageId = (typeof BENCHMARK_HARNESS_STAGE_ORDER)[number];

export type BenchmarkHarnessCostTotalBySystem = {
  systemId: string;
  totalMicrosUsd: number;
};

/**
 * Run-level cost summary. SOURCED verbatim from the composed cost/quality
 * report's validated `costLedger` — the harness never fabricates a cost.
 */
export type BenchmarkHarnessCostSummary = {
  currency: "USD";
  reportTotalMicrosUsd: number;
  includesUnknownCost: boolean;
  totalsBySystem: BenchmarkHarnessCostTotalBySystem[];
};

/**
 * A generated report artifact, NAMED in the run manifest by its on-disk
 * path + content hash so a consumer can locate and verify exactly which
 * composed artifact each stage produced.
 */
export type BenchmarkHarnessNamedArtifact = {
  stageId: BenchmarkHarnessStageId;
  artifactKind: string;
  label: string;
  artifactPath: string;
  artifactHash: string;
};

export type BenchmarkHarnessStageFailure = {
  stageId: BenchmarkHarnessStageId;
  errorName: string;
  message: string;
};

export type BenchmarkHarnessStageRecord =
  | {
      stageId: BenchmarkHarnessStageId;
      status: "succeeded";
      artifact: BenchmarkHarnessNamedArtifact;
    }
  | {
      stageId: BenchmarkHarnessStageId;
      status: "failed";
      failure: BenchmarkHarnessStageFailure;
    }
  | {
      stageId: BenchmarkHarnessStageId;
      status: "skipped_upstream_failed";
      blockedByStageId: BenchmarkHarnessStageId;
    };

export type BenchmarkHarnessRunManifest = {
  schemaVersion: typeof BENCHMARK_HARNESS_RUN_MANIFEST_SCHEMA_VERSION;
  benchmarkRunId: string;
  benchmarkName: string;
  generatedAt: string;
  status: "succeeded" | "failed";
  benchmarkSetManifestId: string | null;
  failedStageId: BenchmarkHarnessStageId | null;
  stages: BenchmarkHarnessStageRecord[];
  generatedReports: BenchmarkHarnessNamedArtifact[];
  costSummary: BenchmarkHarnessCostSummary | null;
};

/**
 * What a stage emits on success. The orchestrator persists `artifact`
 * verbatim as the stage's generated report and NAMES it in the manifest.
 * `costSummary` / `benchmarkSetManifestId` are run-level facts a stage
 * COMPOSES from its prerequisite output and hands up to the manifest.
 */
export type BenchmarkHarnessStageOutput = {
  artifactKind: string;
  label: string;
  artifact: unknown;
  costSummary?: BenchmarkHarnessCostSummary;
  benchmarkSetManifestId?: string;
};

/**
 * Read-only view of upstream stage outputs, passed to each stage so a
 * later stage can COMPOSE an earlier stage's output (data-flow wiring).
 */
export type BenchmarkHarnessStageContext = {
  benchmarkRunId: string;
  upstream: ReadonlyMap<BenchmarkHarnessStageId, BenchmarkHarnessStageOutput>;
};

/**
 * A pipeline stage. `run` either returns the composed stage output or
 * THROWS — a throw is the failure-propagation signal the orchestrator
 * records as a visible failed stage. Stages must compose an existing
 * prerequisite output; the orchestrator deliberately gives them no way
 * to score, route, or render.
 */
export type BenchmarkHarnessStage = {
  stageId: BenchmarkHarnessStageId;
  run(context: BenchmarkHarnessStageContext): Promise<BenchmarkHarnessStageOutput>;
};

export type BenchmarkHarnessArtifactWriter = {
  writeJson(path: string, value: unknown): void;
};

export type BenchmarkHarnessCommandArgs = {
  benchmarkRunId: string;
  benchmarkName: string;
  generatedAt: string;
  /** Directory the per-stage reports + run manifest are written under. */
  outputDir: string;
  stages: BenchmarkHarnessStage[];
  io: BenchmarkHarnessArtifactWriter;
  log?: (message: string) => void;
};

export class BenchmarkHarnessStageConfigurationError extends Error {
  constructor(stageId: BenchmarkHarnessStageId) {
    super(
      `benchmark-harness refused: no stage registered for pipeline position '${stageId}'; the harness wires exactly ${BENCHMARK_HARNESS_STAGE_ORDER.join(" → ")}`,
    );
    this.name = "BenchmarkHarnessStageConfigurationError";
  }
}

/**
 * Run the benchmark harness pipeline. Returns the run manifest in every
 * case (including failure): a failed pipeline is reported as a manifest
 * with `status: "failed"` and a visibly-failed stage, never by silently
 * dropping the stage. The CLI surface escalates a failed manifest to a
 * non-zero exit so the failure stays visible at the process level too.
 */
export async function runBenchmarkHarnessCommand(
  args: BenchmarkHarnessCommandArgs,
): Promise<BenchmarkHarnessRunManifest> {
  const log = args.log ?? (() => {});
  const stageById = new Map<BenchmarkHarnessStageId, BenchmarkHarnessStage>();
  for (const stage of args.stages) {
    stageById.set(stage.stageId, stage);
  }
  // A missing stage is a configuration bug, not a pipeline failure: refuse
  // up front rather than silently running a truncated pipeline.
  for (const stageId of BENCHMARK_HARNESS_STAGE_ORDER) {
    if (!stageById.has(stageId)) {
      throw new BenchmarkHarnessStageConfigurationError(stageId);
    }
  }

  const upstream = new Map<BenchmarkHarnessStageId, BenchmarkHarnessStageOutput>();
  const stages: BenchmarkHarnessStageRecord[] = [];
  const generatedReports: BenchmarkHarnessNamedArtifact[] = [];
  let costSummary: BenchmarkHarnessCostSummary | null = null;
  let benchmarkSetManifestId: string | null = null;
  let failedStageId: BenchmarkHarnessStageId | null = null;

  for (const stageId of BENCHMARK_HARNESS_STAGE_ORDER) {
    if (failedStageId !== null) {
      // Upstream failure short-circuits every later stage, but the skip is
      // RECORDED (with the blocking stage) — never silently dropped.
      stages.push({ stageId, status: "skipped_upstream_failed", blockedByStageId: failedStageId });
      continue;
    }
    // Non-null asserted: the configuration check above guarantees presence.
    const stage = stageById.get(stageId)!;
    let output: BenchmarkHarnessStageOutput;
    try {
      output = await stage.run({ benchmarkRunId: args.benchmarkRunId, upstream });
    } catch (error) {
      const failure: BenchmarkHarnessStageFailure = {
        stageId,
        errorName: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      };
      stages.push({ stageId, status: "failed", failure });
      failedStageId = stageId;
      log(`benchmark-harness: stage '${stageId}' FAILED — ${failure.message}`);
      continue;
    }

    upstream.set(stageId, output);
    const artifactPath = joinArtifactPath(args.outputDir, `${stageId}.json`);
    args.io.writeJson(artifactPath, output.artifact);
    const artifact: BenchmarkHarnessNamedArtifact = {
      stageId,
      artifactKind: output.artifactKind,
      label: output.label,
      artifactPath,
      artifactHash: hashArtifact(output.artifact),
    };
    stages.push({ stageId, status: "succeeded", artifact });
    generatedReports.push(artifact);
    if (output.costSummary !== undefined) {
      costSummary = output.costSummary;
    }
    if (output.benchmarkSetManifestId !== undefined) {
      benchmarkSetManifestId = output.benchmarkSetManifestId;
    }
    log(`benchmark-harness: stage '${stageId}' wrote ${artifactPath}`);
  }

  const manifest: BenchmarkHarnessRunManifest = {
    schemaVersion: BENCHMARK_HARNESS_RUN_MANIFEST_SCHEMA_VERSION,
    benchmarkRunId: args.benchmarkRunId,
    benchmarkName: args.benchmarkName,
    generatedAt: args.generatedAt,
    status: failedStageId === null ? "succeeded" : "failed",
    benchmarkSetManifestId,
    failedStageId,
    stages,
    generatedReports,
    costSummary,
  };
  const manifestPath = joinArtifactPath(args.outputDir, "run-manifest.json");
  args.io.writeJson(manifestPath, manifest);
  log(
    `benchmark-harness: wrote ${manifestPath} (status=${manifest.status}, reports=${generatedReports.length})`,
  );
  return manifest;
}

function joinArtifactPath(dir: string, file: string): string {
  return dir.endsWith("/") ? `${dir}${file}` : `${dir}/${file}`;
}

function hashArtifact(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/**
 * Lightweight structural assertion for the run manifest. Used by the
 * regression suite to prove the emitted shape is stable; not a substitute
 * for the per-artifact prerequisite validators the stages run.
 */
export function assertBenchmarkHarnessRunManifest(
  value: unknown,
): asserts value is BenchmarkHarnessRunManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("BenchmarkHarnessRunManifest must be an object");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== BENCHMARK_HARNESS_RUN_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `BenchmarkHarnessRunManifest.schemaVersion must be '${BENCHMARK_HARNESS_RUN_MANIFEST_SCHEMA_VERSION}'`,
    );
  }
  if (manifest.status !== "succeeded" && manifest.status !== "failed") {
    throw new Error("BenchmarkHarnessRunManifest.status must be 'succeeded' or 'failed'");
  }
  if (!Array.isArray(manifest.stages)) {
    throw new Error("BenchmarkHarnessRunManifest.stages must be an array");
  }
  if (!Array.isArray(manifest.generatedReports)) {
    throw new Error("BenchmarkHarnessRunManifest.generatedReports must be an array");
  }
}
