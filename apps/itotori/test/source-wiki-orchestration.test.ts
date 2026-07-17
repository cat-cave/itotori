// Whole-game source-Wiki orchestration — mutation-falsifiable control-flow proofs.
//
// This node is the DETERMINISTIC control flow that drives the analyst roster to
// build the whole-game source Wiki. The role agent outputs are best-effort and
// supplied here by a recorded runner; every proof targets a CONTROL-FLOW
// guarantee — selection, dependency ordering, bounded-concurrency fan-out with
// the serial fold, the accept gate, and crash recovery by missing-artifact
// query — and fails if that guarantee is removed.

import { describe, expect, it } from "vitest";

import type { FactSnapshot } from "../src/prepass/index.js";
import type { EntityRef, RouteScope, RunModeValue, WikiObject } from "../src/contracts/index.js";
import {
  InMemoryArtifactLedger,
  ObjectRejectedError,
  SourceWikiSelectionError,
  acceptObject,
  artifactKey,
  buildSourceWikiPlan,
  deriveWorkSource,
  orchestrateSourceWiki,
  planSourceWiki,
  selectSourceWikiRoles,
  type AnalystRunner,
  type RunStepInput,
} from "../src/source-wiki/index.js";
import { ANALYST_RUNNER_ROLE_IDS, assertAnalystRunnerCoverage } from "../src/composition/index.js";

const SNAP = `sha256:${"a".repeat(64)}` as const;
const RUN_MODE: RunModeValue = "test-dev";
const SOURCE_LANG = "ja-JP";

// ── a synthetic fact snapshot: two routes, three characters, two terms ──────────
// deriveWorkSource reads only source.bridgeId, orderedUnits (factId/sceneId/
// routeScope), characters, terminology, and routeTopology.sceneDispatchOrder.
function unit(factId: string, sceneId: number, routeId: string) {
  return {
    factId,
    sceneId,
    routeScope: { kind: "route", routeId } as const,
    playReveal: { playOrderIndex: sceneId, revealSceneOrder: null, revealItemOrder: null },
  };
}

function syntheticSnapshot(): FactSnapshot {
  const partial = {
    source: {
      bridgeId: "game-alpha",
      sourceBundleHash: SNAP,
      entryScene: 10,
      structureSchemaVersion: "v2",
    },
    orderedUnits: [
      unit("u-10", 10, "r1"),
      unit("u-11", 11, "r1"),
      unit("u-12", 12, "r2"),
      unit("u-13", 13, "r2"),
    ],
    scenes: [],
    routeTopology: {
      entryScene: 10,
      sceneDispatchOrder: [10, 11, 12, 13],
      edges: [],
      reachableSceneIds: [],
      unreachableSceneIds: [],
      reachableUnitKeys: [],
    },
    characters: [
      {
        factId: "character:c1",
        characterId: "c1",
        totalLines: 1,
        firstSceneId: 10,
        lastSceneId: 10,
        sceneIds: [10],
        linesByScene: [{ sceneId: 10, lineCount: 1 }],
      },
      {
        factId: "character:c2",
        characterId: "c2",
        totalLines: 1,
        firstSceneId: 11,
        lastSceneId: 11,
        sceneIds: [11],
        linesByScene: [{ sceneId: 11, lineCount: 1 }],
      },
      {
        factId: "character:c3",
        characterId: "c3",
        totalLines: 1,
        firstSceneId: 12,
        lastSceneId: 12,
        sceneIds: [12],
        linesByScene: [{ sceneId: 12, lineCount: 1 }],
      },
    ],
    terminology: [
      {
        factId: "term:t-alpha",
        termKey: "t-alpha",
        policyAction: "preserve",
        aliases: ["alpha"],
        occurrenceCount: 1,
        occurrenceUnitKeys: ["u-10"],
      },
      {
        factId: "term:t-beta",
        termKey: "t-beta",
        policyAction: "preserve",
        aliases: ["beta"],
        occurrenceCount: 1,
        occurrenceUnitKeys: ["u-11"],
      },
    ],
    choiceLabels: { totalCount: 0, unitKeys: [] },
    glossaryConflicts: [
      {
        factId: "conflict:t-alpha",
        kind: "policy_action_conflict",
        termKey: "t-alpha",
        detail: "synthetic ambiguity",
      },
    ],
    snapshotId: SNAP,
    contentHash: SNAP,
    schemaVersion: "itotori.fact-snapshot.v1",
  };
  return partial as unknown as FactSnapshot;
}

// ── a recorded runner: one on-target, source-language, cited, stamped object per
//    assigned target. The orchestrator persists it; it is not re-proven here. ──
function claim() {
  return {
    claimId: "claim-0",
    statement: "この作品は一貫した語り口を保つ。",
    scope: { kind: "global" },
    kind: "beat",
    confidence: "high",
    citations: [
      {
        evidenceId: "u-10",
        evidenceHash: SNAP,
        snapshotId: SNAP,
        subject: { kind: "unit", id: "u-10" },
        role: "supports",
        playOrderIndex: 0,
      },
    ],
  };
}

interface ObjectOverrides {
  lang?: string;
  contextScope?: string;
  runMode?: string;
  claims?: unknown[];
  subject?: EntityRef;
  scope?: RouteScope;
  kind?: string;
}

function makeObject(
  kind: string,
  subject: EntityRef,
  scope: RouteScope,
  role: string,
  overrides: ObjectOverrides = {},
): WikiObject {
  return {
    schemaVersion: "itotori.wiki-object.v1",
    objectId: `${kind}:${subject.id}`,
    version: 1,
    lang: overrides.lang ?? SOURCE_LANG,
    subject: overrides.subject ?? subject,
    scope: overrides.scope ?? scope,
    claims: overrides.claims ?? [claim()],
    media: [],
    dependencies: [],
    provisional: false,
    kind: overrides.kind ?? kind,
    body: {},
    provenance: {
      snapshotKind: "context",
      contextSnapshotId: SNAP,
      contextScope: overrides.contextScope ?? "whole-game",
      runMode: overrides.runMode ?? RUN_MODE,
      authorRoleId: role,
    },
  } as unknown as WikiObject;
}

function recordedRunner(): AnalystRunner {
  return async (input) =>
    input.step.targets.map((target) =>
      makeObject(target.kind, target.subject, target.scope, input.role),
    );
}

function baseDeps(overrides: Partial<Parameters<typeof orchestrateSourceWiki>[0]> = {}) {
  return {
    snapshot: syntheticSnapshot(),
    sourceLanguage: SOURCE_LANG,
    runMode: RUN_MODE,
    concurrency: 2,
    runner: recordedRunner(),
    ledger: new InMemoryArtifactLedger(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
describe("clause 1 — default roster is ALL A1-A10 + whole-game context", () => {
  it("PROOF: the default selection is exactly the ten analyst roles", () => {
    const roles = selectSourceWikiRoles().map((s) => s.roleId);
    expect(roles).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"]);
    expect(roles.every((role) => role.startsWith("A"))).toBe(true);
  });

  it("PROOF: the default plan runs all ten analysts under whole-game context", () => {
    const plan = planSourceWiki(syntheticSnapshot());
    expect(plan.roles).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"]);
    expect(plan.contextScope).toBe("whole-game");
    const planned = new Set(plan.phases.flatMap((phase) => phase.roles));
    expect(planned.size).toBe(10);
  });

  it("PROOF: a non-analyst role in the selection is rejected loud (roster is analyst-only)", () => {
    expect(() => selectSourceWikiRoles(["A1", "P1"])).toThrow(SourceWikiSelectionError);
    expect(() => selectSourceWikiRoles(["Q6"])).toThrow(/reviewer/);
  });

  it("maps every selected analyst role to a production runner branch", () => {
    const roles = selectSourceWikiRoles().map((specialist) => specialist.roleId);
    expect(ANALYST_RUNNER_ROLE_IDS).toEqual(roles);
    expect(() => assertAnalystRunnerCoverage(roles)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("clause 2 — A3 serial fold, bounded fan-out, dependency-ordered prerequisites", () => {
  it("PROOF: A4/A9/A5 land on strictly later phases than their factual prerequisites", () => {
    const plan = planSourceWiki(syntheticSnapshot());
    const levelOf = new Map<string, number>();
    for (const phase of plan.phases) for (const role of phase.roles) levelOf.set(role, phase.level);
    // A4 after A3; A9 after A4 and A8; A5 after A3, A4, A8, A9. (manifest DAG)
    expect(levelOf.get("A4")!).toBeGreaterThan(levelOf.get("A3")!);
    expect(levelOf.get("A9")!).toBeGreaterThan(levelOf.get("A4")!);
    expect(levelOf.get("A9")!).toBeGreaterThan(levelOf.get("A8")!);
    for (const up of ["A3", "A4", "A8", "A9"]) {
      expect(levelOf.get("A5")!).toBeGreaterThan(levelOf.get(up)!);
    }
    expect(levelOf.get("A8")!).toBeGreaterThan(levelOf.get("A7")!);
  });

  it("PROOF: bounded concurrency + serial fold — fan-out never exceeds the limit; a route's scenes never overlap", async () => {
    let active = 0;
    let maxActive = 0;
    const laneActive = new Map<string, number>();
    let maxLaneActive = 0;
    const a3Order = new Map<string, number[]>();

    const runner: AnalystRunner = async (input: RunStepInput) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      // The work-ITEM lane: for A3 it is the route (scope); its scenes must not
      // overlap. Single-step items are keyed by subject+scope and trivially ≤1.
      const lk =
        input.role === "A3"
          ? `A3:${JSON.stringify(input.step.scope)}`
          : `${input.role}:${input.step.subject.id}:${JSON.stringify(input.step.scope)}`;
      laneActive.set(lk, (laneActive.get(lk) ?? 0) + 1);
      maxLaneActive = Math.max(maxLaneActive, laneActive.get(lk)!);
      if (input.role === "A3") {
        const list = a3Order.get("game") ?? [];
        list.push(Number(input.step.subject.id));
        a3Order.set("game", list);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      laneActive.set(lk, laneActive.get(lk)! - 1);
      active -= 1;
      return input.step.targets.map((t) => makeObject(t.kind, t.subject, t.scope, input.role));
    };

    const plan = planSourceWiki(syntheticSnapshot());
    const maxItemsInAnyPhase = Math.max(...plan.phases.map((p) => p.items.length));
    expect(maxItemsInAnyPhase).toBeGreaterThan(2); // the fan-out is genuinely wider than the limit

    const report = await orchestrateSourceWiki(baseDeps({ concurrency: 2, runner }));

    // Bounded concurrency: never more than the limit of 2 in flight, and the
    // wide phase actually reached the ceiling.
    expect(maxActive).toBe(2);
    // Serial fold: no route/item ever had two steps in flight at once.
    expect(maxLaneActive).toBe(1);
    // The one whole-game fold is serial in deterministic play order.
    expect(a3Order.get("game")).toEqual([10, 11, 12, 13]);
    expect(report.producedKeys.length).toBeGreaterThan(0);
  });

  it("PROOF: raising the limit raises the observed ceiling (the bound is real, not incidental)", async () => {
    let active = 0;
    let maxActive = 0;
    const runner: AnalystRunner = async (input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return input.step.targets.map((t) => makeObject(t.kind, t.subject, t.scope, input.role));
    };
    await orchestrateSourceWiki(baseDeps({ concurrency: 5, runner }));
    expect(maxActive).toBe(3); // the widest exact-emission phase has three items
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("clause 3 — every accepted object is source-language, cited, route-scoped, stamped", () => {
  const target = {
    kind: "character-bio",
    subject: { kind: "character", id: "c1" } as EntityRef,
    scope: { kind: "global" } as RouteScope,
  };
  const targets = [{ ...target, key: artifactKey(target.kind, target.subject, target.scope) }];
  const stamp = { sourceLanguage: SOURCE_LANG, runMode: RUN_MODE };

  it("PROOF: a well-formed object is accepted with its artifact key", () => {
    const object = makeObject(target.kind, target.subject, target.scope, "A7");
    expect(acceptObject(object, targets, stamp)).toBe(targets[0]!.key);
  });

  it("PROOF: a non-source-language object is rejected", () => {
    const object = makeObject(target.kind, target.subject, target.scope, "A7", { lang: "en-US" });
    expect(() => acceptObject(object, targets, stamp)).toThrow(/not-source-language/);
  });

  it("PROOF: an uncited object is rejected", () => {
    const object = makeObject(target.kind, target.subject, target.scope, "A7", { claims: [] });
    expect(() => acceptObject(object, targets, stamp)).toThrow(/not-cited/);
  });

  it("PROOF: an object not stamped whole-game is rejected", () => {
    const object = makeObject(target.kind, target.subject, target.scope, "A7", {
      contextScope: "external-augmented",
    });
    expect(() => acceptObject(object, targets, stamp)).toThrow(/not-whole-game/);
  });

  it("PROOF: an object stamped with the wrong run mode is rejected", () => {
    const object = makeObject(target.kind, target.subject, target.scope, "A7", {
      runMode: "production",
    });
    expect(() => acceptObject(object, targets, stamp)).toThrow(/wrong-run-mode/);
  });

  it("PROOF: an off-target / off-scope object is rejected", () => {
    const object = makeObject(target.kind, target.subject, { kind: "route", routeId: "r9" }, "A7");
    expect(() => acceptObject(object, targets, stamp)).toThrow(ObjectRejectedError);
  });

  it("PROOF: a full run records only whole-game/source-language/cited objects on-target", async () => {
    const ledger = new InMemoryArtifactLedger();
    await orchestrateSourceWiki(baseDeps({ ledger }));
    const recorded = ledger.recorded();
    expect(recorded.length).toBeGreaterThan(0);
    for (const object of recorded) {
      expect(object.lang).toBe(SOURCE_LANG);
      expect(object.claims.length).toBeGreaterThan(0);
      expect(object.provenance.contextScope).toBe("whole-game");
      expect(object.provenance.runMode).toBe(RUN_MODE);
      expect(["global", "route", "route-set"]).toContain(object.scope.kind);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("clause 4 — recoverable by missing-artifact query (only the gaps fill)", () => {
  it("PROOF: a restart produces ONLY the missing artifacts; a completed phase is never rerun", async () => {
    // The full plan is the ground truth for what a complete Wiki contains.
    const plan = planSourceWiki(syntheticSnapshot());
    const allTargets = plan.phases.flatMap((phase) =>
      phase.items.flatMap((item) => item.steps.flatMap((step) => step.targets)),
    );
    const allKeys = new Set(allTargets.map((t) => t.key));

    // Seed a PARTIAL ledger: everything A1 authored + both A2 term rulings + the
    // r1 A3 fold artifacts. These are the "already done" artifacts (a crash left
    // the rest undone). Seed directly from the plan's own target identities.
    const seed = new InMemoryArtifactLedger();
    const seededTargets = allTargets.filter((t) => {
      const kind = t.kind;
      if (kind === "style-contract" || kind === "term-ruling") return true;
      if (kind === "scene-summary" || kind === "story-so-far") {
        return t.scope.kind === "route" && t.scope.routeId === "r1";
      }
      return false;
    });
    for (const t of seededTargets) seed.seedKey(t.kind, t.subject, t.scope);
    const seededKeys = new Set(seededTargets.map((t) => t.key));
    expect(seededKeys.size).toBeGreaterThan(0);
    expect(seededKeys.size).toBeLessThan(allKeys.size);

    // Re-run against the seeded ledger with an instrumented runner.
    const invokedSteps: string[] = [];
    const rerunRunner: AnalystRunner = async (input) => {
      invokedSteps.push(input.step.stepId);
      return input.step.targets.map((t) => makeObject(t.kind, t.subject, t.scope, input.role));
    };
    const rerun = await orchestrateSourceWiki(baseDeps({ ledger: seed, runner: rerunRunner }));

    // The seeded artifacts are exactly the ones skipped; the produced set is
    // exactly the complement (the gaps) — nothing already-present is rebuilt.
    const rerunProduced = new Set(rerun.producedKeys);
    const expectedGaps = new Set([...allKeys].filter((k) => !seededKeys.has(k)));
    expect(rerunProduced).toEqual(expectedGaps);
    expect(new Set(rerun.skippedKeys)).toEqual(seededKeys);
    // A1 and A2 are COMPLETED phases — their runners are never invoked on restart.
    expect(invokedSteps.some((id) => id.startsWith("A1:"))).toBe(false);
    expect(invokedSteps.some((id) => id.startsWith("A2:"))).toBe(false);
    // The completed prefix of the one A3 fold is skipped; its later scene steps
    // still run and receive the serial prior object through the fold.
    expect(invokedSteps.some((id) => id === "A3:game:scene:10")).toBe(false);
    expect(invokedSteps.some((id) => id === "A3:game:scene:12")).toBe(true);
    // No produced key was already present.
    for (const key of rerunProduced) expect(seededKeys.has(key)).toBe(false);

    // A THIRD run over the now-complete ledger produces nothing at all.
    let thirdCalls = 0;
    const thirdRunner: AnalystRunner = async (input) => {
      thirdCalls += 1;
      return input.step.targets.map((t) => makeObject(t.kind, t.subject, t.scope, input.role));
    };
    const third = await orchestrateSourceWiki(baseDeps({ ledger: seed, runner: thirdRunner }));
    expect(thirdCalls).toBe(0);
    expect(third.producedKeys.length).toBe(0);
  });
});

describe("clause 5 — incomplete best-effort outputs retry without weakening completeness", () => {
  it("retries an applicable shard until its partial outputs cover every assigned target", async () => {
    const callsByStep = new Map<string, number>();
    const runner: AnalystRunner = async (input) => {
      const attempt = (callsByStep.get(input.step.stepId) ?? 0) + 1;
      callsByStep.set(input.step.stepId, attempt);
      const target = input.step.targets[attempt - 1];
      return target === undefined
        ? []
        : [makeObject(target.kind, target.subject, target.scope, input.role)];
    };
    const report = await orchestrateSourceWiki(baseDeps({ roles: ["A3"], runner, maxAttempts: 3 }));
    expect([...callsByStep.values()]).toEqual([2, 2, 2, 2]);
    expect(report.producedKeys).toHaveLength(8);
  });

  it("fails loud only after the bounded retry budget is exhausted", async () => {
    await expect(
      orchestrateSourceWiki(baseDeps({ roles: ["A1"], runner: async () => [], maxAttempts: 2 })),
    ).rejects.toThrow(/after 2 attempts/u);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("work-source derivation wires onto the real fact snapshot", () => {
  it("derives two routes, three characters, one ambiguous term, and the exact A9 intersections", () => {
    const source = deriveWorkSource(syntheticSnapshot());
    expect(source.routes.map((r) => r.routeId)).toEqual(["r1", "r2"]);
    expect(source.routes[0]!.sceneIds).toEqual([10, 11]);
    expect(source.characterIds).toEqual(["c1", "c2", "c3"]);
    expect(source.characterRoutePairs).toEqual([
      { characterId: "c1", routeId: "r1" },
      { characterId: "c2", routeId: "r1" },
      { characterId: "c3", routeId: "r2" },
    ]);
    expect(source.termKeys).toEqual(["t-alpha"]);
    expect(source.adaptationUnits).toEqual([]);
    expect(source.unknownSpeakerUnits).toEqual([]);
  });

  it("plans A5 over the per-character objects it actually authors", () => {
    const plan = buildSourceWikiPlan(syntheticSnapshot());
    const a5Items = plan.phases.flatMap((p) => p.items).filter((i) => i.role === "A5");
    expect(a5Items).toHaveLength(3);
  });
});
