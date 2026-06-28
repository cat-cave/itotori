import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  listTrackedIgnoredFiles,
  renderReport,
  scanTrackedIgnoredArtifacts,
} from "./validate-tracked-artifact-hygiene.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scannerPath = resolve(here, "validate-tracked-artifact-hygiene.mjs");

test("fails on tracked ignored live provider artifacts even when gitignore hides artifacts", () => {
  withTempGitRepo((repo) => {
    writeRepoFile(
      repo,
      "artifacts/openrouter-live-smoke/2026-06-25.json",
      JSON.stringify({
        provider: "OpenRouter",
        request: { model: "deepseek/deepseek-v4-flash" },
        response: { id: "gen-fixture" },
      }),
    );
    git(repo, ["add", "-f", "artifacts/openrouter-live-smoke/2026-06-25.json"]);

    const result = scanTrackedIgnoredArtifacts({
      root: repo,
      files: listTrackedIgnoredFiles(repo),
    });

    assert.deepEqual(
      result.violations.map((violation) => violation.path),
      ["artifacts/openrouter-live-smoke/2026-06-25.json"],
    );
    assert.match(result.violations[0].reasons.join("\n"), /live\/provider/u);
  });
});

test("documents and honors the committed ignored artifact allowlist", () => {
  withTempGitRepo((repo) => {
    writeRepoFile(repo, "artifacts/catalog/resolver-integration.json", '{"fixture":true}\n');
    git(repo, ["add", "-f", "artifacts/catalog/resolver-integration.json"]);

    const result = scanTrackedIgnoredArtifacts({
      root: repo,
      files: listTrackedIgnoredFiles(repo),
    });
    const report = renderReport(result);

    assert.deepEqual(result.violations, []);
    assert.match(report, /committed ignored artifact allowlist/u);
    assert.match(report, /static resolver integration fixture/u);
  });
});

test("skips env paths before reading tracked ignored files", () => {
  const filesRead = [];
  const result = scanTrackedIgnoredArtifacts({
    root: "/unused",
    files: [".env.local", "nested/.env.provider", "artifacts/openrouter-live-smoke/capture.json"],
    allowlist: [],
    readFile: (path) => {
      filesRead.push(path);
      return "OpenRouter";
    },
  });

  assert.equal(result.skippedEnvFileCount, 2);
  assert.deepEqual(filesRead, ["artifacts/openrouter-live-smoke/capture.json"]);
  assert.equal(result.violations.length, 1);
});

test("check mode exits non-zero for unallowlisted tracked ignored artifacts", () => {
  withTempGitRepo((repo) => {
    writeRepoFile(repo, "artifacts/provider-runs/run-1/provider-run.json", "OpenRouter\n");
    git(repo, ["add", "-f", "artifacts/provider-runs/run-1/provider-run.json"]);

    const result = spawnSync(process.execPath, [scannerPath, "--root", repo, "--mode", "check"], {
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /tracked ignored artifact hygiene: 1 violation found/u);
  });
});

function withTempGitRepo(callback) {
  const repo = mkdtempSync(join(tmpdir(), "tracked-artifact-hygiene-"));
  try {
    git(repo, ["init"]);
    writeRepoFile(repo, ".gitignore", "artifacts/\n.env\n.env.*\n");
    git(repo, ["add", ".gitignore"]);
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
