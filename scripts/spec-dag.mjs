#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import {
  createIssueSyncPlan,
  issuesFromPayload,
  issueSyncLabelTaxonomy,
  issueSyncManagedLabelPrefixes,
  normalizeExistingIssues,
  renderIssueSyncDryRun,
} from "./spec-dag-issues.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dagPath = resolve(root, "roadmap/spec-dag.json");
const schemaPath = resolve(root, "roadmap/spec-dag.schema.json");
const auditSchemaPath = resolve(root, "roadmap/audit-report.schema.json");
const auditExamplesPath = resolve(root, "roadmap/examples");
const schema = loadJson(schemaPath);
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
if (command === "validate") {
  const auditValidation = validateAuditReportArtifacts(dag);
  validation.errors.push(...auditValidation.errors);
  validation.auditReportExampleCount = auditValidation.exampleCount;
} else if (command === "validate-audit-report") {
  const auditValidation = validateAuditReportFiles(args, dag);
  validation.errors.push(...auditValidation.errors);
  validation.auditReportCount = auditValidation.reportCount;
}

if (validation.errors.length > 0) {
  for (const error of validation.errors) {
    console.error(error);
  }
  process.exit(1);
}

switch (command) {
  case "validate":
    printValidationSummary(dag, validation);
    break;
  case "validate-audit-report":
    printAuditReportValidationSummary(validation);
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
  case "sync-issues":
    printIssueSync(dag, args);
    break;
  default:
    console.error(
      "usage: spec-dag <validate|validate-audit-report|ready|pop|show|graph|sync-issues> [options]",
    );
    process.exit(1);
}

function loadDag() {
  return loadJson(dagPath);
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
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

function validateAuditReportArtifacts(dagValue) {
  const errors = [];
  const compiled = compileAuditReportValidator();
  if (compiled.errors.length > 0) {
    return { errors: compiled.errors, exampleCount: 0 };
  }
  const validate = compiled.validate;

  let entries;
  try {
    entries = readdirSync(auditExamplesPath, { withFileTypes: true });
  } catch (error) {
    return {
      errors: [`audit examples roadmap/examples failed to read: ${error.message}`],
      exampleCount: 0,
    };
  }

  const exampleFiles = entries
    .filter((entry) => entry.isFile() && /^audit-report.*\.json$/.test(entry.name))
    .map((entry) => ({
      displayPath: `roadmap/examples/${entry.name}`,
      path: resolve(auditExamplesPath, entry.name),
    }));

  if (exampleFiles.length === 0) {
    errors.push("audit examples require at least one roadmap/examples/audit-report*.json file");
  }

  for (const exampleFile of exampleFiles) {
    let report;
    try {
      report = loadJson(exampleFile.path);
    } catch (error) {
      errors.push(`audit example ${exampleFile.displayPath} failed to load: ${error.message}`);
      continue;
    }

    const reportErrors = validateAuditReport(report, exampleFile.displayPath, validate, dagValue);
    errors.push(...reportErrors);
    if (reportErrors.length === 0) {
      errors.push(
        ...validateAuditReportGuards(validate, report, exampleFile.displayPath, dagValue),
      );
    }
  }

  return { errors, exampleCount: exampleFiles.length };
}

function validateAuditReportFiles(reportPaths, dagValue) {
  if (reportPaths.length === 0) {
    return {
      errors: ["usage: spec-dag validate-audit-report REPORT.json [REPORT.json ...]"],
      reportCount: 0,
    };
  }

  const compiled = compileAuditReportValidator();
  if (compiled.errors.length > 0) {
    return { errors: compiled.errors, reportCount: 0 };
  }

  const errors = [];
  for (const reportPath of reportPaths) {
    let report;
    try {
      report = loadJson(resolve(process.cwd(), reportPath));
    } catch (error) {
      errors.push(`audit report ${reportPath} failed to load: ${error.message}`);
      continue;
    }
    errors.push(...validateAuditReport(report, reportPath, compiled.validate, dagValue));
  }

  return { errors, reportCount: reportPaths.length };
}

function compileAuditReportValidator() {
  let auditSchema;
  try {
    auditSchema = loadJson(auditSchemaPath);
  } catch (error) {
    return {
      errors: [`audit schema roadmap/audit-report.schema.json failed to load: ${error.message}`],
      validate: undefined,
    };
  }

  const ajv = new Ajv2020({ allErrors: true });
  try {
    return { errors: [], validate: ajv.compile(auditSchema) };
  } catch (error) {
    return {
      errors: [`audit schema roadmap/audit-report.schema.json failed to compile: ${error.message}`],
      validate: undefined,
    };
  }
}

function validateAuditReport(report, displayPath, validate, dagValue) {
  const errors = [];
  if (!validate(report)) {
    for (const error of validate.errors ?? []) {
      errors.push(
        `${displayPath} schema ${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
      );
    }
    return errors;
  }

  errors.push(...validateAuditReportSemantics(report, displayPath, dagValue));
  return errors;
}

function validateAuditReportSemantics(report, displayPath, dagValue) {
  const errors = [];
  const findings = report.findings;
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  const blockingFindingIds = [];
  const followUpFindingIds = [];
  const seenFindingIds = new Set();
  const nodeById = new Map((dagValue.nodes ?? []).map((node) => [node.id, node]));

  if (!nodeById.has(report.spec.id)) {
    errors.push(`${displayPath} spec.id ${report.spec.id} does not exist in roadmap/spec-dag.json`);
  }

  for (const finding of findings) {
    if (seenFindingIds.has(finding.id)) {
      errors.push(`${displayPath} finding id ${finding.id} is duplicated`);
    }
    seenFindingIds.add(finding.id);
    counts[finding.severity] += 1;
    if (["P0", "P1"].includes(finding.severity)) {
      blockingFindingIds.push(finding.id);
    } else {
      followUpFindingIds.push(finding.id);
    }
    if (!finding.id.startsWith(`${report.spec.id}-F`)) {
      errors.push(
        `${displayPath} finding ${finding.id} must use spec id prefix ${report.spec.id}-F`,
      );
    }
    const proposedNode = finding.orchestration.proposedDagNode;
    if (proposedNode && proposedNode.priority !== finding.severity) {
      errors.push(
        `${displayPath} finding ${finding.id} proposed node priority ${proposedNode.priority} must match severity ${finding.severity}`,
      );
    }
    errors.push(...validateFindingDagAction(report, finding, displayPath, nodeById));
  }

  for (const severity of Object.keys(counts)) {
    if (report.humanSummary.counts[severity] !== counts[severity]) {
      errors.push(
        `${displayPath} humanSummary.counts.${severity} is ${report.humanSummary.counts[severity]} but findings contain ${counts[severity]}`,
      );
    }
  }

  const expectedDecision = blockingFindingIds.length > 0 ? "blocked" : "complete_allowed";
  if (report.orchestration.completionDecision !== expectedDecision) {
    errors.push(
      `${displayPath} orchestration.completionDecision must be ${expectedDecision} for current findings`,
    );
  }

  const expectedOutcome =
    blockingFindingIds.length > 0 ? "blocked" : findings.length > 0 ? "follow_up_only" : "pass";
  if (report.humanSummary.outcome !== expectedOutcome) {
    errors.push(
      `${displayPath} humanSummary.outcome must be ${expectedOutcome} for current findings`,
    );
  }

  if (!sameStringSet(report.orchestration.blockingFindingIds, blockingFindingIds)) {
    errors.push(
      `${displayPath} orchestration.blockingFindingIds must exactly match P0/P1 finding ids`,
    );
  }
  if (!sameStringSet(report.orchestration.followUpFindingIds, followUpFindingIds)) {
    errors.push(
      `${displayPath} orchestration.followUpFindingIds must exactly match P2/P3 finding ids`,
    );
  }

  return errors;
}

function validateFindingDagAction(report, finding, displayPath, nodeById) {
  const errors = [];
  const orchestration = finding.orchestration;
  if (!["P2", "P3"].includes(finding.severity)) {
    return errors;
  }

  if (orchestration.nextAction === "append_to_existing_dag_node") {
    const targetNodeId = orchestration.existingDagNodeUpdate.targetNodeId;
    const targetNode = nodeById.get(targetNodeId);
    if (!targetNode) {
      errors.push(
        `${displayPath} finding ${finding.id} existingDagNodeUpdate.targetNodeId ${targetNodeId} does not exist in roadmap/spec-dag.json`,
      );
      return errors;
    }
    if (targetNode.status !== "planned") {
      errors.push(
        `${displayPath} finding ${finding.id} existingDagNodeUpdate.targetNodeId ${targetNodeId} must be planned, not ${targetNode.status}`,
      );
    }
    if (targetNodeId === report.spec.id) {
      errors.push(
        `${displayPath} finding ${finding.id} must not append follow-up work to the audited spec ${report.spec.id}; use draft_new_dag_node or a different planned node`,
      );
    }
    return errors;
  }

  if (orchestration.nextAction === "draft_new_dag_node") {
    const proposedNode = orchestration.proposedDagNode;
    const draftNodeErrors = [];
    const syntheticNode = plannedNodeFromDraft(proposedNode);
    validateNode(syntheticNode, 0, draftNodeErrors);
    for (const error of draftNodeErrors) {
      errors.push(
        `${displayPath} finding ${finding.id} ${error.replaceAll(syntheticNode.id, "proposedDagNode")}`,
      );
    }
    for (const dependency of proposedNode.dependsOn) {
      const dependencyNode = nodeById.get(dependency);
      if (!dependencyNode) {
        errors.push(
          `${displayPath} finding ${finding.id} proposedDagNode.dependsOn references unknown node ${dependency}`,
        );
        continue;
      }
      if (targetRank[dependencyNode.target] > targetRank[proposedNode.target]) {
        errors.push(
          `${displayPath} finding ${finding.id} proposedDagNode target ${proposedNode.target} cannot depend on later ${dependencyNode.target} node ${dependency}`,
        );
      }
    }
  }

  return errors;
}

function validateAuditReportGuards(validate, report, displayPath, dagValue) {
  const errors = [];
  const unanchoredSpec = cloneJson(report);
  reanchorReportSpecId(unanchoredSpec, unusedDagNodeId(dagValue));
  if (validate(unanchoredSpec) && semanticGuardAllowed(unanchoredSpec, dagValue)) {
    errors.push(`${displayPath} semantic guard allowed unanchored spec id`);
  }

  const withoutAcceptanceCriteria = cloneJson(report);
  if (withoutAcceptanceCriteria.findings.length > 0) {
    delete withoutAcceptanceCriteria.findings[0].actionableAcceptanceCriteria;
  }
  if (withoutAcceptanceCriteria.findings.length > 0 && validate(withoutAcceptanceCriteria)) {
    errors.push(`${displayPath} schema guard allowed finding without actionableAcceptanceCriteria`);
  }

  const p0NonBlocking = cloneJson(report);
  const p0Finding = p0NonBlocking.findings.find((finding) => finding.severity === "P0");
  if (p0Finding) {
    p0Finding.orchestration.blocksCompletion = false;
    if (validate(p0NonBlocking)) {
      errors.push(`${displayPath} schema guard allowed P0 finding that does not block completion`);
    }
  }

  const p2Blocking = cloneJson(report);
  const p2Finding = p2Blocking.findings.find((finding) => finding.severity === "P2");
  if (p2Finding) {
    p2Finding.orchestration.blocksCompletion = true;
    p2Finding.orchestration.nextAction = "repair_before_completion";
    delete p2Finding.orchestration.proposedDagNode;
    if (validate(p2Blocking)) {
      errors.push(`${displayPath} schema guard allowed P2 finding to block completion`);
    }
  }

  const blockingFinding = report.findings.find((finding) =>
    ["P0", "P1"].includes(finding.severity),
  );
  if (blockingFinding) {
    const missingBlockingId = cloneJson(report);
    missingBlockingId.orchestration.blockingFindingIds =
      missingBlockingId.orchestration.blockingFindingIds.filter((id) => id !== blockingFinding.id);
    if (validate(missingBlockingId) && semanticGuardAllowed(missingBlockingId, dagValue)) {
      errors.push(`${displayPath} semantic guard allowed P0/P1 missing from blockingFindingIds`);
    }

    const completionAllowed = cloneJson(report);
    completionAllowed.orchestration.completionDecision = "complete_allowed";
    if (validate(completionAllowed) && semanticGuardAllowed(completionAllowed, dagValue)) {
      errors.push(`${displayPath} semantic guard allowed P0/P1 with complete_allowed decision`);
    }
  }

  if (report.findings.length > 1) {
    const duplicateFindingIds = cloneJson(report);
    duplicateFindingIds.findings[1].id = duplicateFindingIds.findings[0].id;
    if (validate(duplicateFindingIds) && semanticGuardAllowed(duplicateFindingIds, dagValue)) {
      errors.push(`${displayPath} semantic guard allowed duplicate finding ids`);
    }
  }

  const appendFinding = report.findings.find(
    (finding) => finding.orchestration.nextAction === "append_to_existing_dag_node",
  );
  if (appendFinding) {
    const appendToAuditedSpec = cloneJson(report);
    const matchingFinding = appendToAuditedSpec.findings.find(
      (finding) => finding.id === appendFinding.id,
    );
    matchingFinding.orchestration.existingDagNodeUpdate.targetNodeId = report.spec.id;
    if (validate(appendToAuditedSpec) && semanticGuardAllowed(appendToAuditedSpec, dagValue)) {
      errors.push(`${displayPath} semantic guard allowed follow-up append to audited spec`);
    }
  }

  const draftFinding = report.findings.find(
    (finding) => finding.orchestration.nextAction === "draft_new_dag_node",
  );
  const laterTargetDependency = (dagValue.nodes ?? []).find(
    (node) => targetRank[node.target] > targetRank.baseline,
  );
  if (draftFinding && laterTargetDependency) {
    const invalidDraftTargetOrder = cloneJson(report);
    const matchingFinding = invalidDraftTargetOrder.findings.find(
      (finding) => finding.id === draftFinding.id,
    );
    matchingFinding.orchestration.proposedDagNode.target = "baseline";
    matchingFinding.orchestration.proposedDagNode.dependsOn = [laterTargetDependency.id];
    if (
      validate(invalidDraftTargetOrder) &&
      semanticGuardAllowed(invalidDraftTargetOrder, dagValue)
    ) {
      errors.push(`${displayPath} semantic guard allowed draft node target-order violation`);
    }
  }

  return errors;
}

function semanticGuardAllowed(report, dagValue) {
  return validateAuditReportSemantics(report, "semantic guard", dagValue).length === 0;
}

function plannedNodeFromDraft(proposedNode) {
  const { idPrefix, ...nodeFields } = proposedNode;
  return {
    id: `${idPrefix}-000`,
    status: "planned",
    ...nodeFields,
  };
}

function reanchorReportSpecId(report, newSpecId) {
  report.reportId = report.reportId.replace(/^AUDIT-[A-Z]+-[0-9]{3}-/, `AUDIT-${newSpecId}-`);
  const idMap = new Map();
  for (const [index, finding] of report.findings.entries()) {
    const suffix =
      finding.id.match(/-F[0-9]{3}$/)?.[0] ?? `-F${String(index + 1).padStart(3, "0")}`;
    const newFindingId = `${newSpecId}${suffix}`;
    idMap.set(finding.id, newFindingId);
    finding.id = newFindingId;
  }
  report.spec.id = newSpecId;
  report.orchestration.blockingFindingIds = report.orchestration.blockingFindingIds.map(
    (id) => idMap.get(id) ?? id,
  );
  report.orchestration.followUpFindingIds = report.orchestration.followUpFindingIds.map(
    (id) => idMap.get(id) ?? id,
  );
}

function unusedDagNodeId(dagValue) {
  const nodeIds = new Set((dagValue.nodes ?? []).map((node) => node.id));
  for (let index = 999; index >= 0; index -= 1) {
    const candidate = `ZZZ-${String(index).padStart(3, "0")}`;
    if (!nodeIds.has(candidate)) {
      return candidate;
    }
  }
  return "ZZZ-999";
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

function printValidationSummary(value, validation) {
  const ready = readyNodes(value);
  const auditSummary =
    typeof validation.auditReportExampleCount === "number"
      ? `, ${validation.auditReportExampleCount} audit report example valid`
      : "";
  console.log(`spec DAG valid: ${value.nodes.length} nodes, ${ready.length} ready${auditSummary}`);
}

function printAuditReportValidationSummary(validation) {
  const count = validation.auditReportCount ?? 0;
  const noun = count === 1 ? "report" : "reports";
  console.log(`audit report valid: ${count} ${noun}`);
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

function printIssueSync(value, args) {
  const options = parseIssueSyncArgs(args);
  if (options.help) {
    printIssueSyncUsage();
    return;
  }
  if (options.apply && options.dryRun) {
    console.error("sync-issues accepts either --dry-run or --apply, not both");
    process.exit(1);
  }
  if (options.apply) {
    console.error(
      "sync-issues --apply is intentionally not implemented in this offline-safe command.",
    );
    console.error(
      "No GitHub writes were attempted. Future apply support must require --apply and a repository target.",
    );
    process.exit(2);
  }

  let nodes = filterNodes(value.nodes, args);
  if (options.nodeId) {
    nodes = nodes.filter((node) => node.id === options.nodeId);
    if (nodes.length === 0) {
      console.error(`unknown node ${options.nodeId}`);
      process.exit(1);
    }
  }

  const existingIssues = loadExistingIssues(options.existingIssuesPath);
  const normalizedExistingIssues = normalizeExistingIssues(existingIssues);
  if (normalizedExistingIssues.duplicateNodeIds.length > 0) {
    console.error(
      `existing issue export contains duplicate DAG node markers: ${normalizedExistingIssues.duplicateNodeIds.join(", ")}`,
    );
    process.exit(1);
  }

  const plan = createIssueSyncPlan({ ...value, nodes }, { existingIssues });
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          writes: 0,
          defaultMutating: false,
          labelTaxonomy: issueSyncLabelTaxonomy,
          managedLabelPrefixes: issueSyncManagedLabelPrefixes,
          plan,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(renderIssueSyncDryRun(plan, { includeBody: options.includeBody }));
}

function parseIssueSyncArgs(args) {
  const booleanFlags = new Set(["--dry-run", "--apply", "--json", "--include-body", "--help"]);
  const valueFlags = new Set([
    "--existing-issues",
    "--node",
    "--project",
    "--target",
    "--priority",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (booleanFlags.has(arg)) {
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        console.error(`${arg} requires a value`);
        process.exit(1);
      }
      index += 1;
      continue;
    }
    console.error(`unknown sync-issues option ${arg}`);
    process.exit(1);
  }

  return {
    apply: args.includes("--apply"),
    dryRun: args.includes("--dry-run"),
    existingIssuesPath: flag(args, "--existing-issues"),
    help: args.includes("--help"),
    includeBody: args.includes("--include-body"),
    json: args.includes("--json"),
    nodeId: flag(args, "--node"),
  };
}

function printIssueSyncUsage() {
  console.log(`usage: spec-dag sync-issues [--dry-run] [--json] [--include-body] [filters]

Creates a deterministic local GitHub issue sync plan from roadmap/spec-dag.json.
The default mode is dry-run and performs no GitHub writes.

Options:
  --dry-run                 render the non-mutating plan explicitly
  --apply                   reserved explicit write mode; currently refuses safely
  --json                    render a machine-readable plan including issue bodies
  --include-body            include rendered issue bodies in text dry-run output
  --existing-issues FILE    local JSON issue export used to update instead of create
  --node NODE-ID            restrict output to one DAG node
  --project NAME            restrict by project
  --target NAME             restrict by target
  --priority NAME           restrict by priority`);
}

function loadExistingIssues(path) {
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

function sameStringSet(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
