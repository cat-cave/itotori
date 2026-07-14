#!/usr/bin/env node
// CI guard: no node-id references in production code.
//
// A "node id" is a roadmap / ticket cross-ref (`<PREFIX>-<number>`, a
// `p0-core-<slug>`, or the prose forms "follow-up node" / "see node" /
// "deferred for node"). Provenance like that is stale-on-write: it belongs in
// git history + the PR description, never in a doc comment or source line.
// This guard enforces "no node ids, ever" with a SHRINK-ONLY ratchet so the
// existing offenders are grandfathered but can only shrink, and no NEW
// violation can land.
//
// Ratchet model (the whitelist may only SHRINK, never grow):
//   - The checked-in whitelist (`scripts/lint/node-id-whitelist.json`) records,
//     per file, the multiset of grandfathered node-id TOKENS (the matched
//     reference text, lower-cased). A token is the signature of one violation,
//     so it is stable under line-number shifts and prose reflow — only the
//     node-id reference itself matters.
//   - `check` (default): every current violation token must be covered by the
//     whitelist for its file (multiset: at most as many occurrences as
//     recorded). Any uncovered token is a NEW violation → exit 1.
//   - `--update` (alias `--regenerate`): rewrites the whitelist from the
//     current tree, but REFUSES to grow — it fails if the total token count
//     increased OR a brand-new token value (a node id never grandfathered
//     anywhere) appears. A cleanup PR runs it to ratchet the baseline DOWN.
//   - When the whitelist reaches empty (or is deleted), the guard is absolute:
//     zero node-id references permitted.
//
// Scope: tracked source under `crates/` (`.rs`) and `packages/`
// (`.ts`/`.tsx`/`.js`/`.mjs`/`.cjs`). Excluded as immutable/prose/delete-zone:
// `apps/itotori/**`, `**/fixtures/**`, `**/target/**`, `**/dist/**`,
// `**/migrations/**/*.sql` (checksum-locked historical SQL — it can neither be
// cleaned nor reach zero, so it is out of the ratchet), `docs/**`, `roadmap/**`,
// `.qd/**`, `.plan/**`, `CHANGELOG*`.
//
// Exit codes: 0 = clean / update applied; 1 = violation or refused update.
// Wired into `just ci-tier0-meta` (test then run), mirroring the
// `audit-no-hardcoded-cost` house style.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const DEFAULT_WHITELIST_PATH = join(here, "lint", "node-id-whitelist.json");

export const SCAN_EXTENSIONS = new Set([".rs", ".ts", ".tsx", ".js", ".mjs", ".cjs"]);

// Path patterns excluded from the scan entirely. A path is excluded if it
// matches any of these (case-sensitive segment/substring match).
const EXCLUDE_PATTERNS = [
  "apps/itotori/",
  "/fixtures/",
  "/target/",
  "/dist/",
  "/migrations/",
  "docs/",
  "roadmap/",
  ".qd/",
  ".plan/",
  "CHANGELOG",
];

// Each pattern extracts one node-id TOKEN per match. `TODO(<node>)` and any
// other wrapping form is subsumed: the bare id pattern matches the id inside
// it, so no separate TODO rule is needed. The `u` flag is omitted on the
// capture alternation only where it would reject a leading digit boundary; all
// patterns use word boundaries so identifier fragments never false-fire.
const NODE_ID_PATTERNS = [
  // `<PREFIX>-<number>` roadmap/ticket ids.
  /\b(?:RB|ITOTORI|KAIFUU|UTSUSHI)-\d+\b/gi,
  // `p0-core-<slug>` predecessor node slugs.
  /\bp0-core-[a-z0-9-]+\b/gi,
  // Prose deferrals that name "a node" without a stable id — equally stale.
  /\bfollow-up node\b/gi,
  /\bsee node\b/gi,
  /\bdeferred for node\b/gi,
];

export function isExcludedPath(path) {
  return EXCLUDE_PATTERNS.some((p) => path.includes(p));
}

export function shouldScan(path) {
  if (isExcludedPath(path)) return false;
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return SCAN_EXTENSIONS.has(path.slice(dot));
}

// Extract one violation per node-id token found. A line carrying two refs
// yields two entries (two tokens) so each grandfathered reference is tracked
// individually. Exported for the regression suite.
export function findNodeIdViolations(path, contents) {
  const found = [];
  const lines = contents.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") continue;
    for (const regex of NODE_ID_PATTERNS) {
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
"node scripts/audit-no-node-ids.mjs --update". Each entry is a grandfathered
node-id token (the matched reference text, lower-cased); the multiset per file
may only shrink. When empty/deleted the guard is absolute (zero node ids).`;

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
// was never grandfathered anywhere (a brand-new node id). Renames / reflows of
// already-grandfathered ids at equal-or-lower total are allowed.
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
  const out = execSync("git ls-files crates packages", {
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
    violations.push(...findNodeIdViolations(rel, contents));
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
    "usage: node scripts/audit-no-node-ids.mjs [--check|--update|--init] [--whitelist PATH] [--root DIR] [<file>...]",
    "",
    "check   fail on any node-id reference not covered by the shrink-only whitelist (default).",
    "update  rewrite the whitelist from the current tree; REFUSE to grow (cleanup ratchet).",
    "init    one-time bootstrap: write the whitelist from the current tree unconditionally.",
    "        Use ONLY to seed the initial baseline; a committed baseline is shrink-only after.",
  ].join("\n");
}

function runCheck(violations, scanned, whitelist) {
  const { ok, newViolations } = evaluateCheck(violations, whitelist);
  if (ok) {
    process.stdout.write(
      `node-id guard: passed. ${violations.length} grandfathered reference(s) across ` +
        `${scanned} scanned files; no new node-id references.\n`,
    );
    return 0;
  }
  process.stderr.write(
    `node-id guard: FAILED. ${newViolations.length} new node-id reference(s) not covered by ` +
      `${DEFAULT_WHITELIST_PATH}.\n` +
      "Node-id references are stale-on-write; clean them instead of whitelisting.\n\n",
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
    `node-id guard: initial whitelist seeded with ${built.total} token(s) across ` +
      `${Object.keys(built.files).length} files.\n` +
      `Wrote ${target}\n` +
      "Future cleanup uses --update (shrink-only; refuses to grow).\n",
  );
  return 0;
}

function runUpdate(violations, oldWhitelist, target) {
  if (oldWhitelist.total === 0 && Object.keys(oldWhitelist.files).length === 0) {
    process.stderr.write(
      "node-id guard: --update REFUSED — no committed baseline to shrink from.\n" +
        "  Run --init ONCE to seed the initial whitelist; afterwards --update is shrink-only.\n",
    );
    return 1;
  }
  const result = evaluateUpdate(violations, oldWhitelist);
  if (!result.ok) {
    process.stderr.write(
      `node-id guard: --update REFUSED (whitelist may only shrink).\n` +
        `  total: ${result.oldTotal} -> ${result.newTotal}${result.grew ? " (GREW)" : ""}\n`,
    );
    if (result.novelTokens.length > 0) {
      process.stderr.write(
        `  ${result.novelTokens.length} brand-new node id(s) never grandfathered:\n`,
      );
      for (const t of result.novelTokens) process.stderr.write(`    "${t}"\n`);
    }
    process.stderr.write("Clean the new references; do not expand the whitelist.\n");
    return 1;
  }
  writeFileSync(target, `${JSON.stringify(result.whitelist, null, 2)}\n`);
  process.stdout.write(
    `node-id guard: whitelist ratcheted ${result.oldTotal} -> ${result.newTotal} ` +
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
      violations = (violations ?? []).concat(findNodeIdViolations(rel, contents));
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
