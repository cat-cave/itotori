#!/usr/bin/env node
// CI guard: no game is mentioned by name in production / shared code.
//
// North star: no game (title, slug, vendor, or VNDB game id) is EVER mentioned
// by name anywhere in shared/production source. A concrete game name in code is
// a generalization bug — the engine substrate, CLI defaults, app surfaces, and
// scripts must be title-agnostic; a game's identity lives only in per-game DATA
// records (fixtures, presets, test corpora), never baked into code paths.
//
// This guard enforces "no game names, ever" with a SHRINK-ONLY ratchet so the
// existing offenders are grandfathered but can only shrink, and no NEW game
// reference can land. Each genericization fix that purges a reference ratchets
// the baseline DOWN toward ZERO; the whitelist is the finish-line meter for the
// whole generalization purge.
//
// A "game name" is one of:
//   - a known game/vendor SLUG (`sweetie`, `karetoshi`, `gamekoi`, `oshioki`,
//     `sukara`) or its Japanese title form (`オシオキ`). Human titles like
//     "Sweetie HD" contain their slug and so are caught by the slug.
//   - a known real-game VNDB id (`v11180`, `v31045`, `v60663`, `v21465`,
//     `v55293`, `v57740`). Synthetic test ids (v1001, v1234, …) are NOT matched
//     — only the curated real-game id set is, so fixtures using fake ids stay
//     clean.
//   - the `corpus-observed` marker, which stamps a constant as derived from one
//     game's real bytes while presented as universal (a game-coupling smell —
//     category (a) of the purge worklist).
//
// Ratchet model (the whitelist may only SHRINK, never grow) — identical to the
// `audit-no-node-ids` house style:
//   - The checked-in whitelist (`scripts/lint/game-name-whitelist.json`)
//     records, per file, the multiset of grandfathered game-name TOKENS (the
//     matched identifier, lower-cased). A token is the signature of one
//     reference, so it is stable under line-number shifts and prose reflow.
//   - `check` (default): every current reference token must be covered by the
//     whitelist for its file (multiset: at most as many occurrences as
//     recorded). Any uncovered token is a NEW reference → exit 1.
//   - `--update` (alias `--regenerate`): rewrites the whitelist from the current
//     tree, but REFUSES to grow — it fails if the total token count increased OR
//     a brand-new token value appears. A cleanup PR runs it to ratchet DOWN.
//   - When the whitelist reaches empty (or is deleted), the guard is absolute:
//     zero game-name references permitted.
//
// Scope: tracked source under `crates/`, `packages/`, `apps/`, and `scripts/`
// (`.rs`/`.ts`/`.tsx`/`.js`/`.mjs`/`.cjs`). Excluded as DATA / test / research
// prose (a per-game reference there is the record's PURPOSE, not code coupling):
// `**/tests?/**`, `**/*.test.*`, `**/*_test.rs`, `**/fixtures?/**` + `*fixture*`
// modules, `**/examples?/**`, `**/target|dist|node_modules/**`,
// `scripts/history/**`, `**/migrations/**`, `docs/**`, `roadmap/**`, `.plan/**`,
// `.qd/**`, `presets/**`, and the two guardrail scanners that must name the
// terms to document them (this file + `validate-no-specific-game-references`).
//
// Exit codes: 0 = clean / update applied; 1 = violation or refused update.
// Wired into `just ci-tier0-meta` (test then run), next to `audit-no-node-ids`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const DEFAULT_WHITELIST_PATH = join(here, "lint", "game-name-whitelist.json");

export const SCAN_EXTENSIONS = new Set([".rs", ".ts", ".tsx", ".js", ".mjs", ".cjs"]);

// Path patterns excluded from the scan entirely (case-sensitive substring
// match). These are DATA / test / research surfaces whose PURPOSE is to hold a
// game's identity, plus build output and the guardrail scanners themselves.
const EXCLUDE_PATTERNS = [
  "/tests/",
  "/test/",
  "/fixtures/",
  "/fixture/",
  "fixture", // fixture crates/modules (crates/kaifuu-engine-fixture/, *fixtures.rs)
  "/examples/",
  "/example/",
  "/target/",
  "/dist/",
  "/node_modules/",
  "scripts/history/",
  "/migrations/",
  "docs/",
  "roadmap/",
  ".plan/",
  ".qd/",
  "presets/",
  // Guardrail scanners must name the terms to document/enforce them.
  "scripts/audit-no-game-names.mjs",
  "scripts/validate-no-specific-game-references.mjs",
];

// Test/fixture file suffixes excluded even outside a tests/ directory.
const EXCLUDE_SUFFIXES = [
  ".test.ts",
  ".test.tsx",
  ".test.js",
  ".test.mjs",
  ".test.cjs",
  "_test.rs",
  "/tests.rs",
  "/test.rs",
  "fixtures.ts",
  "fixtures.rs",
];

// Each pattern extracts one game-name TOKEN per match. Slugs/vendor/title use
// word boundaries so identifier fragments never false-fire; VNDB ids are the
// curated real-game set only; `corpus-observed` is the game-coupling marker.
// The `u` flag is omitted so the Japanese title alternative matches literally.
const GAME_NAME_PATTERNS = [
  // Known game / vendor slugs (human titles contain their slug).
  /\b(?:sweetie|karetoshi|gamekoi|oshioki|sukara)\b/gi,
  // Japanese title form.
  /オシオキ/g,
  // Curated real-game VNDB ids (NOT generic v\d+ — synthetic test ids excluded).
  /\bv(?:11180|31045|60663|21465|55293|57740)\b/gi,
  // Game-coupling marker: a constant derived from one game's real bytes.
  /\bcorpus-observed\b/gi,
];

export function isExcludedPath(path) {
  if (EXCLUDE_PATTERNS.some((p) => path.includes(p))) return true;
  if (EXCLUDE_SUFFIXES.some((s) => path.endsWith(s))) return true;
  return false;
}

export function shouldScan(path) {
  if (isExcludedPath(path)) return false;
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return SCAN_EXTENSIONS.has(path.slice(dot));
}

// Extract one violation per game-name token found. A line carrying two names
// yields two entries so each grandfathered reference is tracked individually.
// Exported for the regression suite.
export function findGameNameViolations(path, contents) {
  const found = [];
  const lines = contents.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") continue;
    for (const regex of GAME_NAME_PATTERNS) {
      const re = new RegExp(regex.source, regex.flags);
      for (const match of trimmed.matchAll(re)) {
        found.push({
          file: path,
          line: i + 1,
          token: match[0].toLowerCase(),
          pattern: match[0],
          excerpt: trimmed.slice(0, 160),
        });
      }
    }
  }
  return found;
}

// ---- whitelist helpers -----------------------------------------------------

const WHITELIST_HEADER = `RATCHET WHITELIST (shrink-only). Do not hand-edit; regenerate via
"node scripts/audit-no-game-names.mjs --update". Each entry is a grandfathered
game-name token (the matched identifier, lower-cased); the multiset per file may
only shrink. When empty/deleted the guard is absolute (zero game names in code).`;

export function emptyWhitelist() {
  return { description: WHITELIST_HEADER, generatedAt: null, total: 0, files: {} };
}

export function loadWhitelist(path) {
  if (!existsSync(path)) return emptyWhitelist();
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return {
    description: WHITELIST_HEADER,
    generatedAt: parsed.generatedAt ?? null,
    total: parsed.total ?? 0,
    files: parsed.files ?? {},
  };
}

// Group violations into per-file sorted token arrays (multiset; duplicates kept).
export function groupByFile(violations) {
  const files = new Map();
  for (const v of violations) {
    if (!files.has(v.file)) files.set(v.file, []);
    files.get(v.file).push(v.token);
  }
  for (const arr of files.values()) arr.sort();
  return files;
}

function countMap(arr) {
  const m = new Map();
  for (const t of arr) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

// `check`: every current violation token must be covered by the whitelist for
// its file (multiset). Returns the uncovered ones as NEW violations.
export function evaluateCheck(violations, whitelist) {
  const current = groupByFile(violations);
  const fresh = [];
  for (const [file, tokens] of current) {
    const allowed = countMap(whitelist.files[file] ?? []);
    const have = countMap(tokens);
    for (const [token, count] of have) {
      const covered = allowed.get(token) ?? 0;
      if (count > covered) {
        fresh.push({ file, token, count, covered, excess: count - covered });
      }
    }
  }
  return { ok: fresh.length === 0, newViolations: fresh };
}

function distinctValues(filesMap) {
  const s = new Set();
  for (const arr of filesMap.values()) for (const t of arr) s.add(t);
  return s;
}

function totalTokens(filesMap) {
  let n = 0;
  for (const arr of filesMap.values()) n += arr.length;
  return n;
}

// `--update`: build the prospective whitelist from the current tree and refuse
// to grow. Growth = total token count increased, OR a token value appears that
// was never grandfathered anywhere (a brand-new game name). Renames / reflows of
// already-grandfathered names at equal-or-lower total are allowed.
export function evaluateUpdate(violations, oldWhitelist) {
  const next = groupByFile(violations);
  const oldFiles = new Map();
  for (const [file, arr] of Object.entries(oldWhitelist.files ?? {})) {
    oldFiles.set(file, [...arr].sort());
  }
  const oldTotal = totalTokens(oldFiles);
  const newTotal = totalTokens(next);
  const grew = newTotal > oldTotal;
  const oldValues = distinctValues(oldFiles);
  const newValues = distinctValues(next);
  const novelTokens = [...newValues].filter((v) => !oldValues.has(v)).sort();
  const ok = !grew && novelTokens.length === 0;
  const files = {};
  const sortedFiles = [...next.keys()].sort();
  for (const f of sortedFiles) files[f] = next.get(f);
  return {
    ok,
    grew,
    oldTotal,
    newTotal,
    novelTokens,
    whitelist: {
      description: WHITELIST_HEADER,
      generatedAt: new Date().toISOString(),
      total: newTotal,
      files,
    },
  };
}

// ---- tree scanning ---------------------------------------------------------

export function listScanFiles(root) {
  const out = execSync("git ls-files crates packages apps scripts", {
    cwd: root,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function scanTree(root) {
  const violations = [];
  let scanned = 0;
  for (const rel of listScanFiles(root)) {
    if (!shouldScan(rel)) continue;
    let contents;
    try {
      contents = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    scanned += 1;
    violations.push(...findGameNameViolations(rel, contents));
  }
  return { violations, scanned };
}

// ---- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    mode: "check",
    whitelist: DEFAULT_WHITELIST_PATH,
    root: repoRoot,
    files: [],
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--update" || a === "--regenerate") opts.mode = "update";
    else if (a === "--init") opts.mode = "init";
    else if (a === "--check") opts.mode = "check";
    else if (a === "--whitelist") opts.whitelist = argv[(i += 1)];
    else if (a.startsWith("--whitelist=")) opts.whitelist = a.slice("--whitelist=".length);
    else if (a === "--root") opts.root = resolve(argv[(i += 1)]);
    else if (a.startsWith("--root=")) opts.root = resolve(a.slice("--root=".length));
    else if (a === "--help" || a === "-h") opts.help = true;
    else opts.files.push(a);
  }
  return opts;
}

function usage() {
  return [
    "usage: node scripts/audit-no-game-names.mjs [--check|--update|--init] [--whitelist PATH] [--root DIR] [<file>...]",
    "",
    "check   fail on any game-name reference not covered by the shrink-only whitelist (default).",
    "update  rewrite the whitelist from the current tree; REFUSE to grow (cleanup ratchet).",
    "init    one-time bootstrap: write the whitelist from the current tree unconditionally.",
    "        Use ONLY to seed the initial baseline; a committed baseline is shrink-only after.",
  ].join("\n");
}

function runCheck(violations, scanned, whitelist) {
  const { ok, newViolations } = evaluateCheck(violations, whitelist);
  if (ok) {
    process.stdout.write(
      `game-name guard: passed. ${violations.length} grandfathered reference(s) across ` +
        `${scanned} scanned files; no new game-name references. ` +
        `(finish-line meter: ${whitelist.total} remaining toward zero)\n`,
    );
    return 0;
  }
  process.stderr.write(
    `game-name guard: FAILED. ${newViolations.length} new game-name reference(s) not covered by ` +
      `${DEFAULT_WHITELIST_PATH}.\n` +
      "A concrete game name in shared/production code is a generalization bug; genericize it " +
      "instead of whitelisting (a game's identity belongs in per-game DATA, not code).\n\n",
  );
  for (const v of newViolations) {
    process.stderr.write(
      `  ${v.file}  +${v.excess}x  "${v.token}"  (covered ${v.covered}, found ${v.count})\n`,
    );
  }
  return 1;
}

function runInit(violations, target) {
  const built = evaluateUpdate(violations, emptyWhitelist()).whitelist;
  writeFileSync(target, `${JSON.stringify(built, null, 2)}\n`);
  process.stdout.write(
    `game-name guard: initial whitelist seeded with ${built.total} token(s) across ` +
      `${Object.keys(built.files).length} files.\n` +
      `Wrote ${target}\n` +
      "Future cleanup uses --update (shrink-only; refuses to grow).\n",
  );
  return 0;
}

function runUpdate(violations, oldWhitelist, target) {
  if (oldWhitelist.total === 0 && Object.keys(oldWhitelist.files).length === 0) {
    process.stderr.write(
      "game-name guard: --update REFUSED — no committed baseline to shrink from.\n" +
        "  Run --init ONCE to seed the initial whitelist; afterwards --update is shrink-only.\n",
    );
    return 1;
  }
  const result = evaluateUpdate(violations, oldWhitelist);
  if (!result.ok) {
    process.stderr.write(
      `game-name guard: --update REFUSED (whitelist may only shrink).\n` +
        `  total: ${result.oldTotal} -> ${result.newTotal}${result.grew ? " (GREW)" : ""}\n`,
    );
    if (result.novelTokens.length > 0) {
      process.stderr.write(
        `  ${result.novelTokens.length} brand-new game name(s) never grandfathered:\n`,
      );
      for (const t of result.novelTokens) process.stderr.write(`    "${t}"\n`);
    }
    process.stderr.write("Genericize the new references; do not expand the whitelist.\n");
    return 1;
  }
  writeFileSync(target, `${JSON.stringify(result.whitelist, null, 2)}\n`);
  process.stdout.write(
    `game-name guard: whitelist ratcheted ${result.oldTotal} -> ${result.newTotal} ` +
      `(${result.whitelist.total} tokens across ${Object.keys(result.whitelist.files).length} files).\n` +
      `Wrote ${target}\n`,
  );
  return 0;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const whitelist = loadWhitelist(opts.whitelist);
  let violations;
  let scanned = 0;
  if (opts.files.length > 0) {
    for (const f of opts.files) {
      const rel = f;
      let contents;
      try {
        contents = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      scanned += 1;
      violations = (violations ?? []).concat(findGameNameViolations(rel, contents));
    }
  } else {
    const r = scanTree(opts.root);
    violations = r.violations;
    scanned = r.scanned;
  }
  if (opts.mode === "update") {
    process.exit(runUpdate(violations, whitelist, opts.whitelist));
  }
  if (opts.mode === "init") {
    process.exit(runInit(violations, opts.whitelist));
  }
  process.exit(runCheck(violations, scanned, whitelist));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
