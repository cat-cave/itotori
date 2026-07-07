// auth-006-no-hardcoded-roles-guard — regression suite for the
// no-hardcoded-roles CI guard.
//
// Proves the guard CATCHES every auth-role-branching shape it forbids
// (`role === "..."`, `isAdmin`, `hasRole`, `roleValues`, `ROLES`,
// `actor.role`), that it does NOT flag legitimate DOMAIN role comparisons
// (property-access forms like `message.role` / `args.role`, lowercase
// `roles`, a bare `role` variable not compared to a string), and that the
// `// authz-guard:allow domain-role` marker (inline OR in the comment block
// above) is the only per-line opt-out — with a MANDATORY non-empty token
// after `allow` so a bare marker cannot silently exempt a real auth branch.

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

const SRC_PATH = "apps/itotori/src/some/module.ts";

function labels(path, contents) {
  return findViolations(path, contents).map((v) => v.pattern);
}

// Invoke the auditor CLI as a fully CAPTURED subprocess. On a detected
// violation the auditor writes its failure line to ITS stderr; capturing
// stdout+stderr keeps that inside this helper (so tooling grepping the test's
// own stderr for the failure string does not false-trip on an intentional
// detection check), while the tests still PROVE detection by asserting on the
// captured stderr. Mirrors audit-no-hardcoded-cost.test.mjs.
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

// ---- Pattern: bare `role === "..."` / `role == "..."` --------------------
test('catches `if (role === "admin")` (the canonical auth-role branch)', () => {
  const hits = labels(SRC_PATH, '  if (role === "admin") {');
  assert.deepEqual(hits, ['auth role-name branching: `role === "..."` / `role == "..."`']);
});

test('catches `role == "admin"` (loose equality, single-line)', () => {
  const hits = labels(SRC_PATH, '  const ok = role == "admin";');
  assert.deepEqual(hits, ['auth role-name branching: `role === "..."` / `role == "..."`']);
});

test("catches single-quoted and backtick-quoted role literals too", () => {
  assert.deepEqual(labels(SRC_PATH, "  if (role === 'superuser') {"), [
    'auth role-name branching: `role === "..."` / `role == "..."`',
  ]);
  assert.deepEqual(labels(SRC_PATH, "  if (role === `owner`) {"), [
    'auth role-name branching: `role === "..."` / `role == "..."`',
  ]);
});

test("does NOT flag a bare `role` that is not compared to a string literal", () => {
  // A `role` variable used in a non-string comparison / as a value is honest.
  assert.deepEqual(labels(SRC_PATH, "  const upper = role.toUpperCase();"), []);
  assert.deepEqual(labels(SRC_PATH, "  roles.push(role);"), []);
  assert.deepEqual(labels(SRC_PATH, "  if (role === otherRole) {"), []);
});

// ---- Pattern: property-access `.role` is NOT matched (domain roles) -------
test("does NOT flag property-access `.role` comparisons (chat-message / proof-stage / text roles)", () => {
  // These are DOMAIN roles accessed as properties, not the bare auth `role`.
  assert.deepEqual(labels(SRC_PATH, '  message.role === "user"'), []);
  assert.deepEqual(labels(SRC_PATH, '  const isDraft = args.role === "draft";'), []);
  assert.deepEqual(labels(SRC_PATH, '  if (actor.role !== "guest") grant();'), [
    "auth-actor role gating `actor.role`",
  ]);
  // Rust text-role enum comparison on a property is not a bare-role string
  // branch (property access + enum variant, not a string literal).
  assert.deepEqual(
    labels("crates/kaifuu-tyrano/src/parse.rs", "  u.role == TextRole::Dialogue"),
    [],
  );
});

// ---- Patterns: isAdmin / is_admin, hasRole / has_role --------------------
test("catches `isAdmin` / `is_admin` auth-gating booleans", () => {
  assert.deepEqual(labels(SRC_PATH, "  if (user.isAdmin) grant();"), [
    "auth-role boolean `isAdmin` / `is_admin`",
  ]);
  assert.deepEqual(labels("crates/foo/src/lib.rs", "  if user.is_admin {"), [
    "auth-role boolean `isAdmin` / `is_admin`",
  ]);
});

test("catches `hasRole(...)` / `has_role(...)` auth-gating helpers", () => {
  assert.deepEqual(labels(SRC_PATH, '  if (hasRole(user, "admin")) grant();'), [
    "auth-role helper `hasRole(...)` / `has_role(...)`",
  ]);
  assert.deepEqual(labels("crates/foo/src/lib.rs", '  if has_role(user, "admin") {'), [
    "auth-role helper `hasRole(...)` / `has_role(...)`",
  ]);
});

// ---- Patterns: roleValues, ROLES enum, actor.role ------------------------
test("catches a `roleValues` auth-roles enum", () => {
  assert.deepEqual(labels(SRC_PATH, "  const admin = roleValues.admin;"), [
    "auth-roles enum `roleValues`",
  ]);
});

test("catches an all-caps `ROLES` auth-roles enum but NOT a lowercase `roles` collection", () => {
  assert.deepEqual(labels(SRC_PATH, "  const admin = ROLES.ADMIN;"), ["auth-roles enum `ROLES`"]);
  // A lowercase `roles` array/field is a legitimate domain collection.
  assert.deepEqual(labels(SRC_PATH, "  for (const r of user.roles) {"), []);
});

test("catches `actor.role` auth-actor role gating", () => {
  assert.deepEqual(labels(SRC_PATH, '  if (actor.role === "admin") grant();'), [
    "auth-actor role gating `actor.role`",
  ]);
  // `actor.role` is caught even outside a string compare — any access is the
  // anti-pattern (the permission-based AuthorizationActor carries no role).
  assert.deepEqual(labels(SRC_PATH, "  return actor.role;"), [
    "auth-actor role gating `actor.role`",
  ]);
});

// ---- Allowlist marker (inline + comment-block-above) --------------------
test("an inline `authz-guard:allow domain-role` marker exempts the line", () => {
  const marked = '  if (role === "draft") { // authz-guard:allow domain-role — proof stage role';
  assert.deepEqual(labels(SRC_PATH, marked), []);
});

test("a marker in the contiguous comment block ABOVE exempts the line below", () => {
  const block = [
    "  // authz-guard:allow domain-role — provider-proof stage role",
    '  if (role === "draft") {',
  ].join("\n");
  assert.deepEqual(
    findViolations(SRC_PATH, block).map((v) => v.pattern),
    [],
  );
});

test("a marker on a comment block separated by code does NOT exempt a later line", () => {
  // The marker only covers the IMMEDIATELY following code line (contiguous
  // comment block); a line after intervening code is not exempt.
  const block = [
    "  // authz-guard:allow domain-role — proof stage role",
    "  doSomethingElse();",
    '  if (role === "admin") {',
  ].join("\n");
  const hits = findViolations(SRC_PATH, block).map((v) => v.pattern);
  assert.deepEqual(hits, ['auth role-name branching: `role === "..."` / `role == "..."`']);
});

test("a bare `authz-guard:allow` with NO reason token does NOT exempt (mandatory reason)", () => {
  // The marker requires a non-empty token after `allow` so a bare marker
  // cannot silently opt a real auth-role branch out.
  const bareInline = '  if (role === "admin") { // authz-guard:allow';
  assert.deepEqual(labels(SRC_PATH, bareInline), [
    'auth role-name branching: `role === "..."` / `role == "..."`',
  ]);
  const bareAbove = ["  // authz-guard:allow", '  if (role === "admin") {'].join("\n");
  assert.deepEqual(
    findViolations(SRC_PATH, bareAbove).map((v) => v.pattern),
    ['auth role-name branching: `role === "..."` / `role == "..."`'],
  );
});

test("the marker exempts every pattern, not just the role-name branch", () => {
  // isAdmin / hasRole / actor.role behind a genuine domain marker pass too.
  assert.deepEqual(
    labels(SRC_PATH, "  if (user.isAdmin) { // authz-guard:allow domain-role — system actor"),
    [],
  );
});

// ---- CLI: scan scope + exit codes ----------------------------------------
test('CLI exits 1 on a crafted shipped-src file with `if (role === "admin")`', () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-roles-"));
  // Place the probe UNDER a */src/ tree so it is in scan scope.
  const srcDir = join(dir, "apps/itotori/src");
  mkdirSync(srcDir, { recursive: true });
  const probe = join(srcDir, "probe-admin-role.ts");
  writeFileSync(probe, 'export function gate(role: string) {\n  return role === "admin";\n}\n');
  const { code, stderr } = runAuditCli(probe);
  assert.equal(code, 1);
  assert.match(stderr, /no-hardcoded-roles audit failed/u);
});

test("CLI exits 0 on a crafted shipped-src file with only clean domain-role code", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-roles-"));
  const srcDir = join(dir, "apps/itotori/src");
  mkdirSync(srcDir, { recursive: true });
  const probe = join(srcDir, "probe-clean.ts");
  writeFileSync(
    probe,
    [
      'export const pick = (message: { role: string }) => message.role === "user";',
      'export const stage = (args: { role: string }) => args.role === "draft";',
    ].join("\n"),
  );
  const { code, stdout } = runAuditCli(probe);
  assert.equal(code, 0);
  assert.match(stdout, /audit passed/u);
});

test("CLI ignores a violation in a file OUTSIDE shipped src (not in scan scope)", () => {
  // A file NOT under an apps/packages/crates */src/ tree is never scanned,
  // so a blatant `role === "admin"` there does not fail the guard. This proves
  // the scan-scope filter (tests/fixtures/scripts trees are out of scope).
  const dir = mkdtempSync(join(tmpdir(), "audit-roles-"));
  const probe = join(dir, "not-shipped-src.ts");
  writeFileSync(probe, 'export const gate = (role: string) => role === "admin";\n');
  const { code, stdout } = runAuditCli(probe);
  assert.equal(code, 0);
  assert.match(stdout, /audit passed/u);
});
