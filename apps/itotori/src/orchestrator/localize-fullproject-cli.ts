// itotori-localize-fullproject-cli — LIVE wiring for `itotori localize`.
//
// Binds the pure whole-project driver (`runLocalizeFullProjectCommand`) to real
// production dependencies: a live Postgres context (draft-job + provider-ledger
// + reviewer-queue + pass-ledger repositories), the DB-backed pass ledger
// adapter, on-disk patch export, and the LIVE OpenRouter provider (ZDR-routed).
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

import { join } from "node:path";
import {
  ItotoriAssetLocalizationDecisionRepository,
  ItotoriDraftAttemptProviderLedgerRepository,
  ItotoriDraftJobRepository,
  ItotoriLocalizationPassLedgerRepository,
  ItotoriProjectRepository,
  ItotoriReviewerQueueRepository,
  ItotoriTranslationScopeSettingsRepository,
  bootstrapLocalUser,
  createDatabaseContext,
  databaseUrlFromEnv,
  localUserId,
  type AuthorizationActor,
} from "@itotori/db";
import {
  assertOpenRouterZdrAccount,
  LocalProviderRunArtifactRecorder,
} from "../providers/index.js";
import { DEFAULT_COST_CAP_USD } from "../providers/openrouter.js";
import { liveOpenRouterFactory } from "./localize-project-stage-command.js";
import { parseLocalizeProjectPairPolicy } from "./localize-project-stage-command.js";
import {
  DrivenDbPersistenceAdapter,
  FsDrivenPatchExportSink,
} from "./project-driven-executor-sinks.js";
import { DbPassLedger } from "./pass-ledger-db-adapter.js";
import {
  parseLocalizeFullProjectConfig,
  runLocalizeFullProjectCommand,
  type LocalizeFullProjectIo,
  type LocalizeFullProjectResult,
} from "./localize-fullproject-command.js";
import {
  runWholeGamePatchExportAndApply,
  type WholeGamePatchExportAndApplyResult,
} from "./patch-apply-seam.js";
import type { WholeGameRuntimeValidationAdmission } from "./wholegame-render-validation-seam.js";
import {
  PipelineFailureDiagnosticError,
  redactDiagnosticError,
  runPipelineStepWithDiagnostic,
} from "./pipeline-failure-diagnostic.js";
import type { NativeCliRunner } from "../native-bin/cli-bin-resolver.js";
import type { DrivenPatchReport } from "./project-driven-executor.js";

/**
 * Schema version for the abort diagnostic written to `<run-dir>/run-diagnostic.json`
 * whenever a live localize pass throws. Distinct from the success-path
 * `run-summary.json` (which only lands when the pass completes without throwing).
 */
const RUN_DIAGNOSTIC_SCHEMA_VERSION = "itotori.localize-fullproject.run-diagnostic.v0" as const;

export type RunLocalizeFullProjectLiveArgs = {
  configPath: string;
  /** Directory the patch export + provider-run artifacts + run summary land in. */
  runDir: string;
  io: LocalizeFullProjectIo;
  /** Per-process USD cost cap for the OpenRouter provider. Defaults to $0.50. */
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
  log?: (message: string) => void;
};

export type RunLocalizeFullProjectLiveResult = LocalizeFullProjectResult & {
  /** Present when the source + target roots drove the patch-apply seam. */
  patchApply?: WholeGamePatchExportAndApplyResult;
};

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
 * whole project through the multi-pass ledger. Tears the DB context down in a
 * `finally` so a failure never leaks a connection.
 *
 * itotori-agent-facing-pipeline-failure-diagnostics — every step failure here
 * is wrapped in a `PipelineFailureDiagnosticError` so the CLI surfaces a
 * structured diagnostic (step + inputs + repro) instead of a bare `Error`. The
 * top-level try/catch rethrows any NON-diagnostic error as a structured
 * diagnostic tagged `localize.run-pass` so a driving agent never sees an
 * unstructured throw.
 */
export async function runLocalizeFullProjectLive(
  args: RunLocalizeFullProjectLiveArgs,
): Promise<RunLocalizeFullProjectLiveResult> {
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
    inputs: { configPath: args.configPath, runDir: args.runDir },
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

    // wholegame-localize-project-provisioning — the driven executor persists
    // draft jobs (FK -> itotori_projects + itotori_locale_branches) and the
    // pass ledger persists a row (FK -> ... + itotori_source_revisions) keyed
    // on this run's config identity. Those parent rows are NOT created anywhere
    // else in the whole-game path, so the first live draft-job batch violated
    // the FK. Provision the identity graph idempotently BEFORE any live persist.
    // The source locale comes from the run's bridge bundle, so this is
    // game-agnostic (no hardcoded locale / no per-game special-casing).
    const projectRepo = new ItotoriProjectRepository(context.db);
    await runPipelineStepWithDiagnostic({
      step: "localize.provision-project-scope",
      code: "unknown",
      message:
        "localize-live: provision-project-scope failed: could not upsert the project / locale-branch / source-revision graph the draft-job + pass-ledger FKs require",
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

    const draftJobRepo = new ItotoriDraftJobRepository(context.db);
    const ledgerRepo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);
    const reviewerQueueRepo = new ItotoriReviewerQueueRepository(context.db);
    const passLedgerRepo = new ItotoriLocalizationPassLedgerRepository(context.db);
    const assetDecisionRepo = new ItotoriAssetLocalizationDecisionRepository(context.db);
    // itotori-translation-scope-configuration-ui — the SAME repository the
    // `settings.translationScope.save` API route persists through, so a
    // project/branch owner's Studio scope selection is the real DB-backed
    // default this live run resolves when its config JSON omits
    // `translationScope`.
    const translationScopeSettingsRepo = new ItotoriTranslationScopeSettingsRepository(context.db);

    const dbAdapter = new DrivenDbPersistenceAdapter(draftJobRepo, ledgerRepo, {
      projectId: config.projectId,
      localeBranchId: config.localeBranchId,
      actor,
      pair,
    });
    const patchSink = new FsDrivenPatchExportSink(args.runDir);
    const artifactRecorder = new LocalProviderRunArtifactRecorder(
      join(args.runDir, "provider-runs"),
    );
    const providerFactory = liveOpenRouterFactory({
      costCapUsd: args.costCapUsd ?? DEFAULT_COST_CAP_USD,
      artifactRecorder,
    });
    let patchApply: WholeGamePatchExportAndApplyResult | undefined;

    const passResult = await runPipelineStepWithDiagnostic({
      step: "localize.run-pass",
      code: "unknown",
      message: `localize-live: run-pass failed: the driven executor / pass-ledger step aborted`,
      inputs: {
        configPath: args.configPath,
        bridgePath: config.bridgePath,
        pairPolicyPath: config.pairPolicyPath,
        runDir: args.runDir,
        projectId: config.projectId,
        localeBranchId: config.localeBranchId,
        pair,
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
          runSummaryPath: join(args.runDir, "run-summary.json"),
          ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
          deps: {
            io: args.io,
            actor,
            providerFactory,
            sinks: { writtenOutcome: dbAdapter, providerRun: dbAdapter, patchExport: patchSink },
            passLedger: new DbPassLedger(passLedgerRepo),
            reviewerQueue: { repository: reviewerQueueRepo },
            translationScopeSettings: {
              resolveScope: (projectId, localeBranchId) =>
                translationScopeSettingsRepo.resolveScope(projectId, localeBranchId),
            },
            ...(args.sourceRoot !== undefined &&
            args.sourceRoot.length > 0 &&
            args.patchTargetRoot !== undefined &&
            args.patchTargetRoot.length > 0
              ? {
                  afterExecutor: async (result) => {
                    const allowPartialPatch = args.allowPartialPatch ?? false;
                    assertWholeGamePatchCoverage(result.patchReport, allowPartialPatch);
                    const sourceRoot = args.sourceRoot!;
                    const patchTargetRoot = args.patchTargetRoot!;
                    const rawBridge = args.io.readJson(config.bridgePath);
                    // The export-patch preflight is engine-agnostic; the apply
                    // step dispatches on engineProfile inside the seam. RealLive
                    // additionally runs utsushi replay/render validation (a
                    // from-scratch VM oracle); RPG Maker MV/MZ is a delegation
                    // runtime with no such seam, so it emits the `.kaifuu` delta
                    // + patched `data` tree and skips render validation.
                    const isRealLive = config.engineProfile === "reallive";
                    patchApply = await runPipelineStepWithDiagnostic({
                      step: "localize.apply-patch",
                      code: "unknown",
                      message: `localize-live: apply-patch failed: kaifuu patch / export-patch preflight aborted`,
                      inputs: {
                        configPath: args.configPath,
                        runDir: args.runDir,
                        projectId: config.projectId,
                        localeBranchId: config.localeBranchId,
                        engineProfile: config.engineProfile,
                      },
                      repro: {
                        configPath: args.configPath,
                        bridgePath: config.bridgePath,
                      },
                      actor,
                      run: () =>
                        runWholeGamePatchExportAndApply({
                          actor,
                          engineProfile: config.engineProfile,
                          draftJobs: draftJobRepo,
                          ledger: ledgerRepo,
                          patchReport: result.patchReport,
                          rawBridge,
                          sourceRoot,
                          targetRoot: patchTargetRoot,
                          translatedBundlePath: join(args.runDir, "translated-bridge.json"),
                          requestedBy: localUserId,
                          loadActiveDecisions: (a, projectId, localeBranchId) =>
                            assetDecisionRepo.loadActiveDecisions(a, projectId, localeBranchId),
                          ...(isRealLive
                            ? {}
                            : {
                                rpgMakerDeltaOutputPath: join(args.runDir, "rpgmaker-delta.kaifuu"),
                              }),
                          ...(isRealLive
                            ? {
                                renderValidation: {
                                  artifactRoot: join(args.runDir, "wholegame-render-validation"),
                                  redaction: "on",
                                  ...(args.nativeCli !== undefined
                                    ? { nativeCli: args.nativeCli }
                                    : {}),
                                  ...(args.log !== undefined ? { log: args.log } : {}),
                                },
                              }
                            : {}),
                          ...(args.log !== undefined ? { log: args.log } : {}),
                        }),
                    });
                    return patchApply.renderValidation === undefined
                      ? result
                      : { ...result, runtimeValidation: patchApply.renderValidation };
                  },
                }
              : {}),
            ...(args.log !== undefined ? { log: args.log } : {}),
          },
        }),
    });
    if (patchApply?.runtimeValidationAdmission?.kind === "runtime-validation-incomplete") {
      throw new RuntimeValidationIncompleteError(
        patchApply.runtimeValidationAdmission,
        args.patchTargetRoot!,
      );
    }
    return patchApply === undefined ? passResult : { ...passResult, patchApply };
  } catch (error) {
    // OBSERVABILITY (#78): a pass that aborts must NEVER be silent. `cli.ts`
    // prints only the generic wrapper `.message`, so without this the real
    // underlying error (e.g. the reviewer-queue FK violation surfaced during
    // the post-drive persist loop) is thrown away and no artifact lands in the
    // run dir. Persist a structured abort diagnostic BEFORE rethrowing so a
    // reviewer can always SEE which step aborted and why. No game bytes: the
    // diagnostic carries only the step + scrubbed error class/message + config
    // identity — never source/draft text.
    const abortDiagnostic =
      error instanceof PipelineFailureDiagnosticError
        ? {
            step: error.diagnostic.step,
            error: error.diagnostic.error,
            repro: error.diagnostic.repro,
          }
        : {
            step: "localize.run-pass" as const,
            error: redactDiagnosticError(error),
            repro: {
              configPath: args.configPath,
              bridgePath: config.bridgePath,
              pairPolicyPath: config.pairPolicyPath,
            },
          };
    try {
      args.io.writeJson(join(args.runDir, "run-diagnostic.json"), {
        schemaVersion: RUN_DIAGNOSTIC_SCHEMA_VERSION,
        aborted: true,
        abortedStep: abortDiagnostic.step,
        error: abortDiagnostic.error,
        repro: abortDiagnostic.repro,
        configPath: args.configPath,
        runDir: args.runDir,
        occurredAt: new Date().toISOString(),
      });
    } catch {
      // Best-effort: a diagnostic-write failure must never mask the real abort.
    }
    // Already a structured diagnostic → rethrow untouched (upstream has the
    // more specific step + context).
    if (
      error instanceof PipelineFailureDiagnosticError ||
      error instanceof RuntimeValidationIncompleteError ||
      error instanceof WholeGamePatchCoverageRefusedError
    ) {
      throw error;
    }
    // Anything else (a Postgres bootstrap error, a transport drop, a missing
    // env var) is wrapped as a structured diagnostic so the CLI never emits a
    // bare `Error`. Step is the most general one — the message preserves the
    // original error class + scrubbed message for triage.
    throw await runPipelineStepWithDiagnostic({
      step: "localize.run-pass",
      code: "unknown",
      message: `localize-live: run-pass failed: ${error instanceof Error ? error.message : String(error)}`,
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
