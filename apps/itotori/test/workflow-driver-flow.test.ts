import { describe, expect, it } from "vitest";

import type { Draft, ReviewVerdict } from "../src/contracts/index.js";
import { runLocalizationWorkflow } from "../src/workflow/index.js";
import type {
  AttemptContext,
  AttemptLineageEntry,
  DraftedScene,
  MemoStepResult,
  UnitArtifactRef,
  UnitStage,
  WorkflowPorts,
  WorkflowScene,
} from "../src/workflow/index.js";
import { FULL_ROSTER, type RunPolicyRequest } from "../src/run-policy/index.js";
import {
  InMemoryQualifyingAttemptTelemetryStore,
  persistQualifyingWorkflowRunLineage,
  type QualifyingWorkflowAttemptObservation,
} from "../src/telemetry/qualifying-lineage.js";

const HASH = `sha256:${"a".repeat(64)}` as const;
const SOURCE_HASH = `sha256:${"b".repeat(64)}` as const;
const REQUEST: RunPolicyRequest = {
  runMode: "production",
  contextScope: "whole-game",
  outputScope: "dialogue-only",
  roster: FULL_ROSTER,
};

function flowScene(unitIds: readonly string[]): WorkflowScene {
  return {
    sceneId: "scene.flow",
    units: unitIds.map((unitId) => ({
      unitId,
      sourceHash: SOURCE_HASH,
      speakerId: "speaker.flow",
      routeId: "route.flow",
      firstAppearance: true,
    })),
  };
}

function draft(unitId: string): Draft {
  return {
    unitId,
    sourceHash: SOURCE_HASH,
    targetSkeleton: `target:${unitId}`,
    evidenceIds: ["evidence.flow"],
    basis: { kind: "wiki-first", bibleRenderingIds: ["bible.flow"] },
    uncertainty: ["none"],
  };
}

function draftedScene(scene: WorkflowScene): DraftedScene {
  const drafts = scene.units.map((unit) => draft(unit.unitId));
  return {
    sceneId: scene.sceneId,
    mode: "whole-scene",
    batches: [
      {
        schemaVersion: "itotori.draft-batch.v1",
        localizationSnapshotId: HASH,
        batchId: "batch.flow",
        scope: {
          kind: "whole-scene",
          sceneId: scene.sceneId,
          expectedUnitIds: drafts.map((item) => item.unitId),
        },
        drafts,
      },
    ],
    units: drafts.map((item) => ({
      unitId: item.unitId,
      draft: item,
      bibleRenderingIds: ["bible.flow"],
    })),
  };
}

function pass(lane: "Q1" | "Q2" | "Q3" | "Q4" | "Q5", unitId: string): ReviewVerdict {
  const rubric = {
    Q1: "meaning",
    Q2: "voice",
    Q3: "terminology",
    Q4: "continuity",
    Q5: "build-lqa",
  }[lane] as ReviewVerdict["rubric"];
  return {
    schemaVersion: "itotori.review-verdict.v1",
    reviewId: `review:${lane}:${unitId}`,
    localizationSnapshotId: HASH,
    roleId: lane,
    rubric,
    unitId,
    basis: { kind: "wiki-first", bibleRenderingIds: ["bible.flow"] },
    verdict: "PASS",
    severity: "none",
    span: null,
    category: null,
    evidenceIds: ["evidence.flow"],
    repairConstraint: null,
  } as ReviewVerdict;
}

function fail(lane: "Q1" | "Q2", unitId: string, severity: "minor" | "major"): ReviewVerdict {
  const rubric = lane === "Q1" ? "meaning" : "voice";
  return {
    ...pass(lane, unitId),
    rubric,
    verdict: "FAIL",
    severity,
    span: { spanId: `span:${lane}`, surface: "target", text: "incorrect" },
    category: lane === "Q1" ? "mistranslation" : "register",
    repairConstraint: "repair the cited defect",
  } as ReviewVerdict;
}

function cannotAssess(lane: "Q3" | "Q4", unitId: string): ReviewVerdict {
  return {
    ...pass(lane, unitId),
    verdict: "CANNOT_ASSESS",
    severity: "none",
    span: null,
    category: "insufficient-evidence",
    evidenceIds: [],
    repairConstraint: null,
    requestedEvidence: ["provide the missing context"],
  } as ReviewVerdict;
}

class TraceStore {
  readonly heads = new Map<string, UnitArtifactRef>();
  readonly memo = new Map<string, unknown>();
  readonly lineage: AttemptLineageEntry[] = [];

  constructor(private readonly events: string[]) {}

  seedFinal(unitId: string): void {
    this.heads.set(`${unitId}:final`, {
      unitId,
      stage: "final",
      contentHash: SOURCE_HASH,
      version: 1,
    });
  }

  async readUnitHead(unitId: string, stage: UnitStage): Promise<UnitArtifactRef | null> {
    return this.heads.get(`${unitId}:${stage}`) ?? null;
  }

  async finalizeUnit(input: {
    unitId: string;
    stage: UnitStage;
    contentHash: `sha256:${string}`;
    shippable: boolean;
  }): Promise<UnitArtifactRef> {
    this.events.push(`finalize:${input.stage}:${input.unitId}`);
    const key = `${input.unitId}:${input.stage}`;
    const previous = this.heads.get(key);
    const ref: UnitArtifactRef = {
      unitId: input.unitId,
      stage: input.stage,
      contentHash: input.contentHash,
      version: (previous?.version ?? 0) + 1,
    };
    this.heads.set(key, ref);
    return ref;
  }

  async runMemoizedStep<T>(
    memoKey: string,
    produce: (attempt: AttemptContext) => Promise<T>,
  ): Promise<MemoStepResult<T>> {
    if (this.memo.has(memoKey)) return { memoHit: true, value: this.memo.get(memoKey) as T };
    const value = await produce({ memoKey, ordinal: 1 });
    this.lineage.push({ memoKey, ordinal: 1, outcome: "completed" });
    this.memo.set(memoKey, value);
    return { memoHit: false, value };
  }

  attemptLineage(): readonly AttemptLineageEntry[] {
    return this.lineage;
  }
}

function indexOf(events: readonly string[], event: string): number {
  const index = events.indexOf(event);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function flowPorts(
  store: TraceStore,
  events: string[],
  semanticRoute: "repair" | "adjudication" = "repair",
): WorkflowPorts {
  return {
    readiness: {
      async resolve() {
        events.push("readiness");
        return { ready: true, bibleRenderingIds: ["bible.flow"] } as const;
      },
    },
    draft: {
      async draftScene(input) {
        events.push("draft");
        return draftedScene(input.scene);
      },
    },
    gates: {
      async evaluate() {
        events.push("gates");
        return { defects: [], evaluatedGates: ["glossary-exact"] };
      },
    },
    review: {
      async review(input) {
        events.push(`review:${input.lane}`);
        return input.unitIds.map((unitId) => ({
          lane: input.lane,
          verdict:
            input.lane === "Q1"
              ? fail("Q1", unitId, "major")
              : input.lane === "Q2"
                ? fail("Q2", unitId, "minor")
                : semanticRoute === "adjudication"
                  ? cannotAssess(input.lane as "Q3" | "Q4", unitId)
                  : pass(input.lane as "Q3" | "Q4", unitId),
        }));
      },
    },
    repair: {
      async lineEdit(input) {
        events.push(`p2:${input.defects.map((defect) => defect.reviewLane).join(",")}`);
        return { route: "repair", changedUnitIds: input.unitIds } as const;
      },
      async semanticRepair(input) {
        events.push(`p3:${input.defects.map((defect) => defect.reviewLane).join(",")}`);
        if (semanticRoute === "adjudication") {
          return { route: "adjudication", contestedUnitIds: input.unitIds } as const;
        }
        return { route: "repair", changedUnitIds: input.unitIds } as const;
      },
    },
    adjudicate: {
      async adjudicate() {
        events.push("q6");
        return { disposition: "finalize" } as const;
      },
    },
    patchback: {
      async exportPatch(input) {
        events.push(
          `patch:${input.finalized
            .map((item) => item.unitId)
            .sort()
            .join(",")}`,
        );
        return { patchId: "patch.flow" };
      },
      async buildLqaReview(input) {
        events.push(`q5:${input.unitIds.join(",")}`);
        return input.unitIds.map((unitId) => ({
          lane: "Q5" as const,
          verdict: pass("Q5", unitId),
        }));
      },
    },
    store,
  };
}

function workflowTelemetry(
  attempts: readonly AttemptLineageEntry[],
): QualifyingWorkflowAttemptObservation[] {
  return attempts.map((attempt, index) => ({
    qualifyingArtifactId: `artifact:workflow-${index + 1}`,
    memoKey: attempt.memoKey,
    attemptOrdinal: attempt.ordinal,
    metrics: {
      requested: { model: "fixture-model", provider: "fixture-policy" },
      served: { model: "fixture-model", provider: "fixture-provider" },
      generationId: `generation:workflow-${index + 1}`,
      memoHit: false,
      stage: "draft",
      role: "P1",
      latencyMs: index + 1,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      cost: { state: "confirmed", amountUsd: "0" },
      quarantine: false,
      correction: false,
    },
  }));
}

describe("workflow driver integration", () => {
  it("orders readiness through patched Q5 and records every injected model step", async () => {
    const events: string[] = [];
    const store = new TraceStore(events);
    const report = await runLocalizationWorkflow(
      REQUEST,
      [flowScene(["u1"])],
      flowPorts(store, events),
    );

    expect(indexOf(events, "draft")).toBeGreaterThan(indexOf(events, "readiness"));
    expect(indexOf(events, "gates")).toBeGreaterThan(indexOf(events, "draft"));
    expect(indexOf(events, "p2:Q2")).toBeGreaterThan(indexOf(events, "review:Q4"));
    expect(indexOf(events, "p3:Q1")).toBeGreaterThan(indexOf(events, "p2:Q2"));
    expect(indexOf(events, "finalize:final:u1")).toBeGreaterThan(indexOf(events, "p3:Q1"));
    expect(indexOf(events, "patch:u1")).toBeGreaterThan(indexOf(events, "finalize:final:u1"));
    expect(indexOf(events, "q5:u1")).toBeGreaterThan(indexOf(events, "patch:u1"));
    expect(events).not.toContain("q6");
    // P1, four first-pass reviews, P2/P3, two scoped reruns, patch, and Q5.
    expect(report.attemptLineage).toHaveLength(11);

    const telemetry = new InMemoryQualifyingAttemptTelemetryStore();
    await persistQualifyingWorkflowRunLineage(
      telemetry,
      report,
      workflowTelemetry(report.attemptLineage),
    );
    expect((await telemetry.list()).map((row) => [row.memoKey, row.attemptOrdinal])).toEqual(
      report.attemptLineage.map((attempt) => [attempt.memoKey, attempt.ordinal]),
    );
  });

  it("resumes from absent heads, patches all current finals, and memo-skips completed stages", async () => {
    const events: string[] = [];
    const store = new TraceStore(events);
    store.seedFinal("u1");
    const ports = flowPorts(store, events);

    await runLocalizationWorkflow(REQUEST, [flowScene(["u1", "u2"])], ports);
    expect(events).toContain("patch:u1,u2");
    expect(events).toContain("q5:u1,u2");

    events.length = 0;
    await runLocalizationWorkflow(REQUEST, [flowScene(["u1", "u2"])], ports);
    expect(events).toEqual([]);
  });

  it("does not dispatch Q6 for a one-sided repair fallback", async () => {
    const events: string[] = [];
    const store = new TraceStore(events);

    await runLocalizationWorkflow(
      REQUEST,
      [flowScene(["u1"])],
      flowPorts(store, events, "adjudication"),
    );

    expect(events).not.toContain("q6");
    expect(await store.readUnitHead("u1", "final")).toBeNull();
  });
});
