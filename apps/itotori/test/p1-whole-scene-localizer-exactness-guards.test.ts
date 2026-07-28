import { describe, expect, it } from "vitest";
import {
  assertExactAgainstSource,
  normalizeScene,
  planSceneLocalization,
  PlanError,
} from "../src/roles/p1/index.js";
import { pad, unitFact, wholeSceneBatch } from "./p1-whole-scene-localizer-test-support.js";

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
