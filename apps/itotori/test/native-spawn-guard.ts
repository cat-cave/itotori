// Test-only static-analysis backstop for native-CLI secret leakage.
//
// Pure, importable classifier so the guard test AND its negative check share
// the SAME detection logic — the negative check points this at real rogue
// fixtures and asserts they are flagged, proving the guard is not vacuous.
//
// PER-SPAWN-SITE precision: sanitization is verified for EACH spawn call
// individually, NOT at file level. A file that contains a legit
// `spawnNativeCliProcess(...)` call AND a separate rogue unsanitized native
// spawn is FLAGGED (on the rogue site) — "the file mentions the boundary
// somewhere" is never enough.
//
// Detection is deliberately robust (not a fragile whole-file substring):
//   - comments (line `//` and block `/* … */`) are stripped BEFORE matching so
//     a bin name mentioned only in prose never trips the guard, and a spawn in
//     real code is always seen;
//   - each spawn-primitive INVOCATION is matched and its argument list captured
//     (balanced-paren scan); a site is "native" when its own args reference a
//     native decode/render bin (bin-name string, ITOTORI_*_BIN, or `-p <bin>-cli`);
//   - a native site is "sanitized" when the call itself is the shared boundary
//     `spawnNativeCliProcess(...)`, or its own arguments scrub the env
//     (`scrubLiveProviderSecrets*(...)`).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Spawn primitives that actually launch a child process (+ the common `execa`
 * dep). `spawnNativeCliProcess` is intentionally NOT here — it is the sanitized
 * boundary, matched separately as an already-safe call.
 */
const SPAWN_PRIMITIVES = [
  "spawnSync",
  "spawn",
  "execFileSync",
  "execFile",
  "execSync",
  "exec",
  "execa",
  "fork",
];

/**
 * A reference to a native decode/render bin: the bin names themselves, the
 * ITOTORI_*_BIN override vars, or a cargo `-p <name>-cli` package selector.
 */
const NATIVE_BIN_RE =
  /\bkaifuu-cli\b|\butsushi-cli\b|ITOTORI_KAIFUU_BIN|ITOTORI_UTSUSHI_BIN|-p\s+\S*-cli\b/u;

/** Applied AT a call site: the env argument runs through the shared scrub. */
const CALL_SCRUB_RE = /scrubLiveProviderSecrets/u;

/** The shared sanitized boundary call — inherently safe (it scrubs internally). */
const SANITIZED_BOUNDARY_CALL = "spawnNativeCliProcess";

/**
 * Remove `//` line comments and `/* … *\/` block comments so classification
 * runs against CODE only. String literals are left intact (a spawn target is a
 * string literal), so a real `spawnSync("kaifuu-cli", …)` is still detected.
 */
export function stripComments(source: string): string {
  // Block comments first (may span lines), then line comments.
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//gu, " ");
  return withoutBlock
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

/**
 * From `code[openParenIndex]` (the `(` of a call), return the substring of the
 * balanced argument list up to the matching `)`. Best-effort: string/quote
 * awareness so a `)` inside a string literal doesn't close the call early.
 */
function captureCallArgs(code: string, openParenIndex: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParenIndex; i < code.length; i++) {
    const ch = code[i];
    if (quote !== null) {
      if (ch === "\\") {
        i++; // skip escaped char
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return code.slice(openParenIndex + 1, i);
    }
  }
  // Unbalanced (truncated) — return the rest so the site is still analyzable.
  return code.slice(openParenIndex + 1);
}

export interface NativeSpawnSite {
  /** The spawn primitive used (e.g. "spawnSync"). */
  readonly primitive: string;
  /** The captured argument-list text of this call. */
  readonly args: string;
  /** This call routes through the sanitized boundary or scrubs its env arg. */
  readonly sanitized: boolean;
}

/**
 * Enumerate EVERY native-CLI spawn SITE in a source body. Each returned site
 * is a call to a real spawn primitive whose own arguments reference a native
 * bin. `sanitized` is decided PER SITE (call-local), never file-wide.
 */
export function findNativeSpawnSites(source: string): NativeSpawnSite[] {
  const code = stripComments(source);
  const sites: NativeSpawnSite[] = [];
  for (const primitive of SPAWN_PRIMITIVES) {
    // Match the primitive as a call: word-boundary, name, optional ws, `(`.
    const re = new RegExp(`\\b${primitive}\\s*\\(`, "gu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const openParen = code.indexOf("(", m.index);
      if (openParen < 0) continue;
      const args = captureCallArgs(code, openParen);
      if (!NATIVE_BIN_RE.test(args)) continue; // this call doesn't target a native bin
      // Sanitized when THIS call's args scrub the env (the boundary call is
      // handled separately below since it is not a raw primitive).
      const sanitized = CALL_SCRUB_RE.test(args);
      sites.push({ primitive, args, sanitized });
    }
  }
  return sites;
}

export interface NativeSpawnClassification {
  /** Every native-CLI spawn site in the file, each with per-site sanitization. */
  readonly sites: readonly NativeSpawnSite[];
  /** Any native spawn site exists (raw primitive targeting a native bin). */
  readonly spawnsNativeBin: boolean;
  /** True only when EVERY native spawn site is individually sanitized. */
  readonly allSitesSanitized: boolean;
  /** The file references the sanitized boundary call somewhere. */
  readonly usesBoundaryCall: boolean;
}

/** Classify a single file's SOURCE body (raw, comments included), per site. */
export function classifyNativeSpawnSource(source: string): NativeSpawnClassification {
  const code = stripComments(source);
  const sites = findNativeSpawnSites(source);
  return {
    sites,
    spawnsNativeBin: sites.length > 0,
    allSitesSanitized: sites.every((s) => s.sanitized),
    usesBoundaryCall: code.includes(SANITIZED_BOUNDARY_CALL),
  };
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "target",
  "web-dist",
  "coverage",
  ".turbo",
  ".vite",
]);

/** Recursively collect scannable non-test source files under `dir`. */
export function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walkSourceFiles(full));
    } else if (/\.(?:ts|tsx|mjs|cjs|js)$/u.test(entry.name)) {
      // Test files may reference spawn + bins freely (they mock / static-scan).
      if (/\.test\.(?:ts|tsx|mjs|cjs|js)$/u.test(entry.name)) continue;
      if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".d.mts")) continue;
      // The guard helper itself is analysis code (it names the primitives).
      if (entry.name === "native-spawn-guard.ts") continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * Scan roots for files with an UNSANITIZED native spawn SITE. Returns the
 * offending repo-relative paths (a file appears once even if it has multiple
 * rogue sites). `allowedInlineScrub` are files permitted to have raw native
 * spawn sites WITHOUT a call-local scrub because they scrub inline via a
 * variable (the boundary itself); `benignDataReferences` reference a bin only
 * as data and spawn only benign tooling.
 */
export function findUnsanitizedNativeSpawns(options: {
  readonly repoRoot: string;
  readonly scanRoots: readonly string[];
  readonly allowedInlineScrub: ReadonlySet<string>;
  readonly benignDataReferences: ReadonlySet<string>;
}): string[] {
  const { repoRoot, scanRoots, allowedInlineScrub, benignDataReferences } = options;
  const offenders: string[] = [];
  for (const root of scanRoots) {
    for (const file of walkSourceFiles(join(repoRoot, root))) {
      const rel = file.slice(repoRoot.length + 1);
      if (benignDataReferences.has(rel)) continue;
      // The boundary file scrubs inline via a variable, which a call-local
      // regex cannot see — it is whitelisted at the FILE level (it is the ONE
      // permitted inline-scrub site).
      if (allowedInlineScrub.has(rel)) continue;
      const { sites } = classifyNativeSpawnSource(readFileSync(file, "utf8"));
      // Flag if ANY native spawn site is not individually sanitized.
      if (sites.some((s) => !s.sanitized)) offenders.push(rel);
    }
  }
  return offenders;
}
