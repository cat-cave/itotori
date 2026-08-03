import { createHash } from "node:crypto";

import { ItotoriLlmAcceptedOutputRepository, ItotoriWorkflowStepMemoRepository } from "@itotori/db";
import { describe, expect, it } from "vitest";

import { createLiveWorkflowArtifactStore } from "../src/composition/live/index.js";
import { FULL_ROSTER, resolveRunPolicy } from "../src/run-policy/index.js";
import {
  createWorkflowMemoIdentity,
  createWorkflowMemoRoleRoutes,
  workflowMemoKeyFor,
  type WorkflowMemoRoleRoutes,
} from "../src/workflow/index.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { TestMemoCipher } from "./llm-step-test-support.js";

const SNAPSHOT_ID = `sha256:${"a".repeat(64)}` as const;
const CONTEXT_ID = `sha256:${"b".repeat(64)}` as const;
const SCHEMA_HASH = `sha256:${"c".repeat(64)}` as const;

describe("workflow memo identity over live Postgres", () => {
  it("keeps a model-only variant in a distinct durable checkpoint", async () => {
    requireLivePostgres();
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const routes = createWorkflowMemoRoleRoutes();
      const baseIdentity = memoIdentity(routes);
      const modelOnlyRoutes: WorkflowMemoRoleRoutes = {
        ...routes,
        P1: {
          ...routes.P1,
          requestedModel: `${routes.P1.requestedModel}-alternate`,
        },
      };
      const modelOnlyIdentity = memoIdentity(modelOnlyRoutes);
      const policy = resolveRunPolicy({
        runMode: "test-dev",
        contextScope: "whole-game",
        outputScope: "dialogue-only",
        roster: FULL_ROSTER,
        ablation: null,
      });
      const parts = ["shared-draft", "shared-scene", "whole-scene", ["shared-unit"]] as const;
      const baseKey = workflowMemoKeyFor({
        identity: baseIdentity,
        policy,
        step: "draft",
        role: "P1",
        parts,
      });
      const modelOnlyKey = workflowMemoKeyFor({
        identity: modelOnlyIdentity,
        policy,
        step: "draft",
        role: "P1",
        parts,
      });
      expect(modelOnlyKey).not.toBe(baseKey);

      const cache = new ItotoriWorkflowStepMemoRepository(context.pool, cipher, {
        requireContentRead: async () => undefined,
      });
      const firstStore = storeFor(context.pool, cipher, cache);
      const secondStore = storeFor(context.pool, cipher, cache);
      let producerCalls = 0;
      const first = await firstStore.runMemoizedStep(baseKey, async () => ({
        sequence: (producerCalls += 1),
      }));
      const second = await secondStore.runMemoizedStep(modelOnlyKey, async () => ({
        sequence: (producerCalls += 1),
      }));
      const replayStore = storeFor(context.pool, cipher, cache);
      const replay = await replayStore.runMemoizedStep(baseKey, async () => ({
        sequence: (producerCalls += 1),
      }));

      expect(first.memoHit).toBe(false);
      expect(second.memoHit).toBe(false);
      expect(replay).toEqual({ memoHit: true, value: { sequence: 1 } });
      expect(producerCalls).toBe(2);
      const rows = await context.pool.query<{ memo_key: string }>(
        "select memo_key from itotori_llm_workflow_step_memos order by memo_key",
      );
      expect(rows.rows.map((row) => row.memo_key)).toEqual([baseKey, modelOnlyKey].sort());
      console.log(
        JSON.stringify({
          workflowMemoIsolationProof: {
            database: "live-postgresql",
            onlyChangedIdentityField: "P1.requestedModel",
            distinctDurableEntries: rows.rows.length,
            producerCalls,
            sameIdentityReplayMemoHit: replay.memoHit,
          },
        }),
      );
    } finally {
      await context.close();
    }
  });
});

function requireLivePostgres(): void {
  if (process.env.DATABASE_URL === undefined)
    throw new Error("workflow memo identity proof requires DATABASE_URL");
}

function memoIdentity(roleRoutes: WorkflowMemoRoleRoutes) {
  return createWorkflowMemoIdentity({
    projectId: "shared-project",
    runId: "shared-run",
    localeBranchId: "shared-en-US",
    contextSnapshotId: CONTEXT_ID,
    localizationSnapshotId: SNAPSHOT_ID,
    schemaHash: SCHEMA_HASH,
    targetLocale: "en-US",
    draftBudget: { budgetBytes: 16_384, overlapUnits: 1 },
    roleRoutes,
  });
}

function storeFor(
  pool: ConstructorParameters<typeof ItotoriLlmAcceptedOutputRepository>[0],
  cipher: TestMemoCipher,
  stepCache: ItotoriWorkflowStepMemoRepository,
) {
  const accepted = new ItotoriLlmAcceptedOutputRepository(pool, cipher);
  return createLiveWorkflowArtifactStore({
    accepted,
    snapshotId: SNAPSHOT_ID,
    stepCache,
    resolveFinalizeArtifact: (input) => ({
      outputId: `${input.unitId}:${input.stage}:v${(input.priorHead?.version ?? 0) + 1}`,
      semanticKey: sha256(`semantic:${input.unitId}:${input.stage}`),
      schemaVersion: "itotori.accepted-output.v1",
      outputJson: JSON.stringify({ unitId: input.unitId, target: input.contentHash }),
      memoKeys: [],
      sourceHash: sha256(`source:${input.unitId}`),
    }),
  });
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
