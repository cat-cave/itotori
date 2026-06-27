import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  isEnvPath,
  listTrackedFiles,
  renderReport,
  scanFiles,
} from "./validate-no-specific-game-references.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scannerPath = resolve(here, "validate-no-specific-game-references.mjs");
const fakeForbiddenTokens = [
  {
    id: "fixture-title",
    label: "fixture title",
    tokens: ["Moonlit Fixture", "moonlit-fixture", "MOONLIT_FIXTURE_PATH"],
  },
  {
    id: "fixture-vendor",
    label: "fixture vendor",
    tokens: ["Example Vendor"],
  },
];

test("scans git-tracked file contents for configured fake tokens", () => {
  withTempGitRepo((repo) => {
    writeRepoFile(repo, "src/config.ts", 'const value = "Moonlit Fixture";\n');
    git(repo, ["add", "src/config.ts"]);

    const result = scanRepo(repo);

    assert.deepEqual(
      result.violations.map((violation) => ({
        path: violation.path,
        location: violation.location,
        line: violation.line,
        token: violation.token,
      })),
      [{ path: "src/config.ts", location: "content", line: 1, token: "Moonlit Fixture" }],
    );
  });
});

test("scans git-tracked path names before reading regular contents", () => {
  withTempGitRepo((repo) => {
    writeRepoFile(repo, "src/moonlit-fixture.ts", "const ok = true;\n");
    git(repo, ["add", "src/moonlit-fixture.ts"]);

    const result = scanRepo(repo);

    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].path, "src/moonlit-fixture.ts");
    assert.equal(result.violations[0].location, "filename");
  });
});

test("honors explicit allowlist entries without broadening to neighbors", () => {
  withTempGitRepo((repo) => {
    writeRepoFile(repo, "plans/record.md", "Moonlit Fixture stays in planning.\n");
    writeRepoFile(repo, "plans-neighbor/record.md", "Moonlit Fixture is active content.\n");
    git(repo, ["add", "plans/record.md", "plans-neighbor/record.md"]);

    const result = scanRepo(repo, [{ path: "plans/", reason: "planning records" }]);

    assert.equal(result.skippedAllowlistedFileCount, 1);
    assert.deepEqual(
      result.violations.map((violation) => violation.path),
      ["plans-neighbor/record.md"],
    );
  });
});

test("skips env files before path or content matching and does not read them", () => {
  withTempGitRepo((repo) => {
    writeRepoFile(repo, ".env.moonlit-fixture", "MOONLIT_FIXTURE_PATH=/secret\n");
    writeRepoFile(repo, "nested/.env.local", "Moonlit Fixture\n");
    writeRepoFile(repo, "src/app.ts", "const ok = true;\n");
    git(repo, ["add", ".env.moonlit-fixture", "nested/.env.local", "src/app.ts"]);

    const filesRead = [];
    const result = scanFiles({
      root: repo,
      files: listTrackedFiles(repo),
      forbiddenTokens: fakeForbiddenTokens,
      allowlist: [],
      readFile: (path) => {
        filesRead.push(path);
        return readFileSync(join(repo, path), "utf8");
      },
    });

    assert.equal(result.skippedEnvFileCount, 2);
    assert.deepEqual(filesRead, ["src/app.ts"]);
    assert.deepEqual(result.violations, []);
  });
});

test("report mode exits zero while printing grouped violations", () => {
  withTempGitRepo((repo) => {
    writeRepoFile(repo, "src/moonlit-fixture.ts", "const vendor = 'Example Vendor';\n");
    git(repo, ["add", "src/moonlit-fixture.ts"]);

    const result = spawnSync(
      process.execPath,
      [
        scannerPath,
        "--root",
        repo,
        "--mode",
        "report",
        "--token",
        "moonlit-fixture",
        "--token",
        "Example Vendor",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /specific-game-reference advisory: 2 violations found/u);
    assert.match(result.stdout, /src\/moonlit-fixture\.ts\n  - filename: configured token/u);
    assert.match(result.stdout, /line 1: configured token/u);
  });
});

test("isEnvPath matches nested env filenames", () => {
  assert.equal(isEnvPath(".env"), true);
  assert.equal(isEnvPath(".env.test"), true);
  assert.equal(isEnvPath("config/.env.local"), true);
  assert.equal(isEnvPath("src/env.ts"), false);
});

test("renderReport prints no-violation summaries", () => {
  const report = renderReport({
    violations: [],
    scannedFileCount: 2,
    skippedAllowlistedFileCount: 1,
    skippedEnvFileCount: 1,
  });

  assert.match(report, /specific-game-reference advisory: 0 violations found/u);
  assert.match(report, /no forbidden title\/vendor references found/u);
});

function scanRepo(repo, allowlist = []) {
  return scanFiles({
    root: repo,
    files: listTrackedFiles(repo),
    forbiddenTokens: fakeForbiddenTokens,
    allowlist,
  });
}

function withTempGitRepo(callback) {
  const repo = mkdtempSync(join(tmpdir(), "title-reference-guardrail-"));
  try {
    git(repo, ["init"]);
    callback(repo);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
}

function writeRepoFile(repo, path, contents) {
  const target = join(repo, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function git(repo, args) {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}
