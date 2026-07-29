import { describe, expect, it } from "vitest";
import type { DraftBatch } from "../src/contracts/index.js";
import { localizeScene, LocalizeError } from "../src/roles/p1/index.js";
import {
  BASE,
  draftBatchResponse,
  installedBibleRendering,
  recordedRuntime,
  unitFact,
  wholeSceneBatch,
  type Captured,
} from "./p1-whole-scene-localizer-test-support.js";

describe("P1 whole-scene localizer — installed bible citations", () => {
  const units = [unitFact(0), unitFact(1)];
  const sceneBible = ["rendering:unit-0", "rendering:unit-1"] as const;
  const unitBible = units.map((unit, index) => ({
    unitId: unit.value.unitId,
    renderings: [installedBibleRendering(sceneBible[index]!)],
  }));

  async function localize(batch: DraftBatch, captured: Captured[]) {
    return await localizeScene(
      {
        ...BASE,
        units,
        bibleRenderingIds: sceneBible,
        unitBible,
        budgetBytes: 10_000,
        overlapUnits: 1,
      },
      recordedRuntime([draftBatchResponse(batch)], captured),
    );
  }

  it("rejects a stale per-unit bible citation and aborts without accepting a draft", async () => {
    const good = wholeSceneBatch("6010", units);
    const stale = {
      ...good,
      drafts: good.drafts.map((draft, index) => ({
        ...draft,
        basis: {
          kind: "wiki-first" as const,
          bibleRenderingIds: [index === 0 ? "rendering:stale" : sceneBible[index]!],
        },
      })),
    } as DraftBatch;
    const captured: Captured[] = [];
    const rejected = localize(stale, captured);

    await expect(rejected).rejects.toBeInstanceOf(LocalizeError);
    await expect(rejected).rejects.toMatchObject({ code: "bible-context" });
    // The untrusted batch reached P1 once, but localizeScene returned no accepted draft.
    expect(captured).toHaveLength(1);
  });

  it("rejects a non-wiki-first basis and aborts without accepting a draft", async () => {
    const good = wholeSceneBatch("6010", units);
    const ablation = {
      ...good,
      drafts: good.drafts.map((draft) => ({
        ...draft,
        basis: { kind: "pure-mtl-ablation" as const, bibleRenderingIds: [] },
      })),
    } as DraftBatch;
    const captured: Captured[] = [];
    const rejected = localize(ablation, captured);

    await expect(rejected).rejects.toBeInstanceOf(LocalizeError);
    await expect(rejected).rejects.toMatchObject({ code: "bible-context" });
    expect(captured).toHaveLength(1);
  });

  it("accepts drafts citing each unit's exact resolved bible subset", async () => {
    const good = wholeSceneBatch("6010", units);
    const exactSubset = {
      ...good,
      drafts: good.drafts.map((draft, index) => ({
        ...draft,
        basis: { kind: "wiki-first" as const, bibleRenderingIds: [sceneBible[index]!] },
      })),
    } as DraftBatch;
    const captured: Captured[] = [];

    const result = await localize(exactSubset, captured);

    expect(result.finalizedDrafts.map((draft) => draft.unitId)).toEqual(
      units.map((unit) => unit.value.unitId),
    );
    expect(captured).toHaveLength(1);
  });

  it("accepts the advertised scene-wide bible union as a citation superset", async () => {
    const good = wholeSceneBatch("6010", units);
    const unionEcho = {
      ...good,
      drafts: good.drafts.map((draft) => ({
        ...draft,
        basis: { kind: "wiki-first" as const, bibleRenderingIds: [...sceneBible] },
      })),
    } as DraftBatch;
    const captured: Captured[] = [];

    const result = await localize(unionEcho, captured);

    expect(result.finalizedDrafts).toHaveLength(units.length);
    expect(captured).toHaveLength(1);
  });

  it("rejects wiki-first direct calls that omit every per-unit bible binding", async () => {
    const good = wholeSceneBatch("6010", units);
    const captured: Captured[] = [];

    await expect(
      localizeScene(
        {
          ...BASE,
          units,
          bibleRenderingIds: sceneBible,
          budgetBytes: 10_000,
          overlapUnits: 1,
        },
        recordedRuntime([draftBatchResponse(good)], captured),
      ),
    ).rejects.toMatchObject({ code: "bible-context" });
    expect(captured).toHaveLength(0);
  });
});
