// strictness-ci-guard-bans-laxity-reintroduction — regression suite.
//
// Proves each of the guard's five rules fires on a synthetic VIOLATING
// snippet and stays silent on a synthetic COMPLIANT one, and that the CLI
// exits 0 on the current (green) repo. Mirrors
// scripts/audit-no-hardcoded-cost.test.mjs.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  checkBareIgnore,
  checkUnreasonedAllow,
  checkDenyBans,
  checkRelaxedFloors,
  parseLaneCrates,
  crateOwnsRealBytes,
  evaluateRealBytesCoverage,
} from "./audit-strictness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "audit-strictness.mjs");
const RS = "crates/kaifuu-reallive/src/lib.rs";
const RB = "crates/kaifuu-reallive/tests/thing_real_bytes.rs";

function rules(found) {
  return found.map((v) => v.rule);
}

// ---- Rule 1: bare #[ignore] ---------------------------------------------
test("rule 1 flags a bare #[ignore] with no reason", () => {
  assert.deepEqual(rules(checkBareIgnore(RS, "    #[ignore]")), [
    "bare #[ignore] without a reason",
  ]);
});

test('rule 1 accepts #[ignore = "…"] and ignores prose/strings', () => {
  assert.deepEqual(checkBareIgnore(RS, '#[ignore = "requires real bytes"]'), []);
  // `#[ignore]` inside a doc comment or a string-literal continuation must not
  // be mistaken for a bare attribute.
  assert.deepEqual(checkBareIgnore(RS, "//! this test is `#[ignore]`-gated"), []);
  assert.deepEqual(checkBareIgnore(RS, '        #[ignore]-gated and only run with X",'), []);
});

// ---- Rule 2: unreasoned #[allow(...)] ------------------------------------
test("rule 2 flags an #[allow(...)] / #![allow(...)] with no reason", () => {
  assert.deepEqual(rules(checkUnreasonedAllow(RS, "#[allow(clippy::too_many_arguments)]")), [
    "#[allow(...)] without a `// reason:`",
  ]);
  assert.deepEqual(rules(checkUnreasonedAllow(RS, "#![allow(dead_code)]")), [
    "#[allow(...)] without a `// reason:`",
  ]);
});

test("rule 2 accepts an inline or block-comment `// reason:`", () => {
  assert.deepEqual(checkUnreasonedAllow(RS, "#[allow(dead_code)] // reason: test helper"), []);
  // Reason anywhere in the contiguous comment block directly above.
  const block = [
    "// reason: builder over many distinct byte-layout fields;",
    "// a params struct would only relocate the arity.",
    "#[allow(clippy::too_many_arguments)]",
  ].join("\n");
  assert.deepEqual(checkUnreasonedAllow(RS, block), []);
});

// ---- Rule 3: deny.toml bans ----------------------------------------------
test("rule 3 flags a ban left at warn/allow (or missing)", () => {
  const lax = '[bans]\nmultiple-versions = "warn"\nwildcards = "allow"\n';
  assert.deepEqual(rules(checkDenyBans(lax)).sort(), [
    'deny.toml `multiple-versions` must be "deny"',
    'deny.toml `wildcards` must be "deny"',
  ]);
  assert.deepEqual(rules(checkDenyBans("[bans]\n")), [
    'deny.toml `multiple-versions` must be "deny"',
    'deny.toml `wildcards` must be "deny"',
  ]);
});

test("rule 3 accepts both bans at deny (ignoring comment prose)", () => {
  const strict =
    '[bans]\n# multiple-versions = "allow" would be laxity\nmultiple-versions = "deny"\nwildcards = "deny"\n';
  assert.deepEqual(checkDenyBans(strict), []);
});

// ---- Rule 4: relaxed floors on real-bytes assert lines -------------------
test("rule 4 flags relaxed floors on real-bytes assert lines", () => {
  const ceil = 'assert!(\n    unknown <= 135,\n    "msg"\n);';
  assert.deepEqual(rules(checkRelaxedFloors(RB, ceil)), [
    "relaxed floor on a real-bytes assert without justification",
  ]);
  const minFloor = 'assert!(\n    clean >= MIN_CLEAN_PARSE_COUNT,\n    "msg"\n);';
  assert.deepEqual(rules(checkRelaxedFloors(RB, minFloor)), [
    "relaxed floor on a real-bytes assert without justification",
  ]);
  const frac = 'assert!(coverage >= 0.75, "msg");';
  assert.deepEqual(rules(checkRelaxedFloors(RB, frac)), [
    "relaxed floor on a real-bytes assert without justification",
  ]);
});

test("rule 4 stays silent with an inline justification, off assert lines, and in non-real-bytes files", () => {
  // Inline justification exempts the line.
  const justified = "assert!(\n    unknown <= 135, // justification: documented domain bound\n);";
  assert.deepEqual(checkRelaxedFloors(RB, justified), []);
  const tracked =
    "assert!(\n    clean >= MIN_CLEAN_PARSE_COUNT, // TODO(strictness-fix-relaxed-floors-to-strict): tighten\n);";
  assert.deepEqual(checkRelaxedFloors(RB, tracked), []);
  // A `<= n` outside any assert (e.g. a filter/shift) is not a floor.
  assert.deepEqual(checkRelaxedFloors(RB, "    let keep = xs.filter(|x| *x <= 8);"), []);
  assert.deepEqual(checkRelaxedFloors(RB, "        bit <<= 1;"), []);
  // Same floor in a non-real-bytes file is out of scope.
  assert.deepEqual(checkRelaxedFloors(RS, "assert!(coverage >= 0.75);"), []);
});

// ---- Rule 5: real-bytes crate outside the lane ---------------------------
test("rule 5 parses the ci-real-bytes lane and detects real-bytes crates", () => {
  const jf = [
    "ci-real-bytes:",
    "    export X=y",
    "    cargo test -p kaifuu-reallive -p utsushi-reallive -p kaifuu-cli -p utsushi-cli -- --ignored",
    "",
    "qd-full-ci:",
    "    node scripts/qd-full-ci.mjs",
  ].join("\n");
  const lane = parseLaneCrates(jf);
  assert.deepEqual([...lane].sort(), [
    "kaifuu-cli",
    "kaifuu-reallive",
    "utsushi-cli",
    "utsushi-reallive",
  ]);

  // A real-bytes file, or an #[ignore] naming a live corpus, marks the crate.
  assert.equal(crateOwnsRealBytes("crates/foo/tests/x_real_bytes.rs", "fn t() {}"), true);
  assert.equal(
    crateOwnsRealBytes("crates/foo/tests/x.rs", '#[ignore = "requires ITOTORI_REAL_GAME_ROOT"]'),
    true,
  );
  assert.equal(
    crateOwnsRealBytes("crates/foo/tests/x.rs", '#[ignore = "requires ITOTORI_VAULT_ROOT"]'),
    true,
  );
  // A plain #[ignore] (bug-tracking, no live corpus) does NOT mark the crate.
  assert.equal(
    crateOwnsRealBytes("crates/foo/tests/x.rs", '#[ignore = "flaky, KAIFUU-237"]'),
    false,
  );
});

test("rule 5 flags an uncovered crate but not lane or allowlisted crates", () => {
  const lane = new Set(["kaifuu-reallive", "utsushi-reallive", "kaifuu-cli", "utsushi-cli"]);
  // A brand-new real-bytes crate absent from lane + allowlist is flagged.
  const flagged = evaluateRealBytesCoverage(new Set(["kaifuu-siglus"]), lane);
  assert.equal(flagged.length, 1);
  assert.match(flagged[0].rule, /kaifuu-siglus/u);
  // Lane crates and the transitional allowlist crates are NOT flagged.
  assert.deepEqual(
    evaluateRealBytesCoverage(
      new Set(["kaifuu-reallive", "kaifuu-rpgmaker", "utsushi-core", "kaifuu-vault-source"]),
      lane,
    ),
    [],
  );
});

// ---- CLI smoke: the guard is green on the current repo -------------------
test("CLI exits 0 on the current (green) repo", () => {
  const out = execFileSync("node", [scriptPath], { encoding: "utf8" });
  assert.match(out, /strictness audit passed/u);
});
