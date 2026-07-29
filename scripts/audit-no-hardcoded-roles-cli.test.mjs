import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  LABELS,
  RS,
  labels,
  runAuditCli,
  writeShippedProbe,
} from "./audit-no-hardcoded-roles-test-helpers.mjs";

// Rust shapes — pragmatic pattern-scan.
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

// CLI: scan scope + exit codes, incl. a temp-file probe for each missed shape.
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
  assert.match(stderr, /no-hardcoded-roles audit failed/u);
  assert.match(stderr, /switch on a role read/u);
});

test('CLI exits 1 on a shipped-src probe with `role !== "viewer"` (inequality shape)', () => {
  const probe = writeShippedProbe(
    "probe-inequality.ts",
    'export function gate(role: string) {\n  return role !== "viewer";\n}\n',
  );
  const { code, stderr } = runAuditCli(probe);
  assert.equal(code, 1);
  assert.match(stderr, /no-hardcoded-roles audit failed/u);
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
