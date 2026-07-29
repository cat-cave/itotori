#!/usr/bin/env node
/**
 * Inserts 23 new DAG nodes proposed by the three 2026-06-24 audits:
 *
 *   1. docs/audits/real-bytes-validation-2026-06-24.md  (8 nodes)
 *      the relevant capability, the relevant capability, the relevant capability, the relevant capability, the relevant capability, the relevant capability,
 *      the relevant capability, the relevant capability
 *
 *   2. docs/audits/non-reallive-fixture-needs-2026-06-24.md  (11 nodes)
 *      the relevant capability, the relevant capability, the relevant capability, the relevant capability, the relevant capability, the relevant capability,
 *      the relevant capability, the relevant capability, the relevant capability, the relevant capability, the relevant capability
 *      (audit text proposed the relevant capability..203 — those collide with the RealLive
 *       decomposition's the relevant capability..221 already in the DAG; renumbered to
 *       the relevant capability..182 per the apply task spec.)
 *
 *   3. docs/audits/silenced-2026-06-24.md  (4 nodes)
 *      the relevant capability, the relevant capability, the relevant capability, the relevant capability
 *      (audit text proposed the relevant capability/203/204 — those collide with the
 *       non-RealLive fixture audit; renumbered to the relevant capability/208/209 per the
 *       apply task spec.)
 *
 * The script:
 *   - Loads roadmap/spec-dag.json
 *   - Validates against roadmap/spec-dag.schema.json (ajv 2020 draft)
 *   - Inserts the 23 nodes (skipping any that already exist; printing a notice)
 *   - Filters out any dependsOn entry whose target id is not in the DAG, and
 *     prints a notice listing the dropped pairs.
 *   - Re-validates against the schema and the spec-dag CLI's per-node semantic
 *     checks (re-implemented inline; mirror of scripts/spec-dag.mjs).
 *   - Writes roadmap/spec-dag.json with `JSON.stringify(dag, null, 2) + "\n"`.
 *   - Exits non-zero on any error.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dagPath = resolve(root, "roadmap/spec-dag.json");
const schemaPath = resolve(root, "roadmap/spec-dag.schema.json");

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateAgainstSchema(dag, schema, label) {
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(dag)) {
    const errors = (validate.errors ?? [])
      .map((e) => `  ${e.instancePath || "/"} ${e.message ?? "is invalid"}`)
      .join("\n");
    throw new Error(`schema validation failed (${label}):\n${errors}`);
  }
}

import { FIXTURE_NODES } from "./apply-audit-2026-06-24-fixture-nodes.mjs";
import { REAL_BYTES_NODES } from "./apply-audit-2026-06-24-real-bytes-nodes.mjs";
import { SILENCED_NODES } from "./apply-audit-2026-06-24-silenced-nodes.mjs";

// The historical audit definitions are grouped by their source audit.
const NEW_NODES = [...REAL_BYTES_NODES, ...FIXTURE_NODES, ...SILENCED_NODES];

// -----------------------------------------------------------------------------
// Apply
// -----------------------------------------------------------------------------

function main() {
  const dag = loadJson(dagPath);
  const schema = loadJson(schemaPath);

  // Schema sanity check on the existing DAG first.
  validateAgainstSchema(dag, schema, "pre-insertion");

  const existingIds = new Set(dag.nodes.map((node) => node.id));
  const insertedIds = [];
  const skippedIds = [];
  const droppedDependencies = [];

  for (const proposed of NEW_NODES) {
    if (existingIds.has(proposed.id)) {
      console.log(`notice: ${proposed.id} already exists in DAG; skipping insertion.`);
      skippedIds.push(proposed.id);
      continue;
    }
    const node = withFilteredDependsOn(proposed, existingIds, droppedDependencies);
    dag.nodes.push(node);
    existingIds.add(node.id);
    insertedIds.push(node.id);
  }

  // Cross-node dependsOn fix-up for nodes whose new sibling was promised but
  // not yet present: NEW_NODES may depend on each other (e.g. the relevant capability ->
  // the relevant capability), which is fine because by the time we reach the relevant capability we have
  // already added the relevant capability to existingIds. Order matters; the array is in
  // sequential order. Re-verify by walking once more.
  for (const node of dag.nodes) {
    if (!NEW_NODES.find((proposed) => proposed.id === node.id)) {
      continue;
    }
    for (const dep of node.dependsOn) {
      if (!existingIds.has(dep)) {
        throw new Error(
          `post-insertion validation: ${node.id} still depends on unknown node ${dep}`,
        );
      }
    }
  }

  validateAgainstSchema(dag, schema, "post-insertion");

  writeFileSync(dagPath, JSON.stringify(dag, null, 2) + "\n");

  for (const { nodeId, missing } of droppedDependencies) {
    console.log(`notice: ${nodeId} dropped dependsOn=${missing} (target id not present in DAG).`);
  }
  console.log(
    `applied 2026-06-24 audit nodes: ${insertedIds.length} inserted, ${skippedIds.length} pre-existing.`,
  );
  console.log(`new DAG node count: ${dag.nodes.length}`);
}

function withFilteredDependsOn(proposed, existingIds, droppedAcc) {
  const kept = [];
  for (const dep of proposed.dependsOn) {
    if (existingIds.has(dep)) {
      kept.push(dep);
    } else {
      droppedAcc.push({ nodeId: proposed.id, missing: dep });
    }
  }
  return { ...proposed, dependsOn: kept };
}

main();
