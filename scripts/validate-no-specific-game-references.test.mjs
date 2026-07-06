import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  classifySurface,
  isEnvPath,
  listTrackedFiles,
  renderReport,
  scanFiles,
  stripComments,
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

// Fake classified allowlist: one historical/research surface category. Every
// other path is an active product/operator surface.
const fakeSurfaces = [
  { id: "records", kind: "prefix", value: "records/", reason: "planning records" },
];

// ---------------------------------------------------------------------------
// Required acceptance: forbidden active-surface reference fails the gate.
// ---------------------------------------------------------------------------
test("a title reference in code on an active product surface is a forbidden leak", () => {
  withTempGitRepo((repo) => {
    writeRepoFile(repo, "src/config.ts", 'const target = "moonlit-fixture";\n');
    git(repo, ["add", "src/config.ts"]);

    const result = scanRepo(repo);

    assert.equal(result.historical.length, 0);
    assert.deepEqual(
      result.active.map((violation) => ({
        path: violation.path,
        line: violation.line,
        token: violation.token,
        classification: violation.classification,
      })),
      [
        {
          path: "src/config.ts",
          line: 1,
          token: "moonlit-fixture",
          classification: "active-surface",
        },
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// Required acceptance: allowed historical reference passes the gate.
// ---------------------------------------------------------------------------
test("a title reference on a classified historical/research surface is allowed", () => {
  withTempGitRepo((repo) => {
    writeRepoFile(repo, "records/note.md", "Decoded from Moonlit Fixture bytes.\n");
    git(repo, ["add", "records/note.md"]);

    const result = scanRepo(repo);

    assert.equal(result.active.length, 0);
    assert.equal(result.historical.length, 1);
    assert.equal(result.historical[0].classification, "historical-surface");
    assert.equal(result.historical[0].reason, "planning records");
  });
});

test("a title reference inside a comment on an active surface is allowed historical memory", () => {
  withTempGitRepo((repo) => {
    writeRepoFile(
      repo,
      "src/decode.ts",
      "// validated against Moonlit Fixture scene 1\nconst ok = true;\n",
    );
    // block comment spanning lines, plus a real code leak below it
    writeRepoFile(
      repo,
      "src/block.rs",
      '/*\n Moonlit Fixture doc\n*/\nlet id = "moonlit-fixture";\n',
    );
    git(repo, ["add", "src/decode.ts", "src/block.rs"]);

    const result = scanRepo(repo);

    // The comment references are historical; only the real code string leaks.
    assert.deepEqual(
      result.active.map((v) => ({ path: v.path, line: v.line, token: v.token })),
      [{ path: "src/block.rs", line: 4, token: "moonlit-fixture" }],
    );
    assert.deepEqual(result.historical.map((v) => v.classification).sort(), [
      "historical-comment",
      "historical-comment",
    ]);
  });
});

test("a title-bearing filename on an active surface is a forbidden leak, but allowed on a historical surface", () => {
  withTempGitRepo((repo) => {
    writeRepoFile(repo, "src/moonlit-fixture.ts", "const ok = true;\n");
    writeRepoFile(repo, "records/moonlit-fixture.md", "planning\n");
    git(repo, ["add", "src/moonlit-fixture.ts", "records/moonlit-fixture.md"]);

    const result = scanRepo(repo);

    assert.deepEqual(
      result.active.map((v) => ({ path: v.path, location: v.location })),
      [{ path: "src/moonlit-fixture.ts", location: "filename" }],
    );
    assert.deepEqual(
      result.historical.map((v) => v.path),
      ["records/moonlit-fixture.md"],
    );
  });
});

test("surface classification does not broaden to neighbouring paths", () => {
  withTempGitRepo((repo) => {
    writeRepoFile(repo, "records/record.md", "Moonlit Fixture in planning.\n");
    writeRepoFile(repo, "records-neighbour/record.md", "Moonlit Fixture is active content.\n");
    git(repo, ["add", "records/record.md", "records-neighbour/record.md"]);

    const result = scanRepo(repo);

    assert.deepEqual(
      result.historical.map((v) => v.path),
      ["records/record.md"],
    );
    assert.deepEqual(
      result.active.map((v) => v.path),
      ["records-neighbour/record.md"],
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
      surfaces: fakeSurfaces,
      readFile: (path) => {
        filesRead.push(path);
        return readFileSync(join(repo, path), "utf8");
      },
    });

    assert.equal(result.skippedEnvFileCount, 2);
    assert.deepEqual(filesRead, ["src/app.ts"]);
    assert.deepEqual(result.active, []);
    assert.deepEqual(result.historical, []);
  });
});

// ---------------------------------------------------------------------------
// Enforceable vs advisory modes via the real default surfaces.
// ---------------------------------------------------------------------------
test("check mode exits 1 on an active-surface leak and 0 on a classified historical reference", () => {
  withTempGitRepo((repo) => {
    // roadmap/ is a real default historical/research surface; src/ is active.
    writeRepoFile(repo, "roadmap/record.md", "moonlit-fixture stays in planning.\n");
    git(repo, ["add", "roadmap/record.md"]);
    const historicalRun = runScanner(repo, ["--mode", "check", "--token", "moonlit-fixture"]);
    assert.equal(historicalRun.status, 0, historicalRun.stderr);
    assert.match(historicalRun.stdout, /0 active-surface leaks found/u);

    writeRepoFile(repo, "src/app.ts", 'const target = "moonlit-fixture";\n');
    git(repo, ["add", "src/app.ts"]);
    const activeRun = runScanner(repo, ["--mode", "check", "--token", "moonlit-fixture"]);
    assert.equal(activeRun.status, 1, activeRun.stdout);
    assert.match(activeRun.stdout, /1 active-surface leak found/u);
    assert.match(activeRun.stdout, /gate FAILED/u);
  });
});

test("report mode prints active leaks but exits zero (advisory audit)", () => {
  withTempGitRepo((repo) => {
    writeRepoFile(repo, "src/app.ts", 'const target = "moonlit-fixture";\n');
    git(repo, ["add", "src/app.ts"]);

    const result = runScanner(repo, ["--mode", "report", "--token", "moonlit-fixture"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /generalization-purge gate: 1 active-surface leak found/u);
    assert.doesNotMatch(result.stdout, /gate FAILED/u);
  });
});

// ---------------------------------------------------------------------------
// Unit coverage for the classification helpers.
// ---------------------------------------------------------------------------
test("classifySurface matches prefix, exact, suffix and segment kinds", () => {
  const surfaces = [
    { id: "prefix", kind: "prefix", value: "docs/", reason: "docs" },
    { id: "exact", kind: "exact", value: "justfile", reason: "harness" },
    { id: "suffix", kind: "suffix", value: ".test.ts", reason: "tests" },
    { id: "segment", kind: "segment", value: "examples", reason: "examples" },
  ];
  assert.equal(classifySurface("docs/x.md", surfaces).id, "prefix");
  assert.equal(classifySurface("justfile", surfaces).id, "exact");
  assert.equal(classifySurface("apps/a.test.ts", surfaces).id, "suffix");
  assert.equal(classifySurface("crates/x/examples/y.rs", surfaces).id, "segment");
  assert.equal(classifySurface("apps/itotori/src/app.ts", surfaces), null);
});

test("stripComments blanks line and block comments while preserving column positions", () => {
  const line = stripComments('let x = "keep"; // drop', false);
  assert.equal(line.code, 'let x = "keep";        ');
  assert.equal(line.inBlockNext, false);

  const opened = stripComments("code /* enter", false);
  assert.equal(opened.inBlockNext, true);
  assert.equal(opened.code, "code         ");

  const closed = stripComments("still comment */ real", true);
  assert.equal(closed.inBlockNext, false);
  assert.match(closed.code, /real$/u);
});

test("isEnvPath matches nested env filenames", () => {
  assert.equal(isEnvPath(".env"), true);
  assert.equal(isEnvPath(".env.test"), true);
  assert.equal(isEnvPath("config/.env.local"), true);
  assert.equal(isEnvPath("src/env.ts"), false);
});

test("renderReport summarizes the zero-leak case", () => {
  const report = renderReport({
    active: [],
    historical: [{}, {}],
    scannedFileCount: 3,
    historicalSurfaceFileCount: 2,
    skippedEnvFileCount: 1,
  });

  assert.match(report, /generalization-purge gate: 0 active-surface leaks found/u);
  assert.match(report, /no active-surface title\/vendor leaks found/u);
});

function scanRepo(repo) {
  return scanFiles({
    root: repo,
    files: listTrackedFiles(repo),
    forbiddenTokens: fakeForbiddenTokens,
    surfaces: fakeSurfaces,
  });
}

function runScanner(repo, args) {
  return spawnSync(process.execPath, [scannerPath, "--root", repo, ...args], { encoding: "utf8" });
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
