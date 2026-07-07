#!/usr/bin/env node
// auth-006-no-hardcoded-roles-guard — CI guard that makes Trevor's
// NON-NEGOTIABLE authorization invariant self-enforcing. Access control in
// itotori is PERMISSION-BASED; shipped source must NEVER branch an auth
// decision on a role name. Once the permission model landed
// (packages/itotori-db/src/authorization.ts — `permissionValues` +
// `requirePermission`, NO `roleValues`), nothing may silently reintroduce
// role-name auth branching. This script parses shipped src and fails the build
// (exit 1, one line per hit) if any forbidden auth-role-branching shape appears.
//
// AST-BASED (auth-noroles-guard-ast). The previous implementation was a
// line-regex scanner that MISSED most real auth-role branches: it explicitly
// excluded property-access role reads (`user.role === "admin"`), never handled
// `switch (role)`, only caught `===`/`==` (not `!==`/`!=`), and never saw a
// role-keyed lookup map (`ROLES[role]`). It was a false-negative sieve. For
// .ts/.tsx/.js/.mjs/.cjs files this now walks the TypeScript compiler API AST
// (mirroring packages/itotori-db/test/authorization-matrix.test.ts's
// `ts.createSourceFile` + `forEachChild` walk); for Rust .rs files it uses a
// pragmatic pattern-scan of the same shapes. The companion regression suite
// scripts/audit-no-hardcoded-roles.test.mjs exercises every shape below,
// including a positive + negative fixture for each of the four previously
// missed shapes.
//
// The invariant it enforces is stated in docs/permissions.md ("Authorization
// checks must not branch on role names"); this guard turns that prose into a
// CI gate. See the "No-Hardcoded-Roles Guard" section there.
//
// ---------------------------------------------------------------------------
// What is a ROLE READ?
//   - an identifier named exactly `role`;
//   - any property access `<obj>.role` (e.g. `user.role`, `message.role`);
//   - a variable that ALIASES a role read: `const r = x.role` /
//     `const { role } = x` / `const { role: r } = x`, then a branch on `r`.
//
// What makes a role read an AUTH branch (a violation) rather than a legitimate
// DOMAIN role (LLM message role, proof-stage role, asset-surface role, catalog
// translation role, a `TextRole` enum, …)? The shipped tree is SATURATED with
// domain `.role` reads, so the shape alone cannot decide it — `user.role ===
// "admin"` and `args.role === "draft"` are the SAME shape. A role-read branch
// is classified AUTH iff ANY of:
//   (1) the role read is on an AUTH-SUBJECT object — `user`/`actor`/`principal`/
//       `session`/`subject`/`requester`/`caller`/`currentUser`/`auth`/`account`/
//       `identity` — regardless of the compared value; the permission-based
//       `AuthorizationActor` carries only `userId`, so ANY `<authSubject>.role`
//       access is the anti-pattern reintroduced;
//   (2) the compared string literal / switch-case value is a known AUTH role
//       NAME (`admin`, `owner`, `moderator`, `editor`, `viewer`, `guest`,
//       `member`, `superuser`, `root`, …); the LLM message roles (`user`,
//       `assistant`, `system`, `tool`, …) and domain roles (`draft`, `qa`,
//       `official_translation`, `inventory_only`, `primary`, …) are NOT auth;
//   (3) for a lookup map `X[role]`, the container is a known AUTH-ROLES map
//       (`ROLES`, `ROLE_PERMISSIONS`, `rolePermissions`, `rolePolicies`,
//       `permissionsByRole`, …) — a role-keyed authorization table.
// Plus the classic name-based auth shortcuts: `isAdmin`/`is_admin`,
// `hasRole(...)`/`has_role(...)`, `roleValues`, `ROLES`.
//
// Detected shapes:
//   1. binary `===`/`==`/`!==`/`!=` where one side is a role read and the other
//      a string literal (`if (user.role === "admin")`, `if (role !== "viewer")`);
//   2. `switch` whose discriminant is a role read, with string-literal cases
//      (`switch (role) { case "admin": … }`);
//   3. element-access lookup indexed by a role read into an auth-roles map
//      (`ROLES[role]`, `ROLE_PERMISSIONS[actor.role]`);
//   4. a bare `<authSubject>.role` read in any context (`return actor.role`);
//   5. `isAdmin`/`is_admin`, `hasRole(`/`has_role(`, `roleValues`, `ROLES`.
//
// Allowlist — genuine DOMAIN (non-auth) roles:
//   A real domain role that must branch on an AUTH-role-NAME value in a genuine
//   domain context carries an explicit per-line marker:
//       // authz-guard:allow domain-role — <reason>
//   The marker REQUIRES a non-empty token after `allow` (the convention is the
//   literal `domain-role` tag plus a short reason) so a reviewer can judge each
//   exemption individually. It is EXPRESSION-NARROW: it exempts only the flagged
//   line (inline trailing comment) OR the single code line immediately below a
//   contiguous `//`-comment block — never a whole file or region. It is the ONLY
//   opt-out; it never disables the check. The two known domain-role sites in the
//   current tree branch on non-auth values (`role === "draft"` /
//   `role === "official_translation"`) so they already pass on VALUE; the marker
//   documents that intent and stays valid should the value ever look auth-like:
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
import * as ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// ---- Auth classification vocabularies -------------------------------------

// Known AUTH role NAMES (lowercase). Branching a role read on any of these is
// the forbidden auth decision. Deliberately EXCLUDES the LLM message roles
// (`user`, `assistant`, `system`, `tool`, `developer`, `function`, `model`) and
// the domain roles present in the tree (`draft`, `qa`, `official_translation`,
// `inventory_only`, `primary`, …) so those legitimate branches are not caught.
const AUTH_ROLE_NAMES = new Set([
  "admin",
  "administrator",
  "superadmin",
  "superuser",
  "sysadmin",
  "root",
  "owner",
  "coowner",
  "moderator",
  "mod",
  "editor",
  "viewer",
  "guest",
  "member",
  "operator",
  "maintainer",
  "manager",
  "staff",
  "subscriber",
]);

// AUTH-SUBJECT object names (lowercase). A `<subject>.role` read is the auth
// anti-pattern regardless of the compared value; the permission-based
// `AuthorizationActor` carries only `userId`. None of these appear as a `.role`
// read in the current shipped tree — the domain `.role` objects are `message`,
// `args`, `entry`, `route`, `row`, `s`, `u`, `r`, … which are NOT here.
const AUTH_SUBJECT_OBJECTS = new Set([
  "user",
  "actor",
  "principal",
  "session",
  "subject",
  "requester",
  "caller",
  "currentuser",
  "curuser",
  "auth",
  "account",
  "identity",
  "viewer",
]);

// Known AUTH-ROLES map identifiers (EXACT, case-sensitive). Indexing one of
// these by a role read is a role-keyed authorization table lookup. Case-exact
// so a lowercase `roles[role]` domain collection (present in the tree) is NOT
// caught.
const AUTH_ROLE_MAP_NAMES = new Set([
  "ROLES",
  "ROLE_PERMISSIONS",
  "ROLE_PERMS",
  "ROLE_MAP",
  "ROLE_POLICY",
  "ROLE_POLICIES",
  "rolePermissions",
  "rolePolicies",
  "roleToPermissions",
  "permissionsByRole",
  "roleValues",
]);

function isAuthRoleName(value) {
  return AUTH_ROLE_NAMES.has(value.toLowerCase());
}

function isAuthSubjectName(name) {
  return name !== undefined && AUTH_SUBJECT_OBJECTS.has(name.toLowerCase());
}

function isAuthRoleMapName(name) {
  return name !== undefined && AUTH_ROLE_MAP_NAMES.has(name);
}

// Violation labels — human-readable, stable for the report + the test suite.
const LABELS = {
  comparison: "auth role-name branching (comparison on a role read)",
  switch: "auth role-name branching (switch on a role read)",
  lookup: "auth role-keyed lookup map (indexing by a role read)",
  subject: "auth-subject role gating (`<subject>.role`)",
  isAdmin: "auth-role boolean `isAdmin` / `is_admin`",
  hasRole: "auth-role helper `hasRole(...)` / `has_role(...)`",
  roleValues: "auth-roles enum `roleValues`",
  roles: "auth-roles enum `ROLES`",
};

// ---- Shared comment + allowlist-marker helpers ----------------------------

// The per-line comment prefixes that mark a line as commentary. Shared with the
// Rust scan and the marker walk. Mirrors audit-no-hardcoded-cost.mjs so SQL
// (`--`) and shell/toml (`#`) forms are honored too.
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
// A non-empty token after `allow` is MANDATORY so a bare `// authz-guard:allow`
// cannot silently opt a real auth-role branch out.
function hasAllowMarker(line) {
  return /authz-guard:allow\s+\S/u.test(line);
}

// True iff the domain-role marker sits on `lines[i]` (inline) OR in the
// contiguous `//`-comment block immediately above it. This is EXPRESSION-NARROW:
// it can only ever exempt the single violating line (a trailing marker) or the
// one code line directly beneath a marker comment block — never a region. fmt
// often moves a trailing comment onto its own preceding line, so the block walk
// keeps the marker stable across formatting.
function markerOnLineOrAbove(lines, i) {
  if (i < 0 || i >= lines.length) return false;
  if (hasAllowMarker(lines[i])) return true;
  for (let j = i - 1; j >= 0; j -= 1) {
    const above = lines[j].trim();
    if (!isCommentLine(above)) break;
    if (hasAllowMarker(lines[j])) return true;
  }
  return false;
}

// ---- TypeScript / JavaScript AST scan -------------------------------------

const BINARY_EQUALITY_TOKENS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

// The immediate object name of a property access `<obj>.role` — the identifier
// or property name closest to `.role` (for `session.user.role` → `user`).
function immediateObjectName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

// The name of a lookup-map container expression `X[...]` — `X`'s identifier or
// trailing property name.
function containerName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

// If `node` is a role read, return { authSubject } describing it; else null.
// `aliases` maps an aliased variable name → { authSubject } captured from its
// initializer. `role` (bare) and any `<obj>.role` are role reads; an aliased
// variable inherits its origin's auth-subject flag.
function roleReadInfo(node, aliases) {
  if (ts.isIdentifier(node)) {
    if (node.text === "role") return { authSubject: false };
    const alias = aliases.get(node.text);
    if (alias !== undefined) return { authSubject: alias.authSubject };
    return null;
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === "role") {
    return { authSubject: isAuthSubjectName(immediateObjectName(node.expression)) };
  }
  return null;
}

// The string value of a string-literal / no-substitution-template node, else
// null. Template literals catch the `role === \`owner\`` form.
function stringLiteralValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

// Collect alias declarations across the whole file, so `const r = x.role; if (r
// === "admin")` and `const { role: r } = actor; if (r) …` treat `r` as a role
// read. A single pre-pass keeps this order-independent.
function collectAliases(sourceFile) {
  const aliases = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const init = node.initializer;
      if (
        ts.isIdentifier(node.name) &&
        ts.isPropertyAccessExpression(init) &&
        init.name.text === "role"
      ) {
        // `const r = <obj>.role`
        aliases.set(node.name.text, {
          authSubject: isAuthSubjectName(immediateObjectName(init.expression)),
        });
      } else if (
        ts.isIdentifier(node.name) &&
        ts.isIdentifier(init) &&
        (init.text === "role" || aliases.has(init.text))
      ) {
        // `const r = role` / `const r2 = r`
        const origin = init.text === "role" ? { authSubject: false } : aliases.get(init.text);
        aliases.set(node.name.text, { authSubject: origin?.authSubject ?? false });
      } else if (ts.isObjectBindingPattern(node.name)) {
        // `const { role } = x` / `const { role: r } = x`
        const initSubject =
          ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)
            ? isAuthSubjectName(immediateObjectName(init))
            : false;
        for (const element of node.name.elements) {
          const propName = element.propertyName ?? element.name;
          if (
            ts.isIdentifier(propName) &&
            propName.text === "role" &&
            ts.isIdentifier(element.name)
          ) {
            aliases.set(element.name.text, { authSubject: initSubject });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return aliases;
}

function scriptKindForPath(path) {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

function findTsViolations(path, contents, lines) {
  const sourceFile = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindForPath(path),
  );
  const aliases = collectAliases(sourceFile);
  const found = [];
  const seen = new Set();

  const record = (node, label) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    if (markerOnLineOrAbove(lines, line)) return;
    const key = `${line}::${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({
      file: path,
      line: line + 1,
      pattern: label,
      excerpt: (lines[line] ?? "").trim().slice(0, 200),
    });
  };

  function visit(node) {
    // Shape 1 — binary equality with a role read vs a string literal.
    if (ts.isBinaryExpression(node) && BINARY_EQUALITY_TOKENS.has(node.operatorToken.kind)) {
      const leftRead = roleReadInfo(node.left, aliases);
      const rightRead = roleReadInfo(node.right, aliases);
      const leftStr = stringLiteralValue(node.left);
      const rightStr = stringLiteralValue(node.right);
      let read = null;
      let literal = null;
      if (leftRead !== null && rightStr !== null) {
        read = leftRead;
        literal = rightStr;
      } else if (rightRead !== null && leftStr !== null) {
        read = rightRead;
        literal = leftStr;
      }
      if (read !== null && (read.authSubject || isAuthRoleName(literal))) {
        record(node, LABELS.comparison);
      }
    }

    // Shape 2 — switch whose discriminant is a role read, with string cases.
    if (ts.isSwitchStatement(node)) {
      const discriminant = roleReadInfo(node.expression, aliases);
      if (discriminant !== null) {
        const caseValues = node.caseBlock.clauses
          .filter((clause) => ts.isCaseClause(clause))
          .map((clause) => stringLiteralValue(clause.expression))
          .filter((value) => value !== null);
        if (discriminant.authSubject || caseValues.some((value) => isAuthRoleName(value))) {
          record(node, LABELS.switch);
        }
      }
    }

    // Shape 3 — element-access lookup indexed by a role read into an auth map.
    if (ts.isElementAccessExpression(node)) {
      const index = roleReadInfo(node.argumentExpression, aliases);
      if (index !== null) {
        const container = containerName(node.expression);
        if (isAuthRoleMapName(container) || index.authSubject) {
          record(node, LABELS.lookup);
        }
      }
    }

    // Shape 4 — a bare `<authSubject>.role` read in any context.
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "role" &&
      isAuthSubjectName(immediateObjectName(node.expression))
    ) {
      record(node, LABELS.subject);
    }

    // Shape 5 — classic name-based auth shortcuts.
    if (ts.isIdentifier(node)) {
      if (/^is_?[Aa]dmin$/u.test(node.text)) record(node, LABELS.isAdmin);
      else if (node.text === "roleValues") record(node, LABELS.roleValues);
      else if (node.text === "ROLES") record(node, LABELS.roles);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (calleeName !== undefined && /^has_?[Rr]ole$/u.test(calleeName)) {
        record(node, LABELS.hasRole);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

// ---- Rust pattern scan ----------------------------------------------------

// Rust has no drivable TS AST here, so a pragmatic pattern-scan detects the same
// auth-role-branch shapes. Domain Rust `.role` reads in the tree (`u.role ==
// TextRole::Dialogue` — enum variant, not a string; `r.role == "primary"` — a
// non-auth domain value; `s.role == role` — two role reads) are NOT caught.
const AUTH_ROLE_NAME_ALTERNATION = [...AUTH_ROLE_NAMES].join("|");
const RUST_AUTH_MAP_ALTERNATION = [...AUTH_ROLE_MAP_NAMES]
  .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
  .join("|");
const RUST_SUBJECT_ALTERNATION = [...AUTH_SUBJECT_OBJECTS].join("|");

const RUST_LINE_PATTERNS = [
  {
    // `<authSubject>.role` — auth-subject role gating.
    label: LABELS.subject,
    regex: new RegExp(`\\b(?:${RUST_SUBJECT_ALTERNATION})\\.role\\b`, "iu"),
  },
  {
    // role read `==`/`!=` an AUTH-role-NAME string literal (either order).
    label: LABELS.comparison,
    regex: new RegExp(
      `(?:(?:[\\w.]*\\.)?\\brole\\b\\s*(?:==|!=)\\s*"(?:${AUTH_ROLE_NAME_ALTERNATION})")` +
        `|(?:"(?:${AUTH_ROLE_NAME_ALTERNATION})"\\s*(?:==|!=)\\s*(?:[\\w.]*\\.)?\\brole\\b)`,
      "iu",
    ),
  },
  {
    // auth-roles map indexed by a role read: `ROLES[role]`.
    label: LABELS.lookup,
    regex: new RegExp(`\\b(?:${RUST_AUTH_MAP_ALTERNATION})\\s*\\[\\s*[\\w.]*\\brole\\b`, "u"),
  },
  {
    label: LABELS.isAdmin,
    regex: /\bis_?[Aa]dmin\b/u,
  },
  {
    label: LABELS.hasRole,
    regex: /\bhas_?[Rr]ole\s*\(/u,
  },
];

// A `match` whose discriminant is a role read and whose arms include an
// AUTH-role-NAME string literal (`match role { "admin" => … }`). Whole-file so
// the arm can sit on any following line; enum-variant arms (no string literal)
// and non-auth string arms are not caught.
const RUST_MATCH_REGEX = new RegExp(
  `match\\s+[\\w.()&*\\s]*\\brole\\b[^\\{]*\\{[\\s\\S]*?"(?:${AUTH_ROLE_NAME_ALTERNATION})"\\s*=>`,
  "u",
);

function findRustViolations(path, contents, lines) {
  const found = [];
  const seen = new Set();
  const push = (lineIndex, label) => {
    if (markerOnLineOrAbove(lines, lineIndex)) return;
    const key = `${lineIndex}::${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({
      file: path,
      line: lineIndex + 1,
      pattern: label,
      excerpt: (lines[lineIndex] ?? "").trim().slice(0, 200),
    });
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const trimmed = line.trim();
    if (isCommentLine(trimmed)) continue;
    for (const pattern of RUST_LINE_PATTERNS) {
      if (pattern.regex.test(line)) push(lineIndex, pattern.label);
    }
  }

  // `match` on a role read with an auth-name arm — locate the `match` line.
  if (RUST_MATCH_REGEX.test(contents)) {
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (/\bmatch\s+[\w.()&*\s]*\brole\b/u.test(lines[lineIndex])) {
        push(lineIndex, LABELS.switch);
        break;
      }
    }
  }

  return found;
}

// ---- Dispatch -------------------------------------------------------------

const TS_LIKE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

// Return every forbidden auth-role-branch violation in `contents`, tagged with
// the repo-relative `path` for reporting. Exported for the regression suite.
export function findViolations(path, contents) {
  const lines = contents.split(/\r?\n/u);
  if (path.endsWith(".rs")) {
    return findRustViolations(path, contents, lines);
  }
  if (TS_LIKE_EXTENSIONS.some((ext) => path.endsWith(ext))) {
    return findTsViolations(path, contents, lines);
  }
  return [];
}

// ---- Scan scope + CLI -----------------------------------------------------

// Shipped src only: apps/*/src + packages/*/src + crates/*/src, excluding
// tests/fixtures/node_modules/docs.
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
      // Absent files (e.g. a partially checked-out tree) get silently skipped —
      // they cannot host a violation.
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
