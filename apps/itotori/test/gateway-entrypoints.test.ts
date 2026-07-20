import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { runApiLocalize } from "../src/api/localize-route.js";
import { runApiPlay } from "../src/api/play-route.js";
import { runApiWiki } from "../src/api/wiki-route.js";
import { runLocalizeCommand } from "../src/cli/localize-command.js";
import { runPlayCommand } from "../src/cli/play-command.js";
import { runWikiCommand } from "../src/cli/wiki-command.js";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import type {
  AttemptContext,
  AttemptLineageEntry,
  DraftedScene,
  LaneVerdict,
  MemoStepResult,
  UnitArtifactRef,
  UnitStage,
  WorkflowPorts,
} from "../src/workflow/index.js";

const structure = JSON.parse(
  readFileSync(new URL("./fixtures/narrative-structure-v2-units.json", import.meta.url), "utf8"),
) as unknown;
const bridge = JSON.parse(
  readFileSync(new URL("./fixtures/whole-seen-bridge.json", import.meta.url), "utf8"),
) as BridgeBundleV02;
const SOURCE_HASH = `sha256:${"b".repeat(64)}` as const;
const SNAPSHOT_HASH = `sha256:${"a".repeat(64)}` as const;

class GatewayStore {
  readonly heads = new Map<string, UnitArtifactRef>();
  readonly attempts: AttemptLineageEntry[] = [];
  draftCalls = 0;
  patchCalls = 0;

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
    const ref = {
      unitId: input.unitId,
      stage: input.stage,
      contentHash: input.contentHash,
      version: (this.heads.get(key)?.version ?? 0) + 1,
    } as UnitArtifactRef;
    this.heads.set(key, ref);
    return ref;
  }

  async runMemoizedStep<T>(
    memoKey: string,
    produce: (attempt: AttemptContext) => Promise<T>,
  ): Promise<MemoStepResult<T>> {
    const value = await produce({ memoKey, ordinal: 1 });
    this.attempts.push({ memoKey, ordinal: 1, outcome: "completed" });
    return { memoHit: false, value };
  }

  attemptLineage(): readonly AttemptLineageEntry[] {
    return this.attempts;
  }
}

function passingVerdict(lane: "Q1" | "Q2" | "Q3" | "Q4" | "Q5", unitId: string): LaneVerdict {
  const rubric = {
    Q1: "meaning",
    Q2: "voice",
    Q3: "terminology",
    Q4: "continuity",
    Q5: "build-lqa",
  }[lane];
  return {
    lane,
    verdict: {
      schemaVersion: "itotori.review-verdict.v1",
      reviewId: `review:${lane}:${unitId}`,
      localizationSnapshotId: SNAPSHOT_HASH,
      roleId: lane,
      rubric,
      unitId,
      basis: { kind: "wiki-first", bibleRenderingIds: ["bible:1"] },
      verdict: "PASS",
      severity: "none",
      span: null,
      category: null,
      evidenceIds: ["evidence:1"],
      repairConstraint: null,
    },
  } as LaneVerdict;
}

function gatewayPorts(store: GatewayStore): WorkflowPorts {
  return {
    readiness: {
      async resolve() {
        return { ready: true, bibleRenderingIds: ["bible:1"] } as const;
      },
    },
    draft: {
      async draftScene(input) {
        store.draftCalls += 1;
        const drafts = input.scene.units.map((unit) => ({
          unitId: unit.unitId,
          sourceHash: SOURCE_HASH,
          targetSkeleton: `target:${unit.unitId}`,
          evidenceIds: ["evidence:1"],
          basis: { kind: "wiki-first" as const, bibleRenderingIds: ["bible:1"] },
          uncertainty: ["none"] as const,
        }));
        return {
          sceneId: input.scene.sceneId,
          mode: input.mode,
          batches: [
            {
              schemaVersion: "itotori.draft-batch.v1",
              localizationSnapshotId: SNAPSHOT_HASH,
              batchId: `batch:${input.scene.sceneId}`,
              scope: {
                kind: "whole-scene",
                sceneId: input.scene.sceneId,
                expectedUnitIds: drafts.map((draft) => draft.unitId),
              },
              drafts,
            },
          ],
          units: drafts.map((draft) => ({
            unitId: draft.unitId,
            draft,
            bibleRenderingIds: ["bible:1"],
          })),
        } as DraftedScene;
      },
    },
    gates: {
      async evaluate() {
        return { defects: [], evaluatedGates: ["protected-spans"] };
      },
    },
    review: {
      async review(input) {
        return input.unitIds.map((unitId) => passingVerdict(input.lane, unitId));
      },
    },
    repair: {
      async lineEdit(input) {
        return { route: "repair" as const, changedUnitIds: input.unitIds };
      },
      async semanticRepair(input) {
        return { route: "repair" as const, changedUnitIds: input.unitIds };
      },
    },
    adjudicate: {
      async adjudicate() {
        return { disposition: "finalize" as const };
      },
    },
    patchback: {
      async exportPatch() {
        store.patchCalls += 1;
        return { patchId: "patch:gateway" };
      },
      async buildLqaReview(input) {
        return input.unitIds.map((unitId) => passingVerdict("Q5", unitId));
      },
    },
    store,
  };
}

describe("gateway entrypoints", () => {
  it("drives CLI and API localize requests through injected workflow ports", async () => {
    const cliStore = new GatewayStore();
    const apiStore = new GatewayStore();
    const cliWrites = new Map<string, unknown>();
    const resolveCliPorts = vi.fn(() => ({ ports: gatewayPorts(cliStore) }));
    const resolveApiPorts = vi.fn(() => ({ ports: gatewayPorts(apiStore) }));

    await runLocalizeCommand(
      [
        "localize",
        "--run-mode",
        "production",
        "--structure",
        "structure.json",
        "--bridge",
        "bridge.json",
        "--output",
        "cli-run.json",
      ],
      {
        io: {
          readJson: (path) => (path === "bridge.json" ? bridge : structure),
          writeJson: (path, value) => cliWrites.set(path, value),
        },
        resolvePortSource: resolveCliPorts,
      },
    );
    const apiReport = await runApiLocalize(
      { runMode: "production", structureJson: structure, bridge },
      { resolvePortSource: resolveApiPorts },
    );

    expect(cliStore.draftCalls).toBeGreaterThan(0);
    expect(cliStore.patchCalls).toBe(1);
    expect(apiStore.draftCalls).toBeGreaterThan(0);
    expect(apiStore.patchCalls).toBe(1);
    expect(resolveCliPorts).toHaveBeenCalledWith(
      expect.objectContaining({ runMode: "production" }),
      { structureJson: structure, bridge },
    );
    expect(resolveApiPorts).toHaveBeenCalledWith(
      expect.objectContaining({ runMode: "production" }),
      { structureJson: structure, bridge },
    );
    expect(cliWrites.get("cli-run.json")).toMatchObject({ patchId: "patch:gateway" });
    expect(apiReport.patchId).toBe("patch:gateway");
  });

  it("routes wiki build/object requests and patch play through their new ports", async () => {
    const wikiBuild = vi.fn().mockResolvedValue({
      phases: [],
      producedKeys: ["source:1"],
      skippedKeys: [],
      uncitableObjects: [],
    });
    const list = vi.fn().mockResolvedValue({ sourceObjects: [], renderings: [] });
    const load = vi.fn().mockResolvedValue({ patchVersionId: "patch:1" });
    const launch = vi.fn().mockResolvedValue({ runtime: "utsushi", scene: 4 });
    const writes = new Map<string, unknown>();

    await runWikiCommand(
      [
        "wiki",
        "build",
        "--run-mode",
        "production",
        "--source-locale",
        "ja-JP",
        "--structure",
        "structure.json",
        "--bridge",
        "bridge.json",
        "--output",
        "wiki.json",
      ],
      {
        io: {
          readJson: (path) => (path === "bridge.json" ? bridge : structure),
          writeJson: (path, value) => writes.set(path, value),
        },
        resolveWikiService: () => ({ list }) as never,
        runBuild: wikiBuild,
      },
    );
    const listed = await runApiWiki(
      { action: "list", snapshotId: "snapshot:1" },
      { resolveWikiService: () => ({ list }) as never },
    );
    await runPlayCommand(["patch", "play", "patch:1", "--output", "play.json"], {
      io: { writeJson: (path, value) => writes.set(path, value) },
      resolvePlayDeps: () => ({ loader: { load }, launcher: { launch } }) as never,
    });
    const receipt = await runApiPlay(
      { patchVersionId: "patch:1" },
      { resolvePlayDeps: () => ({ loader: { load }, launcher: { launch } }) as never },
    );

    expect(wikiBuild).toHaveBeenCalledWith(
      expect.objectContaining({ bridge, structureJson: structure, sourceLanguage: "ja-JP" }),
    );
    expect(list).toHaveBeenCalledWith({ snapshotId: "snapshot:1" });
    expect(listed).toEqual({ action: "list", result: { sourceObjects: [], renderings: [] } });
    expect(load).toHaveBeenCalledWith("patch:1");
    expect(launch).toHaveBeenCalledWith({ patch: { patchVersionId: "patch:1" } });
    expect(writes.get("play.json")).toMatchObject({ runtime: "utsushi" });
    expect(receipt).toMatchObject({ runtime: "utsushi" });
  });
});
