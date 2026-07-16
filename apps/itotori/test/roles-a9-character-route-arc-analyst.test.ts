// A9 Character-in-Route Arc Analyst — mutation-falsifiable proofs over REAL
// decoded bytes. Every clause fails if its guarantee is removed:
//   Clause 1 — the pair set A9 fans out over EQUALS the deterministic character-
//              by-route intersection EXACTLY: a minor character is not skipped and
//              a fabricated pair is rejected. A9 holds NO web_search grant.
//   Clause 2 — every arc is route-scoped; each state shift carries a from/to
//              PLAY-ORDER RANGE + resolving citations; a shift bounded by a unit
//              outside the decoded occurrence window, or a reversed range, rejects.
//   Clause 3 — play order + route membership are DECODE-derived: the model's
//              asserted re-timing is ignored, and a route the decode never carries
//              can never enter the intersection.
//
// The model boundary is a RECORDED responder (no network, no DB): the assembly is
// deterministic and the guarantees are the module's, not the model's.

import { describe, expect, it } from "vitest";

import { validateWikiObjectClaims } from "../src/wiki/claim-validation.js";
import { assertRoleAllowed, ReadToolError } from "../src/read-tools/index.js";
import {
  EgressDeniedError,
  assertWebEgressAllowed,
  webEgressAllowed,
  type EgressPolicy,
} from "../src/egress/index.js";
import { specialistFor } from "../src/roster/index.js";
import {
  A9RoleError,
  assembleCharacterRouteArc,
  buildA9CallSpec,
  characterIndex,
  characterRouteIntersection,
  pairInIntersection,
  readCharacterRouteEvidence,
  routeArcObjectId,
  routeArcRoster,
  routeOccurrenceWindow,
  routeUniverse,
  type A9Context,
  type A9ModelCaller,
  type A9ShiftDraft,
} from "../src/roles/a9/index.js";
import {
  buildClaimFixture,
  unitFactIdAt,
  type FixtureCharacterSpec,
} from "./support/claim-fixture.js";

const CONTEXT: A9Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

/** Two canonical characters seeded into the deterministic index; nam-22 is a
 * MINOR character (a single line) — the anti-skip witness. Both occur in the
 * global scene 1, so both are present on the route-a playthrough. */
const CHARACTERS: readonly FixtureCharacterSpec[] = [
  { characterId: "nam-11", decodedLabel: "アイ", lines: 2, boundUnitPlayOrder: 0 },
  { characterId: "nam-22", decodedLabel: "ケイ", lines: 1, boundUnitPlayOrder: 1 },
];

/** Scene 2 is placed on route-a; scene 1 is global. The route universe is exactly
 * {route-a}, so the decoded intersection is {(nam-11,route-a),(nam-22,route-a)}. */
function fixture() {
  return buildClaimFixture({ characters: CHARACTERS, scene2Routes: ["route-a"] });
}

/** A recorded responder: one state shift per pair, bounded by the first and last
 * unit of THAT pair's decoded occurrence window. */
function recordedCaller(): A9ModelCaller {
  return async (request) => ({
    shifts: [
      {
        stateBefore: "よそよそしい",
        stateAfter: "打ち解ける",
        fromEvidenceId: request.windowUnitIds[0]!,
        toEvidenceId: request.windowUnitIds[request.windowUnitIds.length - 1]!,
      },
    ],
  });
}

/** Assemble one arc directly for a single pair with a caller-authored shift draft,
 * so a single guarantee can be falsified in isolation. */
function assembleOne(
  model: ReturnType<typeof fixture>["model"],
  characterId: string,
  routeId: string,
  shifts: readonly A9ShiftDraft[],
) {
  const character = characterIndex(model).find((c) => c.characterId === characterId)!;
  const evidence = readCharacterRouteEvidence(model, CONTEXT, character, routeId);
  return assembleCharacterRouteArc(model, CONTEXT, character, evidence, { shifts });
}

describe("clause 1 — the pair set equals the deterministic character-by-route intersection", () => {
  it("PROOF (pair-set-equals-decoded-intersection): coverage equals the decoded intersection exactly; the minor character is NOT skipped", async () => {
    const { model } = fixture();
    // The intersection is decode-derived, not a model count.
    const intersection = characterRouteIntersection(model);
    expect(intersection).toEqual([
      { characterId: "nam-11", routeId: "route-a" },
      { characterId: "nam-22", routeId: "route-a" },
    ]);
    // The roster covers exactly that intersection — no pair added, none dropped.
    const result = await routeArcRoster(model, CONTEXT, recordedCaller());
    expect(result.coveredPairs).toEqual(intersection);
    expect(result.arcs.map((a) => ({ characterId: a.characterId, routeId: a.routeId }))).toEqual(
      intersection,
    );
    // The MINOR character (a single line) is present, not silently skipped.
    expect(result.coveredPairs).toContainEqual({ characterId: "nam-22", routeId: "route-a" });
  });

  it("PROOF: every arc is a route-scoped character-route-arc bound to its subject", async () => {
    const { model } = fixture();
    const result = await routeArcRoster(model, CONTEXT, recordedCaller());
    for (const { characterId, routeId, arc } of result.arcs) {
      expect(arc.kind).toBe("character-route-arc");
      expect(arc.subject).toEqual({ kind: "character", id: characterId });
      expect(arc.scope).toEqual({ kind: "route", routeId });
      expect(arc.objectId).toBe(routeArcObjectId(characterId, routeId));
      expect(arc.lang).toBe(model.sourceLanguage);
      const body = arc.kind === "character-route-arc" ? arc.body : null;
      expect(body!.routeId).toBe(routeId);
      // Every claim on the arc is route-scoped and resolves against the snapshot.
      for (const claim of arc.claims) expect(claim.scope).toEqual({ kind: "route", routeId });
      expect(() => validateWikiObjectClaims(arc, model)).not.toThrow();
    }
  });

  it("PROOF: a fabricated pair (a route the decode never carries) is REJECTED — never authored", () => {
    const { model } = fixture();
    // route-z is not in the decoded route universe, so (nam-11, route-z) is not an
    // intersection and cannot be assembled.
    expect(routeUniverse(model)).toEqual(["route-a"]);
    try {
      assembleOne(model, "nam-11", "route-z", []);
      throw new Error("expected a pair-not-in-intersection failure");
    } catch (error) {
      expect(error).toBeInstanceOf(A9RoleError);
      expect((error as A9RoleError).code).toBe("pair-not-in-intersection");
    }
  });

  it("PROOF: A9 holds NO web_search grant — the tool is uncallable from A9 in every surface", () => {
    expect(() => assertRoleAllowed("web_search", "A9")).toThrow(ReadToolError);
    const open: EgressPolicy = { operatorEnabled: true, qualifyingRun: false };
    expect(webEgressAllowed("A9", open)).toBe(false);
    expect(() => assertWebEgressAllowed("A9", open)).toThrow(EgressDeniedError);
    expect(specialistFor("A9").tools).not.toContain("web_search");
    // The built A9 call spec offers ZERO tools.
    const { model } = fixture();
    const character = characterIndex(model)[0]!;
    const evidence = readCharacterRouteEvidence(model, CONTEXT, character, "route-a");
    const windowUnitIds = routeOccurrenceWindow(model, evidence.sceneIds, "route-a").map(
      (u) => u.factId,
    );
    const { spec } = buildA9CallSpec(model, CONTEXT, {
      evidence,
      windowUnitIds,
      sourceLanguage: model.sourceLanguage,
    });
    expect(spec.tools).toHaveLength(0);
  });

  it("PROOF: an empty character index fails loud (never a silent zero-arc pass)", async () => {
    const { model } = buildClaimFixture();
    await expect(routeArcRoster(model, CONTEXT, recordedCaller())).rejects.toThrow(
      /empty-character-index/u,
    );
  });
});

describe("clause 2 — state shifts carry from/to play-order ranges + resolving citations", () => {
  it("PROOF: a shift carries a decode from/to play-order range and resolving citations", () => {
    const { model, snapshot } = fixture();
    const fromId = unitFactIdAt(snapshot, 0);
    const toId = unitFactIdAt(snapshot, 2);
    const arc = assembleOne(model, "nam-11", "route-a", [
      {
        stateBefore: "よそよそしい",
        stateAfter: "打ち解ける",
        fromEvidenceId: fromId,
        toEvidenceId: toId,
      },
    ]);
    const body = arc.kind === "character-route-arc" ? arc.body : null;
    const shift = body!.shifts[0]!;
    // The range is the decoded play order of the bounding units, and non-reversed.
    expect(shift.fromPlayOrder).toBe(0);
    expect(shift.toPlayOrder).toBe(2);
    expect(shift.fromPlayOrder).toBeLessThanOrEqual(shift.toPlayOrder);
    expect(shift.evidenceIds).toEqual([fromId, toId]);
    // The shift claim cites both bounding units and resolves.
    const shiftClaim = arc.claims.find((c) => c.claimId.endsWith(":shift:0"))!;
    expect(shiftClaim.citations.map((c) => c.evidenceId)).toEqual([fromId, toId]);
    expect(() => validateWikiObjectClaims(arc, model)).not.toThrow();
  });

  it("PROOF: a shift bounded by a unit OUTSIDE the decoded occurrence window is REJECTED", () => {
    const { model, snapshot } = fixture();
    // Unit at play order 3 is a scene-2 (route-a) unit — route-visible, but NOT in
    // nam-11's occurrence scenes, so it is outside the window.
    const outOfWindow = unitFactIdAt(snapshot, 3);
    try {
      assembleOne(model, "nam-11", "route-a", [
        {
          stateBefore: "a",
          stateAfter: "b",
          fromEvidenceId: unitFactIdAt(snapshot, 0),
          toEvidenceId: outOfWindow,
        },
      ]);
      throw new Error("expected an unknown-shift-evidence failure");
    } catch (error) {
      expect(error).toBeInstanceOf(A9RoleError);
      expect((error as A9RoleError).code).toBe("unknown-shift-evidence");
    }
  });

  it("PROOF: a reversed shift (ends before it begins) is REJECTED", () => {
    const { model, snapshot } = fixture();
    try {
      assembleOne(model, "nam-11", "route-a", [
        {
          stateBefore: "a",
          stateAfter: "b",
          fromEvidenceId: unitFactIdAt(snapshot, 2),
          toEvidenceId: unitFactIdAt(snapshot, 0),
        },
      ]);
      throw new Error("expected a reversed-shift failure");
    } catch (error) {
      expect(error).toBeInstanceOf(A9RoleError);
      expect((error as A9RoleError).code).toBe("reversed-shift");
    }
  });
});

describe("clause 3 — play order + route membership are decode-derived", () => {
  it("PROOF (play-order-decode-derived): the model's asserted re-timing is IGNORED; the decode play order is stamped", () => {
    const { model, snapshot } = fixture();
    const fromId = unitFactIdAt(snapshot, 0);
    const toId = unitFactIdAt(snapshot, 2);
    // The model asserts a garbage re-timing; the module must ignore it.
    const arc = assembleOne(model, "nam-11", "route-a", [
      {
        stateBefore: "よそよそしい",
        stateAfter: "打ち解ける",
        fromEvidenceId: fromId,
        toEvidenceId: toId,
        assertedFromPlayOrder: 999,
        assertedToPlayOrder: 1,
      },
    ]);
    const body = arc.kind === "character-route-arc" ? arc.body : null;
    const shift = body!.shifts[0]!;
    // The stamped range is the DECODED play order (0, 2), never the asserted (999, 1).
    expect(shift.fromPlayOrder).toBe(0);
    expect(shift.toPlayOrder).toBe(2);
    // The citations' play order is the decode's too — so validation still passes.
    expect(() => validateWikiObjectClaims(arc, model)).not.toThrow();
  });

  it("PROOF: route membership is decode-derived — a route absent from the decode is never a pair", () => {
    const { model } = fixture();
    const character = characterIndex(model).find((c) => c.characterId === "nam-11")!;
    // route-a is a real decoded route; route-b is not in the universe.
    expect(pairInIntersection(model, character, "route-a")).toBe(true);
    expect(pairInIntersection(model, character, "route-b")).toBe(false);
    expect(characterRouteIntersection(model)).not.toContainEqual({
      characterId: "nam-11",
      routeId: "route-b",
    });
  });
});
