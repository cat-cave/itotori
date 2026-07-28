// Regression suite for immutable CI inputs and centralized toolchain setup.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { findCiInputViolations } from "./audit-ci-input-pins.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "audit-ci-input-pins.mjs");
const sha = "0123456789abcdef0123456789abcdef01234567";

test("rejects every symbolic third-party uses reference", () => {
  const violations = findCiInputViolations(
    ".github/workflows/probe.yml",
    "- uses: acme/action@v9\n",
  );
  assert.deepEqual(
    violations.map((item) => item.kind),
    ["mutable-action"],
  );
});

test("requires a reviewed version comment after an immutable action SHA", () => {
  const violations = findCiInputViolations(
    ".github/workflows/probe.yml",
    `- uses: acme/action@${sha}\n`,
  );
  assert.deepEqual(
    violations.map((item) => item.kind),
    ["missing-version-comment"],
  );
});

test("allows local actions and reviewed immutable third-party actions", () => {
  const workflow = [
    "- uses: ./.github/actions/setup-itotori",
    `- uses: acme/action@${sha} # v9.4.1`,
  ].join("\n");
  assert.deepEqual(findCiInputViolations(".github/workflows/probe.yml", workflow), []);
});

test("rejects every workflow-local toolchain installer", () => {
  const workflow = [
    "- run: sudo snap install just --classic",
    "- run: cargo install just",
    "- run: brew install just",
    "- run: apt-get install just",
    "- run: pipx install just",
    "- run: npm install -g just",
    "- run: nix develop --command just check",
  ].join("\n");
  const kinds = findCiInputViolations(".github/workflows/probe.yml", workflow).map(
    (item) => item.kind,
  );
  assert.deepEqual(kinds, Array(7).fill("ad-hoc-install"));
});

test("keeps just installation in setup-itotori at the pinned version", () => {
  const canonical = "tool: just@1.56.0,cargo-deny@0.20.2,nextest@0.9.140\n";
  assert.deepEqual(
    findCiInputViolations(".github/actions/setup-itotori/action.yml", canonical),
    [],
  );
  const duplicate = findCiInputViolations(".github/workflows/probe.yml", canonical);
  assert.equal(duplicate[0].kind, "duplicate-just-installer");
});

test("CLI fails on a reintroduced tag and installer, then passes once restored", () => {
  const directory = mkdtempSync(join(tmpdir(), "ci-input-pins-"));
  const probe = join(directory, "workflow.yml");
  writeFileSync(probe, "- uses: acme/action@v9\n- run: sudo snap install just --classic\n");

  const failed = runCli(probe);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /ci-input-pins guard: FAILED/u);
  assert.match(failed.stderr, /mutable-action/u);
  assert.match(failed.stderr, /ad-hoc-install/u);

  writeFileSync(probe, `- uses: acme/action@${sha} # v9.4.1\n`);
  const passed = runCli(probe);
  assert.equal(passed.code, 0);
  assert.match(passed.stdout, /1 workflow\/action YAML file/u);
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
