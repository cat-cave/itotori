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

describe("P1 whole-scene localizer — exactness guards", () => {
  const units = [0, 1, 2].map((index) => unitFact(index));
  const scene = normalizeScene(units);

  it("rejects a wrong source hash, a missing unit, and a reordering", () => {
    const good = wholeSceneBatch("6010", units).drafts;
    expect(() => assertExactAgainstSource(scene.units, good)).not.toThrow();

    const wrongHash = [{ ...good[0]!, sourceHash: `sha256:${"0".repeat(64)}` }, good[1]!, good[2]!];
    expect(() => assertExactAgainstSource(scene.units, wrongHash)).toThrow(/source-hash/u);

    expect(() => assertExactAgainstSource(scene.units, [good[0]!, good[1]!])).toThrow(
      /unit-cardinality/u,
    );

    const reordered = [good[1]!, good[0]!, good[2]!];
    expect(() => assertExactAgainstSource(scene.units, reordered)).toThrow(/unit-order/u);
  });

  it("fails loud when a single unit exceeds the whole context budget", () => {
    const big = normalizeScene([unitFact(0, { skeleton: pad("big", 200) })]);
    expect(() => planSceneLocalization(big, { budgetBytes: 50, overlapUnits: 1 })).toThrow(
      PlanError,
    );
  });
});

// End-to-end rejection tests: malformed / forged inputs travel the SAME public
// entry (localizeScene / dispatchLocalizerCall) a real caller uses, and the run
// is refused BEFORE any tainted or mis-routed request reaches the wire.
