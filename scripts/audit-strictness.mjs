#!/usr/bin/env node
// strictness-ci-guard-bans-laxity-reintroduction — CI guard that makes the
// strictness pass self-enforcing. Once the strictness cluster tightened the
// repo (reasons on every `#[ignore]`/`#[allow(...)]`, max-strict clippy,
// `deny`-level bans, strict real-bytes floors, a full real-bytes CI lane),
// nothing may silently reintroduce the old laxity. This script greps the
// Rust tree + build config for the forbidden-laxity shapes and fails the
// build (exit 1, one line per hit) if any reappear.
//
// It MIRRORS scripts/audit-no-hardcoded-cost.mjs in structure, style, exit
// codes, comment-skipping, and file-scanning; the companion regression suite
// scripts/audit-strictness.test.mjs exercises every rule below.
//
// Rules:
//   1. Bare `#[ignore]` with no reason — every ignore must be
//      `#[ignore = "…"]`.
//   2. `#[allow(...)]` / `#![allow(...)]` without an inline `// reason:` in the
//      attached comment block (mirrors the keystone's inventory.rs example).
//   3. `deny.toml` `multiple-versions` / `wildcards` bans left at anything
//      other than `"deny"`.
//   4. Relaxed fractional / count floors on assert lines inside
//      `crates/**/tests/*_real_bytes.rs`, unless the line carries an inline
//      justification (`// reason:` / `// justification:` / a
//      `TODO(strictness-fix-relaxed-floors-to-strict)` reference).
//   5. A real-bytes `#[ignore]` / `*_real_bytes.rs` test in a crate that the
//      `ci-real-bytes` justfile lane (the periodic ground-truth oracle) does
//      NOT run, and that is not on the transitional allowlist owned by
//      `strictness-invert-real-bytes-default-and-full-crate-coverage`.
//
// (A former rule 6 banned enabling the real-bytes corpus opt-out flag. The
// synthetic-CI collapse REMOVED that opt-out entirely — real-bytes coverage is
// now unconditionally strict, so there is no opt-out to guard. The rule and its
// regression tests were deleted with the flag, per no-legacy-compat.)
//
// Exit codes:
//   0 — no violations
//   1 — at least one violation detected; details printed to stderr
//
// Run: `node scripts/audit-strictness.mjs`   (scan the tracked repo)
//      `node scripts/audit-strictness.mjs --self-test-crate-set a,b`  (unused;
//        the regression suite calls the exported helpers directly)
// Wired into `just check` next to the audit-no-hardcoded-cost lines.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// ---------------------------------------------------------------------------
// Rule 5 allowlist. Previously carried kaifuu-rpgmaker / utsushi-core /
// kaifuu-vault-source, whose real-bytes / live-corpus tests were not yet in the
// `ci-real-bytes` lane. The node
// `strictness-invert-real-bytes-default-and-full-crate-coverage` added ALL of
// them to the lane, so the allowlist is now EMPTY — every crate that owns a
// real-bytes test must be in the lane, no exceptions. Adding a crate here again
// is a laxity regression the guard exists to prevent.
const RULE5_TRANSITIONAL_ALLOWLIST = new Set([]);
const RULE5_ALLOWLIST_NODE = "strictness-invert-real-bytes-default-and-full-crate-coverage";

// Rule 4 justification markers: an assert-line floor is exempt when the line
// carries one of these inline comments. `TODO(strictness-fix-relaxed-floors-…)`
// names the node that will tighten a genuinely-relaxed floor to strict; a bare
// `reason:` / `justification:` documents a floor that is a real domain bound
// (e.g. an audio channel count) rather than laxity.
const RULE4_JUSTIFICATION =
  /\/\/[^\n]*(?:reason:|justification:|TODO\(strictness-fix-relaxed-floors-to-strict\))/iu;

// A `// reason:`-style marker for rule 2. Accepts the keystone form
// (`// reason: …`) in a line/doc comment.
const REASON_MARKER = /\/\/[^\n]*reason:/iu;

function isCommentLine(trimmed) {
  return trimmed.startsWith("//");
}

// ---- Rule 1: bare `#[ignore]` -------------------------------------------
// A real bare ignore attribute is a line whose ENTIRE trimmed content is
// `#[ignore]` (optionally with a trailing `//` comment). This deliberately
// does NOT match `#[ignore = "…"]` (reasoned) nor `#[ignore]`-in-prose such as
// a doc comment or a string literal continuation (`#[ignore]-gated …`), which
// carry trailing non-attribute text.
const BARE_IGNORE = /^#\[\s*ignore\s*\]\s*(?:\/\/.*)?$/u;

export function checkBareIgnore(path, contents) {
  const found = [];
  const lines = contents.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (BARE_IGNORE.test(trimmed)) {
      found.push({
        file: path,
        line: i + 1,
        rule: "bare #[ignore] without a reason",
        excerpt: trimmed.slice(0, 200),
      });
    }
  }
  return found;
}

// ---- Rule 2: unreasoned `#[allow(...)]` ----------------------------------
// Fires on an outer `#[allow(...)]` or inner `#![allow(...)]` attribute line
// that lacks a `// reason:` marker either inline OR anywhere in the contiguous
// comment block directly above it (walking up over `//`/`///` lines).
const ALLOW_ATTR = /^#!?\[\s*allow\s*\(/u;

export function checkUnreasonedAllow(path, contents) {
  const found = [];
  const lines = contents.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!ALLOW_ATTR.test(trimmed)) continue;
    if (REASON_MARKER.test(line)) continue; // inline `// reason:`
    // Walk up over the contiguous comment block immediately above.
    let reasoned = false;
    for (let j = i - 1; j >= 0; j -= 1) {
      const above = lines[j].trim();
      if (!isCommentLine(above)) break;
      if (REASON_MARKER.test(lines[j])) {
        reasoned = true;
        break;
      }
    }
    if (!reasoned) {
      found.push({
        file: path,
        line: i + 1,
        rule: "#[allow(...)] without a `// reason:`",
        excerpt: trimmed.slice(0, 200),
      });
    }
  }
  return found;
}

// ---- Rule 3: deny.toml bans left below `deny` ----------------------------
const DENY_LOCKED_KEYS = ["multiple-versions", "wildcards"];

export function checkDenyBans(contents) {
  const found = [];
  const lines = contents.split(/\r?\n/u);
  const seen = new Map();
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("#")) continue; // skip TOML comments
    for (const key of DENY_LOCKED_KEYS) {
      const m = trimmed.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "u"));
      if (m) seen.set(key, m[1]);
    }
  }
  for (const key of DENY_LOCKED_KEYS) {
    const value = seen.get(key);
    if (value !== "deny") {
      found.push({
        file: "deny.toml",
        line: 0,
        rule: `deny.toml \`${key}\` must be "deny"`,
        excerpt: value === undefined ? `${key} = <missing>` : `${key} = "${value}"`,
      });
    }
  }
  return found;
}

// ---- Rule 4: relaxed floors on real-bytes assert lines -------------------
// Floor shapes that indicate a relaxed acceptance bar. `<= <digit>` is a
// ceiling on tolerated failures/unknowns; `>= 0.<frac>` is a fractional pass
// rate; `>= MIN_*_COUNT` / `<= MIN_*_COUNT` compares against a MIN constant
// standing in for the true EXPECTED; `assert_at_least`/`_at_least(` is a
// lower-bound helper. `(?<![<>])<=` avoids matching the `<<=` shift operator.
const FLOOR_PATTERNS = [
  /(?<![<>])<=\s*\d/u,
  />=\s*0\.\d/u,
  /(?:>=|<=)\s*MIN_[A-Z0-9_]*COUNT/u,
  /\bat_least\s*\(/u,
];
const ASSERT_OPEN = /\bassert(?:_eq|_ne)?!\s*\(/u;

function isRealBytesTestPath(path) {
  return /\/tests\/[^/]*_real_bytes\.rs$/u.test(path) || path.endsWith("_real_bytes.rs");
}

export function checkRelaxedFloors(path, contents) {
  if (!isRealBytesTestPath(path)) return [];
  const found = [];
  const lines = contents.split(/\r?\n/u);
  // Track assert-macro nesting by paren depth so a floor on a continuation
  // line (the common multi-line `assert!(` form) is still an "assert line".
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    const wasInAssert = depth > 0;
    const opensHere = ASSERT_OPEN.test(line);
    if (opensHere || wasInAssert) {
      // Update depth across this line's parens.
      const opens = (line.match(/\(/gu) || []).length;
      const closes = (line.match(/\)/gu) || []).length;
      if (opensHere && !wasInAssert) {
        // start counting from the assert's own paren
        depth = opens - closes;
      } else {
        depth += opens - closes;
      }
      if (depth < 0) depth = 0;
    }
    if (isCommentLine(trimmed)) continue;
    const inAssert = opensHere || wasInAssert;
    if (!inAssert) continue;
    // Justification may sit inline OR in the contiguous comment block directly
    // above the floor line (fmt moves trailing attribute/arg comments onto
    // their own preceding line, so a block-comment marker is the stable form).
    if (RULE4_JUSTIFICATION.test(line)) continue;
    let justifiedAbove = false;
    for (let j = i - 1; j >= 0; j -= 1) {
      const above = lines[j].trim();
      if (!isCommentLine(above)) break;
      if (RULE4_JUSTIFICATION.test(lines[j])) {
        justifiedAbove = true;
        break;
      }
    }
    if (justifiedAbove) continue;
    for (const pat of FLOOR_PATTERNS) {
      if (pat.test(line)) {
        found.push({
          file: path,
          line: i + 1,
          rule: "relaxed floor on a real-bytes assert without justification",
          excerpt: trimmed.slice(0, 200),
        });
        break;
      }
    }
  }
  return found;
}

// ---- Rule 5: real-bytes crate not covered by the lane --------------------
// Parse the `-p <crate>` set the `ci-real-bytes` recipe passes to
// `cargo test`, then flag any crate that owns a real-bytes/live-corpus
// `#[ignore]` test yet is absent from that lane (and not on the transitional
// allowlist).
export function parseLaneCrates(justfileText) {
  const lines = justfileText.split(/\r?\n/u);
  let inRecipe = false;
  const crates = new Set();
  for (const line of lines) {
    if (/^ci-real-bytes\s*:/u.test(line)) {
      inRecipe = true;
      continue;
    }
    if (inRecipe && /^\S/u.test(line)) break; // next top-level recipe
    if (inRecipe && /cargo\s+test\b/u.test(line)) {
      for (const m of line.matchAll(/-p\s+(\S+)/gu)) crates.add(m[1]);
    }
  }
  return crates;
}

// A crate "owns a real-bytes test" if it contains a `*_real_bytes.rs` file OR
// a real `#[ignore = "…"]` attribute whose reason names a live external
// corpus (`ITOTORI_REAL_GAME_ROOT*`, `ITOTORI_VAULT_ROOT`, or
// `ITOTORI_SOFTPAL_RESEARCH_ROOT` — the standalone Softpal research tree,
// wired into the periodic `ci-real-bytes` lane with skip-when-absent at the
// lane level).
const IGNORE_REASON = /^#\[\s*ignore\s*=\s*"([^"]*)"/u;
const LIVE_CORPUS_ENV = /ITOTORI_REAL_GAME_ROOT|ITOTORI_VAULT_ROOT|ITOTORI_SOFTPAL_RESEARCH_ROOT/u;

export function crateOwnsRealBytes(path, contents) {
  if (isRealBytesTestPath(path)) return true;
  const lines = contents.split(/\r?\n/u);
  for (const line of lines) {
    const m = line.trim().match(IGNORE_REASON);
    if (m && LIVE_CORPUS_ENV.test(m[1])) return true;
  }
  return false;
}

function crateOfPath(path) {
  const m = path.match(/^crates\/([^/]+)\//u);
  return m ? m[1] : undefined;
}

// Pure evaluator (exported for the regression suite): given the set of crates
// that own real-bytes tests and the lane's crate set, return the crates that
// violate rule 5.
export function evaluateRealBytesCoverage(realBytesCrates, laneCrates) {
  const found = [];
  for (const crate of [...realBytesCrates].sort()) {
    if (laneCrates.has(crate)) continue;
    if (RULE5_TRANSITIONAL_ALLOWLIST.has(crate)) continue;
    found.push({
      file: `crates/${crate}`,
      line: 0,
      rule: `real-bytes crate '${crate}' is not in the ci-real-bytes lane`,
      excerpt: `add -p ${crate} to the ci-real-bytes recipe (or allowlist via ${RULE5_ALLOWLIST_NODE})`,
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
function listTrackedRustFiles() {
  const out = execSync("git ls-files crates", { cwd: repoRoot, encoding: "utf8" });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".rs"));
}

function readRepoFile(relPath) {
  try {
    return readFileSync(join(repoRoot, relPath), "utf8");
  } catch {
    return undefined;
  }
}

function runAudit() {
  const violations = [];

  const rustFiles = listTrackedRustFiles();
  const realBytesCrates = new Set();
  for (const relPath of rustFiles) {
    const contents = readRepoFile(relPath);
    if (contents === undefined) continue;
    violations.push(...checkBareIgnore(relPath, contents));
    violations.push(...checkUnreasonedAllow(relPath, contents));
    violations.push(...checkRelaxedFloors(relPath, contents));
    if (crateOwnsRealBytes(relPath, contents)) {
      const crate = crateOfPath(relPath);
      if (crate) realBytesCrates.add(crate);
    }
  }

  const denyToml = readRepoFile("deny.toml");
  if (denyToml === undefined) {
    violations.push({
      file: "deny.toml",
      line: 0,
      rule: "deny.toml is missing",
      excerpt: "the workspace ban config must exist",
    });
  } else {
    violations.push(...checkDenyBans(denyToml));
  }

  const justfile = readRepoFile("justfile");
  const laneCrates = justfile ? parseLaneCrates(justfile) : new Set();
  violations.push(...evaluateRealBytesCoverage(realBytesCrates, laneCrates));

  if (violations.length > 0) {
    process.stderr.write(
      `strictness audit failed: ${violations.length} laxity ` +
        `pattern${violations.length === 1 ? "" : "s"} found.\n` +
        "The strictness pass is self-enforcing: no `#[ignore]`/`#[allow]` without a reason, " +
        "no relaxed real-bytes floors, deny.toml bans locked at `deny`, and every real-bytes " +
        "crate must be in the ci-real-bytes lane (or its transitional allowlist).\n\n",
    );
    for (const v of violations) {
      const loc = v.line > 0 ? `${v.file}:${v.line}` : v.file;
      process.stderr.write(`  ${loc}  [${v.rule}]\n    ${v.excerpt}\n`);
    }
    return 1;
  }

  process.stdout.write(
    `strictness audit passed: ${rustFiles.length} Rust files scanned; ` +
      "no reintroduced laxity found.\n",
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(runAudit());
}
