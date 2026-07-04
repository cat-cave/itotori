// Patchback-safety: deterministic protected-span strip/re-inject + SJIS-safe
// target normalization + bounded json-repair for the RealLive draft path.
//
// WHY THIS EXISTS (at-scale v2 finding). The at-scale pilot proved that when a
// translation draft must reproduce control markup itself, an LLM drops or
// mutates it at scale (name tokens `【…】`, `<reallive.kidoku N>` markers) and
// emits English typography (curly quotes, em-dashes, ellipses) that is NOT
// representable in WHATWG Shift_JIS — so the RealLive patchback raises
// `kaifuu.reallive.patchback_target_encode_failure` and whole scenes fail to
// patch. The TranslationAgent + DraftProtectedSpanValidator only VALIDATE and
// reject/retry; they do not deterministically make a draft patch-safe. These
// three pure functions close that gap:
//
//   (a) splitProtectedSpans / reconstructTarget — strip every out-of-band and
//       in-body protected span OFF the source before the model, then re-inject
//       them deterministically around the translated body. The model only ever
//       sees the pure dialogue body, so it CANNOT drop control markup.
//   (b) normalizeToSjisSafe — fold English typography the model emits to a
//       Shift_JIS-representable equivalent while keeping genuine CJK content,
//       so the patchback encode step never fails.
//   (c) repairJsonObject — bounded salvage of a truncated / lightly-malformed
//       structured-output object (fences, prose, trailing commas, truncation).
//
// All functions are pure and dependency-free. The kidoku-marker syntax mirrors
// `kaifuu_reallive::REALLIVE_OUT_OF_BAND_MARKER_OPEN`.

const KIDOKU_OPEN = "<reallive.kidoku ";

/**
 * The deterministic protected-span skeleton of a RealLive source line, with the
 * translatable dialogue body separated out. Shapes:
 *   `<kidoku>【name】「body」` → { name:"【name】", open:"「", body, close:"」", trailing:"" }
 *   `<kidoku>「body」`        → { name:"",         open:"「", body, close:"」", trailing:"" }
 *   `<kidoku>bareNarration`   → { name:"",         open:"",  body, close:"",  trailing:"" }
 */
export type ProtectedSpanSkeleton = {
  /** Leading `【…】` speaker name token, or "" when absent. */
  name: string;
  /** Opening quote `「` when the body was quote-wrapped, else "". */
  open: string;
  /** The translatable dialogue/narration body (control markup removed). */
  body: string;
  /** Closing quote `」` when the body was quote-wrapped, else "". */
  close: string;
  /** Any residual text after the closing quote (rare), preserved verbatim. */
  trailing: string;
};

/**
 * Strip EVERY out-of-band kidoku marker (`<reallive.kidoku …>`). The marker has
 * no Textout byte-run; the RealLive patchback re-emits kidoku bytes byte-equal
 * from the untouched bytecode, so the marker must never reach the Textout body.
 * Never truncates on an unterminated marker.
 */
export function stripOutOfBandControlMarkup(text: string): string {
  let out = "";
  let rest = text;
  for (;;) {
    const open = rest.indexOf(KIDOKU_OPEN);
    if (open === -1) {
      return out + rest;
    }
    out += rest.slice(0, open);
    const afterOpen = rest.slice(open + KIDOKU_OPEN.length);
    const close = afterOpen.indexOf(">");
    if (close === -1) {
      return out + rest.slice(open);
    }
    rest = afterOpen.slice(close + 1);
  }
}

/**
 * Deterministically split a source line into its protected-span skeleton plus
 * the pure translatable body. The caller sends ONLY `body` to the model.
 */
export function splitProtectedSpans(sourceText: string): ProtectedSpanSkeleton {
  let s = stripOutOfBandControlMarkup(sourceText);
  let name = "";
  const nameMatch = s.match(/^【[^】]*】/u);
  if (nameMatch) {
    name = nameMatch[0];
    s = s.slice(nameMatch[0].length);
  }
  let open = "";
  let close = "";
  let trailing = "";
  let body = s;
  if (s.startsWith("「")) {
    const end = s.lastIndexOf("」");
    if (end > 0) {
      open = "「";
      close = "」";
      body = s.slice(1, end);
      trailing = s.slice(end + 1);
    }
  }
  return { name, open, body, close, trailing };
}

/**
 * Re-inject the protected spans deterministically around an (already
 * SJIS-normalized) translated body. `nameRomanization` maps a source name
 * token to its target form; a name absent from the map keeps its original
 * (Shift_JIS-safe) token, so a name is never dropped or corrupted.
 */
export function reconstructTarget(
  skeleton: ProtectedSpanSkeleton,
  translatedBody: string,
  nameRomanization?: ReadonlyMap<string, string>,
): string {
  const name =
    skeleton.name && nameRomanization && nameRomanization.has(skeleton.name)
      ? (nameRomanization.get(skeleton.name) as string)
      : skeleton.name;
  return `${name}${skeleton.open}${translatedBody}${skeleton.close}${skeleton.trailing}`;
}

// ---------------------------------------------------------------------------
// (b) SJIS-safe target normalization
// ---------------------------------------------------------------------------

/**
 * English typography an LLM emits that is NOT in WHATWG Shift_JIS
 * (`encoding_rs::SHIFT_JIS`) → a representable ASCII equivalent. This is the
 * direct cause of `kaifuu.reallive.patchback_target_encode_failure`.
 */
const TYPOGRAPHY_MAP: ReadonlyMap<string, string> = new Map([
  ["‘", "'"],
  ["’", "'"],
  ["‚", "'"],
  ["‛", "'"],
  ["“", '"'],
  ["”", '"'],
  ["„", '"'],
  ["‟", '"'],
  ["–", "-"],
  ["—", "--"],
  ["―", "--"],
  ["−", "-"],
  ["…", "..."],
  ["•", "*"],
  ["·", "*"],
  ["→", "->"],
  ["←", "<-"],
  ["↔", "<->"],
  ["⇒", "=>"],
  ["⇐", "<="],
  [" ", " "],
  [" ", " "],
  [" ", " "],
  [" ", " "],
  [" ", " "],
  [" ", " "],
  ["​", ""],
  ["﻿", ""],
  ["«", '"'],
  ["»", '"'],
  ["‹", "'"],
  ["›", "'"],
  ["©", "(c)"],
  ["®", "(r)"],
  ["™", "(tm)"],
  ["½", "1/2"],
  ["¼", "1/4"],
  ["¾", "3/4"],
  ["″", '"'],
  ["′", "'"],
  ["°", " degrees"],
  ["‑", "-"],
  ["⁃", "-"],
  ["‧", "*"],
]);

/**
 * Codepoints kept verbatim — all Shift_JIS-encodable (they round-trip from the
 * decoded source): ASCII, CJK symbols/punctuation, kana, CJK ideographs,
 * compatibility ideographs, and fullwidth/halfwidth forms.
 */
function isSjisSafeKept(cp: number): boolean {
  return (
    cp <= 0x7e ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef)
  );
}

/**
 * Normalize a translated body so the RealLive patchback can encode it as
 * Shift_JIS. English prose folds to ASCII; genuine CJK content survives. Any
 * residual unmappable codepoint is folded via NFKD (dropping combining marks)
 * and finally replaced with `?` rather than silently deleted, so an encode
 * failure can never reach the patchback.
 */
export function normalizeToSjisSafe(text: string): string {
  let mapped = "";
  for (const ch of text) {
    mapped += TYPOGRAPHY_MAP.has(ch) ? (TYPOGRAPHY_MAP.get(ch) as string) : ch;
  }
  let out = "";
  for (const ch of mapped) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isSjisSafeKept(cp)) {
      out += ch;
      continue;
    }
    const decomposed = ch.normalize("NFKD").replace(/\p{M}+/gu, "");
    let folded = "";
    for (const d of decomposed) {
      const dcp = d.codePointAt(0) ?? 0;
      folded += isSjisSafeKept(dcp) ? d : "?";
    }
    out += folded.length > 0 ? folded : "?";
  }
  return out;
}

// ---------------------------------------------------------------------------
// (c) bounded json-repair
// ---------------------------------------------------------------------------

/**
 * Bounded, deterministic repair of a truncated / lightly-malformed structured
 * JSON object. Fixes ONLY: markdown fences, prose preamble, trailing commas,
 * and truncation (unterminated string + unclosed `[`/`{` at EOF). Never
 * fabricates values. Returns the parsed value or `null`. Bounded to a single
 * left-to-right pass over the salvaged slice plus at most two reparse attempts.
 */
export function repairJsonObject(content: string | null | undefined): unknown {
  if (content == null) {
    return null;
  }
  let s = String(content).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1] !== undefined) {
    s = fence[1].trim();
  }
  const start = s.indexOf("{");
  if (start < 0) {
    return null;
  }
  s = s.slice(start);
  try {
    return JSON.parse(s);
  } catch {
    /* fall through to bounded repair */
  }
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let lastSignificant = -1;
  const chars: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    chars.push(c);
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (c === "\\") {
        esc = true;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      lastSignificant = chars.length - 1;
    } else if (c === "{" || c === "[") {
      stack.push(c);
      lastSignificant = chars.length - 1;
    } else if (c === "}" || c === "]") {
      stack.pop();
      lastSignificant = chars.length - 1;
    } else if (!/\s/.test(c)) {
      lastSignificant = chars.length - 1;
    }
  }
  let repaired = chars.join("");
  if (inStr) {
    repaired += '"';
  }
  repaired = repaired.replace(/,\s*$/, "");
  for (let i = stack.length - 1; i >= 0; i--) {
    repaired += stack[i] === "{" ? "}" : "]";
  }
  repaired = repaired.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(repaired);
  } catch {
    if (lastSignificant >= 0) {
      let tail = chars.slice(0, lastSignificant + 1).join("");
      tail = tail.replace(/,\s*$/, "");
      for (let i = stack.length - 1; i >= 0; i--) {
        tail += stack[i] === "{" ? "}" : "]";
      }
      tail = tail.replace(/,(\s*[}\]])/g, "$1");
      try {
        return JSON.parse(tail);
      } catch {
        return null;
      }
    }
    return null;
  }
}
