import assert from "node:assert/strict";
import test from "node:test";

import {
  checkBudget,
  declaredNames,
  trackedRegularFiles,
  undeclaredReads,
} from "./env-registry-guard.mjs";

test("reports an undeclared literal project environment read", () => {
  const name = ["ITOTORI", "UNDECLARED_TEST_VALUE"].join("_");
  assert.deepEqual(undeclaredReads(`const value = process.env.${name};`), [name]);
});

test("accepts the registered field-cipher secret", () => {
  assert.equal(declaredNames().has("ITOTORI_FIELD_CIPHER_KEY"), true);
  assert.deepEqual(undeclaredReads("const value = process.env.ITOTORI_FIELD_CIPHER_KEY;"), []);
});

test("scans tracked regular files without resolving host-specific Corepack symlinks", () => {
  const indexEntries = [
    "100644 0123456789012345678901234567890123456789 0\tscripts/reader.mjs",
    "120000 0123456789012345678901234567890123456789 0\tapps/itotori/.corepack/bin/pnpm",
  ].join("\n");

  assert.deepEqual(trackedRegularFiles(indexEntries), ["scripts/reader.mjs"]);
});

test("rejects both an increased count and unrecorded progress", () => {
  assert.match(checkBudget(45, { undeclaredReads: 44 }), /rose from budget 44 to 45/u);
  assert.match(checkBudget(43, { undeclaredReads: 44 }), /fell from budget 44 to 43/u);
  assert.equal(checkBudget(44, { undeclaredReads: 44 }), undefined);
});

test("requires budget deletion only after the absolute check reaches zero", () => {
  assert.match(
    checkBudget(0, { undeclaredReads: 1 }),
    /delete scripts\/env-registry-guard-budget\.json/u,
  );
  assert.equal(checkBudget(0, undefined), undefined);
});
