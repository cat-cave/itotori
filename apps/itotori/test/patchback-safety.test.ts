import { describe, expect, it } from "vitest";
import {
  normalizeToSjisSafe,
  reconstructTarget,
  repairJsonObject,
  splitProtectedSpans,
  stripOutOfBandControlMarkup,
  type ProtectedSpanSkeleton,
} from "../src/localization/patchback-safety.js";

describe("stripOutOfBandControlMarkup", () => {
  it("removes every kidoku marker and keeps the body", () => {
    expect(stripOutOfBandControlMarkup("<reallive.kidoku 5>本文")).toBe("本文");
    expect(stripOutOfBandControlMarkup("<reallive.kidoku 1>a<reallive.kidoku 2>b")).toBe("ab");
  });
  it("keeps an unterminated marker verbatim rather than truncating", () => {
    expect(stripOutOfBandControlMarkup("x<reallive.kidoku 9")).toBe("x<reallive.kidoku 9");
  });
  it("leaves in-body markup untouched", () => {
    expect(stripOutOfBandControlMarkup("【凛】「hi」")).toBe("【凛】「hi」");
  });
});

describe("splitProtectedSpans", () => {
  it("splits a spoken line into name + quote + body", () => {
    expect(splitProtectedSpans("<reallive.kidoku 5>【凛】「こんにちは」")).toEqual({
      name: "【凛】",
      open: "「",
      body: "こんにちは",
      close: "」",
      trailing: "",
    });
  });
  it("splits a quoted line with no name", () => {
    expect(splitProtectedSpans("<reallive.kidoku 0>「やあ」")).toEqual({
      name: "",
      open: "「",
      body: "やあ",
      close: "」",
      trailing: "",
    });
  });
  it("treats a bare line as narration (no wrappers)", () => {
    expect(splitProtectedSpans("<reallive.kidoku 3>ナレーション")).toEqual({
      name: "",
      open: "",
      body: "ナレーション",
      close: "",
      trailing: "",
    });
  });
  it("preserves trailing text after the closing quote", () => {
    const s = splitProtectedSpans("【凛】「あ」……");
    expect(s.body).toBe("あ");
    expect(s.trailing).toBe("……");
  });
});

describe("reconstructTarget", () => {
  const spoken: ProtectedSpanSkeleton = {
    name: "【凛】",
    open: "「",
    body: "",
    close: "」",
    trailing: "",
  };
  it("re-injects name + quotes around the translated body", () => {
    expect(reconstructTarget(spoken, "Hello")).toBe("【凛】「Hello」");
  });
  it("romanizes a known name and keeps unknown names verbatim", () => {
    const rom = new Map([["【凛】", "【Rin】"]]);
    expect(reconstructTarget(spoken, "Hi", rom)).toBe("【Rin】「Hi」");
    const other: ProtectedSpanSkeleton = { ...spoken, name: "【某】" };
    expect(reconstructTarget(other, "Hi", rom)).toBe("【某】「Hi」");
  });
  it("emits a bare body for narration", () => {
    const narration: ProtectedSpanSkeleton = {
      name: "",
      open: "",
      body: "",
      close: "",
      trailing: "",
    };
    expect(reconstructTarget(narration, "A cold night.")).toBe("A cold night.");
  });
});

describe("normalizeToSjisSafe", () => {
  it("folds curly quotes, dashes, and ellipses to ASCII", () => {
    expect(normalizeToSjisSafe("It’s “fine”—really…")).toBe('It\'s "fine"--really...');
  });
  it("strips diacritics from Latin text", () => {
    expect(normalizeToSjisSafe("café naïve résumé")).toBe("cafe naive resume");
  });
  it("keeps genuine CJK content", () => {
    expect(normalizeToSjisSafe("残った日本語")).toBe("残った日本語");
  });
  it("replaces a truly-unmappable codepoint with '?' rather than deleting", () => {
    // U+2603 SNOWMAN is not Shift_JIS-representable and has no NFKD fold.
    expect(normalizeToSjisSafe("a☃b")).toBe("a?b");
  });
  it("produces pure-ASCII output for English prose", () => {
    const out = normalizeToSjisSafe("The “quick” brown—fox… jumped’");
    expect([...out].every((c) => (c.codePointAt(0) ?? 0) <= 0x7e)).toBe(true);
  });
});

describe("repairJsonObject", () => {
  it("parses well-formed JSON unchanged", () => {
    expect(repairJsonObject('{"t":[{"id":9,"en":"ok"}]}')).toEqual({ t: [{ id: 9, en: "ok" }] });
  });
  it("strips markdown fences and prose", () => {
    expect(repairJsonObject('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("removes trailing commas", () => {
    expect(repairJsonObject('{"t":[{"id":0,"en":"a"},]}')).toEqual({ t: [{ id: 0, en: "a" }] });
  });
  it("closes a truncated object, keeping complete entries", () => {
    const out = repairJsonObject('{"t":[{"id":0,"en":"hello"},{"id":1,"en":"wor');
    expect(out).toHaveProperty("t");
    const t = (out as { t: Array<{ id: number }> }).t;
    expect(t[0]).toEqual({ id: 0, en: "hello" });
    expect(t.length).toBeGreaterThanOrEqual(1);
  });
  it("returns null when there is no object at all", () => {
    expect(repairJsonObject("not json")).toBeNull();
    expect(repairJsonObject(null)).toBeNull();
  });
});
