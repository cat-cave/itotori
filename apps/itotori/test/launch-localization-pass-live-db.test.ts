import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { FULL_ROSTER } from "../src/run-policy/index.js";
import { withDatabaseItotoriServices } from "../src/services/database-services.js";
import { loadBridgeBundle, wholeGameStructure } from "./support/gate-fixtures.js";

import { requireLivePostgres } from "../../../packages/itotori-db/test/live-postgres-suite.js";

const postgresDescribe = requireLivePostgres(describe);
const launchEnvironment = {
  OPENROUTER_API_KEY: "launch-pass-test-key",
  ITOTORI_TARGET_LOCALE: "en-US",
  ITOTORI_DRAFT_SCHEMA_HASH: hash("a"),
  ITOTORI_DECODE_REVISION_HASH: hash("b"),
  ITOTORI_GLOSSARY_REVISION_HASH: hash("c"),
  ITOTORI_STYLE_REVISION_HASH: hash("d"),
  ITOTORI_LOCALIZE_MAX_ATTEMPT_EXPOSURE_USD: "0.000010",
  ITOTORI_LOCALIZE_COST_CAP_USD: "1.000000",
  ITOTORI_FIELD_CIPHER_KEY: Buffer.alloc(32, 12).toString("base64"),
};
const previousEnvironment = new Map<string, string | undefined>();

postgresDescribe("launch localization pass live database", () => {
  beforeAll(() => {
    for (const [key, value] of Object.entries(launchEnvironment)) {
      previousEnvironment.set(key, process.env[key]);
      process.env[key] = value;
    }
  });

  afterAll(() => {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("admits a composite branch snapshot and atomically rejects a concurrent second run", async () => {
    const context = await isolatedMigratedContext();
    try {
      await withDatabaseItotoriServices({ databaseUrl: context.databaseUrl }, async (services) => {
        const projectId = "launch-project-live";
        const localeBranchId = "launch-project-live:en-US";
        const bridge = loadBridgeBundle();
        await services.projectWorkflow.ensureRunProjectScope({
          projectId,
          localeBranchId,
          sourceRevisionId: "launch-source-revision-live",
          sourceLocale: "ja-JP",
          targetLocale: "en-US",
          engineFamily: "synthetic_fixture",
          sourceRoot: "/fixture/source",
          buildRoot: "/fixture/build",
          extractProfile: { source: "launch-pass-live-db" },
        });
        const source = await services.localizationSubstrate.resolvePortSource(
          {
            runMode: "production",
            contextScope: "whole-game",
            outputScope: "dialogue-only",
            roster: FULL_ROSTER,
            ablation: null,
          },
          {
            structureJson: parseableStructure(),
            bridge,
            projectRun: {
              projectId,
              runId: "launch-identity-run",
              localeBranchId,
              leaseOwnerId: "launch-pass:launch-identity-run",
            },
          },
        );
        if (source.runPlane === undefined) throw new Error("live source has no project run plane");

        await services.projectWorkflow.createRun({
          projectId,
          runId: source.runPlane.runId,
          localeBranchId,
          contextSnapshotId: source.runPlane.contextSnapshotId,
          localizationSnapshotId: source.runPlane.localizationSnapshotId,
          capMicrosUsd: source.runPlane.capMicrosUsd,
        });
        const snapshot = await context.pool.query(
          "select snapshot_identity ->> 'localeBranchId' as locale_branch_id from itotori_llm_localization_snapshots where snapshot_id = $1",
          [source.runPlane.localizationSnapshotId],
        );
        expect(snapshot.rows).toEqual([{ locale_branch_id: localeBranchId }]);

        const lease = await services.projectWorkflow.acquireLease({
          projectId,
          runId: source.runPlane.runId,
          leaseOwnerId: source.runPlane.leaseOwnerId,
        });
        await services.projectWorkflow.advanceRun({ lease, status: "running" });
        await services.projectWorkflow.advanceRun({ lease, status: "completed" });
        await services.projectWorkflow.releaseLease(lease);

        const concurrent = await Promise.allSettled(
          ["launch-concurrent-a", "launch-concurrent-b"].map((runId) =>
            services.projectWorkflow.createRun({
              projectId,
              runId,
              localeBranchId,
              contextSnapshotId: source.runPlane.contextSnapshotId,
              localizationSnapshotId: source.runPlane.localizationSnapshotId,
              capMicrosUsd: source.runPlane.capMicrosUsd,
            }),
          ),
        );
        expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(concurrent.filter((result) => result.status === "rejected")).toMatchObject([
          {
            reason: {
              code: "active_branch_collision",
              message: expect.stringContaining(
                "constraint 'itotori_project_runs_one_active_branch_idx'",
              ),
            },
          },
        ]);
      });
    } finally {
      await context.close();
    }
  }, 60_000);
});

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function parseableStructure() {
  const structure = wholeGameStructure();
  return {
    ...structure,
    scenes: structure.scenes.map((scene) => ({
      ...scene,
      units: (scene.units ?? []).map((unit) => ({
        ...unit,
        sourceAsset: { ...unit.sourceAsset, assetKey: unit.sourceAsset.assetId },
      })),
    })),
  };
}
