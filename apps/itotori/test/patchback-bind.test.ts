// Proof: the accepted-output <-> scoped-unit binding is exactly-one-per-unit,
// source-hash-matched, and fails loud on every inconsistency. If any of these
// guards is removed, a case here fails.

import { describe, expect, it } from "vitest";

import { bindScopedTargets, PatchbackBindingError } from "../src/patchback/index.js";
import type { NativePatchbackInput } from "../src/patchback/index.js";
import { makeAccepted, makeSnapshot, makeUnit } from "./support/gate-fixtures.js";

const unitA = makeUnit({ factId: "unit:a", sourceUnitKey: "reallive:scene-0001#0000" });
const unitB = makeUnit({
  factId: "unit:b",
  sourceUnitKey: "reallive:scene-0001#0001",
  surfaceKind: "choice_label",
  linkKind: "choice",
  sourceHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
});

function input(overrides: Partial<NativePatchbackInput>): NativePatchbackInput {
  return {
    snapshot: makeSnapshot({ units: [unitA, unitB] }),
    accepted: [makeAccepted(unitA, "Hello"), makeAccepted(unitB, "Yes")],
    rawBridge: {},
    workScope: { inScopeUnitFactIds: [unitA.factId, unitB.factId] },
    sourceLocale: "ja-JP",
    targetLocale: "en-US",
    ...overrides,
  };
}

describe("bindScopedTargets", () => {
  it("binds exactly one source-hash-matched target per scoped unit", () => {
    const bound = bindScopedTargets(input({}));
    expect(bound.map((b) => b.fact.factId)).toEqual(["unit:a", "unit:b"]);
    expect(bound.map((b) => b.targetText)).toEqual(["Hello", "Yes"]);
    for (const b of bound) expect(b.accepted.sourceHash).toBe(b.fact.sourceHash);
  });

  it("rejects partial coverage — a scoped unit with no accepted target", () => {
    const err = grab(() => bindScopedTargets(input({ accepted: [makeAccepted(unitA, "Hello")] })));
    expect(err.code).toBe("no-accepted-target");
    expect(err.unitFactIds).toContain("unit:b");
  });

  it("rejects two accepted outputs claiming the same unit", () => {
    const err = grab(() =>
      bindScopedTargets(
        input({
          accepted: [
            makeAccepted(unitA, "Hello", { outputId: "output:a1" }),
            makeAccepted(unitA, "Hi", { outputId: "output:a2" }),
            makeAccepted(unitB, "Yes"),
          ],
        }),
      ),
    );
    expect(err.code).toBe("duplicate-accepted-target");
  });

  it("rejects a target whose source hash differs from the snapshot fact", () => {
    const stale = makeAccepted(unitB, "Yes", {
      sourceHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    });
    const err = grab(() =>
      bindScopedTargets(input({ accepted: [makeAccepted(unitA, "Hello"), stale] })),
    );
    expect(err.code).toBe("source-hash-mismatch");
    expect(err.unitFactIds).toEqual(["unit:b"]);
  });

  it("rejects an accepted output naming a subject absent from the snapshot", () => {
    const ghost = makeUnit({ factId: "unit:ghost" });
    const err = grab(() =>
      bindScopedTargets(
        input({
          accepted: [
            makeAccepted(unitA, "Hello"),
            makeAccepted(unitB, "Yes"),
            makeAccepted(ghost, "x"),
          ],
        }),
      ),
    );
    expect(err.code).toBe("accepted-subject-not-in-snapshot");
  });

  it("rejects a work scope naming a unit absent from the snapshot", () => {
    const err = grab(() =>
      bindScopedTargets(
        input({ workScope: { inScopeUnitFactIds: [unitA.factId, "unit:missing"] } }),
      ),
    );
    expect(err.code).toBe("unknown-scoped-unit");
  });

  it("rejects an empty work scope", () => {
    const err = grab(() => bindScopedTargets(input({ workScope: { inScopeUnitFactIds: [] } })));
    expect(err.code).toBe("empty-scope");
  });
});

function grab(fn: () => unknown): PatchbackBindingError {
  try {
    fn();
  } catch (error) {
    if (error instanceof PatchbackBindingError) return error;
    throw error;
  }
  throw new Error("expected a PatchbackBindingError");
}
