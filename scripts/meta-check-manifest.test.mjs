// @itotori-meta-check
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { META_CHECK_SCHEMA, discoverMetaChecks, runMetaChecks } from "./meta-check-manifest.mjs";

function declaration(kind) {
  return `${JSON.stringify({ schema: META_CHECK_SCHEMA, kind })}\n`;
}

function writeMarkedSource(root, file, source = "// @itotori-meta-check\n") {
  const target = join(root, file);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, source);
  return target;
}

test("meta checks derive commands from adjacent marked sources", () => {
  const root = mkdtempSync(join(tmpdir(), "itotori-meta-checks-"));
  try {
    writeMarkedSource(root, "scripts/example.test.mjs");
    writeFileSync(join(root, "scripts/example.test.mjs.meta-check.json"), declaration("node-test"));
    writeMarkedSource(root, "scripts/example.mjs");
    writeFileSync(join(root, "scripts/example.mjs.meta-check.json"), declaration("node-script"));

    assert.deepEqual(
      discoverMetaChecks(root).map(({ command, args }) => [command, args]),
      [
        ["node", ["--test", "scripts/example.test.mjs"]],
        ["node", ["scripts/example.mjs"]],
      ],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a marked meta source without its adjacent declaration fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "itotori-meta-check-missing-"));
  try {
    writeMarkedSource(root, "scripts/missing.test.mjs");
    assert.throws(
      () => discoverMetaChecks(root),
      /meta check source has no adjacent declaration: scripts\/missing\.test\.mjs/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a declaration without its adjacent source marker fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "itotori-meta-check-orphan-"));
  try {
    writeMarkedSource(root, "scripts/orphan.test.mjs", 'test("ordinary", () => {});\n');
    writeFileSync(join(root, "scripts/orphan.test.mjs.meta-check.json"), declaration("node-test"));
    assert.throws(
      () => discoverMetaChecks(root),
      /meta check declaration has no matching source marker: scripts\/orphan\.test\.mjs/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("package Vitest commands derive their package name and test path from the owner", () => {
  const root = mkdtempSync(join(tmpdir(), "itotori-meta-check-package-"));
  try {
    mkdirSync(join(root, "packages/example"), { recursive: true });
    writeFileSync(join(root, "packages/example/package.json"), '{"name":"@itotori/example"}\n');
    writeMarkedSource(root, "packages/example/test/example.test.ts");
    writeFileSync(
      join(root, "packages/example/test/example.test.ts.meta-check.json"),
      declaration("package-vitest"),
    );
    assert.deepEqual(discoverMetaChecks(root)[0]?.args, [
      "--filter",
      "@itotori/example",
      "exec",
      "vitest",
      "run",
      "test/example.test.ts",
      "--exclude",
      "**/.direnv/**",
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the runner preserves discovered command order and stops on a failure", () => {
  const root = mkdtempSync(join(tmpdir(), "itotori-meta-check-runner-"));
  try {
    writeMarkedSource(root, "scripts/example.test.mjs");
    writeFileSync(join(root, "scripts/example.test.mjs.meta-check.json"), declaration("node-test"));
    const calls = [];
    const checks = runMetaChecks(root, (command, args) => {
      calls.push([command, args]);
      return { status: 0 };
    });
    assert.equal(checks.length, 1);
    assert.deepEqual(calls, [["node", ["--test", "scripts/example.test.mjs"]]]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
