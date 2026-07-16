import { describe, expect, it, vi } from "vitest";

import { ItotoriProjectWorkflowService } from "../src/services/project-workflow.js";
import { createWorkflowPorts, runLocalization } from "../src/composition/index.js";
import type { WorkflowPortDeps } from "../src/composition/index.js";
import { FULL_ROSTER, type RunPolicyRequest } from "../src/run-policy/index.js";
import type {
  AttemptContext,
  AttemptLineageEntry,
  DraftMode,
  DraftedScene,
  DraftedUnit,
  LaneVerdict,
  MemoStepResult,
  ReviewLane,
  UnitArtifactRef,
  UnitStage,
  WorkflowPorts,
  WorkflowScene,
} from "../src/workflow/index.js";

// Clause 1 (run the driver) + clause 2 (behavior half): a localize request drives
// the NEW deterministic driver through the composition entrypoint, and NEVER the
// legacy `ProjectWorkflowService.draftProject`. The driver is driven with fake
// ports (the same fake-shape technique the workflow-driver proof uses) so the
// proof needs no live ZDR runtime / Postgres.

const SRC = `sha256:${"b".repeat(64)}` as const;
const SNAP = `sha256:${"a".repeat(64)}` as const;

function draftFor(unitId: string): DraftedUnit {
  return {
    unitId,
    bibleRenderingIds: ["bible.rendering.1"],
    draft: {
      unitId,
      sourceHash: SRC,
      targetSkeleton: `target for ${unitId}`,
      evidenceIds: ["ev.1"],
      basis: { kind: "wiki-first", bibleRenderingIds: ["bible.rendering.1"] },
      uncertainty: ["none"],
    },
  };
}

function draftedScene(sceneId: string, unitIds: readonly string[], mode: DraftMode): DraftedScene {
  return {
    sceneId,
    mode,
    batches: [
      {
        schemaVersion: "itotori.draft-batch.v1",
        localizationSnapshotId: SNAP,
        batchId: `${sceneId}.batch`,
        scope: { kind: "whole-scene", sceneId, expectedUnitIds: [...unitIds] },
        drafts: unitIds.map((unitId) => draftFor(unitId).draft),
      },
    ],
    units: unitIds.map((unitId) => draftFor(unitId)),
  };
}

function scene(sceneId: string, unitIds: readonly string[]): WorkflowScene {
  return {
    sceneId,
    units: unitIds.map((unitId) => ({
      unitId,
      sourceHash: SRC,
      speakerId: `speaker.${unitId}`,
      routeId: `route.${sceneId}`,
      firstAppearance: false,
    })),
  };
}

function passVerdict(lane: ReviewLane, unitId: string): LaneVerdict {
  const rubric = (
    {
      Q1: "meaning",
      Q2: "voice",
      Q3: "terminology",
      Q4: "continuity",
      Q5: "build-lqa",
      Q6: "adjudication",
    } as const
  )[lane];
  return {
    lane,
    verdict: {
      schemaVersion: "itotori.review-verdict.v1",
      reviewId: `review.${lane}.${unitId}`,
      localizationSnapshotId: SNAP,
      roleId: lane,
      rubric,
      unitId,
      basis: { kind: "wiki-first", bibleRenderingIds: ["bible.rendering.1"] },
      verdict: "PASS",
      severity: "none",
      span: null,
      category: null,
      evidenceIds: ["ev.1"],
      repairConstraint: null,
    },
  };
}

class FakeStore {
  readonly heads = new Map<string, UnitArtifactRef>();
  readonly completed = new Map<string, unknown>();
  readonly lineage: AttemptLineageEntry[] = [];
  draftCalls = 0;
  reviewCalls = 0;
  exportCalls = 0;

  async readUnitHead(unitId: string, stage: UnitStage): Promise<UnitArtifactRef | null> {
    return this.heads.get(`${unitId}:${stage}`) ?? null;
  }
  async finalizeUnit(input: {
    unitId: string;
    stage: UnitStage;
    contentHash: `sha256:${string}`;
    shippable: boolean;
  }): Promise<UnitArtifactRef> {
    const key = `${input.unitId}:${input.stage}`;
    const ref: UnitArtifactRef = {
      unitId: input.unitId,
      stage: input.stage,
      contentHash: input.contentHash,
      version: (this.heads.get(key)?.version ?? 0) + 1,
    };
    this.heads.set(key, ref);
    return ref;
  }
  async runMemoizedStep<T>(
    memoKey: string,
    produce: (attempt: AttemptContext) => Promise<T>,
  ): Promise<MemoStepResult<T>> {
    if (this.completed.has(memoKey))
      return { memoHit: true, value: this.completed.get(memoKey) as T };
    const value = await produce({ memoKey, ordinal: 1 });
    this.lineage.push({ memoKey, ordinal: 1, outcome: "completed" });
    this.completed.set(memoKey, value);
    return { memoHit: false, value };
  }
  attemptLineage(): readonly AttemptLineageEntry[] {
    return this.lineage;
  }
}

function fakePorts(store: FakeStore): WorkflowPorts {
  return {
    readiness: {
      async resolve() {
        return { ready: true, bibleRenderingIds: ["bible.rendering.1"] };
      },
    },
    draft: {
      async draftScene(input) {
        store.draftCalls += 1;
        return draftedScene(
          input.scene.sceneId,
          input.scene.units.map((unit) => unit.unitId),
          input.mode,
        );
      },
    },
    gates: {
      async evaluate() {
        return { defects: [], evaluatedGates: ["protected-spans", "glossary-exact"] };
      },
    },
    review: {
      async review(input) {
        store.reviewCalls += 1;
        return input.unitIds.map((unitId) => passVerdict(input.lane, unitId));
      },
    },
    repair: {
      async lineEdit(input) {
        return { route: "repair", changedUnitIds: input.unitIds };
      },
      async semanticRepair(input) {
        return { route: "repair", changedUnitIds: input.unitIds };
      },
    },
    adjudicate: {
      async adjudicate() {
        return { disposition: "finalize" };
      },
    },
    patchback: {
      async exportPatch() {
        store.exportCalls += 1;
        return { patchId: "patch.1" };
      },
      async buildLqaReview(input) {
        return input.unitIds.map((unitId) => passVerdict("Q5", unitId));
      },
    },
    store: store as unknown as WorkflowPorts["store"],
  };
}

const PRODUCTION: RunPolicyRequest = {
  runMode: "production",
  contextScope: "whole-game",
  outputScope: "dialogue-only",
  roster: FULL_ROSTER,
};

describe("composition behavior — a localize request drives the new driver, never the old service", () => {
  it("runs the whole workflow through the entrypoint and never calls ProjectWorkflowService.draftProject", async () => {
    const draftSpy = vi
      .spyOn(ItotoriProjectWorkflowService.prototype, "draftProject")
      .mockImplementation(() => {
        throw new Error("the localize entrypoint must never reach the old draftProject path");
      });

    const store = new FakeStore();
    const report = await runLocalization(
      PRODUCTION,
      [scene("s1", ["u1", "u2"]), scene("s2", ["u3"])],
      { ports: fakePorts(store) },
    );

    // The NEW driver ran end to end: it drafted, reviewed, finalized, patched.
    expect(store.draftCalls).toBeGreaterThan(0);
    expect(store.reviewCalls).toBeGreaterThan(0);
    expect(store.exportCalls).toBe(1);
    expect(report.patchId).toBe("patch.1");
    expect(report.finalized.map((unit) => unit.unitId).sort()).toEqual(["u1", "u2", "u3"]);
    expect(report.policy.runMode).toBe("production");

    // The old service was NEVER reached from the kept entrypoint.
    expect(draftSpy).not.toHaveBeenCalled();
    draftSpy.mockRestore();
  });
});

describe("composition wiring — createWorkflowPorts constructs ONLY the new ports", () => {
  it("assembles all eight driver ports and wires the store + review seams through", async () => {
    const store = new FakeStore();
    let reviewLaneCalls = 0;
    const deps = {
      review: {
        async reviewLane(input: { lane: ReviewLane; unitIds: readonly string[] }) {
          reviewLaneCalls += 1;
          return input.unitIds.map((unitId) => passVerdict(input.lane, unitId));
        },
      },
      store,
      // The remaining seams are not exercised by this structural assertion.
    } as unknown as WorkflowPortDeps;

    const ports = createWorkflowPorts(deps);
    expect(Object.keys(ports).sort()).toEqual([
      "adjudicate",
      "draft",
      "gates",
      "patchback",
      "readiness",
      "repair",
      "review",
      "store",
    ]);
    // The store port is the injected CAS substrate (identity wiring).
    expect(ports.store).toBe(store);
    // The review port delegates to the injected per-lane review seam.
    const verdicts = await ports.review.review({
      lane: "Q1",
      scene: draftedScene("s1", ["u1"], "whole-scene"),
      unitIds: ["u1"],
    });
    expect(reviewLaneCalls).toBe(1);
    expect(verdicts[0]?.lane).toBe("Q1");
  });
});
