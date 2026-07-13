// p0-core-result-revision-hitl — real HTTP + real Kaifuu delivery proof.
//
// This drives the shipping API boundary, not a hand-instantiated service:
// a play-tester target edit produces a selected child PatchVersion, the real
// Kaifuu patcher emits the child game bytes, and the delivery route exposes
// that selected output immediately.

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { asNonBlankTargetText, type WrittenUnitOutcome } from "@itotori/localization-bridge-schema";
import {
  bootstrapLocalUser,
  hashLocalizationArtifact,
  ItotoriLocalizationJournalRepository,
  ItotoriLocalizationRunFinalizerRepository,
  localUserId,
  type AuthorizationActor,
  type LocalizationJournalRunLeaseIdentity,
} from "@itotori/db";
import { afterEach, describe, expect, it } from "vitest";
import { runKaifuuRealliveExtract } from "../src/extract/kaifuu-extract-seam.js";
import { applyKaifuuRealLivePatch } from "../src/orchestrator/patch-apply-seam.js";
import { bracketWrapForRealLive } from "../src/orchestrator/localize-project-stage-command.js";
import { createItotoriServer } from "../src/server.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";

const actor: AuthorizationActor = { userId: localUserId };

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

const fixtureRoot = fileURLToPath(
  new URL("../../../crates/kaifuu-reallive/tests/fixtures/bridge-inventory-001/", import.meta.url),
);

const servers: ReturnType<typeof createItotoriServer>[] = [];

type PlayTargetEdit = {
  patchVersionId: string;
  resultRevisionId: string;
  parentPatchVersionId: string;
  targetBody: string;
  status: string;
};

type PlayDelivery = {
  patchVersionId: string;
  artifactHashes: Record<string, string>;
  downloadUrl: string;
  units: Array<{ bridgeUnitId: string; targetBody: string }>;
};

type ProductionParentArtifacts = {
  root: string;
  sourceRoot: string;
  sourceSeenPath: string;
  parentPatchTarget: string;
  bridgeUnitId: string;
  parentTargetBody: string;
  artifactRefs: Record<string, string>;
  artifactHashes: Record<string, string>;
  cleanup: () => void;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe.skipIf(!process.env.DATABASE_URL)("play-tester result revision live DB", () => {
  it("POST parent edit → POST child edit → selected real Kaifuu delivery over HTTP", async () => {
    const context = await isolatedMigratedContext();
    const artifacts = createProductionParentArtifacts();
    try {
      const runId = "play-tester-live-run";
      const parentPatch = await seedPlayableProductionRun(context, artifacts, runId);
      const sourceHashBefore = hashLocalizationArtifact(artifacts.sourceSeenPath);
      const origin = await startLiveServer(context.databaseUrl);
      const parentDelivery = await fetchDelivery(origin, runId);
      expect(parentDelivery.patchVersionId).toBe(parentPatch.patchVersionId);
      const parentPatchHash = parentDelivery.artifactHashes.patchTarget;
      expect(parentPatchHash).toBeTypeOf("string");

      const firstEdited = "Playtester Revision";
      const firstEdit = await postTargetEdit({
        origin,
        parentPatchVersionId: parentPatch.patchVersionId,
        bridgeUnitId: artifacts.bridgeUnitId,
        targetBody: firstEdited,
      });
      expect(firstEdit).toMatchObject({ targetBody: firstEdited, status: "playable" });
      expect(firstEdit.patchVersionId).not.toBe(parentPatch.patchVersionId);
      expect(firstEdit.resultRevisionId).toContain("play-tester-result:");
      expect(firstEdit.parentPatchVersionId).toBe(parentPatch.patchVersionId);

      const firstDelivery = await fetchDelivery(origin, runId);
      expect(firstDelivery.patchVersionId).toBe(firstEdit.patchVersionId);
      expect(
        firstDelivery.units.find((unit) => unit.bridgeUnitId === artifacts.bridgeUnitId)
          ?.targetBody,
      ).toBe(firstEdited);
      expect(firstDelivery.artifactHashes.patchTarget).not.toBe(parentPatchHash);
      const firstDeliveredSeen = await fetchDeliveredSeen(origin, runId, firstDelivery);
      expect(
        reextractDeliveredDialogue({
          artifacts,
          seenBytes: firstDeliveredSeen,
          label: "verify-first-child",
        }),
      ).toBe(bracketWrapForRealLive(firstEdited));

      // The second edit deliberately names the first child as its parent. This
      // proves a play tester can revise a delivered revision repeatedly, rather
      // than only fork the original terminal patch once.
      const secondEdited = "Playtester Revision Two";
      const secondEdit = await postTargetEdit({
        origin,
        parentPatchVersionId: firstEdit.patchVersionId,
        bridgeUnitId: artifacts.bridgeUnitId,
        targetBody: secondEdited,
      });
      expect(secondEdit).toMatchObject({ targetBody: secondEdited, status: "playable" });
      expect(secondEdit.parentPatchVersionId).toBe(firstEdit.patchVersionId);
      expect(secondEdit.patchVersionId).not.toBe(firstEdit.patchVersionId);
      expect(secondEdit.patchVersionId).not.toBe(parentPatch.patchVersionId);

      const secondDelivery = await fetchDelivery(origin, runId);
      expect(secondDelivery.patchVersionId).toBe(secondEdit.patchVersionId);
      expect(
        secondDelivery.units.find((unit) => unit.bridgeUnitId === artifacts.bridgeUnitId)
          ?.targetBody,
      ).toBe(secondEdited);
      expect(secondDelivery.artifactHashes.patchTarget).not.toBe(
        firstDelivery.artifactHashes.patchTarget,
      );
      const secondDeliveredSeen = await fetchDeliveredSeen(origin, runId, secondDelivery);
      expect(secondDeliveredSeen.equals(firstDeliveredSeen)).toBe(false);
      expect(
        reextractDeliveredDialogue({
          artifacts,
          seenBytes: secondDeliveredSeen,
          label: "verify-second-child",
        }),
      ).toBe(bracketWrapForRealLive(secondEdited));

      // The source archive is still immutable; each selected artifact is a
      // separately materialized Kaifuu output delivered through its tar route.
      expect(hashLocalizationArtifact(artifacts.sourceSeenPath)).toBe(sourceHashBefore);
    } finally {
      try {
        await context.close();
      } finally {
        artifacts.cleanup();
      }
    }
  }, 120_000);

  it("cleans production Kaifuu output when a real DB trigger aborts the child transaction", async () => {
    const context = await isolatedMigratedContext();
    const artifacts = createProductionParentArtifacts();
    try {
      const runId = "play-tester-live-trigger-rollback";
      const parentPatch = await seedPlayableProductionRun(context, artifacts, runId);
      const origin = await startLiveServer(context.databaseUrl);
      const sourceHashBefore = hashLocalizationArtifact(artifacts.sourceSeenPath);
      const parentTargetHashBefore = hashLocalizationArtifact(artifacts.parentPatchTarget);
      const parentDelivery = await fetchDelivery(origin, runId);

      // PostgreSQL sequence values are non-transactional. Incrementing it in
      // the AFTER INSERT trigger gives this test durable evidence that the
      // child membership insert was reached (after native materialization),
      // even though the enclosing database transaction is rolled back.
      await context.pool.query(`
        create sequence itotori_test_play_tester_trigger_counter start with 1
      `);
      await context.pool.query(`
        create function itotori_test_fail_production_play_tester_child()
        returns trigger
        language plpgsql
        as $$
        begin
          perform nextval('itotori_test_play_tester_trigger_counter');
          raise exception 'test injected production child membership failure';
        end;
        $$
      `);
      await context.pool.query(`
        create trigger itotori_test_fail_production_play_tester_child
        after insert on itotori_localization_patch_version_units
        for each row
        execute function itotori_test_fail_production_play_tester_child()
      `);

      const failedResponse = await fetch(
        `${origin}/api/play/patch-versions/${parentPatch.patchVersionId}/target-edits`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bridgeUnitId: artifacts.bridgeUnitId,
            targetBody: "This native patch must be cleaned after rollback.",
          }),
        },
      );
      expect(failedResponse.status).toBe(500);
      expect(await failedResponse.json()).toMatchObject({ code: "internal_error" });

      const triggerCounter = await context.pool.query<{ last_value: string; is_called: boolean }>(
        `
          select last_value::text as last_value, is_called
          from itotori_test_play_tester_trigger_counter
        `,
      );
      expect(triggerCounter.rows[0]).toMatchObject({ last_value: "1", is_called: true });

      const residualRows = await context.pool.query<{
        result_revisions: string;
        patch_versions: string;
        patch_units: string;
      }>(
        `
          select
            (
              select count(*)
              from itotori_localization_result_revisions
              where run_id = $1 and origin = 'play_tester_edit'
            )::text as result_revisions,
            (
              select count(*)
              from itotori_localization_patch_versions
              where run_id = $1 and origin = 'play_tester_edit'
            )::text as patch_versions,
            (
              select count(*)
              from itotori_localization_patch_version_units units
              join itotori_localization_patch_versions patches
                on patches.patch_version_id = units.patch_version_id
              where patches.run_id = $1 and patches.origin = 'play_tester_edit'
            )::text as patch_units
        `,
        [runId],
      );
      expect(residualRows.rows[0]).toMatchObject({
        result_revisions: "0",
        patch_versions: "0",
        patch_units: "0",
      });

      // The materializer creates a collision-safe revision directory beneath
      // this owned root. The root's presence proves the real materializer ran
      // before the trigger; cleanup must leave no child directory or files
      // behind.
      const revisionArtifactRoot = join(artifacts.root, "play-tester-revisions");
      expect(existsSync(revisionArtifactRoot)).toBe(true);
      expect(readdirSync(revisionArtifactRoot)).toEqual([]);
      expect(hashLocalizationArtifact(artifacts.sourceSeenPath)).toBe(sourceHashBefore);
      expect(hashLocalizationArtifact(artifacts.parentPatchTarget)).toBe(parentTargetHashBefore);

      const selectedAfterFailure = await fetchDelivery(origin, runId);
      expect(selectedAfterFailure.patchVersionId).toBe(parentPatch.patchVersionId);
      expect(selectedAfterFailure.artifactHashes.patchTarget).toBe(
        parentDelivery.artifactHashes.patchTarget,
      );
    } finally {
      try {
        await context.close();
      } finally {
        artifacts.cleanup();
      }
    }
  }, 120_000);
});

async function seedPlayableProductionRun(
  context: Awaited<ReturnType<typeof isolatedMigratedContext>>,
  artifacts: ProductionParentArtifacts,
  runId: string,
): Promise<{ patchVersionId: string }> {
  await bootstrapLocalUser(context.db);
  await seedScope(context);
  const journal = new ItotoriLocalizationJournalRepository(context.db);
  const finalizer = new ItotoriLocalizationRunFinalizerRepository(context.db);
  await journal.seedRun(actor, {
    runId,
    ...scope,
    frozenScope: { kind: "explicit_units", unitIds: [artifacts.bridgeUnitId] },
    routingPolicy: { routes: ["model-live/provider-live"] },
    // itotori-225-audit-allow: deterministic synthetic ceiling for fixture attempts.
    costPolicy: { kind: "play-tester-live", capUsd: "1.00" },
    units: [
      {
        bridgeUnitId: artifacts.bridgeUnitId,
        sourceUnitKey: "scene.play-tester-live",
        nextAction: { kind: "drive_unit", stage: "translation" },
      },
    ],
    lease: { ownerId: driverLease.ownerId },
    createdAt: "2026-07-12T19:00:00.000Z",
  });
  await writeUnit(journal, runId, artifacts.bridgeUnitId, artifacts.parentTargetBody);

  const patch = await finalizer.ensurePatchVersion(actor, {
    runId,
    artifactHashes: artifacts.artifactHashes,
    artifactRefs: artifacts.artifactRefs,
  });
  for (const stage of ["patch_build", "patch_apply", "validation"] as const) {
    await finalizer.upsertPatchStageEvidence(actor, {
      runId,
      stage,
      status: "succeeded",
      evidence: { fixture: "play-tester-live-real-kaifuu" },
    });
  }
  await finalizer.enterFinalizing(actor, { runId, lease: driverLease });
  await finalizer.completeSucceededRun(actor, {
    runId,
    patchVersionId: patch.patchVersionId,
  });
  return { patchVersionId: patch.patchVersionId };
}

async function startLiveServer(databaseUrl: string): Promise<string> {
  const server = createItotoriServer({
    databaseUrl,
    webRoot: new URL("file:///tmp/itotori-empty-web/"),
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function postTargetEdit(input: {
  origin: string;
  parentPatchVersionId: string;
  bridgeUnitId: string;
  targetBody: string;
}): Promise<PlayTargetEdit> {
  const response = await fetch(
    `${input.origin}/api/play/patch-versions/${encodeURIComponent(input.parentPatchVersionId)}/target-edits`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bridgeUnitId: input.bridgeUnitId, targetBody: input.targetBody }),
    },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as PlayTargetEdit;
}

async function fetchDelivery(origin: string, runId: string): Promise<PlayDelivery> {
  const response = await fetch(`${origin}/api/play/runs/${encodeURIComponent(runId)}/delivery`);
  expect(response.status).toBe(200);
  const delivery = (await response.json()) as PlayDelivery;
  expect(delivery.downloadUrl).toBe(`/api/play/runs/${encodeURIComponent(runId)}/delivery/archive`);
  return delivery;
}

async function fetchDeliveredSeen(
  origin: string,
  runId: string,
  delivery: PlayDelivery,
): Promise<Buffer> {
  expect(delivery.downloadUrl).toBe(`/api/play/runs/${encodeURIComponent(runId)}/delivery/archive`);
  const response = await fetch(new URL(delivery.downloadUrl, origin));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/x-tar");
  const archive = Buffer.from(await response.arrayBuffer());
  expect(archive.length).toBeGreaterThan(1024);
  return extractTarFile(archive, "REALLIVEDATA/Seen.txt");
}

function reextractDeliveredDialogue(input: {
  artifacts: ProductionParentArtifacts;
  seenBytes: Buffer;
  label: string;
}): string {
  const verificationRoot = join(input.artifacts.root, input.label);
  rmSync(verificationRoot, { recursive: true, force: true });
  cpSync(input.artifacts.sourceRoot, verificationRoot, { recursive: true });
  writeFileSync(join(verificationRoot, "REALLIVEDATA", "Seen.txt"), input.seenBytes);
  const verificationBridgePath = join(input.artifacts.root, `${input.label}-bridge.json`);
  runKaifuuRealliveExtract({
    gameRoot: verificationRoot,
    gameId: "fixture",
    gameVersion: "1",
    sourceProfileId: "fixture-profile",
    sourceLocale: "ja-JP",
    scene: 1,
    bundleOutputPath: verificationBridgePath,
  });
  const verificationBridge = JSON.parse(readFileSync(verificationBridgePath, "utf8")) as {
    units: Array<{ bridgeUnitId: string; sourceText: string }>;
  };
  const unit = verificationBridge.units.find(
    (candidate) => candidate.bridgeUnitId === input.artifacts.bridgeUnitId,
  );
  if (unit === undefined) {
    throw new Error(`delivered archive did not re-extract ${input.artifacts.bridgeUnitId}`);
  }
  return unit.sourceText;
}

function extractTarFile(archive: Buffer, wantedPath: string): Buffer {
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = prefix.length === 0 ? name : `${prefix}/${name}`;
    const size = tarOctal(header, 124, 12);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > archive.length) {
      throw new Error(`tar entry ${path} exceeds archive length`);
    }
    if (path === wantedPath) {
      return Buffer.from(archive.subarray(bodyStart, bodyEnd));
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`delivery tar did not contain ${wantedPath}`);
}

function tarString(buffer: Buffer, offset: number, length: number): string {
  const field = buffer.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  return field.subarray(0, terminator === -1 ? field.length : terminator).toString("utf8");
}

function tarOctal(buffer: Buffer, offset: number, length: number): number {
  const encoded = tarString(buffer, offset, length).trim();
  if (!/^[0-7]+$/u.test(encoded)) {
    throw new Error(`invalid tar octal size '${encoded}'`);
  }
  return Number.parseInt(encoded, 8);
}

function createProductionParentArtifacts(): ProductionParentArtifacts {
  const root = mkdtempSync(join(tmpdir(), "itotori-play-tester-live-real-"));
  const sourceRoot = join(root, "source-game");
  const sourceData = join(sourceRoot, "REALLIVEDATA");
  mkdirSync(sourceData, { recursive: true });
  copyFileSync(join(fixtureRoot, "SEEN.TXT"), join(sourceData, "Seen.txt"));
  copyFileSync(join(fixtureRoot, "Gameexe.ini"), join(sourceRoot, "Gameexe.ini"));
  const sourceSeenPath = join(sourceData, "Seen.txt");
  const extractedBridgePath = join(root, "extracted-bridge.json");
  runKaifuuRealliveExtract({
    gameRoot: sourceRoot,
    gameId: "fixture",
    gameVersion: "1",
    sourceProfileId: "fixture-profile",
    sourceLocale: "ja-JP",
    scene: 1,
    bundleOutputPath: extractedBridgePath,
  });

  const translatedBridge = JSON.parse(readFileSync(extractedBridgePath, "utf8")) as {
    units: Array<{
      bridgeUnitId: string;
      sourceText: string;
      surfaceKind: string;
      target?: { locale: string; text: string };
    }>;
  };
  const dialogue = translatedBridge.units.find((unit) => unit.surfaceKind === "dialogue");
  if (dialogue === undefined) {
    throw new Error("public RealLive fixture did not expose a dialogue unit");
  }
  const parentTargetBody = "Parent delivery";
  for (const unit of translatedBridge.units) {
    unit.target = {
      locale: "en-US",
      text:
        unit.bridgeUnitId === dialogue.bridgeUnitId
          ? bracketWrapForRealLive(parentTargetBody)
          : unit.sourceText,
    };
  }
  const translatedBridgePath = join(root, "translated-bridge.json");
  writeFileSync(translatedBridgePath, `${JSON.stringify(translatedBridge, null, 2)}\n`, "utf8");
  const parentPatchTarget = join(root, "parent-patch-target");
  const apply = applyKaifuuRealLivePatch({
    sourceRoot,
    targetRoot: parentPatchTarget,
    translatedBundlePath: translatedBridgePath,
    translationScope: "dialogue-only",
    force: false,
  });
  const patchApplyPath = join(root, "patch-apply.json");
  writeFileSync(patchApplyPath, `${JSON.stringify(apply, null, 2)}\n`, "utf8");
  const artifactRefs = {
    translatedBridge: translatedBridgePath,
    patchApply: patchApplyPath,
    patchTarget: parentPatchTarget,
  };
  return {
    root,
    sourceRoot,
    sourceSeenPath,
    parentPatchTarget,
    bridgeUnitId: dialogue.bridgeUnitId,
    parentTargetBody,
    artifactRefs,
    artifactHashes: Object.fromEntries(
      Object.entries(artifactRefs).map(([key, path]) => [key, hashLocalizationArtifact(path)]),
    ),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function writeUnit(
  journal: ItotoriLocalizationJournalRepository,
  runId: string,
  bridgeUnitId: string,
  targetBody: string,
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
        body: asNonBlankTargetText(targetBody),
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
    sourceUnitKey: "scene.play-tester-live",
    outcome,
    attempts: [],
    contextPacket: { fixture: "play-tester-live" },
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

async function closeServer(server: ReturnType<typeof createItotoriServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
