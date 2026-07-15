import { LlmMemoConflictError } from "@itotori/db";
import { describe, expect, it } from "vitest";
import { PhysicalStepMemoSchema } from "../src/contracts/index.js";
import { dispatch } from "../src/llm/dispatch.js";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { reviewVerdictExample } from "./contract-fixtures-core.js";
import {
  TestMemoCipher,
  decodedUnitsTool,
  dispatchHarness,
  physicalCallSpec,
  rawStructuredProviderResponse,
  structuredProviderResponse,
  toolLoopSpec,
  toolProviderResponse,
} from "./llm-step-test-support.js";

const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;

postgresDescribe("physical model step durability", () => {
  it("memoizes every model step and response event in a tool loop independently", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const prompt = "Use the decoded-unit tool twice, then return a verdict.";
    try {
      const harness = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt,
        responses: [
          toolProviderResponse(1),
          toolProviderResponse(2),
          structuredProviderResponse(reviewVerdictExample),
        ],
        tools: [decodedUnitsTool()],
      });

      const result = await dispatch(toolLoopSpec(prompt), harness.runtime);
      expect(result.status).toBe("success");
      expect(harness.transportCalls()).toBe(3);

      const memos = await context.pool.query<{
        memo_key: string;
        outcome_ciphertext: Uint8Array;
        outcome_key_ref: string;
        request_ciphertext: Uint8Array;
      }>(
        `
          select memo_key, outcome_ciphertext, outcome_key_ref, request_ciphertext
          from itotori_llm_call_memos order by completed_at
        `,
      );
      const events = await countRows(context.pool, "itotori_llm_conversation_events");
      const attempts = await countRows(context.pool, "itotori_llm_http_attempts");
      expect(memos.rows).toHaveLength(3);
      expect(new Set(memos.rows.map((row) => row.memo_key))).toHaveProperty("size", 3);
      expect(events).toBe(3);
      expect(attempts).toBe(3);
      expect(Buffer.from(memos.rows[0]!.request_ciphertext).includes(Buffer.from(prompt))).toBe(
        false,
      );
      for (const row of memos.rows) {
        const plaintext = await cipher.open(row.outcome_ciphertext, row.outcome_key_ref);
        expect(PhysicalStepMemoSchema.safeParse(JSON.parse(plaintext)).success).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  it("reuses every completed step after restart and dispatches only the missing step", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const prompt = "Use the decoded-unit tool twice, then return a verdict.";
    const spec = toolLoopSpec(prompt);
    let firstToolExecutions = 0;
    const interruptedSignal = new AbortController();
    try {
      const interrupted = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt,
        responses: [
          toolProviderResponse(1),
          toolProviderResponse(2),
          async () => {
            interruptedSignal.abort();
            throw new Error("operator cancelled the interrupted run");
          },
        ],
        tools: [decodedUnitsTool(() => (firstToolExecutions += 1))],
        signal: interruptedSignal.signal,
      });
      const interruptedResult = await dispatch(spec, interrupted.runtime);
      expect(interruptedResult.status).toBe("failure");
      expect(interruptedResult).toMatchObject({ failureKind: "cancelled" });
      expect(interrupted.transportCalls()).toBe(3);
      expect(firstToolExecutions).toBe(2);

      const before = await memoKeys(context.pool);
      expect(before).toHaveLength(2);

      let restartedToolExecutions = 0;
      const restarted = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt,
        responses: [structuredProviderResponse(reviewVerdictExample)],
        tools: [decodedUnitsTool(() => (restartedToolExecutions += 1))],
      });
      const restartedResult = await dispatch(spec, restarted.runtime);
      expect(restartedResult.status).toBe("success");
      expect(restarted.transportCalls()).toBe(1);
      expect(restartedToolExecutions).toBe(2);

      const after = await memoKeys(context.pool);
      const discardedMemoKeys = before.filter((key) => !after.includes(key));
      expect(discardedMemoKeys).toEqual([]);
      expect(after).toHaveLength(3);
      expect(await countRows(context.pool, "itotori_llm_conversation_events")).toBe(3);

      const missingStepAttempts = await context.pool.query<{ attempt_status: string }>(
        `
          select attempt_status from itotori_llm_http_attempts
          where memo_key = $1 order by attempt_ordinal
        `,
        [after.find((key) => !before.includes(key))],
      );
      expect(missingStepAttempts.rows.map((row) => row.attempt_status)).toEqual([
        "cancelled",
        "completed",
      ]);
    } finally {
      await context.close();
    }
  });

  it("coalesces concurrent identical steps to one billed transport call", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const prompt = "Return a verdict.";
    let announceStarted!: () => void;
    let releaseResponse!: () => void;
    const started = new Promise<void>((resolve) => (announceStarted = resolve));
    const released = new Promise<void>((resolve) => (releaseResponse = resolve));
    try {
      const harness = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt,
        responses: [
          async () => {
            announceStarted();
            await released;
            return structuredProviderResponse(reviewVerdictExample);
          },
        ],
      });
      const spec = physicalCallSpec(prompt);
      const first = dispatch(spec, harness.runtime);
      await started;
      const second = dispatch(spec, harness.runtime);
      releaseResponse();
      const results = await Promise.all([first, second]);

      expect(harness.transportCalls()).toBe(1);
      expect(results.map((result) => result.memoHit).sort()).toEqual([false, true]);
      expect(await countRows(context.pool, "itotori_llm_call_memos")).toBe(1);
      expect(await countRows(context.pool, "itotori_llm_http_attempts")).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("returns a completed invalid response from its immutable memo without recalling", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const prompt = "Return a verdict.";
    const spec = physicalCallSpec(prompt);
    try {
      const first = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt,
        responses: [rawStructuredProviderResponse("{}")],
      });
      expect(await dispatch(spec, first.runtime)).toMatchObject({
        status: "failure",
        failureKind: "schema-failure",
        memoHit: false,
      });

      const replay = dispatchHarness({ pool: context.pool, cipher, prompt, responses: [] });
      expect(await dispatch(spec, replay.runtime)).toMatchObject({
        status: "failure",
        failureKind: "schema-failure",
        memoHit: true,
      });
      expect(replay.transportCalls()).toBe(0);
      const outcome = await context.pool.query<{ outcome_kind: string }>(
        "select outcome_kind from itotori_llm_call_memos",
      );
      expect(outcome.rows).toEqual([{ outcome_kind: "invalid" }]);
    } finally {
      await context.close();
    }
  });

  it("rejects semantic parameter drift for the same logical step before transport", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const prompt = "Return a verdict.";
    try {
      const first = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt,
        responses: [structuredProviderResponse(reviewVerdictExample)],
      });
      await dispatch(physicalCallSpec(prompt), first.runtime);

      const drift = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt,
        responses: [structuredProviderResponse(reviewVerdictExample)],
      });
      await expect(
        dispatch(
          physicalCallSpec(prompt, { sampling: { temperature: 0.5, topP: 1, seed: null } }),
          drift.runtime,
        ),
      ).rejects.toBeInstanceOf(LlmMemoConflictError);
      expect(drift.transportCalls()).toBe(0);
      expect(await countRows(context.pool, "itotori_llm_call_memos")).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("uses an explicit sampleId to create one deliberate independent sample", async () => {
    const context = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const prompt = "Return a verdict.";
    try {
      const ordinary = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt,
        responses: [structuredProviderResponse(reviewVerdictExample)],
      });
      const ordinaryResult = await dispatch(physicalCallSpec(prompt), ordinary.runtime);

      const independent = dispatchHarness({
        pool: context.pool,
        cipher,
        prompt,
        responses: [structuredProviderResponse(reviewVerdictExample)],
      });
      const sampledSpec = physicalCallSpec(prompt, { sampleId: "sample:independent:1" });
      const sampledResult = await dispatch(sampledSpec, independent.runtime);
      expect(sampledResult.memoKey).not.toBe(ordinaryResult.memoKey);
      expect(independent.transportCalls()).toBe(1);

      const replay = dispatchHarness({ pool: context.pool, cipher, prompt, responses: [] });
      expect(await dispatch(sampledSpec, replay.runtime)).toMatchObject({ memoHit: true });
      expect(replay.transportCalls()).toBe(0);
      expect(await countRows(context.pool, "itotori_llm_call_memos")).toBe(2);
    } finally {
      await context.close();
    }
  });
});

async function countRows(
  pool: Awaited<ReturnType<typeof isolatedMigratedContext>>["pool"],
  table: string,
) {
  if (!/^itotori_llm_[a-z_]+$/u.test(table)) throw new Error("unexpected table name");
  const result = await pool.query<{ count: string }>(
    `select count(*)::text as count from ${table}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function memoKeys(
  pool: Awaited<ReturnType<typeof isolatedMigratedContext>>["pool"],
): Promise<string[]> {
  const result = await pool.query<{ memo_key: string }>(
    "select memo_key from itotori_llm_call_memos order by completed_at",
  );
  return result.rows.map((row) => row.memo_key);
}
