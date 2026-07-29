import {
  allowed,
  isRecord,
  qdActiveAuditFixStatuses,
  qdAllowedStatuses,
  qdCiReuseSummaryPattern,
  qdEvidenceLogPathPattern,
  qdExportSchemaVersions,
  qdGenericAuditFixAcceptancePattern,
  qdLocalLogPathPattern,
  qdPlaceholderTextPattern,
  qdStatusMap,
  root,
  schema,
  windowsAbsolutePathPattern,
} from "./spec-dag-shared.mjs";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { findCycles } from "./spec-dag-graph.mjs";
import { validateQdAcceptanceVerificationPaths } from "./spec-dag-validation-core.mjs";
import { validateAlphaCommandReferences } from "./spec-dag-validation-commands.mjs";

export function isQdExportDag(value) {
  return isRecord(value) && "schema_version" in value;
}

export function validateQdExportDag(value) {
  const errors = [];
  if (!qdExportSchemaVersions.has(value.schema_version)) {
    errors.push(`schema_version must be one of ${[...qdExportSchemaVersions].join(", ")}`);
  }
  if (!Array.isArray(value.nodes)) {
    return { errors: [...errors, "nodes must be an array"] };
  }
  if (!isRecord(value.registries)) {
    errors.push("registries must be an object");
  } else {
    validateQdRegistry(value.registries, "milestones", errors);
    validateQdRegistry(value.registries, "groups", errors);
    validateQdRegistry(value.registries, "projects", errors);
  }

  const ids = new Map();
  for (const [index, node] of value.nodes.entries()) {
    validateQdNode(node, index, errors);
    if (isRecord(node) && typeof node.id === "string") {
      if (ids.has(node.id)) {
        errors.push(`duplicate node id ${node.id}`);
      }
      ids.set(node.id, node);
    }
  }

  const edges = Array.isArray(value.edges) ? value.edges : [];
  if (!Array.isArray(value.edges)) {
    errors.push("edges must be an array");
  }
  for (const [index, edge] of edges.entries()) {
    validateQdEdge(edge, index, ids, errors);
  }
  validateQdRuns(value.runs, errors);
  const normalizedDag = normalizeQdExportDag(value);
  const normalizedIds = new Map(normalizedDag.nodes.map((node) => [node.id, node]));
  for (const cycle of findCycles(normalizedDag.nodes, normalizedIds)) {
    errors.push(`cycle detected: ${cycle.join(" -> ")}`);
  }
  errors.push(...validateAlphaCommandReferences(normalizedDag.nodes));

  return { errors };
}

export function normalizeQdExportDag(value) {
  const dependsOnByNode = new Map();
  for (const edge of Array.isArray(value.edges) ? value.edges : []) {
    if (!isRecord(edge) || typeof edge.from_node !== "string" || typeof edge.to_node !== "string") {
      continue;
    }
    const dependsOn = dependsOnByNode.get(edge.to_node) ?? [];
    dependsOn.push(edge.from_node);
    dependsOnByNode.set(edge.to_node, dependsOn);
  }

  return {
    schemaVersion: "0.1.0",
    metadata: {
      generatedFrom: "qd export",
      currentBaseline: "qd export",
      priorityDefinitions: schema.properties.metadata.properties.priorityDefinitions.properties,
      statusDefinitions: schema.properties.metadata.properties.statusDefinitions.properties,
    },
    nodes: (Array.isArray(value.nodes) ? value.nodes : []).map((node) =>
      normalizeQdExportNode(node, dependsOnByNode.get(node.id) ?? []),
    ),
  };
}

export function normalizeQdExportNode(node, dependsOn) {
  const { summary, deliverables } = splitQdSpec(node.spec);
  const acceptanceCriteria = splitQdList(node.acceptance);
  const normalized = {
    id: node.id,
    title: node.title,
    status: qdStatusMap[node.status] ?? node.status,
    priority: node.priority,
    target: node.milestone ?? "continuous",
    projects: Array.isArray(node.projects) ? node.projects : [],
    parallelGroup: node.group_name ?? "roadmap-infra",
    dependsOn,
    summary,
    deliverables,
    acceptanceCriteria,
    verification: Array.isArray(node.verification) ? node.verification : [],
    auditFocus: Array.isArray(node.audit_focus) ? node.audit_focus : [],
  };
  if (typeof node.status_reason === "string" && node.status_reason.length > 0) {
    normalized.statusReason = node.status_reason;
  }
  if (typeof node.owner === "string" && node.owner.length > 0) {
    normalized.owner = node.owner;
  }
  if (typeof node.branch === "string" && node.branch.length > 0) {
    normalized.branch = node.branch;
  }
  return normalized;
}

export function splitQdSpec(value) {
  if (typeof value !== "string") {
    return { summary: "", deliverables: [] };
  }
  const [summaryText, deliverableText] = value.split(/\n\nDeliverables:\n/u, 2);
  const deliverables =
    deliverableText === undefined ? [] : splitQdList(deliverableText).filter(Boolean);
  return {
    summary: summaryText.trim(),
    deliverables: deliverables.length > 0 ? deliverables : [summaryText.trim()].filter(Boolean),
  };
}

export function splitQdList(value) {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(/\n/u)
    .map((line) => line.replace(/^\s*-\s?/u, "").trim())
    .filter(Boolean);
}

export function validateQdRegistry(registries, field, errors) {
  const entries = registries[field];
  if (!Array.isArray(entries)) {
    errors.push(`registries.${field} must be an array`);
    return;
  }
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.length === 0) {
      errors.push(`registries.${field}[${index}] must have a non-empty name`);
      continue;
    }
    if (seen.has(entry.name)) {
      errors.push(`registries.${field} has duplicate entry ${entry.name}`);
    }
    seen.add(entry.name);
  }
}

export function validateQdNode(node, index, errors) {
  const displayId = isRecord(node) && typeof node.id === "string" ? node.id : `nodes[${index}]`;
  if (!isRecord(node)) {
    errors.push(`nodes[${index}] must be an object`);
    return;
  }
  for (const field of ["id", "title", "status", "priority", "spec", "acceptance"]) {
    if (typeof node[field] !== "string" || node[field].length === 0) {
      errors.push(`${displayId} ${field} must be a non-empty string`);
    }
  }
  if (typeof node.id === "string" && /\s/u.test(node.id)) {
    errors.push(`${displayId} id must not contain whitespace`);
  }
  if (!qdAllowedStatuses.has(node.status)) {
    errors.push(`${displayId} status is invalid: ${node.status}`);
  }
  if (!allowed.priority.has(node.priority)) {
    errors.push(`${displayId} priority is invalid: ${node.priority}`);
  }
  if (node.projects !== null && node.projects !== undefined && !Array.isArray(node.projects)) {
    errors.push(`${displayId} projects must be an array when present`);
  } else if (Array.isArray(node.projects)) {
    const seenProjects = new Set();
    for (const project of node.projects) {
      if (typeof project !== "string" || project.length === 0) {
        errors.push(`${displayId} projects entries must be non-empty strings`);
      }
      if (seenProjects.has(project)) {
        errors.push(`${displayId} projects has duplicate entry ${project}`);
      }
      seenProjects.add(project);
    }
  }
  validateQdVerification(node, errors);
  validateQdStringArray(node, "audit_focus", errors);
  validateQdActiveAuditFixNode(node, displayId, errors);
  validateQdAcceptanceVerificationPaths(node, displayId, errors);
  for (const [field, value] of [
    ["title", node.title],
    ["spec", node.spec],
    ["acceptance", node.acceptance],
    ...(Array.isArray(node.audit_focus)
      ? node.audit_focus.map((entry, auditIndex) => [`audit_focus[${auditIndex}]`, entry])
      : []),
  ]) {
    if (
      node.status !== "cancelled" &&
      typeof value === "string" &&
      qdPlaceholderTextPattern.test(value.trim())
    ) {
      errors.push(`${displayId} ${field} is placeholder text: ${value}`);
    }
  }
  if (node.status === "blocked" && typeof node.status_reason !== "string") {
    errors.push(`${displayId} blocked nodes require status_reason`);
  }
}

export function validateQdActiveAuditFixNode(node, displayId, errors) {
  if (node.kind !== "audit-fix" || !qdActiveAuditFixStatuses.has(node.status)) {
    return;
  }
  if (
    typeof node.acceptance === "string" &&
    qdGenericAuditFixAcceptancePattern.test(node.acceptance.trim())
  ) {
    errors.push(`${displayId} audit-fix acceptance is generic: ${node.acceptance}`);
  }
  if (!Array.isArray(node.verification) || node.verification.length === 0) {
    errors.push(`${displayId} audit-fix verification must have at least one entry`);
  }
  if (!Array.isArray(node.audit_focus) || node.audit_focus.length === 0) {
    errors.push(`${displayId} audit-fix audit_focus must have at least one entry`);
  }
}

export function validateQdVerification(node, errors) {
  if (!Array.isArray(node.verification)) {
    errors.push(`${node.id} verification must be an array`);
    return;
  }
  const seen = new Set();
  for (const [index, entry] of node.verification.entries()) {
    if (!isRecord(entry)) {
      errors.push(`${node.id} verification[${index}] must be an object`);
      continue;
    }
    if (!allowed.verificationType.has(entry.type)) {
      errors.push(`${node.id} verification[${index}] type is invalid: ${entry.type}`);
    }
    if (typeof entry.value !== "string" || entry.value.length === 0) {
      errors.push(`${node.id} verification[${index}] value must be a non-empty string`);
    }
    const key = `${entry.type}:${entry.value}`;
    if (seen.has(key)) {
      errors.push(`${node.id} verification has duplicate entry ${key}`);
    }
    seen.add(key);
  }
}

export function validateQdStringArray(node, field, errors) {
  const value = node[field];
  if (value === null || value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(`${node.id} ${field} must be an array`);
    return;
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      errors.push(`${node.id} ${field} entries must be non-empty strings`);
    }
  }
}

export function validateQdEdge(edge, index, ids, errors) {
  if (!isRecord(edge)) {
    errors.push(`edges[${index}] must be an object`);
    return;
  }
  const fromNode = edge.from_node;
  const toNode = edge.to_node;
  if (typeof fromNode !== "string" || fromNode.length === 0) {
    errors.push(`edges[${index}] from_node must be a non-empty string`);
  } else if (!ids.has(fromNode)) {
    errors.push(`edge ${fromNode} -> ${toNode} references unknown from_node ${fromNode}`);
  }
  if (typeof toNode !== "string" || toNode.length === 0) {
    errors.push(`edges[${index}] to_node must be a non-empty string`);
  } else if (!ids.has(toNode)) {
    errors.push(`edge ${fromNode} -> ${toNode} references unknown to_node ${toNode}`);
  }
  if (fromNode === toNode) {
    errors.push(`edge ${fromNode} -> ${toNode} cannot reference the same node`);
  }
  if (edge.type !== undefined && edge.type !== "requires") {
    errors.push(`edge ${fromNode} -> ${toNode} type is invalid: ${edge.type}`);
  }
}

export function validateQdRuns(runs, errors) {
  if (runs === null || runs === undefined) {
    return;
  }
  if (!Array.isArray(runs)) {
    errors.push("runs must be an array when present");
    return;
  }

  for (const [index, run] of runs.entries()) {
    if (!isRecord(run)) {
      errors.push(`runs[${index}] must be an object`);
      continue;
    }
    validateQdRunPortableCiReuseEvidence(run, index, errors);
  }
}

export function validateQdRunPortableCiReuseEvidence(run, index, errors) {
  if (!isQdCiReuseEvidenceRun(run)) {
    return;
  }

  const display = `runs[${index}] ${run.node_id ?? "unknown-node"} ci reuse evidence`;
  const logPath = run.log_path;
  if (typeof logPath === "string" && logPath.length > 0) {
    validatePortableQdCiEvidenceLogPath(display, logPath, errors);
  }

  const summary = typeof run.summary === "string" ? run.summary : "";
  if (qdLocalLogPathPattern.test(summary)) {
    errors.push(
      `${display} summary must not cite local-only .qd/logs paths; use external_id, URL, or repo-relative checked-in evidence`,
    );
  }
  const evidenceLogPath = summary.match(qdEvidenceLogPathPattern)?.[1];
  if (evidenceLogPath) {
    validatePortableQdCiEvidenceLogPath(
      `${display} summary Evidence: log_path`,
      evidenceLogPath,
      errors,
    );
  }
}

export function validatePortableQdCiEvidenceLogPath(display, value, errors) {
  if (isAbsolute(value) || windowsAbsolutePathPattern.test(value)) {
    errors.push(`${display} log_path must be repo-relative, not absolute: ${value}`);
    return;
  }
  const normalized = normalizeRepoRelativePath(value);
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    errors.push(`${display} log_path must stay inside the repo: ${value}`);
    return;
  }
  if (normalized === ".qd" || normalized.startsWith(".qd/")) {
    errors.push(`${display} log_path must not point at local-only .qd state: ${value}`);
    return;
  }
  if (normalized === "artifacts" || normalized.startsWith("artifacts/")) {
    errors.push(`${display} log_path must not point at gitignored artifacts: ${value}`);
    return;
  }

  const resolved = resolve(root, normalized);
  if (!existsSync(resolved)) {
    errors.push(`${display} log_path evidence file does not exist: ${normalized}`);
    return;
  }
  if (!statSync(resolved).isFile()) {
    errors.push(`${display} log_path evidence is not a file: ${normalized}`);
  }
}

export function isQdCiReuseEvidenceRun(run) {
  return (
    run.kind === "ci" &&
    run.status === "passed" &&
    typeof run.summary === "string" &&
    qdCiReuseSummaryPattern.test(run.summary)
  );
}

export function normalizeRepoRelativePath(value) {
  return value
    .replaceAll("\\", "/")
    .replace(/\/+/gu, "/")
    .split("/")
    .reduce((parts, part) => {
      if (!part || part === ".") return parts;
      if (part === "..") {
        if (parts.length === 0 || parts.at(-1) === "..") parts.push(part);
        else parts.pop();
        return parts;
      }
      parts.push(part);
      return parts;
    }, [])
    .join("/");
}
