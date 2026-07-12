// Durable live wiring for `itotori localize-project-stage`.
//
// The single-unit stage used to construct a standalone InvocationSupervisor,
// which meant a paid OpenRouter call had no run-cost reservation or durable
// completion reconciliation. Keep the artifact-producing command small, but
// give it the exact same database-backed admission adapter as the full-project
// driver before it can construct a provider.

import { randomUUID } from "node:crypto";
import {
  ItotoriLocalizationJournalRepository,
  ItotoriProjectRepository,
  bootstrapLocalUser,
  createDatabaseContext,
  databaseUrlFromEnv,
} from "@itotori/db";
import { assertBridgeBundleV02, type BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import { DrivenJournalPersistenceAdapter } from "./project-driven-executor-sinks.js";
import {
  parseLocalizeProjectPairPolicy,
  runLocalizeProjectStageCommand,
  type LocalizeProjectStageArgs,
} from "./localize-project-stage-command.js";
import type { DrivenJournalRunPlan } from "./project-driven-executor.js";

export type RunLocalizeProjectStageLiveArgs = Omit<
  LocalizeProjectStageArgs,
  "actor" | "supervision"
> & {
  /** Exact durable run cap; omit it for an unlimited, still-accounted run. */
  budgetCapUsd?: number;
  /** Test-only DB override; production resolves DATABASE_URL normally. */
  databaseUrl?: string;
};

/**
 * Drive one live stage under the durable journal's atomic cost-admission
 * boundary. The command core receives no production fallback: every physical
 * attempt is reserved and reconciled through this adapter.
 */
export async function runLocalizeProjectStageLive(args: RunLocalizeProjectStageLiveArgs) {
  const scope = stageRunScope(args);
  const databaseUrl = args.databaseUrl ?? databaseUrlFromEnv();
  const context = createDatabaseContext(databaseUrl);
  try {
    const actor = await bootstrapLocalUser(context.db);
    const projectRepository = new ItotoriProjectRepository(context.db);
    await projectRepository.ensureRunProjectScope(actor, {
      projectId: scope.projectId,
      localeBranchId: scope.localeBranchId,
      sourceRevisionId: scope.sourceRevisionId,
      sourceLocale: scope.sourceLocale,
      targetLocale: "en-US",
    });

    const journal = new ItotoriLocalizationJournalRepository(context.db);
    const adapter = new DrivenJournalPersistenceAdapter(journal, { actor });
    await adapter.beginJournalRun(scope.plan, "new");

    try {
      return await runLocalizeProjectStageCommand({
        ...args,
        actor,
        supervision: {
          runId: scope.runId,
          lifecycle: adapter,
          costAdmission: adapter.createCostAdmission(scope.runId),
        },
      });
    } catch (error) {
      // A paused single-unit stage has no worker pool to release the fence for
      // it. Once the supervisor has settled its one active call, make the
      // operator-actionable run immediately resumable, mirroring the executor.
      const run = await journal.loadRun(actor, scope.runId);
      if (run?.status === "paused") {
        await adapter.releasePausedRunLease(scope.runId);
      }
      throw error;
    }
  } finally {
    await context.close();
  }
}

function stageRunScope(args: RunLocalizeProjectStageLiveArgs): {
  runId: string;
  projectId: string;
  localeBranchId: string;
  sourceRevisionId: string;
  sourceLocale: string;
  plan: DrivenJournalRunPlan;
} {
  const rawBridge = args.io.readJson(args.bridgePath);
  assertBridgeBundleV02(rawBridge);
  const bridge = rawBridge as BridgeBundleV02;
  const unitIndex = args.unitIndex ?? 0;
  if (!Number.isInteger(unitIndex) || unitIndex < 0 || unitIndex >= bridge.units.length) {
    throw new Error(
      `localize-project-stage refused: --unit-index ${String(unitIndex)} out of range; bridge has ${String(bridge.units.length)} unit(s)`,
    );
  }
  const unit = bridge.units[unitIndex];
  if (unit === undefined) {
    throw new Error("localize-project-stage refused: bridge unit lookup returned undefined");
  }
  if (
    args.budgetCapUsd !== undefined &&
    (!Number.isFinite(args.budgetCapUsd) || args.budgetCapUsd <= 0)
  ) {
    throw new Error(
      `localize-project-stage refused: --cost-cap-usd '${String(args.budgetCapUsd)}' must be a positive number`,
    );
  }
  const { pairPolicy } = parseLocalizeProjectPairPolicy(args.io.readJson(args.pairPolicyPath));
  const runId = `localize-project-stage-run-${randomUUID()}`;
  const projectId = bridge.bridgeId;
  const sourceRevisionId = unit.sourceRevision.revisionId;
  const localeBranchId = `branch:${sourceRevisionId}`;
  const plan: DrivenJournalRunPlan = {
    run: {
      runId,
      projectId,
      localeBranchId,
      sourceRevisionId,
      targetLocale: "en-US",
    },
    frozenScope: { translationScope: "all", bridgeUnitIds: [unit.bridgeUnitId] },
    routingPolicy: pairPolicy,
    costPolicy: {
      budgetCapUsd: args.budgetCapUsd ?? null,
      reservation: "node_4_seam",
    },
    units: [
      {
        bridgeUnitId: unit.bridgeUnitId,
        sourceUnitKey: unit.sourceUnitKey,
        nextAction: { kind: "drive_unit", stage: "context" },
      },
    ],
  };
  return {
    runId,
    projectId,
    localeBranchId,
    sourceRevisionId,
    sourceLocale: bridge.sourceLocale,
    plan,
  };
}
