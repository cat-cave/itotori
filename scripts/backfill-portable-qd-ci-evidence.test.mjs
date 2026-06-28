import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBackfillToExportText,
  backfillPortableQdCiEvidence,
} from "./backfill-portable-qd-ci-evidence.mjs";
import { validateDag } from "./spec-dag.mjs";

test("backfills local qd log evidence on covered CI reuse runs to external ids", () => {
  const dag = qdExportFixture();
  dag.runs.push({
    id: "00000000-0000-4000-8000-000000000000",
    node_id: "ITOTORI-300",
    kind: "ci",
    status: "passed",
    worktree_path: null,
    agent: null,
    started_at: "2026-06-28T09:00:25.766Z",
    finished_at: "2026-06-28T09:00:25.766Z",
    summary:
      "Covered by integrated qd-full-ci wave on main.\nEvidence: log_path=/home/trevor/projects/itotori/.qd/logs/ci-cleanup-qd-full-ci-generated-compose-env-2026-06-28T09-00-25-766Z.log",
    log_path:
      "/home/trevor/projects/itotori/.qd/logs/ci-cleanup-qd-full-ci-generated-compose-env-2026-06-28T09-00-25-766Z.log",
  });

  const result = backfillPortableQdCiEvidence(dag);

  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0].index, 0);
  assert.equal(result.changed[0].id, "00000000-0000-4000-8000-000000000000");
  assert.equal(result.changed[0].node_id, "ITOTORI-300");
  assert.equal(
    result.changed[0].log_path,
    "/home/trevor/projects/itotori/.qd/logs/ci-cleanup-qd-full-ci-generated-compose-env-2026-06-28T09-00-25-766Z.log",
  );
  assert.equal(
    result.changed[0].external_id,
    "local-qdfullci:cleanup-qd-full-ci-generated-compose-env:2026-06-28T09-00-25Z",
  );
  assert.equal(dag.runs[0].log_path, null);
  assert.equal(
    dag.runs[0].summary,
    "Covered by integrated qd-full-ci wave on main.\nEvidence: external_id=local-qdfullci:cleanup-qd-full-ci-generated-compose-env:2026-06-28T09-00-25Z",
  );
  assert.deepEqual(validateDag(dag).errors, []);
});

test("applies backfill to export text without reformatting unrelated JSON", () => {
  const before =
    '{"runs":[{"summary":"Covered by integrated qd-full-ci wave.\\nEvidence: log_path=.qd/logs/ci-wave-2026-06-28T09-00-25-766Z.log","log_path":".qd/logs/ci-wave-2026-06-28T09-00-25-766Z.log","projects":["itotori","kaifuu"]}]}\n';
  const after = applyBackfillToExportText(before, [
    {
      old_summary:
        "Covered by integrated qd-full-ci wave.\nEvidence: log_path=.qd/logs/ci-wave-2026-06-28T09-00-25-766Z.log",
      new_summary:
        "Covered by integrated qd-full-ci wave.\nEvidence: external_id=local-qdfullci:wave:2026-06-28T09-00-25Z",
      log_path: ".qd/logs/ci-wave-2026-06-28T09-00-25-766Z.log",
    },
  ]);

  assert.equal(
    after,
    '{"runs":[{"summary":"Covered by integrated qd-full-ci wave.\\nEvidence: external_id=local-qdfullci:wave:2026-06-28T09-00-25Z","log_path":null,"projects":["itotori","kaifuu"]}]}\n',
  );
});

test("leaves ordinary historical CI log records unchanged", () => {
  const dag = qdExportFixture();
  dag.runs.push({
    id: "00000000-0000-4000-8000-000000000001",
    node_id: "ITOTORI-300",
    kind: "ci",
    status: "failed",
    worktree_path: null,
    agent: null,
    started_at: "2026-06-28T09:00:25.766Z",
    finished_at: "2026-06-28T09:00:25.766Z",
    summary: "ci command failed: just qd-full-ci",
    log_path: ".qd/logs/ci-ITOTORI-300-2026-06-28T09-00-25-766Z.log",
  });

  const result = backfillPortableQdCiEvidence(dag);

  assert.deepEqual(result.changed, []);
  assert.equal(dag.runs[0].log_path, ".qd/logs/ci-ITOTORI-300-2026-06-28T09-00-25-766Z.log");
});

function qdExportFixture() {
  return {
    schema_version: 1,
    exported_at: "2026-06-27T00:00:00.000Z",
    registries: {
      groups: [{ name: "baseline" }, { name: "roadmap-infra" }],
      projects: [{ name: "universal" }, { name: "itotori" }],
      milestones: [
        { name: "baseline", rank: 0 },
        { name: "continuous", rank: 4 },
      ],
    },
    nodes: [
      {
        id: "UNIV-000",
        title: "Baseline",
        kind: "feature",
        milestone: "baseline",
        status: "done",
        priority: "P0",
        owner: null,
        branch: null,
        spec: "Committed baseline.\n\nDeliverables:\n- Baseline gate",
        acceptance: "- Baseline verification passes",
        group_name: "baseline",
        status_reason: null,
        check_command: null,
        ci_command: null,
        projects: ["universal"],
        verification: [{ type: "command", value: "just check" }],
        audit_focus: ["Baseline drift"],
      },
      {
        id: "ITOTORI-300",
        title: "Validate qd export roadmap gate",
        kind: "feature",
        milestone: "continuous",
        status: "ready",
        priority: "P0",
        owner: null,
        branch: null,
        spec: "Make qd export the canonical roadmap/spec-dag.json shape.\n\nDeliverables:\n- scripts/spec-dag.mjs qd export validator",
        acceptance: "- just roadmap-validate passes on qd export JSON",
        group_name: "roadmap-infra",
        status_reason: null,
        check_command: null,
        ci_command: null,
        projects: ["itotori"],
        verification: [{ type: "command", value: "just roadmap-validate" }],
        audit_focus: ["qd check/CI gate drift"],
      },
    ],
    edges: [{ from_node: "UNIV-000", to_node: "ITOTORI-300", type: "requires" }],
    findings: [],
    runs: [],
    node_notes: [],
  };
}
