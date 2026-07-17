// Offline-provable core: strict scorecard from content-free qualifying lineage
// + zero-call deterministic replay from persisted accepted-output CAS + memo.
//
// LIVE-ONLY (flagged): the scorecard over a REAL terminal run (live provider
// receipts) is a downstream live-lane input. This suite proves the generator
// and replay LOGIC on fixtures only — no fabricated live run data.

import { describe, expect, it } from "vitest";
import {
  LIVE_TERMINAL_RUN_SCORECARD_FOLLOW_UP,
  STRICT_SCORECARD_SCHEMA_VERSION,
  ZERO_CALL_REPLAY_SCHEMA_VERSION,
  InMemoryZeroCallReplayStore,
  buildStrictScorecardFromLineage,
  buildStrictScorecardFromPersistedLineage,
  hashOutputJson,
  replayZeroCallFromPersisted,
  type StrictScorecard,
} from "../../src/scorecard/index.js";
import {
  InMemoryQualifyingAttemptTelemetryStore,
  persistQualifyingArtifactLineage,
  type QualifyingArtifactAttemptInput,
} from "../../src/telemetry/qualifying-lineage.js";
import { FULL_ROSTER, resolveRunPolicy } from "../../src/run-policy/index.js";
import type { QualifyingArtifactAttemptTelemetry } from "../../src/contracts/index.js";

const QUALIFYING_POLICY = resolveRunPolicy({
  runMode: "production",
  contextScope: "whole-game",
  outputScope: "all",
  roster: FULL_ROSTER,
});

function memoHash(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}

/** Fixed multi-stage fixture lineage with known projected totals. */
function knownLineageAttempts(): QualifyingArtifactAttemptTelemetry[] {
  return [
    {
      qualifyingArtifactId: "artifact:draft-1",
      memoKey: memoHash(1),
      attemptOrdinal: 1,
      requested: { model: "fixture-model", provider: "fixture-provider" },
      served: { model: "fixture-model", provider: "fixture-provider" },
      generationId: "generation:1",
      memoHit: false,
      stage: "draft",
      role: "P1",
      latencyMs: 100,
      tokens: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 },
      cost: { state: "confirmed", amountUsd: "0.001" }, // itotori-225-audit-allow: synthetic scorecard fixture cost
      quarantine: false,
      correction: false,
      retry: false,
    },
    {
      qualifyingArtifactId: "artifact:review-1",
      memoKey: memoHash(2),
      attemptOrdinal: 1,
      requested: { model: "fixture-model", provider: "fixture-provider" },
      served: { model: "fixture-model", provider: "fixture-provider" },
      generationId: "generation:2",
      memoHit: true,
      stage: "review",
      role: "Q1",
      latencyMs: 50,
      tokens: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0 },
      cost: { state: "confirmed", amountUsd: "0.002" }, // itotori-225-audit-allow: synthetic scorecard fixture cost
      quarantine: false,
      correction: false,
      retry: false,
    },
    {
      qualifyingArtifactId: "artifact:draft-2",
      memoKey: memoHash(3),
      attemptOrdinal: 2,
      requested: { model: "fixture-model", provider: "fixture-provider" },
      served: { model: "fixture-model", provider: "fixture-provider" },
      generationId: "generation:3",
      memoHit: false,
      stage: "draft",
      role: "P1",
      latencyMs: 25,
      tokens: { input: 3, output: 4, cacheRead: 0, cacheWrite: 1 },
      cost: { state: "confirmed", amountUsd: "0.0005" }, // itotori-225-audit-allow: synthetic scorecard fixture cost
      quarantine: false,
      correction: false,
      retry: true,
    },
  ];
}

/** Expected strict scorecard for {@link knownLineageAttempts} (pinned totals). */
const KNOWN_SCORECARD: StrictScorecard = {
  schemaVersion: STRICT_SCORECARD_SCHEMA_VERSION,
  lineage: "qualifying",
  totals: {
    attempts: 3,
    memoHitCount: 1,
    latencyMs: 175,
    tokens: { input: 18, output: 31, cacheRead: 1, cacheWrite: 3 },
    cost: { state: "confirmed", amountUsd: "0.0035" }, // itotori-225-audit-allow: pinned known scorecard total
  },
  byStageRole: [
    {
      stage: "draft",
      role: "P1",
      attempts: 2,
      memoHitCount: 0,
      latencyMs: 125,
      tokens: { input: 13, output: 24, cacheRead: 1, cacheWrite: 3 },
      cost: { state: "confirmed", amountUsd: "0.0015" }, // itotori-225-audit-allow: pinned known scorecard total
    },
    {
      stage: "review",
      role: "Q1",
      attempts: 1,
      memoHitCount: 1,
      latencyMs: 50,
      tokens: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0 },
      cost: { state: "confirmed", amountUsd: "0.002" }, // itotori-225-audit-allow: pinned known scorecard total
    },
  ],
  liveTerminalRunScorecard: LIVE_TERMINAL_RUN_SCORECARD_FOLLOW_UP,
};

function attemptInput(
  index: number,
  overrides: Partial<{
    stage: QualifyingArtifactAttemptInput["metrics"]["stage"];
    role: QualifyingArtifactAttemptInput["metrics"]["role"];
    unknownCost: boolean;
    amountUsd: string;
    latencyMs: number | null;
    memoHit: boolean;
  }> = {},
): QualifyingArtifactAttemptInput {
  const unknownCost = overrides.unknownCost === true;
  return {
    qualifyingArtifactId: `artifact:${index}`,
    workflowAttempt: {
      memoKey: memoHash(index),
      ordinal: 1,
      outcome: "completed",
    },
    metrics: {
      requested: { model: "fixture-model", provider: "fixture-provider" },
      served: { model: "fixture-model", provider: "fixture-provider" },
      generationId: `generation:${index}`,
      memoHit: overrides.memoHit ?? false,
      stage: overrides.stage ?? "draft",
      role: overrides.role ?? "P1",
      latencyMs: overrides.latencyMs === undefined ? index : overrides.latencyMs,
      tokens: { input: index, output: index, cacheRead: 0, cacheWrite: 0 },
      cost: unknownCost
        ? { state: "unknown" }
        : {
            state: "confirmed",
            amountUsd: overrides.amountUsd ?? "0", // itotori-225-audit-allow: synthetic scorecard fixture cost
          },
      quarantine: false,
      correction: false,
    },
  };
}

describe("strict scorecard from qualifying lineage", () => {
  it("projects a fixture lineage to the pinned known scorecard totals", () => {
    const scorecard = buildStrictScorecardFromLineage({
      lineage: "qualifying",
      attempts: knownLineageAttempts(),
    });
    expect(scorecard).toEqual(KNOWN_SCORECARD);
  });

  it("is deterministic across array-only and ledger object inputs", () => {
    const attempts = knownLineageAttempts();
    const fromArray = buildStrictScorecardFromLineage(attempts);
    const fromLedger = buildStrictScorecardFromLineage({ lineage: "qualifying", attempts });
    expect(fromArray).toEqual(fromLedger);
    expect(fromArray).toEqual(KNOWN_SCORECARD);
  });

  it("builds the same scorecard from a persisted qualifying-lineage store", async () => {
    const store = new InMemoryQualifyingAttemptTelemetryStore();
    await persistQualifyingArtifactLineage(store, QUALIFYING_POLICY, [
      attemptInput(10, {
        stage: "draft",
        role: "P1",
        amountUsd: "0.001", // itotori-225-audit-allow: synthetic scorecard fixture cost
        latencyMs: 100,
      }),
      attemptInput(11, {
        stage: "review",
        role: "Q1",
        amountUsd: "0.002", // itotori-225-audit-allow: synthetic scorecard fixture cost
        latencyMs: 50,
        memoHit: true,
      }),
    ]);

    const scorecard = await buildStrictScorecardFromPersistedLineage(store);
    expect(scorecard.lineage).toBe("qualifying");
    expect(scorecard.schemaVersion).toBe(STRICT_SCORECARD_SCHEMA_VERSION);
    expect(scorecard.liveTerminalRunScorecard).toBe(LIVE_TERMINAL_RUN_SCORECARD_FOLLOW_UP);
    expect(scorecard.totals).toEqual({
      attempts: 2,
      memoHitCount: 1,
      latencyMs: 150,
      tokens: { input: 21, output: 21, cacheRead: 0, cacheWrite: 0 },
      cost: { state: "confirmed", amountUsd: "0.003" }, // itotori-225-audit-allow: pinned known scorecard total
    });
    expect(scorecard.byStageRole.map((b) => `${b.stage}:${b.role}`)).toEqual([
      "draft:P1",
      "review:Q1",
    ]);
  });

  it("surfaces unknown-cost attempts as unknown totals, never silent zero", async () => {
    const store = new InMemoryQualifyingAttemptTelemetryStore();
    await persistQualifyingArtifactLineage(store, QUALIFYING_POLICY, [
      attemptInput(20, {
        amountUsd: "0.004", // itotori-225-audit-allow: synthetic scorecard fixture cost
      }),
      attemptInput(21, { stage: "review", role: "Q1", unknownCost: true }),
    ]);

    const scorecard = await buildStrictScorecardFromPersistedLineage(store);

    // Overall: confirmed subtotal retained, state flipped to unknown.
    expect(scorecard.totals.cost).toEqual({
      state: "unknown",
      confirmedAmountUsd: "0.004", // itotori-225-audit-allow: confirmed subtotal under unknown total
      unknownAttemptCount: 1,
    });
    // Never a silent confirmed zero for the unknown attempt.
    expect(scorecard.totals.cost).not.toEqual({ state: "confirmed", amountUsd: "0" });
    expect(Object.hasOwn(scorecard.totals.cost, "amountUsd")).toBe(false);
    if (scorecard.totals.cost.state !== "unknown") {
      throw new Error("expected unknown cost total");
    }
    // Confirmed subtotal is the known attempt only — unknown never contributes 0.
    expect(scorecard.totals.cost.confirmedAmountUsd).toBe("0.004"); // itotori-225-audit-allow: expected confirmed subtotal
    expect(scorecard.totals.cost.unknownAttemptCount).toBe(1);

    const reviewBucket = scorecard.byStageRole.find((b) => b.stage === "review" && b.role === "Q1");
    expect(reviewBucket?.cost).toEqual({
      state: "unknown",
      confirmedAmountUsd: "0",
      unknownAttemptCount: 1,
    });
    expect(reviewBucket?.cost).not.toEqual({ state: "confirmed", amountUsd: "0" });
  });

  it("nulls latency/token aggregates when any contributing attempt lacks a value", () => {
    const scorecard = buildStrictScorecardFromLineage([
      {
        ...knownLineageAttempts()[0]!,
        latencyMs: null,
        tokens: { input: null, output: 1, cacheRead: null, cacheWrite: 0 },
      },
      {
        ...knownLineageAttempts()[1]!,
        latencyMs: 10,
        tokens: { input: 2, output: 3, cacheRead: 1, cacheWrite: 0 },
      },
    ]);
    expect(scorecard.totals.latencyMs).toBeNull();
    expect(scorecard.totals.tokens).toEqual({
      input: null,
      output: 4,
      cacheRead: null,
      cacheWrite: 0,
    });
  });

  it("flags the real terminal-run scorecard as a live-lane follow-up", () => {
    const scorecard = buildStrictScorecardFromLineage([]);
    expect(scorecard.liveTerminalRunScorecard).toBe("downstream-live-lane");
    expect(scorecard.liveTerminalRunScorecard).toBe(LIVE_TERMINAL_RUN_SCORECARD_FOLLOW_UP);
  });
});

describe("zero-call deterministic replay from persisted CAS + memo", () => {
  it("replays with zero wire requests and hash-matches persisted CAS heads", async () => {
    const store = new InMemoryZeroCallReplayStore();
    const bodyA = JSON.stringify({ unit: "u1", target: "accepted-a" });
    const bodyB = JSON.stringify({ unit: "u2", target: "accepted-b" });
    const hashA = hashOutputJson(bodyA);
    const hashB = hashOutputJson(bodyB);
    const memoA = memoHash(100);
    const memoB = memoHash(101);

    store.putMemo({
      memoKey: memoA,
      verificationStatus: "verified",
      generationId: "generation:a",
    });
    store.putMemo({
      memoKey: memoB,
      verificationStatus: "verified",
      generationId: "generation:b",
    });
    store.putHead({
      outputId: "output:u2",
      version: 1,
      contentHash: hashB,
      memoKeys: [memoB],
      outputJson: bodyB,
    });
    store.putHead({
      outputId: "output:u1",
      version: 1,
      contentHash: hashA,
      memoKeys: [memoA],
      outputJson: bodyA,
    });

    const result = await replayZeroCallFromPersisted(store);

    expect(result.schemaVersion).toBe(ZERO_CALL_REPLAY_SCHEMA_VERSION);
    expect(result.wireRequestCount).toBe(0);
    expect(result.newPhysicalAttempts).toBe(0);
    expect(result.allHashMatched).toBe(true);
    expect(result.allMemosResolved).toBe(true);
    expect(result.liveTerminalRunScorecard).toBe(LIVE_TERMINAL_RUN_SCORECARD_FOLLOW_UP);
    // Stable sort by outputId then version.
    expect(result.outputs.map((o) => o.outputId)).toEqual(["output:u1", "output:u2"]);
    expect(result.outputs).toEqual([
      {
        outputId: "output:u1",
        version: 1,
        contentHash: hashA,
        matchesCasHead: true,
        memoKeysResolved: true,
        memoHitCount: 1,
      },
      {
        outputId: "output:u2",
        version: 1,
        contentHash: hashB,
        matchesCasHead: true,
        memoKeysResolved: true,
        memoHitCount: 1,
      },
    ]);
    // Replayed content hashes equal the CAS heads exactly.
    expect(result.outputs.every((o) => o.matchesCasHead)).toBe(true);
    expect(result.acceptedOutputsHash).toBe(
      hashOutputJson(
        JSON.stringify([
          { id: "output:u1", hash: hashA },
          { id: "output:u2", hash: hashB },
        ]),
      ),
    );
  });

  it("reports unresolved memos without ever dispatching (wire still 0)", async () => {
    const store = new InMemoryZeroCallReplayStore();
    const body = JSON.stringify({ unit: "u-missing-memo" });
    const contentHash = hashOutputJson(body);
    const presentMemo = memoHash(200);
    const missingMemo = memoHash(201);

    store.putMemo({
      memoKey: presentMemo,
      verificationStatus: "verified",
      generationId: "generation:present",
    });
    // Head references a memo that is not in the store — still zero-call.
    store.putHead({
      outputId: "output:missing",
      version: 1,
      contentHash,
      memoKeys: [presentMemo, missingMemo],
      outputJson: body,
    });

    const result = await replayZeroCallFromPersisted(store);
    expect(result.wireRequestCount).toBe(0);
    expect(result.newPhysicalAttempts).toBe(0);
    expect(result.allHashMatched).toBe(true);
    expect(result.allMemosResolved).toBe(false);
    expect(result.outputs[0]).toMatchObject({
      matchesCasHead: true,
      memoKeysResolved: false,
      memoHitCount: 1,
    });
  });

  it("structurally cannot accept a dispatch client (store is read-only CAS+memo)", () => {
    const store = new InMemoryZeroCallReplayStore();
    // The ZeroCallReplayStore port exposes only listAcceptedHeads + getMemo.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(store)).sort()).toEqual(
      expect.arrayContaining(["listAcceptedHeads", "getMemo", "putHead", "putMemo"]),
    );
    expect("dispatch" in store).toBe(false);
    expect("complete" in store).toBe(false);
    expect("invoke" in store).toBe(false);
  });
});
