// Regression suite for the 500-line file-cap CI guard.
//
// Proves the grandfather + shrink-only ratchet: a NEW oversized file fails, a
// GROWN grandfathered file fails, a grandfathered file at/below its count
// passes, the whitelist may not gain entries, and --update refuses to grow
// (new entry or increased count) while allowing pure shrinks.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  THRESHOLD,
  buildNextWhitelist,
  countLines,
  emptyWhitelist,
  evaluateCheck,
  evaluateUpdate,
} from "./file-line-cap-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "file-line-cap-guard.mjs");
const BIG = "crates/kaifuu-core/src/lib.rs";

function counts(entries) {
  return new Map(Object.entries(entries));
}

test("countLines matches wc -l (newline count)", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines("a\nb\nc"), 2);
});

test("a NEW oversized file (not whitelisted) fails", () => {
  const wl = { ...emptyWhitelist(), files: {} };
  const { ok, violations } = evaluateCheck(counts({ [BIG]: 600 }), wl);
  assert.equal(ok, false);
  assert.equal(violations[0].kind, "new");
  assert.equal(violations[0].count, 600);
});

test("a GROWN grandfathered file (above its recorded count) fails", () => {
  const wl = { ...emptyWhitelist(), files: { [BIG]: 550 } };
  const { ok, violations } = evaluateCheck(counts({ [BIG]: 575 }), wl);
  assert.equal(ok, false);
  assert.equal(violations[0].kind, "grew");
  assert.equal(violations[0].count, 575);
  assert.equal(violations[0].allowed, 550);
});

test("a grandfathered file at its recorded count passes", () => {
  const wl = { ...emptyWhitelist(), files: { [BIG]: 600 } };
  assert.equal(evaluateCheck(counts({ [BIG]: 600 }), wl).ok, true);
});

test("a grandfathered file that SHRANK (below its count) passes", () => {
  const wl = { ...emptyWhitelist(), files: { [BIG]: 600 } };
  assert.equal(evaluateCheck(counts({ [BIG]: 520 }), wl).ok, true);
});

test("a file at or below the threshold is never a violation", () => {
  const wl = { ...emptyWhitelist(), files: {} };
  assert.equal(evaluateCheck(counts({ "crates/x/src/small.rs": 500 }), wl).ok, true);
  assert.equal(evaluateCheck(counts({ "crates/x/src/small.rs": 499 }), wl).ok, true);
});

test("a missing/empty whitelist makes the cap absolute (no file over threshold)", () => {
  assert.equal(evaluateCheck(counts({ [BIG]: 501 }), emptyWhitelist()).ok, false);
  assert.equal(evaluateCheck(counts({ "crates/x/src/ok.rs": 500 }), emptyWhitelist()).ok, true);
});

test("--update refuses a NEW oversized entry (cannot grandfather growth)", () => {
  const wl = { ...emptyWhitelist(), total: 1, files: { [BIG]: 600 } };
  const cs = counts({ [BIG]: 600, "crates/x/src/new.rs": 700 });
  const r = evaluateUpdate(cs, wl);
  assert.equal(r.ok, false);
  assert.equal(r.newEntries[0].file, "crates/x/src/new.rs");
});

test("--update refuses when a recorded count grew", () => {
  const wl = { ...emptyWhitelist(), total: 1, files: { [BIG]: 600 } };
  const r = evaluateUpdate(counts({ [BIG]: 650 }), wl);
  assert.equal(r.ok, false);
  assert.equal(r.grew[0].count, 650);
  assert.equal(r.grew[0].allowed, 600);
});

test("--update allows a pure shrink (count down)", () => {
  const wl = { ...emptyWhitelist(), total: 1, files: { [BIG]: 600 } };
  const r = evaluateUpdate(counts({ [BIG]: 540 }), wl);
  assert.equal(r.ok, true);
  assert.equal(r.whitelist.files[BIG], 540);
});

test("--update drops a file that fell below the cap (shrink out of the whitelist)", () => {
  const wl = { ...emptyWhitelist(), total: 1, files: { [BIG]: 540 } };
  const r = evaluateUpdate(counts({ [BIG]: 480 }), wl);
  assert.equal(r.ok, true);
  assert.equal(BIG in r.whitelist.files, false);
  assert.equal(r.newTotal, 0);
});

test("buildNextWhitelist only records files strictly over the threshold, sorted", () => {
  const next = buildNextWhitelist(
    counts({ "crates/b/b.rs": 500, "crates/a/a.rs": 700, "crates/c/c.rs": 501 }),
    THRESHOLD,
    "now",
  );
  assert.deepEqual(Object.keys(next.files), ["crates/a/a.rs", "crates/c/c.rs"]);
});

test("CLI check exits 1 on a planted oversized file, 0 when grandfathered", () => {
  const dir = mkdtempSync(join(tmpdir(), "linecap-cli-"));
  const probe = join(dir, "big.rs");
  writeFileSync(probe, `${"x\n".repeat(600)}`);
  const wlPath = join(dir, "wl.json");
  writeFileSync(wlPath, JSON.stringify(emptyWhitelist()));

  const fail = runCli("--whitelist", wlPath, probe);
  assert.equal(fail.code, 1);
  assert.match(fail.stderr, /file-line-cap guard: FAILED/u);
  assert.match(fail.stderr, /NEW/u);

  // Grandfather it at exactly its count -> passes.
  writeFileSync(wlPath, JSON.stringify({ ...emptyWhitelist(), total: 1, files: { [probe]: 600 } }));
  const pass = runCli("--whitelist", wlPath, probe);
  assert.equal(pass.code, 0);
  assert.match(pass.stdout, /passed/u);
});

test("CLI --update refuses to grow but allows a shrink", () => {
  const dir = mkdtempSync(join(tmpdir(), "linecap-update-"));
  const probe = join(dir, "big.rs");

  // Shrink: baseline 600, current 540 -> allowed.
  writeFileSync(probe, `${"x\n".repeat(540)}`);
  const wlPath = join(dir, "wl.json");
  writeFileSync(wlPath, JSON.stringify({ ...emptyWhitelist(), total: 1, files: { [probe]: 600 } }));
  const shrink = runCli("--update", "--whitelist", wlPath, probe);
  assert.equal(shrink.code, 0);
  assert.match(shrink.stdout, /ratcheted 1 -> 1/u);

  // Grow: baseline 540 (just written), current 650 -> refused.
  writeFileSync(probe, `${"x\n".repeat(650)}`);
  const grown = runCli("--update", "--whitelist", wlPath, probe);
  assert.equal(grown.code, 1);
  assert.match(grown.stderr, /REFUSED/u);
  assert.match(grown.stderr, /GREW/u);
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
