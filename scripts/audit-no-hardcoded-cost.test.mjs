// ITOTORI-225 — regression suite for the no-hardcoded-cost CI guard.
//
// Proves the three canonical cost shapes the guard previously MISSED are
// now caught, that the legitimate ZERO_COST shapes are not, that the
// cost-literal patterns are skipped inside synthetic fixture trees, and
// that the legacy-enum patterns still fire everywhere (so the fixture
// exemption does not weaken the rip-out guard).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import { findViolations } from "./audit-no-hardcoded-cost.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "audit-no-hardcoded-cost.mjs");

const PROD_PATH = "apps/itotori/src/providers/openrouter.ts";

function labels(path, contents) {
  return findViolations(path, contents).map((v) => v.pattern);
}

test("catches a hardcoded non-zero amountMicrosUsd literal", () => {
  const hits = labels(PROD_PATH, "    amountMicrosUsd: 12_500,");
  assert.deepEqual(hits, ["hardcoded non-zero amountMicrosUsd literal"]);
});

test("catches an object-form costUsd amount literal", () => {
  const hits = labels(PROD_PATH, '    costUsd: { unit: "usd", amount: "0.01250000" },');
  assert.deepEqual(hits, ["hardcoded non-zero costUsd object amount literal"]);
});

test("catches a bare non-zero cost numeric literal", () => {
  const hits = labels(PROD_PATH, "      cost: 0.0125,");
  assert.deepEqual(hits, ["hardcoded non-zero bare cost numeric literal"]);
});

test("catches a JSON-quoted amountMicrosUsd literal", () => {
  const hits = labels(PROD_PATH, '        "amountMicrosUsd": 42,');
  assert.deepEqual(hits, ["hardcoded non-zero amountMicrosUsd literal"]);
});

test("still catches a bare costUsd numeric literal", () => {
  const hits = labels(PROD_PATH, "    costUsd: 0.5,");
  assert.deepEqual(hits, ["hardcoded costUsd/cost_usd numeric literal"]);
});

test("leaves the canonical ZERO_COST shapes alone", () => {
  assert.deepEqual(labels(PROD_PATH, "  amountMicrosUsd: 0,"), []);
  assert.deepEqual(labels(PROD_PATH, "      cost: 0,"), []);
  assert.deepEqual(labels(PROD_PATH, '    costUsd: { unit: "usd", amount: "0.00000000" },'), []);
});

test("does not flag cost/amount object forms or variable assignments", () => {
  assert.deepEqual(
    labels(
      PROD_PATH,
      '    cost: { costKind: "billed", amountMicrosUsd: cost.value },'.replace("cost.value", "x"),
    ),
    [],
  );
  assert.deepEqual(labels(PROD_PATH, "    amountMicrosUsd: usageCostToMicros(usage.cost),"), []);
  assert.deepEqual(labels(PROD_PATH, "    costUsd: microsToAmount(telemetry.costMicros),"), []);
  // An unrelated `amount:` field (not inside a costUsd object) is ignored.
  assert.deepEqual(labels(PROD_PATH, '    refund: { unit: "usd", amount: "5.00" },'), []);
});

test("skips cost-literal patterns inside fixture/test trees", () => {
  const shape = "    amountMicrosUsd: 12_500,";
  assert.deepEqual(labels("apps/itotori/test/some.test.ts", shape), []);
  assert.deepEqual(labels("packages/itotori-db/test/x.test.ts", shape), []);
  assert.deepEqual(
    labels("fixtures/itotori-style-guide/provider-smoke-suggestion.json", shape),
    [],
  );
  assert.deepEqual(labels("apps/itotori/src/draft/draft-attempt-fixtures.ts", shape), []);
});

test("still fires legacy-enum patterns inside fixture/test trees", () => {
  // The cost-fixture exemption is scoped to cost literals only; a revived
  // legacy enum must still be caught everywhere.
  assert.deepEqual(labels("apps/itotori/test/some.test.ts", '  costKind: "unknown",'), [
    'costKind: "unknown" / "provider_estimate" / "local_estimate"',
  ]);
  assert.deepEqual(labels("apps/itotori/test/some.test.ts", "  costTier: 2,"), [
    "deprecated costTier field/enum",
  ]);
});

test("CLI exits 1 on a crafted file containing amountMicrosUsd: 12_500", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-cost-"));
  const probe = join(dir, "probe-amount.ts");
  writeFileSync(probe, "export const run = {\n  amountMicrosUsd: 12_500,\n};\n");
  let code = 0;
  try {
    execFileSync("node", [scriptPath, probe], { encoding: "utf8" });
  } catch (err) {
    code = err.status;
  }
  assert.equal(code, 1);
});

test("CLI exits 0 on a crafted file with only ZERO_COST shapes", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-cost-"));
  const probe = join(dir, "probe-zero.ts");
  writeFileSync(probe, "export const run = {\n  amountMicrosUsd: 0,\n  cost: 0,\n};\n");
  const out = execFileSync("node", [scriptPath, probe], { encoding: "utf8" });
  assert.match(out, /audit passed/u);
});
