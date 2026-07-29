import {
  legacyLifecycleApplyCommands,
  qdExportLifecycleRefusal,
  dagPath,
  loadJson,
  require,
  schema,
  targetRank,
} from "./spec-dag-shared.mjs";
import { isQdExportDag, normalizeQdExportDag, validateQdExportDag } from "./spec-dag-qd.mjs";
import { findCycles } from "./spec-dag-graph.mjs";
import { validateAlphaReadinessPath, validateNode } from "./spec-dag-validation-core.mjs";

export function assertNoQdExportLifecycleApply(command, args, rawDag) {
  if (
    legacyLifecycleApplyCommands.has(command) &&
    legacyLifecycleApplyRequested(command, args) &&
    isQdExportDag(rawDag)
  ) {
    throw new Error(qdExportLifecycleRefusal);
  }
}

export function legacyLifecycleApplyRequested(command, args) {
  return (
    args.includes("--apply") || (command === "ingest-audit" && args.includes("--apply-follow-ups"))
  );
}

export function isMainModule() {
  return (
    Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

export function loadDag() {
  return normalizeDag(loadJson(dagPath));
}

export function normalizeDag(value) {
  return isQdExportDag(value) ? normalizeQdExportDag(value) : value;
}

export function validateDag(value) {
  if (isQdExportDag(value)) {
    return validateQdExportDag(value);
  }
  return validateNativeDag(value);
}

export function validateNativeDag(value) {
  const errors = [];
  const Ajv2020 = require("ajv/dist/2020.js").default;
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    for (const error of validate.errors ?? []) {
      errors.push(`schema ${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
    }
  }
  if (value.schemaVersion !== "0.1.0") {
    errors.push("schemaVersion must be 0.1.0");
  }
  if (!Array.isArray(value.nodes)) {
    return { errors: [...errors, "nodes must be an array"] };
  }

  const ids = new Map();
  for (const [index, node] of value.nodes.entries()) {
    validateNode(node, index, errors);
    if (typeof node.id === "string") {
      if (ids.has(node.id)) {
        errors.push(`duplicate node id ${node.id}`);
      }
      ids.set(node.id, node);
    }
  }

  for (const node of value.nodes) {
    if (!Array.isArray(node.dependsOn)) {
      continue;
    }
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) {
        errors.push(`${node.id} depends on unknown node ${dependency}`);
      }
      if (dependency === node.id) {
        errors.push(`${node.id} cannot depend on itself`);
      }
      const dependencyNode = ids.get(dependency);
      if (node.status === "complete" && dependencyNode?.status !== "complete") {
        errors.push(`${node.id} is complete but depends on incomplete ${dependency}`);
      }
      if (dependencyNode && targetRank[dependencyNode.target] > targetRank[node.target]) {
        errors.push(
          `${node.id} target ${node.target} cannot depend on later ${dependencyNode.target} node ${dependency}`,
        );
      }
    }
  }

  for (const cycle of findCycles(value.nodes, ids)) {
    errors.push(`cycle detected: ${cycle.join(" -> ")}`);
  }
  for (const error of validateAlphaReadinessPath(value.nodes, ids)) {
    errors.push(error);
  }

  return { errors };
}
