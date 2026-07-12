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
import { join, resolve } from "node:path";
import { assertPatchExportBundle } from "@itotori/localization-bridge-schema";
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
import {
  PipelineFailureDiagnosticError,
  runPipelineStepWithDiagnostic,
} from "./pipeline-failure-diagnostic.js";
import type { NativeCliRunner } from "../native-bin/cli-bin-resolver.js";
import type { DrivenPatchReport, ProjectDrivenExecutorResult } from "./project-driven-executor.js";
import { DbTerminalRunFinalizerAdapter } from "./terminal-run-finalizer-db-adapter.js";
import {
  finalizeTerminalRun,
  TerminalRunOperationalBlockerError,
  type TerminalFinalizerFaultFactory,
  type TerminalFinalizerStage,
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

    // The durable journal run is FK-bound to the project / locale branch /
    // source revision identity. Those parent rows are not created elsewhere in
    // the whole-game path, so provision the graph idempotently before writing
    // the first physical provider attempt.
    // The source locale comes from the run's bridge bundle, so this is
    // game-agnostic (no hardcoded locale / no per-game special-casing).
    const projectRepo = new ItotoriProjectRepository(context.db);
    await runPipelineStepWithDiagnostic({
      step: "localize.provision-project-scope",
      code: "unknown",
      message:
        "localize-live: provision-project-scope failed: could not upsert the project / locale-branch / source-revision graph the journal FKs require",
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
      run: () =>
        projectRepo.ensureRunProjectScope(actor, {
          projectId: config.projectId,
          localeBranchId: config.localeBranchId,
          sourceRevisionId: config.sourceRevisionId,
          targetLocale: config.targetLocale ?? "en-US",
          sourceLocale: readBridgeSourceLocale(
            args.io.readJson(config.bridgePath),
            config.bridgePath,
          ),
        }),
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
    const providerFactory = liveOpenRouterFactory({
      artifactRecorder,
    });
    let patchApply: WholeGamePatchExportAndApplyResult | undefined;
    let patchBuild: WholeGamePatchBuildResult | undefined;
    let patchApplied: WholeGamePatchApplyResult | undefined;
    const terminalRunId = args.resumeRunId ?? `localization-journal-run-${randomUUID()}`;
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

    let runtimeValidationError: RuntimeValidationIncompleteError | undefined;
    let patchWorkerError: unknown;
    const requirePatchArgs = (): RunWholeGamePatchExportAndApplyArgs => {
      if (passError !== undefined) throw passError;
      if (passResult === undefined) {
        throw new Error(`terminal finalizer has no executor result for ${terminalRunId}`);
      }
      if (
        args.sourceRoot === undefined ||
        args.sourceRoot.length === 0 ||
        args.patchTargetRoot === undefined ||
        args.patchTargetRoot.length === 0
      ) {
        throw new TerminalRunOperationalBlockerError({
          kind: "itotori_bug",
          detail: "patch build/apply awaits --source and --patch-target inputs",
          evidence: `terminal-run:${terminalRunId};run-dir:${args.runDir}`,
          raisedAt: new Date().toISOString(),
          operatorAction: "supply the patch source and target roots, then resume this run",
        });
      }
      assertWholeGamePatchCoverage(passResult.result.patchReport, args.allowPartialPatch ?? false);
      const isRealLive = config.engineProfile === "reallive";
      return {
        actor,
        engineProfile: config.engineProfile,
        journal: journalRepo,
        patchReport: passResult.result.patchReport,
        rawBridge: args.io.readJson(config.bridgePath),
        sourceRoot: args.sourceRoot,
        targetRoot: args.patchTargetRoot,
        translatedBundlePath: resolve(args.runDir, "translated-bridge.json"),
        requestedBy: localUserId,
        loadActiveDecisions: (a, projectId, localeBranchId) =>
          assetDecisionRepo.loadActiveDecisions(a, projectId, localeBranchId),
        ...(isRealLive
          ? {}
          : { rpgMakerDeltaOutputPath: resolve(args.runDir, "rpgmaker-delta.kaifuu") }),
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
    const finalization = await finalizeTerminalRun({
      runId: passResult?.result.journalRunId ?? terminalRunId,
      persistence: terminalPersistence,
      ...(args.cancelled === undefined ? {} : { cancelled: args.cancelled }),
      ...(args.finalizerStageFaults === undefined
        ? {}
        : { stageFaults: args.finalizerStageFaults }),
      workers: {
        patch_build: async () => {
          try {
            const patchArgs = requirePatchArgs();
            patchBuild = await runPipelineStepWithDiagnostic({
              step: "localize.apply-patch",
              code: "unknown",
              message: `localize-live: build-patch failed: export-patch preflight aborted`,
              inputs: {
                configPath: args.configPath,
                runDir: args.runDir,
                projectId: config.projectId,
                localeBranchId: config.localeBranchId,
                engineProfile: config.engineProfile,
              },
              repro: { configPath: args.configPath, bridgePath: config.bridgePath },
              actor,
              run: () => buildWholeGamePatchExport(patchArgs),
            });
          } catch (error) {
            patchWorkerError = error;
            throw error;
          }
          return terminalPatchBuildArtifacts({ args, patchBuild: patchBuild! });
        },
        patch_apply: async () => {
          try {
            const patchArgs = requirePatchArgs();
            patchBuild ??= loadTerminalPatchBuild(args, terminalRunId);
            patchApplied = await runPipelineStepWithDiagnostic({
              step: "localize.apply-patch",
              code: "unknown",
              message: `localize-live: apply-patch failed: kaifuu patch aborted`,
              inputs: {
                configPath: args.configPath,
                runDir: args.runDir,
                projectId: config.projectId,
                localeBranchId: config.localeBranchId,
                engineProfile: config.engineProfile,
              },
              repro: { configPath: args.configPath, bridgePath: config.bridgePath },
              actor,
              run: () => applyWholeGamePatch(patchArgs, patchBuild!),
            });
          } catch (error) {
            patchWorkerError = error;
            throw error;
          }
          return terminalPatchApplyArtifacts({ args, config, patchApplied: patchApplied! });
        },
        validation: async () => {
          try {
            const patchArgs = requirePatchArgs();
            patchBuild ??= loadTerminalPatchBuild(args, terminalRunId);
            patchApplied ??= loadTerminalPatchApply(args, patchBuild);
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
          return terminalPatchValidationArtifacts({ args, config, patchApply: patchApply! });
        },
        summary: async ({ summary }) => {
          if (summary === undefined)
            throw new Error("terminal summary worker received no canonical summary");
          args.io.writeJson(join(args.runDir, "run-summary.json"), summary);
          return { evidence: { path: join(args.runDir, "run-summary.json") } };
        },
      },
    });

    if (passError !== undefined) throw passError;
    if (patchWorkerError !== undefined) throw patchWorkerError;
    if (runtimeValidationError !== undefined) throw runtimeValidationError;
    if (finalization.terminalStatus === "failed") {
      throw new TerminalRunFailedError(finalization.summary);
    }
    if (passResult === undefined) {
      throw new TerminalRunFailedError(finalization.summary);
    }
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

/**
 * Resume only a durable post-executor boundary. Returning `null` means the
 * requested run is still an executor-owned running/paused run with no canonical
 * summary and the normal live path must handle it. Finalizing and terminal runs
 * intentionally construct no provider, config, or patch input from process
 * memory; terminal retries only reproject their canonical DB summary.
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
    const isCommittedTerminalBoundary =
      snapshot.runStatus === "succeeded" ||
      snapshot.runStatus === "failed" ||
      snapshot.runStatus === "aborted" ||
      (snapshot.runStatus === "paused" && existingSummary !== null);
    if (snapshot.runStatus !== "finalizing" && !isCommittedTerminalBoundary) return null;
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

    const finalization = await finalizeTerminalRun({
      runId,
      persistence,
      ...(args.cancelled === undefined ? {} : { cancelled: args.cancelled }),
      ...(args.finalizerStageFaults === undefined
        ? {}
        : { stageFaults: args.finalizerStageFaults }),
      workers: {
        // Every physical patch worker completed before an unconfirmed terminal
        // commit. The core skips those durable succeeded outbox keys. If a DB
        // row is unexpectedly incomplete, fail closed instead of manufacturing
        // a successful no-op worker result in this executor-free path.
        patch_build: () => {
          throw new Error(`finalizing resume found incomplete patch_build for ${runId}`);
        },
        patch_apply: () => {
          throw new Error(`finalizing resume found incomplete patch_apply for ${runId}`);
        },
        validation: () => {
          throw new Error(`finalizing resume found incomplete validation for ${runId}`);
        },
        summary: ({ summary }) => {
          if (summary === undefined) {
            throw new Error("terminal summary worker received no canonical summary");
          }
          args.io.writeJson(join(args.runDir, "run-summary.json"), summary);
          return { evidence: { path: join(args.runDir, "run-summary.json") } };
        },
      },
    });

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
 * Read the BCP-47 source locale off the run's bridge bundle (a top-level
 * `sourceLocale` on both the v0.1 and v0.2 BridgeBundle shapes). Used to
 * provision the project/source-bundle source locale from the real extracted
 * bytes rather than a hardcoded default — keeping the whole-game path
 * game-agnostic.
 */
function readBridgeSourceLocale(rawBridge: unknown, bridgePath: string): string {
  if (
    typeof rawBridge === "object" &&
    rawBridge !== null &&
    "sourceLocale" in rawBridge &&
    typeof (rawBridge as { sourceLocale: unknown }).sourceLocale === "string" &&
    (rawBridge as { sourceLocale: string }).sourceLocale.length > 0
  ) {
    return (rawBridge as { sourceLocale: string }).sourceLocale;
  }
  throw new Error(
    `localize-live: bridge bundle at '${bridgePath}' is missing a non-empty top-level string 'sourceLocale'; cannot provision the project source locale`,
  );
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
  patchApplied: WholeGamePatchApplyResult;
}) {
  const patchApplyPath = resolve(input.args.runDir, "patch-apply.json");
  input.args.io.writeJson(patchApplyPath, input.patchApplied.apply);
  const paths: Record<string, string> = {
    patchApply: patchApplyPath,
    patchTarget: resolve(requireArtifactPath(input.args.patchTargetRoot, "patch target")),
  };
  if (input.config.engineProfile === "rpg-maker-mv-mz") {
    paths.rpgMakerDelta = resolve(input.args.runDir, "rpgmaker-delta.kaifuu");
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

function loadTerminalPatchBuild(
  args: RunLocalizeFullProjectLiveArgs,
  runId: string,
): WholeGamePatchBuildResult {
  const value = args.io.readJson(resolve(args.runDir, "patch-export-bundle.json"));
  assertPatchExportBundle(value);
  return {
    patchExportBundle: value,
    draftArtifactBundleId: `wholegame-run:${runId}`,
  };
}

function loadTerminalPatchApply(
  args: RunLocalizeFullProjectLiveArgs,
  build: WholeGamePatchBuildResult,
): WholeGamePatchApplyResult {
  const value = args.io.readJson(resolve(args.runDir, "patch-apply.json"));
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

function requireArtifactPath(path: string | undefined, label: string): string {
  if (path === undefined || path.trim().length === 0) {
    throw new Error(`terminal finalizer requires a non-blank ${label} artifact path`);
  }
  return resolve(path);
}
