import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { runApiLocalize } from "../src/api/localize-route.js";
import { runApiWiki } from "../src/api/wiki-route.js";
import { runApiPlay } from "../src/api/play-route.js";
import { handleItotoriApiRequest, type ItotoriApiServices } from "../src/api-handlers.js";
import { ItotoriProjectWorkflowService } from "../src/services/project-workflow.js";
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
import { projectFixture, dashboardStatusFixture } from "./api-fixtures.js";

// The API cutover: the kept localize/draft, wiki write, and patch-play mutation
// handlers drive ONLY the new-pipeline composition entrypoints. These behavior
// proofs drive each kept handler with injected fake substrate and assert the
// localize path drives the NEW deterministic driver while the legacy
// `ProjectWorkflowService.draftProject` is never reached.

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

describe("localize API handler drives the new driver, never the old service", () => {
  it("projects the decoded structure, drives the driver, and never calls draftProject", async () => {
    const draftSpy = vi
      .spyOn(ItotoriProjectWorkflowService.prototype, "draftProject")
      .mockImplementation(() => {
        throw new Error("the localize API handler must never reach the old draftProject path");
      });

    const store = new FakeStore();
    const report = await runApiLocalize(
      {
        runMode: "production",
        structureJson: STRUCTURE_JSON,
      },
      {
        resolvePortSource: () => ({ ports: fakePorts(store) }),
      },
    );

    expect(store.draftCalls).toBeGreaterThan(0);
    expect(store.exportCalls).toBe(1);
    expect(report.policy.runMode).toBe("production");
    expect(report.patchId).toBe("patch.1");
    expect(report.finalized.length).toBe(3);

    expect(draftSpy).not.toHaveBeenCalled();
    draftSpy.mockRestore();
  });

  it("an API branches.draft request with substrate drives the new driver and never draftProject", async () => {
    const draftSpy = vi
      .spyOn(ItotoriProjectWorkflowService.prototype, "draftProject")
      .mockImplementation(() => {
        throw new Error("the draft API route must never reach the old draftProject path");
      });

    const store = new FakeStore();
    const services = {
      authorization: {
        requirePermission: vi.fn(async () => {}),
      },
      projectWorkflow: {
        listLocaleBranchIdentities: vi.fn(async () => [
          {
            localeBranchId: "locale-1",
            projectId: "project-1",
            sourceBundleId: "bridge-1",
            sourceBundleRevisionId: "revision-1",
            sourceLocale: "ja-JP",
            targetLocale: "en-US",
            branchName: "en-US",
            status: "active" as const,
          },
        ]),
        getDashboardStatus: vi.fn(async () => dashboardStatusFixture),
      },
      localizationSubstrate: {
        resolvePortSource: () => ({ ports: fakePorts(store) }),
      },
      patchPlay: {
        loader: { load: vi.fn() },
        launcher: { launch: vi.fn() },
      },
    } as unknown as ItotoriApiServices;

    const response = await handleItotoriApiRequest(
      {
        method: "POST",
        pathname: "/api/projects/project-1/branches",
        body: {
          project: projectFixture,
          targetLocale: "fr-FR",
          runMode: "production",
          structure: STRUCTURE_JSON,
        },
      },
      services,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ outcome: "drafted" });
    expect(store.draftCalls).toBeGreaterThan(0);
    expect(store.exportCalls).toBe(1);
    expect(draftSpy).not.toHaveBeenCalled();
    draftSpy.mockRestore();
  });

  it("refuses in-band when localizationSubstrate is missing (never draftProject)", async () => {
    const draftSpy = vi
      .spyOn(ItotoriProjectWorkflowService.prototype, "draftProject")
      .mockImplementation(() => {
        throw new Error("draft must never fall back to draftProject when substrate is missing");
      });

    const services = {
      authorization: {
        requirePermission: vi.fn(async () => {}),
      },
      projectWorkflow: {
        listLocaleBranchIdentities: vi.fn(async () => [
          {
            localeBranchId: "locale-1",
            projectId: "project-1",
            sourceBundleId: "bridge-1",
            sourceBundleRevisionId: "revision-1",
            sourceLocale: "ja-JP",
            targetLocale: "en-US",
            branchName: "en-US",
            status: "active" as const,
          },
        ]),
        getDashboardStatus: vi.fn(async () => dashboardStatusFixture),
      },
      patchPlay: {
        loader: { load: vi.fn() },
        launcher: { launch: vi.fn() },
      },
    } as unknown as ItotoriApiServices;

    const response = await handleItotoriApiRequest(
      {
        method: "POST",
        pathname: "/api/projects/project-1/branches",
        body: { project: projectFixture, targetLocale: "fr-FR" },
      },
      services,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      outcome: "refused",
      project: null,
      status: null,
    });
    expect((response.body as { refusalMessage: string }).refusalMessage).toContain(
      "localizationSubstrate port missing",
    );
    expect(draftSpy).not.toHaveBeenCalled();
    draftSpy.mockRestore();
  });
});

describe("wiki API handler routes to the new object-API", () => {
  it("delegates wiki edit to the injected object-API service", async () => {
    const openEditSession = vi
      .fn()
      .mockResolvedValue({ objectId: "obj-1", wikiKind: "source-object" });
    const edit = vi.fn().mockResolvedValue({
      durable: true,
      inputId: "input-1",
      head: { objectId: "obj-1", version: 2, contentHash: "sha256:abc" },
      view: {},
      badges: {},
      dependencyImpact: { consumers: [] },
    });
    const response = await runApiWiki(
      {
        action: "edit",
        selector: { wikiKind: "source-object", objectId: "obj-1" },
        candidate: { kind: "edit", body: "x", reason: "y" },
        createdAt: "2026-07-16T00:00:00.000Z",
      },
      {
        resolveWikiService: () => ({ openEditSession, edit }) as never,
      },
    );
    expect(openEditSession).toHaveBeenCalled();
    expect(edit).toHaveBeenCalled();
    expect(response.action).toBe("edit");
  });
});

describe("patch-play API handler routes to the new runtime launcher", () => {
  it("loads the exact surface and launches through the injected launcher", async () => {
    const load = vi.fn().mockResolvedValue({ patchVersionId: "v1" });
    const launch = vi.fn().mockResolvedValue({
      runtime: "utsushi-reallive",
      engine: "reallive",
      scene: 1,
      replay: "observed",
      observedTextLineCount: 3,
    });
    const receipt = await runApiPlay(
      { patchVersionId: "v1" },
      { resolvePlayDeps: () => ({ loader: { load }, launcher: { launch } }) as never },
    );
    expect(load).toHaveBeenCalledWith("v1");
    expect(launch).toHaveBeenCalledWith({ patch: { patchVersionId: "v1" } });
    expect(receipt.observedTextLineCount).toBe(3);
  });
});
