import { createHash } from "node:crypto";
import {
  ItotoriLlmAcceptedOutputRepository,
  LlmAcceptedOutputCasError,
  type AcceptLlmOutputInput,
  type DatabaseContext,
  type LlmAcceptedOutputHead,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { dispatch, type DispatchRuntime } from "../src/llm/dispatch.js";
import { reviewVerdictExample } from "./contract-fixtures-core.js";
import {
  STEP_HASH_D,
  TestMemoCipher,
  decodedUnitsTool,
  dispatchHarness,
  physicalCallSpec,
  structuredProviderResponse,
  toolLoopSpec,
  toolProviderResponse,
} from "./llm-step-test-support.js";

// Substrate crash-recovery durability proof. Deterministic fault hooks kill at each
// of the six physical call boundaries; a restart drives the SAME spec over a FRESH transport
// against the SAME live Postgres, so a re-dispatched durable memo or a lost
// accepted unit shows up as an extra transport call, a missing memo, or a moved
// head. No live LLM/network: the recorded/memo path only. The fault hooks are
// test infrastructure (a pre-aborted signal, an aborting transport, and a store
// decorator that throws after the response) — not production randomness.
const postgresDescribe = process.env.DATABASE_URL ? describe : describe.skip;
const verdict = () => structuredProviderResponse(reviewVerdictExample);

postgresDescribe("substrate crash recovery at every physical call boundary", () => {
  it("BOUNDARY (a) before dispatch: nothing is lost and only the missing step re-runs", async () => {
    const ctx = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const prompt = "Return a verdict.";
    const spec = physicalCallSpec(prompt);
    try {
      const killed = new AbortController();
      killed.abort();
      const interrupted = dispatchHarness({
        pool: ctx.pool,
        cipher,
        prompt,
        responses: [verdict()],
        signal: killed.signal,
      });
      const interruptedResult = await dispatch(spec, interrupted.runtime);
      expect(interruptedResult).toMatchObject({ status: "failure", failureKind: "cancelled" });
      // Killed before the physical step reached the transport or any durable write.
      expect(interrupted.transportCalls()).toBe(0);
      expect(await countRows(ctx.pool, "itotori_llm_call_memos")).toBe(0);
      expect(await countRows(ctx.pool, "itotori_llm_http_attempts")).toBe(0);

      const restart = dispatchHarness({ pool: ctx.pool, cipher, prompt, responses: [verdict()] });
      const restartResult = await dispatch(spec, restart.runtime);
      expect(restartResult).toMatchObject({ status: "success", memoHit: false });
      expect(restart.transportCalls()).toBe(1); // ONLY the genuinely missing step
      expect(await countRows(ctx.pool, "itotori_llm_call_memos")).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it("BOUNDARY (b) in flight: the killed attempt is recorded honestly and the step re-dispatches", async () => {
    const ctx = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const prompt = "Return a verdict.";
    const spec = physicalCallSpec(prompt);
    try {
      const killed = new AbortController();
      const interrupted = dispatchHarness({
        pool: ctx.pool,
        cipher,
        prompt,
        // The request leaves for the remote, then the connection is severed before
        // any response is received: whether the remote billed us is UNKNOWN.
        responses: [
          () => {
            killed.abort();
            return Promise.reject(new Error("connection severed in flight"));
          },
        ],
        signal: killed.signal,
      });
      const interruptedResult = await dispatch(spec, interrupted.runtime);
      expect(interruptedResult).toMatchObject({ status: "failure", failureKind: "cancelled" });
      expect(interrupted.transportCalls()).toBe(1); // the request WAS dispatched (in flight)
      expect(await countRows(ctx.pool, "itotori_llm_call_memos")).toBe(0); // outcome NOT assumed success

      const restart = dispatchHarness({ pool: ctx.pool, cipher, prompt, responses: [verdict()] });
      const restartResult = await dispatch(spec, restart.runtime);
      expect(restartResult).toMatchObject({ status: "success", memoHit: false });
      expect(restart.transportCalls()).toBe(1); // the missing step re-dispatches

      // Honest ambiguity: the killed attempt is neither erased nor blessed as success —
      // it stays in the journal as an ambiguous attempt ahead of the completing one.
      expect(await attemptStatuses(ctx.pool, restartResult.memoKey)).toEqual([
        "cancelled",
        "completed",
      ]);
      expect(await countRows(ctx.pool, "itotori_llm_call_memos")).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it("BOUNDARY (c) after remote response, before memo insert: double-bill window is reported, not erased", async () => {
    const ctx = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const prompt = "Return a verdict.";
    const spec = physicalCallSpec(prompt);
    try {
      const ledger = { remoteResponsesProduced: 0 };
      const base = dispatchHarness({ pool: ctx.pool, cipher, prompt, responses: [verdict()] });
      const interruptedResult = await dispatch(spec, killAfterResponse(base.runtime, ledger));
      expect(interruptedResult).toMatchObject({ status: "failure", failureKind: "cancelled" });
      expect(base.transportCalls()).toBe(1); // the remote WAS contacted...
      expect(ledger.remoteResponsesProduced).toBe(1); // ...and produced a billable response...
      expect(await countRows(ctx.pool, "itotori_llm_call_memos")).toBe(0); // ...never committed.
      // Honest ambiguity: the attempt is recorded as an ambiguous interruption — NOT
      // silently assumed to have succeeded (no memo) and NOT erased (the row remains).
      expect(await attemptStatuses(ctx.pool, interruptedResult.memoKey)).toEqual(["cancelled"]);

      const restart = dispatchHarness({ pool: ctx.pool, cipher, prompt, responses: [verdict()] });
      const restartResult = await dispatch(spec, restart.runtime);
      expect(restartResult).toMatchObject({ status: "success", memoHit: false });
      // Recovery re-dispatches the missing step. That second remote production is the
      // documented, bounded double-bill window — surfaced (journal + ledger), never
      // allowed to erase correct work.
      expect(restart.transportCalls()).toBe(1);
      expect(ledger.remoteResponsesProduced).toBe(1); // only the interrupted run went through this hook
      expect(await attemptStatuses(ctx.pool, restartResult.memoKey)).toEqual([
        "cancelled",
        "completed",
      ]);
      expect(await countRows(ctx.pool, "itotori_llm_call_memos")).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it("BOUNDARY (d) after memo insert: the durable memo is reused, never re-dispatched", async () => {
    const ctx = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const prompt = "Return a verdict.";
    const spec = physicalCallSpec(prompt);
    try {
      const first = dispatchHarness({ pool: ctx.pool, cipher, prompt, responses: [verdict()] });
      const firstResult = await dispatch(spec, first.runtime);
      expect(firstResult).toMatchObject({ status: "success", memoHit: false });
      expect(first.transportCalls()).toBe(1);
      const before = await memoKeys(ctx.pool);

      // The process died after the memo committed but before the workflow advanced.
      // The restart transport carries NO responses: a re-dispatch would throw.
      const restart = dispatchHarness({ pool: ctx.pool, cipher, prompt, responses: [] });
      const restartResult = await dispatch(spec, restart.runtime);
      expect(restartResult).toMatchObject({ status: "success", memoHit: true });
      expect(restart.transportCalls()).toBe(0); // durable memo NOT re-called
      expect(await memoKeys(ctx.pool)).toEqual(before); // not lost, not duplicated
    } finally {
      await ctx.close();
    }
  });

  it("BOUNDARY (e) after tool result: the completed model step is reused and only the terminal step re-runs", async () => {
    const ctx = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const prompt = "Use the decoded-unit tool twice, then return a verdict.";
    const spec = toolLoopSpec(prompt);
    try {
      const killed = new AbortController();
      let interruptedToolRuns = 0;
      const interrupted = dispatchHarness({
        pool: ctx.pool,
        cipher,
        prompt,
        // Two tool-call model steps commit and their tools run; the process is then
        // killed after the last tool result, before the terminal model step dispatches.
        responses: [
          toolProviderResponse(1),
          toolProviderResponse(2),
          () => {
            killed.abort();
            return Promise.reject(new Error("killed after tool result, before terminal step"));
          },
        ],
        tools: [decodedUnitsTool(() => (interruptedToolRuns += 1))],
        signal: killed.signal,
      });
      const interruptedResult = await dispatch(spec, interrupted.runtime);
      expect(interruptedResult.status).toBe("failure");
      expect(interrupted.transportCalls()).toBe(3); // two tool steps committed + killed terminal step
      expect(interruptedToolRuns).toBe(2);
      const before = await memoKeys(ctx.pool);
      expect(before).toHaveLength(2); // only the two tool-call model steps are durable

      let restartToolRuns = 0;
      const restart = dispatchHarness({
        pool: ctx.pool,
        cipher,
        prompt,
        responses: [verdict()],
        tools: [decodedUnitsTool(() => (restartToolRuns += 1))],
      });
      const restartResult = await dispatch(spec, restart.runtime);
      expect(restartResult.status).toBe("success");
      expect(restart.transportCalls()).toBe(1); // ONLY the missing terminal step
      expect(restartToolRuns).toBe(2); // tool results re-derived locally, not from re-called models
      const after = await memoKeys(ctx.pool);
      expect(before.every((key) => after.includes(key))).toBe(true); // tool-step memos neither lost nor re-dispatched
      expect(after).toHaveLength(3);
    } finally {
      await ctx.close();
    }
  });

  it("BOUNDARY (f) / SYS-1: a crash after accepted-output CAS cannot discard the accepted output on re-run", async () => {
    const ctx = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const prompt = "Return a verdict.";
    const spec = physicalCallSpec(prompt);
    try {
      // Draft the unit and durably memoize its verified response.
      const draft = dispatchHarness({ pool: ctx.pool, cipher, prompt, responses: [verdict()] });
      const draftResult = await dispatch(spec, draft.runtime);
      expect(draftResult).toMatchObject({ status: "success", verification: "verified" });

      // Accept the unit output and advance its CAS head. This is the immutable checkpoint.
      const accepted = new ItotoriLlmAcceptedOutputRepository(ctx.pool, cipher);
      const candidate = unitOutput(draftResult.memoKey, "unit:alpha", 1, null);
      const head = await accepted.acceptAndAdvance(candidate);
      const outputBefore = await outputRow(ctx.pool, candidate.outputId);

      // The process died right after the CAS commit, before the workflow recorded
      // finalization. A SYS-1-safe bridge re-run consults the accepted head first and
      // carries NO transport responses — an already-final unit must not be re-drafted.
      const rerun = dispatchHarness({ pool: ctx.pool, cipher, prompt, responses: [] });
      const survivingHead = await accepted.readHead(headIdentity(candidate));
      expect(survivingHead).toEqual(head); // the accepted output SURVIVES the crash
      expect(rerun.transportCalls()).toBe(0); // the re-run does not re-dispatch a final unit

      // SYS-1 cannot recur: a recovery acting on a STALE view of the accepted head
      // cannot advance or replace it. The CAS content-hash guard rejects the write and
      // rolls it back, so the billed, accepted output can never be discarded/overwritten.
      const staleView: LlmAcceptedOutputHead = { ...head, contentHash: hash("stale-view-of-head") };
      const staleAdvance = unitOutput(draftResult.memoKey, "unit:alpha", 2, staleView, "stale");
      await expect(accepted.acceptAndAdvance(staleAdvance)).rejects.toBeInstanceOf(
        LlmAcceptedOutputCasError,
      );
      expect(await accepted.readHead(headIdentity(candidate))).toEqual(head); // head unchanged
      expect(await outputRow(ctx.pool, candidate.outputId)).toEqual(outputBefore); // byte-identical
      expect(await outputRow(ctx.pool, staleAdvance.outputId)).toBeNull(); // rolled back, never persisted
    } finally {
      await ctx.close();
    }
  });

  it("CONCURRENT RECOVERY: racing memo recoverers coalesce to one call with a monotonic event hash", async () => {
    const ctx = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const prompt = "Return a verdict.";
    const spec = physicalCallSpec(prompt);
    let announceStarted!: () => void;
    let releaseResponse!: () => void;
    const started = new Promise<void>((resolve) => (announceStarted = resolve));
    const released = new Promise<void>((resolve) => (releaseResponse = resolve));
    try {
      const harness = dispatchHarness({
        pool: ctx.pool,
        cipher,
        prompt,
        responses: [
          async () => {
            announceStarted();
            await released;
            return verdict();
          },
        ],
      });
      const first = dispatch(spec, harness.runtime);
      await started; // the first recoverer holds the advisory lock and is mid-flight
      const second = dispatch(spec, harness.runtime);
      releaseResponse();
      const [a, b] = await Promise.all([first, second]);

      expect(harness.transportCalls()).toBe(1); // the durable step is dispatched exactly once
      expect(a.memoKey).toBe(b.memoKey);
      // Monotonic event hash: both recoverers converge on the identical response event ID.
      expect(a.status === "success" && b.status === "success").toBe(true);
      if (a.status !== "success" || b.status !== "success") throw new Error("expected success");
      expect(a.responseEventId).toBe(b.responseEventId);
      expect([a.memoHit, b.memoHit].sort()).toEqual([false, true]);
      expect(await countRows(ctx.pool, "itotori_llm_call_memos")).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  it("CONCURRENT RECOVERY: racing accept advances converge on one monotonic head, never divergent", async () => {
    const ctx = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const prompt = "Return a verdict.";
    const spec = physicalCallSpec(prompt);
    try {
      const draft = dispatchHarness({ pool: ctx.pool, cipher, prompt, responses: [verdict()] });
      const draftResult = await dispatch(spec, draft.runtime);
      const accepted = new ItotoriLlmAcceptedOutputRepository(ctx.pool, cipher);
      const first = await accepted.acceptAndAdvance(
        unitOutput(draftResult.memoKey, "unit:a", 1, null),
      );

      // Two recoverers both see head v1 and race to advance to v2 with identical content.
      const racerA = unitOutput(draftResult.memoKey, "unit:a", 2, first, "A");
      const racerB = unitOutput(draftResult.memoKey, "unit:a", 2, first, "B");
      const settled = await Promise.allSettled([
        accepted.acceptAndAdvance(racerA),
        accepted.acceptAndAdvance(racerB),
      ]);
      const winners = settled.filter((r) => r.status === "fulfilled");
      const losers = settled.filter((r) => r.status === "rejected");
      expect(winners).toHaveLength(1); // exactly one advance wins; the other is serialized out
      expect(losers).toHaveLength(1);
      expect(losers[0]!.status === "rejected" && losers[0]!.reason instanceof Error).toBe(true);

      const finalHead = await accepted.readHead(headIdentity(racerA));
      // Monotonic: the head advanced v1 -> v2 exactly once and equals the accepted content hash.
      expect(finalHead?.version).toBe(2);
      expect(finalHead?.contentHash).toBe(deterministicOutputHash(2));
      // v1 preserved and auditable; the loser's write rolled back — no divergent third version.
      expect(await acceptedVersions(ctx.pool, "unit:a")).toEqual([1, 2]);
    } finally {
      await ctx.close();
    }
  });
});

// --- fault hooks + assertions (deterministic test infrastructure) ---

// Boundary (c): the remote response is fully produced (billable) but the process
// dies before the memo transaction commits. The decorator runs the real physical
// attempt (so the remote genuinely responds and bills), records that production,
// then reports the attempt as an ambiguous interruption instead of committing it.
// The store persists a non-permanent (re-dispatchable) attempt with no memo —
// exactly the crash-between-response-and-insert window, and the honest ambiguity
// that follows: we neither commit the response nor pretend it never happened.
function killAfterResponse(
  runtime: DispatchRuntime,
  ledger: { remoteResponsesProduced: number },
): DispatchRuntime {
  const inner = runtime.memo.store;
  const store: LlmCallMemoStore = {
    singleflight(input: LlmMemoSingleflightInput): Promise<LlmMemoSingleflightResult> {
      return inner.singleflight({
        ...input,
        execute: async (attempt) => {
          const execution = await input.execute(attempt);
          if (execution.kind !== "completed") return execution;
          ledger.remoteResponsesProduced += 1;
          return {
            kind: "incomplete",
            responseJson: null, // the uncommitted response is lost with the process
            attemptStatus: "cancelled",
            httpStatus: null,
            generationId: null,
            served: { status: "unknown" },
            routerAttempts: [],
            usage: null,
            billing: { status: "billing_unknown" },
            reportedCostUsd: null,
            failure: {
              classification: "cancelled",
              kind: "cancelled",
              httpStatus: null,
              retryAfterMs: null,
            },
            completedAt: new Date().toISOString(),
          };
        },
      });
    },
  };
  return { ...runtime, memo: { ...runtime.memo, store } };
}

const ACCEPT_SNAPSHOT_ID = STEP_HASH_D;

function unitOutput(
  memoKey: string,
  subjectId: string,
  version: number,
  expectedHead: LlmAcceptedOutputHead | null,
  variant = "",
): AcceptLlmOutputInput {
  const outputId = `${subjectId}:v${version}${variant ? `:${variant}` : ""}`;
  return {
    outputId,
    semanticKey: hash(`semantic:${outputId}`),
    schemaVersion: "itotori.accepted-output.v1",
    outputVersion: version,
    supersedesOutputId: expectedHead?.outputId ?? null,
    parentOutputIds: expectedHead ? [expectedHead.outputId] : [],
    memoKeys: [memoKey],
    snapshotKind: "localization",
    snapshotId: ACCEPT_SNAPSHOT_ID,
    subjectType: "unit",
    subjectId,
    // Identical content for every version so the accepted content hash is
    // deterministic and the concurrent race stays monotonic regardless of winner.
    stage: "final",
    sourceHash: hash(`source:${subjectId}`),
    outputJson: deterministicOutputJson(version),
    acceptedAt: `2026-01-01T00:0${version}:00.000Z`,
    expectedHead,
  };
}

function deterministicOutputJson(version: number): string {
  return JSON.stringify({ target: `accepted-target:v${version}` });
}

function deterministicOutputHash(version: number): `sha256:${string}` {
  return hash(deterministicOutputJson(version));
}

function headIdentity(candidate: AcceptLlmOutputInput) {
  return {
    snapshotId: candidate.snapshotId,
    subjectType: candidate.subjectType,
    subjectId: candidate.subjectId,
    stage: candidate.stage,
  };
}

async function countRows(pool: DatabaseContext["pool"], table: string): Promise<number> {
  if (!/^itotori_llm_[a-z_]+$/u.test(table)) throw new Error("unexpected table name");
  const result = await pool.query<{ count: string }>(
    `select count(*)::text as count from ${table}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function memoKeys(pool: DatabaseContext["pool"]): Promise<string[]> {
  const result = await pool.query<{ memo_key: string }>(
    "select memo_key from itotori_llm_call_memos order by completed_at",
  );
  return result.rows.map((row) => row.memo_key);
}

async function attemptStatuses(pool: DatabaseContext["pool"], memoKey: string): Promise<string[]> {
  const result = await pool.query<{ attempt_status: string }>(
    "select attempt_status from itotori_llm_http_attempts where memo_key = $1 order by attempt_ordinal",
    [memoKey],
  );
  return result.rows.map((row) => row.attempt_status);
}

async function outputRow(
  pool: DatabaseContext["pool"],
  outputId: string,
): Promise<{ version: number; contentHash: string; deletionState: string } | null> {
  const result = await pool.query<{
    output_version: number;
    output_content_hash: string;
    deletion_state: string;
  }>(
    "select output_version, output_content_hash, deletion_state from itotori_llm_accepted_outputs where output_id = $1",
    [outputId],
  );
  const row = result.rows[0];
  return row
    ? {
        version: row.output_version,
        contentHash: row.output_content_hash,
        deletionState: row.deletion_state,
      }
    : null;
}

async function acceptedVersions(
  pool: DatabaseContext["pool"],
  subjectId: string,
): Promise<number[]> {
  const result = await pool.query<{ output_version: number }>(
    "select output_version from itotori_llm_accepted_outputs where subject_id = $1 order by output_version",
    [subjectId],
  );
  return result.rows.map((row) => row.output_version);
}

function hash(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
