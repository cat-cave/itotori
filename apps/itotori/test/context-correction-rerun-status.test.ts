// The canonical context write and its asynchronous redraft are deliberately
// separate outcomes. This live-DB proof keeps that distinction observable at
// the production WikiBrain boundary when the installed worker records a retry.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ItotoriContextArtifactRepository,
  ItotoriEventQueueRepository,
  ItotoriLocalizationPassRunConfigRepository,
  ItotoriProjectRepository,
  bootstrapLocalUser,
  localUserId,
  type AuthorizationActor,
} from "@itotori/db";
import type { BridgeBundleV02, LocalizationUnitV02 } from "@itotori/localization-bridge-schema";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { assertWikiEditResponse } from "../src/api-schema.js";
import { withDatabaseItotoriServices } from "../src/services/database-services.js";

const ACTOR: AuthorizationActor = { userId: localUserId };
const PROJECT_ID = "019ed0ce-1000-7000-8000-00000000ce11";
const LOCALE_BRANCH_ID = "019ed0ce-1000-7000-8000-00000000ce12";
const SOURCE_REVISION_ID = "019ed0ce-1000-7000-8000-00000000ce13";
const SOURCE_PROFILE_REVISION_ID = "019ed0ce-1000-7000-8000-00000000ce14";
const BRIDGE_ID = "019ed0ce-1000-7000-8000-00000000ce15";
const ASSET_ID = "019ed0ce-1000-7000-8000-00000000ce16";
const UNIT_ID = "019ed0ce-1000-7000-8000-00000000ce17";
const SOURCE_REVISION_HASH = `sha256:${"c".repeat(64)}`;
const SOURCE_PROFILE_HASH = `sha256:${"d".repeat(64)}`;

function revision(revisionId: string, value: string) {
  return { revisionId, revisionKind: "content_hash" as const, value };
}

function bridgeFixture(): BridgeBundleV02 {
  const unit: LocalizationUnitV02 = {
    bridgeUnitId: UNIT_ID,
    surfaceId: ASSET_ID,
    surfaceKind: "dialogue",
    sourceUnitKey: "scene-001/line-001",
    occurrenceId: "rerun-status-occurrence-1",
    sourceLocale: "ja-JP",
    sourceText: "おはよう。",
    sourceHash: `sha256:${"e".repeat(64)}`,
    sourceRevision: revision(SOURCE_REVISION_ID, SOURCE_REVISION_HASH),
    sourceAssetRef: { assetId: ASSET_ID, assetKey: "rerun-status-scenario" },
    sourceLocation: { containerKey: "rerun-status-scenario" },
    context: { route: { sceneKey: "1" } },
    spans: [],
    patchRef: {
      assetId: ASSET_ID,
      writeMode: "replace",
      sourceUnitKey: "scene-001/line-001",
      sourceRevision: revision(SOURCE_REVISION_ID, SOURCE_REVISION_HASH),
    },
    runtimeExpectation: { expectationKind: "metadata_only" },
  };
  return {
    schemaVersion: "0.2.0",
    bridgeId: BRIDGE_ID,
    sourceGame: {
      gameId: "context-correction-rerun-status-fixture",
      gameVersion: "1",
      sourceProfileId: "context-correction-rerun-status-profile",
      sourceProfileRevision: revision(SOURCE_PROFILE_REVISION_ID, SOURCE_PROFILE_HASH),
    },
    sourceBundleHash: SOURCE_REVISION_HASH,
    sourceBundleRevision: revision(SOURCE_REVISION_ID, SOURCE_REVISION_HASH),
    sourceLocale: "ja-JP",
    hashStrategy: {
      sourceProfile: {
        scope: "source_profile",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
      sourceBundle: {
        scope: "source_bundle",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
      sourceAsset: { scope: "source_asset", algorithm: "sha256", normalization: "bytes" },
      sourceUnit: {
        scope: "source_unit",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
        fields: ["sourceLocale", "sourceUnitKey", "sourceText", "spans.raw"],
      },
      patchExport: {
        scope: "patch_export",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
      deltaPackage: {
        scope: "delta_package",
        algorithm: "sha256",
        normalization: "utf8-lf-json-stable-v1",
      },
    },
    extractor: { name: "context-correction-rerun-status-fixture", version: "1" },
    assets: [
      {
        assetId: ASSET_ID,
        assetKey: "rerun-status-scenario",
        assetKind: "text",
        sourceHash: SOURCE_REVISION_HASH,
        sourceRevision: revision(SOURCE_REVISION_ID, SOURCE_REVISION_HASH),
      },
    ],
    units: [unit],
    policyRecords: [],
  };
}

describe.skipIf(!process.env.DATABASE_URL)(
  "context-correction rerun receipt — Postgres-backed WikiBrain",
  () => {
    it("persists the canonical wiki version but returns pending when a redraft failure is retrying", async () => {
      const context = await isolatedMigratedContext();
      const workDir = mkdtempSync(join(tmpdir(), "itotori-context-correction-rerun-status-"));
      try {
        await bootstrapLocalUser(context.db);
        const bridge = bridgeFixture();
        await new ItotoriProjectRepository(context.db).importSourceBundle(ACTOR, {
          projectId: PROJECT_ID,
          localeBranchId: LOCALE_BRANCH_ID,
          targetLocale: "en-US",
          drafts: {},
          bridge,
        });
        await registerRunConfig(context.db, bridge, workDir);

        const receipt = await withDatabaseItotoriServices(
          {
            databaseUrl: context.databaseUrl,
            bootstrapLocalUser: false,
            contextCorrectionRedraftRunner: async () => {
              throw new Error("intentional redraft outage for receipt regression");
            },
          },
          async (services) =>
            await services.wiki.add({
              projectId: PROJECT_ID,
              localeBranchId: LOCALE_BRANCH_ID,
              sourceRevisionId: SOURCE_REVISION_ID,
              kind: "note",
              title: "Rerun-status canonical note",
              body: "This canonical note must survive a redraft retry.",
              reason: "Exercise the durable rerun status receipt.",
              affectedUnitIds: [UNIT_ID],
            }),
        );

        assertWikiEditResponse(receipt);
        expect(receipt).toMatchObject({
          schemaVersion: "wiki.context.edit.v0.2",
          contextEntryVersionId: expect.any(String),
          entry: expect.objectContaining({
            title: "Rerun-status canonical note",
            body: "This canonical note must survive a redraft retry.",
          }),
          rerun: {
            state: "pending",
            jobStatus: "retry_waiting",
            error: "intentional redraft outage for receipt regression",
          },
        });

        const persisted = await new ItotoriContextArtifactRepository(context.db).retrieveArtifacts(
          ACTOR,
          {
            projectId: PROJECT_ID,
            localeBranchId: LOCALE_BRANCH_ID,
            sourceRevisionId: SOURCE_REVISION_ID,
            categories: ["context_note"],
          },
        );
        expect(persisted.matches).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              contextArtifactId: receipt.contextArtifactId,
              headVersionId: receipt.contextEntryVersionId,
              body: "This canonical note must survive a redraft retry.",
            }),
          ]),
        );

        const redraftJob = await new ItotoriEventQueueRepository(context.db).getJob(
          ACTOR,
          receipt.redraftJobId,
        );
        expect(redraftJob).toMatchObject({
          status: "retry_waiting",
          lastError: "intentional redraft outage for receipt regression",
        });
      } finally {
        rmSync(workDir, { recursive: true, force: true });
        await context.close();
      }
    }, 30_000);
  },
);

async function registerRunConfig(
  db: Parameters<typeof bootstrapLocalUser>[0],
  bridge: BridgeBundleV02,
  workDir: string,
): Promise<void> {
  const bridgePath = join(workDir, "registered-bridge.json");
  const configPath = join(workDir, "registered.config.json");
  const pairPolicyPath = join(workDir, "registered.pair-policy.json");
  writeFileSync(bridgePath, `${JSON.stringify(bridge, null, 2)}\n`);
  writeFileSync(pairPolicyPath, "{}\n");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: "itotori.localize-fullproject.config.v0",
        projectId: PROJECT_ID,
        localeBranchId: LOCALE_BRANCH_ID,
        sourceRevisionId: SOURCE_REVISION_ID,
        engineProfile: "rpg-maker-mv-mz",
        targetLocale: "en-US",
        bridgePath,
        pairPolicyPath,
      },
      null,
      2,
    )}\n`,
  );
  await new ItotoriLocalizationPassRunConfigRepository(db).saveRunConfig(ACTOR, {
    projectId: PROJECT_ID,
    localeBranchId: LOCALE_BRANCH_ID,
    configPath,
    dataRoot: workDir,
    pairPolicyPath,
    modelId: "context-correction-rerun-status-model",
    providerId: "context-correction-rerun-status-provider",
    runDir: join(workDir, "registered-run"),
  });
}
