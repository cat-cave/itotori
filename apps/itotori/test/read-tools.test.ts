// Strict local read-tool surface — mutation-falsifiable proofs.
//
// The fact snapshot is built from a REAL committed Bridge v0.2 bundle (from
// extraction), so decode reads run against genuine decoded bytes. Every clause
// below fails if its guarantee is removed: deterministic ordering, explicit
// row/byte bounds, no silent truncation, pagination-concatenation byte identity,
// resultHash↔snapshot binding, role/route/reveal denials, and extra-arg refusal.

import { readFileSync } from "node:fs";

import {
  canonicalLlmJson,
  contextSnapshot,
  type LlmContextSnapshotInput,
  type LlmRevealHorizon,
  type LlmRevisionRef,
} from "@itotori/db";
import type { BridgeBundleV02 } from "@itotori/localization-bridge-schema";
import { describe, expect, it } from "vitest";

import type { GlossaryFactValue, HumanNoteFactValue } from "../src/contracts/index.js";
import {
  buildReadModel,
  decodeGetCharacterOccurrences,
  decodeGetNeighbors,
  decodeGetRouteGraph,
  decodeGetUnits,
  glossaryLookup,
  outputsGetAccepted,
  ReadToolError,
  referencesSearch,
  type CharacterProfile,
  type ReadModel,
  type ReadToolCaller,
} from "../src/read-tools/index.js";
import {
  buildFactSnapshot,
  contextSnapshotFactsFrom,
  type FactSnapshot,
} from "../src/prepass/index.js";
import type { NarrativeScene, NarrativeStructure, NarrativeUnit } from "../src/structure/types.js";
import { acceptedOutputExample } from "./contract-fixtures-core.js";

function loadBundle(): BridgeBundleV02 {
  const raw = readFileSync(new URL("./fixtures/whole-seen-bridge.json", import.meta.url), "utf8");
  return JSON.parse(raw) as BridgeBundleV02;
}

const BUNDLE_HASH = "sha256:3065996aa103c1c827f13998f8d44046d5df0b9d5f30a1f0027544de71be6927";
const LOCALIZATION_ID = `sha256:${"b".repeat(64)}` as `sha256:${string}`;

type Spec = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  assetId: string;
  s: number;
  e: number;
  choice: boolean;
};
const S1_LINE: Spec = {
  bridgeUnitId: "a06a6efc-b1f0-7483-b225-40f197a3bc83",
  sourceUnitKey: "reallive:scene-0001#0000",
  assetId: "df9fc555-e560-7887-a9d1-6c5b0ac311a4",
  s: 17,
  e: 21,
  choice: false,
};
const S1_A: Spec = {
  bridgeUnitId: "9706a898-f08a-7ba9-99e6-c304e0235874",
  sourceUnitKey: "reallive:scene-0001#0001",
  assetId: "df9fc555-e560-7887-a9d1-6c5b0ac311a4",
  s: 29,
  e: 31,
  choice: true,
};
const S1_B: Spec = {
  bridgeUnitId: "b43c7e66-a03e-713b-89cc-797c5ff9216f",
  sourceUnitKey: "reallive:scene-0001#0002",
  assetId: "df9fc555-e560-7887-a9d1-6c5b0ac311a4",
  s: 29,
  e: 31,
  choice: true,
};
const S2_LINE: Spec = {
  bridgeUnitId: "d04f6e35-621e-78cf-80d0-1a3b0416db78",
  sourceUnitKey: "reallive:scene-0002#0000",
  assetId: "ca500bc0-3a3a-74ea-8273-341b123ec2c4",
  s: 17,
  e: 21,
  choice: false,
};
const S2_A: Spec = {
  bridgeUnitId: "402c8867-cf61-7afa-a110-843c4f9fab53",
  sourceUnitKey: "reallive:scene-0002#0001",
  assetId: "ca500bc0-3a3a-74ea-8273-341b123ec2c4",
  s: 29,
  e: 31,
  choice: true,
};
const S2_B: Spec = {
  bridgeUnitId: "84106326-5a71-737e-b369-b6a0ed46bf2a",
  sourceUnitKey: "reallive:scene-0002#0002",
  assetId: "ca500bc0-3a3a-74ea-8273-341b123ec2c4",
  s: 29,
  e: 31,
  choice: true,
};

function unit(spec: Spec, index: number, routeMembership: string[]): NarrativeUnit {
  return {
    unitId: `unit-${spec.sourceUnitKey}`,
    bridgeRef: { bridgeUnitId: spec.bridgeUnitId, sourceUnitKey: spec.sourceUnitKey },
    surfaceKind: spec.choice ? "choice_label" : "dialogue",
    sourceText: "",
    characterId: null,
    evidenceTier: "E2",
    color: null,
    sourceAsset: { assetId: spec.assetId, assetKey: "" },
    byteOffsetInScene: spec.s,
    byteLength: spec.e - spec.s,
    rawByteHandle: `handle-${index}`,
    choiceId: spec.choice ? `choice-${spec.sourceUnitKey}` : null,
    playOrder: index,
    revealOrder: null,
    observedLineIds: [],
    routeMembership,
  };
}

function scene(
  sceneId: number,
  specs: Spec[],
  nextScene: number | null,
  routes: string[],
): NarrativeScene {
  return {
    sceneId,
    selectionControl: "none",
    nextScene,
    messages: [],
    choices: [],
    units: specs.map((spec, index) => unit(spec, index, routes)),
  };
}

/** Entry scene 1 → scene 2; scene 3 orphaned. Scene 2 units carry `route-b`. */
function structure(scene2Routes: string[] = []): NarrativeStructure {
  return {
    schemaVersion: "utsushi.narrative-structure.v2",
    entryScene: 1,
    sceneDispatchOrder: [1, 2],
    sourceBundleHash: BUNDLE_HASH,
    scenes: [
      scene(1, [S1_LINE, S1_A, S1_B], 2, []),
      scene(2, [S2_LINE, S2_A, S2_B], null, scene2Routes),
      { sceneId: 3, selectionControl: "none", nextScene: null, messages: [], choices: [] },
    ],
  };
}

const revision = (id: string): LlmRevisionRef => ({
  revisionId: id,
  contentHash: `sha256:${"0".repeat(63)}${id.length % 10}`,
});

function makeContext(snapshot: FactSnapshot, revealHorizon: LlmRevealHorizon) {
  const { facts, factMaterialization } = contextSnapshotFactsFrom(snapshot);
  const input: LlmContextSnapshotInput = {
    sourceLanguage: "ja-JP",
    decode: revision("decode"),
    sourceUnits: snapshot.orderedUnits.map((u) => ({ unitId: u.factId, sourceHash: u.sourceHash })),
    facts,
    structure: revision("structure"),
    routeGraph: revision("route-graph"),
    glossary: revision("glossary"),
    style: revision("style"),
    revealHorizon,
    humanCorrections: revision("corrections"),
    externalSources: null,
    contextScope: "whole-game",
    factMaterialization,
  };
  return contextSnapshot(input);
}

const ANALYST: ReadToolCaller = {
  roleId: "A1",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};
const LOCALIZER: ReadToolCaller = {
  roleId: "P1",
  routeVisibility: { kind: "global" },
  localeBranchId: "locale-branch:1",
};

function glossaryEntry(termId: string, occurrenceUnitIds: string[]): GlossaryFactValue {
  return {
    kind: "glossary-entry",
    termId,
    sourceForm: "あい",
    aliases: [],
    forms: [{ language: "en-US", form: termId, status: "preferred" }],
    scope: { kind: "global" },
    occurrenceUnitIds,
    conflictsWithTermIds: [],
    revision: revision("glossary"),
  };
}

function note(noteId: string, excerpt: string): HumanNoteFactValue {
  return {
    kind: "human-note",
    noteId,
    excerpt,
    revision: revision("notes"),
    scope: { kind: "global" },
  };
}

function baseModel(
  revealHorizon: LlmRevealHorizon = { kind: "complete" },
  scene2Routes: string[] = [],
): {
  model: ReadModel;
  snapshot: FactSnapshot;
} {
  const snapshot = buildFactSnapshot(structure(scene2Routes), loadBundle());
  const s1LineId = snapshot.orderedUnits.find(
    (u) => u.bridgeUnitId === S1_LINE.bridgeUnitId,
  )!.factId;
  const model = buildReadModel({
    contextSnapshot: makeContext(snapshot, revealHorizon),
    factSnapshot: snapshot,
    bundle: loadBundle(),
    references: [
      note("note:a", "keep the register direct and warm"),
      note("note:b", "avoid slang"),
    ],
    localization: {
      localizationSnapshotId: LOCALIZATION_ID,
      targetLocale: "en-US",
      localeBranchId: "locale-branch:1",
      glossaryRevision: revision("glossary"),
      glossaryEntries: [glossaryEntry("term:z", [s1LineId]), glossaryEntry("term:a", [s1LineId])],
      acceptedOutputs: [
        { ...acceptedOutputExample, subjectId: s1LineId, localizationSnapshotId: LOCALIZATION_ID },
      ],
    },
  });
  return { model, snapshot };
}

function factIdAtPlayOrder(snapshot: FactSnapshot, playOrderIndex: number): string {
  return snapshot.orderedUnits.find((u) => u.playReveal.playOrderIndex === playOrderIndex)!.factId;
}

describe("read tools — ordering, bounds, and pagination", () => {
  it("decode_get_units is deterministically play-ordered and stable across calls", () => {
    const { model } = baseModel();
    const first = decodeGetUnits(model, ANALYST, {
      selector: { kind: "all" },
      maxRows: 100,
      maxBytes: 8_388_608,
    });
    const again = decodeGetUnits(model, ANALYST, {
      selector: { kind: "all" },
      maxRows: 100,
      maxBytes: 8_388_608,
    });
    const orders = first.facts.map((f) => f.value.playOrderIndex);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(first.facts).toHaveLength(6);
    expect(first.page.kind).toBe("complete");
    expect(first.resultHash).toBe(again.resultHash);
  });

  it("PROOF: concatenated pages EQUAL the unpaged result BYTE-FOR-BYTE", () => {
    const { model } = baseModel();
    const args = { selector: { kind: "all" as const }, maxBytes: 8_388_608 };
    const unpaged = decodeGetUnits(model, ANALYST, { ...args, maxRows: 100 });

    const pages: (typeof unpaged.facts)[number][][] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const page = decodeGetUnits(model, ANALYST, {
        ...args,
        maxRows: 2,
        ...(cursor === null ? {} : { cursor }),
      });
      pages.push(page.facts);
      cursor = page.page.nextCursor;
      guard += 1;
    } while (cursor !== null && guard < 100);

    const concatenated = pages.flat();
    // Byte-for-byte identity of the ordered fact stream (not merely deep-equal):
    // 6 facts over 3 pages of 2 -> canonical JSON is 5803 bytes either way.
    expect(canonicalLlmJson(concatenated)).toBe(canonicalLlmJson(unpaged.facts));
    expect(Buffer.byteLength(canonicalLlmJson(concatenated))).toBe(
      Buffer.byteLength(canonicalLlmJson(unpaged.facts)),
    );
    expect(concatenated).toEqual(unpaged.facts);
    // Each intermediate page truncates ONLY by carrying a cursor.
    expect(pages.length).toBe(3);
  });

  it("byte + row bounds are explicit; a single oversize row FAILS LOUD (no truncation)", () => {
    const { model } = baseModel();
    const page = decodeGetUnits(model, ANALYST, {
      selector: { kind: "all" },
      maxRows: 2,
      maxBytes: 8_388_608,
    });
    expect(page.page.returnedRows).toBe(2);
    expect(page.page.kind).toBe("more");
    expect(page.page.nextCursor).not.toBeNull();
    expect(() =>
      decodeGetUnits(model, ANALYST, { selector: { kind: "all" }, maxRows: 100, maxBytes: 10 }),
    ).toThrowError(ReadToolError);
  });

  it("a cursor cannot cross into a different request", () => {
    const { model } = baseModel();
    const page = decodeGetUnits(model, ANALYST, {
      selector: { kind: "all" },
      maxRows: 2,
      maxBytes: 8_388_608,
    });
    const cursor = page.page.nextCursor!;
    // Reuse the cursor under a DIFFERENT selector — the request hash no longer matches.
    expect(() =>
      decodeGetUnits(model, ANALYST, {
        selector: { kind: "scene", sceneId: 1 },
        maxRows: 2,
        maxBytes: 8_388_608,
        cursor,
      }),
    ).toThrowError(ReadToolError);
  });
});

describe("read tools — content-address binding", () => {
  it("PROOF: resultHash binds the payload to the snapshot; a different snapshot ⇒ different envelope", () => {
    const { model } = baseModel();
    const other = buildFactSnapshot({ ...structure(), entryScene: 2 }, loadBundle());
    const otherModel = buildReadModel({
      contextSnapshot: makeContext(other, { kind: "complete" }),
      factSnapshot: other,
      bundle: loadBundle(),
    });
    const a = decodeGetUnits(model, ANALYST, {
      selector: { kind: "all" },
      maxRows: 100,
      maxBytes: 8_388_608,
    });
    const b = decodeGetUnits(otherModel, ANALYST, {
      selector: { kind: "all" },
      maxRows: 100,
      maxBytes: 8_388_608,
    });
    expect(a.snapshotId).not.toBe(b.snapshotId);
    expect(a.resultHash).not.toBe(b.resultHash);
    expect(a.facts.every((f) => f.snapshotId === a.snapshotId)).toBe(true);
  });

  it("rejects a read model whose context did not commit this fact snapshot", () => {
    const snapshot = buildFactSnapshot(structure(), loadBundle());
    const wrong = buildFactSnapshot({ ...structure(), entryScene: 2 }, loadBundle());
    expect(() =>
      buildReadModel({
        contextSnapshot: makeContext(wrong, { kind: "complete" }),
        factSnapshot: snapshot,
        bundle: loadBundle(),
      }),
    ).toThrowError(ReadToolError);
  });
});

describe("read tools — access control", () => {
  it("enforces the role allowlist per tool", () => {
    const { model } = baseModel();
    // A1 (analyst) may not read neighbor windows; P1 (localizer) may not read the route graph.
    expect(() =>
      decodeGetNeighbors(model, ANALYST, {
        anchorUnitIds: ["x"],
        before: 1,
        after: 1,
        maxRows: 10,
        maxBytes: 8_388_608,
      }),
    ).toThrowError(ReadToolError);
    expect(() =>
      decodeGetRouteGraph(model, LOCALIZER, { maxRows: 10, maxBytes: 8_388_608 }),
    ).toThrowError(ReadToolError);
    // Each is allowed for its own role.
    expect(
      decodeGetRouteGraph(model, ANALYST, { maxRows: 100, maxBytes: 8_388_608 }).facts.length,
    ).toBeGreaterThan(0);
  });

  it("rejects unknown arguments (no silent ignore)", () => {
    const { model } = baseModel();
    expect(() =>
      decodeGetUnits(model, ANALYST, {
        selector: { kind: "all" },
        maxRows: 10,
        maxBytes: 8_388_608,
        sneaky: true,
      }),
    ).toThrowError(/unknown-argument/u);
  });

  it("denies reads beyond the reveal horizon (explicit id) and hides them from scans", () => {
    const { model, snapshot } = baseModel({ kind: "through-play-order", playOrderIndex: 2 });
    const hidden = factIdAtPlayOrder(snapshot, 5);
    // Explicit lookup of a beyond-horizon unit is a loud denial…
    expect(() =>
      decodeGetUnits(model, ANALYST, {
        selector: { kind: "unit-ids", unitIds: [hidden] },
        maxRows: 10,
        maxBytes: 8_388_608,
      }),
    ).toThrowError(/beyond-reveal-horizon/u);
    // …and a scan simply never surfaces it.
    const scan = decodeGetUnits(model, ANALYST, {
      selector: { kind: "all" },
      maxRows: 100,
      maxBytes: 8_388_608,
    });
    expect(scan.facts.map((f) => f.factId)).not.toContain(hidden);
    expect(scan.facts).toHaveLength(3);
  });

  it("denies out-of-route reads (explicit id) and hides them from scans", () => {
    const { model, snapshot } = baseModel({ kind: "complete" }, ["route-b"]);
    const routedCaller: ReadToolCaller = {
      roleId: "A1",
      routeVisibility: { kind: "route", routeId: "route-a" },
      localeBranchId: null,
    };
    const outOfRoute = snapshot.orderedUnits.find(
      (u) => u.bridgeUnitId === S2_LINE.bridgeUnitId,
    )!.factId;
    expect(() =>
      decodeGetUnits(model, routedCaller, {
        selector: { kind: "unit-ids", unitIds: [outOfRoute] },
        maxRows: 10,
        maxBytes: 8_388_608,
      }),
    ).toThrowError(/out-of-route/u);
    const scan = decodeGetUnits(model, routedCaller, {
      selector: { kind: "all" },
      maxRows: 100,
      maxBytes: 8_388_608,
    });
    expect(scan.facts.map((f) => f.factId)).not.toContain(outOfRoute);
    expect(scan.facts).toHaveLength(3);
  });
});

describe("read tools — neighbors, glossary, outputs, references", () => {
  it("decode_get_neighbors returns a bounded ordered window around anchors", () => {
    const { model, snapshot } = baseModel();
    const anchor = factIdAtPlayOrder(snapshot, 3);
    const result = decodeGetNeighbors(model, LOCALIZER, {
      anchorUnitIds: [anchor],
      before: 1,
      after: 1,
      maxRows: 100,
      maxBytes: 8_388_608,
    });
    const orders = result.facts.map((f) => f.value.playOrderIndex);
    expect(orders).toEqual([2, 3, 4]);
    expect(result.anchorUnitIds).toEqual([anchor]);
  });

  it("glossary_lookup orders results and enforces the target branch", () => {
    const { model } = baseModel();
    const result = glossaryLookup(model, LOCALIZER, {
      selector: { kind: "all" },
      maxRows: 100,
      maxBytes: 8_388_608,
    });
    expect(result.facts.map((f) => f.value.termId)).toEqual(["term:a", "term:z"]);
    expect(result.glossaryRevisionHash).toBe(revision("glossary").contentHash);
    // A caller bound to the wrong locale branch is denied.
    const wrongBranch: ReadToolCaller = { ...LOCALIZER, localeBranchId: "locale-branch:other" };
    expect(() =>
      glossaryLookup(model, wrongBranch, {
        selector: { kind: "all" },
        maxRows: 10,
        maxBytes: 8_388_608,
      }),
    ).toThrowError(/locale-branch-mismatch/u);
  });

  it("outputs_get_accepted returns accepted outputs for explicit subjects only", () => {
    const { model, snapshot } = baseModel();
    const subject = snapshot.orderedUnits.find(
      (u) => u.bridgeUnitId === S1_LINE.bridgeUnitId,
    )!.factId;
    const result = outputsGetAccepted(model, LOCALIZER, {
      subjectIds: [subject],
      maxRows: 100,
      maxBytes: 8_388_608,
    });
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]!.subjectId).toBe(subject);
    const miss = outputsGetAccepted(model, LOCALIZER, {
      subjectIds: ["unit:absent"],
      maxRows: 100,
      maxBytes: 8_388_608,
    });
    expect(miss.outputs).toHaveLength(0);
    expect(miss.page.kind).toBe("complete");
  });

  it("references_search ranks lexical hits deterministically", () => {
    const { model } = baseModel();
    const result = referencesSearch(model, LOCALIZER, {
      query: "register direct",
      maxRows: 100,
      maxBytes: 8_388_608,
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.fact.value.noteId).toBe("note:a");
    expect(result.hits[0]!.vectorScore).toBeNull();
  });
});

/** Scene 1 gains two decode-only messages attributed to a canonical character,
 * so `reduceCharacterOccurrences` materializes a real occurrence fact. */
function characterStructure(): NarrativeStructure {
  const base = structure();
  base.scenes[0]!.messages = [
    { order: 0, speaker: "あい", characterId: "nam-17", text: "あい", textSurface: "あい" },
    { order: 1, speaker: "あい", characterId: "nam-17", text: "あ", textSurface: "あ" },
  ];
  return base;
}

describe("read tools — character occurrences", () => {
  function characterModel(): { model: ReadModel; snapshot: FactSnapshot } {
    const snapshot = buildFactSnapshot(characterStructure(), loadBundle());
    const unitId = snapshot.orderedUnits.find(
      (u) => u.bridgeUnitId === S1_LINE.bridgeUnitId,
    )!.factId;
    const profiles = new Map<string, CharacterProfile>([
      ["nam-17", { decodedLabel: "Ai", revealStatus: "revealed", unitIds: [unitId] }],
    ]);
    const model = buildReadModel({
      contextSnapshot: makeContext(snapshot, { kind: "complete" }),
      factSnapshot: snapshot,
      bundle: loadBundle(),
      characterProfiles: profiles,
    });
    return { model, snapshot };
  }

  it("projects exactly one occurrence fact bound to the snapshot", () => {
    const { model } = characterModel();
    const result = decodeGetCharacterOccurrences(model, ANALYST, {
      characterId: "nam-17",
      maxRows: 10,
      maxBytes: 8_388_608,
    });
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.value.characterId).toBe("nam-17");
    expect(result.facts[0]!.value.totalLines).toBe(2);
    expect(result.facts[0]!.snapshotId).toBe(model.snapshotId);
  });

  it("enforces its role allowlist and denies an unknown character", () => {
    const { model } = characterModel();
    expect(() =>
      decodeGetCharacterOccurrences(model, LOCALIZER, {
        characterId: "nam-17",
        maxRows: 10,
        maxBytes: 8_388_608,
      }),
    ).toThrowError(/role-not-allowed/u);
    expect(() =>
      decodeGetCharacterOccurrences(model, ANALYST, {
        characterId: "nam-absent",
        maxRows: 10,
        maxBytes: 8_388_608,
      }),
    ).toThrowError(/unknown-subject/u);
  });
});
