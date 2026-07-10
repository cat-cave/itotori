// auth-006-no-hardcoded-roles-guard — regression suite for the AST-based
// no-hardcoded-roles CI guard (auth-noroles-guard-ast).
//
// The guard was rewritten from a line-regex sieve to an AST walk (Babel TS
// parser via scripts/stable-ts-ast.mjs for .ts/.tsx/.mts/.cts/.js/.mjs/.cjs; a
// pragmatic pattern-scan for Rust .rs). This suite proves it now CATCHES the
// four shapes the regex missed — each with a POSITIVE fixture (auth role →
// flagged) and a NEGATIVE fixture (the SAME shape on a domain/LLM role →
// passes):
//   1. property-access comparison   `user.role === "admin"`   vs `message.role === "user"`
//   2. switch on a role read        `switch (role) { case "admin" }` vs domain cases
//   3. inequality comparison        `role !== "viewer"`       vs `role !== "inventory_only"`
//   4. role-keyed lookup map        `ROLES[role]`             vs `roles[role]` / `accepted[role]`
// plus alias/destructuring role reads (including defaulted bindings), optional
// chaining forms (`user?.role`, `auth?.hasRole?.(...)`, `ROLE_PERMISSIONS?.[role]`),
// the Rust equivalents, the classic name-based shortcuts (`isAdmin`, `hasRole`,
// `roleValues`, `ROLES`), and the expression-narrow `// authz-guard:allow
// domain-role` marker (inline OR in the comment block above; a bare marker with
// no reason does NOT exempt).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import { findViolations } from "./audit-no-hardcoded-roles.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "audit-no-hardcoded-roles.mjs");

const TS = "apps/itotori/src/some/module.ts";
const RS = "crates/foo/src/lib.rs";

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

function labels(path, contents) {
  return findViolations(path, contents).map((v) => v.pattern);
}

function isFlagged(path, contents) {
  return findViolations(path, contents).length > 0;
}

// Invoke the auditor CLI as a fully CAPTURED subprocess so an intentional
// detection's stderr stays inside the helper (tooling grepping the test's own
// stderr does not false-trip), while the tests still PROVE detection by
// asserting on the captured stderr. Mirrors audit-no-hardcoded-cost.test.mjs.
function runAuditCli(...files) {
  try {
    const stdout = execFileSync("node", [scriptPath, ...files], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function writeShippedProbe(name, contents) {
  const dir = mkdtempSync(join(tmpdir(), "audit-roles-"));
  const srcDir = join(dir, "apps/itotori/src");
  mkdirSync(srcDir, { recursive: true });
  const probe = join(srcDir, name);
  writeFileSync(probe, contents);
  return probe;
}

// =========================================================================
// Previously-missed shape 1 — PROPERTY-ACCESS comparison (the core bug: the
// old regex EXPLICITLY excluded property access, so `user.role === "admin"`
// slipped through).
// =========================================================================
test('SHAPE 1 (property-access): catches `user.role === "admin"` (was missed)', () => {
  const hits = labels(TS, 'if (user.role === "admin") { grant(); }');
  assert.ok(
    hits.includes(LABELS.comparison),
    `expected comparison flag, got ${JSON.stringify(hits)}`,
  );
});

test('SHAPE 1 (negative): does NOT flag the LLM message role `message.role === "user"`', () => {
  assert.deepEqual(labels(TS, 'const isUser = message.role === "user";'), []);
  assert.deepEqual(labels(TS, 'const isSys = msg.role === "system";'), []);
  // proof-stage domain role via a non-auth-subject property.
  assert.deepEqual(labels(TS, 'const isDraft = args.role === "draft";'), []);
});

// =========================================================================
// Previously-missed shape 2 — SWITCH on a role read (the old regex never
// handled `switch (role) { case "admin": ... }`).
// =========================================================================
test('SHAPE 2 (switch): catches `switch (role) { case "admin": ... }` (was missed)', () => {
  const hits = labels(TS, 'switch (role) { case "admin": return 1; default: return 0; }');
  assert.deepEqual(hits, [LABELS.switch]);
});

test("SHAPE 2 (switch, auth-subject discriminant): catches `switch (actor.role)`", () => {
  const hits = labels(TS, 'switch (actor.role) { case "x": return 1; }');
  assert.ok(hits.includes(LABELS.switch), JSON.stringify(hits));
});

test("SHAPE 2 (negative): does NOT flag a switch on a domain role with non-auth cases", () => {
  assert.deepEqual(
    labels(TS, 'switch (message.role) { case "user": return 1; case "assistant": return 2; }'),
    [],
  );
  assert.deepEqual(
    labels(TS, 'switch (role) { case "draft": return 1; case "qa": return 2; }'),
    [],
  );
});

// =========================================================================
// Previously-missed shape 3 — INEQUALITY (`!==` / `!=`); the old regex only
// caught `===` / `==`.
// =========================================================================
test('SHAPE 3 (inequality): catches `role !== "viewer"` and `role != "admin"` (was missed)', () => {
  assert.deepEqual(labels(TS, 'if (role !== "viewer") deny();'), [LABELS.comparison]);
  assert.deepEqual(labels(TS, "const bad = role != 'admin';"), [LABELS.comparison]);
});

test('SHAPE 3 (negative): does NOT flag `role !== "inventory_only"` (asset-surface domain role)', () => {
  assert.deepEqual(labels(TS, 'return role !== "inventory_only";'), []);
  // `role !== undefined` is not a string-literal comparison at all.
  assert.deepEqual(labels(TS, "if (role !== undefined) map(role);"), []);
});

// =========================================================================
// Previously-missed shape 4 — role-keyed LOOKUP MAP (`ROLES[role]` /
// `ROLE_PERMISSIONS[role]`); the old regex never saw element-access indexing.
// =========================================================================
test("SHAPE 4 (lookup map): catches `ROLES[role]` and `ROLE_PERMISSIONS[role]` (was missed)", () => {
  assert.ok(labels(TS, "const perms = ROLES[role];").includes(LABELS.lookup));
  assert.deepEqual(labels(TS, "const perms = ROLE_PERMISSIONS[role];"), [LABELS.lookup]);
  // actor.role index is also an auth-subject read → both labels; lookup present.
  const both = labels(TS, "const perms = rolePermissions[actor.role];");
  assert.ok(both.includes(LABELS.lookup) && both.includes(LABELS.subject), JSON.stringify(both));
});

test("SHAPE 4 (negative): does NOT flag domain maps `roles[role]` / `accepted[role]`", () => {
  assert.deepEqual(labels(TS, "const e = roles[role];"), []);
  assert.deepEqual(labels(TS, "accepted[role] = outcome.accepted;"), []);
  assert.deepEqual(labels(TS, "const a = fixture.roles[role].attempts;"), []);
});

// =========================================================================
// Alias / destructuring role reads (branch on a variable that aliases a role).
// =========================================================================
test('catches an aliased role read: `const r = user.role; if (r === "admin")`', () => {
  const hits = labels(TS, ["const r = user.role;", 'if (r === "admin") grant();'].join("\n"));
  assert.ok(hits.includes(LABELS.comparison), JSON.stringify(hits));
});

test('catches a destructured/aliased role read: `const { role: r } = actor; r === "owner"`', () => {
  const hits = labels(TS, ["const { role: r } = actor;", 'if (r === "owner") grant();'].join("\n"));
  assert.ok(hits.includes(LABELS.comparison), JSON.stringify(hits));
});

test('catches a defaulted destructured alias: `const { role: r = "draft" } = actor; r === "draft"`', () => {
  // AssignmentPattern defaults must not drop the bound alias; actor is an
  // auth-subject so even a non-auth literal still flags the branch.
  const hits = labels(
    TS,
    ['const { role: r = "draft" } = actor;', 'if (r === "draft") grant();'].join("\n"),
  );
  assert.ok(hits.includes(LABELS.comparison), JSON.stringify(hits));
});

test('catches a defaulted parameter destructure: `function f({ role: r = "admin" }) { r === "admin" }`', () => {
  const hits = labels(TS, 'function f({ role: r = "admin" }) { if (r === "admin") grant(); }');
  assert.ok(hits.includes(LABELS.comparison), JSON.stringify(hits));
});

test("does NOT flag an aliased DOMAIN role read compared to a non-auth value", () => {
  // `const role = edition.translationRole; role === "official_translation"` —
  // the real catalog shape (bare-`role` alias, non-auth value).
  assert.deepEqual(
    labels(
      TS,
      ["const role = edition.translationRole;", 'const y = role === "official_translation";'].join(
        "\n",
      ),
    ),
    [],
  );
});

// =========================================================================
// Optional chaining — Babel OptionalMember/CallExpression must not hide
// auth-role branches (P1 regression from the TS7 stable-AST migration).
// =========================================================================
test('catches optional property-access comparison: `user?.role === "admin"`', () => {
  const hits = labels(TS, 'if (user?.role === "admin") grant();');
  assert.ok(hits.includes(LABELS.comparison), JSON.stringify(hits));
  assert.ok(hits.includes(LABELS.subject), JSON.stringify(hits));
});

test('catches plain property-access comparison: `user.role === "admin"`', () => {
  const hits = labels(TS, 'if (user.role === "admin") grant();');
  assert.ok(hits.includes(LABELS.comparison), JSON.stringify(hits));
});

test('catches optional hasRole helper: `auth?.hasRole?.("admin")`', () => {
  assert.ok(labels(TS, 'if (auth?.hasRole?.("admin")) grant();').includes(LABELS.hasRole));
});

test("catches optional auth-role map lookup: `ROLE_PERMISSIONS?.[role]`", () => {
  assert.ok(labels(TS, "const p = ROLE_PERMISSIONS?.[role];").includes(LABELS.lookup));
});

test("does NOT flag permission-based authorization (negative control)", () => {
  assert.deepEqual(labels(TS, 'await requirePermission(actor, "project.read");'), []);
  assert.deepEqual(labels(TS, "await requirePermission(actor, permissionValues.projectRead);"), []);
});

// =========================================================================
// Auth-subject `.role` read in any context (a bare access, not only a compare).
// =========================================================================
test("catches a bare `actor.role` / `principal.role` read even outside a comparison", () => {
  assert.deepEqual(labels(TS, "return actor.role;"), [LABELS.subject]);
  assert.deepEqual(labels(TS, "const r = principal.role;"), [LABELS.subject]);
});

test("does NOT flag a non-auth-subject `.role` read (`message.role`, `row.role`, `user.roles`)", () => {
  assert.deepEqual(labels(TS, "const x = message.role;"), []);
  assert.deepEqual(labels(TS, "const x = row.role;"), []);
  assert.deepEqual(labels(TS, "for (const r of user.roles) {}"), []);
});

// =========================================================================
// Classic name-based shortcuts — preserved from the original guard.
// =========================================================================
test("catches `isAdmin` / `is_admin` auth-gating booleans", () => {
  assert.deepEqual(labels(TS, "if (user.isAdmin) grant();"), [LABELS.isAdmin]);
  assert.deepEqual(
    labels(RS, "if user.is_admin { grant(); }").filter((l) => l === LABELS.isAdmin),
    [LABELS.isAdmin],
  );
});

test("catches `hasRole(...)` / `has_role(...)` auth-gating helpers", () => {
  // hasRole(...) is a call; the "admin" string is an argument, not a role-read
  // comparison, so only the helper label fires.
  assert.deepEqual(labels(TS, 'if (hasRole(user, "admin")) grant();'), [LABELS.hasRole]);
  assert.deepEqual(
    labels(RS, 'if has_role(user, "admin") { }').filter((l) => l === LABELS.hasRole),
    [LABELS.hasRole],
  );
});

test("catches a `roleValues` auth-roles enum and an all-caps `ROLES` enum", () => {
  assert.deepEqual(labels(TS, "const admin = roleValues.admin;"), [LABELS.roleValues]);
  assert.deepEqual(labels(TS, "const admin = ROLES.ADMIN;"), [LABELS.roles]);
  // A lowercase `roles` array/field is a legitimate domain collection.
  assert.deepEqual(labels(TS, "for (const r of user.roles) {}"), []);
});

// =========================================================================
// Rust shapes — pragmatic pattern-scan.
// =========================================================================
test('RUST: catches an auth-role branch `user.role == "admin"` and `role != "viewer"`', () => {
  assert.ok(labels(RS, 'if user.role == "admin" { grant(); }').includes(LABELS.comparison));
  assert.ok(labels(RS, 'if role != "viewer" { deny(); }').includes(LABELS.comparison));
});

test('RUST: catches a `match role { "admin" => ... }` auth branch', () => {
  const hits = labels(RS, ["match role {", '  "admin" => 1,', "  _ => 0,", "}"].join("\n"));
  assert.ok(hits.includes(LABELS.switch), JSON.stringify(hits));
});

test("RUST: catches `ROLES[role]` lookup and `principal.role` auth-subject read", () => {
  assert.ok(labels(RS, "let p = ROLES[role];").includes(LABELS.lookup));
  assert.ok(labels(RS, "let r = principal.role;").includes(LABELS.subject));
});

test("RUST (negative): does NOT flag domain role branches (enum variant / non-auth value / two reads)", () => {
  // `TextRole` enum variant comparison — not a string literal.
  assert.deepEqual(labels(RS, "x.filter(|u| u.role == TextRole::Dialogue)"), []);
  // `r.role == "primary"` — a non-auth domain value.
  assert.deepEqual(labels(RS, 'if r.role == "primary" { 1 }'), []);
  // `s.role == role` — two role reads, no string literal.
  assert.deepEqual(labels(RS, "x.filter(|s| s.role == role)"), []);
});

// =========================================================================
// The expression-narrow `// authz-guard:allow domain-role` marker.
// =========================================================================
test("an inline `authz-guard:allow domain-role` marker exempts the flagged line", () => {
  const marked = 'if (user.role === "admin") { } // authz-guard:allow domain-role — system actor';
  assert.deepEqual(labels(TS, marked), []);
});

test("a marker in the contiguous comment block ABOVE exempts the code line below", () => {
  const block = [
    "// authz-guard:allow domain-role — provider-proof stage role",
    'if (role === "admin") {',
  ].join("\n");
  assert.deepEqual(labels(TS, block), []);
});

test("the marker is EXPRESSION-NARROW: a marker block separated by code does NOT exempt a later line", () => {
  const block = [
    "// authz-guard:allow domain-role — proof stage role",
    "doSomethingElse();",
    'if (user.role === "admin") {',
  ].join("\n");
  assert.ok(isFlagged(TS, block), "later line after intervening code must still flag");
});

test("a bare `authz-guard:allow` with NO reason token does NOT exempt (mandatory reason)", () => {
  assert.ok(isFlagged(TS, 'if (user.role === "admin") { } // authz-guard:allow'));
  assert.ok(isFlagged(TS, ["// authz-guard:allow", 'if (role === "admin") {'].join("\n")));
});

test("the marker exempts every shape, not just the comparison (e.g. `isAdmin`, lookup)", () => {
  assert.deepEqual(
    labels(TS, "if (user.isAdmin) { } // authz-guard:allow domain-role — trusted system actor"),
    [],
  );
  assert.deepEqual(
    labels(TS, "const p = ROLES[role]; // authz-guard:allow domain-role — documented domain table"),
    [],
  );
});

// =========================================================================
// The two REAL domain-role allowlist sites + the LLM message-role uses pass.
// =========================================================================
test('the real provider-proof stage role `role === "draft"` passes (non-auth value)', () => {
  assert.deepEqual(labels(TS, 'if (role === "draft") {'), []);
});

test('the real catalog translation-source role `role === "official_translation"` passes', () => {
  assert.deepEqual(labels(TS, 'const ok = role === "official_translation";'), []);
});

test('the LLM message-role uses `{ role: "system" }` / `message.role === "user"` pass', () => {
  assert.deepEqual(labels(TS, 'const m = { role: "system", content: text };'), []);
  assert.deepEqual(labels(TS, 'const isUser = message.role === "user";'), []);
});

// =========================================================================
// CLI: scan scope + exit codes, incl. a temp-file probe for each missed shape.
// =========================================================================
test('CLI exits 1 on a shipped-src probe with `user.role === "admin"` (property-access shape)', () => {
  const probe = writeShippedProbe(
    "probe-property-access.ts",
    'export function gate(user: { role: string }) {\n  return user.role === "admin";\n}\n',
  );
  const { code, stderr } = runAuditCli(probe);
  assert.equal(code, 1);
  assert.match(stderr, /no-hardcoded-roles audit failed/u);
  assert.match(stderr, /comparison on a role read/u);
});

test("CLI exits 1 on a shipped-src probe with `switch (role)` (switch shape)", () => {
  const probe = writeShippedProbe(
    "probe-switch.ts",
    'export function gate(role: string) {\n  switch (role) {\n    case "admin":\n      return true;\n    default:\n      return false;\n  }\n}\n',
  );
  const { code, stderr } = runAuditCli(probe);
  assert.equal(code, 1);
  assert.match(stderr, /switch on a role read/u);
});

test('CLI exits 1 on a shipped-src probe with `role !== "viewer"` (inequality shape)', () => {
  const probe = writeShippedProbe(
    "probe-inequality.ts",
    'export function gate(role: string) {\n  return role !== "viewer";\n}\n',
  );
  const { code, stderr } = runAuditCli(probe);
  assert.equal(code, 1);
  assert.match(stderr, /comparison on a role read/u);
});

test("CLI exits 1 on a shipped-src probe with `ROLE_PERMISSIONS[role]` (lookup-map shape)", () => {
  const probe = writeShippedProbe(
    "probe-lookup.ts",
    "const ROLE_PERMISSIONS: Record<string, string[]> = {};\nexport const permsFor = (role: string) => ROLE_PERMISSIONS[role];\n",
  );
  const { code, stderr } = runAuditCli(probe);
  assert.equal(code, 1);
  assert.match(stderr, /lookup map/u);
});

test("CLI exits 0 on a shipped-src probe with only clean domain-role code", () => {
  const probe = writeShippedProbe(
    "probe-clean.ts",
    [
      'export const pick = (message: { role: string }) => message.role === "user";',
      'export const stage = (args: { role: string }) => args.role === "draft";',
      "export const lookup = (roles: Record<string, unknown>, role: string) => roles[role];",
    ].join("\n"),
  );
  const { code, stdout } = runAuditCli(probe);
  assert.equal(code, 0);
  assert.match(stdout, /audit passed/u);
});

test("CLI ignores a violation in a file OUTSIDE shipped src (not in scan scope)", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-roles-"));
  const probe = join(dir, "not-shipped-src.ts");
  writeFileSync(probe, 'export const gate = (user: { role: string }) => user.role === "admin";\n');
  const { code, stdout } = runAuditCli(probe);
  assert.equal(code, 0);
  assert.match(stdout, /audit passed/u);
});
