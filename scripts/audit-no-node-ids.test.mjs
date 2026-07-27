// Regression suite for the absolute no-node-id CI guard.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { findNodeIdViolations, isExcludedPath, shouldScan } from "./audit-no-node-ids.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "audit-no-node-ids.mjs");
const CRATE = "crates/kaifuu-core/src/lib.rs";

test("extracts one token per node-id reference, including multiple per line", () => {
  const violations = findNodeIdViolations(
    CRATE,
    "//! KAIFUU-011 smoke; see UTSUSHI-049 for the patch path.\n",
  );
  assert.deepEqual(violations.map((item) => item.token).sort(), ["kaifuu-011", "utsushi-049"]);
});

test("catches every id family plus the prose and slug forms", () => {
  const lines = [
    "/// RB-1 / ITOTORI-2 / KAIFUU-3 / UTSUSHI-4 all match.",
    "/// Owned by p0-core-atomic-cost-reservation.",
    "/// This is a follow-up node.",
    "/// Deferred for node; see node later.",
    "TODO(KAIFUU-5): drop once cleaned.",
  ].join("\n");
  assert.deepEqual(
    findNodeIdViolations(CRATE, lines)
      .map((item) => item.token)
      .sort(),
    [
      "deferred for node",
      "follow-up node",
      "itotori-2",
      "kaifuu-3",
      "kaifuu-5",
      "p0-core-atomic-cost-reservation",
      "rb-1",
      "see node",
      "utsushi-4",
    ],
  );
});

test("scope excludes immutable, fixture, and prose paths", () => {
  assert.equal(isExcludedPath("crates/x/tests/fixtures/seed.rs"), true);
  assert.equal(isExcludedPath("packages/itotori-db/migrations/0035_ledger.sql"), true);
  assert.equal(isExcludedPath("apps/itotori/src/llm/dispatch.ts"), true);
  assert.equal(isExcludedPath("packages/x/dist/index.js"), true);
  assert.equal(isExcludedPath("crates/foo/target/debug/x.rs"), true);
  assert.equal(isExcludedPath("docs/research/note.md"), true);
  assert.equal(shouldScan("crates/foo/src/lib.rs"), true);
  assert.equal(shouldScan("packages/itotori-db/src/repositories/x.ts"), true);
  assert.equal(shouldScan("packages/itotori-db/migrations/0035_ledger.sql"), false);
});

test("CLI rejects every planted violation without a whitelist escape hatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "node-id-cli-"));
  const probe = join(dir, "probe.rs");
  writeFileSync(probe, "//! KAIFUU-4242 never seen before.\n");

  const failed = runCli(probe);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /node-id guard: FAILED/u);
  assert.match(failed.stderr, /kaifuu-4242/u);

  writeFileSync(probe, "//! Behavior-only explanation.\n");
  const passed = runCli(probe);
  assert.equal(passed.code, 0);
  assert.match(passed.stdout, /0 references/u);
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
