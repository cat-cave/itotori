// itotori-localize-fullproject-cli — LIVE wiring for `itotori localize`.
//
// Binds the pure whole-project driver (`runLocalizeFullProjectCommand`) to real
// production dependencies: a live Postgres context (attempt/outcome journal +
// reviewer-queue repositories), on-disk patch export, and the LIVE OpenRouter
// provider (ZDR-routed).
// This is what the `localize` CLI subcommand invokes.
//
// Privacy gate: the OpenRouter account-wide ZDR posture is asserted BEFORE any
// live byte, mirroring every other live-provider surface. The API key is read
// from the environment by the provider and is NEVER passed on the CLI.
//
// GAME-AGNOSTIC: the only run-specific input is the config path + a run
// directory. The project/branch/revision ids + the pinned (model, provider)
// pair come from the config + its pair-policy, so the SAME wiring drives any
// supported project.

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertBridgeBundleV02,
  assertPatchExportBundle,
} from "@itotori/localization-bridge-schema";
import {
  ItotoriAssetLocalizationDecisionRepository,
  ItotoriContextArtifactRepository,
  ItotoriLocalizationJournalRepository,
  ItotoriLocalizationRunFinalizerRepository,
  ItotoriProjectRepository,
  ItotoriReviewerQueueRepository,
  ItotoriTranslationScopeSettingsRepository,
  bootstrapLocalUser,
  createDatabaseContext,
  databaseUrlFromEnv,
  hashLocalizationArtifact,
  localUserId,
  type AuthorizationActor,
} from "@itotori/db";
import {
  assertOpenRouterZdrAccount,
  LocalProviderRunArtifactRecorder,
} from "../providers/index.js";
import { liveOpenRouterFactory } from "./localize-project-stage-command.js";
import { parseLocalizeProjectPairPolicy } from "./localize-project-stage-command.js";
import {
  DrivenJournalPersistenceAdapter,
  FsDrivenPatchExportSink,
} from "./project-driven-executor-sinks.js";
import {
  parseLocalizeFullProjectConfig,
  runLocalizeFullProjectCommand,
  type LocalizeFullProjectConfig,
  type LocalizeFullProjectIo,
  type LocalizeFullProjectResult,
} from "./localize-fullproject-command.js";
import {
  applyWholeGamePatch,
  buildWholeGamePatchExport,
  validateWholeGamePatch,
  type RunWholeGamePatchExportAndApplyArgs,
  type WholeGamePatchApplyResult,
  type WholeGamePatchBuildResult,
  type WholeGamePatchExportAndApplyResult,
} from "./patch-apply-seam.js";
import type { WholeGameRuntimeValidationAdmission } from "./wholegame-render-validation-seam.js";
import type { AgenticLoopProviderFactory } from "./agentic-loop.js";
import {
  PipelineFailureDiagnosticError,
  runPipelineStepWithDiagnostic,
} from "./pipeline-failure-diagnostic.js";
import type { NativeCliRunner } from "../native-bin/cli-bin-resolver.js";
import {
  hashDraftedAgainstBridge,
  type DrivenPatchReport,
  type ProjectDrivenExecutorResult,
} from "./project-driven-executor.js";
import { DbTerminalRunFinalizerAdapter } from "./terminal-run-finalizer-db-adapter.js";
import {
  finalizeTerminalRun,
  TerminalRunOperationalBlockerError,
  type TerminalFinalizerFaultFactory,
  type TerminalFinalizerWorkerPorts,
  type TerminalFinalizerStage,
  type TerminalRunSnapshot,
  type TerminalRunSummary,
} from "./terminal-run-finalizer.js";

export type RunLocalizeFullProjectLiveArgs = {
  configPath: string;
  /** Directory the patch export + provider-run artifacts + run summary land in. */
  runDir: string;
  io: LocalizeFullProjectIo;
  /** Existing paused executor run or finalizing terminal commit to resume. */
  resumeRunId?: string;
  /** Workflow-owned scope fence for a server-originated resume request. */
  expectedResumeScope?: { projectId: string; localeBranchId: string };
  /** Exact run-level USD cap persisted in the journal cost account. */
  costCapUsd?: number;
  /**
   * Optional client-side bounded-concurrency override (from `--concurrency`).
   * When present it WINS over the config's `concurrency` and the executor
   * default. Raises whole-game throughput without editing the checked-in config.
   */
  concurrency?: number;
  /**
   * m1-wholegame-localize-to-patch-seam — the read-only source game root +
   * the writable target root. When BOTH are present the run reaches an
   * APPLYABLE, byte-correct patch: the executor's real drafts pass the
   * export-patch preflight (production loader), then `kaifuu patch` (dispatched
   * on the config `engineProfile`) writes the patched output under
   * `patchTargetRoot`:
   *   - RealLive (`sourceRoot` = game root w/ REALLIVEDATA/Seen.txt):
   *     `kaifuu patch --engine reallive` patches Seen.txt into `patchTargetRoot`.
   *   - RPG Maker MV/MZ (`sourceRoot` = `www` dir w/ `data/`):
   *     `kaifuu patch --engine rpgmaker` byte-surgically patches the
   *     `www/data/*.json` literals into `patchTargetRoot` + a `.kaifuu` delta.
   * Omit both to stop at `translated-bridge.json` (e.g. a decode-only dry check).
   */
  sourceRoot?: string;
  patchTargetRoot?: string;
  /** Injected native runner for post-patch Utsushi replay/render validation. */
  nativeCli?: NativeCliRunner;
  /** Allow a bounded / incomplete run to produce a byte-preserving preview patch. */
  allowPartialPatch?: boolean;
  /** Explicit cancellation is terminalized as `aborted`, never as a silent throw. */
  cancelled?: boolean;
  /** Narrow deterministic failure-injection seam for terminal-finalizer tests. */
  finalizerStageFaults?: Partial<Record<TerminalFinalizerStage, TerminalFinalizerFaultFactory>>;
  /** Narrow deterministic provider seam for live orchestration regression tests. */
  providerFactoryOverride?: AgenticLoopProviderFactory;
  log?: (message: string) => void;
};

export type DrivenLocalizeFullProjectLiveResult = LocalizeFullProjectResult & {
  /** Present when the source + target roots drove the patch-apply seam. */
  patchApply?: WholeGamePatchExportAndApplyResult;
  /** The one canonical terminal projection, mirrored by run-summary.json. */
  terminalSummary: TerminalRunSummary;
  /** Absent/false for a pass which invoked the driven executor in this process. */
  resumedFinalization?: false;
};

/**
 * Honest projection returned when a durable `finalizing` run is resumed.
 * Executor-only counters are deliberately absent: this process never drove an
 * executor and must not invent an in-memory executor report. The canonical DB
 * summary contains every durable terminal fact the caller may report.
 */
export type ResumedTerminalFinalizationLiveResult = {
  resumedFinalization: true;
  result: Pick<ProjectDrivenExecutorResult, "journalRunId" | "runState" | "pausedBlocker">;
  terminalSummary: TerminalRunSummary;
};

export type RunLocalizeFullProjectLiveResult =
  | DrivenLocalizeFullProjectLiveResult
  | ResumedTerminalFinalizationLiveResult;

export class RuntimeValidationIncompleteError extends Error {
  readonly code = "runtime-validation-incomplete";

  constructor(
    public readonly admission: Extract<
      WholeGameRuntimeValidationAdmission,
      { kind: "runtime-validation-incomplete" }
    >,
    public readonly retryTargetRoot: string,
  ) {
    super(
      `runtime-validation-incomplete: findings=${String(admission.validation.findings.length)} ` +
        `retryUnits=${String(admission.retryUnitIds.length)}`,
    );
    this.name = "RuntimeValidationIncompleteError";
  }
}

/** The CLI still exits non-zero for a durable terminal failure. */
export class TerminalRunFailedError extends Error {
  constructor(readonly summary: TerminalRunSummary) {
    super(
      `localize terminalized ${summary.runId} as failed at ` +
        `${summary.rootCause.stage ?? "terminal"}: ${summary.rootCause.message}`,
    );
    this.name = "TerminalRunFailedError";
  }
}

export type WholeGamePatchCoverage = Pick<
  DrivenPatchReport,
  "unitsInScope" | "unitsRun" | "writtenOutcomeCount" | "failureCount" | "coverageComplete"
>;

export class WholeGamePatchCoverageRefusedError extends Error {
  public readonly unitsInScope: number;
  public readonly unitsRun: number;
  public readonly writtenOutcomeCount: number;
  public readonly coverageComplete: boolean;
  public readonly failureCount: number;

  constructor(public readonly coverage: WholeGamePatchCoverage) {
    super(
      `whole-game patch-export refused: configured scope lacks complete written coverage ` +
        `(${coverage.writtenOutcomeCount}/${coverage.unitsInScope} written; ` +
        `${coverage.failureCount} operational failure(s)). Resolve and resume the run before exporting.`,
    );
    this.name = "WholeGamePatchCoverageRefusedError";
    this.unitsInScope = coverage.unitsInScope;
    this.unitsRun = coverage.unitsRun;
    this.writtenOutcomeCount = coverage.writtenOutcomeCount;
    this.coverageComplete = coverage.coverageComplete;
    this.failureCount = coverage.failureCount;
  }
}

export function assertWholeGamePatchCoverage(
  patchReport: WholeGamePatchCoverage,
  _allowPartialPatch: boolean,
): void {
  if (!patchReport.coverageComplete) {
    throw new WholeGamePatchCoverageRefusedError({
      unitsInScope: patchReport.unitsInScope,
      unitsRun: patchReport.unitsRun,
      writtenOutcomeCount: patchReport.writtenOutcomeCount,
      failureCount: patchReport.failureCount,
      coverageComplete: patchReport.coverageComplete,
    });
  }
}

/**
 * Run `itotori localize <project>` against LIVE OpenRouter + real Postgres.
 * Asserts the account ZDR posture, stands up the repositories, and drives the
 * whole project through its durable attempt/outcome journal. Tears the DB
 * context down in a `finally` so a failure never leaks a connection.
 *
 * itotori-agent-facing-pipeline-failure-diagnostics — every step failure here
 * is wrapped in a `PipelineFailureDiagnosticError` so the CLI surfaces a
 * structured diagnostic (step + inputs + repro) instead of a bare `Error`. The
 * top-level try/catch rethrows any NON-diagnostic error as a structured
 * diagnostic tagged `localize.run-journal` so a driving agent never sees an
 * unstructured throw.
 */
export async function runLocalizeFullProjectLive(
  args: RunLocalizeFullProjectLiveArgs,
): Promise<RunLocalizeFullProjectLiveResult> {
  // A process can lose its connection after every physical stage succeeded but
  // before the terminal transaction was confirmed, or after the canonical row
  // committed but before its file projection. Probe both durable boundaries
  // before config/ZDR/provider setup: rerunning the driven executor is both
  // unnecessary and explicitly refused by its terminal-state fence.
  const resumedFinalization = await resumeDurableFinalizingRun(args);
  if (resumedFinalization !== null) return resumedFinalization;

  // Privacy gate BEFORE any live byte.
  assertOpenRouterZdrAccount(process.env);

  // The pair + identity are read from the config + pair-policy so the DB
  // persistence adapter records the SAME pinned pair the executor drives with.
  // Each pre-parse step is wrapped so a malformed config / pair-policy yields
  // a structured diagnostic naming the failing step (not a bare `Error`).
  const config = await runPipelineStepWithDiagnostic({
    step: "localize.parse-config",
    code: "refused",
    message: `localize-live: parse-config refused: config JSON at '${args.configPath}' is invalid`,
    inputs: {
      configPath: args.configPath,
      runDir: args.runDir,
      ...(args.resumeRunId !== undefined ? { resumeRunId: args.resumeRunId } : {}),
    },
    repro: { configPath: args.configPath },
    run: () => parseLocalizeFullProjectConfig(args.io.readJson(args.configPath)),
  });
  if (
    args.expectedResumeScope !== undefined &&
    (config.projectId !== args.expectedResumeScope.projectId ||
      config.localeBranchId !== args.expectedResumeScope.localeBranchId)
  ) {
    throw new Error(`resume config scope mismatch for durable run ${args.resumeRunId ?? "<new>"}`);
  }
  const { pair } = await runPipelineStepWithDiagnostic({
    step: "localize.read-pair-policy",
    code: "refused",
    message: `localize-live: read-pair-policy refused: pair-policy at '${config.pairPolicyPath}' is invalid`,
    inputs: {
      configPath: args.configPath,
      bridgePath: config.bridgePath,
      pairPolicyPath: config.pairPolicyPath,
      runDir: args.runDir,
    },
    repro: {
      configPath: args.configPath,
      bridgePath: config.bridgePath,
      pairPolicyPath: config.pairPolicyPath,
    },
    run: () => parseLocalizeProjectPairPolicy(args.io.readJson(config.pairPolicyPath)),
  });

  const databaseUrl = databaseUrlFromEnv();
  const context = createDatabaseContext(databaseUrl);
  try {
    await bootstrapLocalUser(context.db);
    const actor: AuthorizationActor = { userId: localUserId };

    // Context artifacts cite canonical source-unit rows. Import the exact
    // v0.2 bridge before the executor can enrich or draft a pending unit, so a
    // paused run resumed after an earlier terminal summary has the same
    // source-unit graph as a fresh live run. The config's source revision is a
    // durable identity fence and must name this bridge bundle revision.
    const projectRepo = new ItotoriProjectRepository(context.db);
    await runPipelineStepWithDiagnostic({
      step: "localize.provision-project-scope",
      code: "unknown",
      message:
        "localize-live: provision-project-scope failed: could not import the bridge source units required by the journal and context brain",
      inputs: {
        configPath: args.configPath,
        bridgePath: config.bridgePath,
        projectId: config.projectId,
        localeBranchId: config.localeBranchId,
        sourceRevisionId: config.sourceRevisionId,
        runDir: args.runDir,
      },
      repro: { configPath: args.configPath, bridgePath: config.bridgePath },
      actor,
      run: async () => {
        const bridge = args.io.readJson(config.bridgePath);
        assertBridgeBundleV02(bridge);
        if (bridge.sourceBundleRevision.revisionId !== config.sourceRevisionId) {
          throw new Error(
            `localize-live: config sourceRevisionId '${config.sourceRevisionId}' does not match ` +
              `bridge sourceBundleRevision '${bridge.sourceBundleRevision.revisionId}'`,
          );
        }
        await projectRepo.importSourceBundle(actor, {
          projectId: config.projectId,
          localeBranchId: config.localeBranchId,
          targetLocale: config.targetLocale ?? "en-US",
          drafts: {},
          bridge,
        });
      },
    });

    const journalRepo = new ItotoriLocalizationJournalRepository(context.db);
    const reviewerQueueRepo = new ItotoriReviewerQueueRepository(context.db);
    const contextArtifactRepo = new ItotoriContextArtifactRepository(context.db);
    const assetDecisionRepo = new ItotoriAssetLocalizationDecisionRepository(context.db);
    // itotori-translation-scope-configuration-ui — the SAME repository the
    // `settings.translationScope.save` API route persists through, so a
    // project/branch owner's Studio scope selection is the real DB-backed
    // default this live run resolves when its config JSON omits
    // `translationScope`.
    const translationScopeSettingsRepo = new ItotoriTranslationScopeSettingsRepository(context.db);

    const dbAdapter = new DrivenJournalPersistenceAdapter(journalRepo, {
      actor,
    });
    const patchSink = new FsDrivenPatchExportSink(args.runDir);
    const artifactRecorder = new LocalProviderRunArtifactRecorder(
      join(args.runDir, "provider-runs"),
    );
    const providerFactory =
      args.providerFactoryOverride ??
      liveOpenRouterFactory({
        artifactRecorder,
      });
    const terminalRunId = args.resumeRunId ?? `localization-journal-run-${randomUUID()}`;
    // A run directory is reusable, but its summary is only a projection of the
    // canonical DB row. Remove an older epoch before the executor can move a
    // paused run back to running (and before any new terminal commit attempt).
    invalidateRunSummary(args.runDir);
    const terminalRepository = new ItotoriLocalizationRunFinalizerRepository(context.db);
    const terminalPersistence = new DbTerminalRunFinalizerAdapter(
      terminalRepository,
      actor,
      (runId) => {
        try {
          return dbAdapter.getActiveRunLease(runId);
        } catch {
          // A paused executor deliberately releases its fence after all
          // workers drain; paused finalization is then resumable without one.
          return undefined;
        }
      },
      {
        beforeEnterFinalizing: (runId) => dbAdapter.quiesceTerminalRunLeaseHeartbeat(runId),
        afterEnterFinalizing: (runId) => dbAdapter.forgetTerminalRunLease(runId),
      },
      { runLockPool: context.pool },
    );
    let passResult: LocalizeFullProjectResult | undefined;
    let passError: unknown;

    try {
      passResult = await runPipelineStepWithDiagnostic({
        step: "localize.run-journal",
        code: "unknown",
        message: `localize-live: run-journal failed: the driven executor / journal step aborted`,
        inputs: {
          configPath: args.configPath,
          bridgePath: config.bridgePath,
          pairPolicyPath: config.pairPolicyPath,
          runDir: args.runDir,
          projectId: config.projectId,
          localeBranchId: config.localeBranchId,
          pair,
          ...(args.resumeRunId !== undefined ? { resumeRunId: args.resumeRunId } : {}),
          ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
          ...(args.costCapUsd !== undefined ? { budgetCapUsd: args.costCapUsd } : {}),
        },
        preserveError: (error) => error instanceof WholeGamePatchCoverageRefusedError,
        repro: {
          configPath: args.configPath,
          bridgePath: config.bridgePath,
          pairPolicyPath: config.pairPolicyPath,
        },
        actor,
        run: () =>
          runLocalizeFullProjectCommand({
            configPath: args.configPath,
            runId: terminalRunId,
            ...(args.resumeRunId !== undefined ? { resumeRunId: args.resumeRunId } : {}),
            ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
            ...(args.costCapUsd !== undefined ? { budgetCapUsd: args.costCapUsd } : {}),
            deps: {
              io: args.io,
              actor,
              providerFactory,
              sinks: { journal: dbAdapter, patchExport: patchSink },
              journalHistory: journalRepo,
              reviewerQueue: { repository: reviewerQueueRepo },
              contextArtifactRepository: contextArtifactRepo,
              translationScopeSettings: {
                resolveScope: (projectId, localeBranchId) =>
                  translationScopeSettingsRepo.resolveScope(projectId, localeBranchId),
              },
              ...(args.log === undefined ? {} : { log: args.log }),
            },
          }),
      });
    } catch (error) {
      passError = error;
    }

    const patchWorkers = createTerminalPatchWorkerController({
      args,
      config,
      actor,
      journal: journalRepo,
      runId: terminalRunId,
      loadActiveDecisions: (a, projectId, localeBranchId) =>
        assetDecisionRepo.loadActiveDecisions(a, projectId, localeBranchId),
      loadPatchReport: (snapshot, requirePersistedArtifact) => {
        if (passError !== undefined) throw passError;
        if (passResult === undefined) {
          throw new Error(`terminal finalizer has no executor result for ${terminalRunId}`);
        }
        if (requirePersistedArtifact) {
          return loadTerminalPatchReport(
            args,
            config,
            terminalRunId,
            snapshot,
            requirePersistedArtifact,
          );
        }
        return passResult.result.patchReport;
      },
    });
    const finalization = await finalizeTerminalRun({
      runId: passResult?.result.journalRunId ?? terminalRunId,
      persistence: terminalPersistence,
      ...(args.cancelled === undefined ? {} : { cancelled: args.cancelled }),
      ...(args.resumeRunId !== undefined && passResult?.result.runState === "paused"
        ? { supersedePausedSummary: true }
        : {}),
      ...(args.finalizerStageFaults === undefined
        ? {}
        : { stageFaults: args.finalizerStageFaults }),
      workers: {
        ...patchWorkers.workers,
        summary: async ({ summary }) => {
          if (summary === undefined)
            throw new Error("terminal summary worker received no canonical summary");
          args.io.writeJson(join(args.runDir, "run-summary.json"), summary);
          return { evidence: { path: join(args.runDir, "run-summary.json") } };
        },
      },
    });

    if (passError !== undefined) throw passError;
    const patchWorkerError = patchWorkers.getPatchWorkerError();
    if (patchWorkerError !== undefined) throw patchWorkerError;
    const runtimeValidationError = patchWorkers.getRuntimeValidationError();
    if (runtimeValidationError !== undefined) throw runtimeValidationError;
    if (finalization.terminalStatus === "failed") {
      throw new TerminalRunFailedError(finalization.summary);
    }
    if (passResult === undefined) {
      throw new TerminalRunFailedError(finalization.summary);
    }
    const patchApply = patchWorkers.getPatchApply();
    const result = {
      ...passResult.result,
      runState: finalization.terminalStatus,
      pausedBlocker: finalization.summary.blocker,
      ...(patchApply?.renderValidation === undefined
        ? {}
        : { runtimeValidation: patchApply.renderValidation }),
    };
    return {
      ...passResult,
      result,
      ...(patchApply === undefined ? {} : { patchApply }),
      terminalSummary: finalization.summary,
    };
  } catch (error) {
    // The terminal finalizer above owns the one canonical structured summary
    // for every seeded run. Preserve an existing structured diagnostic for the
    // CLI's non-zero exit, but never emit a second abort-only artifact.
    if (
      error instanceof PipelineFailureDiagnosticError ||
      error instanceof RuntimeValidationIncompleteError ||
      error instanceof WholeGamePatchCoverageRefusedError ||
      error instanceof TerminalRunFailedError
    ) {
      throw error;
    }
    // Anything else (a Postgres bootstrap error, a transport drop, a missing
    // env var) is wrapped as a structured diagnostic so the CLI never emits a
    // bare `Error`. Step is the most general one — the message preserves the
    // original error class + scrubbed message for triage.
    throw await runPipelineStepWithDiagnostic({
      step: "localize.run-journal",
      code: "unknown",
      message: `localize-live: run-journal failed: ${error instanceof Error ? error.message : String(error)}`,
      inputs: {
        configPath: args.configPath,
        bridgePath: config.bridgePath,
        pairPolicyPath: config.pairPolicyPath,
        runDir: args.runDir,
      },
      repro: {
        configPath: args.configPath,
        bridgePath: config.bridgePath,
        pairPolicyPath: config.pairPolicyPath,
      },
      run: () => {
        throw error;
      },
    });
  } finally {
    await context.close();
  }
}

type TerminalPatchWorkerController = {
  workers: TerminalFinalizerWorkerPorts;
  getPatchApply(): WholeGamePatchExportAndApplyResult | undefined;
  getPatchWorkerError(): unknown;
  getRuntimeValidationError(): RuntimeValidationIncompleteError | undefined;
};

/**
 * One implementation for both the initial finalizer and durable physical-stage
 * recovery. The core decides which workers are incomplete; this controller
 * reconstructs only the worker it is actually asked to run.
 */
function createTerminalPatchWorkerController(input: {
  args: RunLocalizeFullProjectLiveArgs;
  config: LocalizeFullProjectConfig;
  actor: AuthorizationActor;
  journal: RunWholeGamePatchExportAndApplyArgs["journal"];
  runId: string;
  loadActiveDecisions: RunWholeGamePatchExportAndApplyArgs["loadActiveDecisions"];
  loadPatchReport: (
    snapshot: TerminalRunSnapshot,
    requirePersistedArtifact: boolean,
  ) => DrivenPatchReport;
}): TerminalPatchWorkerController {
  const { args, config, actor, journal, runId } = input;
  let patchBuild: WholeGamePatchBuildResult | undefined;
  let patchApplied: WholeGamePatchApplyResult | undefined;
  let patchApply: WholeGamePatchExportAndApplyResult | undefined;
  let patchWorkerError: unknown;
  let runtimeValidationError: RuntimeValidationIncompleteError | undefined;

  const requirePatchArgs = (
    snapshot: TerminalRunSnapshot,
    stage: "build" | "apply" | "validation",
  ): RunWholeGamePatchExportAndApplyArgs => {
    if (
      args.sourceRoot === undefined ||
      args.sourceRoot.length === 0 ||
      args.patchTargetRoot === undefined ||
      args.patchTargetRoot.length === 0
    ) {
      throw new TerminalRunOperationalBlockerError({
        kind: "itotori_bug",
        detail: "patch build/apply awaits --source and --patch-target inputs",
        evidence: `terminal-run:${runId};run-dir:${args.runDir}`,
        raisedAt: new Date().toISOString(),
        operatorAction: "supply the patch source and target roots, then resume this run",
      });
    }
    const requirePersistedBuild = stage !== "build";
    const patchReport = input.loadPatchReport(snapshot, requirePersistedBuild);
    assertWholeGamePatchCoverage(patchReport, args.allowPartialPatch ?? false);
    const rawBridge = args.io.readJson(config.bridgePath);
    if (hashDraftedAgainstBridge(rawBridge) !== patchReport.sourceBridgeHash) {
      throw new Error(`terminal finalizer bridge no longer matches durable run ${runId}`);
    }
    const translatedBundlePath = terminalArtifactPath({
      args,
      snapshot,
      key: "translatedBridge",
      fallbackPath: resolve(args.runDir, "translated-bridge.json"),
      required: requirePersistedBuild,
    });
    const targetRoot = terminalArtifactPath({
      args,
      snapshot,
      key: "patchTarget",
      fallbackPath: resolve(args.patchTargetRoot),
      required: stage === "validation",
    });
    if (
      snapshot.patch?.artifactRefs.patchTarget !== undefined &&
      resolve(args.patchTargetRoot) !== targetRoot
    ) {
      throw new Error(
        `terminal finalizer patch target ${resolve(args.patchTargetRoot)} does not match durable artifact ${targetRoot}`,
      );
    }
    const isRealLive = config.engineProfile === "reallive";
    const rpgMakerDeltaOutputPath = isRealLive
      ? undefined
      : terminalArtifactPath({
          args,
          snapshot,
          key: "rpgMakerDelta",
          fallbackPath: resolve(args.runDir, "rpgmaker-delta.kaifuu"),
          required: stage === "validation",
        });
    return {
      actor,
      engineProfile: config.engineProfile,
      journal,
      patchReport,
      rawBridge,
      sourceRoot: args.sourceRoot,
      targetRoot,
      translatedBundlePath,
      requestedBy: localUserId,
      loadActiveDecisions: input.loadActiveDecisions,
      ...(rpgMakerDeltaOutputPath === undefined ? {} : { rpgMakerDeltaOutputPath }),
      ...(isRealLive
        ? {
            renderValidation: {
              artifactRoot: resolve(args.runDir, "wholegame-render-validation"),
              redaction: "on" as const,
              ...(args.nativeCli === undefined ? {} : { nativeCli: args.nativeCli }),
              ...(args.log === undefined ? {} : { log: args.log }),
            },
          }
        : {}),
      ...(args.log === undefined ? {} : { log: args.log }),
    };
  };

  const workers: TerminalFinalizerWorkerPorts = {
    patch_build: async ({ snapshot }) => {
      try {
        const adopted = adoptTerminalArtifacts(args, snapshot, [
          "translatedBridge",
          "patchReport",
          "patchExport",
        ]);
        if (adopted !== null) {
          requirePatchArgs(snapshot, "apply");
          patchBuild = loadTerminalPatchBuild(args, runId, snapshot);
          return {
            ...adopted,
            evidence: { resumedFromDurableManifest: true, step: "patch_build" },
          };
        }
        const patchArgs = requirePatchArgs(snapshot, "build");
        patchBuild = await runPipelineStepWithDiagnostic({
          step: "localize.apply-patch",
          code: "unknown",
          message: `localize-live: build-patch failed: export-patch preflight aborted`,
          inputs: patchDiagnosticInputs(args, config),
          repro: { configPath: args.configPath, bridgePath: config.bridgePath },
          actor,
          run: () => buildWholeGamePatchExport(patchArgs),
        });
      } catch (error) {
        patchWorkerError = error;
        throw error;
      }
      return terminalPatchBuildArtifacts({ args, patchBuild });
    },
    patch_apply: async ({ snapshot }) => {
      let patchArgs: RunWholeGamePatchExportAndApplyArgs | undefined;
      try {
        const applyArtifactKeys = [
          "patchApply",
          "patchTarget",
          ...(config.engineProfile === "rpg-maker-mv-mz" ? ["rpgMakerDelta"] : []),
        ];
        const adopted = adoptTerminalArtifacts(args, snapshot, applyArtifactKeys);
        if (adopted !== null) {
          requirePatchArgs(snapshot, "validation");
          patchBuild ??= loadTerminalPatchBuild(args, runId, snapshot);
          patchApplied = loadTerminalPatchApply(args, patchBuild, snapshot);
          return {
            ...adopted,
            evidence: { resumedFromDurableManifest: true, step: "patch_apply" },
          };
        }
        patchArgs = requirePatchArgs(snapshot, "apply");
        patchBuild ??= loadTerminalPatchBuild(args, runId, snapshot);
        patchApplied = await runPipelineStepWithDiagnostic({
          step: "localize.apply-patch",
          code: "unknown",
          message: `localize-live: apply-patch failed: kaifuu patch aborted`,
          inputs: patchDiagnosticInputs(args, config),
          repro: { configPath: args.configPath, bridgePath: config.bridgePath },
          actor,
          run: () => applyWholeGamePatch(patchArgs!, patchBuild!),
        });
      } catch (error) {
        patchWorkerError = error;
        throw error;
      }
      return terminalPatchApplyArtifacts({ args, config, patchArgs: patchArgs!, patchApplied });
    },
    validation: async ({ snapshot }) => {
      try {
        const validationArtifactKeys =
          config.engineProfile === "rpg-maker-mv-mz"
            ? ["structuralValidation"]
            : ["runtimeValidation"];
        const adopted = adoptTerminalArtifacts(args, snapshot, validationArtifactKeys);
        if (adopted !== null) {
          requirePatchArgs(snapshot, "validation");
          patchBuild ??= loadTerminalPatchBuild(args, runId, snapshot);
          patchApplied ??= loadTerminalPatchApply(args, patchBuild, snapshot);
          patchApply = { ...patchApplied };
          return {
            ...adopted,
            evidence: { resumedFromDurableManifest: true, step: "validation" },
          };
        }
        const patchArgs = requirePatchArgs(snapshot, "validation");
        patchBuild ??= loadTerminalPatchBuild(args, runId, snapshot);
        patchApplied ??= loadTerminalPatchApply(args, patchBuild, snapshot);
        const validation = validateWholeGamePatch(patchArgs);
        patchApply = { ...patchApplied, ...validation };
      } catch (error) {
        patchWorkerError = error;
        throw error;
      }
      if (patchApply.runtimeValidationAdmission?.kind === "runtime-validation-incomplete") {
        runtimeValidationError = new RuntimeValidationIncompleteError(
          patchApply.runtimeValidationAdmission,
          args.patchTargetRoot!,
        );
        throw runtimeValidationError;
      }
      return terminalPatchValidationArtifacts({ args, config, patchApply });
    },
  };

  return {
    workers,
    getPatchApply: () => patchApply,
    getPatchWorkerError: () => patchWorkerError,
    getRuntimeValidationError: () => runtimeValidationError,
  };
}

function patchDiagnosticInputs(
  args: RunLocalizeFullProjectLiveArgs,
  config: LocalizeFullProjectConfig,
): Record<string, unknown> {
  return {
    configPath: args.configPath,
    runDir: args.runDir,
    projectId: config.projectId,
    localeBranchId: config.localeBranchId,
    engineProfile: config.engineProfile,
  };
}

/**
 * Resume only a durable post-executor boundary. Returning `null` means the
 * requested run is still executor-owned and the normal live path must handle
 * it. Paused runs always return to the executor even when an earlier pause has
 * a canonical summary. Finalizing recovery lazily reconstructs patch inputs only
 * when a physical stage is incomplete; commit-only and terminal retries remain
 * config/provider-free summary projections.
 */
async function resumeDurableFinalizingRun(
  args: RunLocalizeFullProjectLiveArgs,
): Promise<ResumedTerminalFinalizationLiveResult | null> {
  const runId = args.resumeRunId;
  if (runId === undefined || runId.trim().length === 0) return null;

  const context = createDatabaseContext(databaseUrlFromEnv());
  try {
    await bootstrapLocalUser(context.db);
    const actor: AuthorizationActor = { userId: localUserId };
    const repository = new ItotoriLocalizationRunFinalizerRepository(context.db);
    const persistence = new DbTerminalRunFinalizerAdapter(
      repository,
      actor,
      undefined,
      {},
      { runLockPool: context.pool },
    );
    const snapshot = await persistence.loadSnapshot(runId);
    if (snapshot === null) return null;
    const existingSummary = await persistence.loadTerminalSummary(runId);
    if (args.expectedResumeScope !== undefined) {
      const durableRun = await new ItotoriLocalizationJournalRepository(context.db).loadRun(
        actor,
        runId,
      );
      if (
        durableRun === null ||
        durableRun.projectId !== args.expectedResumeScope.projectId ||
        durableRun.localeBranchId !== args.expectedResumeScope.localeBranchId
      ) {
        throw new Error(`finalizing resume scope mismatch for durable run ${runId}`);
      }
    }
    const isCommittedTerminalBoundary =
      snapshot.runStatus === "succeeded" ||
      snapshot.runStatus === "failed" ||
      snapshot.runStatus === "aborted" ||
      (args.cancelled === true && snapshot.runStatus === "paused" && existingSummary !== null);
    if (snapshot.runStatus !== "finalizing" && !isCommittedTerminalBoundary) return null;

    invalidateRunSummary(args.runDir);
    let recovery: TerminalPatchWorkerController | undefined;
    const recoveryWorkers = (): TerminalPatchWorkerController => {
      if (recovery !== undefined) return recovery;
      const config = parseLocalizeFullProjectConfig(args.io.readJson(args.configPath));
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const assetDecisions = new ItotoriAssetLocalizationDecisionRepository(context.db);
      recovery = createTerminalPatchWorkerController({
        args,
        config,
        actor,
        journal,
        runId,
        loadActiveDecisions: (a, projectId, localeBranchId) =>
          assetDecisions.loadActiveDecisions(a, projectId, localeBranchId),
        loadPatchReport: (current, requirePersistedArtifact) =>
          loadTerminalPatchReport(args, config, runId, current, requirePersistedArtifact),
      });
      return recovery;
    };

    const finalization = await finalizeTerminalRun({
      runId,
      persistence,
      ...(args.cancelled === undefined ? {} : { cancelled: args.cancelled }),
      ...(args.finalizerStageFaults === undefined
        ? {}
        : { stageFaults: args.finalizerStageFaults }),
      workers: {
        patch_build: (workerArgs) => recoveryWorkers().workers.patch_build!(workerArgs),
        patch_apply: (workerArgs) => recoveryWorkers().workers.patch_apply!(workerArgs),
        validation: (workerArgs) => recoveryWorkers().workers.validation!(workerArgs),
        summary: ({ summary }) => {
          if (summary === undefined) {
            throw new Error("terminal summary worker received no canonical summary");
          }
          args.io.writeJson(join(args.runDir, "run-summary.json"), summary);
          return { evidence: { path: join(args.runDir, "run-summary.json") } };
        },
      },
    });

    const patchWorkerError = recovery?.getPatchWorkerError();
    if (patchWorkerError !== undefined) throw patchWorkerError;
    const runtimeValidationError = recovery?.getRuntimeValidationError();
    if (runtimeValidationError !== undefined) throw runtimeValidationError;

    // A previously delivered summary outbox is correctly skipped by the core.
    // An explicit operator resume still repairs a missing/stale local
    // projection, using only the canonical row returned above.
    if (
      snapshot.stages.some((stage) => stage.stage === "summary" && stage.status === "succeeded")
    ) {
      args.io.writeJson(join(args.runDir, "run-summary.json"), finalization.summary);
    }

    if (finalization.terminalStatus === "failed") {
      throw new TerminalRunFailedError(finalization.summary);
    }
    return {
      resumedFinalization: true,
      result: {
        journalRunId: runId,
        runState: finalization.terminalStatus,
        pausedBlocker: finalization.summary.blocker,
      },
      terminalSummary: finalization.summary,
    };
  } finally {
    await context.close();
  }
}

/**
 * Materialize/hash the exact artifacts the PatchVersion names. The output is
 * deliberately a small manifest of paths and hashes; no source or target text
 * is copied into a terminal summary.
 */
function terminalPatchBuildArtifacts(input: {
  args: RunLocalizeFullProjectLiveArgs;
  patchBuild: WholeGamePatchBuildResult;
}) {
  const patchExportPath = resolve(input.args.runDir, "patch-export-bundle.json");
  input.args.io.writeJson(patchExportPath, input.patchBuild.patchExportBundle);
  const paths: Record<string, string> = {
    translatedBridge: resolve(input.args.runDir, "translated-bridge.json"),
    patchReport: resolve(input.args.runDir, "patch-report.json"),
    patchExport: patchExportPath,
  };
  return terminalArtifactManifest(paths, {
    patchVersionDraftCount: input.patchBuild.patchExportBundle.drafts.length,
    step: "patch_build",
  });
}

function terminalPatchApplyArtifacts(input: {
  args: RunLocalizeFullProjectLiveArgs;
  config: { engineProfile: "reallive" | "rpg-maker-mv-mz" };
  patchArgs: RunWholeGamePatchExportAndApplyArgs;
  patchApplied: WholeGamePatchApplyResult;
}) {
  const patchApplyPath = resolve(input.args.runDir, "patch-apply.json");
  input.args.io.writeJson(patchApplyPath, input.patchApplied.apply);
  const paths: Record<string, string> = {
    patchApply: patchApplyPath,
    patchTarget: resolve(input.patchArgs.targetRoot),
  };
  if (input.config.engineProfile === "rpg-maker-mv-mz") {
    paths.rpgMakerDelta = resolve(
      input.patchArgs.rpgMakerDeltaOutputPath ?? `${input.patchArgs.targetRoot}.delta.kaifuu`,
    );
  }
  return terminalArtifactManifest(paths, {
    engineProfile: input.config.engineProfile,
    step: "patch_apply",
  });
}

function terminalPatchValidationArtifacts(input: {
  args: RunLocalizeFullProjectLiveArgs;
  config: { engineProfile: "reallive" | "rpg-maker-mv-mz" };
  patchApply: WholeGamePatchExportAndApplyResult;
}) {
  const paths: Record<string, string> = {};
  if (input.patchApply.renderValidation !== undefined) {
    const runtimeValidationPath = resolve(input.args.runDir, "runtime-validation.json");
    input.args.io.writeJson(runtimeValidationPath, input.patchApply.renderValidation);
    paths.runtimeValidation = runtimeValidationPath;
  }
  if (input.patchApply.structuralValidation !== undefined) {
    const structuralValidationPath = resolve(
      input.args.runDir,
      "rpgmaker-structural-validation.json",
    );
    input.args.io.writeJson(structuralValidationPath, input.patchApply.structuralValidation);
    paths.structuralValidation = structuralValidationPath;
  }
  return terminalArtifactManifest(paths, {
    engineProfile: input.config.engineProfile,
    runtimeValidation:
      input.patchApply.renderValidation !== undefined
        ? "runtime-validated"
        : input.patchApply.structuralValidation !== undefined
          ? "structural-validated"
          : "structural-preflight",
    step: "validation",
  });
}

function terminalArtifactManifest(
  paths: Record<string, string>,
  evidence: Record<string, unknown>,
): {
  artifactHashes: Record<string, string>;
  artifactRefs: Record<string, string>;
  evidence: Record<string, unknown>;
} {
  const artifactHashes = Object.fromEntries(
    Object.entries(paths).map(([name, path]) => [name, hashLocalizationArtifact(path)]),
  );
  return {
    artifactHashes,
    artifactRefs: paths,
    evidence: {
      ...evidence,
      artifacts: Object.keys(paths).sort(),
    },
  };
}

/**
 * A process can die after the patch manifest transaction but before its stage
 * outbox row succeeds. In that window the immutable, hash-bound artifacts are
 * already the completed worker result; adopt them without regenerating bytes.
 */
function adoptTerminalArtifacts(
  args: RunLocalizeFullProjectLiveArgs,
  snapshot: TerminalRunSnapshot,
  keys: readonly string[],
): { artifactHashes: Record<string, string>; artifactRefs: Record<string, string> } | null {
  const present = keys.filter(
    (key) =>
      snapshot.patch?.artifactRefs[key] !== undefined ||
      snapshot.patch?.artifactHashes[key] !== undefined,
  );
  if (present.length === 0) return null;
  if (present.length !== keys.length) {
    throw new Error(
      `terminal finalizer durable manifest is incomplete for ${snapshot.runId}: expected ${keys.join(",")}`,
    );
  }
  const artifactRefs: Record<string, string> = {};
  const artifactHashes: Record<string, string> = {};
  for (const key of keys) {
    const ref = snapshot.patch?.artifactRefs[key];
    const hash = snapshot.patch?.artifactHashes[key];
    if (ref === undefined || hash === undefined) {
      throw new Error(`terminal finalizer durable manifest lacks ${key} for ${snapshot.runId}`);
    }
    terminalArtifactPath({
      args,
      snapshot,
      key,
      fallbackPath: ref,
      required: true,
    });
    artifactRefs[key] = ref;
    artifactHashes[key] = hash;
  }
  return { artifactHashes, artifactRefs };
}

function terminalArtifactPath(input: {
  args: RunLocalizeFullProjectLiveArgs;
  snapshot: TerminalRunSnapshot;
  key: string;
  fallbackPath: string;
  required: boolean;
}): string {
  const ref = input.snapshot.patch?.artifactRefs[input.key];
  const expectedHash = input.snapshot.patch?.artifactHashes[input.key];
  if (ref === undefined && expectedHash === undefined) {
    if (input.required) {
      throw new Error(
        `terminal finalizer durable patch ${input.snapshot.runId} is missing artifact ${input.key}`,
      );
    }
    return resolve(input.fallbackPath);
  }
  if (ref === undefined || expectedHash === undefined) {
    throw new Error(
      `terminal finalizer durable artifact ${input.key} has an incomplete ref/hash pair for ${input.snapshot.runId}`,
    );
  }
  const path = resolve(ref);
  const actualHash = hashLocalizationArtifact(path);
  if (actualHash !== expectedHash) {
    throw new Error(
      `terminal finalizer durable artifact ${input.key} hash mismatch in ${input.args.runDir}`,
    );
  }
  return path;
}

function loadTerminalPatchReport(
  args: RunLocalizeFullProjectLiveArgs,
  config: LocalizeFullProjectConfig,
  runId: string,
  snapshot: TerminalRunSnapshot,
  requirePersistedArtifact: boolean,
): DrivenPatchReport {
  const path = terminalArtifactPath({
    args,
    snapshot,
    key: "patchReport",
    fallbackPath: resolve(args.runDir, "patch-report.json"),
    required: requirePersistedArtifact,
  });
  const value = args.io.readJson(path);
  assertDrivenPatchReport(value);
  if (
    value.journalRunId !== runId ||
    value.projectId !== config.projectId ||
    value.localeBranchId !== config.localeBranchId ||
    value.engineProfile !== config.engineProfile ||
    value.targetLocale !== (config.targetLocale ?? "en-US") ||
    (config.translationScope !== undefined && value.translationScope !== config.translationScope)
  ) {
    throw new Error(`terminal finalizer patch report does not match durable resume ${runId}`);
  }
  return value;
}

function assertDrivenPatchReport(value: unknown): asserts value is DrivenPatchReport {
  if (typeof value !== "object" || value === null) {
    throw new Error("terminal finalizer patch report is malformed");
  }
  const report = value as Record<string, unknown>;
  const stringFields = [
    "journalRunId",
    "projectId",
    "localeBranchId",
    "targetLocale",
    "totalUsageCostExactUsd",
    "sourceBridgeHash",
  ] as const;
  const numberFields = [
    "unitsEnumerated",
    "unitsInScope",
    "unitsRun",
    "writtenOutcomeCount",
    "failureCount",
    "reviewerQueueItemCount",
    "totalUsageCostUsd",
  ] as const;
  const booleanFields = ["zdrConfirmed", "budgetStopped", "coverageComplete"] as const;
  const pair = report.pair as Record<string, unknown> | undefined;
  const writtenUnits = report.writtenUnits;
  const valid =
    report.schemaVersion === "itotori.project-driven-executor.patch-report.v0" &&
    stringFields.every(
      (field) => typeof report[field] === "string" && (report[field] as string).length > 0,
    ) &&
    numberFields.every(
      (field) => typeof report[field] === "number" && Number.isFinite(report[field] as number),
    ) &&
    booleanFields.every((field) => typeof report[field] === "boolean") &&
    (report.engineProfile === "reallive" || report.engineProfile === "rpg-maker-mv-mz") &&
    ["dialogue-only", "dialogue-and-choices", "dialogue-choices-ui", "all"].includes(
      report.translationScope as string,
    ) &&
    typeof pair === "object" &&
    pair !== null &&
    typeof pair.modelId === "string" &&
    pair.modelId.length > 0 &&
    typeof pair.providerId === "string" &&
    pair.providerId.length > 0 &&
    Array.isArray(writtenUnits) &&
    writtenUnits.every((unit) => {
      if (typeof unit !== "object" || unit === null) return false;
      const entry = unit as Record<string, unknown>;
      return (
        typeof entry.bridgeUnitId === "string" &&
        entry.bridgeUnitId.length > 0 &&
        typeof entry.sourceUnitKey === "string" &&
        entry.sourceUnitKey.length > 0 &&
        typeof entry.selectedBody === "string" &&
        entry.selectedBody.trim().length > 0 &&
        Array.isArray(entry.qualityFlags) &&
        entry.qualityFlags.every((flag) => typeof flag === "string")
      );
    });
  if (!valid) throw new Error("terminal finalizer patch report is malformed");
}

function loadTerminalPatchBuild(
  args: RunLocalizeFullProjectLiveArgs,
  runId: string,
  snapshot: TerminalRunSnapshot,
): WholeGamePatchBuildResult {
  const path = terminalArtifactPath({
    args,
    snapshot,
    key: "patchExport",
    fallbackPath: resolve(args.runDir, "patch-export-bundle.json"),
    required: true,
  });
  const value = args.io.readJson(path);
  assertPatchExportBundle(value);
  return {
    patchExportBundle: value,
    draftArtifactBundleId: `wholegame-run:${runId}`,
  };
}

function loadTerminalPatchApply(
  args: RunLocalizeFullProjectLiveArgs,
  build: WholeGamePatchBuildResult,
  snapshot: TerminalRunSnapshot,
): WholeGamePatchApplyResult {
  const path = terminalArtifactPath({
    args,
    snapshot,
    key: "patchApply",
    fallbackPath: resolve(args.runDir, "patch-apply.json"),
    required: true,
  });
  const value = args.io.readJson(path);
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { command?: unknown }).command !== "string" ||
    !Array.isArray((value as { args?: unknown }).args) ||
    (value as { args: unknown[] }).args.some((entry) => typeof entry !== "string") ||
    (value as { status?: unknown }).status !== 0 ||
    typeof (value as { stdout?: unknown }).stdout !== "string" ||
    typeof (value as { stderr?: unknown }).stderr !== "string"
  ) {
    throw new Error("terminal finalizer patch-apply receipt is malformed");
  }
  return { ...build, apply: value as WholeGamePatchApplyResult["apply"] };
}

function invalidateRunSummary(runDir: string): void {
  rmSync(join(runDir, "run-summary.json"), { force: true });
}
