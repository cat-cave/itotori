import { describe, expect, it } from "vitest";
import { localizeScene } from "../src/roles/p1/index.js";
import {
  BASE,
  BIBLE,
  draftBatchResponse,
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
