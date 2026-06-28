import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRoadmapSpecDagExport } from "./qd-wrapper.mjs";

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

test("does not canonicalize unrelated qd exports", () => {
  assert.equal(isRoadmapSpecDagExport(root, ["export", "--json"]), false);
  assert.equal(isRoadmapSpecDagExport(root, ["export", "--out", "roadmap/other.json"]), false);
  assert.equal(isRoadmapSpecDagExport(root, ["node", "show", "ITOTORI-300", "--json"]), false);
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
  writeCanonicalizingPnpm(path.join(fakeBinDir, "pnpm"));

  const result = runDispose(repoRoot, fakeQdPath, {
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    QD_FAKE_LOG: logPath,
    EXPECT_LIVE_DB_PATH: expectedLiveDbPath,
  });

  assert.equal(result.status, 0, [result.stderr, result.stdout].filter(Boolean).join("\n"));
  const finalSnapshot = JSON.parse(readFileSync(path.join(repoRoot, ".qd", "qd.db"), "utf8"));
  assert.equal(finalSnapshot.runs[0].status, "cancelled");
  assert.match(finalSnapshot.runs[0].summary, /stale audit run/u);

  const exportedSnapshot = JSON.parse(
    readFileSync(path.join(repoRoot, "roadmap", "spec-dag.json"), "utf8"),
  );
  assert.equal(exportedSnapshot.runs[0].status, "cancelled");

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

function runDispose(repoRoot, fakeQdPath, env = {}) {
  return spawnSync(
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
    },
  );
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
  cp "$root/.qd/qd.db" "$out_path"
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

function writeCanonicalizingPnpm(fakePnpmPath) {
  writeFileSync(
    fakePnpmPath,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

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
