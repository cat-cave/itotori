import { createHash } from "node:crypto";
import {
  ItotoriLlmAcceptedOutputRepository,
  ItotoriWorkflowStepMemoRepository,
  LlmQuarantinedResponseError,
  WorkflowStepMemoConflictError,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { dispatch } from "../src/llm/dispatch.js";
import { reviewVerdictExample } from "./contract-fixtures-core.js";
import {
  TestMemoCipher,
  dispatchHarness,
  physicalCallSpec,
  structuredProviderResponse,
} from "./llm-step-test-support.js";
import {
  createLiveWorkflowArtifactStore,
  type AcceptedUnitOutput,
} from "../src/composition/live/index.js";

// Live-DB round-trip proof for the CAS-backed workflow artifact store. Seeds a
// explicitly-unknown physical memo through the real dispatch boundary against a live
// Postgres, then finalizes and reads back a real accepted-output CAS head. No
// live LLM/network: the recorded-transport path only.
const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const SNAPSHOT_ID = `sha256:${"a".repeat(64)}` as const;

postgresDescribe("live workflow artifact store — real CAS round-trip", () => {
  it("finalizes and re-reads a unit head backed by an explicit-unknown memo", async () => {
    const ctx = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const prompt = "Return a verdict.";
    try {
      // A schema-valid explicit-unknown memo is admissible while upstream
      // served-pair reconciliation is intentionally gated off.
      const draft = dispatchHarness({
        pool: ctx.pool,
        cipher,
        prompt,
        responses: [structuredProviderResponse(reviewVerdictExample)],
      });
      const draftResult = await dispatch(physicalCallSpec(prompt), draft.runtime);
      expect(draftResult).toMatchObject({ status: "success", verification: "explicit-unknown" });
      if (draftResult.status !== "success") throw new Error("expected accepted success");

      const accepted = new ItotoriLlmAcceptedOutputRepository(ctx.pool, cipher);
      const store = createLiveWorkflowArtifactStore({
        accepted,
        snapshotId: SNAPSHOT_ID,
        resolveFinalizeArtifact: (input): AcceptedUnitOutput => {
          const version = (input.priorHead?.version ?? 0) + 1;
          return {
            outputId: `${input.unitId}:${input.stage}:v${version}`,
            semanticKey: sha256(`semantic:${input.unitId}:${input.stage}`),
            schemaVersion: "itotori.accepted-output.v1",
            outputJson: JSON.stringify({ unitId: input.unitId, target: input.contentHash }),
            memoKeys: [draftResult.memoKey],
            sourceHash: sha256(`source:${input.unitId}`),
          };
        },
      });

      expect(await store.readUnitHead("unit:live", "final")).toBeNull();

      const finalized = await store.finalizeUnit({
        unitId: "unit:live",
        stage: "final",
        contentHash: `sha256:${"1".repeat(64)}`,
        shippable: true,
      });
      expect(finalized).toMatchObject({ unitId: "unit:live", stage: "final", version: 1 });

      const head = await store.readUnitHead("unit:live", "final");
      expect(head).toEqual(finalized);
    } finally {
      await ctx.close();
    }
  });

  it("rejects a finalize whose memo keys are quarantined", async () => {
    const ctx = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    try {
      const accepted = new ItotoriLlmAcceptedOutputRepository(ctx.pool, cipher);
      const store = createLiveWorkflowArtifactStore({
        accepted,
        snapshotId: SNAPSHOT_ID,
        resolveFinalizeArtifact: (input): AcceptedUnitOutput => ({
          outputId: `${input.unitId}:${input.stage}:v1`,
          semanticKey: sha256(`semantic:${input.unitId}`),
          schemaVersion: "itotori.accepted-output.v1",
          outputJson: JSON.stringify({ unitId: input.unitId }),
          // A memo key with no accepted row — the CAS must refuse to advance.
          memoKeys: [sha256("memo:unverified")],
          sourceHash: null,
        }),
      });
      await expect(
        store.finalizeUnit({
          unitId: "unit:unverified",
          stage: "final",
          contentHash: `sha256:${"2".repeat(64)}`,
          shippable: true,
        }),
      ).rejects.toBeInstanceOf(LlmQuarantinedResponseError);
    } finally {
      await ctx.close();
    }
  });

  it("replays an encrypted completed step through a separately constructed store", async () => {
    const ctx = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const memoKey = "b".repeat(64);
    const value = { result: "step-cache-private-value" };
    try {
      const accepted = new ItotoriLlmAcceptedOutputRepository(ctx.pool, cipher);
      const stepCache = new ItotoriWorkflowStepMemoRepository(ctx.pool, cipher, {
        requireContentRead: async () => undefined,
      });
      const makeStore = () =>
        createLiveWorkflowArtifactStore({
          accepted,
          snapshotId: SNAPSHOT_ID,
          stepCache,
          resolveFinalizeArtifact: (input): AcceptedUnitOutput => ({
            outputId: `${input.unitId}:${input.stage}:v${(input.priorHead?.version ?? 0) + 1}`,
            semanticKey: sha256(`semantic:${input.unitId}:${input.stage}`),
            schemaVersion: "itotori.accepted-output.v1",
            outputJson: JSON.stringify({ unitId: input.unitId, target: input.contentHash }),
            memoKeys: [],
            sourceHash: sha256(`source:${input.unitId}`),
          }),
        });
      let producerCalls = 0;

      const first = await makeStore().runMemoizedStep(memoKey, async () => {
        producerCalls += 1;
        return value;
      });
      const second = await makeStore().runMemoizedStep(memoKey, async () => {
        producerCalls += 1;
        return { result: "must-not-run" };
      });

      expect(first).toEqual({ memoHit: false, value });
      expect(second).toEqual({ memoHit: true, value });
      expect(producerCalls).toBe(1);

      const stored = await ctx.pool.query<{ value_ciphertext: Uint8Array }>(
        "select value_ciphertext from itotori_llm_workflow_step_memos where memo_key = $1",
        [memoKey],
      );
      expect(stored.rows).toHaveLength(1);
      expect(Buffer.from(stored.rows[0]!.value_ciphertext)).not.toContain(
        Buffer.from(value.result),
      );
      await expect(
        stepCache.set(memoKey, JSON.stringify({ result: "different" })),
      ).rejects.toBeInstanceOf(WorkflowStepMemoConflictError);
    } finally {
      await ctx.close();
    }
  });
});

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
