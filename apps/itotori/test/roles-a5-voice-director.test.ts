// A5 Granular Voice Director — mutation-falsifiable proofs over REAL decoded
// bytes. Every clause fails if its guarantee is removed:
//   Clause 1 — a voice profile is ADDRESSABLE by character (base register),
//              counterpart, route, and arc-position range, carrying register /
//              forms / modulation / shifts / confidence / citations that resolve.
//              A5 holds NO web_search grant.
//   Clause 2 — the deterministic lookup resolves the APPLICABLE slice for ANY real
//              dialogue unit; MOST SPECIFIC WINS; the same address always resolves
//              identically.
//   Clause 3 — a more-specific route/counterpart/arc rule is NEVER overwritten by
//              the per-character base (specificity ordering character < route <
//              counterpart/arc-range is proven directly).
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
  addressForUnit,
  assembleVoiceProfile,
  buildA5CallSpec,
  characterIndex,
  characterRouteIds,
  compileVoiceProfile,
  counterpartIds,
  occurrenceWindow,
  readCharacterVoiceEvidence,
  resolveVoice,
  SPECIFICITY_ORDER,
  voiceProfileObjectId,
  voiceProfileRoster,
  voiceSpecificity,
  type A5Context,
  type A5ModelCaller,
  type A5VoiceDraft,
} from "../src/roles/a5/index.js";
import {
  buildClaimFixture,
  unitFactIdAt,
  type FixtureCharacterSpec,
} from "./support/claim-fixture.js";

const CONTEXT: A5Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

/** Two canonical characters seeded into the deterministic index; both occur in the
 * global scene 1, so both are present on the route-a playthrough. nam-22 is a
 * real counterpart nam-11 addresses. */
const CHARACTERS: readonly FixtureCharacterSpec[] = [
  { characterId: "nam-11", decodedLabel: "アイ", lines: 2, boundUnitPlayOrder: 0 },
  { characterId: "nam-22", decodedLabel: "ケイ", lines: 1, boundUnitPlayOrder: 1 },
];

/** Scene 2 is placed on route-a; scene 1 is global, so the route universe is
 * exactly {route-a} and both characters occur on it. */
function fixture() {
  return buildClaimFixture({ characters: CHARACTERS, scene2Routes: ["route-a"] });
}

/** A recorded responder: a base register, one route-scoped counterpart rule per
 * real counterpart, and one route-scoped arc-register shift over the whole window. */
function recordedCaller(): A5ModelCaller {
  return async (request) => {
    const routeId = request.routeIds[0]!;
    const window = request.occurrenceUnitIds;
    return {
      base: { pronoun: "俺", register: "だ・である（素）", tics: ["…"], confidence: "high" },
      counterparts: request.counterpartIds
        .filter((id) => id !== request.evidence.characterId)
        .map((counterpartId) => ({
          counterpartId,
          addressForm: "お前",
          registerDelta: "砕けた",
          scope: { kind: "route" as const, routeId },
          evidenceId: window[0]!,
        })),
      arcPositions: [
        {
          scope: { kind: "route" as const, routeId },
          register: "ですます（丁寧）",
          note: "序盤の距離感",
          fromEvidenceId: window[0]!,
          toEvidenceId: window[window.length - 1]!,
        },
      ],
    };
  };
}

/** Assemble one profile directly with a caller-authored draft, so a single
 * guarantee can be falsified in isolation. */
function assembleOne(
  model: ReturnType<typeof fixture>["model"],
  characterId: string,
  draft: A5VoiceDraft,
) {
  const character = characterIndex(model).find((c) => c.characterId === characterId)!;
  const evidence = readCharacterVoiceEvidence(model, CONTEXT, character);
  return assembleVoiceProfile(model, CONTEXT, evidence, counterpartIds(model), draft);
}

/** A minimal single-counterpart, single-arc draft over nam-11's window. */
function ai11Draft(model: ReturnType<typeof fixture>["model"]): A5VoiceDraft {
  const window = occurrenceWindow(model, characterIndex(model)[0]!.sceneIds).map((u) => u.factId);
  return {
    base: { pronoun: "俺", register: "だ・である（素）", tics: ["…"] },
    counterparts: [
      {
        counterpartId: "nam-22",
        addressForm: "お前",
        registerDelta: "砕けた",
        scope: { kind: "route", routeId: "route-a" },
        evidenceId: window[0]!,
      },
    ],
    arcPositions: [
      {
        scope: { kind: "route", routeId: "route-a" },
        register: "ですます（丁寧）",
        note: "序盤の距離感",
        fromEvidenceId: window[0]!,
        toEvidenceId: window[window.length - 1]!,
      },
    ],
  };
}

describe("clause 1 — voice profiles are addressable by character/counterpart/route/arc-range", () => {
  it("PROOF: the profile carries base register + per-counterpart forms/modulation + arc-range shifts + resolving citations", async () => {
    const { model } = fixture();
    const result = await voiceProfileRoster(model, CONTEXT, recordedCaller());
    // One profile per character in the deterministic index — none skipped.
    expect(result.coveredCharacterIds).toEqual(["nam-11", "nam-22"]);
    const ai = result.profiles.find((p) => p.characterId === "nam-11")!.profile;
    expect(ai.kind).toBe("voice-profile");
    expect(ai.objectId).toBe(voiceProfileObjectId("nam-11"));
    expect(ai.subject).toEqual({ kind: "character", id: "nam-11" });
    // Voice is an analyst interpretation over immutable facts, never a
    // self-accepted fact.  Wiki acceptance may later promote or supersede it.
    expect(ai.provisional).toBe(true);
    const body = ai.kind === "voice-profile" ? ai.body : null;
    // CHARACTER dimension: base register + pronoun.
    expect(body!.base.register).toBe("だ・である（素）");
    expect(body!.base.pronoun).toBe("俺");
    // COUNTERPART dimension: address form (forms) + register delta (modulation), route-scoped.
    const counterpart = body!.perCounterpart[0]!;
    expect(counterpart.counterpartId).toBe("nam-22");
    expect(counterpart.addressForm).toBe("お前");
    expect(counterpart.registerDelta).toBe("砕けた");
    expect(counterpart.scope).toEqual({ kind: "route", routeId: "route-a" });
    // ARC-RANGE dimension: a register shift over a decoded play-order range, route-scoped.
    const arc = body!.perArcPosition[0]!;
    expect(arc.scope).toEqual({ kind: "route", routeId: "route-a" });
    expect(arc.register).toBe("ですます（丁寧）");
    expect(arc.fromPlayOrder).toBeLessThanOrEqual(arc.toPlayOrder);
    // Confidence + citations: every claim carries a confidence and resolves.
    for (const claim of ai.claims) {
      expect(claim.kind).toBe("voice");
      expect(["low", "medium", "high"]).toContain(claim.confidence);
      expect(claim.citations.length).toBeGreaterThanOrEqual(1);
    }
    expect(() => validateWikiObjectClaims(ai, model)).not.toThrow();
  });

  it("PROOF: the arc-range from/to is DECODE-stamped — the model's asserted re-timing is IGNORED", () => {
    const { model } = fixture();
    const window = occurrenceWindow(model, characterIndex(model)[0]!.sceneIds).map((u) => u.factId);
    const profile = assembleOne(model, "nam-11", {
      base: { pronoun: "俺", register: "だ・である（素）", tics: [] },
      counterparts: [],
      arcPositions: [
        {
          scope: { kind: "route", routeId: "route-a" },
          register: "ですます（丁寧）",
          note: "序盤",
          fromEvidenceId: unitFactIdAt(model.factSnapshot, 0),
          toEvidenceId: unitFactIdAt(model.factSnapshot, 2),
          assertedFromPlayOrder: 999,
          assertedToPlayOrder: 1,
        },
      ],
    });
    void window;
    const body = profile.kind === "voice-profile" ? profile.body : null;
    const arc = body!.perArcPosition[0]!;
    // The range is the DECODED play order (0, 2), never the asserted (999, 1).
    expect(arc.fromPlayOrder).toBe(0);
    expect(arc.toPlayOrder).toBe(2);
    expect(() => validateWikiObjectClaims(profile, model)).not.toThrow();
  });

  it("PROOF: A5 holds NO web_search grant — the tool is uncallable from A5 in every surface", () => {
    expect(() => assertRoleAllowed("web_search", "A5")).toThrow(ReadToolError);
    const open: EgressPolicy = { operatorEnabled: true, qualifyingRun: false };
    expect(webEgressAllowed("A5", open)).toBe(false);
    expect(() => assertWebEgressAllowed("A5", open)).toThrow(EgressDeniedError);
    expect(specialistFor("A5").tools).not.toContain("web_search");
    const { model } = fixture();
    const character = characterIndex(model)[0]!;
    const evidence = readCharacterVoiceEvidence(model, CONTEXT, character);
    const window = occurrenceWindow(model, evidence.sceneIds);
    const { spec } = buildA5CallSpec(model, CONTEXT, {
      evidence,
      counterpartIds: counterpartIds(model),
      routeIds: characterRouteIds(model, window),
      occurrenceUnitIds: window.map((u) => u.factId),
      sourceLanguage: model.sourceLanguage,
    });
    expect(spec.tools).toHaveLength(0);
  });

  it("PROOF: an empty character index fails loud (never a silent zero-profile pass)", async () => {
    const { model } = buildClaimFixture();
    await expect(voiceProfileRoster(model, CONTEXT, recordedCaller())).rejects.toThrow(
      /empty-character-index/u,
    );
  });

  it("PROOF: a rule citing a unit outside the occurrence window is REJECTED; an unknown/self counterpart is REJECTED", () => {
    const { model } = fixture();
    const outOfWindow = unitFactIdAt(model.factSnapshot, 3); // a scene-2 unit, not nam-11's
    expect(() =>
      assembleOne(model, "nam-11", {
        base: { pronoun: "俺", register: "素", tics: [] },
        counterparts: [],
        arcPositions: [
          {
            scope: { kind: "route", routeId: "route-a" },
            register: "丁寧",
            note: "x",
            fromEvidenceId: unitFactIdAt(model.factSnapshot, 0),
            toEvidenceId: outOfWindow,
          },
        ],
      }),
    ).toThrow(/unknown-voice-evidence/u);
    expect(() =>
      assembleOne(model, "nam-11", {
        base: { pronoun: "俺", register: "素", tics: [] },
        counterparts: [
          {
            counterpartId: "nam-99",
            addressForm: "お前",
            registerDelta: "砕けた",
            scope: { kind: "global" },
            evidenceId: unitFactIdAt(model.factSnapshot, 0),
          },
        ],
        arcPositions: [],
      }),
    ).toThrow(/unknown-counterpart/u);
    expect(() =>
      assembleOne(model, "nam-11", {
        base: { pronoun: "俺", register: "素", tics: [] },
        counterparts: [
          {
            counterpartId: "nam-11",
            addressForm: "自分",
            registerDelta: "x",
            scope: { kind: "global" },
            evidenceId: unitFactIdAt(model.factSnapshot, 0),
          },
        ],
        arcPositions: [],
      }),
    ).toThrow(/self-counterpart/u);
  });
});

describe("clause 2 — deterministic lookup resolves the applicable slice, most-specific wins", () => {
  it("PROOF (deterministic-lookup-most-specific-wins): an arc rule beats the base for a unit in its range; the same address always resolves identically", () => {
    const { model } = fixture();
    const profile = compileVoiceProfile(assembleOne(model, "nam-11", ai11Draft(model)));
    // A real scene-1 dialogue unit at play order 1, played on route-a.
    const unit = model.factSnapshot.orderedUnits.find((u) => u.playReveal.playOrderIndex === 1)!;
    const address = addressForUnit(unit, {
      characterId: "nam-11",
      playedRouteId: "route-a",
      counterpartId: null,
    });
    const resolved = resolveVoice(profile, address);
    // The MOST SPECIFIC applicable rule governs: the route-scoped arc, NOT the base.
    expect(resolved.tier).toBe("arc-range");
    expect(resolved.specificity).toBe(3);
    expect(resolved.register).toBe("ですます（丁寧）"); // the arc register
    expect(resolved.register).not.toBe("だ・である（素）"); // NOT the per-character base
    expect(resolved.governingRuleId).toBe("voice-profile:nam-11:arc:0");
    // Deterministic: the same address resolves byte-identically on re-lookup.
    expect(resolveVoice(profile, address)).toEqual(resolved);
  });

  it("PROOF: the lookup resolves a typed slice for ANY real dialogue unit, deterministically", () => {
    const { model } = fixture();
    const profile = compileVoiceProfile(assembleOne(model, "nam-11", ai11Draft(model)));
    for (const unit of model.factSnapshot.orderedUnits) {
      const address = addressForUnit(unit, {
        characterId: "nam-11",
        playedRouteId: "route-a",
        counterpartId: "nam-22",
      });
      const resolved = resolveVoice(profile, address);
      expect(resolved.characterId).toBe("nam-11");
      expect(resolved.register.length).toBeGreaterThan(0);
      expect(["character", "route", "counterpart", "arc-range"]).toContain(resolved.tier);
      // Same unit → identical resolution.
      expect(resolveVoice(profile, address)).toEqual(resolved);
    }
  });
});

describe("clause 3 — a specific rule is never shadowed by the per-character base", () => {
  it("PROOF (specific-rule-not-shadowed): a route+counterpart rule governs a unit the base would otherwise cover; the base does NOT overwrite it", () => {
    const { model } = fixture();
    const profile = compileVoiceProfile(assembleOne(model, "nam-11", ai11Draft(model)));
    // A real scene-2 (route-a) unit at play order 3 — OUTSIDE the arc range [0,2],
    // so ONLY the base (per-character) and the counterpart rule apply.
    const unit = model.factSnapshot.orderedUnits.find((u) => u.playReveal.playOrderIndex === 3)!;
    const address = addressForUnit(unit, {
      characterId: "nam-11",
      playedRouteId: "route-a",
      counterpartId: "nam-22",
    });
    const resolved = resolveVoice(profile, address);
    // The specific counterpart rule governs — the per-character base does NOT shadow it.
    expect(resolved.tier).toBe("counterpart");
    expect(resolved.specificity).toBe(3);
    expect(resolved.addressForm).toBe("お前"); // the counterpart form, never null
    expect(resolved.modulation).toBe("砕けた");
    expect(resolved.governingRuleId).toBe("voice-profile:nam-11:counterpart:0");
    // The base register still fills the register field (no arc applies here) — a
    // less-specific field fallback, never an overwrite of the winning rule's tier.
    expect(resolved.register).toBe("だ・である（素）");
    // If the base shadowed the specific rule, tier would be "character" / form null.
    expect(resolved.tier).not.toBe("character");
    expect(resolved.addressForm).not.toBeNull();
  });

  it("PROOF: the specificity ordering is character < route < counterpart/arc-range", () => {
    const character = voiceSpecificity({ pinsRoute: false, dimension: "none" });
    const route = voiceSpecificity({ pinsRoute: true, dimension: "none" });
    const counterpartGlobal = voiceSpecificity({ pinsRoute: false, dimension: "counterpart" });
    const arcGlobal = voiceSpecificity({ pinsRoute: false, dimension: "arc-range" });
    const routeCounterpart = voiceSpecificity({ pinsRoute: true, dimension: "counterpart" });
    expect(character).toBe(0);
    expect(character).toBeLessThan(route);
    expect(route).toBeLessThan(counterpartGlobal);
    expect(route).toBeLessThan(arcGlobal);
    expect(counterpartGlobal).toBeLessThan(routeCounterpart);
    expect(SPECIFICITY_ORDER).toEqual(["character", "route", "counterpart-or-arc-range"]);
  });

  it("PROOF: a reversed arc range (ends before it begins) is REJECTED", () => {
    const { model } = fixture();
    expect(() =>
      assembleOne(model, "nam-11", {
        base: { pronoun: "俺", register: "素", tics: [] },
        counterparts: [],
        arcPositions: [
          {
            scope: { kind: "route", routeId: "route-a" },
            register: "丁寧",
            note: "x",
            fromEvidenceId: unitFactIdAt(model.factSnapshot, 2),
            toEvidenceId: unitFactIdAt(model.factSnapshot, 0),
          },
        ],
      }),
    ).toThrow(/reversed-arc/u);
  });
});
