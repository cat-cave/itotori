import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { asNonBlankTargetText, type WrittenUnitOutcome } from "@itotori/localization-bridge-schema";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import {
  ItotoriLocalizationJournalRepository,
  type LocalizationJournalRunLeaseIdentity,
} from "../src/repositories/localization-journal-repository.js";
import { ItotoriLocalizationRunFinalizerRepository } from "../src/repositories/localization-run-finalizer-repository.js";
import { isolatedMigratedContext } from "./db-test-context.js";

const localActor: AuthorizationActor = { userId: localUserId };

const scope = {
  projectId: "project-localization-run-finalizer",
  localeBranchId: "locale-branch-localization-run-finalizer",
  sourceRevisionId: "source-revision-localization-run-finalizer",
  targetLocale: "en-US",
} as const;

const driverLease: LocalizationJournalRunLeaseIdentity = {
  ownerId: "terminal-finalizer-driver",
  fenceToken: 1,
};

describe.skipIf(!process.env.DATABASE_URL)("ItotoriLocalizationRunFinalizerRepository", () => {
  it("succeeds despite a critical QA finding, stores one canonical summary, and replays idempotently", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const repository = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const runId = "finalizer-critical-qa";
      const unitIds = ["finalizer-critical-qa-unit-1", "finalizer-critical-qa-unit-2"];

      await journal.seedRun(localActor, seedRunInput(runId, unitIds));
      await writeUnit(journal, runId, unitIds[0]!, { criticalFinding: true });
      await writeUnit(journal, runId, unitIds[1]!);

      const patch = await repository.ensurePatchVersion(localActor, {
        runId,
        artifactHashes: { patch: "sha256:terminal-finalizer-fixture" },
        artifactRefs: { patch: "artifact:terminal-finalizer-fixture" },
      });
      await markPatchWorkersSucceeded(repository, runId);
      await repository.enterFinalizing(localActor, { runId, lease: driverLease });

      const first = await repository.completeSucceededRun(localActor, {
        runId,
        patchVersionId: patch.patchVersionId,
      });
      expect(first).toMatchObject({
        runId,
        terminalStatus: "succeeded",
        summaryEpoch: 1,
        summary: {
          terminalStatus: "succeeded",
          quality: { findingCount: 1, contestedFindingCount: 1 },
          coverage: {
            plannedUnitCount: 2,
            writtenOutcomeCount: 2,
            validSelectedCandidateCount: 2,
            missingUnitIds: [],
          },
          patch: { playable: true, exactFrozenScope: true },
        },
      });

      const afterFirst = await repository.loadSnapshot(localActor, runId);
      const summaryOutbox = afterFirst?.outbox.find((entry) => entry.stage === "summary");
      expect(summaryOutbox?.payload).toEqual(first.summary);
      expect(afterFirst?.patch).toMatchObject({
        patchVersionId: patch.patchVersionId,
        status: "playable",
      });

      // Projection delivery is retryable without changing its canonical
      // payload or terminal decision.
      await repository.upsertPatchStageEvidence(localActor, {
        runId,
        stage: "summary",
        status: "failed",
        lastError: "fixture summary filesystem outage",
      });
      await repository.upsertPatchStageEvidence(localActor, {
        runId,
        stage: "summary",
        status: "succeeded",
        evidence: { fixture: "summary replayed" },
      });

      const replay = await repository.completeSucceededRun(localActor, {
        runId,
        patchVersionId: patch.patchVersionId,
      });
      expect(replay).toEqual(first);

      const afterReplay = await repository.loadSnapshot(localActor, runId);
      expect(afterReplay?.summary).toEqual(first);
      expect(afterReplay?.outbox.filter((entry) => entry.stage === "summary")).toHaveLength(1);
      expect(afterReplay?.outbox.find((entry) => entry.stage === "summary")?.payload).toEqual(
        first.summary,
      );
    } finally {
      await context.close();
    }
  });

  it("rejects success when any frozen unit lacks a valid written outcome", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const repository = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const runId = "finalizer-coverage-gap";
      const unitIds = ["finalizer-coverage-gap-unit-1", "finalizer-coverage-gap-unit-2"];

      await journal.seedRun(localActor, seedRunInput(runId, unitIds));
      await writeUnit(journal, runId, unitIds[0]!);

      await expect(repository.ensurePatchVersion(localActor, { runId })).rejects.toMatchObject({
        code: "coverage_incomplete",
        message: expect.stringContaining(unitIds[1]!),
      });
      await repository.enterFinalizing(localActor, { runId, lease: driverLease });
      await expect(repository.completeSucceededRun(localActor, { runId })).rejects.toMatchObject({
        code: "coverage_incomplete",
      });
      expect(await repository.loadTerminalSummary(localActor, runId)).toBeNull();
    } finally {
      await context.close();
    }
  });

  it("keeps an operational patch blocker resumable without poisoning its outbox keys", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const repository = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const runId = "finalizer-paused-resume";
      const unitIds = ["finalizer-paused-resume-unit"];
      const resumedLease = { ownerId: "terminal-finalizer-resumer", fenceToken: 2 } as const;

      await journal.seedRun(localActor, seedRunInput(runId, unitIds));
      await writeUnit(journal, runId, unitIds[0]!);
      await repository.enterFinalizing(localActor, { runId, lease: driverLease });
      await repository.ensurePatchVersion(localActor, { runId });
      const paused = await repository.terminalize(localActor, {
        runId,
        terminalStatus: "paused",
        blocker: {
          kind: "provider_outage",
          detail: "patch tool is temporarily unavailable",
          evidence: "fixture:patch-tool-outage",
          raisedAt: "2026-07-12T12:00:04.000Z",
          operatorAction: "restore the patch tool and resume",
        },
      });
      expect(paused.summary.terminalStatus).toBe("paused");

      await journal.resumeRun(localActor, runId, { ownerId: resumedLease.ownerId });
      await repository.enterFinalizing(localActor, { runId, lease: resumedLease });
      const patch = await repository.ensurePatchVersion(localActor, {
        runId,
        artifactHashes: { patch: "sha256:resumed-terminal-finalizer-fixture" },
        artifactRefs: { patch: "artifact:resumed-terminal-finalizer-fixture" },
      });
      await markPatchWorkersSucceeded(repository, runId);
      const completed = await repository.completeSucceededRun(localActor, {
        runId,
        patchVersionId: patch.patchVersionId,
      });

      expect(completed.summary).toMatchObject({
        terminalStatus: "succeeded",
        summaryEpoch: 2,
        blocker: null,
        patch: { playable: true },
      });
      const snapshot = await repository.loadSnapshot(localActor, runId);
      expect(snapshot?.outbox.find((entry) => entry.stage === "patch_apply")).toMatchObject({
        status: "succeeded",
      });
      expect(snapshot?.outbox.filter((entry) => entry.stage === "summary")).toHaveLength(1);
    } finally {
      await context.close();
    }
  });
});

function seedRunInput(runId: string, unitIds: readonly string[]) {
  return {
    runId,
    ...scope,
    frozenScope: { kind: "explicit_units", unitIds: [...unitIds] },
    routingPolicy: { routes: ["model-terminal-finalizer/provider-terminal-finalizer"] },
    costPolicy: { kind: "terminal-finalizer-fixture", capUsd: "1.00" },
    units: unitIds.map((bridgeUnitId) => ({
      bridgeUnitId,
      sourceUnitKey: `scene.${bridgeUnitId}`,
      nextAction: { kind: "drive_unit", stage: "translation" },
    })),
    lease: { ownerId: driverLease.ownerId },
    createdAt: "2026-07-12T12:00:00.000Z",
  };
}

async function writeUnit(
  journal: ItotoriLocalizationJournalRepository,
  runId: string,
  bridgeUnitId: string,
  options: { criticalFinding?: boolean } = {},
): Promise<void> {
  const attemptId = `terminal-finalizer-attempt:${runId}:${bridgeUnitId}`;
  await journal.beginAttempt(localActor, {
    attemptId,
    runId,
    bridgeUnitId,
    stage: "translation",
    agentLabel: "terminal-finalizer-fixture",
    logicalCallId: `terminal-finalizer-logical:${runId}:${bridgeUnitId}`,
    attemptIndex: 1,
    requestedModelId: "model-terminal-finalizer",
    requestedProviderId: "provider-terminal-finalizer",
    zdr: true,
    artifactRef: `provider-run:${attemptId}`,
    startedAt: "2026-07-12T12:00:01.000Z",
    lease: driverLease,
  });
  await journal.completeAttempt(localActor, {
    attemptId,
    runId,
    bridgeUnitId,
    modelId: "model-terminal-finalizer",
    providerId: "provider-terminal-finalizer",
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
    completedAt: "2026-07-12T12:00:02.000Z",
    lease: driverLease,
  });

  const outcomeId = `terminal-finalizer-outcome:${runId}:${bridgeUnitId}`;
  const candidateId = `terminal-finalizer-candidate:${runId}:${bridgeUnitId}`;
  const findingId = `terminal-finalizer-critical:${runId}:${bridgeUnitId}`;
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
          modelId: "model-terminal-finalizer",
          providerId: "provider-terminal-finalizer",
        },
        attemptId,
        kind: "primary",
      },
    ],
    findings: options.criticalFinding
      ? [
          {
            id: findingId,
            outcomeId,
            candidateId,
            severity: "critical",
            category: "mistranslation",
            note: "Critical QA finding is diagnostic-only for terminal coverage.",
            contested: true,
            confidence: 1,
          },
        ]
      : [],
    qualityFlags: options.criticalFinding ? ["qa_unresolved"] : [],
    provenance: { origin: "terminal-finalizer-fixture" },
    writtenAt: "2026-07-12T12:00:03.000Z",
  };
  await journal.persistUnit(localActor, {
    runId,
    bridgeUnitId,
    sourceUnitKey: `scene.${bridgeUnitId}`,
    outcome,
    attempts: [],
    contextPacket: { fixture: "terminal-run-finalizer" },
    contextRefs: [],
    speakerLabels: [],
    qaDetails: options.criticalFinding
      ? {
          [findingId]: {
            recommendation: "Inspect the critical QA annotation after terminalization.",
            agentRationale: "This proves QA remains recorded but never gates coverage success.",
            evidenceRefs: ["fixture:critical-qa"],
          },
        }
      : {},
    lease: driverLease,
  });
}

async function markPatchWorkersSucceeded(
  repository: ItotoriLocalizationRunFinalizerRepository,
  runId: string,
): Promise<void> {
  for (const stage of ["patch_build", "patch_apply", "validation"] as const) {
    await repository.upsertPatchStageEvidence(localActor, {
      runId,
      stage,
      status: "succeeded",
      evidence: { fixture: "terminal-run-finalizer" },
    });
  }
}

async function seedScope(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
): Promise<void> {
  await context.db.execute(sql`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-localization-run-finalizer', 'Localization Run Finalizer Workspace')
  `);
  await context.db.execute(sql`
    insert into itotori_projects (
      project_id, workspace_id, project_key, name, source_locale, status
    ) values (
      ${scope.projectId}, 'workspace-localization-run-finalizer', 'localization-run-finalizer',
      'Localization Run Finalizer Project', 'ja-JP', 'imported'
    )
  `);
  await context.db.execute(sql`
    insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
    values (${scope.sourceRevisionId}, ${scope.projectId}, 'bridge_revision', 'terminal-finalizer-v1')
  `);
  await context.db.execute(sql`
    insert into itotori_source_bundles (
      source_bundle_id, project_id, source_bundle_revision_id, bridge_id,
      schema_version, source_bundle_hash, source_locale,
      extractor_name, extractor_version, unit_count, asset_count
    ) values (
      'source-bundle-localization-run-finalizer', ${scope.projectId}, ${scope.sourceRevisionId},
      'bridge-localization-run-finalizer', '0.2.0', 'hash:terminal-finalizer', 'ja-JP',
      'fixture-extractor', '1.0.0', 0, 0
    )
  `);
  await context.db.execute(sql`
    insert into itotori_locale_branches (
      locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
    ) values (
      ${scope.localeBranchId}, ${scope.projectId}, 'source-bundle-localization-run-finalizer',
      ${scope.targetLocale}, 'Terminal Finalizer branch', 'active'
    )
  `);
}
