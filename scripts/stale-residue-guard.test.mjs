import assert from "node:assert/strict";
import test from "node:test";
import { renderReport, scanStaleResidue } from "./stale-residue-guard.mjs";

const WORKFLOW_SCOPE_SOURCE = "apps/itotori/src/workflow/output-scope.ts";

test("fails on missing markdown link targets", () => {
  const result = scanFixture({
    "docs/README.md": "Read [missing](missing-file.md).\n",
  });

  assertViolation(result, "missing-doc-link-target");
  assert.match(renderReport(result), /missing-file\.md/u);
});

test("ignores a tracked source file pending deletion", () => {
  const result = scanStaleResidue({
    root: "/fixture",
    files: ["apps/itotori/src/orchestrator/retired.ts"],
    readFile: () => {
      throw new Error("a deleted path must not be read");
    },
    pathExists: () => false,
  });

  assert.deepEqual(result.violations, []);
  assert.equal(result.scannedFiles, 0);
});

test("fails on stale New-Game undecoded comments", () => {
  const result = scanFixture({
    [WORKFLOW_SCOPE_SOURCE]:
      "// New-Game routine does not decode, so keep reverse engineering scene 9996.\n",
  });

  assertViolation(result, "reallive-new-game-undecoded");
});

test("allows resolved MalformedExpression mentions only when explicitly marked historical", () => {
  const unresolved = scanFixture({
    [WORKFLOW_SCOPE_SOURCE]:
      "// scene 9996 hits MalformedExpression @~offset 271; investigate it next.\n",
  });
  assertViolation(unresolved, "resolved-malformed-expression-offset");

  const resolved = scanFixture({
    [WORKFLOW_SCOPE_SOURCE]:
      "// Historical snapshot: MalformedExpression @~offset 271 was resolved by the current decoder.\n",
  });
  assert.deepEqual(resolved.violations, []);
});

test("requires explicit snapshot markers for dated Traced notes", () => {
  const bare = scanFixture({
    [WORKFLOW_SCOPE_SOURCE]: "// Traced 2026-07-04 with boot_dispatch_scan.\n",
  });
  assertViolation(bare, "dated-trace-without-snapshot-marker");

  for (const marker of ["Snapshot", "Historical", "Observed", "Point-in-time", "Resolved"]) {
    const marked = scanFixture({
      [WORKFLOW_SCOPE_SOURCE]: `// ${marker}: Traced 2026-07-04 with boot_dispatch_scan.\n`,
    });
    assert.deepEqual(marked.violations, [], `expected ${marker} marker to be allowed`);
  }
});

test("fails active qd text that points at retired paths without a marker", () => {
  const result = scanFixture({
    "roadmap/spec-dag.json": JSON.stringify({
      nodes: [
        {
          id: "bad-node",
          status: "ready",
          spec: "Load presets/localize-sweetie-hd.pair-policy.json for new runs.",
          acceptance: "",
          verification: [],
        },
      ],
      node_notes: [],
    }),
  });

  assertViolation(result, "retired-game-specific-localize-preset");
});

test("fails active select_objbtn module_type=1 coordinates", () => {
  const result = scanFixture({
    "crates/utsushi-reallive/src/rlop/module_ctrl.rs":
      "//! `module_sel` at `(module_type=1, module_id=2)` handles select_objbtn.\n",
  });

  assertViolation(result, "select-objbtn-stale-module-type-one-coordinate");
});

test("allows historical select_objbtn coordinate correction notes", () => {
  const result = scanFixture({
    "crates/utsushi-reallive/src/rlop/module_sel.rs":
      "//! Historical note: select_objbtn was wrongly registered at `(module_type=1, module_id=2)`.\n",
  });

  assert.deepEqual(result.violations, []);
});

test("scopes stale premise allow markers to local match context", () => {
  const bare = scanFixture({
    "docs/README.md": "Load presets/localize-sweetie-hd.pair-policy.json for new runs.\n",
  });
  assertViolation(bare, "retired-game-specific-localize-preset");

  const marked = scanFixture({
    "docs/README.md":
      "Historical note: retired presets/localize-sweetie-hd.pair-policy.json was replaced.\n",
  });
  assert.deepEqual(marked.violations, []);

  const markerElsewhere = scanFixture({
    "docs/README.md": [
      "Historical aside: the migration was completed.",
      "",
      "",
      "",
      "Load presets/localize-sweetie-hd.pair-policy.json for new runs.",
    ].join("\n"),
  });
  assertViolation(markerElsewhere, "retired-game-specific-localize-preset");
});

test("allows active qd repair text that marks retired paths as stale", () => {
  const result = scanFixture({
    "roadmap/spec-dag.json": JSON.stringify({
      nodes: [
        {
          id: "repair-node",
          status: "claimed",
          spec: "Repair stale text that still mentions retired presets/localize-sweetie-hd.pair-policy.json.",
          acceptance: "",
          verification: [],
        },
      ],
      node_notes: [],
    }),
  });

  assert.deepEqual(result.violations, []);
});

test("fails when the facade doc cites a symbol no tracked source exports", () => {
  const result = scanFixture({
    "docs/utsushi-substrate-facade.md": [
      "## 2. Subsystem entry points",
      "| Subsystem | Owning spec | Canonical type / fn | Use when |",
      "| --- | --- | --- | --- |",
      "| Runtime VFS | UTSUSHI-020 | `RuntimeVfs`, `DeletedFacadeSymbol` | You mount. |",
      "## 3. Schema version inventory",
    ].join("\n"),
    "crates/utsushi-core/src/substrate.rs": "pub struct RuntimeVfs;\n",
  });

  assertViolation(result, "missing-exported-symbol");
});

test("passes when linked files and documented facade symbols exist", () => {
  const result = scanFixture({
    "docs/README.md": "Read [dev](dev/spec-dag.md).\n",
    "docs/dev/spec-dag.md": "# Spec DAG\n",
    "docs/utsushi-substrate-facade.md": [
      "## 2. Subsystem entry points",
      "| Subsystem | Owning spec | Canonical type / fn | Use when |",
      "| --- | --- | --- | --- |",
      "| Runtime VFS | UTSUSHI-020 | `RuntimeVfs`, `take_snapshot` | You mount. |",
      "## 3. Schema version inventory",
    ].join("\n"),
    "crates/utsushi-core/src/substrate.rs": "pub struct RuntimeVfs;\npub fn take_snapshot() {}\n",
    "roadmap/spec-dag.json": JSON.stringify({ nodes: [], node_notes: [] }),
  });

  assert.deepEqual(result.violations, []);
});

function scanFixture(files) {
  return scanStaleResidue({
    root: "/fixture",
    files: Object.keys(files),
    readFile: (path) => files[path],
    pathExists: (path) => Object.prototype.hasOwnProperty.call(files, path),
  });
}

function assertViolation(result, rule) {
  assert.ok(
    result.violations.some((violation) => violation.rule === rule),
    `expected violation ${rule}; got ${JSON.stringify(result.violations, null, 2)}`,
  );
}
