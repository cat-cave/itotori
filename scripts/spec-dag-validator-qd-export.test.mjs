import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDag, validateDag } from "./spec-dag.mjs";
import {
  assertError,
  errorsFor,
  nodeFixture,
  qdCiReuseRunFixture,
  qdExportFixture,
  qdPromotedAuditFixExport,
} from "./spec-dag-validator-test-fixtures.mjs";

test("accepts qd export shape as the canonical roadmap file shape", () => {
  const errors = validateDag(qdExportFixture()).errors;

  assert.deepEqual(errors, []);

  const normalized = normalizeDag(qdExportFixture());
  assert.equal(normalized.schemaVersion, "0.1.0");
  assert.deepEqual(normalized.nodes[1], {
    id: "capability_itotori_300",
    title: "Validate qd export roadmap gate",
    status: "planned",
    priority: "P0",
    target: "continuous",
    projects: ["itotori"],
    parallelGroup: "roadmap-infra",
    dependsOn: ["UNIV-000"],
    summary: "Make qd export the canonical roadmap/spec-dag.json shape.",
    deliverables: ["scripts/spec-dag.mjs qd export validator"],
    acceptanceCriteria: ["just roadmap-validate passes on qd export JSON"],
    verification: [{ type: "command", value: "just roadmap-validate" }],
    auditFocus: ["qd check/CI gate drift"],
  });
});

test("rejects done qd export acceptance and verification paths that are absent from disk", () => {
  const errors = validateDag(
    qdExportFixture({
      status: "done",
      acceptance: "- node scripts/missing-roadmap-validator.test.mjs passes",
      verification: [{ type: "command", value: "node scripts/missing-roadmap-validator.test.mjs" }],
    }),
  ).errors;

  assertError(
    errors,
    "capability_itotori_300 acceptance references missing repo path scripts/missing-roadmap-validator.test.mjs",
  );
  assertError(
    errors,
    "capability_itotori_300 verification[0].value references missing repo path scripts/missing-roadmap-validator.test.mjs",
  );
});

test("rejects complete native acceptance and verification paths that are absent from disk", () => {
  const errors = errorsFor(
    nodeFixture({
      status: "complete",
      acceptanceCriteria: [
        "The completed node cites presets/missing-roadmap-validator.pair-policy.json.",
      ],
      verification: [{ type: "command", value: "node scripts/missing-roadmap-validator.test.mjs" }],
    }),
  );

  assertError(
    errors,
    "VALID-001 acceptanceCriteria[0] references missing repo path presets/missing-roadmap-validator.pair-policy.json",
  );
  assertError(
    errors,
    "VALID-001 verification[0].value references missing repo path scripts/missing-roadmap-validator.test.mjs",
  );
});

test("does not reject historical or intentionally absent completed-node path references", () => {
  const errors = validateDag(
    qdExportFixture({
      status: "done",
      acceptance:
        "- The retired presets/missing-roadmap-validator.pair-policy.json path is historical.",
      verification: [
        {
          type: "command",
          value: "! test -f scripts/missing-roadmap-validator.test.mjs",
        },
      ],
    }),
  ).errors;

  assert.deepEqual(errors, []);
});

test("does not reject known no-legacy-cutover paths retained in completed qd evidence", () => {
  const errors = validateDag(
    qdExportFixture({
      status: "done",
      acceptance: "- apps/itotori/src/providers/recorded.ts was validated before the cutover.",
      verification: [{ type: "command", value: "just localize-project --dry-run" }],
    }),
  ).errors;

  assert.deepEqual(errors, []);
});

test("rejects qd export placeholder spec, acceptance, and audit-focus text", () => {
  const dag = qdExportFixture({
    spec: "test spec",
    acceptance: "test acc",
    audit_focus: ["test focus"],
  });

  const errors = validateDag(dag).errors;

  assertError(errors, "capability_itotori_300 spec is placeholder text: test spec");
  assertError(errors, "capability_itotori_300 acceptance is placeholder text: test acc");
  assertError(errors, "capability_itotori_300 audit_focus[0] is placeholder text: test focus");
});

test("rejects active qd audit-fix nodes with generic acceptance and empty evidence", () => {
  for (const status of ["ready", "claimed", "working", "review", "fixing", "ci", "mergeable"]) {
    const errors = validateDag(qdPromotedAuditFixExport({ status })).errors;

    assertError(
      errors,
      "report-id-is-a-constant-per-kind-index-pair-not-per-run audit-fix acceptance is generic: Finding is addressed and verified.",
      status,
    );
    assertError(
      errors,
      "report-id-is-a-constant-per-kind-index-pair-not-per-run audit-fix verification must have at least one entry",
      status,
    );
    assertError(
      errors,
      "report-id-is-a-constant-per-kind-index-pair-not-per-run audit-fix audit_focus must have at least one entry",
      status,
    );
  }
});

test("rejects active qd audit-fix nodes with omitted evidence arrays", () => {
  const dag = qdPromotedAuditFixExport({
    status: "review",
    acceptance:
      "- The regression fixture fails before the parser repair and passes after the repair",
  });
  delete dag.nodes[1].verification;
  delete dag.nodes[1].audit_focus;

  const errors = validateDag(dag).errors;

  assertError(
    errors,
    "report-id-is-a-constant-per-kind-index-pair-not-per-run audit-fix verification must have at least one entry",
  );
  assertError(
    errors,
    "report-id-is-a-constant-per-kind-index-pair-not-per-run audit-fix audit_focus must have at least one entry",
  );
});

test("accepts done and cancelled qd audit-fix nodes with historical generic evidence", () => {
  for (const status of ["done", "cancelled"]) {
    const errors = validateDag(
      qdPromotedAuditFixExport({
        status,
        status_reason: status === "cancelled" ? "Replaced by a concrete qd node." : null,
      }),
    ).errors;

    assert.deepEqual(errors, [], status);
  }
});

test("rejects qd export CI reuse evidence that cites local qd log paths", () => {
  const dag = qdExportFixture();
  dag.runs.push(
    qdCiReuseRunFixture({
      summary:
        "Covered by integrated qd-full-ci wave on main.\nEvidence: log_path=.qd/logs/ci-capability_itotori_300-2026-06-28T09-00-25-766Z.log",
      log_path: ".qd/logs/ci-capability_itotori_300-2026-06-28T09-00-25-766Z.log",
    }),
    qdCiReuseRunFixture({
      node_id: "UNIV-000",
      summary:
        "Covered by integrated qd-full-ci wave on main.\nEvidence: log_path=/home/trevor/projects/itotori/.qd/logs/ci-UNIV-000-2026-06-28T09-00-25-766Z.log",
      log_path: "/home/trevor/projects/itotori/.qd/logs/ci-UNIV-000-2026-06-28T09-00-25-766Z.log",
    }),
  );

  const errors = validateDag(dag).errors;

  assertError(
    errors,
    "runs[0] capability_itotori_300 ci reuse evidence log_path must not point at local-only .qd state",
  );
  assertError(
    errors,
    "runs[0] capability_itotori_300 ci reuse evidence summary must not cite local-only .qd/logs paths",
  );
  assertError(
    errors,
    "runs[1] UNIV-000 ci reuse evidence log_path must be repo-relative, not absolute",
  );
  assertError(
    errors,
    "runs[1] UNIV-000 ci reuse evidence summary must not cite local-only .qd/logs paths",
  );
});

test("rejects qd export passed-CI reuse wording that cites local qd log paths", () => {
  const dag = qdExportFixture();
  dag.runs.push(
    qdCiReuseRunFixture({
      summary:
        "Broad audit follow-up bookkeeping only; implementation CI already passed at /home/trevor/projects/itotori/.qd/logs/ci-expose-benchmark-seed-adapterids-through-catalog-api-filters-2026-06-28T01-35-46-790Z.log before the audit wave.\nEvidence: log_path=/home/trevor/projects/itotori/.qd/logs/ci-expose-benchmark-seed-adapterids-through-catalog-api-filters-2026-06-28T01-35-46-790Z.log",
      log_path:
        "/home/trevor/projects/itotori/.qd/logs/ci-expose-benchmark-seed-adapterids-through-catalog-api-filters-2026-06-28T01-35-46-790Z.log",
    }),
    qdCiReuseRunFixture({
      node_id: "UNIV-000",
      summary:
        "Safety wave qd full CI passed after catalog redaction integration; focused app API handlers passed.\nEvidence: log_path=.qd/logs/ci-harden-reallive-patch-target-canonicalization-2026-06-28T08-05-27-638Z.log",
      log_path:
        ".qd/logs/ci-harden-reallive-patch-target-canonicalization-2026-06-28T08-05-27-638Z.log",
    }),
  );

  const errors = validateDag(dag).errors;

  assertError(
    errors,
    "runs[0] capability_itotori_300 ci reuse evidence log_path must be repo-relative, not absolute",
  );
  assertError(
    errors,
    "runs[0] capability_itotori_300 ci reuse evidence summary must not cite local-only .qd/logs paths",
  );
  assertError(
    errors,
    "runs[1] UNIV-000 ci reuse evidence log_path must not point at local-only .qd state",
  );
  assertError(
    errors,
    "runs[1] UNIV-000 ci reuse evidence summary must not cite local-only .qd/logs paths",
  );
});

test("accepts qd export CI reuse evidence recorded as an external id", () => {
  const dag = qdExportFixture();
  dag.runs.push(
    qdCiReuseRunFixture({
      summary:
        "Covered by integrated qd-full-ci wave on main.\nEvidence: external_id=local-qdfullci:capability_itotori_300:2026-06-28T09-00-25Z",
      log_path: null,
    }),
  );

  const errors = validateDag(dag).errors;

  assert.deepEqual(errors, []);
});

test("rejects qd export alpha command verification that names missing recipes and tasks", () => {
  const errors = validateDag(
    qdExportFixture({
      milestone: "alpha",
      priority: "P1",
      verification: [
        { type: "command", value: "just missing-alpha-recipe --dry-run" },
        { type: "command", value: "pnpm exec vp run alpha:missing-task" },
      ],
    }),
  ).errors;

  assertError(
    errors,
    "capability_itotori_300 verification[0] references missing just recipe missing-alpha-recipe",
  );
  assertError(
    errors,
    "capability_itotori_300 verification[1] references missing vp task alpha:missing-task",
  );
});

test("rejects qd export alpha P0/P1 app test passthrough commands", () => {
  const errors = validateDag(
    qdExportFixture({
      milestone: "alpha",
      priority: "P1",
      verification: [
        {
          type: "command",
          value: "pnpm --filter @itotori/app test -- test/openrouter-live.test.ts",
        },
        {
          type: "command",
          value: "pnpm --filter @itotori/app test -- apps/itotori/test/openrouter-live.test.ts",
        },
        {
          type: "command",
          value:
            "pnpm --filter @itotori/app exec vitest run apps/itotori/test/openrouter-live.test.ts",
        },
      ],
    }),
  ).errors;

  assertError(
    errors,
    'capability_itotori_300 verification[0] must use "pnpm --filter @itotori/app exec vitest run" instead of package "test --" passthrough',
  );
  assertError(
    errors,
    'capability_itotori_300 verification[1] must use "pnpm --filter @itotori/app exec vitest run" instead of package "test --" passthrough',
  );
  assertError(
    errors,
    "capability_itotori_300 verification[1] @itotori/app test path must be package-relative, not root-relative apps/itotori/test/openrouter-live.test.ts",
  );
  assertError(
    errors,
    "capability_itotori_300 verification[2] @itotori/app test path must be package-relative, not root-relative apps/itotori/test/openrouter-live.test.ts",
  );
});

test("rejects qd export alpha include-ignored cargo commands without exact test target and filter", () => {
  const errors = validateDag(
    qdExportFixture({
      milestone: "alpha",
      priority: "P1",
      verification: [
        {
          type: "command",
          value:
            "cargo test -p utsushi-core composite_asset_package_real_bytes -- --include-ignored",
        },
      ],
    }),
  ).errors;

  assertError(
    errors,
    "capability_itotori_300 verification[0] include-ignored command must name an exact cargo integration test target and test filter",
  );
});

test("accepts qd export alpha commands that name existing recipes, tasks, and exact ignored tests", () => {
  const errors = validateDag(
    qdExportFixture({
      milestone: "alpha",
      priority: "P1",
      verification: [
        { type: "command", value: "just alpha-proof" },
        {
          type: "command",
          value: "pnpm --filter @itotori/app exec vitest run test/composition-reachability.test.ts",
        },
        {
          type: "command",
          value:
            "private inventory row=/scratch/itotori-research/sweetie-hd/extracted direnv exec . cargo test -p utsushi-core --test engine_port_sinks_bridge_real_bytes engine_port_sinks_bridge_real_bytes_pushes_text_and_frame_for_ten_ticks -- --include-ignored",
        },
      ],
    }),
  ).errors;

  assert.deepEqual(errors, []);
});
