import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isCiRecordPass,
  isRoadmapSpecDagImport,
  isRoadmapSpecDagExport,
  validateCiRecordPassEvidence,
} from "./qd-wrapper.mjs";

const root = path.resolve("/repo");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const wrapperPath = path.join(scriptDir, "qd-wrapper.mjs");
const qdDatabaseFiles = ["qd.db", "qd.db-wal", "qd.db-shm"];

const runningAuditRun = {
  id: "7ffce8d8-729b-4b4f-900a-0cea996a1096",
  node_id: "CATALOG-003",
  kind: "audit",
  status: "running",
  started_at: "2026-06-27T00:00:00.000Z",
  finished_at: null,
  summary: null,
};

test("detects direct qd export to roadmap spec DAG", () => {
  assert.equal(isRoadmapSpecDagExport(root, ["export", "--out", "roadmap/spec-dag.json"]), true);
  assert.equal(isRoadmapSpecDagExport(root, ["export", "--out=roadmap/spec-dag.json"]), true);
  assert.equal(
    isRoadmapSpecDagExport(root, ["export", "--out", path.join(root, "roadmap", "spec-dag.json")]),
    true,
  );
});

test("detects qd import rebuilds from roadmap spec DAG", () => {
  assert.equal(isRoadmapSpecDagImport(root, ["import", "--from", "roadmap/spec-dag.json"]), true);
  assert.equal(isRoadmapSpecDagImport(root, ["import", "--from=roadmap/spec-dag.json"]), true);
  assert.equal(
    isRoadmapSpecDagImport(root, ["import", "--from", path.join(root, "roadmap", "spec-dag.json")]),
    true,
  );
  assert.equal(
    isRoadmapSpecDagImport(root, ["import", "--dry-run", "--from", "roadmap/spec-dag.json"]),
    false,
  );
  assert.equal(isRoadmapSpecDagImport(root, ["import", "--from", "roadmap/other.json"]), false);
});

test("does not canonicalize unrelated qd exports", () => {
  assert.equal(isRoadmapSpecDagExport(root, ["export", "--json"]), false);
  assert.equal(isRoadmapSpecDagExport(root, ["export", "--out", "roadmap/other.json"]), false);
  assert.equal(isRoadmapSpecDagExport(root, ["node", "show", "ITOTORI-300", "--json"]), false);
});

test("detects qd ci record-pass commands", () => {
  assert.equal(isCiRecordPass(["ci", "record-pass", "ITOTORI-300"]), true);
  assert.equal(isCiRecordPass(["ci", "run", "ITOTORI-300"]), false);
  assert.equal(isCiRecordPass(["check", "run", "ITOTORI-300"]), false);
});

test("accepts durable qd ci record-pass URL and external id evidence", () => {
  assert.doesNotThrow(() =>
    validateCiRecordPassEvidence(root, [
      "ci",
      "record-pass",
      "ITOTORI-300",
      "--summary",
      "Covered by integrated CI.",
      "--url",
      "https://github.com/cat-cave/itotori/actions/runs/123",
    ]),
  );
  assert.doesNotThrow(() =>
    validateCiRecordPassEvidence(root, [
      "ci",
      "record-pass",
      "ITOTORI-300",
      "--summary=Covered by integrated CI.",
      "--external-id=github-actions:123",
    ]),
  );
});

test("accepts existing repo-relative qd ci record-pass evidence files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qd-wrapper-record-pass-"));
  const evidencePath = path.join(dir, "docs", "qd-ci-evidence", "wave.md");
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, "CI summary\n");

  assert.doesNotThrow(() =>
    validateCiRecordPassEvidence(dir, [
      "ci",
      "record-pass",
      "ITOTORI-300",
      "--summary",
      "Covered by integrated CI.",
      "--log-path",
      "docs/qd-ci-evidence/wave.md",
    ]),
  );
});

test("rejects local-only qd ci record-pass log paths", () => {
  assert.throws(
    () =>
      validateCiRecordPassEvidence(root, [
        "ci",
        "record-pass",
        "ITOTORI-300",
        "--summary",
        "Covered by integrated CI.",
        "--log-path",
        "/home/trevor/projects/itotori/.qd/logs/ci-ITOTORI-300.log",
      ]),
    /repo-relative/u,
  );

  assert.throws(
    () =>
      validateCiRecordPassEvidence(root, [
        "ci",
        "record-pass",
        "ITOTORI-300",
        "--summary",
        "Covered by integrated CI.",
        "--log-path",
        ".qd/logs/ci-ITOTORI-300.log",
      ]),
    /local-only \.qd/u,
  );
});

test("rejects stale or gitignored qd ci record-pass evidence paths", () => {
  assert.throws(
    () =>
      validateCiRecordPassEvidence(root, [
        "ci",
        "record-pass",
        "ITOTORI-300",
        "--summary",
        "Covered by integrated CI.",
        "--log-path",
        "docs/qd-ci-evidence/missing.md",
      ]),
    /does not exist/u,
  );

  assert.throws(
    () =>
      validateCiRecordPassEvidence(root, [
        "ci",
        "record-pass",
        "ITOTORI-300",
        "--summary",
        "Covered by integrated CI.",
        "--log-path",
        "artifacts/qd-ci/run.log",
      ]),
    /gitignored artifacts/u,
  );
});

test("rejects record-pass summaries that cite local qd logs", () => {
  assert.throws(
    () =>
      validateCiRecordPassEvidence(root, [
        "ci",
        "record-pass",
        "ITOTORI-300",
        "--summary",
        "Covered by integrated CI.\nEvidence: log_path=.qd/logs/ci-ITOTORI-300.log",
        "--external-id",
        "github-actions:123",
      ]),
    /must not cite local-only \.qd\/logs paths/u,
  );
});

test("canonicalizes direct qd export to roadmap spec DAG", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qd-wrapper-export-"));
  const repoRoot = path.join(dir, "repo");
  const fakeBinDir = path.join(dir, "bin");
  const fakeQdPath = path.join(dir, "fake-qd.mjs");
  const fakePnpmPath = path.join(fakeBinDir, "pnpm");
  const pnpmArgsPath = path.join(dir, "pnpm-args.txt");
  const exportPath = path.join(repoRoot, "roadmap", "spec-dag.json");

  mkdirSync(path.dirname(exportPath), { recursive: true });
  mkdirSync(path.join(repoRoot, ".qd"), { recursive: true });
  mkdirSync(fakeBinDir, { recursive: true });

  writeFileSync(
    fakeQdPath,
    `import { writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const root = rootIndex >= 0 ? args[rootIndex + 1] : process.cwd();
const outIndex = args.indexOf("--out");
if (!args.includes("export") || outIndex < 0) process.exit(2);
writeFileSync(path.resolve(root, args[outIndex + 1]), '{"b":2,"a":[1,2]}');
`,
  );

  writeFileSync(
    fakePnpmPath,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

writeFileSync(${JSON.stringify(pnpmArgsPath)}, process.argv.slice(2).join("\\n"));
const target = process.argv.at(-1);
const json = JSON.parse(readFileSync(target, "utf8"));
writeFileSync(target, \`\${JSON.stringify(json, null, 2)}\\n\`);
`,
  );
  chmodSync(fakePnpmPath, 0o755);

  const result = spawnSync(
    process.execPath,
    [wrapperPath, "--root", repoRoot, "export", "--out", "roadmap/spec-dag.json"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        QD_REAL_NODE_SCRIPT: fakeQdPath,
      },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, [result.stderr, result.stdout].filter(Boolean).join("\n"));
  assert.equal(readFileSync(exportPath, "utf8"), '{\n  "b": 2,\n  "a": [\n    1,\n    2\n  ]\n}\n');
  assert.deepEqual(readFileSync(pnpmArgsPath, "utf8").split("\n"), [
    "exec",
    "vp",
    "check",
    "--fix",
    "--no-lint",
    exportPath,
  ]);
});

test("qd import rebuild preserves live database and config when staged import fails", () => {
  const { repoRoot, fakeQdPath, logPath, originalDb, originalConfig } = createImportFixture();

  const result = runImport(repoRoot, fakeQdPath, {
    QD_FAKE_LOG: logPath,
    FAIL_IMPORT: "1",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fake import failure/u);
  assert.deepEqual(readDatabaseFiles(repoRoot), originalDb);
  assert.equal(readFileSync(path.join(repoRoot, ".qd", "config.toml"), "utf8"), originalConfig);
  assert.deepEqual(readLog(logPath), ["import"]);
});

test("qd import rebuild recovers a zero-byte qd database without rewriting config", () => {
  const { repoRoot, fakeQdPath, logPath, originalConfig } = createImportFixture({
    zeroByteDb: true,
  });

  const result = runImport(repoRoot, fakeQdPath, {
    QD_FAKE_LOG: logPath,
  });

  assert.equal(result.status, 0, [result.stderr, result.stdout].filter(Boolean).join("\n"));
  const finalSnapshot = JSON.parse(readFileSync(path.join(repoRoot, ".qd", "qd.db"), "utf8"));
  assert.deepEqual(
    finalSnapshot.nodes.map((node) => node.id),
    ["UNIV-003"],
  );
  assert.equal(readFileSync(path.join(repoRoot, ".qd", "qd.db-wal"), "utf8"), "replacement wal\n");
  assert.equal(readFileSync(path.join(repoRoot, ".qd", "qd.db-shm"), "utf8"), "replacement shm\n");
  assert.equal(readFileSync(path.join(repoRoot, ".qd", "config.toml"), "utf8"), originalConfig);
  assert.match(originalConfig, /check_command = "nix develop --command bash -lc 'just check'"/u);
  assert.match(originalConfig, /ci_command = "nix develop --command bash -lc 'just qd-full-ci'"/u);
  assert.deepEqual(readLog(logPath), ["import", "stage-export-json", "doctor"]);
});

test("qd import rebuild preserves live database and config when staged doctor fails", () => {
  const { repoRoot, fakeQdPath, logPath, originalDb, originalConfig } = createImportFixture();

  const result = runImport(repoRoot, fakeQdPath, {
    QD_FAKE_LOG: logPath,
    FAIL_DOCTOR: "1",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fake doctor failure/u);
  assert.deepEqual(readDatabaseFiles(repoRoot), originalDb);
  assert.equal(readFileSync(path.join(repoRoot, ".qd", "config.toml"), "utf8"), originalConfig);
  assert.deepEqual(readLog(logPath), ["import", "stage-export-json", "doctor"]);
});

test("read-only qd commands hydrate from roadmap export when live database is unusable", () => {
  const { repoRoot, fakeQdPath, logPath } = createImportFixture({ zeroByteDb: true });

  const result = spawnSync(
    process.execPath,
    [wrapperPath, "--root", repoRoot, "node", "show", "UNIV-003", "--full", "--json"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        QD_REAL_NODE_SCRIPT: fakeQdPath,
        QD_FAKE_LOG: logPath,
        LIVE_ROOT: repoRoot,
      },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, [result.stderr, result.stdout].filter(Boolean).join("\n"));
  assert.deepEqual(JSON.parse(result.stdout), { id: "UNIV-003", title: "Hydrated node" });
  assert.equal(readFileSync(path.join(repoRoot, ".qd", "qd.db"), "utf8"), "");
  assert.deepEqual(readLog(logPath), [
    "live-node-show",
    "import",
    "stage-export-json",
    "stage-node-show",
  ]);
});

test("audit disposition preserves live qd database when staged import fails", () => {
  const { dir, repoRoot, fakeQdPath, logPath, expectedLiveDbPath, originalDb } =
    createDispositionFixture();

  const result = runDispose(repoRoot, fakeQdPath, {
    QD_FAKE_LOG: logPath,
    FAIL_IMPORT: "1",
    EXPECT_LIVE_DB_PATH: expectedLiveDbPath,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fake import failure/u);
  assert.deepEqual(readDatabaseFiles(repoRoot), originalDb);
  assert.deepEqual(readLog(logPath), ["live-export-json", "import"]);
  assert.equal(existsSync(path.join(repoRoot, ".qd", "audit-disposition.lock")), false);

  assert.equal(dir.startsWith(tmpdir()), true);
});

test("audit disposition imports into staging, validates, then replaces live qd database", () => {
  const { repoRoot, fakeQdPath, fakeBinDir, logPath, expectedLiveDbPath } =
    createDispositionFixture({
      withRoadmap: true,
    });
  const pnpmArgsPath = path.join(fakeBinDir, "pnpm-args.txt");
  const roadmapPath = path.join(repoRoot, "roadmap", "spec-dag.json");
  writeCanonicalizingPnpm(path.join(fakeBinDir, "pnpm"), pnpmArgsPath);

  const result = runDispose(repoRoot, fakeQdPath, {
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    QD_FAKE_LOG: logPath,
    EXPECT_LIVE_DB_PATH: expectedLiveDbPath,
    UNFORMATTED_LIVE_EXPORT: "1",
  });

  assert.equal(result.status, 0, [result.stderr, result.stdout].filter(Boolean).join("\n"));
  const finalSnapshot = JSON.parse(readFileSync(path.join(repoRoot, ".qd", "qd.db"), "utf8"));
  assert.equal(finalSnapshot.runs[0].status, "cancelled");
  assert.match(finalSnapshot.runs[0].summary, /stale audit run/u);

  const roadmapContent = readFileSync(roadmapPath, "utf8");
  const exportedSnapshot = JSON.parse(roadmapContent);
  assert.equal(exportedSnapshot.runs[0].status, "cancelled");
  assert.equal(roadmapContent, `${JSON.stringify(exportedSnapshot, null, 2)}\n`);
  assert.deepEqual(readFileSync(pnpmArgsPath, "utf8").split("\n"), [
    "exec",
    "vp",
    "check",
    "--fix",
    "--no-lint",
    roadmapPath,
  ]);

  assert.deepEqual(readLog(logPath), [
    "live-export-json",
    "import",
    "stage-export-json",
    "live-export-out",
  ]);
});

test("audit disposition lock acquisition failure leaves qd database untouched", () => {
  const { repoRoot, fakeQdPath, logPath, expectedLiveDbPath, originalDb } =
    createDispositionFixture();
  mkdirSync(path.join(repoRoot, ".qd", "audit-disposition.lock"));

  const result = runDispose(repoRoot, fakeQdPath, {
    QD_FAKE_LOG: logPath,
    EXPECT_LIVE_DB_PATH: expectedLiveDbPath,
  });

  assert.notEqual(result.status, 0);
  assert.deepEqual(readDatabaseFiles(repoRoot), originalDb);
  assert.equal(existsSync(logPath), false);
});

test("audit disposition refuses a lock owned by a live process", () => {
  const { repoRoot, fakeQdPath, logPath, expectedLiveDbPath, originalDb } =
    createDispositionFixture();
  writeAuditDispositionLock(repoRoot, {
    pid: process.pid,
    created_at: new Date().toISOString(),
  });

  const result = runDispose(repoRoot, fakeQdPath, {
    QD_FAKE_LOG: logPath,
    EXPECT_LIVE_DB_PATH: expectedLiveDbPath,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /held by live process/u);
  assert.deepEqual(readDatabaseFiles(repoRoot), originalDb);
  assert.equal(existsSync(logPath), false);
});

test("audit disposition recovers a lock owned by a dead process", () => {
  const { repoRoot, fakeQdPath, logPath, expectedLiveDbPath } = createDispositionFixture();
  writeAuditDispositionLock(repoRoot, {
    pid: deadPid(),
    created_at: new Date().toISOString(),
  });

  const result = runDispose(repoRoot, fakeQdPath, {
    QD_FAKE_LOG: logPath,
    EXPECT_LIVE_DB_PATH: expectedLiveDbPath,
  });

  assert.equal(result.status, 0, [result.stderr, result.stdout].filter(Boolean).join("\n"));
  assert.equal(existsSync(path.join(repoRoot, ".qd", "audit-disposition.lock")), false);
  assert.deepEqual(readLog(logPath), ["live-export-json", "import", "stage-export-json"]);
});

test("audit disposition recovers stale locks with empty or malformed owner metadata", () => {
  for (const ownerContent of ["", "{not json"]) {
    const { repoRoot, fakeQdPath, logPath, expectedLiveDbPath } = createDispositionFixture();
    writeAuditDispositionLock(repoRoot, ownerContent, { stale: true });

    const result = runDispose(repoRoot, fakeQdPath, {
      QD_FAKE_LOG: logPath,
      EXPECT_LIVE_DB_PATH: expectedLiveDbPath,
    });

    assert.equal(result.status, 0, [result.stderr, result.stdout].filter(Boolean).join("\n"));
    assert.equal(existsSync(path.join(repoRoot, ".qd", "audit-disposition.lock")), false);
    assert.deepEqual(readLog(logPath), ["live-export-json", "import", "stage-export-json"]);
  }
});

test("audit disposition requires force for young locks with unknown owner metadata", () => {
  const { repoRoot, fakeQdPath, logPath, expectedLiveDbPath, originalDb } =
    createDispositionFixture();
  writeAuditDispositionLock(repoRoot, "{not json");

  const refused = runDispose(repoRoot, fakeQdPath, {
    QD_FAKE_LOG: logPath,
    EXPECT_LIVE_DB_PATH: expectedLiveDbPath,
  });

  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /use --force/u);
  assert.deepEqual(readDatabaseFiles(repoRoot), originalDb);
  assert.equal(existsSync(logPath), false);

  const forced = runDispose(
    repoRoot,
    fakeQdPath,
    {
      QD_FAKE_LOG: logPath,
      EXPECT_LIVE_DB_PATH: expectedLiveDbPath,
    },
    ["--force"],
  );

  assert.equal(forced.status, 0, [forced.stderr, forced.stdout].filter(Boolean).join("\n"));
  assert.equal(existsSync(path.join(repoRoot, ".qd", "audit-disposition.lock")), false);
  assert.deepEqual(readLog(logPath), ["live-export-json", "import", "stage-export-json"]);
});

test("audit disposition rolls back qd database and roadmap when canonicalization fails", () => {
  const { repoRoot, fakeQdPath, fakeBinDir, logPath, expectedLiveDbPath, originalDb } =
    createDispositionFixture({
      withRoadmap: true,
    });
  const originalRoadmap = readFileSync(path.join(repoRoot, "roadmap", "spec-dag.json"), "utf8");
  writeFailingPnpm(path.join(fakeBinDir, "pnpm"));

  const result = runDispose(repoRoot, fakeQdPath, {
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    QD_FAKE_LOG: logPath,
    EXPECT_LIVE_DB_PATH: expectedLiveDbPath,
  });

  assert.notEqual(result.status, 0);
  assert.deepEqual(readDatabaseFiles(repoRoot), originalDb);
  assert.equal(
    readFileSync(path.join(repoRoot, "roadmap", "spec-dag.json"), "utf8"),
    originalRoadmap,
  );
  assert.deepEqual(readLog(logPath), [
    "live-export-json",
    "import",
    "stage-export-json",
    "live-export-out",
  ]);
});

test("audit disposition preserves live qd database when staged validation fails", () => {
  const { repoRoot, fakeQdPath, logPath, expectedLiveDbPath, originalDb } =
    createDispositionFixture();

  const result = runDispose(repoRoot, fakeQdPath, {
    QD_FAKE_LOG: logPath,
    EXPECT_LIVE_DB_PATH: expectedLiveDbPath,
    FAIL_STAGE_VALIDATION: "1",
  });

  assert.notEqual(result.status, 0);
  assert.deepEqual(readDatabaseFiles(repoRoot), originalDb);
  assert.deepEqual(readLog(logPath), ["live-export-json", "import", "stage-export-json"]);
});

test("audit disposition restores original qd database when staged swap fails", () => {
  const { repoRoot, fakeQdPath, logPath, expectedLiveDbPath, originalDb } =
    createDispositionFixture();

  const result = runDispose(repoRoot, fakeQdPath, {
    QD_FAKE_LOG: logPath,
    EXPECT_LIVE_DB_PATH: expectedLiveDbPath,
    FAIL_SWAP_AFTER_DB: "1",
  });

  assert.notEqual(result.status, 0);
  assert.deepEqual(readDatabaseFiles(repoRoot), originalDb);
  assert.deepEqual(readLog(logPath), ["live-export-json", "import", "stage-export-json"]);
});

test("audit disposition rolls back qd database and roadmap when live export fails", () => {
  const { repoRoot, fakeQdPath, fakeBinDir, logPath, expectedLiveDbPath, originalDb } =
    createDispositionFixture({
      withRoadmap: true,
    });
  const originalRoadmap = readFileSync(path.join(repoRoot, "roadmap", "spec-dag.json"), "utf8");
  writeCanonicalizingPnpm(path.join(fakeBinDir, "pnpm"));

  const result = runDispose(repoRoot, fakeQdPath, {
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    QD_FAKE_LOG: logPath,
    EXPECT_LIVE_DB_PATH: expectedLiveDbPath,
    FAIL_LIVE_EXPORT: "1",
  });

  assert.notEqual(result.status, 0);
  assert.deepEqual(readDatabaseFiles(repoRoot), originalDb);
  assert.equal(
    readFileSync(path.join(repoRoot, "roadmap", "spec-dag.json"), "utf8"),
    originalRoadmap,
  );
  assert.deepEqual(readLog(logPath), [
    "live-export-json",
    "import",
    "stage-export-json",
    "live-export-out",
  ]);
});

test("audit disposition rolls back qd database and roadmap when roadmap rename fails", () => {
  const { repoRoot, fakeQdPath, fakeBinDir, logPath, expectedLiveDbPath, originalDb } =
    createDispositionFixture({
      withRoadmap: true,
    });
  const roadmapDir = path.join(repoRoot, "roadmap");
  const originalRoadmap = readFileSync(path.join(roadmapDir, "spec-dag.json"), "utf8");
  writeCanonicalizingPnpm(path.join(fakeBinDir, "pnpm"));

  try {
    const result = runDispose(repoRoot, fakeQdPath, {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      QD_FAKE_LOG: logPath,
      EXPECT_LIVE_DB_PATH: expectedLiveDbPath,
      MAKE_ROADMAP_READONLY_AFTER_EXPORT: "1",
    });

    assert.notEqual(result.status, 0);
    assert.deepEqual(readDatabaseFiles(repoRoot), originalDb);
    assert.equal(readFileSync(path.join(roadmapDir, "spec-dag.json"), "utf8"), originalRoadmap);
    assert.deepEqual(readLog(logPath), [
      "live-export-json",
      "import",
      "stage-export-json",
      "live-export-out",
    ]);
  } finally {
    chmodSync(roadmapDir, 0o755);
  }
});

function createDispositionFixture({ withRoadmap = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "qd-wrapper-dispose-"));
  const repoRoot = path.join(dir, "repo");
  const fakeBinDir = path.join(dir, "bin");
  const fakeQdPath = path.join(dir, "fake-qd.mjs");
  const logPath = path.join(dir, "qd.log");
  const qdDir = path.join(repoRoot, ".qd");

  mkdirSync(qdDir, { recursive: true });
  mkdirSync(fakeBinDir, { recursive: true });
  writeFileSync(path.join(qdDir, "config.toml"), "[workspace]\n");
  writeFileSync(path.join(qdDir, "qd.db"), "original db\n");
  writeFileSync(path.join(qdDir, "qd.db-wal"), "original wal\n");
  writeFileSync(path.join(qdDir, "qd.db-shm"), "original shm\n");
  const expectedLiveDbPath = path.join(dir, "expected-live-qd.db");
  writeFileSync(expectedLiveDbPath, readFileSync(path.join(qdDir, "qd.db")));

  if (withRoadmap) {
    mkdirSync(path.join(repoRoot, "roadmap"), { recursive: true });
    writeFileSync(path.join(repoRoot, "roadmap", "spec-dag.json"), '{"old":true}\n');
  }

  writeDispositionFakeQd(fakeQdPath);

  return {
    dir,
    repoRoot,
    fakeBinDir,
    fakeQdPath,
    logPath,
    expectedLiveDbPath,
    originalDb: readDatabaseFiles(repoRoot),
  };
}

function createImportFixture({ zeroByteDb = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "qd-wrapper-import-"));
  const repoRoot = path.join(dir, "repo");
  const fakeQdPath = path.join(dir, "fake-qd.mjs");
  const logPath = path.join(dir, "qd.log");
  const qdDir = path.join(repoRoot, ".qd");
  const roadmapPath = path.join(repoRoot, "roadmap", "spec-dag.json");

  mkdirSync(qdDir, { recursive: true });
  mkdirSync(path.dirname(roadmapPath), { recursive: true });
  const originalConfig = `# qdcli repo-local configuration
schema_version = 1
check_command = "nix develop --command bash -lc 'just check'"
ci_command = "nix develop --command bash -lc 'just qd-full-ci'"
merge_strategy = "squash"
`;
  writeFileSync(path.join(qdDir, "config.toml"), originalConfig);
  writeFileSync(path.join(qdDir, "qd.db"), zeroByteDb ? "" : '{"nodes":[{"id":"OLD"}]}\n');
  writeFileSync(path.join(qdDir, "qd.db-wal"), "original wal\n");
  writeFileSync(path.join(qdDir, "qd.db-shm"), "original shm\n");
  writeFileSync(
    roadmapPath,
    `${JSON.stringify({ nodes: [{ id: "UNIV-003", title: "Hydrated node" }] }, null, 2)}\n`,
  );
  writeImportFakeQd(fakeQdPath);

  return {
    repoRoot,
    fakeQdPath,
    logPath,
    originalConfig,
    originalDb: readDatabaseFiles(repoRoot),
  };
}

function runImport(repoRoot, fakeQdPath, env = {}) {
  return spawnSync(
    process.execPath,
    [wrapperPath, "--root", repoRoot, "import", "--from", "roadmap/spec-dag.json"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...env,
        QD_REAL_NODE_SCRIPT: fakeQdPath,
        LIVE_ROOT: repoRoot,
      },
      encoding: "utf8",
    },
  );
}

function runDispose(repoRoot, fakeQdPath, env = {}, extraArgs = []) {
  const stderrPath = path.join(path.dirname(repoRoot), `dispose-stderr-${process.hrtime.bigint()}`);
  const stderrFd = openSync(stderrPath, "w");
  let result;
  try {
    result = spawnSync(
      process.execPath,
      [
        wrapperPath,
        "--root",
        repoRoot,
        "audit",
        "dispose",
        "CATALOG-003",
        "--run-id",
        runningAuditRun.id,
        "--rationale",
        "stale audit run",
        ...extraArgs,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          ...env,
          LIVE_ROOT: repoRoot,
          LIVE_DB_PATH: path.join(repoRoot, ".qd", "qd.db"),
          INITIAL_SNAPSHOT: JSON.stringify({ runs: [runningAuditRun] }),
          QD_REAL_BIN: fakeQdPath,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", stderrFd],
      },
    );
  } finally {
    closeSync(stderrFd);
  }
  result.stderr = readFileSync(stderrPath, "utf8");
  return result;
}

function writeAuditDispositionLock(repoRoot, owner, { stale = false } = {}) {
  const lockPath = path.join(repoRoot, ".qd", "audit-disposition.lock");
  mkdirSync(lockPath);
  const ownerPath = path.join(lockPath, "owner.json");
  writeFileSync(
    ownerPath,
    typeof owner === "string" ? owner : `${JSON.stringify(owner, null, 2)}\n`,
  );

  if (stale) {
    const old = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(ownerPath, old, old);
    utimesSync(lockPath, old, old);
  }
}

function deadPid() {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.equal(result.status, 0);
  return result.pid;
}

function readDatabaseFiles(repoRoot) {
  return Object.fromEntries(
    qdDatabaseFiles.map((name) => [name, readFileSync(path.join(repoRoot, ".qd", name), "utf8")]),
  );
}

function readLog(logPath) {
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
}

function writeDispositionFakeQd(fakeQdPath) {
  writeFileSync(
    fakeQdPath,
    `#!/usr/bin/env bash
set -euo pipefail

root="$PWD"
command=""
json=0
from=""
out=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root)
      root="$2"
      shift 2
      ;;
    --json)
      json=1
      shift
      ;;
    --from)
      from="$2"
      shift 2
      ;;
    --out)
      out="$2"
      shift 2
      ;;
    export|import)
      command="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

log() {
  if [ -n "\${QD_FAKE_LOG:-}" ]; then
    printf '%s\\n' "$1" >> "$QD_FAKE_LOG"
  fi
}

assert_live_db_unchanged() {
  if [ -n "\${EXPECT_LIVE_DB_PATH:-}" ] && ! cmp -s "$LIVE_DB_PATH" "$EXPECT_LIVE_DB_PATH"; then
    printf '%s\\n' "live qd database changed before staged validation completed" >&2
    exit 47
  fi
}

resolve_under_root() {
  case "$1" in
    /*) printf '%s\\n' "$1" ;;
    *) printf '%s\\n' "$root/$1" ;;
  esac
}

if [ "$command" = "export" ] && [ "$json" -eq 1 ]; then
  if [ "$root" = "$LIVE_ROOT" ]; then
    log "live-export-json"
  else
    log "stage-export-json"
    assert_live_db_unchanged
    if [ "\${FAIL_STAGE_VALIDATION:-}" = "1" ]; then
      printf '%s\\n' "$INITIAL_SNAPSHOT"
      exit 0
    fi
  fi

  if [ -f "$root/.qd/snapshot.json" ]; then
    cat "$root/.qd/snapshot.json"
  else
    printf '%s\\n' "$INITIAL_SNAPSHOT"
  fi
  exit 0
fi

if [ "$command" = "import" ]; then
  log "import"
  assert_live_db_unchanged
  if [ "\${FAIL_IMPORT:-}" = "1" ]; then
    printf '%s\\n' "fake import failure" >&2
    exit 41
  fi

  snapshot_path="$(resolve_under_root "$from")"
  mkdir -p "$root/.qd"
  cp "$snapshot_path" "$root/.qd/snapshot.json"
  cp "$snapshot_path" "$root/.qd/qd.db"
  if [ "\${FAIL_SWAP_AFTER_DB:-}" = "1" ]; then
    mkdir "$root/.qd/qd.db-wal"
  else
    printf '%s\\n' "replacement wal" > "$root/.qd/qd.db-wal"
  fi
  printf '%s\\n' "replacement shm" > "$root/.qd/qd.db-shm"
  exit 0
fi

if [ "$command" = "export" ] && [ -n "$out" ]; then
  log "live-export-out"
  if [ "\${FAIL_LIVE_EXPORT:-}" = "1" ]; then
    printf '%s\\n' "fake live export failure" >&2
    exit 42
  fi
  out_path="$(resolve_under_root "$out")"
  mkdir -p "\${out_path%/*}"
  if [ "\${UNFORMATTED_LIVE_EXPORT:-}" = "1" ]; then
    node -e '
const fs = require("node:fs");
const [source, target] = process.argv.slice(1);
const raw = fs.readFileSync(source, "utf8");
fs.writeFileSync(target, JSON.stringify(JSON.parse(raw)));
' "$root/.qd/qd.db" "$out_path"
  else
    cp "$root/.qd/qd.db" "$out_path"
  fi
  if [ "\${MAKE_ROADMAP_READONLY_AFTER_EXPORT:-}" = "1" ]; then
    chmod a-w "$LIVE_ROOT/roadmap"
  fi
  exit 0
fi

exit 2
`,
  );
  chmodSync(fakeQdPath, 0o755);
}

function writeImportFakeQd(fakeQdPath) {
  writeFileSync(
    fakeQdPath,
    `import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
let root = process.cwd();
let command = "";
let subcommand = "";
let from = "";
let json = false;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--root") {
    root = args[index + 1];
    index += 1;
  } else if (arg === "--from") {
    from = args[index + 1];
    index += 1;
  } else if (arg.startsWith("--from=")) {
    from = arg.slice("--from=".length);
  } else if (arg === "--json") {
    json = true;
  } else if (!command && ["import", "export", "doctor", "node"].includes(arg)) {
    command = arg;
  } else if (command === "node" && !subcommand) {
    subcommand = arg;
  }
}

function log(value) {
  if (process.env.QD_FAKE_LOG) {
    writeFileSync(process.env.QD_FAKE_LOG, \`\${value}\\n\`, { flag: "a" });
  }
}

function resolveUnderRoot(value) {
  return path.isAbsolute(value) ? value : path.join(root, value);
}

if (command === "import") {
  log("import");
  if (process.env.FAIL_IMPORT === "1") {
    writeSync(2, "fake import failure\\n");
    process.exit(41);
  }
  const sourcePath = resolveUnderRoot(from);
  mkdirSync(path.join(root, ".qd"), { recursive: true });
  const snapshot = JSON.parse(readFileSync(sourcePath, "utf8"));
  writeFileSync(path.join(root, ".qd", "qd.db"), \`\${JSON.stringify(snapshot)}\\n\`);
  writeFileSync(path.join(root, ".qd", "qd.db-wal"), "replacement wal\\n");
  writeFileSync(path.join(root, ".qd", "qd.db-shm"), "replacement shm\\n");
  process.exit(0);
}

if (command === "export" && json) {
  log(root === process.env.LIVE_ROOT ? "live-export-json" : "stage-export-json");
  const dbPath = path.join(root, ".qd", "qd.db");
  if (!existsSync(dbPath) || readFileSync(dbPath, "utf8") === "") {
    writeSync(2, "SqliteFailure: no such table: nodes\\n");
    process.exit(1);
  }
  writeSync(1, readFileSync(dbPath, "utf8"));
  process.exit(0);
}

if (command === "doctor") {
  log("doctor");
  if (process.env.FAIL_DOCTOR === "1") {
    writeSync(2, "fake doctor failure\\n");
    process.exit(42);
  }
  writeSync(1, \`\${JSON.stringify({ ok: true })}\\n\`);
  process.exit(0);
}

if (command === "node" && subcommand === "show") {
  if (root === process.env.LIVE_ROOT) {
    log("live-node-show");
    writeSync(2, "SqliteFailure: no such table: nodes\\n");
    process.exit(1);
  }
  log("stage-node-show");
  const snapshot = JSON.parse(readFileSync(path.join(root, ".qd", "qd.db"), "utf8"));
  writeSync(1, \`\${JSON.stringify(snapshot.nodes[0])}\\n\`);
  process.exit(0);
}

writeSync(2, \`unexpected fake qd invocation: \${args.join(" ")}\\n\`);
process.exit(2);
`,
  );
}

function writeCanonicalizingPnpm(fakePnpmPath, argsPath = null) {
  writeFileSync(
    fakePnpmPath,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const argsPath = ${JSON.stringify(argsPath)};
if (argsPath) writeFileSync(argsPath, process.argv.slice(2).join("\\n"));
const target = process.argv.at(-1);
const json = JSON.parse(readFileSync(target, "utf8"));
writeFileSync(target, \`\${JSON.stringify(json, null, 2)}\\n\`);
`,
  );
  chmodSync(fakePnpmPath, 0o755);
}

function writeFailingPnpm(fakePnpmPath) {
  writeFileSync(
    fakePnpmPath,
    `#!/usr/bin/env node
console.error("fake canonicalization failure");
process.exit(55);
`,
  );
  chmodSync(fakePnpmPath, 0o755);
}
