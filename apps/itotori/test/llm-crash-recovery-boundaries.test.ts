import {
  ItotoriLlmAcceptedOutputRepository,
  LlmAcceptedOutputCasError,
  LlmDurabilityFaultError,
  type LlmAcceptedOutputHead,
} from "@itotori/db";
import { expect, it } from "vitest";
import { isolatedMigratedContext } from "../../../packages/itotori-db/test/db-test-context.js";
import { dispatch } from "../src/llm/dispatch.js";

import {
  TestMemoCipher,
  decodedUnitsTool,
  dispatchHarness,
  physicalCallSpec,
  toolLoopSpec,
  toolProviderResponse,
} from "./llm-step-test-support.js";

import {
  postgresDescribe,
  verdict,
  crashAt,
  recoverAcceptedUnit,
  unitOutput,
  deterministicOutputHash,
  headIdentity,
  countRows,
  memoKeys,
  attemptStatuses,
  attemptAmbiguity,
  outputRow,
  outputPayload,
  acceptedVersions,
  hash,
} from "./llm-crash-recovery-boundaries.support.js";

postgresDescribe("substrate crash recovery at every physical call boundary", () => {
  it("BOUNDARY (a) before dispatch: nothing is lost and only the missing step re-runs", async () => {
    const ctx = await isolatedMigratedContext();
    const cipher = new TestMemoCipher();
    const prompt = "Return a verdict.";
    const spec = physicalCallSpec(prompt);
    try {
      const interrupted = dispatchHarness({
        pool: ctx.pool,
        cipher,
        prompt,
        responses: [verdict()],
        durabilityFaults: crashAt("before-dispatch"),
      });
      const interruptedResult = await dispatch(spec, interrupted.runtime);
      expect(interruptedResult).toMatchObject({ status: "failure", failureKind: "cancelled" });
      // Killed after attempt admission but before the physical step reached the
      // transport: no response or memo is durable.
      expect(interrupted.transportCalls()).toBe(0);
      expect(await countRows(ctx.pool, "itotori_llm_call_memos")).toBe(0);
      expect(await attemptStatuses(ctx.pool, interruptedResult.memoKey)).toEqual(["cancelled"]);

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
      const interrupted = dispatchHarness({
        pool: ctx.pool,
        cipher,
        prompt,
        // The request has started when the hook terminates its caller, so whether
        // the remote billed us remains explicitly unknown.
        responses: [verdict()],
        durabilityFaults: crashAt("in-flight"),
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
      const interrupted = dispatchHarness({
        pool: ctx.pool,
        cipher,
        prompt,
        responses: [
          () => {
            ledger.remoteResponsesProduced += 1;
            return Promise.resolve(verdict());
          },
        ],
        durabilityFaults: crashAt("after-remote-response"),
      });
      const interruptedResult = await dispatch(spec, interrupted.runtime);
      expect(interruptedResult).toMatchObject({ status: "failure", failureKind: "cancelled" });
      expect(interrupted.transportCalls()).toBe(1); // the remote WAS contacted...
      expect(ledger.remoteResponsesProduced).toBe(1); // ...and produced a billable response...
      expect(await countRows(ctx.pool, "itotori_llm_call_memos")).toBe(0); // ...never committed.
      // Honest ambiguity: the attempt is recorded as an ambiguous interruption — NOT
      // silently assumed to have succeeded (no memo) and NOT erased (the row remains).
      expect(await attemptStatuses(ctx.pool, interruptedResult.memoKey)).toEqual(["cancelled"]);
      expect(await attemptAmbiguity(ctx.pool, interruptedResult.memoKey)).toEqual([
        {
          status: "cancelled",
          failureClass: "cancelled",
          billing: "billing_unknown",
          hasResponse: true,
        },
      ]);

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
      const first = dispatchHarness({
        pool: ctx.pool,
        cipher,
        prompt,
        responses: [verdict()],
        durabilityFaults: crashAt("after-memo-insert"),
      });
      const firstResult = await dispatch(spec, first.runtime);
      expect(firstResult).toMatchObject({ status: "failure", failureKind: "cancelled" });
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
    const prompt = "Use the decoded-unit tool, then return a verdict.";
    const spec = toolLoopSpec(prompt);
    try {
      let interruptedToolRuns = 0;
      const interrupted = dispatchHarness({
        pool: ctx.pool,
        cipher,
        prompt,
        // The tool-call model step commits, the tool produces its real local
        // result, and the exact post-result hook kills the caller before a
        // terminal model step can be dispatched.
        responses: [toolProviderResponse(1)],
        tools: [decodedUnitsTool(() => (interruptedToolRuns += 1))],
        durabilityFaults: crashAt("after-tool-result"),
      });
      const interruptedResult = await dispatch(spec, interrupted.runtime);
      expect(interruptedResult).toMatchObject({ status: "failure", failureKind: "cancelled" });
      expect(interrupted.transportCalls()).toBe(1); // terminal step was never dispatched
      expect(interruptedToolRuns).toBe(1);
      const before = await memoKeys(ctx.pool);
      expect(before).toHaveLength(1); // the tool-call model step is durable

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
      expect(restartToolRuns).toBe(1); // tool result is re-derived locally, not from a re-called model
      const after = await memoKeys(ctx.pool);
      expect(before.every((key) => after.includes(key))).toBe(true); // tool-step memos neither lost nor re-dispatched
      expect(after).toHaveLength(2);
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
      // Draft the unit and durably memoize its explicit-unknown response.
      const draft = dispatchHarness({ pool: ctx.pool, cipher, prompt, responses: [verdict()] });
      const draftResult = await dispatch(spec, draft.runtime);
      expect(draftResult).toMatchObject({ status: "success", verification: "explicit-unknown" });

      // Accept the unit output and advance its CAS head. This is the immutable checkpoint.
      const candidate = unitOutput(draftResult.memoKey, "unit:alpha", 1, null);
      const killed = new ItotoriLlmAcceptedOutputRepository(
        ctx.pool,
        cipher,
        crashAt("after-accepted-output-cas"),
      );
      await expect(killed.acceptAndAdvance(candidate)).rejects.toBeInstanceOf(
        LlmDurabilityFaultError,
      );
      const accepted = new ItotoriLlmAcceptedOutputRepository(ctx.pool, cipher);
      const head = await accepted.readHead(headIdentity(candidate));
      expect(head).not.toBeNull();
      if (!head) throw new Error("accepted head was lost after committed CAS");
      const outputBefore = await outputRow(ctx.pool, candidate.outputId);
      expect(await outputPayload(ctx.pool, cipher, candidate.outputId)).toBe(candidate.outputJson);

      // The process died right after the CAS commit, before the workflow recorded
      // finalization. A SYS-1-safe bridge re-run consults the accepted head first and
      // carries NO transport responses — an already-final unit must not be re-drafted.
      const rerun = dispatchHarness({ pool: ctx.pool, cipher, prompt, responses: [] });
      const survivingHead = await recoverAcceptedUnit(accepted, candidate, spec, rerun.runtime);
      expect(survivingHead).toEqual(head); // the accepted output SURVIVES the crash
      expect(rerun.transportCalls()).toBe(0); // the re-run does not re-dispatch a final unit

      // SYS-1 cannot recur: a recovery acting on a STALE view of the accepted head
      // cannot advance or replace it. The CAS content-hash guard rejects the write and
      // rolls it back, so the billed, accepted output can never be discarded/overwritten.
      const staleView: LlmAcceptedOutputHead = {
        ...head,
        contentHash: hash("stale-view-of-head"),
      };
      const staleAdvance = unitOutput(draftResult.memoKey, "unit:alpha", 2, staleView, "stale");
      await expect(accepted.acceptAndAdvance(staleAdvance)).rejects.toBeInstanceOf(
        LlmAcceptedOutputCasError,
      );
      expect(await accepted.readHead(headIdentity(candidate))).toEqual(head); // head unchanged
      expect(await outputRow(ctx.pool, candidate.outputId)).toEqual(outputBefore); // byte-identical
      expect(await outputPayload(ctx.pool, cipher, candidate.outputId)).toBe(candidate.outputJson);
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
