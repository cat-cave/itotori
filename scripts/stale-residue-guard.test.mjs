import assert from "node:assert/strict";
import test from "node:test";
import { renderReport, scanStaleResidue } from "./stale-residue-guard.mjs";

test("fails on missing markdown link targets", () => {
  const result = scanFixture({
    "docs/README.md": "Read [missing](missing-file.md).\n",
  });

  assertViolation(result, "missing-doc-link-target");
  assert.match(renderReport(result), /missing-file\.md/u);
});

test("fails on stale New-Game undecoded comments", () => {
  const result = scanFixture({
    "apps/itotori/src/agents/work-scope/manifest.ts":
      "// New-Game routine does not decode, so keep reverse engineering scene 9996.\n",
  });

  assertViolation(result, "reallive-new-game-undecoded");
});

test("allows resolved MalformedExpression mentions only when explicitly marked historical", () => {
  const unresolved = scanFixture({
    "apps/itotori/src/agents/work-scope/carve.ts":
      "// scene 9996 hits MalformedExpression @~offset 271; investigate it next.\n",
  });
  assertViolation(unresolved, "resolved-malformed-expression-offset");

  const resolved = scanFixture({
    "apps/itotori/src/agents/work-scope/carve.ts":
      "// Historical snapshot: MalformedExpression @~offset 271 was resolved by the current decoder.\n",
  });
  assert.deepEqual(resolved.violations, []);
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

  assertViolation(result, "retired-localize-sweetie-hd-preset");
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
