// A8 Relationships and Background Analyst — mutation-falsifiable proofs over REAL
// decoded bytes. Every clause fails if its guarantee is removed:
//   Clause 1 — ONE cited character-background per indexed character, with REAL
//              counterpart ids + claim-level scope; consumed upstream bio + story
//              evidence come through the LOCAL tools; A8 holds NO web_search grant.
//   Clause 2 — every relationship cites an ESTABLISHING same-game scene; a
//              fabricated or unreachable scene is rejected.
//   Clause 3 — route REACHABILITY validates the relationship's scope; an out-of-
//              route or unreachable scope is rejected.
//   Clause 4 — the provenance of every caller-supplied input is verified; a
//              fabricated bio or an unknown counterpart is rejected.
//
// The model boundary is a RECORDED responder (no network, no DB): the assembly is
// deterministic and the guarantees are the module's, not the model's.

import { describe, expect, it, vi } from "vitest";

const localToolCalls = vi.hoisted(
  () => [] as Array<{ readonly tool: string; readonly roleId: string }>,
);

vi.mock("../src/read-tools/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/read-tools/index.js")>();
  return {
    ...actual,
    decodeGetCharacterOccurrences: (
      ...args: Parameters<typeof actual.decodeGetCharacterOccurrences>
    ) => {
      localToolCalls.push({ tool: "decode_get_character_occurrences", roleId: args[1].roleId });
      return actual.decodeGetCharacterOccurrences(...args);
    },
    decodeGetRouteGraph: (...args: Parameters<typeof actual.decodeGetRouteGraph>) => {
      localToolCalls.push({ tool: "decode_get_route_graph", roleId: args[1].roleId });
      return actual.decodeGetRouteGraph(...args);
    },
  };
});

import { validateWikiObjectClaims } from "../src/wiki/claim-validation.js";
import { assertRoleAllowed, ReadToolError } from "../src/read-tools/index.js";
import {
  EgressDeniedError,
  assertWebEgressAllowed,
  webEgressAllowed,
  type EgressPolicy,
} from "../src/egress/index.js";
import { specialistFor } from "../src/roster/index.js";
import type { WikiObject } from "../src/contracts/index.js";
import {
  assembleCharacterBio,
  buildCharacterPortrait,
  characterIndex as a7CharacterIndex,
  readCharacterEvidence as a7ReadEvidence,
  type A7BioDraft,
  type A7Context,
  type A7PortraitProvider,
} from "../src/roles/a7/index.js";
import {
  A8RoleError,
  assembleCharacterBackground,
  backgroundObjectId,
  backgroundRoster,
  buildA8CallSpec,
  characterIndex,
  counterpartIds,
  readCharacterEvidence,
  sceneEvidenceId,
  type A8BackgroundDraft,
  type A8BackgroundRequest,
  type A8Context,
  type A8ModelCaller,
  type A8RelationshipDraft,
} from "../src/roles/a8/index.js";
import { buildClaimFixture, type FixtureCharacterSpec } from "./support/claim-fixture.js";

const CONTEXT: A8Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

const A7_CONTEXT: A7Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

/** Two canonical characters seeded into the deterministic index, each bound to a
 * real scene-1 ordered unit as its whole-game evidence. */
const CHARACTERS: readonly FixtureCharacterSpec[] = [
  { characterId: "nam-11", decodedLabel: "アイ", lines: 2, boundUnitPlayOrder: 0 },
  { characterId: "nam-22", decodedLabel: "ケイ", lines: 1, boundUnitPlayOrder: 1 },
];

/** Scene 2 is placed on route-a (reachable); scene 1 is global (reachable);
 * scene 3 is global but unreachable — the falsifiable topology. */
function fixture() {
  return buildClaimFixture({ characters: CHARACTERS, scene2Routes: ["route-a"] });
}

const portraits: A7PortraitProvider = (characterId) => ({
  status: "available",
  facts: {
    artifactUri: `artifacts/utsushi/runtime/test-run/screenshots/portrait-${characterId}.png`,
    contentHash: `sha256:${(characterId === "nam-11" ? "a" : "b").repeat(64)}`,
    mediaType: "image/png",
    dimensions: { width: 256, height: 256 },
    access: { redaction: "default-redacted", permission: "project-member" },
  },
});

/** Build a genuine upstream A7 bio for one character — the authoritative artifact
 * A8's provenance gate binds against. */
function bioFor(model: ReturnType<typeof fixture>["model"], characterId: string): WikiObject {
  const character = a7CharacterIndex(model).find((c) => c.characterId === characterId)!;
  const evidence = a7ReadEvidence(model, A7_CONTEXT, character);
  const draft: A7BioDraft = {
    storyRole: `${evidence.decodedLabel} は物語を動かす。`,
    definingTraits: ["まっすぐ"],
    notableMomentEvidenceIds: [evidence.notableUnitIds[0]!],
    claims: [],
  };
  return assembleCharacterBio(
    model,
    A7_CONTEXT,
    evidence,
    draft,
    buildCharacterPortrait(characterId, portraits(characterId)),
  );
}

function bioProvider(model: ReturnType<typeof fixture>["model"]) {
  const bios = new Map(CHARACTERS.map((c) => [c.characterId, bioFor(model, c.characterId)]));
  return (characterId: string): WikiObject => bios.get(characterId)!;
}

/** A recorded responder that relates each character to the OTHER one, globally,
 * established by the reachable global scene 1. */
function recordedCaller(): A8ModelCaller {
  return async (request) => {
    const other = request.counterpartIds.find((id) => id !== request.character.characterId)!;
    const relationships: A8RelationshipDraft[] = [
      {
        counterpartId: other,
        relationship: "幼なじみ。",
        confidence: "high",
        scope: { kind: "global" },
        establishingSceneIds: [sceneEvidenceId(1)],
      },
    ];
    return { background: `${request.character.decodedLabel} の生い立ち。`, relationships };
  };
}

/** Assemble one background directly for a single character with a caller-authored
 * relationship draft, so a single guarantee can be falsified in isolation. */
function assembleOne(
  model: ReturnType<typeof fixture>["model"],
  characterId: string,
  relationships: readonly A8RelationshipDraft[],
  bio?: WikiObject,
): WikiObject {
  const character = characterIndex(model).find((c) => c.characterId === characterId)!;
  const evidence = readCharacterEvidence(model, CONTEXT, character);
  const request: A8BackgroundRequest = {
    character: evidence,
    bio: bio ?? bioFor(model, characterId),
    counterpartIds: counterpartIds(model),
    sourceLanguage: model.sourceLanguage,
  };
  const draft: A8BackgroundDraft = { background: "生い立ち。", relationships };
  return assembleCharacterBackground(model, CONTEXT, evidence, request, draft);
}

describe("clause 1 — one cited character-background per indexed character; local-only; no web grant", () => {
  it("PROOF: coverage equals the deterministic index exactly; none skipped", async () => {
    const { model } = fixture();
    const index = characterIndex(model).map((c) => c.characterId);
    const result = await backgroundRoster(model, CONTEXT, recordedCaller(), bioProvider(model));
    expect(result.coveredCharacterIds).toEqual(index);
    expect(result.backgrounds.map((b) => b.characterId)).toEqual(index);
  });

  it("PROOF: every background is a character-background with real counterparts + claim-level scope", async () => {
    const { model } = fixture();
    const realIds = new Set(counterpartIds(model));
    const result = await backgroundRoster(model, CONTEXT, recordedCaller(), bioProvider(model));
    for (const { characterId, background } of result.backgrounds) {
      expect(background.kind).toBe("character-background");
      expect(background.subject).toEqual({ kind: "character", id: characterId });
      expect(background.lang).toBe(model.sourceLanguage);
      expect(background.objectId).toBe(backgroundObjectId(characterId));
      // Analyst output stays provisional until Wiki acceptance promotes it.
      expect(background.provisional).toBe(true);
      // The upstream bio is recorded as a provable dependency edge on its artifact.
      expect(
        background.dependencies.some((d) => d.upstreamObjectId === `character-bio:${characterId}`),
      ).toBe(true);
      const body = background.kind === "character-background" ? background.body : null;
      for (const relationship of body!.relationships) {
        expect(realIds.has(relationship.counterpartId)).toBe(true);
        expect(relationship.scope.kind).toBe("global");
        expect(relationship.establishingEvidenceIds.length).toBeGreaterThan(0);
      }
      // Every claim resolves against the snapshot.
      expect(() => validateWikiObjectClaims(background, model)).not.toThrow();
    }
  });

  it("PROOF: A7 and story inputs traverse A8's local tools, never an egress surface", async () => {
    localToolCalls.length = 0;
    const { model } = fixture();
    await backgroundRoster(model, CONTEXT, recordedCaller(), bioProvider(model));

    expect(localToolCalls).toEqual([
      { tool: "decode_get_character_occurrences", roleId: "A7" },
      { tool: "decode_get_character_occurrences", roleId: "A7" },
      { tool: "decode_get_character_occurrences", roleId: "A8" },
      { tool: "decode_get_route_graph", roleId: "A8" },
      { tool: "decode_get_character_occurrences", roleId: "A8" },
      { tool: "decode_get_character_occurrences", roleId: "A8" },
      { tool: "decode_get_route_graph", roleId: "A8" },
      { tool: "decode_get_character_occurrences", roleId: "A8" },
    ]);
    // The only recorded traversal points are local fact tools; egress remains
    // denied even if an operator opens the general web switch.
    expect(webEgressAllowed("A8", { operatorEnabled: true, qualifyingRun: false })).toBe(false);
    expect(() =>
      assertWebEgressAllowed("A8", { operatorEnabled: true, qualifyingRun: false }),
    ).toThrow(EgressDeniedError);
  });

  it("PROOF: A8 holds NO web_search grant — the tool is uncallable from A8 in every surface", () => {
    // Local read surface: web_search is granted to no role, so A8 is denied.
    expect(() => assertRoleAllowed("web_search", "A8")).toThrow(ReadToolError);
    // Egress boundary: A8 is not the egress role, denied even with the operator switch open.
    const open: EgressPolicy = { operatorEnabled: true, qualifyingRun: false };
    expect(webEgressAllowed("A8", open)).toBe(false);
    expect(() => assertWebEgressAllowed("A8", open)).toThrow(EgressDeniedError);
    // The A8 specialist carries no web_search in its derived tool grant.
    expect(specialistFor("A8").tools).not.toContain("web_search");
    // The built A8 call spec offers ZERO tools.
    const { model } = fixture();
    const character = characterIndex(model)[0]!;
    const evidence = readCharacterEvidence(model, CONTEXT, character);
    const { spec } = buildA8CallSpec(model, CONTEXT, {
      character: evidence,
      bio: bioFor(model, character.characterId),
      counterpartIds: counterpartIds(model),
      sourceLanguage: model.sourceLanguage,
    });
    expect(spec.tools).toHaveLength(0);
  });

  it("PROOF: an empty character index fails loud (never a silent zero-background pass)", async () => {
    const { model } = buildClaimFixture();
    await expect(
      backgroundRoster(model, CONTEXT, recordedCaller(), () => bioFor(model, "nam-11")),
    ).rejects.toThrow(/empty-character-index/u);
  });
});

describe("clause 2 — every relationship cites an establishing same-game scene", () => {
  it("PROOF (establishing-scene-cited): a real reachable scene is accepted and cited with role establishes", () => {
    const { model } = fixture();
    const background = assembleOne(model, "nam-11", [
      {
        counterpartId: "nam-22",
        relationship: "同じ学校に通う。",
        confidence: "high",
        scope: { kind: "global" },
        establishingSceneIds: [sceneEvidenceId(1)],
      },
    ]);
    const body = background.kind === "character-background" ? background.body : null;
    // The body carries the establishing scene evidence id, index-derived.
    expect(body!.relationships[0]!.establishingEvidenceIds).toEqual([sceneEvidenceId(1)]);
    // The relationship claim cites that scene with role "establishes", and resolves.
    const relationshipClaim = background.claims.find((c) => c.kind === "relationship")!;
    const citation = relationshipClaim.citations.find((c) => c.evidenceId === sceneEvidenceId(1))!;
    expect(citation.role).toBe("establishes");
    expect(citation.subject).toEqual({ kind: "scene", id: "1" });
    expect(() => validateWikiObjectClaims(background, model)).not.toThrow();
  });

  it("PROOF: a relationship with NO establishing scene is REJECTED", () => {
    const { model } = fixture();
    try {
      assembleOne(model, "nam-11", [
        {
          counterpartId: "nam-22",
          relationship: "根拠のない仲。",
          confidence: "high",
          scope: { kind: "global" },
          establishingSceneIds: [],
        },
      ]);
      throw new Error("expected a missing-establishing-scene failure");
    } catch (error) {
      expect(error).toBeInstanceOf(A8RoleError);
      expect((error as A8RoleError).code).toBe("missing-establishing-scene");
    }
  });

  it("PROOF: a fabricated / nonexistent establishing scene is REJECTED", () => {
    const { model } = fixture();
    try {
      assembleOne(model, "nam-11", [
        {
          counterpartId: "nam-22",
          relationship: "架空の場面で出会う。",
          confidence: "high",
          scope: { kind: "global" },
          establishingSceneIds: [sceneEvidenceId(999)],
        },
      ]);
      throw new Error("expected an unknown-establishing-scene failure");
    } catch (error) {
      expect(error).toBeInstanceOf(A8RoleError);
      expect((error as A8RoleError).code).toBe("unknown-establishing-scene");
    }
  });

  it("PROOF: an unreachable establishing scene is REJECTED", () => {
    const { model } = fixture();
    try {
      assembleOne(model, "nam-11", [
        {
          counterpartId: "nam-22",
          relationship: "到達不能な場面で出会う。",
          confidence: "high",
          scope: { kind: "global" },
          establishingSceneIds: [sceneEvidenceId(3)],
        },
      ]);
      throw new Error("expected an unreachable-scene failure");
    } catch (error) {
      expect(error).toBeInstanceOf(A8RoleError);
      expect((error as A8RoleError).code).toBe("unreachable-scene");
    }
  });
});

describe("clause 3 — route reachability validates the relationship's scope", () => {
  it("PROOF (route-reachability-validates-scope): a route-scoped relationship reachable on its route is accepted", () => {
    const { model } = fixture();
    const background = assembleOne(model, "nam-11", [
      {
        counterpartId: "nam-22",
        relationship: "route-a でのみ深まる仲。",
        confidence: "high",
        scope: { kind: "route", routeId: "route-a" },
        establishingSceneIds: [sceneEvidenceId(2)],
      },
    ]);
    const body = background.kind === "character-background" ? background.body : null;
    // The relationship keeps its route scope, established by the reachable route-a scene.
    expect(body!.relationships[0]!.scope).toEqual({ kind: "route", routeId: "route-a" });
    expect(body!.relationships[0]!.establishingEvidenceIds).toEqual([sceneEvidenceId(2)]);
    const relationshipClaim = background.claims.find((c) => c.kind === "relationship")!;
    expect(relationshipClaim.scope).toEqual({ kind: "route", routeId: "route-a" });
    expect(() => validateWikiObjectClaims(background, model)).not.toThrow();
  });

  it("PROOF: a route-set relationship reachable on its routes is accepted", () => {
    // Scene 2 spans route-a + route-b → claim-level route-set scope is admissible.
    const { model } = buildClaimFixture({
      characters: CHARACTERS,
      scene2Routes: ["route-a", "route-b"],
    });
    const background = assembleOne(model, "nam-11", [
      {
        counterpartId: "nam-22",
        relationship: "両ルートで並行する絆。",
        confidence: "high",
        scope: { kind: "route-set", routeIds: ["route-a", "route-b"] },
        establishingSceneIds: [sceneEvidenceId(2)],
      },
    ]);
    const body = background.kind === "character-background" ? background.body : null;
    expect(body!.relationships[0]!.scope).toEqual({
      kind: "route-set",
      routeIds: ["route-a", "route-b"],
    });
    expect(body!.relationships[0]!.establishingEvidenceIds).toEqual([sceneEvidenceId(2)]);
    expect(() => validateWikiObjectClaims(background, model)).not.toThrow();
  });

  it("PROOF: an out-of-route establishing scene is REJECTED", () => {
    const { model } = fixture();
    // Scope route-b, but the establishing scene (2) is on route-a — out of route.
    try {
      assembleOne(model, "nam-11", [
        {
          counterpartId: "nam-22",
          relationship: "別ルートの場面で確立と偽る。",
          confidence: "high",
          scope: { kind: "route", routeId: "route-b" },
          establishingSceneIds: [sceneEvidenceId(2)],
        },
      ]);
      throw new Error("expected an out-of-route-scene failure");
    } catch (error) {
      expect(error).toBeInstanceOf(A8RoleError);
      expect((error as A8RoleError).code).toBe("out-of-route-scene");
    }
  });

  it("PROOF: an unreachable route scope is REJECTED", () => {
    const { model } = fixture();
    // Scope route-b is not carried by any reachable scene; the global establishing
    // scene passes compatibility, so the scope-reachability guard is what rejects.
    try {
      assembleOne(model, "nam-11", [
        {
          counterpartId: "nam-22",
          relationship: "到達不能なルート限定の仲。",
          confidence: "high",
          scope: { kind: "route", routeId: "route-b" },
          establishingSceneIds: [sceneEvidenceId(1)],
        },
      ]);
      throw new Error("expected an unreachable-scope failure");
    } catch (error) {
      expect(error).toBeInstanceOf(A8RoleError);
      expect((error as A8RoleError).code).toBe("unreachable-scope");
    }
  });
});

describe("clause 4 — the provenance of every caller-supplied input is verified", () => {
  it("PROOF: a fabricated bio (wrong subject) is REJECTED, never consumed", () => {
    const { model } = fixture();
    // A bio that is really about nam-22, offered as nam-11's — a forged input.
    const forged = bioFor(model, "nam-22");
    try {
      assembleOne(
        model,
        "nam-11",
        [
          {
            counterpartId: "nam-22",
            relationship: "幼なじみ。",
            confidence: "high",
            scope: { kind: "global" },
            establishingSceneIds: [sceneEvidenceId(1)],
          },
        ],
        forged,
      );
      throw new Error("expected an unverified-bio failure");
    } catch (error) {
      expect(error).toBeInstanceOf(A8RoleError);
      expect((error as A8RoleError).code).toBe("unverified-bio");
    }
  });

  it("PROOF: a bio from a DIFFERENT snapshot is REJECTED", () => {
    const { model } = fixture();
    // A genuinely different snapshot (different route topology → different
    // content-addressed id); its bio is bound to that snapshot, not `model`'s.
    const other = buildClaimFixture({ characters: CHARACTERS, scene2Routes: ["route-z"] });
    expect(other.model.snapshotId).not.toBe(model.snapshotId);
    const foreignBio = bioFor(other.model, "nam-11");
    try {
      assembleOne(
        model,
        "nam-11",
        [
          {
            counterpartId: "nam-22",
            relationship: "幼なじみ。",
            confidence: "high",
            scope: { kind: "global" },
            establishingSceneIds: [sceneEvidenceId(1)],
          },
        ],
        foreignBio,
      );
      throw new Error("expected an unverified-bio failure");
    } catch (error) {
      expect(error).toBeInstanceOf(A8RoleError);
      expect((error as A8RoleError).code).toBe("unverified-bio");
    }
  });

  it("PROOF: a relationship to an UNKNOWN counterpart id is REJECTED", () => {
    const { model } = fixture();
    try {
      assembleOne(model, "nam-11", [
        {
          counterpartId: "ghost-999",
          relationship: "存在しない人物との仲。",
          confidence: "high",
          scope: { kind: "global" },
          establishingSceneIds: [sceneEvidenceId(1)],
        },
      ]);
      throw new Error("expected an unknown-counterpart failure");
    } catch (error) {
      expect(error).toBeInstanceOf(A8RoleError);
      expect((error as A8RoleError).code).toBe("unknown-counterpart");
    }
  });

  it("PROOF: a counterpart id poisoned into the request is REJECTED against real character evidence", () => {
    const { model } = fixture();
    const character = characterIndex(model).find((entry) => entry.characterId === "nam-11")!;
    const evidence = readCharacterEvidence(model, CONTEXT, character);
    const request: A8BackgroundRequest = {
      character: evidence,
      bio: bioFor(model, evidence.characterId),
      counterpartIds: [...counterpartIds(model), "ghost-999"],
      sourceLanguage: model.sourceLanguage,
    };
    const draft: A8BackgroundDraft = {
      background: "生い立ち。",
      relationships: [
        {
          counterpartId: "ghost-999",
          relationship: "存在しない人物との仲。",
          confidence: "high",
          scope: { kind: "global" },
          establishingSceneIds: [sceneEvidenceId(1)],
        },
      ],
    };

    try {
      assembleCharacterBackground(model, CONTEXT, evidence, request, draft);
      throw new Error("expected a poisoned-counterpart failure");
    } catch (error) {
      expect(error).toBeInstanceOf(A8RoleError);
      expect((error as A8RoleError).code).toBe("unknown-counterpart");
    }
  });
});
