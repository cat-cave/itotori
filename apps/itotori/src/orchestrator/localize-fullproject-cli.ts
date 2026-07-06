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
 */
export async function runLocalizeFullProjectLive(
  args: RunLocalizeFullProjectLiveArgs,
): Promise<LocalizeFullProjectResult> {
  // Privacy gate BEFORE any live byte.
  assertOpenRouterZdrAccount(process.env);

  // The pair + identity are read from the config + pair-policy so the DB
  // persistence adapter records the SAME pinned pair the executor drives with.
  const config = parseLocalizeFullProjectConfig(args.io.readJson(args.configPath));
  const { pair } = parseLocalizeProjectPairPolicy(args.io.readJson(config.pairPolicyPath));

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

    return await runLocalizeFullProjectCommand({
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
    });
  } finally {
    await context.close();
  }
}
