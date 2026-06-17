import { describe, expect, it } from "vitest";
import { assertBridgeBundleV02 } from "../src/index.js";
import {
  countJapaneseCharacters,
  createSyntheticLargeBridgeBundle,
  summarizeSyntheticLargeBridgeBundle,
} from "../src/synthetic-large-project.js";

describe("synthetic large bridge generator", () => {
  it("creates deterministic v0.2 bridge bundles above the requested Japanese character target", () => {
    const first = createSyntheticLargeBridgeBundle({
      seed: "fixture-seed",
      targetJapaneseCharacters: 5_000,
      assetCount: 8,
    });
    const second = createSyntheticLargeBridgeBundle({
      seed: "fixture-seed",
      targetJapaneseCharacters: 5_000,
      assetCount: 8,
    });

    assertBridgeBundleV02(first);
    assertBridgeBundleV02(second);
    expect(second).toEqual(first);

    const summary = summarizeSyntheticLargeBridgeBundle(first);
    expect(summary.assetCount).toBe(8);
    expect(summary.sourceJapaneseCharacterCount).toBeGreaterThanOrEqual(5_000);
    expect(summary.unitCount).toBeGreaterThan(10);
    expect(summary.sourceTextBytes).toBeGreaterThan(summary.sourceCharacterCount);
  });

  it("generates byte-accurate protected spans inside source text", () => {
    const bridge = createSyntheticLargeBridgeBundle({
      targetJapaneseCharacters: 3_000,
      assetCount: 4,
    });

    const unitsWithSpans = bridge.units.filter((unit) => unit.spans.length > 0);
    expect(unitsWithSpans.length).toBeGreaterThan(0);

    for (const unit of unitsWithSpans) {
      const bytes = Buffer.from(unit.sourceText, "utf8");
      for (const span of unit.spans) {
        expect(bytes.subarray(span.startByte, span.endByte).toString("utf8")).toBe(span.raw);
      }
    }
  });

  it("counts Japanese characters separately from placeholders and ASCII metadata", () => {
    expect(countJapaneseCharacters("第1章 {player} [wait] 記録")).toBe(4);
  });
});
