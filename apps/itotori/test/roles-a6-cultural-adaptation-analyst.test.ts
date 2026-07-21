// Cultural Adaptation Analyst — mutation-falsifiable proofs. Each clause below
// fails if its guarantee is removed.
//
// Clause 1 (runs over EXACTLY the flagged set; no per-line fan-out): the
//   deterministic pre-pass flags exactly the culture/dialect/honorific/wordplay
//   units and hides the plain lines; the whole-run dispatches once per flagged
//   unit and never for an unflagged one (an unflagged unit has no recorded
//   anchor, so touching it would throw).
// Clause 2 (function + bounded options, never a replacement translation): a note
//   is a SOURCE-language object with a communicative function and ≥1 bounded
//   option carrying tradeoffs, with NO replacement/target field — a
//   target-language object and an option with no tradeoffs are both rejected.
// Clause 3 (every note maps to a real unit; byte-derived flag): the flag's
//   markers are copied from the decoded source text (an invented marker is
//   rejected), a note mapping to the wrong unit is rejected, and a note citing a
//   unit that is not in the snapshot is rejected by claim validation.

import type { BridgeBundleV02, BridgeSpanV02 } from "@itotori/localization-bridge-schema";
import { describe, expect, it } from "vitest";

import {
  CALL_RESULT_SCHEMA_VERSION,
  CallResultSchema,
  WIKI_OBJECT_SCHEMA_VERSION,
  type Citation,
  type WikiObject,
} from "../src/contracts/index.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import { ClaimValidationError } from "../src/wiki/claim-validation.js";
import { buildEvidenceIndex } from "../src/wiki/evidence-index.js";
import {
  AdaptationAnalystError,
  AdaptationEvidenceError,
  assertNoteIsFunctionAndOptions,
  candidateAnchor,
  flaggedAdaptationCandidates,
  inlineAdaptationPromptStore,
  isFlaggedUnit,
  recordedAdaptationModel,
  recordedAdaptationModelByAnchor,
  runAdaptationAnalyst,
  runAdaptationNote,
  type AdaptationRequest,
  type FlaggedAdaptationCandidate,
} from "../src/roles/a6/index.js";
import { buildClaimFixture } from "./support/claim-fixture.js";

const HASH = (c: string): `sha256:${string}` => `sha256:${c.repeat(64)}` as `sha256:${string}`;

const HONORIFIC_UNIT = "a06a6efc-b1f0-7483-b225-40f197a3bc83"; // scene-0001#0000
const DIALECT_UNIT = "9706a898-f08a-7ba9-99e6-c304e0235874"; // scene-0001#0001
const PLAIN_UNIT_A = "b43c7e66-a03e-713b-89cc-797c5ff9216f"; // scene-0001#0002 (unflagged)
const CULTURE_UNIT = "d04f6e35-621e-78cf-80d0-1a3b0416db78"; // scene-0002#0000
const WORDPLAY_UNIT = "402c8867-cf61-7afa-a110-843c4f9fab53"; // scene-0002#0001
const PLAIN_UNIT_B = "84106326-5a71-737e-b369-b6a0ed46bf2a"; // scene-0002#0002 (unflagged)

const rubySpan = (): BridgeSpanV02 => ({
  spanId: "00000000-0000-7000-8000-0000000000aa",
  spanKind: "ruby_annotation",
  raw: "<ruby>",
  startByte: 0,
  endByte: 1,
  preserveMode: "transform",
  annotationText: "よみ",
});

/** Stage decoded source text / spans onto the read model's bundle: three lines
 * carry a fixed cultural/dialect/honorific marker, one carries a ruby wordplay
 * span, and two stay plain (unflagged). The FACT snapshot stays real bytes. */
function stageMarkers(bundle: BridgeBundleV02): BridgeBundleV02 {
  const sourceText: Record<string, string> = {
    [HONORIFIC_UNIT]: "先輩、おはようございます",
    [DIALECT_UNIT]: "ほんまにそうやねん",
    [CULTURE_UNIT]: "お盆に浴衣で花見へ行く",
    [WORDPLAY_UNIT]: "あ",
    [PLAIN_UNIT_A]: "い",
    [PLAIN_UNIT_B]: "い",
  };
  return {
    ...bundle,
    units: bundle.units.map((unit) => ({
      ...unit,
      sourceText: sourceText[unit.bridgeUnitId] ?? unit.sourceText,
      spans: unit.bridgeUnitId === WORDPLAY_UNIT ? [rubySpan()] : [],
    })),
  };
}

function fixture() {
  return buildClaimFixture({ modelBundle: stageMarkers });
}

function request(snapshotId: `sha256:${string}`): AdaptationRequest {
  return {
    contextSnapshotId: snapshotId,
    sourceLanguage: "ja-JP",
    operatorBrief: "House localization posture for a peer-to-peer romance VN.",
    runMode: "production",
    contextScope: "whole-game",
  };
}

/** A citation to the fixture unit with the given fact id, resolved through the
 * real evidence index so hash / subject / play-order all resolve. */
function citationForUnit(model: ReturnType<typeof fixture>["model"], unitFactId: string): Citation {
  const record = buildEvidenceIndex(model).get(unitFactId)!;
  return {
    evidenceId: record.factId,
    evidenceHash: record.hash,
    snapshotId: record.snapshotId as `sha256:${string}`,
    subject: record.subject,
    role: "establishes",
    playOrderIndex: record.fromPlayOrder,
  };
}

/** A schema-valid adaptation-note WikiObject: a communicative function plus a
 * bounded option carrying tradeoffs, in the source language, mapped to a unit. */
function adaptationNote(opts: {
  objectId: string;
  unitFactId: string;
  snapshotId: `sha256:${string}`;
  lang?: string;
  subjectId?: string;
  citations: Citation[];
  boundedOptions?: {
    optionId: string;
    strategy: string;
    tradeoffs: string[];
  }[];
}): WikiObject {
  return {
    schemaVersion: WIKI_OBJECT_SCHEMA_VERSION,
    objectId: opts.objectId,
    version: 1,
    lang: opts.lang ?? "ja-JP",
    subject: { kind: "unit", id: opts.unitFactId },
    scope: { kind: "global" },
    kind: "adaptation-note",
    body: {
      subjectId: opts.subjectId ?? opts.unitFactId,
      communicativeFunction: "敬称が上下関係と親しさの度合いを示し、話者の距離感を規定している。",
      constraints: ["話者の年齢差を保持する"],
      boundedOptions: opts.boundedOptions ?? [
        {
          optionId: "opt-preserve",
          strategy: "敬称をローマ字で保持し、読者に関係性を委ねる。",
          tradeoffs: ["原語のニュアンスを保つが可読性が下がる"],
        },
        {
          optionId: "opt-naturalize",
          strategy: "役割語に置き換え、関係性を語彙で示す。",
          tradeoffs: ["読みやすいが敬称の含みが薄れる"],
        },
      ],
    },
    claims: [
      {
        claimId: `${opts.objectId}:adapt-1`,
        statement: "この行は敬称によって関係性を確立している。",
        scope: { kind: "global" },
        kind: "adaptation",
        confidence: "high",
        citations: opts.citations,
      },
    ],
    media: [],
    dependencies: [],
    provisional: false,
    provenance: {
      contextSnapshotId: opts.snapshotId,
      contextScope: "whole-game",
      runMode: "production",
      snapshotKind: "context",
    },
  } as unknown as WikiObject;
}

function recordedSuccess(object: WikiObject, servedModel = deepSeekV4FlashProfile.model) {
  return CallResultSchema.parse({
    schemaVersion: CALL_RESULT_SCHEMA_VERSION,
    status: "success",
    memoKey: HASH("b"),
    requested: { model: deepSeekV4FlashProfile.model },
    memoHit: true,
    value: object,
    responseEventId: HASH("c"),
    served: { status: "confirmed", model: servedModel, provider: "fireworks" },
    generationId: "generation:a6-rec",
    verification: "verified",
    usage: { promptTokens: 800, completionTokens: 260, reasoningTokens: 90, cachedTokens: 0 },
    billing: { status: "confirmed", costUsd: "0.0008" },
    events: [],
  });
}

function candidateFor(
  model: ReturnType<typeof fixture>["model"],
  bridgeUnitId: string,
): FlaggedAdaptationCandidate {
  return flaggedAdaptationCandidates(model).find((c) => c.bridgeUnitId === bridgeUnitId)!;
}

describe("A6 clause 1 — runs over EXACTLY the deterministically flagged set", () => {
  it("PROOF: only the marked units are flagged; the plain lines are hidden", () => {
    const { model } = fixture();
    const candidates = flaggedAdaptationCandidates(model);
    const flaggedKeys = candidates.map((c) => c.sourceUnitKey).sort();
    expect(flaggedKeys).toEqual([
      "reallive:scene-0001#0000",
      "reallive:scene-0001#0001",
      "reallive:scene-0002#0000",
      "reallive:scene-0002#0001",
    ]);
    // The plain lines are absent — the analyst can never fan out onto them.
    expect(isFlaggedUnit(model, PLAIN_UNIT_A)).toBe(false);
    expect(isFlaggedUnit(model, PLAIN_UNIT_B)).toBe(false);
    // Each flag names byte-derived categories + markers, not a model guess.
    const byId = new Map(candidates.map((c) => [c.bridgeUnitId, c]));
    expect(byId.get(HONORIFIC_UNIT)!.categories).toEqual(["honorific"]);
    expect(byId.get(HONORIFIC_UNIT)!.markers).toEqual(["先輩"]);
    expect(byId.get(DIALECT_UNIT)!.categories).toEqual(["dialect"]);
    expect(byId.get(DIALECT_UNIT)!.markers).toEqual(["やねん"]);
    expect(byId.get(CULTURE_UNIT)!.categories).toEqual(["culture"]);
    expect(byId.get(CULTURE_UNIT)!.markers).toEqual(["お盆", "浴衣", "花見"].sort());
    expect(byId.get(WORDPLAY_UNIT)!.categories).toEqual(["wordplay"]);
    expect(byId.get(WORDPLAY_UNIT)!.hasRubyWordplay).toBe(true);
    expect(byId.get(WORDPLAY_UNIT)!.markers).toEqual([]);
  });

  it("PROOF: the whole run dispatches once per flagged unit and never for a plain line", async () => {
    const { model } = fixture();
    const req = request(model.snapshotId);
    const candidates = flaggedAdaptationCandidates(model);

    // A recorded result exists ONLY for each flagged unit's transcript anchor. If
    // the run fanned out onto a plain line, it would dispatch an anchor the map
    // does not cover and throw — so a green run proves EXACTLY the flagged set.
    const byAnchor = new Map(
      candidates.map((candidate) => {
        const note = adaptationNote({
          objectId: `note:${candidate.unitFactId}`,
          unitFactId: candidate.unitFactId,
          snapshotId: model.snapshotId,
          citations: [citationForUnit(model, candidate.unitFactId)],
        });
        return [candidateAnchor(req, candidate.unitFactId), recordedSuccess(note)];
      }),
    );

    const result = await runAdaptationAnalyst(req, {
      model: recordedAdaptationModelByAnchor(byAnchor),
      storePrompt: inlineAdaptationPromptStore(),
      readModel: model,
    });

    expect(result.notes).toHaveLength(candidates.length);
    expect(result.flaggedUnitFactIds).toEqual(candidates.map((c) => c.unitFactId));
    // No plain-line unit was ever a subject of a produced note.
    const noteUnitIds = result.notes.map((n) => n.note.subject.id);
    const plainFactIds = model.factSnapshot.orderedUnits
      .filter((u) => u.bridgeUnitId === PLAIN_UNIT_A || u.bridgeUnitId === PLAIN_UNIT_B)
      .map((u) => u.factId);
    for (const plain of plainFactIds) expect(noteUnitIds).not.toContain(plain);
  });
});

describe("A6 clause 2 — function + bounded options, never a replacement translation", () => {
  it("PROOF: runAdaptationNote emits a source-language note with function + bounded options", async () => {
    const { model } = fixture();
    const candidate = candidateFor(model, HONORIFIC_UNIT);
    const note = adaptationNote({
      objectId: "note:ok",
      unitFactId: candidate.unitFactId,
      snapshotId: model.snapshotId,
      citations: [citationForUnit(model, candidate.unitFactId)],
    });
    const storedPrompts: string[] = [];
    const baseStore = inlineAdaptationPromptStore();

    const result = await runAdaptationNote(request(model.snapshotId), candidate, {
      model: recordedAdaptationModel(recordedSuccess(note)),
      storePrompt: async (text, channel) => {
        storedPrompts.push(text);
        return baseStore(text, channel);
      },
      readModel: model,
    });

    expect(result.note.kind).toBe("adaptation-note");
    expect(result.note.lang).toBe("ja-JP");
    expect(result.note.claims).toHaveLength(1);
    expect(result.note.claims[0]!.citations[0]!.evidenceId).toBe(candidate.unitFactId);
    expect(result.note.provenance).toMatchObject({
      contextSnapshotId: model.snapshotId,
      contextScope: "whole-game",
      runMode: "production",
      snapshotKind: "context",
    });
    expect(typeof result.note.provisional).toBe("boolean");
    expect(result.note.body.communicativeFunction.length).toBeGreaterThan(0);
    expect(result.note.body.boundedOptions.length).toBeGreaterThanOrEqual(1);
    for (const option of result.note.body.boundedOptions) {
      expect(option.tradeoffs.length).toBeGreaterThanOrEqual(1);
    }
    expect(result.served.model).toBe(deepSeekV4FlashProfile.model);
    expect(result.served.provider).toBe("fireworks");
    // A6 reads its exact source unit and setup/payoff window through the
    // specialist read surface; this is the context the role actually had
    // before dispatching the note.
    expect(result.context.unit.factId).toBe(candidate.unitFactId);
    expect(result.context.neighborsPage.tool).toBe("decode_get_neighbors");
    expect(result.context.neighborsPage.facts.map((fact) => fact.factId)).toContain(
      candidate.unitFactId,
    );
    expect(result.context.referencesPage.tool).toBe("references_search");
    expect(storedPrompts.join("\n")).toContain(`RB-025 exact source fact: ${candidate.unitFactId}`);
    expect(storedPrompts.join("\n")).toContain("RB-025 setup/payoff window");
    // The byte-derived flag is surfaced authoritatively, not the model's guess.
    expect(result.evidence.markers).toEqual(["先輩"]);
    // The body carries NO replacement / target field — it is function + options.
    expect(Object.keys(result.note.body).sort()).toEqual(
      ["boundedOptions", "communicativeFunction", "constraints", "subjectId"].sort(),
    );
    expect(JSON.stringify(result.note.body)).not.toMatch(/replacement|target|en-US/i);
  });

  it("PROOF: a target-language object is rejected — the note is an analysis, not a rendering", async () => {
    const { model } = fixture();
    const candidate = candidateFor(model, HONORIFIC_UNIT);
    const note = adaptationNote({
      objectId: "note:en",
      unitFactId: candidate.unitFactId,
      snapshotId: model.snapshotId,
      lang: "en-US",
      citations: [citationForUnit(model, candidate.unitFactId)],
    });
    await expect(
      runAdaptationNote(request(model.snapshotId), candidate, {
        model: recordedAdaptationModel(recordedSuccess(note)),
        storePrompt: inlineAdaptationPromptStore(),
        readModel: model,
      }),
    ).rejects.toBeInstanceOf(AdaptationEvidenceError);
  });

  it("PROOF: a bounded option with no tradeoffs (a bare replacement) is rejected", () => {
    const { model } = fixture();
    const note = adaptationNote({
      objectId: "note:bare",
      unitFactId: candidateFor(model, HONORIFIC_UNIT).unitFactId,
      snapshotId: model.snapshotId,
      citations: [citationForUnit(model, candidateFor(model, HONORIFIC_UNIT).unitFactId)],
      boundedOptions: [{ optionId: "opt-bare", strategy: "just say senpai", tradeoffs: [] }],
    }) as Extract<WikiObject, { kind: "adaptation-note" }>;
    expect(() => assertNoteIsFunctionAndOptions(note, "ja-JP")).toThrow(AdaptationEvidenceError);
  });

  it("PROOF: a wrong served model is rejected (certified model only)", async () => {
    const { model } = fixture();
    const candidate = candidateFor(model, HONORIFIC_UNIT);
    const note = adaptationNote({
      objectId: "note:x",
      unitFactId: candidate.unitFactId,
      snapshotId: model.snapshotId,
      citations: [citationForUnit(model, candidate.unitFactId)],
    });
    await expect(
      runAdaptationNote(request(model.snapshotId), candidate, {
        model: recordedAdaptationModel(recordedSuccess(note, "openai/gpt-x")),
        storePrompt: inlineAdaptationPromptStore(),
        readModel: model,
      }),
    ).rejects.toBeInstanceOf(AdaptationAnalystError);
  });
});

describe("A6 clause 3 — every note maps to a real unit; the flag is byte-derived", () => {
  it("PROOF: a note that maps to the wrong unit is rejected", async () => {
    const { model } = fixture();
    const candidate = candidateFor(model, HONORIFIC_UNIT);
    const otherFactId = candidateFor(model, DIALECT_UNIT).unitFactId;
    const note = adaptationNote({
      objectId: "note:off",
      unitFactId: candidate.unitFactId,
      snapshotId: model.snapshotId,
      subjectId: otherFactId, // body names a different unit than the dispatched one
      citations: [citationForUnit(model, candidate.unitFactId)],
    });
    await expect(
      runAdaptationNote(request(model.snapshotId), candidate, {
        model: recordedAdaptationModel(recordedSuccess(note)),
        storePrompt: inlineAdaptationPromptStore(),
        readModel: model,
      }),
    ).rejects.toBeInstanceOf(AdaptationEvidenceError);
  });

  it("PROOF: a note citing a unit that is not in the snapshot is rejected by claim validation", async () => {
    const { model } = fixture();
    const candidate = candidateFor(model, HONORIFIC_UNIT);
    const real = citationForUnit(model, candidate.unitFactId);
    const forged: Citation = { ...real, evidenceHash: HASH("f") };
    const note = adaptationNote({
      objectId: "note:forged",
      unitFactId: candidate.unitFactId,
      snapshotId: model.snapshotId,
      citations: [forged],
    });
    await expect(
      runAdaptationNote(request(model.snapshotId), candidate, {
        model: recordedAdaptationModel(recordedSuccess(note)),
        storePrompt: inlineAdaptationPromptStore(),
        readModel: model,
      }),
    ).rejects.toBeInstanceOf(ClaimValidationError);
  });

  it("PROOF: a hand-built flag naming a marker the bytes never carried is rejected", async () => {
    const { model } = fixture();
    // Forge a flag on a PLAIN unit, claiming a culture marker its bytes lack.
    const plainFactId = model.factSnapshot.orderedUnits.find(
      (u) => u.bridgeUnitId === PLAIN_UNIT_A,
    )!.factId;
    const forgedFlag: FlaggedAdaptationCandidate = {
      unitFactId: plainFactId,
      sourceUnitKey: "reallive:scene-0001#0002",
      bridgeUnitId: PLAIN_UNIT_A,
      categories: ["culture"],
      markers: ["お盆"],
      hasRubyWordplay: false,
      sourceText: "い",
      playOrderIndex: 2,
    };
    const note = adaptationNote({
      objectId: "note:forged-flag",
      unitFactId: plainFactId,
      snapshotId: model.snapshotId,
      citations: [citationForUnit(model, plainFactId)],
    });
    await expect(
      runAdaptationNote(request(model.snapshotId), forgedFlag, {
        model: recordedAdaptationModel(recordedSuccess(note)),
        storePrompt: inlineAdaptationPromptStore(),
        readModel: model,
      }),
    ).rejects.toBeInstanceOf(AdaptationEvidenceError);
  });
});
