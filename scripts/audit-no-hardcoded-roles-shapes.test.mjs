import assert from "node:assert/strict";
import test from "node:test";

import { LABELS, RS, TS, labels } from "./audit-no-hardcoded-roles-test-helpers.mjs";

// Previously-missed shape 1 — PROPERTY-ACCESS comparison (the core bug: the
// old regex EXPLICITLY excluded property access, so `user.role === "admin"`
// slipped through).
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

// Previously-missed shape 2 — SWITCH on a role read (the old regex never
// handled `switch (role) { case "admin": ... }`).
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

// Previously-missed shape 3 — INEQUALITY (`!==` / `!=`); the old regex only
// caught `===` / `==`.
test('SHAPE 3 (inequality): catches `role !== "viewer"` and `role != "admin"` (was missed)', () => {
  assert.deepEqual(labels(TS, 'if (role !== "viewer") deny();'), [LABELS.comparison]);
  assert.deepEqual(labels(TS, "const bad = role != 'admin';"), [LABELS.comparison]);
});

test('SHAPE 3 (negative): does NOT flag `role !== "inventory_only"` (asset-surface domain role)', () => {
  assert.deepEqual(labels(TS, 'return role !== "inventory_only";'), []);
  // `role !== undefined` is not a string-literal comparison at all.
  assert.deepEqual(labels(TS, "if (role !== undefined) map(role);"), []);
});

// Previously-missed shape 4 — role-keyed LOOKUP MAP (`ROLES[role]` /
// `ROLE_PERMISSIONS[role]`); the old regex never saw element-access indexing.
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

// Alias / destructuring role reads (branch on a variable that aliases a role).
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

// Auth-subject `.role` read in any context (a bare access, not only a compare).
test("catches a bare `actor.role` / `principal.role` read even outside a comparison", () => {
  assert.deepEqual(labels(TS, "return actor.role;"), [LABELS.subject]);
  assert.deepEqual(labels(TS, "const r = principal.role;"), [LABELS.subject]);
});

test("does NOT flag a non-auth-subject `.role` read (`message.role`, `row.role`, `user.roles`)", () => {
  assert.deepEqual(labels(TS, "const x = message.role;"), []);
  assert.deepEqual(labels(TS, "const x = row.role;"), []);
  assert.deepEqual(labels(TS, "for (const r of user.roles) {}"), []);
});

// Classic name-based shortcuts — preserved from the original guard.
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
