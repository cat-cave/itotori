#!/usr/bin/env node
// auth-006-no-hardcoded-roles-guard — CI guard that makes Trevor's
// NON-NEGOTIABLE authorization invariant self-enforcing. Access control in
// itotori is PERMISSION-BASED; shipped source must NEVER branch an auth
// decision on a role name. Once the permission model landed
// (packages/itotori-db/src/authorization.ts — `permissionValues` +
// `requirePermission`, NO `roleValues`), nothing may silently reintroduce
// role-name auth branching. This script greps shipped src for the forbidden
// auth-role-branching shapes and fails the build (exit 1, one line per hit)
// if any appear.
//
// It MIRRORS scripts/audit-no-hardcoded-cost.mjs in structure, style, exit
// codes, comment-skipping, and file-scanning; the companion regression suite
// scripts/audit-no-hardcoded-roles.test.mjs exercises every pattern below.
//
// The invariant it enforces is already stated in docs/permissions.md
// ("Authorization checks must not branch on role names"); this guard turns
// that prose into a CI gate. See the "No-Hardcoded-Roles Guard" section there.
//
// Forbidden patterns (each fires in every scanned shipped-src file):
//   1. Bare `role === "..."` / `role == "..."` — a variable named exactly
//      `role` compared to a string literal, the shape of `if (role === "admin")`.
//      The lookbehind `(?<![.\w$])` deliberately does NOT match a property
//      access (`message.role`, `args.role`, `u.role`) — those are chat-message
//      / proof-stage / text-role domain comparisons, not auth-role branching.
//      In the current tree this fires on exactly the two documented
//      domain-role sites below, which carry the allowlist marker.
//   2. `isAdmin` / `is_admin` — the classic auth-gating boolean.
//   3. `hasRole(` / `has_role(` — the classic auth-gating helper.
//   4. `roleValues` — an auth-roles enum (mirrors `permissionValues`); a
//      role enum used for branching is exactly what the permission model
//      replaces.
//   5. `ROLES` (all-caps constant) — an auth-roles enum literal.
//   6. `actor.role` — gating on the authorization actor's role field. The
//      permission-based `AuthorizationActor` deliberately carries only
//      `userId`; an `actor.role` access is the anti-pattern.
//
// Allowlist — genuine DOMAIN (non-auth) roles:
//   A real domain role that must branch on a `role`-named value (e.g. a proof
//   stage role like "draft", or a translation-source role like
//   "official_translation") carries an explicit per-line marker:
//       // authz-guard:allow domain-role — <reason>
//   The marker REQUIRES a non-empty token after `allow` (the convention is the
//   literal `domain-role` tag plus a short reason) so a reviewer can judge each
//   exemption individually. This is the ONLY opt-out; it is never a blanket
//   tree exemption, and it never disables the check. The two known domain-role
//   sites in the current tree are:
//     - apps/itotori/src/provider-proof/harness.ts (`role === "draft"` — a
//       proof stage role, not an auth role)
//     - packages/itotori-db/src/services/catalog-recorded-importers.ts
//       (`role === "official_translation"` — a DLsite translation-source
//       role, not an auth role)
//
// Exit codes:
//   0 — no violations
//   1 — at least one violation detected; details printed to stderr
//
// Run: `node scripts/audit-no-hardcoded-roles.mjs`            (scan shipped src)
//      `node scripts/audit-no-hardcoded-roles.mjs <file>...`  (scan files; used
//        by the regression suite / ad-hoc checks against a crafted fixture)
// Wired into `just check` (which `just ci` depends on) next to the
// audit-no-hardcoded-cost / audit-strictness lines.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// Patterns: each fires a violation if matched on a non-comment line outside a
// per-line allowlist marker. `label` is human-readable for the error report.
// Every pattern fires in every scanned shipped-src file; there is no per-tree
// exemption.
const FORBIDDEN_PATTERNS = [
  {
    // A variable named exactly `role` compared to a string literal. This is
    // the shape of `if (role === "admin")` / `role == "admin"`. The lookbehind
    // `(?<![.\w$])` ensures the character immediately before `role` is NOT a
    // `.`, a word char, or `$`, so property accesses (`message.role`,
    // `args.role`, `u.role`, `actor.role`) are NOT matched here — those are
    // domain comparisons (chat-message role, proof-stage role, text role).
    // `actor.role` has its OWN dedicated pattern below. The string literal may
    // be single-/double-/back-quoted so template literals are caught too.
    label: 'auth role-name branching: `role === "..."` / `role == "..."`',
    regex: /(?<![.\w$])role\s*(?:===|==)\s*["'`]/u,
  },
  {
    // `isAdmin` / `is_admin` — the classic auth-gating boolean used as an
    // authorization shortcut. Case-sensitive on the two real spellings
    // (camelCase + snake_case) so a domain `isAdministrator`-style helper name
    // is not silently caught by accident while still netting both ecosystems.
    label: "auth-role boolean `isAdmin` / `is_admin`",
    regex: /\bis_?[Aa]dmin\b/u,
  },
  {
    // `hasRole(...)` / `has_role(...)` — the classic auth-gating helper that
    // branches on a role name. Fires on the call shape so a type/fixture named
    // `hasRole` (no call) is not caught, matching how it would actually gate.
    label: "auth-role helper `hasRole(...)` / `has_role(...)`",
    regex: /\bhas_?[Rr]ole\s*\(/u,
  },
  {
    // `roleValues` — an auth-roles enum literal. The permission model uses
    // `permissionValues` for its source of truth; a `roleValues` enum is the
    // shape the model replaced and forbids reintroducing.
    label: "auth-roles enum `roleValues`",
    regex: /\broleValues\b/u,
  },
  {
    // `ROLES` all-caps constant — an auth-roles enum literal (the SCREAMING_SNAKE
    // form of the `roleValues` pattern). Case-sensitive all-caps so a lowercase
    // `roles` array/field (a legitimate domain collection) is never matched.
    label: "auth-roles enum `ROLES`",
    regex: /\bROLES\b/u,
  },
  {
    // `actor.role` — gating on the authorization actor's role field. The
    // permission-based `AuthorizationActor` deliberately carries only `userId`;
    // any `actor.role` access is the auth-role anti-pattern reintroduced.
    label: "auth-actor role gating `actor.role`",
    regex: /\bactor\.role\b/u,
  },
];

// The per-line comment prefixes that mark a line as commentary rather than real
// code. Shared across the pass. Mirrors audit-no-hardcoded-cost.mjs so SQL
// (`--`) and shell/toml (`#`) comment forms are honored too.
function isCommentLine(trimmed) {
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("--") ||
    trimmed.startsWith("#")
  );
}

// The per-line allowlist escape hatch for a genuine DOMAIN (non-auth) role:
//   // authz-guard:allow domain-role — <reason>
// The marker REQUIRES a non-empty token after `allow` (the convention is the
// literal `domain-role` tag plus a short reason) so a bare
// `// authz-guard:allow` cannot silently opt a real auth-role branch out. This
// is the ONLY per-line opt-out; it is never a blanket tree exemption. The
// marker may sit INLINE on the violating line (a trailing `// ...` comment,
// mirroring audit-no-hardcoded-cost.mjs) OR anywhere in the contiguous
// comment block directly above it (mirroring audit-strictness.mjs's
// `// reason:` walk), so both idiomatic styles are honored.
function hasAllowMarker(line) {
  return /authz-guard:allow\s+\S/u.test(line);
}

// True iff the domain-role allowlist marker sits on `lines[i]` (inline) OR in
// the contiguous `//`-comment block immediately above it. fmt/rustfmt often
// move trailing comments onto their own preceding line, so the block walk
// makes the marker stable across formatting.
function markerOnLineOrAbove(lines, i) {
  if (hasAllowMarker(lines[i])) return true;
  for (let j = i - 1; j >= 0; j -= 1) {
    const above = lines[j].trim();
    if (!isCommentLine(above)) break;
    if (hasAllowMarker(lines[j])) return true;
  }
  return false;
}

// Return every forbidden-pattern violation in `contents`, tagged with the
// repo-relative `path` for reporting. Exported for the regression suite.
export function findViolations(path, contents) {
  const found = [];
  const lines = contents.split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    // Skip comment-only lines so that the audit's own forbidden-pattern names
    // + doc references do not trigger violations. Bare comment lines beginning
    // with `//`, `*`, `--`, or `#` are exempt.
    const trimmed = line.trim();
    if (isCommentLine(trimmed)) {
      continue;
    }
    // Per-line domain-role escape hatch: `// authz-guard:allow domain-role`
    // marks a single line whose `role === "..."` is a genuine domain
    // (non-auth) role branch (e.g. a proof stage role, a translation-source
    // role), honored inline OR on the contiguous comment block above. This is
    // the ONLY per-line opt-out.
    if (markerOnLineOrAbove(lines, lineIndex)) {
      continue;
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.regex.test(line)) {
        found.push({
          file: path,
          line: lineIndex + 1,
          pattern: pattern.label,
          excerpt: trimmed.slice(0, 200),
        });
      }
    }
  }
  return found;
}

// Scan scope: shipped src only. The brief specifies apps/*/src +
// packages/*/src + crates/*/src, excluding tests/fixtures/node_modules/docs.
// A file is scanned iff it lives under an apps/packages/crates `*/src/` tree,
// is NOT under a tests/fixtures/node_modules/docs segment, and has a scanned
// source extension.
const SCANNABLE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".rs"];

function inShippedSrc(path) {
  return /(?:^|\/)(?:apps|packages|crates)\/[^/]+\/src\//u.test(path);
}

function isExcluded(path) {
  return /(?:^|\/)(?:tests?|fixtures|node_modules|docs)\//u.test(path);
}

function shouldScan(path) {
  if (!inShippedSrc(path)) return false;
  if (isExcluded(path)) return false;
  return SCANNABLE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function listTrackedFiles() {
  const out = execSync("git ls-files apps packages crates", {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Resolve the set of repo-relative paths to scan. With no CLI args we scan the
// tracked shipped-src tree; with args we scan exactly those files (used by the
// regression suite / ad-hoc checks against a crafted fixture).
function resolveScanTargets(args) {
  if (args.length === 0) {
    return listTrackedFiles().map((file) => ({ relPath: file, absPath: join(repoRoot, file) }));
  }
  return args.map((arg) => {
    const absPath = resolve(arg);
    const relPath = relative(repoRoot, absPath);
    return { relPath: relPath.startsWith("..") ? absPath : relPath, absPath };
  });
}

function runAudit(args) {
  const targets = resolveScanTargets(args);
  const violations = [];
  let scannedCount = 0;
  for (const { relPath, absPath } of targets) {
    if (!shouldScan(relPath)) continue;
    let contents;
    try {
      contents = readFileSync(absPath, "utf8");
    } catch {
      // Absent files (e.g. a partially checked-out tree) get silently skipped
      // — they cannot host a violation.
      continue;
    }
    scannedCount += 1;
    violations.push(...findViolations(relPath, contents));
  }

  if (violations.length > 0) {
    process.stderr.write(
      `no-hardcoded-roles audit failed: ${violations.length} forbidden ` +
        `auth-role-branching pattern${violations.length === 1 ? "" : "s"} found.\n` +
        "Itotori authorization is PERMISSION-BASED: never branch an auth " +
        "decision on a role name. Use `requirePermission` with a typed " +
        "permission value instead. See docs/permissions.md.\n\n",
    );
    for (const v of violations) {
      process.stderr.write(`  ${v.file}:${v.line}  [${v.pattern}]\n    ${v.excerpt}\n`);
    }
    return 1;
  }

  process.stdout.write(
    `no-hardcoded-roles audit passed: ${scannedCount} shipped-src files scanned; ` +
      "no auth-role-name branching found.\n",
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(runAudit(process.argv.slice(2)));
}
