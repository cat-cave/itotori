import { describe, expect, it } from "vitest";
import {
  normalizeToSjisSafe,
  reconstructTarget,
  splitProtectedSpans,
  stripOutOfBandControlMarkup,
} from "../src/localization/patchback-safety.js";

describe("patchback safety", () => {
  it("removes out-of-band markup before drafting and restores protected spans exactly", () => {
    const source = "<reallive.kidoku 42>【栞】「こんにちは」";
    const skeleton = splitProtectedSpans(source);

    expect(stripOutOfBandControlMarkup(source)).toBe("【栞】「こんにちは」");
    expect(skeleton).toMatchObject({ name: "【栞】", open: "「", body: "こんにちは", close: "」" });
    expect(reconstructTarget(skeleton, "Hello")).toBe("【栞】「Hello」");
  });

  it("normalizes non-SJIS English typography without changing protected spans", () => {
    const skeleton = splitProtectedSpans("【栞】「『test』」");
    const normalized = normalizeToSjisSafe("“Hello”—wait…");

    expect(normalized).toBe('"Hello"--wait...');
    expect(reconstructTarget(skeleton, normalized)).toBe('【栞】「"Hello"--wait...」');
  });
});
