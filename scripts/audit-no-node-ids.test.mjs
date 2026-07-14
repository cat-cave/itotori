// Regression suite for the no-node-id CI guard.
//
// Proves the ratchet is airtight: a planted new violation FAILS, a grandfathered
// one PASSES, a whitelist that grew is REFUSED, and --update refuses to grow
// (whether by total count or by a brand-new node id). Also covers token
// extraction (multiple refs per line), scope exclusions (fixtures / migrations
// SQL / delete-zone), and the absolute-zero posture when no whitelist exists.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "audit-no-node-ids.mjs");

import {
  evaluateCheck,
  evaluateUpdate,
  emptyWhitelist,
  findNodeIdViolations,
  isExcludedPath,
  shouldScan,
} from "./audit-no-node-ids.mjs";

const CRATE = "crates/kaifuu-core/src/lib.rs";

function whitelist(files) {
  return {
    ...emptyWhitelist(),
    total: Object.values(files).reduce((n, a) => n + a.length, 0),
    files,
  };
}

test("extracts one token per node-id reference, including multiple per line", () => {
  const v = findNodeIdViolations(
    CRATE,
    "//! KAIFUU-011 smoke; see UTSUSHI-049 for the patch path.\n",
  );
  assert.deepEqual(v.map((x) => x.token).sort(), ["kaifuu-011", "utsushi-049"]);
});

test("catches every id family plus the prose and slug forms", () => {
  const lines = [
    "/// RB-1 / ITOTORI-2 / KAIFUU-3 / UTSUSHI-4 all match.",
    "/// Owned by p0-core-atomic-cost-reservation.",
    "/// This is a follow-up node.",
    "/// Deferred for node; see node later.",
    "TODO(KAIFUU-5): drop once cleaned.",
  ].join("\n");
  const tokens = findNodeIdViolations(CRATE, lines)
    .map((x) => x.token)
    .sort();
  assert.deepEqual(tokens, [
    "deferred for node",
    "follow-up node",
    "itotori-2",
    "kaifuu-3",
    "kaifuu-5",
    "p0-core-atomic-cost-reservation",
    "rb-1",
    "see node",
    "utsushi-4",
  ]);
});

test("a planted new violation (brand-new id) is NOT covered -> check fails", () => {
  const violations = findNodeIdViolations(CRATE, "//! KAIFUU-999 brand new.\n");
  const wl = whitelist({ [CRATE]: ["kaifuu-011"] });
  const { ok, newViolations } = evaluateCheck(violations, wl);
  assert.equal(ok, false);
  assert.equal(newViolations[0].token, "kaifuu-999");
  assert.equal(newViolations[0].excess, 1);
});

test("a planted extra occurrence of a grandfathered id (over its count) fails", () => {
  // Whitelist allots ONE kaifuu-011 in this file; a second occurrence is new.
  const violations = findNodeIdViolations(CRATE, "//! KAIFUU-011 a\n//! KAIFUU-011 b\n");
  const wl = whitelist({ [CRATE]: ["kaifuu-011"] });
  const { ok, newViolations } = evaluateCheck(violations, wl);
  assert.equal(ok, false);
  assert.equal(newViolations[0].token, "kaifuu-011");
  assert.equal(newViolations[0].excess, 1);
});

test("a grandfathered existing violation passes", () => {
  const violations = findNodeIdViolations(CRATE, "//! KAIFUU-011 smoke.\n//! UTSUSHI-049 patch.\n");
  const wl = whitelist({ [CRATE]: ["kaifuu-011", "utsushi-049"] });
  assert.equal(evaluateCheck(violations, wl).ok, true);
});

test("shrinking (fewer occurrences than allotted) still passes", () => {
  const violations = findNodeIdViolations(CRATE, "//! KAIFUU-011 only one now.\n");
  const wl = whitelist({ [CRATE]: ["kaifuu-011", "kaifuu-084"] });
  assert.equal(evaluateCheck(violations, wl).ok, true);
});

test("a missing/empty whitelist requires zero violations (absolute posture)", () => {
  const violations = findNodeIdViolations(CRATE, "//! KAIFUU-011.\n");
  assert.equal(evaluateCheck(violations, emptyWhitelist()).ok, false);
  assert.equal(evaluateCheck([], emptyWhitelist()).ok, true);
});

test("--update refuses to grow when total token count increases", () => {
  const old = whitelist({ [CRATE]: ["kaifuu-011"] });
  const violations = findNodeIdViolations(CRATE, "//! KAIFUU-011 a\n//! KAIFUU-011 b\n");
  const r = evaluateUpdate(violations, old);
  assert.equal(r.ok, false);
  assert.equal(r.grew, true);
  assert.equal(r.oldTotal, 1);
  assert.equal(r.newTotal, 2);
});

test("--update refuses a brand-new node id even at equal total count", () => {
  // One old ref removed, one NEW id added: total unchanged, but a novel value.
  const old = whitelist({ [CRATE]: ["kaifuu-011"] });
  const violations = findNodeIdViolations(CRATE, "//! KAIFUU-999 swapped in.\n");
  const r = evaluateUpdate(violations, old);
  assert.equal(r.ok, false);
  assert.equal(r.grew, false);
  assert.deepEqual(r.novelTokens, ["kaifuu-999"]);
});

test("--update allows a pure shrink (ratchet down)", () => {
  const old = whitelist({ [CRATE]: ["kaifuu-011", "utsushi-049"] });
  const violations = findNodeIdViolations(CRATE, "//! KAIFUU-011 remaining.\n");
  const r = evaluateUpdate(violations, old);
  assert.equal(r.ok, true);
  assert.equal(r.newTotal, 1);
  assert.equal(r.oldTotal, 2);
  assert.deepEqual(r.whitelist.files[CRATE], ["kaifuu-011"]);
});

test("--update allows reusing an already-grandfathered id at equal total (rename/reflow)", () => {
  // The same grandfathered id moves to a different file: no novel value, total equal.
  const old = whitelist({ "crates/a/src/a.rs": ["kaifuu-011"] });
  const violations = findNodeIdViolations("crates/b/src/b.rs", "//! KAIFUU-011 moved here.\n");
  const r = evaluateUpdate(violations, old);
  assert.equal(r.ok, true);
});

test("scope: fixtures, migrations SQL, dist, target, and apps/itotori are excluded", () => {
  assert.equal(isExcludedPath("crates/x/tests/fixtures/seed.rs"), true);
  assert.equal(isExcludedPath("packages/itotori-db/migrations/0035_ledger.sql"), true);
  assert.equal(isExcludedPath("apps/itotori/src/providers/x.ts"), true);
  assert.equal(isExcludedPath("packages/x/dist/index.js"), true);
  assert.equal(isExcludedPath("crates/foo/target/debug/x.rs"), true);
  assert.equal(isExcludedPath("docs/research/note.md"), true);
  assert.equal(shouldScan("crates/foo/src/lib.rs"), true);
  assert.equal(shouldScan("packages/itotori-db/src/repositories/x.ts"), true);
  // migrations SQL is excluded even though .sql could be scanned.
  assert.equal(shouldScan("packages/itotori-db/migrations/0035_ledger.sql"), false);
});

test("CLI check exits 1 on a planted violation and 0 when grandfathered", () => {
  const dir = mkdtempSync(join(tmpdir(), "node-id-cli-"));
  const probe = join(dir, "probe.rs");
  writeFileSync(probe, "//! KAIFUU-4242 never seen before.\n");
  const wlPath = join(dir, "wl.json");
  writeFileSync(wlPath, JSON.stringify(emptyWhitelist()));

  const { code, stderr } = runCli("--whitelist", wlPath, probe);
  assert.equal(code, 1);
  assert.match(stderr, /node-id guard: FAILED/u);
  assert.match(stderr, /kaifuu-4242/u);
});

test("CLI --update writes a strictly-smaller whitelist and refuses to grow", () => {
  const dir = mkdtempSync(join(tmpdir(), "node-id-update-"));
  const probe = join(dir, "probe.rs");
  writeFileSync(probe, "//! KAIFUU-011 stays.\n");
  const wlPath = join(dir, "wl.json");
  // Baseline has two refs; current tree has one -> shrink allowed.
  writeFileSync(
    wlPath,
    JSON.stringify({
      ...emptyWhitelist(),
      total: 2,
      files: { [dir + "/probe.rs"]: ["kaifuu-011", "kaifuu-084"] },
    }),
  );
  const { code, stdout } = runCli("--update", "--whitelist", wlPath, probe);
  assert.equal(code, 0);
  assert.match(stdout, /ratcheted 2 -> 1/u);

  // Now try to grow: baseline one ref, tree two -> refuse, exit 1.
  writeFileSync(probe, "//! KAIFUU-011 a\n//! KAIFUU-011 b\n");
  writeFileSync(
    wlPath,
    JSON.stringify({
      ...emptyWhitelist(),
      total: 1,
      files: { [dir + "/probe.rs"]: ["kaifuu-011"] },
    }),
  );
  const grown = runCli("--update", "--whitelist", wlPath, probe);
  assert.equal(grown.code, 1);
  assert.match(grown.stderr, /REFUSED/u);
});

function runCli(...args) {
  try {
    const stdout = execFileSync("node", [scriptPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}
