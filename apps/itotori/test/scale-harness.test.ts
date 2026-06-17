import { describe, expect, it } from "vitest";
import {
  assertScaleBudgets,
  evaluateScaleBudgets,
  planDraftBatches,
  type DraftPlanningUnit,
} from "../src/services/scale-harness.js";

describe("scale harness utilities", () => {
  it("plans draft batches by unit count and source character budgets", () => {
    const plan = planDraftBatches(units(["あいう", "かきく", "さしす", "たちつ"]), {
      maxUnitsPerBatch: 2,
      maxSourceCharactersPerBatch: 7,
    });

    expect(plan).toMatchObject({
      totalUnits: 4,
      totalSourceCharacters: 12,
      oversizedUnitCount: 0,
    });
    expect(plan.batches).toEqual([
      expect.objectContaining({
        startIndex: 0,
        endIndexExclusive: 2,
        unitCount: 2,
        sourceCharacterCount: 6,
      }),
      expect.objectContaining({
        startIndex: 2,
        endIndexExclusive: 4,
        unitCount: 2,
        sourceCharacterCount: 6,
      }),
    ]);
  });

  it("keeps oversized units explicit instead of dropping or splitting them implicitly", () => {
    const plan = planDraftBatches(units(["短い", "これはとても長い文です", "次"]), {
      maxUnitsPerBatch: 5,
      maxSourceCharactersPerBatch: 5,
    });

    expect(plan.oversizedUnitCount).toBe(1);
    expect(plan.batches).toEqual([
      expect.objectContaining({ startIndex: 0, endIndexExclusive: 1, oversized: false }),
      expect.objectContaining({ startIndex: 1, endIndexExclusive: 2, oversized: true }),
      expect.objectContaining({ startIndex: 2, endIndexExclusive: 3, oversized: false }),
    ]);
  });

  it("reports budget failures with operation names and measured overages", () => {
    const evaluation = evaluateScaleBudgets(
      [
        { operation: "importIndex", elapsedMs: 50 },
        { operation: "dashboardStatus", elapsedMs: 101 },
      ],
      { importIndex: 100, dashboardStatus: 100 },
    );

    expect(evaluation.passed).toBe(false);
    expect(evaluation.failures).toEqual([
      expect.objectContaining({ operation: "dashboardStatus", elapsedMs: 101, budgetMs: 100 }),
    ]);
    expect(() => assertScaleBudgets(evaluation)).toThrow(
      "scale budget exceeded: dashboardStatus 101.0ms > 100ms",
    );
  });

  it("fails when a configured budgeted operation was not measured", () => {
    expect(() =>
      evaluateScaleBudgets([{ operation: "importIndex", elapsedMs: 50 }], {
        importIndex: 100,
        dashboardStatus: 100,
      }),
    ).toThrow("missing scale measurement for budgeted operation dashboardStatus");
  });
});

function units(sourceTexts: string[]): DraftPlanningUnit[] {
  return sourceTexts.map((sourceText, index) => ({
    bridgeUnitId: `unit-${index + 1}`,
    sourceText,
  }));
}
