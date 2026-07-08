// ITOTORI-225 — regression suite for the no-hardcoded-cost CI guard.
//
// Proves the three canonical cost shapes the guard previously MISSED are
// now caught, that the legitimate ZERO_COST shapes are not, that the
// cost-literal patterns now fire INSIDE test/fixture trees too (the old
// blanket `test/`+`fixtures/` exemption is gone), that the per-line
// `itotori-225-audit-allow:` marker (with a mandatory non-empty reason) is
// the only per-line opt-out, that the enumerated comment-incapable JSON
// fixtures (COST_LITERAL_ALLOW) are exempted per-file but an UN-listed JSON
// fixture is not, that the legacy-enum patterns fire everywhere EXCEPT the
// enumerated external-system benchmark fixtures (LEGACY_ENUM_ALLOW), and that
// the bridge-schema package has NO blanket exemption (a new un-listed schema
// file with a cost literal or revived legacy enum still fails).

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

// Invoke the auditor CLI as a fully CAPTURED subprocess.
//
// On a detected violation the auditor writes `ITOTORI-225 audit failed: ...`
// to ITS stderr. The default `execFileSync` stdio inherits the child's stderr
// onto THIS test process's own stderr, so that failure line escaped the test
// even though the probes below are INTENTIONAL detection checks, not real repo
// violations. Tooling that greps the test's stderr for that string (e.g.
// `qd advance`, which treats a stderr match as a lifecycle failure) then
// false-tripped on a passing test. Capturing stdout+stderr here (stdin
// ignored) keeps the child's output inside this helper: the tests still PROVE
// detection by asserting on the captured stderr, but the parent stderr stays
// clean. Returns the exit code plus the captured streams (stderr empty on a
// clean pass).
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

test("catches a hardcoded non-zero amountMicrosUsd literal", () => {
  const hits = labels(PROD_PATH, "    amountMicrosUsd: 12_500,");
  assert.deepEqual(hits, ["hardcoded non-zero amountMicrosUsd literal"]);
});

test("catches a hardcoded non-zero amountMicrosUsd literal split ACROSS multiple lines", () => {
  const multiline = ["amountMicrosUsd:", "  12_500,"].join("\n");
  const hits = findViolations(PROD_PATH, multiline);
  assert.deepEqual(
    hits.map((v) => v.pattern),
    ["hardcoded non-zero amountMicrosUsd literal"],
  );
  assert.equal(hits[0].line, 1);
});

test("catches a hardcoded non-zero amountUsd string literal (the authoritative ledger cost)", () => {
  // amountUsd is the full-precision decimal the ledger persists as cost_amount
  // (assertBilledCostDecimal returns it verbatim; migration 0041 1e-9 CHECK).
  // A hardcoded amountUsd is as forbidden as a hardcoded amountMicrosUsd.
  const hits = labels(PROD_PATH, '    amountUsd: "0.05",');
  assert.deepEqual(hits, ["hardcoded non-zero amountUsd literal"]);
});

test("catches a hardcoded non-zero amountUsd NUMERIC literal", () => {
  const hits = labels(PROD_PATH, "    amountUsd: 0.00157,");
  assert.deepEqual(hits, ["hardcoded non-zero amountUsd literal"]);
});

test("catches a JSON-quoted amountUsd string literal", () => {
  const hits = labels(PROD_PATH, '        "amountUsd": "0.0125",');
  assert.deepEqual(hits, ["hardcoded non-zero amountUsd literal"]);
});

test("leaves the ZERO_COST amountUsd shapes alone", () => {
  assert.deepEqual(labels(PROD_PATH, '    amountUsd: "0",'), []);
  assert.deepEqual(labels(PROD_PATH, '    amountUsd: "0.00000000",'), []);
  assert.deepEqual(labels(PROD_PATH, "    amountUsd: 0,"), []);
});

test("does not flag amountUsd variable / shorthand / type / expression forms", () => {
  // A variable reference, object shorthand, type annotation, and property
  // access are all honest non-literals: the value after the colon is not a
  // number, so nothing fires. `costAmountUsd` (capital A) is a different key.
  assert.deepEqual(labels(PROD_PATH, "    amountUsd: overrides.amountUsd,"), []);
  assert.deepEqual(
    labels(PROD_PATH, "    return { costKind, currency, amountUsd, amountMicrosUsd };"),
    [],
  );
  assert.deepEqual(labels(PROD_PATH, "    amountUsd: string;"), []);
  assert.deepEqual(labels(PROD_PATH, "    amountUsd: usageCostToDecimalString(decimalUsd),"), []);
  assert.deepEqual(labels(PROD_PATH, "    costAmountUsd: run.cost.amountUsd,"), []);
  assert.deepEqual(
    labels(PROD_PATH, "    expect(row.amountUsd).toBe(row.amountMicrosUsd / 1e6);"),
    [],
  );
});

test("a marked synthetic amountUsd literal is exempt; without a marker it fires", () => {
  const marked =
    '        amountUsd: "0.00000602", // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount';
  assert.deepEqual(labels("apps/itotori/test/some.test.ts", marked), []);
  assert.deepEqual(labels("apps/itotori/test/some.test.ts", '        amountUsd: "0.00000602",'), [
    "hardcoded non-zero amountUsd literal",
  ]);
});

test("enumerated JSON fixtures skip the amountUsd cost-literal pattern", () => {
  // amountUsd is a cost-literal pattern, so the enumerated comment-incapable
  // JSON fixtures (COST_LITERAL_ALLOW) skip it like the other cost literals.
  const listed = "fixtures/itotori-style-guide/provider-smoke-suggestion.json";
  assert.deepEqual(labels(listed, '    "amountUsd": "0.000123",'), []);
});

test("CLI exits 1 on a crafted file with a hardcoded amountUsd literal", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-cost-"));
  const probe = join(dir, "probe-amountusd.ts");
  writeFileSync(probe, 'export const run = {\n  amountUsd: "0.05",\n};\n');
  const { code, stderr } = runAuditCli(probe);
  assert.equal(code, 1);
  // Detection is proven via the CAPTURED stderr; it never reaches this test's
  // own stderr (so `qd advance`'s failure-string grep no longer false-trips).
  assert.match(stderr, /ITOTORI-225 audit failed/u);
});

test("CLI exits 0 on a crafted file with only ZERO_COST amountUsd shapes", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-cost-"));
  const probe = join(dir, "probe-amountusd-zero.ts");
  writeFileSync(probe, 'export const run = {\n  amountUsd: "0",\n  amountMicrosUsd: 0,\n};\n');
  const { code, stdout } = runAuditCli(probe);
  assert.equal(code, 0);
  assert.match(stdout, /audit passed/u);
});

test("catches an object-form costUsd amount literal", () => {
  const hits = labels(PROD_PATH, '    costUsd: { unit: "usd", amount: "0.01250000" },');
  assert.deepEqual(hits, ["hardcoded non-zero costUsd object amount literal"]);
});

test("catches an object-form costUsd amount literal split ACROSS multiple lines", () => {
  // Prettier can split the costUsd money object across lines, stranding the
  // `amount:` line without a `cost` token. The block scanner joins the object
  // first, so the hardcoded amount is still caught. Reported on the opener.
  const multiline = ["costUsd: {", '  unit: "usd",', '  amount: "0.0125",', "},"].join("\n");
  const hits = findViolations(PROD_PATH, multiline);
  assert.deepEqual(
    hits.map((v) => v.pattern),
    ["hardcoded non-zero costUsd object amount literal"],
  );
  assert.equal(hits[0].line, 1);
});

test("leaves a multi-line ZERO_COST costUsd object alone", () => {
  const multiline = ["costUsd: {", '  unit: "usd",', '  amount: "0.00000000",', "},"].join("\n");
  assert.deepEqual(labels(PROD_PATH, multiline), []);
});

test("does not double-report a single-line costUsd object", () => {
  // The block scanner subsumes the single-line case; it must fire EXACTLY once.
  const hits = findViolations(PROD_PATH, '    costUsd: { unit: "usd", amount: "0.01250000" },');
  assert.equal(hits.length, 1);
});

test("ignores a multi-line NON-costUsd object with a decimal amount (no false positive)", () => {
  // A standalone `amount:` inside an unrelated object (e.g. a refund/token
  // field) must NOT trip — the scanner anchors on `costUsd: {`.
  const multiline = ["refund: {", '  unit: "usd",', '  amount: "5.00",', "},"].join("\n");
  assert.deepEqual(labels(PROD_PATH, multiline), []);
});

test("a per-line audit-allow marker inside a multi-line costUsd object opts it out", () => {
  const multiline = [
    "costUsd: {",
    '  unit: "usd",',
    '  amount: "0.0125", // itotori-225-audit-allow: synthetic fixture cost',
    "},",
  ].join("\n");
  assert.deepEqual(labels(PROD_PATH, multiline), []);
});

test("CLI exits 1 on a crafted file with a multi-line costUsd object", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-cost-"));
  const probe = join(dir, "probe-costusd-multiline.ts");
  writeFileSync(
    probe,
    [
      "export const run = {",
      "  costUsd: {",
      '    unit: "usd",',
      '    amount: "0.0125",',
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  const { code, stderr } = runAuditCli(probe);
  assert.equal(code, 1);
  assert.match(stderr, /ITOTORI-225 audit failed/u);
});

test("catches a bare non-zero cost numeric literal", () => {
  const hits = labels(PROD_PATH, "      cost: 0.0125,");
  assert.deepEqual(hits, ["hardcoded non-zero bare cost numeric literal"]);
});

test("catches a bare non-zero cost numeric literal split ACROSS multiple lines", () => {
  const multiline = ["cost:", "  0.0125,"].join("\n");
  const hits = findViolations(PROD_PATH, multiline);
  assert.deepEqual(
    hits.map((v) => v.pattern),
    ["hardcoded non-zero bare cost numeric literal"],
  );
  assert.equal(hits[0].line, 1);
});

test("catches a JSON-quoted amountMicrosUsd literal", () => {
  const hits = labels(PROD_PATH, '        "amountMicrosUsd": 42,');
  assert.deepEqual(hits, ["hardcoded non-zero amountMicrosUsd literal"]);
});

test("still catches a bare costUsd numeric literal", () => {
  const hits = labels(PROD_PATH, "    costUsd: 0.5,");
  assert.deepEqual(hits, ["hardcoded costUsd/cost_usd numeric literal"]);
});

test("catches a `?? estimateTokens(...)` token-count fabrication fallback", () => {
  const hits = labels(
    PROD_PATH,
    "    const tokensOut = providerRun.tokenUsage.completionTokens ?? estimateTokens(rawContent);",
  );
  assert.deepEqual(hits, [
    "token-count fabrication: `?? estimateTokens(...)` fallback in a recording path",
  ]);
});

test("leaves a legitimate non-fallback estimateTokens(...) pre-flight call alone", () => {
  // Pre-flight planning + the explicitly-named `inputTokenEstimate` are honest
  // estimates: they do not use the `?? estimateTokens(` fallback form.
  assert.deepEqual(labels(PROD_PATH, "  tokens += estimateTokens(input.sceneSummary.body);"), []);
  assert.deepEqual(
    labels(PROD_PATH, "  const inputTokenEstimate = estimateTokens(`${a}\\n${b}`);"),
    [],
  );
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

test("FIRES cost-literal patterns inside test/fixture trees (no blanket exemption)", () => {
  // The old blanket `test/`+`fixtures/` cost-literal exemption is removed: an
  // UN-annotated cost literal in a test tree now fails exactly as in src/.
  const shape = "    amountMicrosUsd: 12_500,";
  assert.deepEqual(labels("apps/itotori/test/some.test.ts", shape), [
    "hardcoded non-zero amountMicrosUsd literal",
  ]);
  assert.deepEqual(labels("packages/itotori-db/test/x.test.ts", shape), [
    "hardcoded non-zero amountMicrosUsd literal",
  ]);
  // An arbitrary (un-listed) JSON fixture under fixtures/ also fires now.
  assert.deepEqual(labels("fixtures/some-new-fixture.json", '  "amountMicrosUsd": 12500,'), [
    "hardcoded non-zero amountMicrosUsd literal",
  ]);
});

test("per-line audit-allow marker (with a reason) passes; without one it still fires", () => {
  const withMarker =
    "    amountMicrosUsd: 12_500, // itotori-225-audit-allow: synthetic fixture cost, not a real billed amount";
  assert.deepEqual(labels("apps/itotori/test/some.test.ts", withMarker), []);
  // A bare marker with NO reason is inert — the literal still fires.
  const noReason = "    amountMicrosUsd: 12_500, // itotori-225-audit-allow:";
  assert.deepEqual(labels("apps/itotori/test/some.test.ts", noReason), [
    "hardcoded non-zero amountMicrosUsd literal",
  ]);
});

test("enumerated JSON fixtures skip cost-literal patterns but nothing else", () => {
  // COST_LITERAL_ALLOW files (JSON has no line-comment syntax) skip ONLY the
  // cost-literal patterns; a revived legacy enum in them still fires.
  const listed = "fixtures/itotori-style-guide/provider-smoke-suggestion.json";
  assert.deepEqual(labels(listed, '    "amountMicrosUsd": 42,'), []);
  assert.deepEqual(labels(listed, '    "cost": 0.000123,'), []);
  // A non-cost-literal pattern (deprecated costTier) still fires on the file.
  assert.deepEqual(labels(listed, '    "costTier": 2,'), ["deprecated costTier field/enum"]);
});

test("catches a JSON-quoted legacy-enum costKind literal (not just the TS form)", () => {
  // The legacy-enum pattern allows optional quotes around the key so the
  // JSON shape `"costKind": "unknown"` is caught alongside the TS
  // object-literal `costKind: "unknown"`. ITOTORI-134 removed
  // `provider_estimate` from the forbidden list (it is now a legitimate
  // deterministic cost-estimate state), so only `unknown` / `local_estimate`
  // fire; a `provider_estimate` literal is ALLOWED everywhere.
  assert.deepEqual(labels(PROD_PATH, '        "costKind": "unknown",'), [
    'costKind: "unknown" / "local_estimate"',
  ]);
  assert.deepEqual(labels(PROD_PATH, '        "costKind": "local_estimate",'), [
    'costKind: "unknown" / "local_estimate"',
  ]);
  // ITOTORI-134: provider_estimate is now allowed — no violation.
  assert.deepEqual(labels(PROD_PATH, '        "costKind": "provider_estimate",'), []);
  assert.deepEqual(labels("fixtures/some-new.json", '  "costKind": "unknown",'), [
    'costKind: "unknown" / "local_estimate"',
  ]);
});

test("no blanket schema-package exemption: a NEW un-listed schema file still fires", () => {
  // The whole-package `packages/localization-bridge-schema/` ALLOW_LIST entry
  // is gone. A fresh, un-enumerated file in the schema package with a cost
  // literal or a revived legacy enum fails exactly as production source does.
  const newSchemaSrc = "packages/localization-bridge-schema/src/new-thing.ts";
  assert.deepEqual(labels(newSchemaSrc, "    amountMicrosUsd: 12_500,"), [
    "hardcoded non-zero amountMicrosUsd literal",
  ]);
  assert.deepEqual(labels(newSchemaSrc, '    costKind: "unknown",'), [
    'costKind: "unknown" / "local_estimate"',
  ]);
  const newSchemaFixture =
    "packages/localization-bridge-schema/test/examples/benchmark-report-v0.2-unlisted.json";
  assert.deepEqual(labels(newSchemaFixture, '        "costKind": "unknown",'), [
    'costKind: "unknown" / "local_estimate"',
  ]);
  assert.deepEqual(labels(newSchemaFixture, '        "amountMicrosUsd": 1570,'), [
    "hardcoded non-zero amountMicrosUsd literal",
  ]);
});

test("ITOTORI-134: provider_estimate costKind is allowed everywhere (production + fixtures)", () => {
  // ITOTORI-134 re-introduces `provider_estimate` as a legitimate deterministic
  // cost-estimate state. The legacy-enum pattern no longer flags it in any
  // file — production source, test trees, or un-listed fixtures. The forbidden
  // legacy-enum values are now ONLY `unknown` and `local_estimate`.
  assert.deepEqual(
    labels("apps/itotori/src/providers/openrouter.ts", '    costKind: "provider_estimate",'),
    [],
  );
  assert.deepEqual(
    labels("apps/itotori/src/providers/types.ts", '    costKind: "provider_estimate",'),
    [],
  );
  assert.deepEqual(
    labels("apps/itotori/test/some.test.ts", '  costKind: "provider_estimate",'),
    [],
  );
  assert.deepEqual(labels("fixtures/some-new.json", '  "costKind": "provider_estimate",'), []);
  // A hardcoded cost AMOUNT is still caught regardless of costKind.
  assert.deepEqual(
    labels(
      "apps/itotori/src/providers/types.ts",
      '    costKind: "provider_estimate",\n    amountMicrosUsd: 12_500,',
    ),
    ["hardcoded non-zero amountMicrosUsd literal"],
  );
});

test("enumerated benchmark fixtures skip the cost-literal patterns", () => {
  // The four external-system benchmark fixtures are enumerated in COST_LITERAL_ALLOW
  // (amountMicrosUsd estimate). ITOTORI-134 made `provider_estimate` generally
  // allowed, so the legacy-enum skip is no longer load-bearing for these files,
  // but the cost-literal skip still applies; nothing else is skipped.
  const listed = "packages/localization-bridge-schema/test/examples/benchmark-report-v0.2.json";
  assert.deepEqual(labels(listed, '        "costKind": "provider_estimate",'), []);
  assert.deepEqual(labels(listed, '        "amountMicrosUsd": 1570,'), []);
  // A non-cost / non-legacy-enum pattern (deprecated costTier) still fires.
  assert.deepEqual(labels(listed, '        "costTier": 2,'), ["deprecated costTier field/enum"]);
});

test("fires cost-literal patterns inside scanned src/ even for fixture modules", () => {
  // PROJECT LAW: no fabricated cost literal in scanned production source,
  // even in a "test fixture" that happens to live under src/. There is no
  // per-tree cost-literal exemption for any src/ module; a revived invented
  // amount must fire. (The former in-src draft-attempt-fixtures.ts was
  // relocated under test/, so any future src-tree fixture module is held to
  // exactly this bar.)
  assert.deepEqual(
    labels("apps/itotori/src/draft/some-fixture-module.ts", "    amountMicrosUsd: 12_500,"),
    ["hardcoded non-zero amountMicrosUsd literal"],
  );
});

test("still fires legacy-enum patterns inside fixture/test trees", () => {
  // The cost-fixture exemption is scoped to cost literals only; a revived
  // legacy enum must still be caught everywhere. ITOTORI-134 narrowed the
  // forbidden legacy enum to `unknown` / `local_estimate` only.
  assert.deepEqual(labels("apps/itotori/test/some.test.ts", '  costKind: "unknown",'), [
    'costKind: "unknown" / "local_estimate"',
  ]);
  assert.deepEqual(labels("apps/itotori/test/some.test.ts", "  costTier: 2,"), [
    "deprecated costTier field/enum",
  ]);
});

test("CLI exits 1 on a crafted file containing amountMicrosUsd: 12_500", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-cost-"));
  const probe = join(dir, "probe-amount.ts");
  writeFileSync(probe, "export const run = {\n  amountMicrosUsd: 12_500,\n};\n");
  const { code, stderr } = runAuditCli(probe);
  assert.equal(code, 1);
  assert.match(stderr, /ITOTORI-225 audit failed/u);
});

test("CLI exits 1 on a crafted file containing multi-line amountMicrosUsd and bare cost literals", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-cost-"));
  const probe = join(dir, "probe-multiline-cost.ts");
  writeFileSync(
    probe,
    [
      "export const run = {",
      "  amountMicrosUsd:",
      "    12_500,",
      "  usageResponseJson: {",
      "    cost:",
      "      0.0125,",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  const { code, stderr } = runAuditCli(probe);
  assert.equal(code, 1);
  assert.match(stderr, /hardcoded non-zero amountMicrosUsd literal/u);
  assert.match(stderr, /hardcoded non-zero bare cost numeric literal/u);
});

test("CLI exits 0 on a crafted file with only ZERO_COST shapes", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-cost-"));
  const probe = join(dir, "probe-zero.ts");
  writeFileSync(probe, "export const run = {\n  amountMicrosUsd: 0,\n  cost: 0,\n};\n");
  const { code, stdout } = runAuditCli(probe);
  assert.equal(code, 0);
  assert.match(stdout, /audit passed/u);
});
