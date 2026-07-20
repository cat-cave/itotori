import { describe, expect, it } from "vitest";
import { QualifyingArtifactAttemptTelemetrySchema } from "../src/contracts/index.js";
import {
  InMemoryQualifyingAttemptTelemetryStore,
  persistQualifyingArtifactLineage,
  persistQualifyingWorkflowLineage,
  projectQualifyingArtifactAttempt,
  reportPersistedQualifyingTelemetry,
  type QualifyingArtifactAttemptInput,
} from "../src/telemetry/qualifying-lineage.js";
import { FULL_ROSTER, resolveRunPolicy } from "../src/run-policy/index.js";

const QUALIFYING_POLICY = resolveRunPolicy({
  runMode: "production",
  contextScope: "whole-game",
  outputScope: "all",
  roster: FULL_ROSTER,
});

const STAGE_ROLES = [
  ["source-wiki", "A1"],
  ["localized-bible", "A2"],
  ["draft", "P1"],
  ["review", "Q1"],
  ["correction", "P2"],
  ["retry", "P1"],
  ["repair", "P3"],
  ["build-lqa", "Q5"],
  ["feedback-enhancement", "A4"],
] as const;

function hash(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}

function attempt(
  index: number,
  stage: (typeof STAGE_ROLES)[number][0] = "draft",
  role: (typeof STAGE_ROLES)[number][1] = "P1",
  unknownCost = false,
): QualifyingArtifactAttemptInput {
  return {
    qualifyingArtifactId: `artifact:${index}`,
    workflowAttempt: {
      memoKey: hash(index),
      ordinal: stage === "retry" ? 2 : 1,
      outcome: stage === "retry" ? "transient-retry" : "completed",
    },
    metrics: {
      requested: { model: "requested-model", provider: "requested-provider" },
      served: { model: "served-model", provider: "served-provider" },
      generationId: `generation:${index}`,
      memoHit: false,
      stage,
      role,
      latencyMs: index,
      tokens: { input: index, output: index, cacheRead: 0, cacheWrite: 0 },
      cost: unknownCost ? { state: "unknown" } : { state: "confirmed", amountUsd: "0" },
      quarantine: false,
      correction: stage === "correction",
    },
  };
}

function fieldNames(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    key,
    ...fieldNames(child),
  ]);
}

describe("qualifying artifact-lineage telemetry", () => {
  it("persists one qualifying-artifact row for every physical workflow attempt", async () => {
    const store = new InMemoryQualifyingAttemptTelemetryStore();
    const entries = [attempt(1), attempt(2, "retry", "P1")];

    await persistQualifyingWorkflowLineage(
      store,
      QUALIFYING_POLICY,
      entries.map((entry) => entry.workflowAttempt),
      entries.map((entry) => ({
        qualifyingArtifactId: entry.qualifyingArtifactId,
        memoKey: entry.workflowAttempt.memoKey,
        attemptOrdinal: entry.workflowAttempt.ordinal,
        metrics: entry.metrics,
      })),
    );
    const dashboard = await reportPersistedQualifyingTelemetry(store);

    expect(dashboard.attempts).toHaveLength(entries.length);
    expect(dashboard.attempts.map((row) => row.qualifyingArtifactId)).toEqual([
      "artifact:1",
      "artifact:2",
    ]);
    expect(dashboard.attempts.map((row) => [row.memoKey, row.attemptOrdinal])).toEqual([
      [hash(1), 1],
      [hash(2), 2],
    ]);
    expect(() =>
      projectQualifyingArtifactAttempt(QUALIFYING_POLICY, {
        ...attempt(3),
        qualifyingArtifactId: "",
      }),
    ).toThrow();
    expect(() =>
      projectQualifyingArtifactAttempt(
        resolveRunPolicy({
          runMode: "test-dev",
          contextScope: "whole-game",
          outputScope: "all",
          roster: FULL_ROSTER,
          ablation: { kind: "pure-mtl" },
        }),
        attempt(4),
      ),
    ).toThrow(/ablation/u);
  });

  it("rejects an RB-064 attempt lineage when a physical attempt lacks telemetry", async () => {
    const store = new InMemoryQualifyingAttemptTelemetryStore();
    const entries = [attempt(5), attempt(6, "review", "Q1")];

    await expect(
      persistQualifyingWorkflowLineage(
        store,
        QUALIFYING_POLICY,
        entries.map((entry) => entry.workflowAttempt),
        [
          {
            qualifyingArtifactId: entries[0]!.qualifyingArtifactId,
            memoKey: entries[0]!.workflowAttempt.memoKey,
            attemptOrdinal: entries[0]!.workflowAttempt.ordinal,
            metrics: entries[0]!.metrics,
          },
        ],
      ),
    ).rejects.toThrow(/missing telemetry/u);
    expect(await store.list()).toEqual([]);
  });

  it("persists a row with no prompt, source, or target text", async () => {
    const input = {
      ...attempt(4, "source-wiki", "A1"),
      // These untyped fields model an accidental caller payload. Projection
      // selects its explicit content-free inputs, so none becomes persisted.
      prompt: "must not persist",
      source: "must not persist",
      target: "must not persist",
    } as QualifyingArtifactAttemptInput;
    const store = new InMemoryQualifyingAttemptTelemetryStore();
    await persistQualifyingArtifactLineage(store, QUALIFYING_POLICY, [input]);
    const [row] = await store.list();
    if (row === undefined) throw new Error("expected one persisted telemetry row");

    expect(Object.keys(row).sort()).toEqual(
      [
        "qualifyingArtifactId",
        "memoKey",
        "attemptOrdinal",
        "requested",
        "served",
        "generationId",
        "memoHit",
        "stage",
        "role",
        "latencyMs",
        "tokens",
        "cost",
        "quarantine",
        "correction",
        "retry",
      ].sort(),
    );
    const persistedFieldNames = fieldNames(row);
    expect(persistedFieldNames).not.toContain("prompt");
    expect(persistedFieldNames).not.toContain("source");
    expect(persistedFieldNames).not.toContain("target");
    expect(
      QualifyingArtifactAttemptTelemetrySchema.safeParse({ ...row, prompt: "no" }).success,
    ).toBe(false);
    expect(
      QualifyingArtifactAttemptTelemetrySchema.safeParse({ ...row, source: "no" }).success,
    ).toBe(false);
    expect(
      QualifyingArtifactAttemptTelemetrySchema.safeParse({ ...row, target: "no" }).success,
    ).toBe(false);
  });

  it("counts source, bible, P/Q, correction, retry, repair, build, and feedback attempts in totals", async () => {
    const store = new InMemoryQualifyingAttemptTelemetryStore();
    await persistQualifyingArtifactLineage(
      store,
      QUALIFYING_POLICY,
      STAGE_ROLES.map(([stage, role], index) => attempt(index + 10, stage, role)),
    );

    const dashboard = await reportPersistedQualifyingTelemetry(store);

    expect(dashboard.totals.physicalAttemptCount).toBe(STAGE_ROLES.length);
    for (const [stage] of STAGE_ROLES) {
      expect(dashboard.totals.byStage[stage]).toBe(1);
    }
    expect(dashboard.totals.correctionCount).toBe(1);
    expect(dashboard.totals.retryCount).toBe(1);
    expect(dashboard.totals.latencyMs).toBe(126);
    expect(dashboard.totals.tokens).toEqual({
      input: 126,
      output: 126,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("surfaces an unknown-cost total instead of silently treating it as zero", async () => {
    const store = new InMemoryQualifyingAttemptTelemetryStore();
    await persistQualifyingArtifactLineage(store, QUALIFYING_POLICY, [
      attempt(30),
      attempt(31, "review", "Q1", true),
    ]);

    const dashboard = await reportPersistedQualifyingTelemetry(store);

    expect(dashboard.totals.cost).toEqual({
      state: "unknown",
      confirmedAmountUsd: "0",
      unknownAttemptCount: 1,
    });
    expect(dashboard.totals.cost).not.toEqual({ state: "confirmed", amountUsd: "0" });
    expect(Object.hasOwn(dashboard.totals.cost, "amountUsd")).toBe(false);
  });
});
