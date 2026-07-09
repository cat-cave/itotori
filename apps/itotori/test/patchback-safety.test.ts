import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  listSjisEncodableCodepointsForAudit,
  normalizeToSjisSafe,
  reconstructTarget,
  repairJsonObject,
  splitProtectedSpans,
  stripOutOfBandControlMarkup,
  type ProtectedSpanSkeleton,
} from "../src/localization/patchback-safety.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function encodingRsSjisEncodableCodepoints(): readonly number[] {
  const result = spawnSync(
    "cargo",
    ["run", "--quiet", "-p", "kaifuu-reallive", "--example", "sjis_encodable_codepoints"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout) as number[];
}

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
  it("collapses interior 」「 of a multi-quoted-segment line to placeholders (no bare quote in body)", () => {
    // Audit case 「A」text「B」: the naive first-open/last-close used to leave
    // the inner 」…「 in the body, where the model could confuse it with the
    // outer wrapper. The body now carries a placeholder per interior quote.
    const s = splitProtectedSpans("「A」text「B」");
    expect(s.open).toBe("「");
    expect(s.close).toBe("」");
    expect(s.body).not.toContain("」");
    expect(s.body).not.toContain("「");
    // The translatable interior content survives.
    expect(s.body).toContain("A");
    expect(s.body).toContain("text");
    expect(s.body).toContain("B");
    // The original interior close/open chars are tracked in order.
    expect(s.interiorQuotes).toEqual(["」", "「"]);
  });
  it("handles a multi-quoted-segment line with a 【name】 token", () => {
    const s = splitProtectedSpans("<reallive.kidoku 5>【凛】「あ」…「う」");
    expect(s.name).toBe("【凛】");
    expect(s.open).toBe("「");
    expect(s.close).toBe("」");
    expect(s.body).not.toContain("」");
    expect(s.body).not.toContain("「");
    expect(s.interiorQuotes).toEqual(["」", "「"]);
  });
  it("handles a three-segment multi-quote line (multiple interior pairs)", () => {
    const s = splitProtectedSpans("「A」x「B」y「C」");
    expect(s.body).not.toContain("」");
    expect(s.body).not.toContain("「");
    // Two interior close/open pairs (4 chars total).
    expect(s.interiorQuotes).toEqual(["」", "「", "」", "「"]);
  });
});

describe("reconstructTarget — multi-quote round-trip", () => {
  it("round-trips a multi-quoted-segment line byte-exact via the source body", () => {
    const skeleton = splitProtectedSpans("「A」text「B」");
    // The reconstruct round-trip is byte-exact when the body is unchanged.
    expect(reconstructTarget(skeleton, skeleton.body)).toBe("「A」text「B」");
  });
  it("round-trips a multi-quote line with 【name】 + kidoku byte-exact", () => {
    const source = "<reallive.kidoku 5>【凛】「あ」…「う」";
    const skeleton = splitProtectedSpans(source);
    expect(reconstructTarget(skeleton, skeleton.body)).toBe("【凛】「あ」…「う」");
  });
  it("reconstructs a translated multi-quote body when the model preserved placeholders", () => {
    // The model translated each segment and KEPT the placeholder boundary,
    // so the deterministic re-inject restores the interior 」「 verbatim.
    const skeleton = splitProtectedSpans("「A」x「B」");
    const placeholders = skeleton.body.match(/\u0001/gu) ?? [];
    expect(placeholders.length).toBe(2);
    // Model translates A→Apple, B→Banana, preserving the \u0001 placeholders.
    const preserved = skeleton.body.replace("A", "Apple").replace("B", "Banana");
    expect(reconstructTarget(skeleton, preserved)).toBe("「Apple」x「Banana」");
  });
  it("degrades gracefully (no leftover control char) when the model DROPS placeholders", () => {
    // If the model strips the placeholders, the interior 」「 are lost — but
    // no bare \u0001 control char may leak into the patchback target.
    const skeleton = splitProtectedSpans("「A」x「B」");
    const stripped = skeleton.body.replace(/\u0001/gu, "");
    const out = reconstructTarget(skeleton, stripped);
    expect(out).not.toContain("\u0001");
    expect(out).toBe("「AxB」");
  });
  it("degrades gracefully when the model ADDS extra placeholders", () => {
    // Extra placeholders (model hallucinated them) must be stripped, not
    // left as bare control chars in the patchback target.
    const skeleton = splitProtectedSpans("「A」x「B」");
    const extra = skeleton.body + "\u0001";
    const out = reconstructTarget(skeleton, extra);
    expect(out).not.toContain("\u0001");
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
  // Spawns cargo run of the encoding_rs oracle example — allow cold compile.
  it("uses the same keep-set as the encoding_rs Shift_JIS encoder", () => {
    expect(listSjisEncodableCodepointsForAudit()).toEqual(encodingRsSjisEncodableCodepoints());
  }, 120_000);

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
  it("does NOT keep non-JIS CJK that Shift_JIS cannot encode", () => {
    // U+3402 (Ext-A), U+9FA6 (CJK block tail), U+31F0 (Kana Ext) all satisfied
    // the old Unicode-range whitelist but are NOT in JIS X 0208 / Shift_JIS.
    for (const cp of [0x3402, 0x9fa6, 0x31f0]) {
      const ch = String.fromCodePoint(cp);
      const out = normalizeToSjisSafe(ch);
      // Handled (substituted), never passed through to fail later at encode.
      expect(out).not.toContain(ch);
      expect(out).toBe("?");
    }
  });
  it("keeps genuine JIS X 0208 kanji including U+4E00", () => {
    expect(normalizeToSjisSafe("一")).toBe("一");
    expect(normalizeToSjisSafe("日本語")).toBe("日本語");
  });
  it("output always round-trips through the real Shift_JIS codec with zero failures", () => {
    const decoder = new TextDecoder("shift_jis", { fatal: true });
    // Encodability oracle built from the real codec (encode->decode->identical).
    const encodable = new Set<number>();
    const add = (bytes: number[]): void => {
      try {
        const s = decoder.decode(new Uint8Array(bytes));
        const cps = [...s];
        if (cps.length === 1 && cps[0] !== "�") {
          encodable.add(cps[0]!.codePointAt(0)!);
        }
      } catch {
        /* invalid sequence */
      }
    };
    for (let b = 0; b <= 0xff; b++) add([b]);
    for (let lead = 0x81; lead <= 0xfc; lead++) {
      if (!((lead >= 0x81 && lead <= 0x9f) || (lead >= 0xe0 && lead <= 0xfc))) continue;
      for (let trail = 0x40; trail <= 0xfc; trail++) {
        if ((trail >= 0x40 && trail <= 0x7e) || (trail >= 0x80 && trail <= 0xfc))
          add([lead, trail]);
      }
    }
    const sample =
      "It’s “fine”—really… café naïve 残った日本語 一 " + "mixed 㐂龦ㇰ tail ☃ ★ 日本語で。";
    const normalized = normalizeToSjisSafe(sample);
    for (const ch of normalized) {
      expect(encodable.has(ch.codePointAt(0)!)).toBe(true);
    }
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
