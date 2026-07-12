import { describe, expect, it } from "vitest";
import {
  assertWholeGamePatchCoverage,
  WholeGamePatchCoverageRefusedError,
  type WholeGamePatchCoverage,
} from "../src/orchestrator/localize-fullproject-cli.js";

function coverage(overrides: Partial<WholeGamePatchCoverage> = {}): WholeGamePatchCoverage {
  return {
    unitsInScope: 25,
    unitsRun: 25,
    writtenOutcomeCount: 25,
    failureCount: 0,
    coverageComplete: true,
    ...overrides,
  };
}

describe("whole-game patch coverage gate", () => {
  it("refuses incomplete written coverage and carries the canonical report counts", () => {
    const report = coverage({
      unitsRun: 5,
      writtenOutcomeCount: 5,
      failureCount: 0,
      coverageComplete: false,
    });

    expect(() => assertWholeGamePatchCoverage(report, false)).toThrow(
      WholeGamePatchCoverageRefusedError,
    );
    try {
      assertWholeGamePatchCoverage(report, false);
      throw new Error("expected partial coverage to be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(WholeGamePatchCoverageRefusedError);
      expect(error).toMatchObject({
        unitsInScope: 25,
        unitsRun: 5,
        writtenOutcomeCount: 5,
        failureCount: 0,
        coverageComplete: false,
      });
      expect((error as Error).message).toContain("complete written coverage");
    }
  });

  it("does not waive an incomplete configured scope with --allow-partial-patch", () => {
    expect(() =>
      assertWholeGamePatchCoverage(
        coverage({ unitsRun: 5, writtenOutcomeCount: 5, coverageComplete: false }),
        true,
      ),
    ).toThrow(WholeGamePatchCoverageRefusedError);
  });

  it("allows complete coverage with the strict default", () => {
    expect(() => assertWholeGamePatchCoverage(coverage(), false)).not.toThrow();
  });
});
