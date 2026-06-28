import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyMilestoneScopedJsonSummary } from "./qd-wrapper.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const wrapperPath = path.join(scriptDir, "qd-wrapper.mjs");

test("scopes qd stats --json --milestone status counts while preserving path data", () => {
  const output = applyMilestoneScopedJsonSummary(
    {
      stats: globalStatus(),
      velocity: { windowDays: 7, completedPoints: 10 },
      criticalPath: alphaCriticalPath(),
      eta: { milestone: "alpha", criticalPathPoints: 5 },
    },
    {
      command: "stats",
      exported: exportedFixture(),
      ready: readyFixture(),
      milestone: "alpha",
    },
  );

  assert.deepEqual(output.stats, {
    nodes: 3,
    ready: 1,
    byStatus: {
      done: 1,
      ready: 1,
      claimed: 1,
    },
    donePoints: 2,
    totalPoints: 10,
    remainingPoints: 8,
    openP0P1Findings: 1,
  });
  assert.equal(output.criticalPath.milestone, "alpha");
  assert.equal(output.criticalPath.criticalPathPoints, 5);
  assert.equal(output.eta.milestone, "alpha");
});

test("scopes qd snapshot --json --milestone status and ready nodes", () => {
  const output = applyMilestoneScopedJsonSummary(
    {
      schemaVersion: 1,
      status: globalStatus(),
      ready: readyFixture(),
      openFindings: [],
      criticalPath: alphaCriticalPath(),
    },
    {
      command: "snapshot",
      exported: exportedFixture(),
      ready: readyFixture(),
      milestone: "alpha",
    },
  );

  assert.deepEqual(output.status, {
    nodes: 3,
    ready: 1,
    byStatus: {
      done: 1,
      ready: 1,
      claimed: 1,
    },
    donePoints: 2,
    totalPoints: 10,
    remainingPoints: 8,
    openP0P1Findings: 1,
  });
  assert.deepEqual(
    output.ready.map((node) => node.id),
    ["ALPHA-READY"],
  );
  assert.equal(output.criticalPath.milestone, "alpha");
});

test("leaves unfiltered qd stats and snapshot output global", () => {
  const fixture = createFixture();

  const stats = runWrapper(fixture, ["stats", "--json"]);
  const snapshot = runWrapper(fixture, ["snapshot", "--json"]);

  assertOk(stats);
  assertOk(snapshot);
  assert.equal(JSON.parse(stats.stdout).stats.nodes, 99);
  assert.equal(JSON.parse(snapshot.stdout).status.nodes, 99);
  assert.deepEqual(readLog(fixture.logPath), ["stats --json", "snapshot --json"]);
});

function createFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "qd-cli-milestone-scope-"));
  const repoRoot = path.join(dir, "repo");
  const fakeQdPath = path.join(dir, "fake-qd.mjs");
  const logPath = path.join(dir, "qd.log");

  mkdirSync(path.join(repoRoot, ".qd"), { recursive: true });
  writeFakeQd(fakeQdPath);

  return { repoRoot, fakeQdPath, logPath };
}

function runWrapper(fixture, args) {
  const options = {
    cwd: fixture.repoRoot,
    env: {
      ...process.env,
      QD_REAL_BIN: fixture.fakeQdPath,
      QD_REAL_NODE_SCRIPT: "",
      QD_FAKE_LOG: fixture.logPath,
    },
    encoding: "utf8",
  };

  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [wrapperPath, "--root", fixture.repoRoot, ...args], {
        ...options,
        stderr: "pipe",
      }),
      stderr: "",
      error: null,
    };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      error,
    };
  }
}

function assertOk(result) {
  assert.equal(
    result.status,
    0,
    [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n"),
  );
}

function exportedFixture() {
  return {
    nodes: [
      { id: "ALPHA-DONE", milestone: "alpha", status: "done", estimate_points: 2 },
      { id: "ALPHA-READY", milestone: "alpha", status: "ready", estimate_points: 3 },
      { id: "ALPHA-CLAIMED", milestone: "alpha", status: "claimed", estimate_points: 5 },
      { id: "BETA-READY", milestone: "beta", status: "ready", estimate_points: 7 },
      { id: "NO-MILESTONE", milestone: null, status: "ready", estimate_points: 11 },
    ],
    findings: [
      { id: "F1", node_id: "ALPHA-READY", severity: "P1", status: "open" },
      { id: "F2", node_id: "ALPHA-CLAIMED", severity: "P2", status: "open" },
      { id: "F3", node_id: "BETA-READY", severity: "P0", status: "open" },
      { id: "F4", node_id: "ALPHA-DONE", severity: "P0", status: "resolved" },
    ],
  };
}

function readyFixture() {
  return [
    { id: "ALPHA-READY", milestone: "alpha", status: "ready", estimate_points: 3 },
    { id: "BETA-READY", milestone: "beta", status: "ready", estimate_points: 7 },
  ];
}

function globalStatus() {
  return {
    nodes: 99,
    ready: 42,
    byStatus: { done: 10, ready: 80, claimed: 9 },
    donePoints: 10,
    totalPoints: 99,
    remainingPoints: 89,
    openP0P1Findings: 4,
  };
}

function alphaCriticalPath() {
  return {
    milestone: "alpha",
    totalRemainingPoints: 8,
    criticalPathPoints: 5,
    criticalPath: [{ id: "ALPHA-CLAIMED", remainingPoints: 5 }],
  };
}

function readLog(logPath) {
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
}

function writeFakeQd(fakeQdPath) {
  writeFileSync(
    fakeQdPath,
    `#!/usr/bin/env bash
set -euo pipefail

command=""
milestone_json="null"
command_args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    stats|snapshot|export|ready)
      command="$1"
      command_args+=("$1")
      shift
      ;;
    --milestone)
      milestone_json="\\"$2\\""
      command_args+=("$1" "$2")
      shift 2
      ;;
    --milestone=*)
      milestone_json="\\"\${1#--milestone=}\\""
      command_args+=("$1")
      shift
      ;;
    --root)
      shift 2
      ;;
    *)
      command_args+=("$1")
      shift
      ;;
  esac
done

if [ -n "\${QD_FAKE_LOG:-}" ]; then
  printf '%s\\n' "\${command_args[*]}" >> "$QD_FAKE_LOG"
fi

case "$command" in
  export)
    cat <<'JSON'
{
  "nodes": [
    { "id": "ALPHA-DONE", "milestone": "alpha", "status": "done", "estimate_points": 2 },
    { "id": "ALPHA-READY", "milestone": "alpha", "status": "ready", "estimate_points": 3 },
    { "id": "ALPHA-CLAIMED", "milestone": "alpha", "status": "claimed", "estimate_points": 5 },
    { "id": "BETA-READY", "milestone": "beta", "status": "ready", "estimate_points": 7 },
    { "id": "NO-MILESTONE", "milestone": null, "status": "ready", "estimate_points": 11 }
  ],
  "findings": [
    { "id": "F1", "node_id": "ALPHA-READY", "severity": "P1", "status": "open" },
    { "id": "F2", "node_id": "ALPHA-CLAIMED", "severity": "P2", "status": "open" },
    { "id": "F3", "node_id": "BETA-READY", "severity": "P0", "status": "open" },
    { "id": "F4", "node_id": "ALPHA-DONE", "severity": "P0", "status": "resolved" }
  ]
}
JSON
    ;;
  ready)
    cat <<'JSON'
[
  { "id": "ALPHA-READY", "milestone": "alpha", "status": "ready", "estimate_points": 3 },
  { "id": "BETA-READY", "milestone": "beta", "status": "ready", "estimate_points": 7 }
]
JSON
    ;;
  stats)
    cat <<JSON
{
  "stats": {
    "nodes": 99,
    "ready": 42,
    "byStatus": { "done": 10, "ready": 80, "claimed": 9 },
    "donePoints": 10,
    "totalPoints": 99,
    "remainingPoints": 89,
    "openP0P1Findings": 4
  },
  "velocity": { "windowDays": 7, "completedPoints": 10 },
  "criticalPath": {
    "milestone": $milestone_json,
    "totalRemainingPoints": 8,
    "criticalPathPoints": 5,
    "criticalPath": [{ "id": "ALPHA-CLAIMED", "remainingPoints": 5 }]
  },
  "eta": { "milestone": $milestone_json, "criticalPathPoints": 5 }
}
JSON
    ;;
  snapshot)
    cat <<JSON
{
  "schemaVersion": 1,
  "status": {
    "nodes": 99,
    "ready": 42,
    "byStatus": { "done": 10, "ready": 80, "claimed": 9 },
    "donePoints": 10,
    "totalPoints": 99,
    "remainingPoints": 89,
    "openP0P1Findings": 4
  },
  "ready": [
    { "id": "ALPHA-READY", "milestone": "alpha", "status": "ready", "estimate_points": 3 },
    { "id": "BETA-READY", "milestone": "beta", "status": "ready", "estimate_points": 7 }
  ],
  "openFindings": [],
  "criticalPath": {
    "milestone": $milestone_json,
    "totalRemainingPoints": 8,
    "criticalPathPoints": 5,
    "criticalPath": [{ "id": "ALPHA-CLAIMED", "remainingPoints": 5 }]
  }
}
JSON
    ;;
  *)
    exit 2
    ;;
esac
`,
  );
  chmodSync(fakeQdPath, 0o755);
}
