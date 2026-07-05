#!/usr/bin/env node
/*
 * RGT-005 — Real-game-testing-ready milestone readiness checklist.
 *
 * The real-game-testing-ready milestone HUB gate (parallel to ALPHA-005 for the
 * alpha tier). It proves the pre-requisite SUBSTRATE for testing real games is
 * present and aggregated under one hub — catalog / benchmark / dashboard /
 * MV-MZ-readiness / synthetic-encrypted / real-bytes-parse / dag-lint scaffolding
 * — NOT that real-game localization is a finished product.
 *
 * Evidence-first, docs-can't-drift: every readiness surface is re-derived from
 * the committed roadmap DAG (`roadmap/spec-dag.json`), never a hand-maintained
 * success string. Each named substrate surface must resolve to a real node that
 * is an ANCESTOR of RGT-005 (i.e. actually wired under the hub); if a substrate
 * node is dropped from the hub's ancestry, the checklist FAILS.
 *
 * Relationship to the validator rule: `scripts/spec-dag.mjs`'s
 * `validateAlphaReadinessPath` enforces the schema-level invariant "every
 * non-complete P1 target: real-game-testing-ready node is an ancestor of
 * RGT-005" on the NATIVE DAG shape. The committed roadmap is a qd export, so the
 * native rule is dormant there; this checklist is the qd-export-path reporter for
 * the same invariant — it runs against the real committed DAG and surfaces any
 * dangling (non-complete, non-cancelled) P1 rgt node that is not yet wired under
 * RGT-005 as a warning for the orchestrator to wire.
 *
 * Checks:
 *   A. Hub sanity — RGT-005 resolves in the DAG, is priority P1 and milestone
 *      real-game-testing-ready.
 *   B. Substrate surfaces — every named readiness surface (catalog, benchmark,
 *      dashboard/reporting, MV/MZ readiness, synthetic-encrypted, real-bytes
 *      parse, capability matrix, real-engine vertical, DAG lint) maps to nodes
 *      that resolve in the DAG AND are ancestors of RGT-005. Reports each node's
 *      status. Blocking if a surface node is missing or not wired under the hub.
 *   C. Ancestor-coverage invariant — every non-complete (status != done),
 *      non-cancelled P1 real-game-testing-ready node (other than RGT-005) is an
 *      ancestor of RGT-005. Violators are reported as warnings (dangling
 *      substrate for the orchestrator to add to RGT-005.dependsOn).
 *
 * Usage:
 *   node scripts/rgt-readiness-checklist.mjs             # run the checklist
 *   node scripts/rgt-readiness-checklist.mjs --print-surfaces
 *        # print the canonical substrate-surface -> node mapping this gate enforces
 */
"use strict";

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..");

export const SPEC_DAG_PATH = "roadmap/spec-dag.json";
export const HUB_ID = "RGT-005";
export const RGT_MILESTONE = "real-game-testing-ready";

/**
 * The canonical readiness surfaces of the real-game-testing-ready substrate,
 * mapped to the representative DAG nodes that must be wired under RGT-005. This
 * is the machine-checked definition (analogous to ALPHA-005's REQUIRED_NODE_REFS)
 * of "what the RGT milestone aggregates". Editing the substrate means editing
 * this map AND the hub's dependsOn — the checklist compares the two.
 */
export const SUBSTRATE_SURFACES = [
  {
    surface: "real-engine-vertical",
    description: "First real-engine end-to-end vertical + public-fixture run",
    nodes: ["ALPHA-001", "ALPHA-002", "ALPHA-007", "ALPHA-009"],
  },
  {
    surface: "capability-matrix",
    description: "Generated engine-capability matrix substrate",
    nodes: ["ALPHA-004"],
  },
  {
    surface: "catalog",
    description: "Local corpus scanner + benchmark seed + opportunity ranking",
    nodes: ["CATALOG-003", "CATALOG-004", "CATALOG-061"],
  },
  {
    surface: "mv-mz-readiness",
    description: "MV/MZ local corpus readiness integration",
    nodes: ["CATALOG-007"],
  },
  {
    surface: "benchmark",
    description: "Benchmark harness + set selector + QA benchmark modes + matrix runner",
    nodes: ["ALPHA-003", "ITOTORI-026", "ITOTORI-089", "ITOTORI-090", "ITOTORI-091", "ITOTORI-099"],
  },
  {
    surface: "dashboard-reporting",
    description: "Cost/quality + provider-route report renderers and export metadata",
    nodes: ["ITOTORI-092", "ITOTORI-100", "ITOTORI-039", "ITOTORI-059"],
  },
  {
    surface: "synthetic-encrypted",
    description: "Encrypted-readiness evidence + synthetic encrypted-XP3 scaffolding",
    nodes: ["KAIFUU-104", "KAIFUU-171"],
  },
  {
    surface: "real-bytes-parse",
    description: "RealLive real-bytes envelope / detector / Gameexe substrate",
    nodes: ["KAIFUU-064", "KAIFUU-188", "KAIFUU-189", "KAIFUU-190"],
  },
  {
    surface: "dag-implementability-lint",
    description: "Spec-DAG implementability lint",
    nodes: ["UNIV-021"],
  },
];

function readJson(relPath) {
  return JSON.parse(readFileSync(resolve(repoRoot, relPath), "utf8"));
}

/**
 * Build a node-id -> node map and a dependsOn map (to_node -> [from_node]) from a
 * qd-export DAG. Supports both edge-list qd exports and native nodes carrying an
 * inline `dependsOn` array, so the checklist works on either shape.
 */
export function indexDag(dag) {
  const nodesById = new Map((dag.nodes ?? []).map((n) => [n.id, n]));
  const dependsOn = new Map();
  const add = (to, from) => {
    const list = dependsOn.get(to) ?? [];
    list.push(from);
    dependsOn.set(to, list);
  };
  for (const edge of Array.isArray(dag.edges) ? dag.edges : []) {
    if (edge && typeof edge.from_node === "string" && typeof edge.to_node === "string") {
      add(edge.to_node, edge.from_node);
    }
  }
  for (const node of dag.nodes ?? []) {
    if (Array.isArray(node.dependsOn)) {
      for (const from of node.dependsOn) add(node.id, from);
    }
  }
  return { nodesById, dependsOn };
}

/** Transitive ancestor (dependency) set of `id` following the dependsOn map. */
export function ancestorsOf(id, dependsOn) {
  const seen = new Set();
  const stack = [...(dependsOn.get(id) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const parent of dependsOn.get(cur) ?? []) stack.push(parent);
  }
  return seen;
}

const isDone = (status) => status === "done" || status === "complete";

/**
 * Run the RGT readiness checklist. `dag` defaults to the committed roadmap DAG.
 * Returns `{ ok, findings }`; each finding is `{ check, severity, message }`.
 * A `blocking` finding fails the gate; `warning`/`info` do not.
 */
export function runChecklist(dag = readJson(SPEC_DAG_PATH)) {
  const findings = [];
  const fail = (check, message) => findings.push({ check, severity: "blocking", message });
  const warn = (check, message) => findings.push({ check, severity: "warning", message });
  const pass = (check, message) => findings.push({ check, severity: "info", message });

  const { nodesById, dependsOn } = indexDag(dag);
  const hub = nodesById.get(HUB_ID);

  // Check A — hub sanity.
  if (!hub) {
    fail("hub", `${HUB_ID} milestone hub node does not resolve in ${SPEC_DAG_PATH}`);
    return { ok: false, findings };
  }
  const hubMilestone = hub.milestone ?? hub.target;
  if (hubMilestone !== RGT_MILESTONE) {
    fail("hub", `${HUB_ID} milestone is ${hubMilestone}, expected ${RGT_MILESTONE}`);
  }
  if (hub.priority !== "P1") {
    fail("hub", `${HUB_ID} priority is ${hub.priority}, expected P1`);
  }
  if (!findings.some((f) => f.check === "hub" && f.severity === "blocking")) {
    pass("hub", `${HUB_ID} resolves as a P1 ${RGT_MILESTONE} milestone hub [${hub.status}]`);
  }

  const ancestors = ancestorsOf(HUB_ID, dependsOn);

  // Check B — each named substrate surface is wired under the hub.
  for (const { surface, description, nodes } of SUBSTRATE_SURFACES) {
    for (const id of nodes) {
      const node = nodesById.get(id);
      if (!node) {
        fail("substrate", `surface ${surface}: node ${id} does not resolve in ${SPEC_DAG_PATH}`);
        continue;
      }
      if (!ancestors.has(id)) {
        fail(
          "substrate",
          `surface ${surface}: node ${id} is not an ancestor of ${HUB_ID} (not wired under the hub)`,
        );
        continue;
      }
      pass(
        "substrate",
        `${surface}: ${id} [${node.status}] wired under ${HUB_ID} — ${description}`,
      );
    }
  }

  // Check C — ancestor-coverage invariant across every non-complete P1 rgt node.
  const dangling = [];
  for (const node of dag.nodes ?? []) {
    if (node.id === HUB_ID) continue;
    const milestone = node.milestone ?? node.target;
    if (milestone !== RGT_MILESTONE) continue;
    if (node.priority !== "P1") continue;
    if (isDone(node.status) || node.status === "cancelled") continue;
    if (!ancestors.has(node.id)) dangling.push(node);
  }
  if (dangling.length === 0) {
    pass("coverage", `every non-complete P1 ${RGT_MILESTONE} node is an ancestor of ${HUB_ID}`);
  } else {
    for (const node of dangling) {
      warn(
        "coverage",
        `${node.id} [${node.status}] is a non-complete P1 ${RGT_MILESTONE} node but is NOT an ancestor of ${HUB_ID}; wire it into ${HUB_ID}.dependsOn`,
      );
    }
  }

  const ok = !findings.some((f) => f.severity === "blocking");
  return { ok, findings };
}

function main(argv) {
  if (argv.includes("--print-surfaces")) {
    for (const { surface, description, nodes } of SUBSTRATE_SURFACES) {
      process.stdout.write(`${surface}: ${nodes.join(", ")}  # ${description}\n`);
    }
    return 0;
  }
  const { ok, findings } = runChecklist();
  for (const f of findings) {
    const tag = f.severity === "blocking" ? "FAIL" : f.severity === "warning" ? "WARN" : "ok";
    process.stdout.write(`[rgt-readiness] [${tag}] ${f.check}: ${f.message}\n`);
  }
  if (!ok) {
    const n = findings.filter((f) => f.severity === "blocking").length;
    process.stderr.write(`[rgt-readiness] FAILED: ${n} blocking finding(s)\n`);
    return 1;
  }
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const suffix =
    warnings > 0 ? ` (${warnings} warning(s) — substrate to wire under ${HUB_ID})` : "";
  process.stdout.write(
    `[rgt-readiness] PASS: real-game-testing-ready readiness checklist green${suffix}\n`,
  );
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

export { main };
