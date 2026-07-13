import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { asNonBlankTargetText, type WrittenUnitOutcome } from "@itotori/localization-bridge-schema";
import { localUserId, type AuthorizationActor } from "../src/authorization.js";
import { hashLocalizationArtifact } from "../src/localization-artifact-integrity.js";
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

describe("ItotoriLocalizationRunFinalizerRepository", () => {
  it("succeeds despite a critical QA finding, stores one canonical summary, and replays idempotently", async () => {
    const context = await isolatedMigratedContext();
    const artifact = createRealArtifact("critical-qa");
    try {
      await seedScope(context);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const repository = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const runId = "finalizer-critical-qa";
      const unitIds = ["finalizer-critical-qa-unit-1", "finalizer-critical-qa-unit-2"];

      await journal.seedRun(localActor, seedRunInput(runId, unitIds));
      await writeUnit(journal, runId, unitIds[0]!, { criticalFinding: true });
      await writeUnit(journal, runId, unitIds[1]!);
      await context.db.execute(sql`
        insert into itotori_localization_cost_reservations (
          reservation_id, run_id, attempt_id, reserved_usd, state
        ) values (
          'reservation-finalizer-released', ${runId},
          ${`terminal-finalizer-attempt:${runId}:${unitIds[0]!}`}, '0.5', 'released'
        )
      `);

      const patch = await repository.ensurePatchVersion(localActor, {
        runId,
        artifactHashes: artifact.artifactHashes,
        artifactRefs: artifact.artifactRefs,
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
          reservations: { totalCount: 1, reconciledCount: 0, unresolvedCount: 0 },
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
      try {
        await context.close();
      } finally {
        artifact.cleanup();
      }
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

  it("never synthesizes coverage when a written unit lacks its persisted result revision", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const repository = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const runId = "finalizer-missing-result-revision";
      const unitIds = [
        "finalizer-missing-result-revision-unit-1",
        "finalizer-missing-result-revision-unit-2",
      ];

      await journal.seedRun(localActor, seedRunInput(runId, unitIds));
      await writeUnit(journal, runId, unitIds[0]!);
      await writeUnit(journal, runId, unitIds[1]!);

      const persisted = await repository.loadSnapshot(localActor, runId);
      expect(persisted?.outcomes.map((outcome) => outcome.resultRevisionId)).toEqual([
        `run-result:${runId}:${unitIds[0]}`,
        `run-result:${runId}:${unitIds[1]}`,
      ]);

      await context.db.execute(sql`
        delete from itotori_localization_result_revisions
        where run_id = ${runId}
          and bridge_unit_id = ${unitIds[1]!}
      `);

      const missingRevision = await repository.loadSnapshot(localActor, runId);
      expect(
        missingRevision?.outcomes.find((outcome) => outcome.bridgeUnitId === unitIds[1]),
      ).toMatchObject({ resultRevisionId: null, selectedCandidateValid: true });

      await expect(repository.ensurePatchVersion(localActor, { runId })).rejects.toMatchObject({
        code: "coverage_incomplete",
        message: expect.stringContaining(unitIds[1]!),
      });
      await repository.enterFinalizing(localActor, { runId, lease: driverLease });
      await expect(repository.completeSucceededRun(localActor, { runId })).rejects.toMatchObject({
        code: "coverage_incomplete",
      });

      const afterRejectedSuccess = await repository.loadSnapshot(localActor, runId);
      expect(afterRejectedSuccess).toMatchObject({
        run: { status: "finalizing" },
        patch: null,
        summary: null,
      });
    } finally {
      await context.close();
    }
  });

  it("enforces the patch-member result-revision foreign key at the SQL boundary", async () => {
    const context = await isolatedMigratedContext();
    try {
      await seedScope(context);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const repository = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const runId = "finalizer-result-revision-fkey";
      const unitId = "finalizer-result-revision-fkey-unit";

      await journal.seedRun(localActor, seedRunInput(runId, [unitId]));
      await writeUnit(journal, runId, unitId);
      const patch = await repository.ensurePatchVersion(localActor, { runId });

      let captured: unknown;
      try {
        await context.db.execute(sql`
          update itotori_localization_patch_version_units
          set result_revision_id = 'missing-result-revision'
          where patch_version_id = ${patch.patchVersionId}
            and bridge_unit_id = ${unitId}
        `);
      } catch (error) {
        captured = error;
      }
      expect(postgresErrorCodeOf(captured)).toBe("23503");

      const afterRejectedUpdate = await repository.loadSnapshot(localActor, runId);
      expect(afterRejectedUpdate?.patch?.units).toEqual([
        expect.objectContaining({
          bridgeUnitId: unitId,
          resultRevisionId: `run-result:${runId}:${unitId}`,
        }),
      ]);
    } finally {
      await context.close();
    }
  });

  it("rejects a missing artifact ref and never marks its patch playable", async () => {
    const context = await isolatedMigratedContext();
    const artifactRoot = mkdtempSync(join(tmpdir(), "itotori-finalizer-missing-artifact-"));
    try {
      await seedScope(context);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const repository = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const runId = "finalizer-missing-artifact";
      const unitId = "finalizer-missing-artifact-unit";
      const missingPath = join(artifactRoot, "does-not-exist.patch");

      await journal.seedRun(localActor, seedRunInput(runId, [unitId]));
      await writeUnit(journal, runId, unitId);
      const patch = await repository.ensurePatchVersion(localActor, {
        runId,
        artifactRefs: { patch: missingPath },
        artifactHashes: { patch: `sha256:${"0".repeat(64)}` },
      });
      await markPatchWorkersSucceeded(repository, runId);
      await repository.enterFinalizing(localActor, { runId, lease: driverLease });

      await expect(
        repository.completeSucceededRun(localActor, {
          runId,
          patchVersionId: patch.patchVersionId,
        }),
      ).rejects.toMatchObject({
        code: "coverage_incomplete",
        message: expect.stringContaining("missing or unreadable"),
      });

      const afterRejectedSuccess = await repository.loadSnapshot(localActor, runId);
      expect(afterRejectedSuccess).toMatchObject({
        run: { status: "finalizing" },
        patch: { status: "building", playableAt: null },
        summary: null,
      });
    } finally {
      try {
        await context.close();
      } finally {
        rmSync(artifactRoot, { recursive: true, force: true });
      }
    }
  });

  it("rejects an artifact changed after hashing and never marks its patch playable", async () => {
    const context = await isolatedMigratedContext();
    const artifact = createRealArtifact("tampered");
    try {
      await seedScope(context);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const repository = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const runId = "finalizer-tampered-artifact";
      const unitId = "finalizer-tampered-artifact-unit";

      await journal.seedRun(localActor, seedRunInput(runId, [unitId]));
      await writeUnit(journal, runId, unitId);
      const patch = await repository.ensurePatchVersion(localActor, {
        runId,
        artifactRefs: artifact.artifactRefs,
        artifactHashes: artifact.artifactHashes,
      });
      writeFileSync(artifact.path, "tampered after the persisted hash was calculated\n", "utf8");
      await markPatchWorkersSucceeded(repository, runId);
      await repository.enterFinalizing(localActor, { runId, lease: driverLease });

      await expect(
        repository.completeSucceededRun(localActor, {
          runId,
          patchVersionId: patch.patchVersionId,
        }),
      ).rejects.toMatchObject({
        code: "coverage_incomplete",
        message: expect.stringContaining("hash mismatch"),
      });

      const afterRejectedSuccess = await repository.loadSnapshot(localActor, runId);
      expect(afterRejectedSuccess).toMatchObject({
        run: { status: "finalizing" },
        patch: { status: "building", playableAt: null },
        summary: null,
      });
    } finally {
      try {
        await context.close();
      } finally {
        artifact.cleanup();
      }
    }
  });

  it("freezes the verified manifest, membership, and stage evidence after playability", async () => {
    const context = await isolatedMigratedContext();
    const artifact = createRealArtifact("playable-immutable");
    try {
      await seedScope(context);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const repository = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const runId = "finalizer-playable-immutable";
      const unitId = "finalizer-playable-immutable-unit";
      await journal.seedRun(localActor, seedRunInput(runId, [unitId]));
      await writeUnit(journal, runId, unitId);
      await expectDatabaseErrorContaining(
        context.db.execute(sql`
          update itotori_localization_result_revisions
          set target_body = 'tampered revision body'
          where run_id = ${runId}
            and bridge_unit_id = ${unitId}
        `),
        "localization result revision",
      );
      const patch = await repository.ensurePatchVersion(localActor, {
        runId,
        artifactRefs: artifact.artifactRefs,
        artifactHashes: artifact.artifactHashes,
      });
      await markPatchWorkersSucceeded(repository, runId);
      await repository.enterFinalizing(localActor, { runId, lease: driverLease });
      await repository.completeSucceededRun(localActor, {
        runId,
        patchVersionId: patch.patchVersionId,
      });

      const idempotentReplay = await repository.ensurePatchVersion(localActor, {
        runId,
        artifactRefs: artifact.artifactRefs,
        artifactHashes: artifact.artifactHashes,
      });
      expect(idempotentReplay.status).toBe("playable");

      await expect(
        repository.ensurePatchVersion(localActor, {
          runId,
          artifactRefs: { bogus: join(artifact.path, "missing") },
          artifactHashes: { bogus: `sha256:${"0".repeat(64)}` },
        }),
      ).rejects.toMatchObject({ code: "patch_conflict" });
      await expectDatabaseErrorContaining(
        context.db.execute(sql`
          update itotori_localization_patch_versions
          set artifact_refs = artifact_refs || ${JSON.stringify({ bogus: "/missing" })}::jsonb
          where patch_version_id = ${patch.patchVersionId}
        `),
        "playable patch version",
      );
      await expectDatabaseErrorContaining(
        context.db.execute(sql`
          delete from itotori_localization_patch_version_units
          where patch_version_id = ${patch.patchVersionId}
            and bridge_unit_id = ${unitId}
        `),
        "membership for playable patch version",
      );
      await expectDatabaseErrorContaining(
        context.db.execute(sql`
          update itotori_localization_run_finalizer_outbox
          set status = 'pending'
          where run_id = ${runId}
            and stage = 'patch_apply'
        `),
        "stage patch_apply for playable patch run",
      );

      const frozen = await repository.loadSnapshot(localActor, runId);
      expect(frozen?.patch).toMatchObject({
        status: "playable",
        artifactRefs: artifact.artifactRefs,
        artifactHashes: artifact.artifactHashes,
        units: [expect.objectContaining({ bridgeUnitId: unitId })],
      });
      expect(frozen?.outbox.find((entry) => entry.stage === "patch_apply")?.status).toBe(
        "succeeded",
      );
    } finally {
      try {
        await context.close();
      } finally {
        artifact.cleanup();
      }
    }
  });

  it("keeps an operational patch blocker resumable without poisoning its outbox keys", async () => {
    const context = await isolatedMigratedContext();
    const artifact = createRealArtifact("paused-resume");
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
        artifactHashes: artifact.artifactHashes,
        artifactRefs: artifact.artifactRefs,
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
      try {
        await context.close();
      } finally {
        artifact.cleanup();
      }
    }
  });
});

function createRealArtifact(label: string): {
  path: string;
  artifactRefs: Record<string, string>;
  artifactHashes: Record<string, string>;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), `itotori-finalizer-${label}-`));
  const path = join(root, "patch-artifact.bin");
  writeFileSync(path, `terminal finalizer artifact fixture: ${label}\n`, "utf8");
  return {
    path,
    artifactRefs: { patch: path },
    artifactHashes: { patch: hashLocalizationArtifact(path) },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function postgresErrorCodeOf(error: unknown): string | undefined {
  let current = error;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

async function expectDatabaseErrorContaining(
  operation: PromiseLike<unknown>,
  expectedMessage: string,
): Promise<void> {
  let captured: unknown;
  try {
    await operation;
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeDefined();
  expect(databaseErrorMessages(captured)).toContain(expectedMessage);
}

function databaseErrorMessages(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if ("message" in current && typeof current.message === "string") {
      messages.push(current.message);
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return messages.join("\n");
}

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
