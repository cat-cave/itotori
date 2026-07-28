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

describe("P1 whole-scene localizer — prior accepted target thread", () => {
  it("continues the thread with prior accepted target supplied through localizeScene", async () => {
    const units = [0, 1].map((index) => unitFact(index));
    // Prior accepted target for an in-prompt unit, from the trusted accepted-
    // output store. A plain typed value — no provenance proof, just substrate.
    const prior = [{ unitId: "unit:6010:0", targetSkeleton: "EN>ACCEPTED-PRIOR-TARGET" }];
    const captured: Captured[] = [];
    const result = await localizeScene(
      {
        ...BASE,
        units,
        bibleRenderingIds: BIBLE,
        priorAcceptedTarget: prior,
        budgetBytes: 10_000,
        overlapUnits: 1,
      },
      recordedRuntime([draftBatchResponse(wholeSceneBatch("6010", units))], captured),
    );
    expect(result.finalizedDrafts.map((d) => d.unitId)).toEqual(units.map((u) => u.value.unitId));
    // The prior accepted target continues the author thread on the wire.
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured[0])).toContain("ACCEPTED-PRIOR-TARGET");
  });
});
