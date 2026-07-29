import { describe, expect, it } from "vitest";
import {
  assertBridgeBundleV02,
  assertDeltaPackageMetadataV02,
  assertPatchExportV02,
  assertPermissionLocalUserFixtureV02,
} from "../src/index.js";
import {
  MIN_COMMITTED_FIXTURES_PER_INVARIANT,
  MUTATION_CASES,
  MUTATION_SURVIVOR_THRESHOLD,
  REQUIRED_MUTATION_INVARIANTS,
} from "./mutation-thresholds.js";
import type { MutationCase, MutationInvariant } from "./mutation-thresholds.js";
import { exampleFixture } from "./schema-test-helpers.js";

// UNIV-011 — mutation-survivor guard.
//
// Each committed invalid fixture is a deliberately-mutated-invalid input that
// its validator MUST reject with a specific diagnostic. A "survivor" is any
// mutation the validator fails to reject (or rejects with the wrong
// diagnostic) — a coverage gap. The guard requires zero survivors across the
// selected schema / delta / protected-span / permission invariants, and a
// failure names the invariant, fixture, and mutation for direct action.
describe("mutation-survivor guard", () => {
  const VALIDATORS: Record<string, (value: unknown) => void> = {
    assertBridgeBundleV02: assertBridgeBundleV02,
    assertDeltaPackageMetadataV02: assertDeltaPackageMetadataV02,
    assertPatchExportV02: assertPatchExportV02,
    assertPermissionLocalUserFixtureV02: assertPermissionLocalUserFixtureV02,
  };

  function runMutationCase(mutationCase: MutationCase): {
    survived: boolean;
    reason: string;
  } {
    const validator = VALIDATORS[mutationCase.validator];
    if (validator === undefined) {
      return {
        survived: true,
        reason: `no validator registered under name ${mutationCase.validator}`,
      };
    }
    const fixture = exampleFixture(mutationCase.fixture);
    let thrown: unknown;
    try {
      validator(fixture);
    } catch (error) {
      thrown = error;
    }
    if (thrown === undefined) {
      return {
        survived: true,
        reason: `${mutationCase.validator} ACCEPTED the mutated fixture (expected a throw matching ${String(mutationCase.expectedDiagnostic)})`,
      };
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    if (!mutationCase.expectedDiagnostic.test(message)) {
      return {
        survived: true,
        reason: `${mutationCase.validator} rejected the mutated fixture but with diagnostic ${JSON.stringify(message)} that does not match ${String(mutationCase.expectedDiagnostic)}`,
      };
    }
    return { survived: false, reason: "" };
  }

  it("covers every required invariant with at least one committed fixture", () => {
    const byInvariant = new Map<MutationInvariant, number>();
    for (const mutationCase of MUTATION_CASES) {
      byInvariant.set(mutationCase.invariant, (byInvariant.get(mutationCase.invariant) ?? 0) + 1);
    }
    for (const invariant of REQUIRED_MUTATION_INVARIANTS) {
      expect(
        byInvariant.get(invariant) ?? 0,
        `invariant ${invariant} must have >= ${MIN_COMMITTED_FIXTURES_PER_INVARIANT} committed mutation fixture(s)`,
      ).toBeGreaterThanOrEqual(MIN_COMMITTED_FIXTURES_PER_INVARIANT);
    }
  });

  it.each(MUTATION_CASES.map((mutationCase) => ({ mutationCase })))(
    "rejects $mutationCase.id ($mutationCase.invariant)",
    ({ mutationCase }) => {
      const outcome = runMutationCase(mutationCase);
      expect(
        outcome.survived,
        `mutation survivor [${mutationCase.invariant}] ${mutationCase.id}: ${mutationCase.mutation} — ${outcome.reason}`,
      ).toBe(false);
    },
  );

  it("has zero surviving mutations across all selected invariants", () => {
    const survivors = MUTATION_CASES.map((mutationCase) => ({
      mutationCase,
      outcome: runMutationCase(mutationCase),
    })).filter((entry) => entry.outcome.survived);

    const report = survivors
      .map(
        (entry) =>
          `  - [${entry.mutationCase.invariant}] ${entry.mutationCase.id}: ${entry.mutationCase.mutation} — ${entry.outcome.reason}`,
      )
      .join("\n");

    expect(
      survivors.length,
      survivors.length === 0
        ? "no surviving mutations"
        : `mutation survivors detected (validators failed to catch these deliberate mutations):\n${report}`,
    ).toBe(MUTATION_SURVIVOR_THRESHOLD);
  });
});
