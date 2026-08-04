// @itotori-meta-check
// Regression suite for the absolute corpus-identity guard.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { findGameNameViolations, isExcludedPath, shouldScan } from "./audit-no-game-names.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "audit-no-game-names.mjs");
const DOC = "docs/probe.md";

test("rejects a newly shaped corpus title without a vocabulary edit", () => {
  const found = findGameNameViolations(DOC, "The corpus is comet-signal.v70991.\n");
  assert.deepEqual(
    found.map((entry) => entry.token),
    ["comet-signal.v70991"],
  );
});

test("rejects title-shaped test names and encoded Shift-JIS title literals", () => {
  const found = findGameNameViolations(
    "crates/example/tests/probe.rs",
    "fn v70991_comet_signal_story_detects_engine() {}\nconst title: &[u8] = &[0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x54, 0x45, 0x53, 0x54];\n",
  );
  assert.deepEqual(
    found.map((entry) => entry.token),
    ["v70991_comet_signal_story_detects_engine", "shift-jis-title-literal"],
  );
});

test("scans docs and tests while exempting only the guard pair", () => {
  assert.equal(shouldScan("docs/probe.md"), true);
  assert.equal(shouldScan("crates/example/tests/probe.rs"), true);
  assert.equal(isExcludedPath("scripts/audit-no-game-names.mjs"), true);
  assert.equal(isExcludedPath("scripts/audit-no-game-names.test.mjs"), true);
});

test("CLI reports file and line for a planted title-shaped identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "game-name-cli-"));
  const probe = join(dir, "probe.md");
  writeFileSync(probe, "corpus: comet-signal.v70991\n");
  const failed = runCli(probe);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /probe\.md:1/u);
  assert.match(failed.stderr, /comet-signal\.v70991/u);

  writeFileSync(probe, "corpus: softpal/1/default\n");
  const clean = runCli(probe);
  assert.equal(clean.code, 0);
  assert.match(clean.stdout, /0 enforced references/u);
});

function runCli(...args) {
  try {
    return {
      code: 0,
      stdout: execFileSync("node", [scriptPath, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}
