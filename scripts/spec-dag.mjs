#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dagPath = resolve(root, "roadmap/spec-dag.json");
const schemaPath = resolve(root, "roadmap/spec-dag.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const nodeSchema = schema.$defs.node.properties;

const allowed = {
  status: new Set(nodeSchema.status.enum),
  priority: new Set(nodeSchema.priority.enum),
  target: new Set(nodeSchema.target.enum),
  project: new Set(nodeSchema.projects.items.enum),
  parallelGroup: new Set(nodeSchema.parallelGroup.enum),
  verificationType: new Set(nodeSchema.verification.items.properties.type.enum),
};

const requiredNodeFields = [
  "id",
  "title",
  "status",
  "priority",
  "target",
  "projects",
  "parallelGroup",
  "dependsOn",
  "summary",
  "deliverables",
  "acceptanceCriteria",
  "verification",
  "auditFocus",
];

const optionalNodeFields = ["statusReason", "issue", "branch", "worktree", "owner", "blockedBy"];

const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
const targetRank = { baseline: 0, mvp: 1, post_mvp: 2 };

const [command = "validate", ...args] = process.argv.slice(2);
const dag = loadDag();
const validation = validateDag(dag);

if (validation.errors.length > 0) {
  for (const error of validation.errors) {
    console.error(error);
  }
  process.exit(1);
}

switch (command) {
  case "validate":
    printValidationSummary(dag);
    break;
  case "ready":
    printNodes(readyNodes(dag), args);
    break;
  case "pop":
    printPop(dag, args);
    break;
  case "show":
    printShow(dag, args);
    break;
  case "graph":
    printDotGraph(dag);
    break;
  default:
    console.error("usage: spec-dag <validate|ready|pop|show|graph> [options]");
    process.exit(1);
}

function loadDag() {
  return JSON.parse(readFileSync(dagPath, "utf8"));
}

function validateDag(value) {
  const errors = [];
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
  for (const error of validateMvpReleasePath(value.nodes, ids)) {
    errors.push(error);
  }

  return { errors };
}

function validateMvpReleasePath(nodes, ids) {
  const releaseNode = ids.get("MVP-005");
  if (!releaseNode) {
    return ["MVP-005 release hardening node is required"];
  }
  const ancestors = ancestorsOf(releaseNode, ids);
  return nodes
    .filter(
      (node) =>
        node.priority === "P1" &&
        node.target === "mvp" &&
        node.status !== "complete" &&
        node.id !== "MVP-005" &&
        !ancestors.has(node.id),
    )
    .map((node) => `${node.id} is P1 MVP but is not an ancestor of MVP-005`);
}

function ancestorsOf(node, ids) {
  const result = new Set();
  visit(node);
  return result;

  function visit(current) {
    for (const dependency of current.dependsOn ?? []) {
      if (result.has(dependency)) {
        continue;
      }
      result.add(dependency);
      const dependencyNode = ids.get(dependency);
      if (dependencyNode) {
        visit(dependencyNode);
      }
    }
  }
}

function validateNode(node, index, errors) {
  if (!isRecord(node)) {
    errors.push(`nodes[${index}] must be an object`);
    return;
  }
  const allowedFields = new Set([...requiredNodeFields, ...optionalNodeFields]);
  for (const field of requiredNodeFields) {
    if (!(field in node)) {
      errors.push(`${node.id ?? `nodes[${index}]`} missing required field ${field}`);
    }
  }
  for (const field of Object.keys(node)) {
    if (!allowedFields.has(field)) {
      errors.push(`${node.id ?? `nodes[${index}]`} has unknown field ${field}`);
    }
  }
  if (typeof node.id !== "string" || !/^[A-Z]+-[0-9]{3}$/.test(node.id)) {
    errors.push(`nodes[${index}] id must match /^[A-Z]+-[0-9]{3}$/`);
  }
  for (const field of ["title", "parallelGroup", "summary"]) {
    if (typeof node[field] !== "string" || node[field].length === 0) {
      errors.push(`${node.id} ${field} must be a non-empty string`);
    }
  }
  for (const field of optionalNodeFields) {
    if (field in node && typeof node[field] !== "string") {
      errors.push(`${node.id} ${field} must be a string when present`);
    }
  }
  if (!allowed.status.has(node.status)) {
    errors.push(`${node.id} status is invalid: ${node.status}`);
  }
  if (!allowed.priority.has(node.priority)) {
    errors.push(`${node.id} priority is invalid: ${node.priority}`);
  }
  if (!allowed.target.has(node.target)) {
    errors.push(`${node.id} target is invalid: ${node.target}`);
  }
  if (!allowed.parallelGroup.has(node.parallelGroup)) {
    errors.push(`${node.id} parallelGroup is invalid: ${node.parallelGroup}`);
  }
  if (node.status === "blocked" && (!node.statusReason || !node.blockedBy)) {
    errors.push(`${node.id} blocked nodes require statusReason and blockedBy`);
  }
  if (node.status === "in_progress" && (!node.owner || (!node.branch && !node.worktree))) {
    errors.push(`${node.id} in_progress nodes require owner and branch or worktree`);
  }
  if (node.status === "cancelled" && !node.statusReason) {
    errors.push(`${node.id} cancelled nodes require statusReason`);
  }
  validateStringArray(node, "projects", errors, { min: 1, allowedValues: allowed.project });
  validateStringArray(node, "dependsOn", errors, { min: 0 });
  validateStringArray(node, "deliverables", errors, { min: 1 });
  validateStringArray(node, "acceptanceCriteria", errors, { min: 1 });
  validateVerification(node, errors);
  validateStringArray(node, "auditFocus", errors, { min: 1 });
}

function validateVerification(node, errors) {
  const value = node.verification;
  if (!Array.isArray(value) || value.length < 1) {
    errors.push(`${node.id} verification must be an array with at least 1 entries`);
    return;
  }
  const seen = new Set();
  for (const entry of value) {
    if (!isRecord(entry)) {
      errors.push(`${node.id} verification entries must be objects`);
      continue;
    }
    if (!allowed.verificationType.has(entry.type)) {
      errors.push(`${node.id} verification type is invalid: ${entry.type}`);
    }
    if (typeof entry.value !== "string" || entry.value.length === 0) {
      errors.push(`${node.id} verification value must be a non-empty string`);
    }
    const key = `${entry.type}:${entry.value}`;
    if (seen.has(key)) {
      errors.push(`${node.id} verification has duplicate entry ${key}`);
    }
    seen.add(key);
  }
}

function validateStringArray(node, field, errors, options) {
  const value = node[field];
  if (!Array.isArray(value) || value.length < options.min) {
    errors.push(`${node.id} ${field} must be an array with at least ${options.min} entries`);
    return;
  }
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      errors.push(`${node.id} ${field} entries must be non-empty strings`);
    }
    if (seen.has(item)) {
      errors.push(`${node.id} ${field} has duplicate entry ${item}`);
    }
    seen.add(item);
    if (options.allowedValues && !options.allowedValues.has(item)) {
      errors.push(`${node.id} ${field} contains invalid value ${item}`);
    }
  }
}

function findCycles(nodes, ids) {
  const cycles = [];
  const visiting = new Set();
  const visited = new Set();

  for (const node of nodes) {
    visit(node, []);
  }
  return cycles;

  function visit(node, path) {
    if (visited.has(node.id)) {
      return;
    }
    if (visiting.has(node.id)) {
      cycles.push([...path, node.id]);
      return;
    }
    visiting.add(node.id);
    for (const dependency of node.dependsOn ?? []) {
      const dependencyNode = ids.get(dependency);
      if (dependencyNode) {
        visit(dependencyNode, [...path, node.id]);
      }
    }
    visiting.delete(node.id);
    visited.add(node.id);
  }
}

function readyNodes(value) {
  const ids = new Map(value.nodes.map((node) => [node.id, node]));
  return sortNodes(
    value.nodes.filter(
      (node) =>
        node.status === "planned" &&
        node.dependsOn.every((dependency) => ids.get(dependency)?.status === "complete"),
    ),
  );
}

function sortNodes(nodes) {
  return [...nodes].sort((left, right) => {
    const byPriority = priorityRank[left.priority] - priorityRank[right.priority];
    if (byPriority !== 0) {
      return byPriority;
    }
    const byTarget = targetRank[left.target] - targetRank[right.target];
    if (byTarget !== 0) {
      return byTarget;
    }
    const byGroup = left.parallelGroup.localeCompare(right.parallelGroup);
    if (byGroup !== 0) {
      return byGroup;
    }
    return left.id.localeCompare(right.id);
  });
}

function printValidationSummary(value) {
  const ready = readyNodes(value);
  console.log(`spec DAG valid: ${value.nodes.length} nodes, ${ready.length} ready`);
}

function printNodes(nodes, args) {
  const filtered = filterNodes(nodes, args);
  if (args.includes("--json")) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }
  for (const node of filtered) {
    console.log(
      `${node.id}\t${node.priority}\t${node.target}\t${node.projects.join(",")}\t${node.title}`,
    );
  }
}

function printPop(value, args) {
  const [node] = filterNodes(readyNodes(value), args);
  if (!node) {
    console.error("no ready nodes match the requested filters");
    process.exit(1);
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(node, null, 2));
    return;
  }
  console.log(`${node.id}: ${node.title}`);
  console.log(
    `priority=${node.priority} target=${node.target} projects=${node.projects.join(",")}`,
  );
  console.log(`dependsOn=${node.dependsOn.join(",") || "none"}`);
}

function printShow(value, args) {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) {
    console.error("usage: spec-dag show NODE-ID [--json]");
    process.exit(1);
  }
  const node = value.nodes.find((candidate) => candidate.id === id);
  if (!node) {
    console.error(`unknown node ${id}`);
    process.exit(1);
  }
  if (args.includes("--json")) {
    console.log(JSON.stringify(node, null, 2));
    return;
  }
  console.log(`${node.id}: ${node.title}`);
  console.log(node.summary);
  console.log(`status=${node.status} priority=${node.priority} target=${node.target}`);
  console.log(`projects=${node.projects.join(",")} parallelGroup=${node.parallelGroup}`);
  console.log(`dependsOn=${node.dependsOn.join(",") || "none"}`);
}

function printDotGraph(value) {
  console.log("digraph itotori_spec_dag {");
  console.log("  rankdir=LR;");
  for (const node of value.nodes) {
    const label = `${node.id}\\n${node.priority} ${node.title.replaceAll('"', "'")}`;
    console.log(`  "${node.id}" [label="${label}"];`);
    for (const dependency of node.dependsOn) {
      console.log(`  "${dependency}" -> "${node.id}";`);
    }
  }
  console.log("}");
}

function filterNodes(nodes, args) {
  const project = flag(args, "--project");
  const target = flag(args, "--target");
  const priority = flag(args, "--priority");
  validateFilter("--project", project, allowed.project);
  validateFilter("--target", target, allowed.target);
  validateFilter("--priority", priority, allowed.priority);
  return nodes.filter(
    (node) =>
      (!project || node.projects.includes(project)) &&
      (!target || node.target === target) &&
      (!priority || node.priority === priority),
  );
}

function validateFilter(name, value, allowedValues) {
  if (value && !allowedValues.has(value)) {
    console.error(`${name} has invalid value ${value}`);
    process.exit(1);
  }
}

function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
