import { readFileSync } from "node:fs";
import {
  canonicalLlmJson,
  contextSnapshot,
  type LlmJsonValue,
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

export function loadBundle(): BridgeBundleV02 {
  const raw = readFileSync(new URL("./fixtures/whole-seen-bridge.json", import.meta.url), "utf8");
  return JSON.parse(raw) as BridgeBundleV02;
}

export const BUNDLE_HASH =
  "sha256:3065996aa103c1c827f13998f8d44046d5df0b9d5f30a1f0027544de71be6927";

export const LOCALIZATION_ID = `sha256:${"b".repeat(64)}` as `sha256:${string}`;

export type Spec = {
  bridgeUnitId: string;
  sourceUnitKey: string;
  assetId: string;
  s: number;
  e: number;
  choice: boolean;
};

export const S1_LINE: Spec = {
  bridgeUnitId: "a06a6efc-b1f0-7483-b225-40f197a3bc83",
  sourceUnitKey: "reallive:scene-0001#0000",
  assetId: "df9fc555-e560-7887-a9d1-6c5b0ac311a4",
  s: 17,
  e: 21,
  choice: false,
};

export const S1_A: Spec = {
  bridgeUnitId: "9706a898-f08a-7ba9-99e6-c304e0235874",
  sourceUnitKey: "reallive:scene-0001#0001",
  assetId: "df9fc555-e560-7887-a9d1-6c5b0ac311a4",
  s: 29,
  e: 31,
  choice: true,
};

export const S1_B: Spec = {
  bridgeUnitId: "b43c7e66-a03e-713b-89cc-797c5ff9216f",
  sourceUnitKey: "reallive:scene-0001#0002",
  assetId: "df9fc555-e560-7887-a9d1-6c5b0ac311a4",
  s: 29,
  e: 31,
  choice: true,
};

export const S2_LINE: Spec = {
  bridgeUnitId: "d04f6e35-621e-78cf-80d0-1a3b0416db78",
  sourceUnitKey: "reallive:scene-0002#0000",
  assetId: "ca500bc0-3a3a-74ea-8273-341b123ec2c4",
  s: 17,
  e: 21,
  choice: false,
};

export const S2_A: Spec = {
  bridgeUnitId: "402c8867-cf61-7afa-a110-843c4f9fab53",
  sourceUnitKey: "reallive:scene-0002#0001",
  assetId: "ca500bc0-3a3a-74ea-8273-341b123ec2c4",
  s: 29,
  e: 31,
  choice: true,
};

export const S2_B: Spec = {
  bridgeUnitId: "84106326-5a71-737e-b369-b6a0ed46bf2a",
  sourceUnitKey: "reallive:scene-0002#0002",
  assetId: "ca500bc0-3a3a-74ea-8273-341b123ec2c4",
  s: 29,
  e: 31,
  choice: true,
};

export function unit(spec: Spec, index: number, routeMembership: string[]): NarrativeUnit {
  return {
    unitId: `unit-${spec.sourceUnitKey}`,
    bridgeRef: { bridgeUnitId: spec.bridgeUnitId, sourceUnitKey: spec.sourceUnitKey },
    surfaceKind: spec.choice ? "choice_label" : "dialogue",
    sourceText: "",
    characterId: null,
    evidenceTier: "E2",
    color: null,
    sourceAsset: { assetId: spec.assetId, assetKey: "" },
    engineEvidence: {
      reallive: {
        byteOffsetInScene: spec.s,
        byteLength: spec.e - spec.s,
        rawByteHandle: `handle-${index}`,
      },
    },
    choiceId: spec.choice ? `choice-${spec.sourceUnitKey}` : null,
    playOrder: index,
    revealOrder: null,
    observedLineIds: [],
    routeMembership,
  };
}

export function sceneRef(sceneId: number): string {
  return `scene:${String(sceneId).padStart(4, "0")}`;
}

export function scene(
  sceneId: number,
  specs: Spec[],
  nextScene: number | null,
  routes: string[],
): NarrativeScene {
  return {
    sceneId: sceneRef(sceneId),
    selectionControl: "none",
    nextScene: nextScene === null ? null : sceneRef(nextScene),
    messages: [],
    choices: [],
    units: specs.map((spec, index) => unit(spec, index, routes)),
  };
}

export function structure(scene2Routes: string[] = []): NarrativeStructure {
  return {
    schemaVersion: "utsushi.narrative-structure.v2",
    engine: "reallive",
    entryScene: sceneRef(1),
    sceneDispatchOrder: [sceneRef(1), sceneRef(2)],
    sourceBundleHash: BUNDLE_HASH,
    scenes: [
      scene(1, [S1_LINE, S1_A, S1_B], 2, []),
      scene(2, [S2_LINE, S2_A, S2_B], null, scene2Routes),
      {
        sceneId: sceneRef(3),
        selectionControl: "none",
        nextScene: null,
        messages: [],
        choices: [],
      },
    ],
  };
}

export const revision = (id: string): LlmRevisionRef => ({
  revisionId: id,
  contentHash: `sha256:${"0".repeat(63)}${id.length % 10}`,
});

export function makeContext(snapshot: FactSnapshot, revealHorizon: LlmRevealHorizon) {
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

export const ANALYST: ReadToolCaller = {
  roleId: "A1",
  routeVisibility: { kind: "global" },
  localeBranchId: null,
};

export const LOCALIZER: ReadToolCaller = {
  roleId: "P1",
  routeVisibility: { kind: "global" },
  localeBranchId: "locale-branch:1",
};

export function glossaryEntry(
  termId: string,
  occurrenceUnitIds: string[],
  scope: GlossaryFactValue["scope"] = { kind: "global" },
): GlossaryFactValue {
  return {
    kind: "glossary-entry",
    termId,
    sourceForm: "あい",
    aliases: [],
    forms: [{ language: "en-US", form: termId, status: "preferred" }],
    scope,
    occurrenceUnitIds,
    conflictsWithTermIds: [],
    revision: revision("glossary"),
  };
}

export function note(
  noteId: string,
  excerpt: string,
  scope: HumanNoteFactValue["scope"] = { kind: "global" },
): HumanNoteFactValue {
  return {
    kind: "human-note",
    noteId,
    excerpt,
    revision: revision("notes"),
    scope,
  };
}

export function baseModel(
  revealHorizon: LlmRevealHorizon = { kind: "complete" },
  scene2Routes: string[] = [],
): {
  model: ReadModel;
  snapshot: FactSnapshot;
} {
  const snapshot = buildFactSnapshot(structure(scene2Routes), loadBundle());
  const s1Line = snapshot.orderedUnits.find((u) => u.bridgeUnitId === S1_LINE.bridgeUnitId)!;
  const s1LineId = s1Line.factId;
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
        {
          ...acceptedOutputExample,
          subjectId: s1LineId,
          sourceHash: s1Line.sourceHash,
          localizationSnapshotId: LOCALIZATION_ID,
        },
      ],
    },
  });
  return { model, snapshot };
}

export function factIdAtPlayOrder(snapshot: FactSnapshot, playOrderIndex: number): string {
  return snapshot.orderedUnits.find((u) => u.playReveal.playOrderIndex === playOrderIndex)!.factId;
}

export function characterStructure(): NarrativeStructure {
  const base = structure();
  base.scenes[0]!.messages = [
    { order: 0, speaker: "あい", characterId: "nam-17", text: "あい", textSurface: "あい" },
    { order: 1, speaker: "あい", characterId: "nam-17", text: "あ", textSurface: "あ" },
  ];
  return base;
}

export type PagedToolResult = {
  snapshotId: string;
  resultHash: string;
  page: {
    maxRows: number;
    maxBytes: number;
    kind: "complete" | "more";
    nextCursor: string | null;
  };
};

export function resultItems(
  result: PagedToolResult,
  key: "facts" | "outputs" | "hits",
): LlmJsonValue[] {
  return (result as Record<string, unknown>)[key] as LlmJsonValue[];
}

export function assertStrictPagedSurface(input: {
  unpaged: () => PagedToolResult;
  paged: (cursor: string | undefined) => PagedToolResult;
  tooSmall: () => unknown;
  key: "facts" | "outputs" | "hits";
  snapshotId: string;
}): void {
  const full = input.unpaged();
  const repeated = input.unpaged();
  expect(full.snapshotId).toBe(input.snapshotId);
  expect(full.resultHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(full.page.kind).toBe("complete");
  expect(canonicalLlmJson(resultItems(full, input.key))).toBe(
    canonicalLlmJson(resultItems(repeated, input.key)),
  );

  const pages: LlmJsonValue[][] = [];
  let cursor: string | undefined;
  let firstPage: PagedToolResult | undefined;
  do {
    const page = input.paged(cursor);
    firstPage ??= page;
    expect(page.snapshotId).toBe(input.snapshotId);
    expect(page.resultHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(page.page.maxRows).toBe(1);
    expect(page.page.maxBytes).toBe(8_388_608);
    pages.push(resultItems(page, input.key));
    cursor = page.page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  expect(canonicalLlmJson(pages.flat())).toBe(canonicalLlmJson(resultItems(full, input.key)));
  if (resultItems(full, input.key).length > 1) {
    expect(firstPage!.page.kind).toBe("more");
    expect(firstPage!.page.nextCursor).not.toBeNull();
  }
  expect(input.tooSmall).toThrow(/row-exceeds-byte-budget/u);
}

export function characterModelForStrictProof(): { model: ReadModel; snapshot: FactSnapshot } {
  const snapshot = buildFactSnapshot(characterStructure(), loadBundle());
  const unitId = factIdAtPlayOrder(snapshot, 0);
  const model = buildReadModel({
    contextSnapshot: makeContext(snapshot, { kind: "complete" }),
    factSnapshot: snapshot,
    bundle: loadBundle(),
    characterProfiles: new Map([
      ["nam-17", { decodedLabel: "Ai", revealStatus: "revealed" as const, unitIds: [unitId] }],
    ]),
  });
  return { model, snapshot };
}
