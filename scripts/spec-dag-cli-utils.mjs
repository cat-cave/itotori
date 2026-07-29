import { issuesFromPayload } from "./spec-dag-issues.mjs";
import { allowed, loadJson } from "./spec-dag-shared.mjs";
import { resolve } from "node:path";

export function loadExistingIssues(path) {
  if (!path) {
    return [];
  }
  let payload;
  try {
    payload = loadJson(resolve(process.cwd(), path));
  } catch (error) {
    console.error(`existing issue export ${path} failed to load: ${error.message}`);
    process.exit(1);
  }
  const issues = issuesFromPayload(payload);
  if (!Array.isArray(payload) && (!isRecord(payload) || !Array.isArray(payload.issues))) {
    console.error("existing issue export must be an array or an object with an issues array");
    process.exit(1);
  }
  return issues;
}

export function filterNodes(nodes, args) {
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

export function validateFilter(name, value, allowedValues) {
  if (value && !allowedValues.has(value)) {
    console.error(`${name} has invalid value ${value}`);
    process.exit(1);
  }
}

export function flag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function sameStringSet(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
