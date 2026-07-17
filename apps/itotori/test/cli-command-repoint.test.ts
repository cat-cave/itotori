import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { runLocalizeCommand } from "../src/cli/localize-command.js";
import { runWikiCommand } from "../src/cli/wiki-command.js";
import { runPlayCommand } from "../src/cli/play-command.js";
import { ItotoriProjectWorkflowService } from "../src/services/project-workflow.js";
import {
  addressRequestedRun,
  provisionProjectBranch,
  RequestedRunNotFoundError,
  type AddressableRun,
  type ProvisioningStore,
} from "../src/composition/index.js";
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
} from "../src/workflow/index.js";

// The CLI cutover: the kept `localize` / `wiki` / `patch play` CLI handlers
// drive ONLY the new-pipeline composition entrypoints. These behavior proofs drive
// each kept handler with injected fake substrate (the same fake-shape technique the
// workflow-driver / composition proofs use) and assert the localize handler drives
// the NEW deterministic driver while the legacy `ProjectWorkflowService.draftProject`
// is never reached.

const SRC = `sha256:${"b".repeat(64)}` as const;
const SNAP = `sha256:${"a".repeat(64)}` as const;

const STRUCTURE_JSON = JSON.parse(
  readFileSync(new URL("./fixtures/narrative-structure-v2-units.json", import.meta.url), "utf8"),
) as unknown;

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
        return { defects: [], evaluatedGates: ["protected-spans"] };
      },
    },
    review: {
      async review(input) {
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

describe("localize CLI handler drives the new driver, never the old service", () => {
  it("projects the decoded structure, drives the driver, and never calls draftProject", async () => {
    const draftSpy = vi
      .spyOn(ItotoriProjectWorkflowService.prototype, "draftProject")
      .mockImplementation(() => {
        throw new Error("the localize CLI handler must never reach the old draftProject path");
      });

    const store = new FakeStore();
    const writes = new Map<string, unknown>();

    await runLocalizeCommand(
      [
        "localize",
        "--run-mode",
        "production",
        "--structure",
        "structure.json",
        "--output",
        "run.json",
      ],
      {
        io: {
          readJson: () => STRUCTURE_JSON,
          writeJson: (path, value) => {
            writes.set(path, value);
          },
        },
        resolvePortSource: () => ({ ports: fakePorts(store) }),
      },
    );

    // The NEW driver ran end to end over the projected scenes.
    expect(store.draftCalls).toBeGreaterThan(0);
    expect(store.exportCalls).toBe(1);
    const summary = writes.get("run.json") as {
      runMode: string;
      patchId: string;
      finalizedUnitCount: number;
    };
    expect(summary.runMode).toBe("production");
    expect(summary.patchId).toBe("patch.1");
    expect(summary.finalizedUnitCount).toBe(3);

    // The old service was NEVER reached from the kept CLI handler.
    expect(draftSpy).not.toHaveBeenCalled();
    draftSpy.mockRestore();
  });

  it("rejects an illegal run policy at the boundary (production forbids a narrowed context)", async () => {
    await expect(
      runLocalizeCommand(
        [
          "localize",
          "--run-mode",
          "production",
          "--context-scope",
          "narrowed:one-scene",
          "--structure",
          "structure.json",
        ],
        {
          io: { readJson: () => STRUCTURE_JSON, writeJson: () => undefined },
          resolvePortSource: () => {
            throw new Error("port source must not be resolved for an illegal run");
          },
        },
      ),
    ).rejects.toThrow();
  });
});

describe("wiki CLI handler routes to the new object-API", () => {
  it("delegates `wiki list` to the injected object-API service", async () => {
    const list = vi.fn().mockResolvedValue({ sourceObjects: [], renderings: [] });
    const writes = new Map<string, unknown>();
    await runWikiCommand(["wiki", "list", "--snapshot", "snap-1", "--output", "wiki.json"], {
      io: { writeJson: (path, value) => writes.set(path, value) },
      resolveWikiService: () => ({ list }) as never,
    });
    expect(list).toHaveBeenCalledWith({ snapshotId: "snap-1" });
    expect(writes.get("wiki.json")).toEqual({
      action: "list",
      result: { sourceObjects: [], renderings: [] },
    });
  });
});

describe("patch-play CLI handler routes to the new runtime launcher", () => {
  it("loads the exact surface and launches through the injected launcher", async () => {
    const load = vi.fn().mockResolvedValue({ patchVersionId: "v1" });
    const launch = vi.fn().mockResolvedValue({
      runtime: "utsushi-reallive",
      engine: "reallive",
      scene: 1,
      replay: "observed",
      observedTextLineCount: 3,
    });
    const writes = new Map<string, unknown>();
    await runPlayCommand(["patch", "play", "v1", "--output", "receipt.json"], {
      io: { writeJson: (path, value) => writes.set(path, value) },
      resolvePlayDeps: () => ({ loader: { load }, launcher: { launch } }) as never,
    });
    expect(load).toHaveBeenCalledWith("v1");
    expect(launch).toHaveBeenCalledWith({ patch: { patchVersionId: "v1" } });
    expect(
      (writes.get("receipt.json") as { observedTextLineCount: number }).observedTextLineCount,
    ).toBe(3);
  });
});

describe("fresh provisioning + exact requested-run addressing still work", () => {
  function inMemoryStore(): ProvisioningStore & { runs: Map<string, AddressableRun> } {
    const projects = new Set<string>();
    const branches = new Set<string>();
    const runs = new Map<string, AddressableRun>();
    return {
      runs,
      async hasProject(projectId) {
        return projects.has(projectId);
      },
      async ensureProject(projectId) {
        const created = !projects.has(projectId);
        projects.add(projectId);
        return { projectId, created };
      },
      async ensureLocaleBranch(input) {
        const key = `${input.projectId}:${input.localeBranchId}`;
        const created = !branches.has(key);
        branches.add(key);
        return { ...input, created };
      },
      async findRun(runId) {
        return runs.get(runId) ?? null;
      },
    };
  }

  it("provisions a fresh project/branch in place and addresses the exact requested run", async () => {
    const store = inMemoryStore();
    const result = await provisionProjectBranch(store, {
      projectId: "proj-1",
      localeBranchId: "branch-1",
      targetLocale: "en",
    });
    expect(result.project.created).toBe(true);
    expect(result.branch.created).toBe(true);

    store.runs.set("run-1", { runId: "run-1", projectId: "proj-1", localeBranchId: "branch-1" });
    const addressed = await addressRequestedRun(store, "run-1");
    expect(addressed.projectId).toBe("proj-1");

    await expect(addressRequestedRun(store, "missing")).rejects.toBeInstanceOf(
      RequestedRunNotFoundError,
    );
  });
});
