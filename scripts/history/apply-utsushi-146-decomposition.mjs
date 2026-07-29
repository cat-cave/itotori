#!/usr/bin/env node
/**
 * Translates the structured 22-node decomposition in
 * docs/research/reallive-engine-dag-proposal.md into spec-dag.json entries.
 *
 * Plan:
 *   - Load roadmap/spec-dag.json and validate against the schema.
 *   - Mark the relevant capability as `cancelled`, retain all other fields, retarget the
 *     summary at the decomposition doc.
 *   - Insert 22 new nodes (the relevant capability .. the relevant capability) right after the relevant capability,
 *     drawn verbatim where possible from the proposal doc.
 *   - Re-validate against the schema; bail loudly on any error.
 *   - Write with JSON.stringify(dag, null, 2) + "\n" (the spec-dag lifecycle
 *     canonicalizer reformats on subsequent CLI runs).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { NODE_SPECS_FOUNDATION } from "./decomposition-foundation.mjs";
import { NODE_SPECS_RUNTIME } from "./decomposition-runtime.mjs";
import { NODE_SPECS_SUBSYSTEMS } from "./decomposition-subsystems.mjs";
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
// ID mapping helpers ---------------------------------------------------------

// Proposal "146x" -> numeric DAG id (200 .. 221).
const SUFFIX_LETTERS = "abcdefghijklmnopqrstuv".split("");
const ID_BY_SUFFIX = new Map(
  SUFFIX_LETTERS.map((letter, index) => [letter, `UTSUSHI-${200 + index}`]),
);
function mapProposalIdToDagId(suffix) {
  const id = ID_BY_SUFFIX.get(suffix);
  if (!id) throw new Error(`unknown proposal suffix: ${suffix}`);
  return id;
}
// Common fields applied to every sub-node -----------------------------------
const COMMON = {
  projects: ["utsushi"],
  parallelGroup: "runtime-adapters",
  status: "planned",
};

// P1 nodes per task scope: 200, 201, 202, 203, 204, 205, 207, 208, 209, 211,
// 213, 212, 216, 219, 221. All others P2.
const P1_IDS = new Set([
  "capability_utsushi_200",
  "capability_utsushi_201",
  "capability_utsushi_202",
  "capability_utsushi_203",
  "capability_utsushi_204",
  "capability_utsushi_205",
  "capability_utsushi_207",
  "capability_utsushi_208",
  "capability_utsushi_209",
  "capability_utsushi_211",
  "capability_utsushi_212",
  "capability_utsushi_213",
  "capability_utsushi_216",
  "capability_utsushi_219",
  "capability_utsushi_221",
]);

function priorityFor(id) {
  return P1_IDS.has(id) ? "P1" : "P2";
}

function targetFor(id) {
  return id === "capability_utsushi_200" ? "alpha" : "continuous";
}

// ---------------------------------------------------------------------------
// Per-node content. Acceptance criteria and audit focus are drawn verbatim
// from the proposal doc; verification commands map to {type:"command"} entries.
// Deliverables are derived from the proposal title + acceptance criteria so
// each node has 4-6 concrete bullets.
// ---------------------------------------------------------------------------

const NODE_SPECS = [...NODE_SPECS_FOUNDATION, ...NODE_SPECS_RUNTIME, ...NODE_SPECS_SUBSYSTEMS];

// ---------------------------------------------------------------------------
// Build node objects and apply mutations.
// ---------------------------------------------------------------------------

function buildNode(spec) {
  const id = mapProposalIdToDagId(spec.suffix);
  const dependsOnFromProposal = (spec.dependsOnProposal ?? []).map(mapProposalIdToDagId);
  const extraDeps = spec.extraDeps ?? [];
  const dependsOn = [...new Set([...dependsOnFromProposal, ...extraDeps])];
  const verification = spec.verification.map(([type, value]) => ({ type, value }));
  return {
    id,
    title: spec.title,
    status: COMMON.status,
    priority: priorityFor(id),
    target: targetFor(id),
    projects: COMMON.projects,
    parallelGroup: COMMON.parallelGroup,
    dependsOn,
    summary: spec.summary,
    deliverables: spec.deliverables,
    acceptanceCriteria: spec.acceptanceCriteria,
    verification,
    auditFocus: spec.auditFocus,
  };
}

function applyDecomposition(dag) {
  const nodes = dag.nodes;
  const oldIdx = nodes.findIndex((n) => n.id === "capability_utsushi_146");
  if (oldIdx === -1) throw new Error("capability_utsushi_146 not found in DAG");

  const oldNode = nodes[oldIdx];
  if (oldNode.status === "cancelled") {
    throw new Error(
      "capability_utsushi_146 already cancelled — refusing to re-apply decomposition",
    );
  }

  // Marks the relevant capability cancelled, points the summary at the decomposition, and
  // attaches the required statusReason. Drops the alpha target so the cancelled
  // shell does not re-flag the alpha-readiness gate (the alpha claim is carried
  // by the relevant capability — the crate skeleton — per docs/audits/alpha-scope-honesty.md
  // §D). Other fields (priority, projects, parallelGroup, deliverables,
  // acceptanceCriteria, verification, auditFocus) stay.
  oldNode.status = "cancelled";
  oldNode.target = "continuous";
  oldNode.statusReason =
    "Decomposed into capability_utsushi_200..capability_utsushi_221 per docs/research/reallive-engine-dag-proposal.md; per docs/audits/alpha-scope-honesty.md §D + docs/alpha-localization-project-readiness.md, only the crate-skeleton (capability_utsushi_200) retains target=alpha. End-to-end scene-1 replay (originally capability_utsushi_146) lands as capability_utsushi_219.";
  oldNode.summary =
    "Superseded by the 22-node decomposition in docs/research/reallive-engine-dag-proposal.md (capability_utsushi_200..capability_utsushi_221). Original scope split into: foundation (utsushi-reallive crate skeleton, Seen.txt directory parser, scene header, LZ+XOR decompressor, element-stream decoder, expression evaluator, variable banks); Gameexe parser; VM (fetch/decode/dispatch, control flow, text/messaging, choice, string/memory/arithmetic); subsystems (syscall dispatch, graphics stack, graphics RLOps, g00 decoder, audio, save/load); game-state-machine (XOR-2 key research, end-to-end scene-1 smoke, cross-engine conformance). The original 'rlvm referenced only as research anchor, never invoked as a binary' acceptance criterion propagates to every sub-node.";

  // Build the 22 new nodes and insert directly after the relevant capability.
  const newNodes = NODE_SPECS.map(buildNode);

  // Sanity-check: every node has the minimum required content.
  for (const node of newNodes) {
    if (!node.acceptanceCriteria?.length) {
      throw new Error(`${node.id} missing acceptanceCriteria`);
    }
    if (!node.deliverables?.length) {
      throw new Error(`${node.id} missing deliverables`);
    }
    if (!node.verification?.length) {
      throw new Error(`${node.id} missing verification`);
    }
    if (!node.auditFocus?.length) {
      throw new Error(`${node.id} missing auditFocus`);
    }
  }

  nodes.splice(oldIdx + 1, 0, ...newNodes);

  // Rewrite stale `the relevant capability` dependsOn entries in callers. Both current
  // callers (ALPHA-006, the relevant capability) are target=alpha, and the schema
  // enforces target ordering (alpha cannot depend on continuous). The honest
  // route therefore points each caller at the relevant capability — the only alpha
  // sub-node and the explicit alpha claim per docs/audits/alpha-scope-honesty.md
  // §D + docs/alpha-localization-project-readiness.md redefinition. The
  // end-to-end smoke (the relevant capability) and cross-engine conformance (the relevant capability)
  // are continuous follow-ups, not alpha gates.
  const rewrites = [];
  for (const node of nodes) {
    if (node.id === "capability_utsushi_146") continue;
    if (!node.dependsOn?.includes("capability_utsushi_146")) continue;
    node.dependsOn = node.dependsOn.map((dep) =>
      dep === "capability_utsushi_146" ? "capability_utsushi_200" : dep,
    );
    rewrites.push(node.id);
  }

  return {
    addedCount: newNodes.length,
    addedIds: newNodes.map((n) => n.id),
    rewrittenCallers: rewrites,
  };
}

// ---------------------------------------------------------------------------

function main() {
  const schema = loadJson(schemaPath);
  const dag = loadJson(dagPath);

  validateAgainstSchema(dag, schema, "pre-mutation");

  const result = applyDecomposition(dag);

  validateAgainstSchema(dag, schema, "post-mutation");

  writeFileSync(dagPath, `${JSON.stringify(dag, null, 2)}\n`);

  process.stdout.write(
    `applied capability_utsushi_146 decomposition: ${result.addedCount} new nodes (${result.addedIds[0]}..${result.addedIds.at(-1)}), capability_utsushi_146 marked cancelled, rewrote stale callers ${JSON.stringify(result.rewrittenCallers)}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`apply-capability_utsushi_146-decomposition failed: ${error.message}\n`);
  process.exit(1);
}
