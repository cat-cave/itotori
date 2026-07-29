import assert from "node:assert/strict";
import test from "node:test";

import {
  LABELS,
  TS,
  isFlagged,
  labels,
  runAuditCli,
  writeShippedProbe,
} from "./audit-no-hardcoded-roles-test-helpers.mjs";

// Optional chaining — Babel OptionalMember/CallExpression must not hide
// auth-role branches (P1 regression from the TS7 stable-AST migration).
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

// Computed / literal-key / full pattern matrix (P1 re-audit after optional fix).
// Static `.role`, optional `?.role`, and literal-computed `["role"]` must be
// equivalent; destructuring-assignment and ArrayPattern aliases must not escape.
test('catches computed optional role compare: `actor?.["role"] === "admin"`', () => {
  const hits = labels(TS, 'if (actor?.["role"] === "admin") grant();');
  assert.ok(hits.includes(LABELS.comparison), JSON.stringify(hits));
  assert.ok(hits.includes(LABELS.subject), JSON.stringify(hits));
});

test('catches literal auth-role map key: `user?.perms?.["admin"]`', () => {
  const hits = labels(TS, 'if (user?.perms?.["admin"]) grant();');
  assert.ok(hits.includes(LABELS.lookup), JSON.stringify(hits));
});

test('catches nested computed role index: `ROLE_MAP?.[actor?.["role"]]`', () => {
  const hits = labels(TS, "const permitted = ROLE_MAP?.[actor?.['role']];");
  assert.ok(hits.includes(LABELS.lookup), JSON.stringify(hits));
  assert.ok(hits.includes(LABELS.subject), JSON.stringify(hits));
});

test('catches computed hasRole helper: `auth?.["hasRole"]?.("admin")`', () => {
  assert.ok(labels(TS, 'if (auth?.["hasRole"]?.("admin")) grant();').includes(LABELS.hasRole));
});

test('catches destructuring-assignment default alias: `({ role: r = "admin" } = x); r === "admin"`', () => {
  const hits = labels(
    TS,
    ["let r;", '({ role: r = "admin" } = actor);', 'if (r === "admin") grant();'].join("\n"),
  );
  assert.ok(hits.includes(LABELS.comparison), JSON.stringify(hits));
});

test('catches array-pattern nested default alias: `const [{ role: r = "admin" }] = users; r === "admin"`', () => {
  const hits = labels(
    TS,
    ['const [{ role: r = "admin" }] = users;', 'if (r === "admin") grant();'].join("\n"),
  );
  assert.ok(hits.includes(LABELS.comparison), JSON.stringify(hits));
});

test('catches nested assignment-pattern profile binding: `({ profile: { role: r = "admin" } = {} } = actor)`', () => {
  const hits = labels(
    TS,
    [
      "let r;",
      '({ profile: { role: r = "admin" } = {} } = actor);',
      'if (r === "admin") grant();',
    ].join("\n"),
  );
  assert.ok(hits.includes(LABELS.comparison), JSON.stringify(hits));
});

test('catches computed role alias then domain-value compare: `const r = actor?.["role"]; r === "draft"`', () => {
  // Auth-subject origin makes even a non-auth literal an auth branch.
  const hits = labels(TS, ['const r = actor?.["role"];', 'if (r === "draft") grant();'].join("\n"));
  assert.ok(hits.includes(LABELS.comparison), JSON.stringify(hits));
  assert.ok(hits.includes(LABELS.subject), JSON.stringify(hits));
});

test("catches TS-asserted role index: `ROLE_MAP?.[(role as string)]`", () => {
  assert.ok(labels(TS, "const p = ROLE_MAP?.[(role as string)];").includes(LABELS.lookup));
});

test("computed/optional GOOD controls: permission-based forms stay clean", () => {
  assert.deepEqual(labels(TS, 'if (user?.perms?.["project.read"]) grant();'), []);
  assert.deepEqual(labels(TS, "const p = PERMISSION_MAP?.[permission];"), []);
  assert.deepEqual(labels(TS, 'if (actor?.["permission"] === "project.read") grant();'), []);
  assert.deepEqual(
    labels(
      TS,
      [
        "let p;",
        '({ permission: p = "project.read" } = actor);',
        'if (p === "project.read") grant();',
      ].join("\n"),
    ),
    [],
  );
  assert.deepEqual(
    labels(
      TS,
      ["const [{ permission: p }] = users;", 'if (p === "project.read") grant();'].join("\n"),
    ),
    [],
  );
  assert.deepEqual(
    labels(TS, "await requirePermission?.(actor, permissionValues.projectRead);"),
    [],
  );
});

test('CLI exits 1 on computed optional role probe `actor?.["role"] === "admin"`', () => {
  const probe = writeShippedProbe(
    "probe-computed-role.ts",
    'export function gate(actor: { role?: string }) {\n  return actor?.["role"] === "admin";\n}\n',
  );
  const { code, stderr } = runAuditCli(probe);
  assert.equal(code, 1);
  assert.match(stderr, /no-hardcoded-roles audit failed/u);
});

test('CLI exits 1 on literal auth-role key probe `user?.perms?.["admin"]`', () => {
  const probe = writeShippedProbe(
    "probe-perms-admin.ts",
    'export function gate(user: { perms?: Record<string, boolean> }) {\n  return Boolean(user?.perms?.["admin"]);\n}\n',
  );
  const { code, stderr } = runAuditCli(probe);
  assert.equal(code, 1);
  assert.match(stderr, /lookup map/u);
});

test('CLI exits 1 on ROLE_MAP?.[actor?.["role"]] probe', () => {
  const probe = writeShippedProbe(
    "probe-role-map-nested.ts",
    "const ROLE_MAP: Record<string, boolean> = {};\nexport const ok = (actor: { role?: string }) => ROLE_MAP?.[actor?.['role']];\n",
  );
  const { code, stderr } = runAuditCli(probe);
  assert.equal(code, 1);
  assert.match(stderr, /lookup map/u);
});

test("CLI exits 1 on destructuring-assignment default alias probe", () => {
  const probe = writeShippedProbe(
    "probe-destruct-assign.ts",
    'export function gate(actor: { role?: string }) {\n  let r: string;\n  ({ role: r = "admin" } = actor);\n  return r === "admin";\n}\n',
  );
  const { code, stderr } = runAuditCli(probe);
  assert.equal(code, 1);
  assert.match(stderr, /comparison on a role read/u);
});

// The expression-narrow `// authz-guard:allow domain-role` marker.
test("an inline `authz-guard:allow domain-role` marker exempts the flagged line", () => {
  const marked = 'if (user.role === "admin") { } // authz-guard:allow domain-role — system actor';
  assert.deepEqual(labels(TS, marked), []);
});

test("a marker in the contiguous comment block ABOVE exempts the code line below", () => {
  const block = [
    "// authz-guard:allow domain-role — non-auth workflow stage role",
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

// The two REAL domain-role allowlist sites + the LLM message-role uses pass.
test('a non-auth workflow-stage role `role === "draft"` passes', () => {
  assert.deepEqual(labels(TS, 'if (role === "draft") {'), []);
});

test('the real catalog translation-source role `role === "official_translation"` passes', () => {
  assert.deepEqual(labels(TS, 'const ok = role === "official_translation";'), []);
});

test('the LLM message-role uses `{ role: "system" }` / `message.role === "user"` pass', () => {
  assert.deepEqual(labels(TS, 'const m = { role: "system", content: text };'), []);
  assert.deepEqual(labels(TS, 'const isUser = message.role === "user";'), []);
});
