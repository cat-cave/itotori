// A10 Hindsight Speaker Resolver — the offline, real-bytes proof suite.
//
// A10 examines every unit read through the strict decode surface and emits ONE
// cited, PROVISIONAL speaker-hypothesis per genuinely `parser-unknown` /
// `reader-unknown` unit — refusing any unit the decode already fixed. These
// proofs run on the real-bytes claim fixture (speakers staged per unit), with no
// network and no Postgres, and each falsifies one guarantee:
//   - only genuinely-unknown units are hypothesized (a known-speaker unit refused)
//   - each hypothesis carries candidate / confidence / reveal-scene / scope, cited
//   - A10 is STRUCTURALLY unable to write the decoded speaker fact
//   - a later decode resolution INVALIDATES the hypothesis (never merges)

import type { SpeakerContextV02 } from "@itotori/localization-bridge-schema";
import { describe, expect, it } from "vitest";

import {
  SpeakerHypothesisBodySchema,
  type SpeakerTruth,
  type WikiObject,
} from "../src/contracts/index.js";
import {
  assembleSpeakerHypothesis,
  classifySpeaker,
  invalidateOnDecodeResolution,
  readAllUnitFacts,
  readUnknownSpeakerUnits,
  resolveSpeakers,
  toUnknownSpeakerUnit,
  verifyCandidateCharacter,
  verifyRevealScene,
  type A10Context,
  A10RoleError,
  type A10HypothesisDraft,
  type A10ModelCaller,
  type DecodeResolution,
  type UnknownSpeakerUnit,
} from "../src/roles/a10/index.js";
import {
  buildClaimFixture,
  type ClaimFixtureOptions,
  type FixtureCharacterSpec,
} from "./support/claim-fixture.js";

const CONTEXT: A10Context = {
  runMode: "test-dev",
  contextScope: "whole-game",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

const SCENE_2 = "scene:0002";
const SCENE_999 = "scene:0999";

const CHARACTERS: readonly FixtureCharacterSpec[] = [
  { characterId: "nam-11", decodedLabel: "アイ", lines: 2, boundUnitPlayOrder: 0 },
];

const KNOWN_SPEAKER: SpeakerContextV02 = {
  knowledgeState: "known",
  speakerId: "0190aa11-0000-7000-8000-000000000001",
  displayName: "アイ",
  canonicalNameRef: "nam-11",
  revealState: "revealed",
  textColor: [255, 255, 255],
};
const PARSER_UNKNOWN_SPEAKER: SpeakerContextV02 = {
  knowledgeState: "parser_unknown",
  rawSpeakerText: "？？？",
};
const READER_UNKNOWN_SPEAKER: SpeakerContextV02 = {
  knowledgeState: "reader_unknown",
  speakerId: "0190aa11-0000-7000-8000-000000000002",
  displayName: "アイ",
  readerLabel: "謎の声",
  revealState: "concealed",
  textColor: [10, 20, 30],
};

/** Stage the three speaker truths onto distinct units: scene1#0000 is a decoded
 * KNOWN speaker (must be refused); scene1#0001 is READER-unknown and scene2#0000
 * is PARSER-unknown (both hypothesized); the rest stay narration. */
function fixtureOptions(): ClaimFixtureOptions {
  return {
    characters: CHARACTERS,
    unitSpeakers: new Map<string, SpeakerContextV02>([
      ["reallive:scene-0001#0000", KNOWN_SPEAKER],
      ["reallive:scene-0001#0001", READER_UNKNOWN_SPEAKER],
      ["reallive:scene-0002#0000", PARSER_UNKNOWN_SPEAKER],
    ]),
  };
}

function fixture() {
  return buildClaimFixture(fixtureOptions());
}

/** The recorded model: a fixed hypothesis draft naming the seeded candidate and a
 * real reveal scene. Assembly re-resolves and re-cites, so the draft is untrusted. */
function recordedCaller(draft?: Partial<A10HypothesisDraft>): A10ModelCaller {
  return async (request) => ({
    candidateCharacterId: "nam-11",
    confidence: "medium",
    revealSceneId: SCENE_2,
    rationale: `${request.unit.revealSafeLabel} の正体はアイだと後の場面から推測できる。`,
    ...draft,
  });
}

describe("A10 hypothesizes only genuinely-unknown speakers", () => {
  it("PROOF: a known-speaker unit is refused, and every unknown unit is hypothesized", async () => {
    const { model } = fixture();

    // The decode surface classifies each unit; only the two unknown ones qualify.
    const units = readAllUnitFacts(model, CONTEXT);
    const knownUnit = units.find((u) => classifySpeaker(u.value.speaker) === "known");
    expect(knownUnit).toBeDefined();
    // Structural refusal: A10 cannot be forced to hypothesize a decoded speaker.
    expect(() => toUnknownSpeakerUnit(knownUnit!)).toThrowError(A10RoleError);
    try {
      toUnknownSpeakerUnit(knownUnit!);
    } catch (error) {
      expect((error as A10RoleError).code).toBe("known-speaker");
    }

    const unknown = readUnknownSpeakerUnits(model, CONTEXT);
    expect(unknown.map((u) => u.speakerStatus).sort()).toEqual([
      "parser-unknown",
      "reader-unknown",
    ]);

    const result = await resolveSpeakers(model, CONTEXT, recordedCaller());
    // One hypothesis per unknown unit — none for the known unit.
    expect(result.hypotheses).toHaveLength(2);
    expect(result.hypothesizedUnitIds).not.toContain(knownUnit!.value.unitId);
    for (const { hypothesis } of result.hypotheses) {
      expect(hypothesis.kind).toBe("speaker-hypothesis");
    }
  });

  it("PROOF: each hypothesis carries candidate / confidence / reveal-scene / scope, all cited", async () => {
    const { model } = fixture();
    const result = await resolveSpeakers(model, CONTEXT, recordedCaller({ confidence: "high" }));
    const first = result.hypotheses[0]!.hypothesis;
    expect(first.kind).toBe("speaker-hypothesis");
    if (first.kind !== "speaker-hypothesis") throw new Error("unreachable");
    expect(first.body.candidateCharacterId).toBe("nam-11");
    expect(first.body.confidence).toBe("high");
    expect(first.body.revealSceneId).toBe(SCENE_2);
    // Scope is the unit's route scope; the single claim cites unit + candidate +
    // reveal-scene evidence, and it survived the claim-validation gate on assembly.
    expect(first.scope).toEqual({ kind: "global" });
    expect(first.claims).toHaveLength(1);
    expect(first.claims[0]!.kind).toBe("speaker-hypothesis");
    expect(first.claims[0]!.citations.map((c) => c.role).sort()).toEqual([
      "reveal",
      "supports",
      "supports",
    ]);
  });

  it("PROOF: a model candidate absent from the decoded index is rejected", async () => {
    const { model } = fixture();
    await expect(
      resolveSpeakers(model, CONTEXT, recordedCaller({ candidateCharacterId: "ghost-99" })),
    ).rejects.toThrowError(/unknown-candidate/u);
  });

  it("PROOF: a model reveal scene absent from the route graph is rejected", async () => {
    const { model } = fixture();
    await expect(
      resolveSpeakers(model, CONTEXT, recordedCaller({ revealSceneId: SCENE_999 })),
    ).rejects.toThrowError(/unknown-reveal-scene/u);
  });
});

describe("A10 is structurally unable to write the decoded speaker fact", () => {
  it("PROOF: the only emitted object is a PROVISIONAL speaker-hypothesis, never a decoded fact", async () => {
    const { model } = fixture();
    const result = await resolveSpeakers(model, CONTEXT, recordedCaller());
    for (const { hypothesis } of result.hypotheses) {
      // A hypothesis, never a settled fact.
      expect(hypothesis.kind).toBe("speaker-hypothesis");
      expect(hypothesis.provisional).toBe(true);
      expect(hypothesis.provenance.authorRoleId).toBe("A10");
    }
  });

  it("PROOF: the speaker-hypothesis body type has NO field for an authoritative decoded speaker", () => {
    // The body carries only a CANDIDATE + confidence. Attempting to smuggle an
    // authoritative decoded-speaker attribution into it fails the strict schema,
    // so no code path — model-driven or hand-authored — can encode a decoded fact.
    const hypothesisBody = {
      unitId: "unit-x",
      candidateCharacterId: "nam-11",
      confidence: "high" as const,
      revealSceneId: SCENE_2,
    };
    expect(() => SpeakerHypothesisBodySchema.parse(hypothesisBody)).not.toThrow();
    const withDecodedFact = {
      ...hypothesisBody,
      resolvedDisplayName: "アイ",
      canonicalCharacterId: "nam-11",
    };
    expect(() => SpeakerHypothesisBodySchema.parse(withDecodedFact)).toThrow();
  });

  it("PROOF: assembling a hypothesis for a decoded (known) speaker unit is refused", () => {
    const { model } = fixture();
    const known = readAllUnitFacts(model, CONTEXT).find(
      (u) => classifySpeaker(u.value.speaker) === "known",
    )!;
    // There is no UnknownSpeakerUnit for a known speaker: the narrowing refuses it,
    // so `assembleSpeakerHypothesis` can never be reached with a decoded speaker.
    expect(() => toUnknownSpeakerUnit(known)).toThrowError(/known-speaker/u);
  });
});

describe("A10: a later decode resolution invalidates the hypothesis (never merges)", () => {
  function hypothesisFor(status: "parser-unknown" | "reader-unknown"): {
    model: ReturnType<typeof buildClaimFixture>["model"];
    hypothesis: WikiObject;
    unit: UnknownSpeakerUnit;
  } {
    const { model } = fixture();
    const unit = readUnknownSpeakerUnits(model, CONTEXT).find((u) => u.speakerStatus === status)!;
    const occ = verifyCandidateCharacter(model, CONTEXT, "nam-11");
    const node = verifyRevealScene(model, CONTEXT, SCENE_2);
    const hypothesis = assembleSpeakerHypothesis(
      model,
      CONTEXT,
      unit,
      {
        candidateCharacterId: "nam-11",
        confidence: "medium",
        revealSceneId: SCENE_2,
        rationale: "推測。",
      },
      occ,
      node,
    );
    return { model, hypothesis, unit };
  }

  const decodedSpeaker = (characterId: string): Extract<SpeakerTruth, { status: "known" }> => ({
    status: "known",
    rawName: "アイ",
    resolvedDisplayName: "アイ",
    revealSafeLabel: "アイ",
    canonicalCharacterId: characterId,
    color: { red: 1, green: 2, blue: 3 },
  });

  it("PROOF: a decode resolution invalidates the hypothesis — even when the candidate matched", () => {
    const { hypothesis, unit } = hypothesisFor("reader-unknown");
    const resolution: DecodeResolution = {
      unitId: unit.unitId,
      resolvedSpeaker: decodedSpeaker("nam-11"),
    };
    const outcome = invalidateOnDecodeResolution(hypothesis, resolution);
    // Discarded, not merged: the outcome is invalidation, the decoded id comes from
    // the decode, and a matching candidate is only recorded — never folded in.
    expect(outcome.outcome).toBe("invalidated");
    expect(outcome.decodedCharacterId).toBe("nam-11");
    expect(outcome.hypothesizedCandidateId).toBe("nam-11");
    expect(outcome.candidateMatchedDecode).toBe(true);
    expect(outcome.invalidatedObjectId).toBe(hypothesis.objectId);
  });

  it("PROOF: a decode resolution to a DIFFERENT character still invalidates (decode wins)", () => {
    const { hypothesis, unit } = hypothesisFor("parser-unknown");
    const outcome = invalidateOnDecodeResolution(hypothesis, {
      unitId: unit.unitId,
      resolvedSpeaker: decodedSpeaker("nam-99"),
    });
    expect(outcome.outcome).toBe("invalidated");
    // The decoded fact stands alone; the hypothesis candidate is NOT carried into it.
    expect(outcome.decodedCharacterId).toBe("nam-99");
    expect(outcome.candidateMatchedDecode).toBe(false);
  });

  it("PROOF: a resolution for a different unit, or one that is still unknown, is refused", () => {
    const { hypothesis, unit } = hypothesisFor("parser-unknown");
    expect(() =>
      invalidateOnDecodeResolution(hypothesis, {
        unitId: `${unit.unitId}-other`,
        resolvedSpeaker: decodedSpeaker("nam-11"),
      }),
    ).toThrowError(/resolution-mismatch/u);
    expect(() =>
      invalidateOnDecodeResolution(hypothesis, {
        unitId: unit.unitId,
        // A "resolution" that is still unknown is not a decode resolution at all.
        resolvedSpeaker: { status: "parser-unknown" } as unknown as Extract<
          SpeakerTruth,
          { status: "known" }
        >,
      }),
    ).toThrowError(/unresolved-decode/u);
  });
});
