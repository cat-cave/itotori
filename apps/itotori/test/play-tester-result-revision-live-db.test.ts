// p0-core-result-revision-hitl — end-to-end: play tester edits a delivered
// target line → new delivered patch revision (real Postgres, real patch bytes),
// atomic, real provenance, export reflects the edit with NO approval gate.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashLocalizationArtifact,
  ItotoriLocalizationJournalRepository,
  ItotoriLocalizationResultRevisionRepository,
  ItotoriLocalizationRunFinalizerRepository,
  localUserId,
  type AuthorizationActor,
  type LocalizationJournalRunLeaseIdentity,
} from "@itotori/db";
import { asNonBlankTargetText, type WrittenUnitOutcome } from "@itotori/localization-bridge-schema";
import { describe, expect, it } from "vitest";
import { PlayTesterResultRevisionService } from "../src/play/result-revision-service.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };
const playTester: AuthorizationActor = { userId: "play-tester-live-db" };

const scope = {
  projectId: "project-play-tester-live",
  localeBranchId: "branch-play-tester-live",
  sourceRevisionId: "revision-play-tester-live",
  targetLocale: "en-US",
} as const;

const driverLease: LocalizationJournalRunLeaseIdentity = {
  ownerId: "play-tester-live-driver",
  fenceToken: 1,
};

describe.skipIf(!process.env.DATABASE_URL)("play-tester result revision live DB", () => {
  it("edit → selected export reflects new target with no approval step", async () => {
    const context = await isolatedMigratedContext();
    const parentArtifact = createRealArtifact("live-parent");
    const childRoot = mkdtempSync(join(tmpdir(), "itotori-play-tester-live-child-"));
    try {
      await seedScope(context);
      await grantDraftWrite(context, playTester.userId);
      const journal = new ItotoriLocalizationJournalRepository(context.db);
      const finalizer = new ItotoriLocalizationRunFinalizerRepository(context.db);
      const repository = new ItotoriLocalizationResultRevisionRepository(context.db);
      const service = new PlayTesterResultRevisionService({ repository });

      const runId = "play-tester-live-run";
      const unitId = "live-unit-1";
      await journal.seedRun(actor, {
        runId,
        ...scope,
        frozenScope: { kind: "explicit_units", unitIds: [unitId] },
        routingPolicy: { routes: ["model-live/provider-live"] },
        // itotori-225-audit-allow: deterministic synthetic ceiling for fixture attempts.
        costPolicy: { kind: "play-tester-live", capUsd: "1.00" },
        units: [
          {
            bridgeUnitId: unitId,
            sourceUnitKey: `scene.${unitId}`,
            nextAction: { kind: "drive_unit", stage: "translation" },
          },
        ],
        lease: { ownerId: driverLease.ownerId },
        createdAt: "2026-07-12T19:00:00.000Z",
      });
      await writeUnit(journal, runId, unitId);

      const parentPatch = await finalizer.ensurePatchVersion(actor, {
        runId,
        artifactHashes: parentArtifact.artifactHashes,
        artifactRefs: parentArtifact.artifactRefs,
      });
      for (const stage of ["patch_build", "patch_apply", "validation"] as const) {
        await finalizer.upsertPatchStageEvidence(actor, {
          runId,
          stage,
          status: "succeeded",
          evidence: { fixture: "play-tester-live" },
        });
      }
      await finalizer.enterFinalizing(actor, { runId, lease: driverLease });
      await finalizer.completeSucceededRun(actor, {
        runId,
        patchVersionId: parentPatch.patchVersionId,
      });

      const beforeExport = await service.loadSelectedExport(actor, { runId });
      expect(beforeExport.export?.units[0]?.targetBody).toBe(`Translated ${unitId}.`);

      // Target-only edit — no source field on the request.
      const edited = "Play-tester delivered rewrite — no source needed.";
      const response = await service.editTarget(playTester, {
        parentPatchVersionId: parentPatch.patchVersionId,
        bridgeUnitId: unitId,
        targetBody: edited,
        artifactRootDir: childRoot,
      });

      expect(response.result.resultRevision.actorUserId).toBe(playTester.userId);
      expect(response.result.resultRevision.origin).toBe("play_tester_edit");
      expect(response.result.patchVersion.status).toBe("playable");
      expect(response.result.patchVersion.parentPatchVersionId).toBe(parentPatch.patchVersionId);

      // Export immediately reflects the edit — no approve/request_repair step.
      const afterExport = await service.loadSelectedExport(actor, { runId });
      expect(afterExport.export?.patchVersionId).toBe(response.result.patchVersion.patchVersionId);
      expect(afterExport.export?.units[0]?.targetBody).toBe(edited);
      expect(afterExport.export?.origin).toBe("play_tester_edit");

      const bundlePath = Object.values(response.result.patchVersion.artifactRefs)[0]!;
      const payload = JSON.parse(
        readFileSync(join(bundlePath, "delivered-units.json"), "utf8"),
      ) as { units: Array<{ targetBody: string }> };
      expect(payload.units[0]?.targetBody).toBe(edited);
      expect(hashLocalizationArtifact(bundlePath)).toBe(
        response.result.patchVersion.artifactHashes.delivered_bundle,
      );
    } finally {
      try {
        await context.close();
      } finally {
        parentArtifact.cleanup();
        rmSync(childRoot, { recursive: true, force: true });
      }
    }
  });
});

async function writeUnit(
  journal: ItotoriLocalizationJournalRepository,
  runId: string,
  bridgeUnitId: string,
): Promise<void> {
  const attemptId = `live-attempt:${runId}:${bridgeUnitId}`;
  await journal.beginAttempt(actor, {
    attemptId,
    runId,
    bridgeUnitId,
    stage: "translation",
    agentLabel: "play-tester-live",
    logicalCallId: `live-logical:${runId}:${bridgeUnitId}`,
    attemptIndex: 1,
    requestedModelId: "model-live",
    requestedProviderId: "provider-live",
    zdr: true,
    artifactRef: `provider-run:${attemptId}`,
    startedAt: "2026-07-12T19:00:01.000Z",
    lease: driverLease,
  });
  await journal.completeAttempt(actor, {
    attemptId,
    runId,
    bridgeUnitId,
    modelId: "model-live",
    providerId: "provider-live",
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
    completedAt: "2026-07-12T19:00:02.000Z",
    lease: driverLease,
  });
  const outcomeId = `live-outcome:${runId}:${bridgeUnitId}`;
  const candidateId = `live-candidate:${runId}:${bridgeUnitId}`;
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
        producedBy: { modelId: "model-live", providerId: "provider-live" },
        attemptId,
        kind: "primary",
      },
    ],
    findings: [],
    qualityFlags: [],
    provenance: { origin: "play-tester-live" },
    writtenAt: "2026-07-12T19:00:03.000Z",
  };
  await journal.persistUnit(actor, {
    runId,
    bridgeUnitId,
    sourceUnitKey: `scene.${bridgeUnitId}`,
    outcome,
    attempts: [],
    contextPacket: { fixture: "play-tester-live" },
    contextRefs: [],
    speakerLabels: [],
    qaDetails: {},
    lease: driverLease,
  });
}

function createRealArtifact(label: string): {
  artifactRefs: Record<string, string>;
  artifactHashes: Record<string, string>;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), `itotori-play-tester-live-${label}-`));
  const path = join(root, "patch.bin");
  writeFileSync(path, `live parent ${label}\n`, "utf8");
  return {
    artifactRefs: { patch: path },
    artifactHashes: { patch: hashLocalizationArtifact(path) },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function seedScope(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
): Promise<void> {
  await context.pool.query(`
    insert into itotori_workspaces (workspace_id, name)
    values ('workspace-play-tester-live', 'Play Tester Live Workspace')
  `);
  await context.pool.query(
    `
    insert into itotori_projects (
      project_id, workspace_id, project_key, name, source_locale, status
    ) values ($1, 'workspace-play-tester-live', 'play-tester-live',
      'Play Tester Live Project', 'ja-JP', 'imported')
  `,
    [scope.projectId],
  );
  await context.pool.query(
    `
    insert into itotori_source_revisions (source_revision_id, project_id, revision_kind, value)
    values ($1, $2, 'bridge_revision', 'live-v1')
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
      'source-bundle-play-tester-live', $1, $2,
      'bridge-play-tester-live', '0.2.0', 'hash:live', 'ja-JP',
      'fixture-extractor', '1.0.0', 0, 0
    )
  `,
    [scope.projectId, scope.sourceRevisionId],
  );
  await context.pool.query(
    `
    insert into itotori_locale_branches (
      locale_branch_id, project_id, source_bundle_id, target_locale, branch_name, status
    ) values (
      $1, $2, 'source-bundle-play-tester-live',
      $3, 'Play Tester Live branch', 'active'
    )
  `,
    [scope.localeBranchId, scope.projectId, scope.targetLocale],
  );
}

async function grantDraftWrite(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  userId: string,
): Promise<void> {
  await context.pool.query(
    `
    insert into itotori_users (user_id, display_name)
    values ($1, $2)
    on conflict (user_id) do nothing
  `,
    [userId, `Play tester ${userId}`],
  );
  await context.pool.query(
    `
    insert into itotori_user_permission_grants (user_id, permission)
    values
      ($1, 'draft.write'),
      ($1, 'catalog.read')
    on conflict do nothing
  `,
    [userId],
  );
}
