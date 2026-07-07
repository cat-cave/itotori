import { describe, expect, it } from "vitest";
import { compareSemanticMatches } from "../src/index.js";
import type { SemanticGlossarySearchMatch } from "../src/index.js";

function match(termId: string, sourceTerm: string, score: number): SemanticGlossarySearchMatch {
  return {
    term: {
      termId,
      sourceTerm,
      preferredTranslation: sourceTerm,
      termKind: "general",
      status: "active",
      sourceLocale: "ja-JP",
      targetLocale: "en-US",
    },
    score,
    matchKinds: ["semantic_vector"],
    exactMatchKinds: [],
    provenance: {},
  };
}

describe("compareSemanticMatches", () => {
  it("orders by descending score when scores differ", () => {
    expect(compareSemanticMatches(match("a", "剣", 0.9), match("b", "剣", 0.5))).toBeLessThan(0);
    expect(compareSemanticMatches(match("a", "剣", 0.5), match("b", "剣", 0.9))).toBeGreaterThan(0);
  });

  it("breaks equal-score ties by ascending sourceTerm", () => {
    expect(compareSemanticMatches(match("a", "剣", 0.5), match("b", "勇者", 0.5))).toBeLessThan(0);
    expect(compareSemanticMatches(match("a", "勇者", 0.5), match("b", "剣", 0.5))).toBeGreaterThan(
      0,
    );
  });

  it("breaks equal-score + equal-sourceTerm ties by ascending termId (stable)", () => {
    // Regardless of input order, the lower termId sorts first.
    expect(
      compareSemanticMatches(match("term-bravo", "剣", 0.5), match("term-alpha", "剣", 0.5)),
    ).toBeGreaterThan(0);
    expect(
      compareSemanticMatches(match("term-alpha", "剣", 0.5), match("term-bravo", "剣", 0.5)),
    ).toBeLessThan(0);
    expect(
      compareSemanticMatches(match("term-alpha", "剣", 0.5), match("term-alpha", "剣", 0.5)),
    ).toBe(0);
  });

  it("sorts an equal-score + equal-sourceTerm batch deterministically by termId", () => {
    const batch = [
      match("term-gamma", "剣", 0.5),
      match("term-alpha", "剣", 0.5),
      match("term-delta", "剣", 0.5),
      match("term-bravo", "剣", 0.5),
    ];
    const sorted = [...batch].sort(compareSemanticMatches);
    expect(sorted.map((entry) => entry.term.termId)).toEqual([
      "term-alpha",
      "term-bravo",
      "term-delta",
      "term-gamma",
    ]);
  });
});
