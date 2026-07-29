import { canonicalLlmJson } from "@itotori/db";

import { describe, expect, it } from "vitest";

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
import { buildFactSnapshot, type FactSnapshot } from "../src/prepass/index.js";

import {
  loadBundle,
  S1_LINE,
  S2_LINE,
  sceneRef,
  structure,
  revision,
  makeContext,
  ANALYST,
  LOCALIZER,
  baseModel,
  factIdAtPlayOrder,
  characterStructure,
} from "./read-tools.support.js";

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
        selector: { kind: "scene", sceneId: sceneRef(1) },
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
    const other = buildFactSnapshot({ ...structure(), entryScene: sceneRef(2) }, loadBundle());
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
    const wrong = buildFactSnapshot({ ...structure(), entryScene: sceneRef(2) }, loadBundle());
    expect(() =>
      buildReadModel({
        contextSnapshot: makeContext(wrong, { kind: "complete" }),
        factSnapshot: snapshot,
        bundle: loadBundle(),
      }),
    ).toThrowError(ReadToolError);
  });

  it("rejects a fact snapshot whose unit cites a scene outside the snapshot", () => {
    const snapshot = buildFactSnapshot(structure(), loadBundle());
    const malformed = {
      ...snapshot,
      orderedUnits: snapshot.orderedUnits.map((unit, index) =>
        index === 0 ? { ...unit, sceneId: "scene:missing" } : unit,
      ),
    };

    expect(() =>
      buildReadModel({
        contextSnapshot: makeContext(snapshot, { kind: "complete" }),
        factSnapshot: malformed,
        bundle: loadBundle(),
      }),
    ).toThrowError(/unit .* cites unknown scene scene:missing/u);
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
