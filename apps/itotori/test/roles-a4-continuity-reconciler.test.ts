// A4 Continuity and Lore Reconciler — mutation-falsifiable proofs over REAL
// decoded bytes. Every clause of the role fails if its guarantee is removed:
//
//   Clause 1 — A4 ADOPTS the final progressive story-so-far as the route spine
//              and never reconstructs topology (the adopted coverage must equal
//              the decode's dispatch order).
//   Clause 2 — it emits route-scoped route-arc / callback / foreshadow /
//              relationship-delta claims with PAIRED resolvable endpoints and a
//              DETERMINISTIC reveal order.
//   Clause 3 — origins PRECEDE callbacks (play order), decode FACTS settle a
//              contradicting timeline, and unknown / partial edges stay EXPLICIT
//              (never invented).
//
// The model boundary is a RECORDED responder (no network, no DB): the
// reconciliation is deterministic and the guarantees are the module's.

import { describe, expect, it } from "vitest";

import { ClaimValidationError } from "../src/wiki/claim-validation.js";
import {
  citeableSceneUnits,
  foldRoute,
  type A3Context,
  type A3ModelCaller,
  type A3SceneNarrative,
} from "../src/roles/a3/index.js";
import {
  assembleRouteArc,
  reconcileRoute,
  type A4ArcDraft,
  type A4Context,
  type A4ModelCaller,
  type A4RouteSpine,
  type ResolvedArc,
} from "../src/roles/a4/index.js";
import { ROSTER, toolsForRole, validateRosterManifest } from "../src/roster/index.js";
import { buildClaimFixture, unitFactIdAt } from "./support/claim-fixture.js";

const A3_CONTEXT: A3Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

const A4_CONTEXT: A4Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

/** A recorded A3 responder that cites the scene's own first unit, so a genuine
 * final story-so-far object exists for A4 to adopt as the spine. */
function a3Recorded(): A3ModelCaller {
  return async (request) => {
    const anchor = citeableSceneUnits(request.scene)[0]!.label;
    const narrative: A3SceneNarrative = {
      beat: "けいこは決断する。",
      subtext: "静かな決意。",
      sceneOpenThreads: [],
      sceneClaims: [
        { statement: "導入。", kind: "beat", confidence: "high", evidenceUnitIds: [anchor] },
      ],
      storySummary: `シーン${request.scene.sceneId}までの物語。`,
      storyOpenThreads: ["未解決の伏線"],
      storyClaims: [
        {
          statement: "一貫。",
          kind: "story-so-far",
          confidence: "medium",
          evidenceUnitIds: [anchor],
        },
      ],
    };
    return narrative;
  };
}

async function buildSpine(
  model: ReturnType<typeof buildClaimFixture>["model"],
): Promise<A4RouteSpine> {
  const result = await foldRoute(model, A3_CONTEXT, a3Recorded());
  return { finalStorySoFar: result.finalStorySoFar, coveredSceneIds: result.coveredSceneIds };
}

function a4Recorded(draft: A4ArcDraft): A4ModelCaller {
  return async () => draft;
}

describe("clause 1 — A4 adopts the spine and never reconstructs topology", () => {
  it("PROOF: the registered A4 specialist is an immutable analyst with the RB-025 validator/tools", () => {
    const a4 = validateRosterManifest(Object.values(ROSTER)).A4;
    expect(a4).toBe(ROSTER.A4);
    expect(a4.shape).toBe("analyst");
    expect(Object.isFrozen(a4)).toBe(true);
    expect([...a4.tools]).toEqual([...toolsForRole("A4")]);
    expect(a4.validate(undefined)).not.toHaveLength(0);
  });

  it("PROOF: reconciliation adopts the final story-so-far — the arc depends on it", async () => {
    const { model } = buildClaimFixture();
    const spine = await buildSpine(model);
    const result = await reconcileRoute(
      model,
      A4_CONTEXT,
      spine,
      a4Recorded({
        arcSummary: "ルートの弧。",
        callbacks: [],
        foreshadows: [],
        relationshipDeltas: [],
      }),
    );
    // The route-arc carries a provable dependency edge back to the adopted spine.
    expect(result.spineObjectId).toBe(spine.finalStorySoFar.objectId);
    const deps = result.routeArc.dependencies.map((d) => d.upstreamObjectId);
    expect(deps).toContain(spine.finalStorySoFar.objectId);
    expect(result.routeArc.kind).toBe("route-arc");
  });

  it("PROOF: a spine whose coverage diverges from the dispatch order FAILS", async () => {
    const { model } = buildClaimFixture();
    const spine = await buildSpine(model);
    // Reorder the covered scenes — the signature of a reconstructed topology.
    const tampered: A4RouteSpine = { ...spine, coveredSceneIds: [2, 1] };
    await expect(
      reconcileRoute(
        model,
        A4_CONTEXT,
        tampered,
        a4Recorded({
          arcSummary: "x",
          callbacks: [],
          foreshadows: [],
          relationshipDeltas: [],
        }),
      ),
    ).rejects.toThrow(/spine-topology-mismatch/);
  });

  it("PROOF: a spine that is not a story-so-far object FAILS", async () => {
    const { model } = buildClaimFixture();
    const spine = await buildSpine(model);
    const notStory = {
      ...spine.finalStorySoFar,
      kind: "scene-summary",
    } as typeof spine.finalStorySoFar;
    await expect(
      reconcileRoute(
        model,
        A4_CONTEXT,
        { ...spine, finalStorySoFar: notStory },
        a4Recorded({
          arcSummary: "x",
          callbacks: [],
          foreshadows: [],
          relationshipDeltas: [],
        }),
      ),
    ).rejects.toThrow(/spine-not-story-so-far/);
  });

  it("PROOF: an intermediate story cannot masquerade as the final route spine", async () => {
    const { model } = buildClaimFixture();
    const spine = await buildSpine(model);
    const stale = {
      ...spine.finalStorySoFar,
      body: { ...spine.finalStorySoFar.body, throughSceneId: "1" },
    } as typeof spine.finalStorySoFar;
    await expect(
      reconcileRoute(
        model,
        A4_CONTEXT,
        { ...spine, finalStorySoFar: stale },
        a4Recorded({
          arcSummary: "x",
          callbacks: [],
          foreshadows: [],
          relationshipDeltas: [],
        }),
      ),
    ).rejects.toThrow(/spine-final-scene-mismatch/);
  });
});

describe("clause 2 — route-scoped claims, paired resolvable endpoints, deterministic order", () => {
  it("PROOF: every callback claim carries the route scope and TWO resolvable citations", async () => {
    const { model, snapshot } = buildClaimFixture();
    const spine = await buildSpine(model);
    const origin = unitFactIdAt(snapshot, 0);
    const destination = unitFactIdAt(snapshot, 3);
    const result = await reconcileRoute(
      model,
      A4_CONTEXT,
      spine,
      a4Recorded({
        arcSummary: "弧。",
        callbacks: [
          {
            description: "後の場面が最初の決断を呼び戻す。",
            originEvidenceId: origin,
            destinationEvidenceId: destination,
          },
        ],
        foreshadows: [],
        relationshipDeltas: [],
      }),
    );
    const claim = result.routeArc.claims.find((c) => c.kind === "callback")!;
    expect(claim.scope).toEqual(result.routeScope);
    expect(claim.citations.map((c) => c.evidenceId)).toEqual([origin, destination]);
    expect(claim.citations).toHaveLength(2);
    // Both endpoints are present in the body link as a paired edge.
    const link = result.routeArc.kind === "route-arc" ? result.routeArc.body.callbacks[0]! : null;
    expect(link?.originEvidenceId).toBe(origin);
    expect(link?.destinationEvidenceId).toBe(destination);
    // Analyst claims are cited hypotheses, not promoted decode facts.
    expect(result.routeArc.provisional).toBe(true);
    const routeSummary = result.routeArc.claims.find((candidate) => candidate.kind === "arc")!;
    expect(routeSummary.scope).toEqual(result.routeScope);
    expect(routeSummary.citations.length).toBeGreaterThan(0);
  });

  it("PROOF: reveal order is DETERMINISTIC by play order, not model emission order", async () => {
    const { model, snapshot } = buildClaimFixture();
    const spine = await buildSpine(model);
    const early = {
      originEvidenceId: unitFactIdAt(snapshot, 0),
      destinationEvidenceId: unitFactIdAt(snapshot, 3),
      description: "早い呼び戻し。",
    };
    const late = {
      originEvidenceId: unitFactIdAt(snapshot, 1),
      destinationEvidenceId: unitFactIdAt(snapshot, 4),
      description: "遅い呼び戻し。",
    };
    // Fed in REVERSE play order; the module must re-order by play order.
    const result = await reconcileRoute(
      model,
      A4_CONTEXT,
      spine,
      a4Recorded({
        arcSummary: "弧。",
        callbacks: [late, early],
        foreshadows: [],
        relationshipDeltas: [],
      }),
    );
    const bodyOrigins =
      result.routeArc.kind === "route-arc"
        ? result.routeArc.body.callbacks.map((l) => l.originEvidenceId)
        : [];
    expect(bodyOrigins).toEqual([early.originEvidenceId, late.originEvidenceId]);
    expect(result.revealOrder).toEqual(["callback:global:0", "callback:global:1"]);
    const persistedOrder =
      result.routeArc.kind === "route-arc" ? result.routeArc.body.revealOrder : [];
    expect(persistedOrder).toEqual(result.revealOrder);
  });

  it("PROOF: relationship-delta claim order is also derived from decoded play order", async () => {
    const { model, snapshot } = buildClaimFixture();
    const spine = await buildSpine(model);
    const result = await reconcileRoute(
      model,
      A4_CONTEXT,
      spine,
      a4Recorded({
        arcSummary: "弧。",
        callbacks: [],
        foreshadows: [],
        // Intentionally reversed relative to their decoded endpoint ranges.
        relationshipDeltas: [
          {
            counterpartId: "late",
            before: "遠い",
            after: "近い",
            fromEvidenceId: unitFactIdAt(snapshot, 1),
            toEvidenceId: unitFactIdAt(snapshot, 4),
          },
          {
            counterpartId: "early",
            before: "他人",
            after: "友人",
            fromEvidenceId: unitFactIdAt(snapshot, 0),
            toEvidenceId: unitFactIdAt(snapshot, 3),
          },
        ],
      }),
    );
    const deltas =
      result.routeArc.kind === "route-arc" ? result.routeArc.body.relationshipDeltas : [];
    expect(deltas.map((delta) => delta.counterpartId)).toEqual(["early", "late"]);
    expect(result.routeArc.claims.filter((claim) => claim.kind === "relationship")).toHaveLength(2);
  });

  it("PROOF: a citation OUTSIDE the visible snapshot FAILS the claim gate", async () => {
    const { model, snapshot } = buildClaimFixture();
    const spine = await buildSpine(model);
    const arc: ResolvedArc = {
      arcSummary: "弧。",
      callbacks: [
        {
          linkId: "callback:global:0",
          description: "存在しない終点を引く。",
          originEvidenceId: unitFactIdAt(snapshot, 0),
          destinationEvidenceId: "unit:ghost-does-not-exist",
          originPlayOrder: 0,
          destinationPlayOrder: 5,
          confidence: "high",
        },
      ],
      foreshadows: [],
      relationshipDeltas: [],
      revealHorizon: 5,
    };
    try {
      assembleRouteArc(model, A4_CONTEXT, spine.finalStorySoFar.scope, arc, {
        objectId: spine.finalStorySoFar.objectId,
        version: spine.finalStorySoFar.version,
        evidenceIds: [unitFactIdAt(snapshot, 0)],
      });
      throw new Error("expected an unresolvable-citation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ClaimValidationError);
      expect((error as ClaimValidationError).code).toBe("evidence-unresolvable");
    }
  });
});

describe("clause 3 — origins precede callbacks, facts dominate, unknown edges explicit", () => {
  it("PROOF: an origin that does NOT play before its use FAILS (origin-not-before-callback)", async () => {
    const { model, snapshot } = buildClaimFixture();
    const spine = await buildSpine(model);
    // Origin plays at 3, the "use" at 0 — a reversed chronology.
    await expect(
      reconcileRoute(
        model,
        A4_CONTEXT,
        spine,
        a4Recorded({
          arcSummary: "弧。",
          callbacks: [
            {
              description: "逆転した呼び戻し。",
              originEvidenceId: unitFactIdAt(snapshot, 3),
              destinationEvidenceId: unitFactIdAt(snapshot, 0),
            },
          ],
          foreshadows: [],
          relationshipDeltas: [],
        }),
      ),
    ).rejects.toThrow(/origin-not-before-callback/);
  });

  it("PROOF: a decode FACT dominates a model's contradicting relationship timeline", async () => {
    const { model, snapshot } = buildClaimFixture();
    const spine = await buildSpine(model);
    const early = unitFactIdAt(snapshot, 0); // decoded play order 0
    const late = unitFactIdAt(snapshot, 3); // decoded play order 3
    // The model asserts a REVERSED, fabricated timeline: from=999, to=0, and
    // even cites the endpoints in the wrong direction (from=late, to=early).
    const result = await reconcileRoute(
      model,
      A4_CONTEXT,
      spine,
      a4Recorded({
        arcSummary: "弧。",
        callbacks: [],
        foreshadows: [],
        relationshipDeltas: [
          {
            counterpartId: "char-a",
            before: "他人",
            after: "友人",
            fromEvidenceId: late,
            toEvidenceId: early,
            assertedFromPlayOrder: 999,
            assertedToPlayOrder: 0,
          },
        ],
      }),
    );
    const delta =
      result.routeArc.kind === "route-arc" ? result.routeArc.body.relationshipDeltas[0]! : null;
    // The emitted chronology is the DECODE's play order (0 → 3), not the model's.
    expect(delta?.fromPlayOrder).toBe(0);
    expect(delta?.toPlayOrder).toBe(3);
    expect(delta?.fromPlayOrder).not.toBe(999);
  });

  it("PROOF: a partial edge (missing endpoint) stays EXPLICIT and is never invented", async () => {
    const { model, snapshot } = buildClaimFixture();
    const spine = await buildSpine(model);
    const result = await reconcileRoute(
      model,
      A4_CONTEXT,
      spine,
      a4Recorded({
        arcSummary: "弧。",
        callbacks: [
          {
            description: "終点が欠けた辺。",
            originEvidenceId: unitFactIdAt(snapshot, 0),
            destinationEvidenceId: null,
          },
        ],
        foreshadows: [],
        relationshipDeltas: [],
      }),
    );
    // The unpaired edge is surfaced explicitly, never sealed into the arc.
    expect(result.unresolvedEdges).toHaveLength(1);
    expect(result.unresolvedEdges[0]!.gap).toBe("missing-endpoint");
    expect(result.unresolvedEdges[0]!.destinationEvidenceId).toBeNull();
    const bodyCallbacks =
      result.routeArc.kind === "route-arc" ? result.routeArc.body.callbacks : [];
    expect(bodyCallbacks).toHaveLength(0);
    expect(result.routeArc.claims.filter((c) => c.kind === "callback")).toHaveLength(0);
    const persistedUnknowns =
      result.routeArc.kind === "route-arc" ? result.routeArc.body.unresolvedEdges : [];
    expect(persistedUnknowns).toEqual(result.unresolvedEdges);
  });

  it("PROOF: an edge citing an UNRESOLVABLE endpoint stays explicit, never fabricated", async () => {
    const { model, snapshot } = buildClaimFixture();
    const spine = await buildSpine(model);
    const result = await reconcileRoute(
      model,
      A4_CONTEXT,
      spine,
      a4Recorded({
        arcSummary: "弧。",
        callbacks: [],
        foreshadows: [
          {
            description: "解決不能な終点。",
            originEvidenceId: unitFactIdAt(snapshot, 0),
            destinationEvidenceId: "unit:ghost",
          },
        ],
        relationshipDeltas: [],
      }),
    );
    expect(result.unresolvedEdges[0]!.gap).toBe("unresolvable-endpoint");
    const bodyForeshadows =
      result.routeArc.kind === "route-arc" ? result.routeArc.body.foreshadows : [];
    expect(bodyForeshadows).toHaveLength(0);
  });
});
