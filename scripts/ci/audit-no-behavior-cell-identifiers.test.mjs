// @itotori-meta-check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { behaviorCells } from "./behavior-cell-registry.mjs";
import {
  findBehaviorCellIdentifierViolations,
  registeredCellIdentifiers,
  SHARED_BEHAVIOR_HARNESS_FILES,
} from "./audit-no-behavior-cell-identifiers.mjs";
import { discoverMetaChecks } from "../meta-check-manifest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "audit-no-behavior-cell-identifiers.mjs");

test("derives behavior and cell identifiers from registry entries", () => {
  const entries = [
    { behavior: "domain.synthetic-behavior", cell: "cell::domain.synthetic-behavior::all" },
  ];
  assert.deepEqual(registeredCellIdentifiers(entries), [
    "cell::domain.synthetic-behavior::all",
    "domain.synthetic-behavior",
  ]);
});

test("finds a registered identifier in a prohibited shared harness", () => {
  const identifiers = ["cell::domain.synthetic-behavior::all", "domain.synthetic-behavior"];
  const found = findBehaviorCellIdentifierViolations(
    SHARED_BEHAVIOR_HARNESS_FILES[2],
    "const behavior = 'domain.synthetic-behavior';\n",
    identifiers,
  );
  assert.deepEqual(
    found.map((entry) => [entry.file, entry.line, entry.token]),
    [["suite/behavior/support/world.ts", 1, "domain.synthetic-behavior"]],
  );
});

test("CLI fails when a registered behavior or cell returns to a shared harness", () => {
  const entry = behaviorCells[0];
  for (const [index, file] of SHARED_BEHAVIOR_HARNESS_FILES.entries()) {
    const identifier = index % 2 === 0 ? entry.behavior : entry.cell;
    const root = createIdentifierFreeSharedHarnessRoot();
    writeFileSync(join(root, file), `const named = "${identifier}";\n`);

    const failed = runCli("--root", root);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /behavior-cell identifier guard: FAILED/u);
    assert.match(failed.stderr, new RegExp(escapeRegex(identifier), "u"));
  }
});

test("CLI passes when all shared discovery and harness files are identifier-free", () => {
  const passed = runCli("--root", createIdentifierFreeSharedHarnessRoot());
  assert.equal(passed.code, 0, passed.stderr);
  assert.match(passed.stdout, /0 references/u);
});

test("runs as a Tier-0 metadata guard", () => {
  const checks = discoverMetaChecks(join(here, "..", ".."));
  const testEntry = checks.find(
    ({ owner }) => owner === "scripts/ci/audit-no-behavior-cell-identifiers.test.mjs",
  );
  const guardEntry = checks.find(
    ({ owner }) => owner === "scripts/ci/audit-no-behavior-cell-identifiers.mjs",
  );
  assert.deepEqual(testEntry?.args, [
    "--test",
    "scripts/ci/audit-no-behavior-cell-identifiers.test.mjs",
  ]);
  assert.deepEqual(guardEntry?.args, ["scripts/ci/audit-no-behavior-cell-identifiers.mjs"]);
  assert.ok(checks.indexOf(testEntry) < checks.indexOf(guardEntry));
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function createIdentifierFreeSharedHarnessRoot() {
  const root = mkdtempSync(join(tmpdir(), "behavior-cell-identifier-guard-"));
  for (const file of SHARED_BEHAVIOR_HARNESS_FILES) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "export {};\n");
  }
  return root;
}

function runCli(...args) {
  try {
    return {
      code: 0,
      stdout: execFileSync(process.execPath, [scriptPath, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}
