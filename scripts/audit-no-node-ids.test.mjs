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
const nodeId = (prefix, number) => `${prefix}-${number}`;
const proseNodeRef = (...words) => words.join(" ");
const nodeSlug = (...parts) => parts.join("-");

test("extracts one token per node-id reference, including multiple per line", () => {
  const violations = findNodeIdViolations(
    CRATE,
    `//! ${nodeId("KAIFUU", 11)} smoke; see ${nodeId("UTSUSHI", 49)} for the patch path.\n`,
  );
  assert.deepEqual(violations.map((item) => item.token).sort(), [
    nodeId("kaifuu", 11),
    nodeId("utsushi", 49),
  ]);
});

test("catches every id family plus the prose and slug forms", () => {
  const lines = [
    `/// ${nodeId("RB", 1)} / ${nodeId("ITOTORI", 2)} / ${nodeId("KAIFUU", 3)} / ${nodeId("UTSUSHI", 4)} all match.`,
    `/// Owned by ${nodeSlug("p0", "core", "atomic", "cost", "reservation")}.`,
    `/// This is a ${proseNodeRef("follow-up", "node")}.`,
    `/// ${proseNodeRef("deferred", "for", "node")}; ${proseNodeRef("see", "node")} later.`,
    `TODO(${nodeId("KAIFUU", 5)}): drop once cleaned.`,
  ].join("\n");
  assert.deepEqual(
    findNodeIdViolations(CRATE, lines)
      .map((item) => item.token)
      .sort(),
    [
      proseNodeRef("deferred", "for", "node"),
      proseNodeRef("follow-up", "node"),
      nodeId("itotori", 2),
      nodeId("kaifuu", 3),
      nodeId("kaifuu", 5),
      nodeSlug("p0", "core", "atomic", "cost", "reservation"),
      nodeId("rb", 1),
      proseNodeRef("see", "node"),
      nodeId("utsushi", 4),
    ],
  );
});

test("catches node ids embedded in snake_case, camelCase, and digit identifiers", () => {
  const violations = findNodeIdViolations(
    CRATE,
    `const task_${nodeId("KAIFUU", 42)}_suffix = 1;\nconst task${nodeId("Kaifuu", 43)}Suffix = 1;\nconst task2${nodeId("KAIFUU", 44)}suffix = 1;\n`,
  );
  assert.deepEqual(
    violations.map((item) => item.token),
    [nodeId("kaifuu", 42), nodeId("kaifuu", 43), nodeId("kaifuu", 44)],
  );
});

test("scope excludes only generated ledger and immutable migration paths", () => {
  assert.equal(isExcludedPath("crates/x/tests/fixtures/seed.rs"), false);
  assert.equal(isExcludedPath("packages/itotori-db/migrations/0035_ledger.sql"), true);
  assert.equal(isExcludedPath("roadmap/spec-dag.json"), true);
  assert.equal(isExcludedPath("apps/itotori/src/llm/dispatch.ts"), false);
  assert.equal(isExcludedPath("docs/research/note.md"), false);
  assert.equal(shouldScan("crates/foo/src/lib.rs"), true);
  assert.equal(shouldScan(".github/workflows/check.yml"), true);
  assert.equal(shouldScan("docs/research/note.md"), true);
  assert.equal(shouldScan("packages/itotori-db/src/repositories/x.ts"), true);
  assert.equal(shouldScan("packages/itotori-db/migrations/0035_ledger.sql"), false);
});

test("scans a NUL-containing tracked-artifact payload", () => {
  const violations = findNodeIdViolations(
    "fixtures/opaque-payload.bin",
    `prefix\0${nodeId("RB", 99)}\n`,
  );
  assert.deepEqual(
    violations.map((item) => item.token),
    [nodeId("rb", 99)],
  );
});

test("CLI rejects every planted violation without a whitelist escape hatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "node-id-cli-"));
  const probe = join(dir, "probe.rs");
  writeFileSync(probe, `//! ${nodeId("KAIFUU", 4242)} never seen before.\n`);

  const failed = runCli(probe);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /node-id guard: FAILED/u);
  assert.match(failed.stderr, new RegExp(nodeId("kaifuu", 4242), "u"));

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
