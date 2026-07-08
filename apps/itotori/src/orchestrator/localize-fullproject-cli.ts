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
  ItotoriDraftAttemptProviderLedgerRepository,
  ItotoriDraftJobRepository,
  ItotoriLocalizationPassLedgerRepository,
  ItotoriReviewerQueueRepository,
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
  PipelineFailureDiagnosticError,
  runPipelineStepWithDiagnostic,
} from "./pipeline-failure-diagnostic.js";

export type RunLocalizeFullProjectLiveArgs = {
  configPath: string;
  /** Directory the patch export + provider-run artifacts + run summary land in. */
  runDir: string;
  io: LocalizeFullProjectIo;
  /** Per-process USD cost cap for the OpenRouter provider. Defaults to $0.50. */
  costCapUsd?: number;
  log?: (message: string) => void;
};

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
): Promise<LocalizeFullProjectResult> {
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

    const draftJobRepo = new ItotoriDraftJobRepository(context.db);
    const ledgerRepo = new ItotoriDraftAttemptProviderLedgerRepository(context.db);
    const reviewerQueueRepo = new ItotoriReviewerQueueRepository(context.db);
    const passLedgerRepo = new ItotoriLocalizationPassLedgerRepository(context.db);

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

    return await runPipelineStepWithDiagnostic({
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
          deps: {
            io: args.io,
            actor,
            providerFactory,
            sinks: { draft: dbAdapter, providerRun: dbAdapter, patchExport: patchSink },
            passLedger: new DbPassLedger(passLedgerRepo),
            reviewerQueue: { repository: reviewerQueueRepo },
            ...(args.log !== undefined ? { log: args.log } : {}),
          },
        }),
    });
  } catch (error) {
    // Already a structured diagnostic → rethrow untouched (upstream has the
    // more specific step + context).
    if (error instanceof PipelineFailureDiagnosticError) {
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
