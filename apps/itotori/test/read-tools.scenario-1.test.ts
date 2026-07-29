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

import {
  loadBundle,
  BUNDLE_HASH,
  LOCALIZATION_ID,
  Spec,
  S1_LINE,
  S1_A,
  S1_B,
  S2_LINE,
  S2_A,
  S2_B,
  unit,
  sceneRef,
  scene,
  structure,
  revision,
  makeContext,
  ANALYST,
  LOCALIZER,
  glossaryEntry,
  note,
  baseModel,
  factIdAtPlayOrder,
  characterStructure,
  PagedToolResult,
  resultItems,
  assertStrictPagedSurface,
  characterModelForStrictProof,
} from "./read-tools.support.js";

describe("read tools — seven-tool strict envelope proof", () => {
  it("proves deterministic envelopes, explicit cursor pages, and byte-identical reassembly per tool", () => {
    const { model, snapshot } = baseModel();
    const { model: characterReadModel } = characterModelForStrictProof();
    const anchor = factIdAtPlayOrder(snapshot, 3);
    const subject = factIdAtPlayOrder(snapshot, 0);

    assertStrictPagedSurface({
      snapshotId: model.snapshotId,
      key: "facts",
      unpaged: () =>
        decodeGetUnits(model, ANALYST, {
          selector: { kind: "all" },
          maxRows: 100,
          maxBytes: 8_388_608,
        }),
      paged: (cursor) =>
        decodeGetUnits(model, ANALYST, {
          selector: { kind: "all" },
          maxRows: 1,
          maxBytes: 8_388_608,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      tooSmall: () =>
        decodeGetUnits(model, ANALYST, { selector: { kind: "all" }, maxRows: 1, maxBytes: 1 }),
    });
    assertStrictPagedSurface({
      snapshotId: model.snapshotId,
      key: "facts",
      unpaged: () =>
        decodeGetNeighbors(model, LOCALIZER, {
          anchorUnitIds: [anchor],
          before: 1,
          after: 1,
          maxRows: 100,
          maxBytes: 8_388_608,
        }),
      paged: (cursor) =>
        decodeGetNeighbors(model, LOCALIZER, {
          anchorUnitIds: [anchor],
          before: 1,
          after: 1,
          maxRows: 1,
          maxBytes: 8_388_608,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      tooSmall: () =>
        decodeGetNeighbors(model, LOCALIZER, {
          anchorUnitIds: [anchor],
          before: 1,
          after: 1,
          maxRows: 1,
          maxBytes: 1,
        }),
    });
    assertStrictPagedSurface({
      snapshotId: model.snapshotId,
      key: "facts",
      unpaged: () => decodeGetRouteGraph(model, ANALYST, { maxRows: 100, maxBytes: 8_388_608 }),
      paged: (cursor) =>
        decodeGetRouteGraph(model, ANALYST, {
          maxRows: 1,
          maxBytes: 8_388_608,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      tooSmall: () => decodeGetRouteGraph(model, ANALYST, { maxRows: 1, maxBytes: 1 }),
    });
    assertStrictPagedSurface({
      snapshotId: characterReadModel.snapshotId,
      key: "facts",
      unpaged: () =>
        decodeGetCharacterOccurrences(characterReadModel, ANALYST, {
          characterId: "nam-17",
          maxRows: 100,
          maxBytes: 8_388_608,
        }),
      paged: (cursor) =>
        decodeGetCharacterOccurrences(characterReadModel, ANALYST, {
          characterId: "nam-17",
          maxRows: 1,
          maxBytes: 8_388_608,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      tooSmall: () =>
        decodeGetCharacterOccurrences(characterReadModel, ANALYST, {
          characterId: "nam-17",
          maxRows: 1,
          maxBytes: 1,
        }),
    });
    assertStrictPagedSurface({
      snapshotId: model.snapshotId,
      key: "facts",
      unpaged: () =>
        glossaryLookup(model, LOCALIZER, {
          selector: { kind: "all" },
          maxRows: 100,
          maxBytes: 8_388_608,
        }),
      paged: (cursor) =>
        glossaryLookup(model, LOCALIZER, {
          selector: { kind: "all" },
          maxRows: 1,
          maxBytes: 8_388_608,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      tooSmall: () =>
        glossaryLookup(model, LOCALIZER, {
          selector: { kind: "all" },
          maxRows: 1,
          maxBytes: 1,
        }),
    });
    assertStrictPagedSurface({
      snapshotId: model.snapshotId,
      key: "outputs",
      unpaged: () =>
        outputsGetAccepted(model, LOCALIZER, {
          subjectIds: [subject],
          maxRows: 100,
          maxBytes: 8_388_608,
        }),
      paged: (cursor) =>
        outputsGetAccepted(model, LOCALIZER, {
          subjectIds: [subject],
          maxRows: 1,
          maxBytes: 8_388_608,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      tooSmall: () =>
        outputsGetAccepted(model, LOCALIZER, {
          subjectIds: [subject],
          maxRows: 1,
          maxBytes: 1,
        }),
    });
    assertStrictPagedSurface({
      snapshotId: model.snapshotId,
      key: "hits",
      unpaged: () =>
        referencesSearch(model, LOCALIZER, {
          query: "register direct",
          maxRows: 100,
          maxBytes: 8_388_608,
        }),
      paged: (cursor) =>
        referencesSearch(model, LOCALIZER, {
          query: "register direct",
          maxRows: 1,
          maxBytes: 8_388_608,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      tooSmall: () =>
        referencesSearch(model, LOCALIZER, {
          query: "register direct",
          maxRows: 1,
          maxBytes: 1,
        }),
    });
  });

  it("rejects extra arguments for every local read tool", () => {
    const { model, snapshot } = baseModel();
    const { model: characterReadModel } = characterModelForStrictProof();
    const anchor = factIdAtPlayOrder(snapshot, 3);
    const subject = factIdAtPlayOrder(snapshot, 0);
    const calls = [
      () =>
        decodeGetUnits(model, ANALYST, {
          selector: { kind: "all" },
          maxRows: 1,
          maxBytes: 100_000,
          extra: true,
        }),
      () =>
        decodeGetNeighbors(model, LOCALIZER, {
          anchorUnitIds: [anchor],
          before: 0,
          after: 0,
          maxRows: 1,
          maxBytes: 100_000,
          extra: true,
        }),
      () => decodeGetRouteGraph(model, ANALYST, { maxRows: 1, maxBytes: 100_000, extra: true }),
      () =>
        decodeGetCharacterOccurrences(characterReadModel, ANALYST, {
          characterId: "nam-17",
          maxRows: 1,
          maxBytes: 100_000,
          extra: true,
        }),
      () =>
        glossaryLookup(model, LOCALIZER, {
          selector: { kind: "all" },
          maxRows: 1,
          maxBytes: 100_000,
          extra: true,
        }),
      () =>
        outputsGetAccepted(model, LOCALIZER, {
          subjectIds: [subject],
          maxRows: 1,
          maxBytes: 100_000,
          extra: true,
        }),
      () =>
        referencesSearch(model, LOCALIZER, {
          query: "register",
          maxRows: 1,
          maxBytes: 100_000,
          extra: true,
        }),
    ];
    for (const call of calls) expect(call).toThrow(/unknown-argument/u);
  });
});

describe("read tools — route, reveal, and branch boundaries beyond unit scans", () => {
  it("does not leak route-scoped graph, glossary, accepted-unit, or reference data", () => {
    const { model, snapshot } = baseModel({ kind: "complete" }, ["route-b"]);
    const routedModel: ReadModel = {
      ...model,
      references: [
        ...model.references,
        note("note:route-b", "branch secret", { kind: "route", routeId: "route-b" }),
      ],
      localization: {
        ...model.localization!,
        glossaryEntries: [
          ...model.localization!.glossaryEntries,
          glossaryEntry("term:route-b", [factIdAtPlayOrder(snapshot, 3)], {
            kind: "route",
            routeId: "route-b",
          }),
        ],
      },
    };
    const routeA: ReadToolCaller = {
      roleId: "P1",
      routeVisibility: { kind: "route", routeId: "route-a" },
      localeBranchId: "locale-branch:1",
    };
    const routeAGraphCaller: ReadToolCaller = { ...routeA, roleId: "A1" };
    const hiddenUnit = factIdAtPlayOrder(snapshot, 3);

    const graph = decodeGetRouteGraph(routedModel, routeAGraphCaller, {
      maxRows: 100,
      maxBytes: 8_388_608,
    });
    expect(graph.facts.some((fact) => fact.factId === "scene:scene:0002")).toBe(false);
    expect(
      glossaryLookup(routedModel, routeA, {
        selector: { kind: "all" },
        maxRows: 100,
        maxBytes: 8_388_608,
      }).facts.map((fact) => fact.value.termId),
    ).not.toContain("term:route-b");
    expect(() =>
      glossaryLookup(routedModel, routeA, {
        selector: { kind: "term-ids", termIds: ["term:route-b"] },
        maxRows: 1,
        maxBytes: 8_388_608,
      }),
    ).toThrow(/out-of-route/u);
    expect(() =>
      outputsGetAccepted(routedModel, routeA, {
        subjectIds: [hiddenUnit],
        maxRows: 1,
        maxBytes: 8_388_608,
      }),
    ).toThrow(/out-of-route/u);
    expect(
      referencesSearch(routedModel, routeA, {
        query: "branch secret",
        maxRows: 100,
        maxBytes: 8_388_608,
      }).hits,
    ).toEqual([]);
  });

  it("hides future route-graph nodes and rejects future accepted-unit reads", () => {
    const { model, snapshot } = baseModel({ kind: "through-play-order", playOrderIndex: 0 });
    const graph = decodeGetRouteGraph(model, ANALYST, { maxRows: 100, maxBytes: 8_388_608 });
    expect(graph.facts.some((fact) => fact.factId === "scene:scene:0002")).toBe(false);
    expect(() =>
      outputsGetAccepted(model, LOCALIZER, {
        subjectIds: [factIdAtPlayOrder(snapshot, 3)],
        maxRows: 1,
        maxBytes: 8_388_608,
      }),
    ).toThrow(/beyond-reveal-horizon/u);
    const wrongBranch: ReadToolCaller = { ...LOCALIZER, localeBranchId: "locale-branch:other" };
    expect(() =>
      outputsGetAccepted(model, wrongBranch, {
        subjectIds: [factIdAtPlayOrder(snapshot, 0)],
        maxRows: 1,
        maxBytes: 8_388_608,
      }),
    ).toThrow(/locale-branch-mismatch/u);
  });
});
