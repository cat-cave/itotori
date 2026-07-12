import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashLocalizationArtifact,
  ItotoriLocalizationJournalRepository,
  ItotoriLocalizationRunFinalizerRepository,
  localUserId,
  type AuthorizationActor,
  type LocalizationJournalRunLeaseIdentity,
} from "@itotori/db";
import { asNonBlankTargetText, type WrittenUnitOutcome } from "@itotori/localization-bridge-schema";
import { describe, expect, it } from "vitest";
import { DbTerminalRunFinalizerAdapter } from "../src/orchestrator/terminal-run-finalizer-db-adapter.js";
import {
  finalizeTerminalRun,
  TerminalRunFinalizerBusyError,
  terminalFinalizerStageValues,
  type TerminalFinalizerStage,
  type TerminalFinalizerWorkerPorts,
} from "../src/orchestrator/terminal-run-finalizer.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };
const driverLease: LocalizationJournalRunLeaseIdentity = {
  ownerId: "terminal-finalizer-live-db-driver",
  fenceToken: 1,
};
const scope = {
  projectId: "project-terminal-finalizer-live-db",
  localeBranchId: "branch-terminal-finalizer-live-db",
  sourceRevisionId: "revision-terminal-finalizer-live-db",
  targetLocale: "en-US",
} as const;

describe.skipIf(!process.env.DATABASE_URL)("production terminal finalizer adapter", () => {
  it.each(terminalFinalizerStageValues)(
    "persists exactly one canonical DB summary when %s is fault-injected",
    async (stage) => {
      const context = await isolatedMigratedContext();
      const artifact = createRealArtifact(stage);
      try {
        await seedScope(context);
        const journal = new ItotoriLocalizationJournalRepository(context.db);
        const finalizerRepository = new ItotoriLocalizationRunFinalizerRepository(context.db);
        const runId = `terminal-finalizer-live-db-${stage.replaceAll("_", "-")}`;
        const unitId = `${runId}-unit`;

        await journal.seedRun(actor, {
          runId,
          ...scope,
          frozenScope: { kind: "explicit_units", unitIds: [unitId] },
          routingPolicy: { routes: ["model-finalizer-live/provider-finalizer-live"] },
          // itotori-225-audit-allow: deterministic synthetic ceiling; every fixture attempt bills an exact zero.
          costPolicy: { kind: "terminal-finalizer-live-db-test", capUsd: "1.00" },
          units: [
            {
              bridgeUnitId: unitId,
              sourceUnitKey: `scene.${unitId}`,
              nextAction: { kind: "drive_unit", stage: "translation" },
            },
          ],
          lease: { ownerId: driverLease.ownerId },
          createdAt: "2026-07-12T16:00:00.000Z",
        });
        await writeUnit(journal, runId, unitId);

        const adapter = new DbTerminalRunFinalizerAdapter(
          finalizerRepository,
          actor,
          () => driverLease,
          {},
          { runLockPool: context.pool },
        );
        const faultMessage = `injected live DB ${stage} fault`;
        const stageFaults: Partial<Record<TerminalFinalizerStage, () => unknown>> = {
          [stage]: () => new Error(faultMessage),
        };
        const result = await finalizeTerminalRun({
          runId,
          persistence: adapter,
          workers: successfulWorkers(artifact),
          stageFaults,
          now: () => new Date("2026-07-12T16:00:10.000Z"),
        });

        const canonical = await finalizerRepository.loadTerminalSummary(actor, runId);
        const snapshot = await finalizerRepository.loadSnapshot(actor, runId);
        expect(canonical).not.toBeNull();
        expect(result).toMatchObject({
          terminalStatus: canonical!.terminalStatus,
          summary: canonical!.summary,
          committed: true,
        });
        expect(snapshot?.run.status).toBe(result.terminalStatus);
        expect(result.terminalStatus).toBe(
          stage === "summary" || stage === "cleanup" ? "succeeded" : "failed",
        );
        if (stage === "cleanup") {
          expect(canonical!.summary.cleanup.error).toBe(faultMessage);
        } else if (stage !== "summary") {
          expect(canonical!.summary.rootCause.message).toBe(faultMessage);
        }

        const injectedStageOutbox = snapshot?.outbox.find((entry) => entry.stage === stage);
        expect(injectedStageOutbox).toMatchObject({
          status: stage === "summary" ? "retry_waiting" : "failed",
          lastError: faultMessage,
        });

        const durableCounts = await context.pool.query<{
          run_status: string;
          canonical_summary_count: number;
          summary_outbox_count: number;
        }>(
          `
          select
            run.status as run_status,
            (
              select count(*)::int
              from itotori_localization_run_terminal_summaries summary
              where summary.run_id = run.run_id
            ) as canonical_summary_count,
            (
              select count(*)::int
              from itotori_localization_run_finalizer_outbox outbox
              where outbox.run_id = run.run_id
                and outbox.stage = 'summary'
            ) as summary_outbox_count
          from itotori_localization_journal_runs run
          where run.run_id = $1
        `,
          [runId],
        );
        expect(durableCounts.rows).toHaveLength(1);
        expect(durableCounts.rows[0]).toMatchObject({
          run_status: result.terminalStatus,
          canonical_summary_count: 1,
          summary_outbox_count: 1,
        });

        const summaryOutbox = snapshot?.outbox.filter((entry) => entry.stage === "summary") ?? [];
        expect(summaryOutbox).toHaveLength(1);
        expect(summaryOutbox[0]?.payload).toEqual(canonical!.summary);
        expect(summaryOutbox[0]?.status).toBe(stage === "summary" ? "retry_waiting" : "succeeded");
      } finally {
        try {
          await context.close();
        } finally {
          artifact.cleanup();
        }
      }
    },
  );

  it("admits only one production finalizer for an effectful run", async () => {
    const context = await isolatedMigratedContext();
    const artifact = createRealArtifact("concurrent-owner");
    let releaseBuild = (): void => {};
    try {
      await seedScope(context);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const finalizerRepository = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const runId = "terminal-finalizer-live-db-concurrent-owner";
      const unitId = `${runId}-unit`;
      await journal.seedRun(actor, {
        runId,
        ...scope,
        frozenScope: { kind: "explicit_units", unitIds: [unitId] },
        routingPolicy: { routes: ["model-finalizer-live/provider-finalizer-live"] },
        // itotori-225-audit-allow: deterministic synthetic ceiling; this fixture bills exact zero.
        costPolicy: { kind: "terminal-finalizer-live-db-test", capUsd: "1.00" },
        units: [
          {
            bridgeUnitId: unitId,
            sourceUnitKey: `scene.${unitId}`,
            nextAction: { kind: "drive_unit", stage: "translation" },
          },
        ],
        lease: { ownerId: driverLease.ownerId },
        createdAt: "2026-07-12T16:10:00.000Z",
      });
      await writeUnit(journal, runId, unitId);

      const adapter = (): DbTerminalRunFinalizerAdapter =>
        new DbTerminalRunFinalizerAdapter(
          finalizerRepository,
          actor,
          () => driverLease,
          {},
          { runLockPool: context.pool },
        );
      let buildCalls = 0;
      let announceBuild = (): void => {};
      const buildStarted = new Promise<void>((resolve) => {
        announceBuild = resolve;
      });
      const buildGate = new Promise<void>((resolve) => {
        releaseBuild = resolve;
      });
      const workers = successfulWorkers(artifact);
      workers.patch_build = async () => {
        buildCalls += 1;
        announceBuild();
        await buildGate;
        return {
          artifactRefs: { patch: artifact.path },
          artifactHashes: { patch: artifact.hash },
          evidence: { fixture: "live-db", stage: "patch_build" },
        };
      };

      const owner = finalizeTerminalRun({ runId, persistence: adapter(), workers });
      await buildStarted;
      await expect(
        finalizeTerminalRun({
          runId,
          persistence: adapter(),
          workers: successfulWorkers(artifact),
        }),
      ).rejects.toBeInstanceOf(TerminalRunFinalizerBusyError);
      expect(buildCalls).toBe(1);

      releaseBuild();
      const completed = await owner;
      expect(completed.terminalStatus).toBe("succeeded");
      expect(buildCalls).toBe(1);
      const counts = await context.pool.query<{ summary_count: number }>(
        `select count(*)::int as summary_count
         from itotori_localization_run_terminal_summaries
         where run_id = $1`,
        [runId],
      );
      expect(counts.rows[0]?.summary_count).toBe(1);
    } finally {
      releaseBuild();
      try {
        await context.close();
      } finally {
        artifact.cleanup();
      }
    }
  });
});

function successfulWorkers(
  artifact: ReturnType<typeof createRealArtifact>,
): TerminalFinalizerWorkerPorts {
  return {
    patch_build: () => ({
      artifactRefs: { patch: artifact.path },
      artifactHashes: { patch: artifact.hash },
      evidence: { fixture: "live-db", stage: "patch_build" },
    }),
    patch_apply: () => ({ evidence: { fixture: "live-db", stage: "patch_apply" } }),
    validation: () => ({ evidence: { fixture: "live-db", stage: "validation" } }),
    summary: () => ({ evidence: { fixture: "live-db", stage: "summary" } }),
    cleanup: () => ({ evidence: { fixture: "live-db", stage: "cleanup" } }),
  };
}

function createRealArtifact(stage: TerminalFinalizerStage): {
  path: string;
  hash: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), `itotori-finalizer-live-db-${stage}-`));
  const path = join(root, "patch-artifact.bin");
  writeFileSync(path, `live DB terminal finalizer artifact for ${stage}\n`, "utf8");
  return {
    path,
    hash: hashLocalizationArtifact(path),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function writeUnit(
  journal: ItotoriLocalizationJournalRepository,
  runId: string,
  bridgeUnitId: string,
): Promise<void> {
  const attemptId = `terminal-finalizer-live-attempt:${runId}:${bridgeUnitId}`;
  await journal.beginAttempt(actor, {
    attemptId,
    runId,
    bridgeUnitId,
    stage: "translation",
    agentLabel: "terminal-finalizer-live-db-fixture",
    logicalCallId: `terminal-finalizer-live-logical:${runId}:${bridgeUnitId}`,
    attemptIndex: 1,
    requestedModelId: "model-finalizer-live",
    requestedProviderId: "provider-finalizer-live",
    zdr: true,
    artifactRef: `provider-run:${attemptId}`,
    startedAt: "2026-07-12T16:00:01.000Z",
    lease: driverLease,
  });
  await journal.completeAttempt(actor, {
    attemptId,
    runId,
    bridgeUnitId,
    modelId: "model-finalizer-live",
    providerId: "provider-finalizer-live",
    costUsd: "0",
    costKind: "zero",
    tokensIn: 1,
    tokensOut: 1,
    tokenCountSource: "fixture",
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheDiscountMicrosUsd: 0,
    fallbackUsed: false,
    fallbackPlan: [],
    zdr: true,
    finishState: "stop",
    refusalState: null,
    validationResult: "accepted",
    failureClass: null,
    retryDecision: "write",
    retryDelayMs: null,
    artifactRef: `provider-run:${attemptId}`,
    errorClasses: [],
    completedAt: "2026-07-12T16:00:02.000Z",
    lease: driverLease,
  });

  const outcomeId = `terminal-finalizer-live-outcome:${runId}:${bridgeUnitId}`;
  const candidateId = `terminal-finalizer-live-candidate:${runId}:${bridgeUnitId}`;
  const outcome: WrittenUnitOutcome = {
    id: outcomeId,
    status: "written",
    unitId: bridgeUnitId,
    targetLocale: scope.targetLocale,
    selectedCandidateId: candidateId,
    candidates: [
      {
        id: candidateId,
        outcomeId,
        body: asNonBlankTargetText(`Translated ${bridgeUnitId}.`),
        producedBy: {
          modelId: "model-finalizer-live",
          providerId: "provider-finalizer-live",
        },
        attemptId,
        kind: "primary",
      },
    ],
    findings: [],
    qualityFlags: [],
    provenance: { origin: "terminal-finalizer-live-db-fixture" },
    writtenAt: "2026-07-12T16:00:03.000Z",
  };
  await journal.persistUnit(actor, {
    runId,
    bridgeUnitId,
    sourceUnitKey: `scene.${bridgeUnitId}`,
    outcome,
    attempts: [],
    contextPacket: { fixture: "terminal-finalizer-live-db" },
    contextRefs: [],
    speakerLabels: [],
    qaDetails: {},
    lease: driverLease,
  });
}

async function seedScope(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
): Promise<void> {
  await context.pool.query(`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-terminal-finalizer-live-db', 'Terminal Finalizer Live DB Workspace')
  `);
  await context.pool.query(
    `
    insert into itotori_projects (
      project_id, workspace_id, project_key, name, source_locale, status
    ) values (
      $1, 'workspace-terminal-finalizer-live-db', 'terminal-finalizer-live-db',
      'Terminal Finalizer Live DB Project', 'ja-JP', 'imported'
    )
  `,
    [scope.projectId],
  );
  await context.pool.query(
    `
    insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
    values ($1, $2, 'bridge_revision', 'terminal-finalizer-live-v1')
  `,
    [scope.sourceRevisionId, scope.projectId],
  );
  await context.pool.query(
    `
    insert into itotori_source_bundles (
      source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
      schema_version, source_bundle_hash, source_locale,
      extractor_name, extractor_version, unit_count, asset_count
    ) values (
      'bundle-terminal-finalizer-live-db', $1, $2,
      'bridge-terminal-finalizer-live-db', '0.2.0', 'hash:terminal-finalizer-live-db', 'ja-JP',
      'fixture-extractor', '1.0.0', 1, 0
    )
  `,
    [scope.projectId, scope.sourceRevisionId],
  );
  await context.pool.query(
    `
    insert into itotori_locale_branches (
      locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
    ) values (
      $1, $2, 'bundle-terminal-finalizer-live-db',
      $3, 'Terminal finalizer live DB branch', 'active'
    )
  `,
    [scope.localeBranchId, scope.projectId, scope.targetLocale],
  );
}
