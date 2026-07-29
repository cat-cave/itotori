import {
  auditExamplesPath,
  auditSchemaPath,
  cloneJson,
  loadJson,
  require,
  targetRank,
} from "./spec-dag-shared.mjs";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { sameStringSet } from "./spec-dag-cli-utils.mjs";
import { validateNode } from "./spec-dag-validation-core.mjs";

export function validateAuditReportArtifacts(dagValue) {
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

    const reportErrors = validateAuditReport(report, exampleFile.displayPath, validate, dagValue, {
      isExampleFixture: true,
    });
    errors.push(...reportErrors);
    if (reportErrors.length === 0) {
      errors.push(
        ...validateAuditReportGuards(validate, report, exampleFile.displayPath, dagValue),
      );
    }
  }

  return { errors, exampleCount: exampleFiles.length };
}

export function validateAuditReportFiles(reportPaths, dagValue) {
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

export function compileAuditReportValidator() {
  let auditSchema;
  try {
    auditSchema = loadJson(auditSchemaPath);
  } catch (error) {
    return {
      errors: [`audit schema roadmap/audit-report.schema.json failed to load: ${error.message}`],
      validate: undefined,
    };
  }

  const Ajv2020 = require("ajv/dist/2020.js").default;
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

export function loadValidatedAuditReport(reportPath, dagValue) {
  let report;
  try {
    report = loadJson(resolve(process.cwd(), reportPath));
  } catch (error) {
    throw new Error(`audit report ${reportPath} failed to load: ${error.message}`);
  }
  const compiled = compileAuditReportValidator();
  if (compiled.errors.length > 0) {
    throw new Error(compiled.errors.join("\n"));
  }
  const errors = validateAuditReport(report, reportPath, compiled.validate, dagValue);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  return report;
}

export function validateAuditReport(report, displayPath, validate, dagValue, options = {}) {
  const errors = [];
  if (!validate(report)) {
    for (const error of validate.errors ?? []) {
      errors.push(
        `${displayPath} schema ${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
      );
    }
    return errors;
  }

  errors.push(...validateAuditReportSemantics(report, displayPath, dagValue, options));
  return errors;
}

export function validateAuditReportSemantics(report, displayPath, dagValue, options = {}) {
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
    errors.push(...validateFindingDagAction(report, finding, displayPath, nodeById, options));
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

export function validateFindingDagAction(report, finding, displayPath, nodeById, options = {}) {
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
    // The committed illustrative example fixture references a real DAG node by id to
    // demonstrate shape, but the DAG is driven to 100% completion where no node stays
    // `planned`. Requiring the example's target to be live-`planned` couples a checked-in
    // fixture to mutable DAG status (an unsatisfiable coupling at 100% completion), so the
    // example only asserts existence + non-self-reference. The live-`planned` liveness
    // requirement is meaningful only for REAL submitted audit reports being ingested.
    if (!options.isExampleFixture && targetNode.status !== "planned") {
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

export function validateAuditReportGuards(validate, report, displayPath, dagValue) {
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

export function semanticGuardAllowed(report, dagValue) {
  return validateAuditReportSemantics(report, "semantic guard", dagValue).length === 0;
}

export function plannedNodeFromDraft(proposedNode) {
  const { idPrefix, ...nodeFields } = proposedNode;
  return {
    id: `${idPrefix}-000`,
    status: "planned",
    ...nodeFields,
  };
}

export function reanchorReportSpecId(report, newSpecId) {
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

export function unusedDagNodeId(dagValue) {
  const nodeIds = new Set((dagValue.nodes ?? []).map((node) => node.id));
  for (let index = 999; index >= 0; index -= 1) {
    const candidate = `ZZZ-${String(index).padStart(3, "0")}`;
    if (!nodeIds.has(candidate)) {
      return candidate;
    }
  }
  return "ZZZ-999";
}
