import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

const root = join(import.meta.dirname, "..");
const expected = ["check", "ci", "dev", "doctor", "test", "worktree-setup"];
const removed = [
  "affected",
  "alpha-proof",
  "alpha-readiness-checklist",
  "audit-findings-seed",
  "browser-e2e",
  "build",
  "catalog-replay-db-strict",
  "ci-itotori",
  "ci-kaifuu",
  "ci-real-bytes",
  "ci-real-bytes-private-proof",
  "ci-tier0",
  "ci-tier0-manifest",
  "ci-tier0-meta",
  "ci-tier0-rust",
  "ci-tier0-ts",
  "ci-tier1",
  "ci-tier1-browser",
  "ci-tier1-db",
  "ci-tier1-mutation",
  "ci-tier1-rust-1of3",
  "ci-tier1-rust-2of3",
  "ci-tier1-rust-3of3",
  "ci-tier1-ts-public-1of2",
  "ci-tier1-ts-public-2of2",
  "ci-utsushi",
  "contract-validate",
  "contract-validate-rust",
  "contract-validate-ts",
  "dashboard",
  "db-cli-build",
  "db-down",
  "db-migrate",
  "db-reset",
  "db-up",
  "db-wait",
  "dlsite-demand-app-test",
  "fixtures-validate",
  "hello-replay",
  "hello-replay-validate",
  "impl-map-schema-validate",
  "install",
  "itotori-package-build",
  "itotori-package-pack",
  "itotori-scale-build",
  "itotori-scale-large",
  "itotori-scale-smoke",
  "mutation-differential",
  "mutation-property-test",
  "periodic-strict",
  "permission-denial-db-strict",
  "provision-native-deps",
  "qd-export",
  "qd-full-ci",
  "qd-import",
  "real-bytes",
  "real-bytes-oracle",
  "real-bytes-oracle-drift",
  "rgt-readiness-checklist",
  "roadmap-dashboard",
  "roadmap-dashboard-watch",
  "roadmap-validate",
  "schema",
  "test-db-strict",
  "test-ratio",
  "upgrade",
];

function capturedDelegateShell(delegate, selector) {
  const tempRoot = mkdtempSync(join(tmpdir(), "itotori-justfile-surface-"));
  const capturePath = join(tempRoot, "shell-script");
  const bashPath = join(tempRoot, "bash");
  writeFileSync(
    bashPath,
    `#!/bin/sh\nprintf "%s" "$5" > '${capturePath.replaceAll("'", "'\"'\"")}'\n`,
  );
  chmodSync(bashPath, 0o755);

  try {
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts/developer-command.mjs"), delegate, selector],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${tempRoot}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(capturePath, "utf8");
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

test("justfile keeps exactly the six approved delegates", () => {
  const names = execFileSync("just", ["--summary"], { cwd: root, encoding: "utf8" })
    .trim()
    .split(/\s+/u)
    .sort();
  assert.deepEqual(names, expected);
  assert.equal(readFileSync(join(root, "justfile"), "utf8").split("\n").length - 1, 22);
});

test("removed recipe names are rejected by just", () => {
  for (const recipe of removed) {
    const result = spawnSync("just", [recipe], { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0, `${recipe} unexpectedly returned as a recipe`);
    assert.match(result.stderr, /does not contain recipe/u);
  }
});

test("public CI and all-test delegates retain their complete execution paths", () => {
  const ciScript = capturedDelegateShell("ci", "public");
  for (const command of [
    "node scripts/developer-command.mjs check all",
    "node scripts/developer-command.mjs dev build",
    "node scripts/developer-command.mjs dev db-migrate",
    "node scripts/developer-command.mjs test all",
    "node scripts/developer-command.mjs test mutation-differential",
  ]) {
    assert.match(ciScript, new RegExp(`^${command}$`, "mu"));
  }

  const testScript = capturedDelegateShell("test", "all");
  assert.match(testScript, /^pnpm exec vp run ts:test$/mu);
  assert.match(testScript, /^cargo test --workspace$/mu);
});
