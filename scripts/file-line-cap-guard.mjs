#!/usr/bin/env node
// CI guard: 500-line file cap with a grandfather + shrink-only ratchet.
//
// Large files accrete; a hard cap would force-split the kept moat
// (kaifuu-core/lib.rs etc.), which is a dedicated refactor, not a lint fix.
// Instead this guard GRANDFATHERS the current over-limit files at their CURRENT
// line count and forbids growth: a grandfathered file may shrink, never grow,
// and no NEW file may exceed the cap. The whitelist entries (and the per-file
// counts) may only shrink, so the cap ratchets toward 500 as files are
// modularized.
//
// Ratchet model:
//   - `check` (default): a file > THRESHOLD fails if (a) it is NOT in the
//     whitelist (new oversized file), or (b) it IS whitelisted but its current
//     line count EXCEEDS the recorded count (it grew). A whitelisted file at or
//     below its recorded count passes.
//   - `--update` (alias `--regenerate`): rewrites the whitelist from the
//     current tree, REFUSING to grow — fails if a NEW oversized file appears
//     (would add an entry) or any recorded count increased. A file that shrank
//     (lower count, or dropped below the cap and out of the whitelist) is
//     allowed. `--init` bootstraps the one-time initial baseline.
//   - When the whitelist reaches empty (all files modularized under the cap),
//     the guard is absolute: every file must stay at or below the cap.
//
// Scope: tracked `crates/**/*.rs` (the documented file-size tension is a Rust
// phenomenon; package TS may be added later). Generated/build output
// (`target/`, `dist/`) is excluded as untracked anyway. Lines are counted as
// newline characters (matches `wc -l`), deliberately INCLUDING inline
// `#[cfg(test)] mod tests` lines so the cap reflects true file size.
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
const DEFAULT_WHITELIST_PATH = join(here, "lint", "file-line-cap-whitelist.json");

export const THRESHOLD = 500;

const WHITELIST_HEADER = `RATCHET WHITELIST (shrink-only). Do not hand-edit; regenerate via
"node scripts/file-line-cap-guard.mjs --update". Each entry maps an over-cap
file to its grandfathered line count; counts and entries may only shrink. When
empty/deleted the cap is absolute (no file may exceed the threshold).`;

export function emptyWhitelist() {
  return {
    description: WHITELIST_HEADER,
    threshold: THRESHOLD,
    generatedAt: null,
    total: 0,
    files: {},
  };
}

export function loadWhitelist(path) {
  if (!existsSync(path)) return emptyWhitelist();
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return {
    description: WHITELIST_HEADER,
    threshold: parsed.threshold ?? THRESHOLD,
    generatedAt: parsed.generatedAt ?? null,
    total: parsed.total ?? 0,
    files: parsed.files ?? {},
  };
}

// Count lines as newline characters (matches `wc -l`), so the recorded counts
// are stable against how an editor renders a trailing partial line.
export function countLines(contents) {
  let n = 0;
  for (let i = 0; i < contents.length; i += 1) {
    if (contents.charCodeAt(i) === 10) n += 1;
  }
  return n;
}

// `check`: classify every over-cap file. Returns violations of kind "new"
// (not grandfathered) or "grew" (grandfathered but larger than recorded).
export function evaluateCheck(fileCounts, whitelist) {
  const allowed = whitelist.files ?? {};
  const violations = [];
  for (const [file, count] of fileCounts) {
    if (count <= whitelist.threshold) continue;
    if (!(file in allowed)) {
      violations.push({ file, kind: "new", count, allowed: null });
    } else if (count > allowed[file]) {
      violations.push({ file, kind: "grew", count, allowed: allowed[file] });
    }
  }
  return { ok: violations.length === 0, violations };
}

// Build the prospective whitelist from current over-cap files (sorted for a
// stable diff), regardless of growth — the caller decides whether to accept.
export function buildNextWhitelist(fileCounts, threshold, at) {
  const files = {};
  for (const file of [...fileCounts.keys()].sort()) {
    const count = fileCounts.get(file);
    if (count > threshold) files[file] = count;
  }
  return {
    description: WHITELIST_HEADER,
    threshold,
    generatedAt: at,
    total: Object.keys(files).length,
    files,
  };
}

// `--update`: refuse to grow. Growth = a NEW over-cap file (entry added) or a
// recorded count that increased. Shrinking (count down, or file dropped below
// the cap and out) is allowed. A rename appears as a new entry and is refused —
// update the whitelist key manually, or split the file first.
export function evaluateUpdate(fileCounts, oldWhitelist) {
  const threshold = oldWhitelist.threshold ?? THRESHOLD;
  const oldFiles = oldWhitelist.files ?? {};
  const next = buildNextWhitelist(fileCounts, threshold, new Date().toISOString());
  const newEntries = [];
  const grew = [];
  for (const [file, count] of Object.entries(next.files)) {
    if (!(file in oldFiles)) newEntries.push({ file, count });
    else if (count > oldFiles[file]) grew.push({ file, count, allowed: oldFiles[file] });
  }
  const ok = newEntries.length === 0 && grew.length === 0;
  return {
    ok,
    newEntries,
    grew,
    oldTotal: oldWhitelist.total ?? 0,
    newTotal: next.total,
    whitelist: next,
  };
}

// ---- tree scanning ---------------------------------------------------------

export function listScanFiles(root) {
  const out = execSync("git ls-files crates", {
    cwd: root,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.endsWith(".rs"));
}

function scanTree(root) {
  const counts = new Map();
  for (const rel of listScanFiles(root)) {
    let contents;
    try {
      contents = readFileSync(join(root, rel), "utf8");
    } catch {
      continue;
    }
    counts.set(rel, countLines(contents));
  }
  return counts;
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
    "usage: node scripts/file-line-cap-guard.mjs [--check|--update|--init] [--whitelist PATH] [--root DIR] [<file>...]",
    "",
    `check   fail on any .rs file over ${THRESHOLD} lines not grandfathered, or a grandfathered file that grew (default).`,
    "update  rewrite the whitelist from the current tree; REFUSE to grow (shrink ratchet).",
    "init    one-time bootstrap: write the whitelist from the current tree unconditionally.",
  ].join("\n");
}

function summarizeOverCap(counts, threshold) {
  let files = 0;
  let lines = 0;
  for (const c of counts.values()) {
    if (c > threshold) {
      files += 1;
      lines += c;
    }
  }
  return { files, lines };
}

function runCheck(counts, whitelist) {
  const { ok, violations } = evaluateCheck(counts, whitelist);
  if (ok) {
    const over = summarizeOverCap(counts, whitelist.threshold);
    process.stdout.write(
      `file-line-cap guard: passed. ${over.files} grandfathered file(s) over ` +
        `${whitelist.threshold} lines (total ${over.lines}); nothing new, nothing grew.\n`,
    );
    return 0;
  }
  process.stderr.write(
    `file-line-cap guard: FAILED. ${violations.length} over-cap file(s) not allowed ` +
      `by ${DEFAULT_WHITELIST_PATH}.\n` +
      `New files must stay <= ${whitelist.threshold} lines; grandfathered files may only shrink.\n\n`,
  );
  for (const v of violations) {
    if (v.kind === "new") {
      process.stderr.write(`  NEW   ${v.file}  (${v.count} > ${whitelist.threshold})\n`);
    } else {
      process.stderr.write(`  GREW  ${v.file}  (${v.count} > allowed ${v.allowed})\n`);
    }
  }
  return 1;
}

function runInit(counts, target) {
  const built = buildNextWhitelist(counts, THRESHOLD, new Date().toISOString());
  writeFileSync(target, `${JSON.stringify(built, null, 2)}\n`);
  process.stdout.write(
    `file-line-cap guard: initial whitelist seeded with ${built.total} file(s) over ${THRESHOLD} lines.\n` +
      `Wrote ${target}\n` +
      `Future cleanup uses --update (shrink-only; refuses to grow).\n`,
  );
  return 0;
}

function runUpdate(counts, oldWhitelist, target) {
  if (oldWhitelist.total === 0 && Object.keys(oldWhitelist.files).length === 0) {
    process.stderr.write(
      "file-line-cap guard: --update REFUSED — no committed baseline to shrink from.\n" +
        "  Run --init ONCE to seed the initial whitelist; afterwards --update is shrink-only.\n",
    );
    return 1;
  }
  const result = evaluateUpdate(counts, oldWhitelist);
  if (!result.ok) {
    process.stderr.write(
      `file-line-cap guard: --update REFUSED (whitelist may only shrink).\n` +
        `  entries: ${result.oldTotal} -> ${result.newTotal}\n`,
    );
    for (const e of result.newEntries) {
      process.stderr.write(`  NEW ENTRY  ${e.file}  (${e.count} lines; was not grandfathered)\n`);
    }
    for (const g of result.grew) {
      process.stderr.write(`  GREW       ${g.file}  (${g.count} > allowed ${g.allowed})\n`);
    }
    process.stderr.write("Split the file or trim it; do not expand the whitelist.\n");
    return 1;
  }
  writeFileSync(target, `${JSON.stringify(result.whitelist, null, 2)}\n`);
  process.stdout.write(
    `file-line-cap guard: whitelist ratcheted ${result.oldTotal} -> ${result.newTotal} file(s).\n` +
      `Wrote ${target}\n`,
  );
  return 0;
}

function readCounts(opts) {
  const counts = new Map();
  if (opts.files.length > 0) {
    for (const f of opts.files) {
      try {
        counts.set(f, countLines(readFileSync(f, "utf8")));
      } catch {
        continue;
      }
    }
    return counts;
  }
  return scanTree(opts.root);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const whitelist = loadWhitelist(opts.whitelist);
  const counts = readCounts(opts);
  if (opts.mode === "update") {
    process.exit(runUpdate(counts, whitelist, opts.whitelist));
  }
  if (opts.mode === "init") {
    process.exit(runInit(counts, opts.whitelist));
  }
  process.exit(runCheck(counts, whitelist));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
