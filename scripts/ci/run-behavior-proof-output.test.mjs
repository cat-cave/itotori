import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { resolveBehaviorProofOutput, runBehaviorProof } from "./run-behavior-proof.mjs";
import { clearBehaviorRuntimeBuilds } from "./behavior-proof-build.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);

test("behavior proof rejects destructive output targets before execution", async () => {
  const sentinel = resolve(root, "docs", "README.md");
  const original = readFileSync(sentinel);
  for (const output of [
    ".",
    "..",
    ".git",
    "docs",
    "scripts",
    "CONTRIBUTING.md",
    ".tmp/arbitrary",
  ]) {
    await assert.rejects(
      runBehaviorProof({ root, output }),
      /behavior-proof-output-not-allowed/u,
      output,
    );
  }
  assert.deepEqual(readFileSync(sentinel), original);
});

test("behavior proof accepts only a caller-created direct temporary test directory", () => {
  mkdirSync(resolve(root, ".tmp"), { recursive: true });
  const outputRoot = mkdtempSync(resolve(root, ".tmp", "behavior-gate-test-"));
  try {
    const output = relative(root, outputRoot).split("\\").join("/");
    assert.equal(resolveBehaviorProofOutput(root, output), outputRoot);
    assert.throws(
      () => resolveBehaviorProofOutput(root, `${output}/nested`),
      /behavior-proof-output-not-allowed/u,
    );
  } finally {
    rmSync(outputRoot, { force: true, recursive: true });
  }
});

test("behavior proof rejects a symlinked temporary output", async () => {
  mkdirSync(resolve(root, ".tmp"), { recursive: true });
  const link = mkdtempSync(resolve(root, ".tmp", "behavior-gate-test-"));
  const target = mkdtempSync(join(tmpdir(), "behavior-gate-output-target-"));
  const marker = resolve(target, "untouched.txt");
  writeFileSync(marker, "untouched", "utf8");
  rmSync(link, { recursive: true });
  symlinkSync(target, link, "dir");
  try {
    await assert.rejects(
      runBehaviorProof({ root, output: relative(root, link).split("\\").join("/") }),
      /behavior-proof-test-output-type-invalid/u,
    );
    assert.equal(readFileSync(marker, "utf8"), "untouched");
  } finally {
    rmSync(link, { force: true });
    rmSync(target, { force: true, recursive: true });
  }
});

test("behavior runtime cleanup removes only its two scoped dist trees", () => {
  const scratch = mkdtempSync(join(tmpdir(), "behavior-runtime-clean-"));
  try {
    for (const directory of ["localization-bridge-schema", "itotori-db", "unrelated"]) {
      const dist = resolve(scratch, "packages", directory, "dist");
      mkdirSync(dist, { recursive: true });
      writeFileSync(resolve(dist, "stale.js"), "stale", "utf8");
    }
    clearBehaviorRuntimeBuilds(scratch);
    assert.equal(existsSync(resolve(scratch, "packages/localization-bridge-schema/dist")), false);
    assert.equal(existsSync(resolve(scratch, "packages/itotori-db/dist")), false);
    assert.equal(existsSync(resolve(scratch, "packages/unrelated/dist/stale.js")), true);
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
});
