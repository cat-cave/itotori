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
    acceptedDraftCount: 25,
    deferredCount: 0,
    failureCount: 0,
    ...overrides,
  };
}

describe("whole-game patch coverage gate", () => {
  it("refuses partial coverage by default and carries the report counts", () => {
    const report = coverage({
      unitsRun: 5,
      acceptedDraftCount: 4,
      deferredCount: 1,
      failureCount: 0,
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
        acceptedDraftCount: 4,
        deferredCount: 1,
        failureCount: 0,
      });
      expect((error as Error).message).toContain("--allow-partial-patch");
    }
  });

  it("allows partial coverage when explicitly producing a preview patch", () => {
    expect(() => assertWholeGamePatchCoverage(coverage({ unitsRun: 5 }), true)).not.toThrow();
  });

  it("allows complete coverage with the strict default", () => {
    expect(() => assertWholeGamePatchCoverage(coverage(), false)).not.toThrow();
  });
});
