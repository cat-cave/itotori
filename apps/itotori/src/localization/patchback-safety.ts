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
 * Placeholder substituted for each interior close/open quote char when a
 * multi-quoted-segment line is collapsed. `\u0001` (SOH) is a single-byte
 * ASCII control char — it is Shift_JIS-encodable (so it survives
 * {@link normalizeToSjisSafe}) and never appears in real dialogue, so the
 * model cannot confuse it with the outer `「」` wrapper. The original chars
 * are tracked in {@link ProtectedSpanSkeleton.interiorQuotes} and restored
 * verbatim by {@link reconstructTarget}.
 */
const INTERIOR_QUOTE_PLACEHOLDER = "\u0001";

/**
 * The deterministic protected-span skeleton of a RealLive source line, with the
 * translatable dialogue body separated out. Shapes:
 *   `<kidoku>【name】「body」` → { name:"【name】", open:"「", body, close:"」", trailing:"" }
 *   `<kidoku>「body」`        → { name:"",         open:"「", body, close:"」", trailing:"" }
 *   `<kidoku>bareNarration`   → { name:"",         open:"",  body, close:"",  trailing:"" }
 *
 * For a MULTI-quoted-segment line (`「A」x「B」`), the outer wrapper is the
 * first `「` and the last `」`; any interior `」「` chars between them are
 * collapsed to {@link INTERIOR_QUOTE_PLACEHOLDER} in `body` (so the model
 * never sees bare interior quotes it could confuse with the wrapper) and the
 * original chars are recorded in `interiorQuotes` for faithful re-inject.
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
  /**
   * Interior close/open quote chars collapsed out of `body` for a multi-
   * quoted-segment line, in the order their placeholders appear. Undefined
   * for the common single-quote / narration case. reconstructTarget swaps
   * each placeholder back to the original char.
   */
  interiorQuotes?: string[];
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
 *
 * For a multi-quoted-segment line (`「A」x「B」`), the outer wrapper is the
 * first `「` and the last 」; interior 」「 between them are collapsed to
 * {@link INTERIOR_QUOTE_PLACEHOLDER} so the model never sees bare interior
 * quote chars it could confuse with the wrapper or mis-nest on reconstruct.
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
  let interiorQuotes: string[] | undefined;
  if (s.startsWith("「")) {
    const end = s.lastIndexOf("」");
    if (end > 0) {
      open = "「";
      close = "」";
      const rawBody = s.slice(1, end);
      trailing = s.slice(end + 1);
      // Collapse any interior 」「 to placeholders so the model never sees
      // bare interior quote chars (which it could confuse with the outer
      // wrapper). The original chars are tracked for faithful re-inject.
      if (rawBody.includes("「") || rawBody.includes("」")) {
        interiorQuotes = [];
        let collapsed = "";
        for (const ch of rawBody) {
          if (ch === "「" || ch === "」") {
            interiorQuotes.push(ch);
            collapsed += INTERIOR_QUOTE_PLACEHOLDER;
          } else {
            collapsed += ch;
          }
        }
        body = collapsed;
      } else {
        body = rawBody;
      }
    }
  }
  return {
    name,
    open,
    body,
    close,
    trailing,
    ...(interiorQuotes !== undefined ? { interiorQuotes } : {}),
  };
}

/**
 * Re-inject the protected spans deterministically around an (already
 * SJIS-normalized) translated body. `nameRomanization` maps a source name
 * token to its target form; a name absent from the map keeps its original
 * (Shift_JIS-safe) token, so a name is never dropped or corrupted.
 *
 * For a multi-quoted-segment line, each {@link INTERIOR_QUOTE_PLACEHOLDER}
 * the model (hopefully) preserved is swapped back to its original interior
 * quote char from `skeleton.interiorQuotes`. Placeholders the model dropped
 * are simply skipped (the interior 」「 is lost — caught by the downstream
 * safety net); any leftover placeholder is stripped so it cannot leak an
 * out-of-band control char into the patchback target.
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
  let body = translatedBody;
  const interior = skeleton.interiorQuotes;
  if (interior !== undefined && interior.length > 0) {
    let qi = 0;
    let restored = "";
    for (const ch of translatedBody) {
      if (ch === INTERIOR_QUOTE_PLACEHOLDER) {
        restored += interior[qi] ?? "";
        qi += 1;
      } else {
        restored += ch;
      }
    }
    body = restored;
  }
  return `${name}${skeleton.open}${body}${skeleton.close}${skeleton.trailing}`;
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
 * The AUTHORITATIVE set of Shift_JIS-encodable Unicode codepoints, derived once
 * from a REAL Shift_JIS codec rather than a hand-maintained Unicode-range table.
 *
 * WHY A CODEC, NOT RANGES. The old range whitelist kept the *entire* CJK Unified
 * Ideographs (`0x4e00-0x9fff`), Ext-A (`0x3400-0x4dbf`), Kana Ext (`0x31f0-…`)
 * and CJK-compat (`0xf900-0xfaff`) blocks. But Shift_JIS only covers the JIS
 * X 0208 subset of those blocks (~6900 ideographs), so non-JIS CJK such as
 * U+3402, U+9FA6 or U+31F0 PASSED the range check yet is NOT Shift_JIS-encodable
 * — it then reached the RealLive patchback and raised
 * `kaifuu.reallive.patchback_target_encode_failure`. The keep-decision must be
 * "can a real Shift_JIS codec represent this char?", not "is it in a CJK block?".
 *
 * We enumerate every valid Shift_JIS byte sequence and decode it with the
 * platform's WHATWG `TextDecoder("shift_jis")`, then apply the measured
 * `encoding_rs::SHIFT_JIS` encoder delta. The raw decode-derived value set is
 * close but not exact: it includes decode-only PUA mappings U+E000..U+E757, and
 * it misses four encoder-canonical codepoints (U+0080, U+00A5, U+203E, U+2212).
 *
 * The focused patchback-safety test asserts the final set against an
 * `encoding_rs` oracle generated by `kaifuu_reallive::encode_shift_jis_slot`,
 * keeping the runtime path dependency-free while preserving an exact encoder
 * audit.
 */
const ENCODING_RS_SHIFT_JIS_ENCODER_ONLY_CODEPOINTS = [0x80, 0xa5, 0x203e, 0x2212] as const;
const ENCODING_RS_SHIFT_JIS_DECODE_ONLY_PUA_START = 0xe000;
const ENCODING_RS_SHIFT_JIS_DECODE_ONLY_PUA_END = 0xe757;

const SJIS_ENCODABLE_CODEPOINTS: ReadonlySet<number> = buildSjisEncodableSet();

function buildSjisEncodableSet(): ReadonlySet<number> {
  const decoder = new TextDecoder("shift_jis", { fatal: true });
  const set = new Set<number>();
  const add = (bytes: number[]): void => {
    let decoded: string;
    try {
      decoded = decoder.decode(new Uint8Array(bytes));
    } catch {
      return; // invalid Shift_JIS sequence
    }
    const cps = [...decoded];
    if (cps.length === 1) {
      const cp = cps[0]?.codePointAt(0);
      if (cp !== undefined && cp !== 0xfffd) {
        set.add(cp);
      }
    }
  };
  // Single-byte: ASCII (0x00-0x7f) + halfwidth katakana (0xa1-0xdf).
  for (let b = 0x00; b <= 0xff; b++) {
    add([b]);
  }
  // Double-byte: lead 0x81-0x9f / 0xe0-0xfc, trail 0x40-0x7e / 0x80-0xfc.
  const isLead = (b: number): boolean => (b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc);
  const isTrail = (b: number): boolean => (b >= 0x40 && b <= 0x7e) || (b >= 0x80 && b <= 0xfc);
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if (!isLead(lead)) {
      continue;
    }
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (isTrail(trail)) {
        add([lead, trail]);
      }
    }
  }
  for (
    let cp = ENCODING_RS_SHIFT_JIS_DECODE_ONLY_PUA_START;
    cp <= ENCODING_RS_SHIFT_JIS_DECODE_ONLY_PUA_END;
    cp++
  ) {
    set.delete(cp);
  }
  for (const cp of ENCODING_RS_SHIFT_JIS_ENCODER_ONLY_CODEPOINTS) {
    set.add(cp);
  }
  return set;
}

/**
 * True iff `cp` is representable in Shift_JIS, verified against the real codec
 * (see {@link SJIS_ENCODABLE_CODEPOINTS}). Everything else — including non-JIS
 * CJK that the old range table let slip through — is treated as non-encodable
 * and routed to the NFKD-fold / `?` substitution path by {@link normalizeToSjisSafe}.
 */
function isSjisSafeKept(cp: number): boolean {
  return SJIS_ENCODABLE_CODEPOINTS.has(cp);
}

/**
 * Audit hook for tests that compare the dependency-free TS keep-set against the
 * Rust patchback encoder oracle. Returns a sorted copy so callers cannot mutate
 * the module-level set used by {@link normalizeToSjisSafe}.
 */
export function listSjisEncodableCodepointsForAudit(): readonly number[] {
  return [...SJIS_ENCODABLE_CODEPOINTS].sort((a, b) => a - b);
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

/**
 * Run a strict structured-output parser, and on failure deterministically
 * salvage the raw content via `repairJsonObject` (markdown-fence stripping +
 * bounded json-repair, provider-agnostic) and re-run the SAME strict parser
 * on the salvaged object. Re-throws the ORIGINAL error when nothing is
 * salvageable, so a genuinely-invalid response still surfaces the typed error.
 */
export function parseWithBoundedRepair<T>(raw: string, strictParse: (input: string) => T): T {
  try {
    return strictParse(raw);
  } catch (originalError) {
    const repaired = repairJsonObject(raw);
    if (repaired === null || typeof repaired !== "object") {
      throw originalError;
    }
    return strictParse(JSON.stringify(repaired));
  }
}
