import {
  LlmMemoConflictError,
  LlmRetriesExhaustedError,
  type LlmCallMemoStore,
  type LlmMemoSingleflightInput,
  type LlmMemoSingleflightResult,
} from "@itotori/db";
import { describe, expect, it } from "vitest";
import {
  FACT_SCHEMA_VERSION,
  DRAFT_BATCH_SCHEMA_VERSION,
  LocalizedRenderingSchema,
  type DraftBatch,
  type UnitFact,
} from "../src/contracts/index.js";
import { sha256 } from "../src/llm/canonical-json.js";
import { deepSeekV4FlashProfile } from "../src/llm/role-model-profiles.js";
import type { MeasuredModelProfile } from "../src/llm/physical-attempt-policy.js";
import type { LocalizerRuntimeBase } from "../src/roles/p1/index.js";
import {
  assembleFinalizedDrafts,
  assertExactAgainstSource,
  assertPlaceholdersPreserved,
  buildLocalizerCall,
  dispatchLocalizerCall,
  localizeScene,
  LocalizeError,
  MAX_P1_CORE_UNITS_PER_REQUEST,
  normalizeScene,
  planSceneLocalization,
  FinalizeError,
  PlanError,
} from "../src/roles/p1/index.js";
import { specialistFor } from "../src/roster/index.js";
import { localizedRenderingExample } from "./contract-fixtures-core.js";
import {
  BASE,
  BIBLE,
  CTX,
  LOC,
  SCHEMA,
  chunkBatch,
  draftBatchResponse,
  installedBibleRendering,
  pad,
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
});
