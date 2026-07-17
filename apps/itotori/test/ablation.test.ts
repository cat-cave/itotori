import { describe, expect, it } from "vitest";

import { buildDefect } from "../src/gates/index.js";
import type { Defect } from "../src/contracts/index.js";
import { FULL_ROSTER, resolveRunPolicy, type RunPolicyRequest } from "../src/run-policy/index.js";
import {
  AblationLineageIsolationError,
  EMPTY_QUALIFYING_METRICS,
  collectAblationLineage,
  foldQualifyingLineage,
  lineageClassOf,
  resolveAblationPolicy,
  runPureMtlAblation,
  tagLineage,
  type AblationRunRequest,
} from "../src/ablation/index.js";
import type {
  AttemptContext,
  AttemptLineageEntry,
  DraftMode,
  DraftedScene,
  DraftedUnit,
  MemoStepResult,
  UnitArtifactRef,
  UnitStage,
  WorkflowPorts,
  WorkflowScene,
} from "../src/workflow/index.js";

// ---------------------------------------------------------------------------
// Fixtures — minimal valid role outputs (the same shapes the workflow proof
// uses). The driver proves control flow / isolation; these stand in for the
// best-effort content a real P1 direct-translate call would produce.
// ---------------------------------------------------------------------------

const SNAP = `sha256:${"a".repeat(64)}` as const;
const SRC = `sha256:${"b".repeat(64)}` as const;

function draftFor(unitId: string, bibleRenderingIds: readonly string[]): DraftedUnit {
  return {
    unitId,
    bibleRenderingIds,
    draft: {
      unitId,
      sourceHash: SRC,
      targetSkeleton: `target for ${unitId}`,
      evidenceIds: ["ev.1"],
      // The ablation drafts with no bible grounding — a null-Wiki basis (the
      // substrate's own `pure-mtl-ablation` draft basis carries no renderings).
      basis: { kind: "pure-mtl-ablation", bibleRenderingIds: [] },
      uncertainty: ["none"],
    },
  };
}

function draftedScene(
  sceneId: string,
  unitIds: readonly string[],
  mode: DraftMode,
  bibleByUnit: ReadonlyMap<string, readonly string[]>,
): DraftedScene {
  return {
    sceneId,
    mode,
    batches: [
      {
        schemaVersion: "itotori.draft-batch.v1",
        localizationSnapshotId: SNAP,
        batchId: `${sceneId}.batch`,
        scope: { kind: "whole-scene", sceneId, expectedUnitIds: [...unitIds] },
        drafts: unitIds.map((unitId) => draftFor(unitId, bibleByUnit.get(unitId) ?? []).draft),
      },
    ],
    units: unitIds.map((unitId) => draftFor(unitId, bibleByUnit.get(unitId) ?? [])),
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

function protectedSpanDefect(unitId: string): Defect {
  return buildDefect({
    unitId,
    category: "protected-span",
    detail: `protected span dropped in ${unitId}`,
    basisFactIds: ["fact.1"],
  });
}

// ---------------------------------------------------------------------------
// Fake substrate + ports. The store models the CAS heads + memoized physical
// step + attempt ledger exactly as the workflow proof does; the recorder proves
// which ports the ablation driver DID and DID NOT invoke.
// ---------------------------------------------------------------------------

class FakeStore {
  readonly heads = new Map<string, UnitArtifactRef>();
  readonly completed = new Map<string, unknown>();
  readonly lineage: AttemptLineageEntry[] = [];

  seedFinal(unitId: string): void {
    this.heads.set(`${unitId}:final`, { unitId, stage: "final", contentHash: SRC, version: 1 });
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
    const key = `${input.unitId}:${input.stage}`;
    const prev = this.heads.get(key);
    const ref: UnitArtifactRef = {
      unitId: input.unitId,
      stage: input.stage,
      contentHash: input.contentHash,
      version: (prev?.version ?? 0) + 1,
    };
    this.heads.set(key, ref);
    return ref;
  }

  async runMemoizedStep<T>(
    memoKey: string,
    produce: (attempt: AttemptContext) => Promise<T>,
  ): Promise<MemoStepResult<T>> {
    if (this.completed.has(memoKey)) {
      return { memoHit: true, value: this.completed.get(memoKey) as T };
    }
    const value = await produce({ memoKey, ordinal: 1 });
    this.lineage.push({ memoKey, ordinal: 1, outcome: "completed" });
    this.completed.set(memoKey, value);
    return { memoHit: false, value };
  }

  attemptLineage(): readonly AttemptLineageEntry[] {
    return this.lineage;
  }
}

interface Recorder {
  readinessCalls: number;
  reviewCalls: number;
  lineEditCalls: number;
  semanticRepairCalls: number;
  adjudicateCalls: number;
  buildLqaCalls: number;
  draftCalls: {
    sceneId: string;
    mode: DraftMode;
    unitIds: readonly string[];
    bibleEntries: number;
  }[];
  gateCalls: number;
  exportCalls: number;
  finalizeShippable: boolean[];
}

function newRecorder(): Recorder {
  return {
    readinessCalls: 0,
    reviewCalls: 0,
    lineEditCalls: 0,
    semanticRepairCalls: 0,
    adjudicateCalls: 0,
    buildLqaCalls: 0,
    draftCalls: [],
    gateCalls: 0,
    exportCalls: 0,
    finalizeShippable: [],
  };
}

interface FakeOptions {
  readonly gateDefects?: readonly Defect[];
}

function buildPorts(store: FakeStore, rec: Recorder, opts: FakeOptions = {}): WorkflowPorts {
  // Wrap the store's finalize to observe the shippable disposition the policy gate
  // stamped onto each finalized head.
  const wrappedStore = {
    ...store,
    readUnitHead: store.readUnitHead.bind(store),
    runMemoizedStep: store.runMemoizedStep.bind(store),
    attemptLineage: store.attemptLineage.bind(store),
    async finalizeUnit(input: {
      unitId: string;
      stage: UnitStage;
      contentHash: `sha256:${string}`;
      shippable: boolean;
    }): Promise<UnitArtifactRef> {
      rec.finalizeShippable.push(input.shippable);
      return store.finalizeUnit(input);
    },
  } as unknown as WorkflowPorts["store"];

  return {
    readiness: {
      async resolve(unitId: string) {
        rec.readinessCalls += 1;
        return { ready: true as const, bibleRenderingIds: [`bible.${unitId}`] };
      },
    },
    draft: {
      async draftScene(input): Promise<DraftedScene> {
        const unitIds = input.scene.units.map((unit) => unit.unitId);
        rec.draftCalls.push({
          sceneId: input.scene.sceneId,
          mode: input.mode,
          unitIds,
          bibleEntries: input.bibleRenderingIdsByUnit.size,
        });
        return draftedScene(
          input.scene.sceneId,
          unitIds,
          input.mode,
          input.bibleRenderingIdsByUnit,
        );
      },
    },
    gates: {
      async evaluate(): Promise<{
        defects: readonly Defect[];
        evaluatedGates: readonly ("protected-spans" | "glossary-exact")[];
      }> {
        rec.gateCalls += 1;
        return {
          defects: opts.gateDefects ?? [],
          evaluatedGates: ["protected-spans", "glossary-exact"],
        };
      },
    },
    review: {
      async review() {
        rec.reviewCalls += 1;
        return [];
      },
    },
    repair: {
      async lineEdit(input) {
        rec.lineEditCalls += 1;
        return { route: "repair" as const, changedUnitIds: input.unitIds };
      },
      async semanticRepair(input) {
        rec.semanticRepairCalls += 1;
        return { route: "repair" as const, changedUnitIds: input.unitIds };
      },
    },
    adjudicate: {
      async adjudicate() {
        rec.adjudicateCalls += 1;
        return { disposition: "finalize" as const };
      },
    },
    patchback: {
      async exportPatch() {
        rec.exportCalls += 1;
        return { patchId: "patch.ablation.1" };
      },
      async buildLqaReview() {
        rec.buildLqaCalls += 1;
        return [];
      },
    },
    store: wrappedStore,
  };
}

const ABLATION_REQUEST: AblationRunRequest = {
  runMode: "test-dev",
  contextScope: "whole-game",
  outputScope: "dialogue-only",
  roster: FULL_ROSTER,
};

const PRODUCTION: RunPolicyRequest = {
  runMode: "production",
  contextScope: "whole-game",
  outputScope: "dialogue-only",
  roster: FULL_ROSTER,
};

// ---------------------------------------------------------------------------
// Clause 1 — SAME substrate (policy + dispatch/draft + gates + patchback + CAS),
// not a parallel/forked implementation.
// ---------------------------------------------------------------------------

describe("pure-MTL ablation — clause 1: same substrate as the real pipeline", () => {
  it("resolves through the SAME run-policy boundary (pinned pure-mtl selector) and lands on the null-Wiki, non-shippable, test-dev basis", () => {
    const policy = resolveAblationPolicy(ABLATION_REQUEST);
    // Identical to submitting the ablation selector to the shared resolver.
    const direct = resolveRunPolicy({ ...ABLATION_REQUEST, ablation: { kind: "pure-mtl" } });
    expect(policy).toEqual(direct);
    expect(policy.runMode).toBe("test-dev");
    expect(policy.bibleBasis).toBe("pure-mtl-ablation");
    expect(policy.shippable).toBe(false);
  });

  it("drives the SAME draft (P1 dispatch boundary) + gates + CAS finalize + native patchback ports", async () => {
    const store = new FakeStore();
    const rec = newRecorder();
    const ports = buildPorts(store, rec);
    const report = await runPureMtlAblation(ABLATION_REQUEST, [scene("s1", ["u1", "u2"])], ports);

    // The real substrate ports WERE exercised.
    expect(rec.draftCalls).toHaveLength(1);
    expect(rec.gateCalls).toBe(1);
    expect(rec.exportCalls).toBe(1);
    expect(report.patchId).toBe("patch.ablation.1");
    // Units finalized into the CAS, each addressed by a content hash.
    expect(report.finalized.map((unit) => unit.unitId).sort()).toEqual(["u1", "u2"]);
    // Every finalized head is artifact-only (non-shippable) — the policy gate.
    expect(rec.finalizeShippable).toEqual([false, false]);
    expect(report.finalized.every((unit) => unit.shippable === false)).toBe(true);
    // Physical draft attempt was counted in the SAME lineage substrate.
    expect(report.attemptLineage.length).toBeGreaterThanOrEqual(1);
  });

  it("restart-queries the SAME CAS durability substrate — produces only the missing units", async () => {
    const store = new FakeStore();
    const rec = newRecorder();
    const ports = buildPorts(store, rec);
    store.seedFinal("u1");
    const report = await runPureMtlAblation(
      ABLATION_REQUEST,
      [scene("s1", ["u1", "u2", "u3"])],
      ports,
    );
    expect(rec.draftCalls[0]?.unitIds).toEqual(["u2", "u3"]);
    expect(report.scenes[0]?.skippedUnitIds).toEqual(["u1"]);
    expect(report.scenes[0]?.draftedUnitIds).toEqual(["u2", "u3"]);
  });
});

// ---------------------------------------------------------------------------
// Clause 2 — null Wiki + direct translation + ~zero model QA.
// ---------------------------------------------------------------------------

describe("pure-MTL ablation — clause 2: null Wiki, direct translation, ~zero model QA", () => {
  it("NEVER calls readiness / review / repair / adjudicate / build-lqa; drafts with an EMPTY bible map", async () => {
    const store = new FakeStore();
    const rec = newRecorder();
    const ports = buildPorts(store, rec);
    await runPureMtlAblation(ABLATION_REQUEST, [scene("s1", ["u1", "u2", "u3"])], ports);

    // No bible resolution, no source-wiki grounding: the draft got an empty map.
    expect(rec.readinessCalls).toBe(0);
    expect(rec.draftCalls[0]?.bibleEntries).toBe(0);
    // Direct translation: a single whole-scene translate call, not chunked review.
    expect(rec.draftCalls).toHaveLength(1);
    expect(rec.draftCalls[0]?.mode).toBe("whole-scene");
    // ~Zero model QA: no Q-review stratification, no P2/P3 repair, no Q6, no Q5.
    expect(rec.reviewCalls).toBe(0);
    expect(rec.lineEditCalls).toBe(0);
    expect(rec.semanticRepairCalls).toBe(0);
    expect(rec.adjudicateCalls).toBe(0);
    expect(rec.buildLqaCalls).toBe(0);
  });

  it("REPORTS deterministic gate defects but never routes them to a model reviewer/repairer", async () => {
    const store = new FakeStore();
    const rec = newRecorder();
    const ports = buildPorts(store, rec, { gateDefects: [protectedSpanDefect("u1")] });
    const report = await runPureMtlAblation(ABLATION_REQUEST, [scene("s1", ["u1"])], ports);
    // The deterministic gate ran and its defect is surfaced for the benchmark...
    expect(report.scenes[0]?.gateDefects).toHaveLength(1);
    expect(report.scenes[0]?.gateDefects[0]?.gate).toBe("protected-spans");
    // ...but no model QA was invoked to correct it.
    expect(
      rec.reviewCalls + rec.lineEditCalls + rec.semanticRepairCalls + rec.adjudicateCalls,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Clause 3 — lineage/telemetry ISOLATED from the qualifying lineage.
// ---------------------------------------------------------------------------

describe("pure-MTL ablation — clause 3: lineage isolated from the qualifying lineage", () => {
  it("tags the ablation lineage as 'ablation' (derived from the null-Wiki basis, not a flag)", async () => {
    const store = new FakeStore();
    const rec = newRecorder();
    const ports = buildPorts(store, rec);
    const report = await runPureMtlAblation(ABLATION_REQUEST, [scene("s1", ["u1"])], ports);
    expect(report.lineageClass).toBe("ablation");
    // Derived: a wiki-first (production) policy is 'qualifying'; the ablation is not.
    expect(lineageClassOf(report.policy)).toBe("ablation");
    expect(lineageClassOf(resolveRunPolicy(PRODUCTION))).toBe("qualifying");
  });

  it("REFUSES to fold the ablation lineage into the qualifying metrics ledger", async () => {
    const store = new FakeStore();
    const rec = newRecorder();
    const ports = buildPorts(store, rec);
    const report = await runPureMtlAblation(ABLATION_REQUEST, [scene("s1", ["u1", "u2"])], ports);
    const tagged = tagLineage(report.policy, report);

    // The isolation guard: an ablation contribution can never enter qualifying totals.
    expect(() => foldQualifyingLineage(EMPTY_QUALIFYING_METRICS, tagged)).toThrow(
      AblationLineageIsolationError,
    );

    // It DOES accumulate in its own isolated ablation ledger.
    const ablationLedger = collectAblationLineage(EMPTY_QUALIFYING_METRICS, tagged);
    expect(ablationLedger.runCount).toBe(1);
    expect(ablationLedger.contributingClasses).toEqual(["ablation"]);
    expect(ablationLedger.attemptCount).toBe(report.attemptLineage.length);

    // A genuine qualifying run folds cleanly into the qualifying ledger, and the
    // ablation numbers are nowhere in it.
    const qualifying = tagLineage(resolveRunPolicy(PRODUCTION), {
      ...report,
      policy: resolveRunPolicy(PRODUCTION),
    });
    const qualLedger = foldQualifyingLineage(EMPTY_QUALIFYING_METRICS, qualifying);
    expect(qualLedger.contributingClasses).toEqual(["qualifying"]);
  });
});
