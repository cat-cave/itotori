import {
  acceptanceVerificationPathPattern,
  allowed,
  historicalMissingPathContextPattern,
  isRecord,
  requiredNodeFields,
  optionalNodeFields,
  retiredLegacyPathPatterns,
  root,
  semanticValidationStatuses,
  timeEstimateFieldPattern,
} from "./spec-dag-shared.mjs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  validateConcreteDeliverables,
  validateImplementableNodeKind,
  validateNoTimeEstimateText,
  validateNonPlaceholderAcceptance,
  validateRunnableVerification,
  validateStringArray,
} from "./spec-dag-validation-text.mjs";
import {
  validateAlphaPriorityCommandVerification,
  validateIntegrationNodeSurfaces,
} from "./spec-dag-validation-surfaces.mjs";

export function validateAlphaReadinessPath(nodes, ids) {
  const errors = [];

  const releaseNode = ids.get("ALPHA-005");
  if (!releaseNode) {
    errors.push("ALPHA-005 alpha readiness milestone node is required");
  } else {
    const ancestors = ancestorsOf(releaseNode, ids);
    for (const node of nodes) {
      if (
        node.priority === "P1" &&
        node.target === "alpha" &&
        node.status !== "complete" &&
        node.id !== "ALPHA-005" &&
        !ancestors.has(node.id)
      ) {
        errors.push(`${node.id} is P1 alpha-readiness work but is not an ancestor of ALPHA-005`);
      }
    }
  }

  const rgtNode = ids.get("RGT-005");
  if (!rgtNode) {
    errors.push("RGT-005 real-game-testing-ready milestone node is required");
  } else {
    const ancestors = ancestorsOf(rgtNode, ids);
    for (const node of nodes) {
      if (
        node.priority === "P1" &&
        node.target === "real-game-testing-ready" &&
        node.status !== "complete" &&
        node.id !== "RGT-005" &&
        !ancestors.has(node.id)
      ) {
        errors.push(
          `${node.id} is P1 real-game-testing-ready work but is not an ancestor of RGT-005`,
        );
      }
    }
  }

  return errors;
}

export function ancestorsOf(node, ids) {
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

export function validateNode(node, index, errors) {
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
      if (timeEstimateFieldPattern.test(field)) {
        errors.push(
          `${node.id ?? `nodes[${index}]`} ${field} is a time estimate field; roadmap nodes must use dependencies and verification instead of time estimates`,
        );
      }
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
  validateNoTimeEstimateText(node, errors);
  validateNativeAcceptanceVerificationPaths(node, errors);
  validateNodeSemantics(node, errors);
}

export function validateVerification(node, errors) {
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

export function validateNodeSemantics(node, errors) {
  if (!semanticValidationStatuses.has(node.status)) {
    return;
  }

  validateRunnableVerification(node, errors);
  validateConcreteDeliverables(node, errors);
  validateNonPlaceholderAcceptance(node, errors);
  validateImplementableNodeKind(node, errors);
  validateIntegrationNodeSurfaces(node, errors);
  validateAlphaPriorityCommandVerification(node, errors);
}

export function validateQdAcceptanceVerificationPaths(node, displayId, errors) {
  if (node.status !== "done") {
    return;
  }
  validateAcceptanceVerificationPathReferences(
    displayId,
    [
      ["acceptance", node.acceptance],
      ...(Array.isArray(node.verification)
        ? node.verification.map((entry, index) => [
            `verification[${index}].value`,
            isRecord(entry) ? entry.value : undefined,
          ])
        : []),
    ],
    errors,
  );
}

export function validateNativeAcceptanceVerificationPaths(node, errors) {
  if (node.status !== "complete") {
    return;
  }
  validateAcceptanceVerificationPathReferences(
    node.id,
    [
      ...(Array.isArray(node.acceptanceCriteria)
        ? node.acceptanceCriteria.map((value, index) => [`acceptanceCriteria[${index}]`, value])
        : []),
      ...(Array.isArray(node.verification)
        ? node.verification.map((entry, index) => [
            `verification[${index}].value`,
            isRecord(entry) ? entry.value : undefined,
          ])
        : []),
    ],
    errors,
  );
}

export function validateAcceptanceVerificationPathReferences(nodeId, fields, errors) {
  for (const [field, value] of fields) {
    if (typeof value !== "string") {
      continue;
    }
    for (const reference of missingAcceptanceVerificationPathReferences(value)) {
      errors.push(
        `${nodeId} ${field} references missing repo path ${reference.path}: ${reference.context}`,
      );
    }
  }
}

export function missingAcceptanceVerificationPathReferences(value) {
  const references = [];
  for (const match of value.matchAll(acceptanceVerificationPathPattern)) {
    const repoPath = cleanAcceptanceVerificationPath(match[1]);
    if (!isCheckableAcceptanceVerificationPath(repoPath)) {
      continue;
    }
    const context = localLineContext(value, match.index ?? 0);
    if (isIntentionalMissingPathContext(context)) {
      continue;
    }
    if (!existsSync(resolve(root, repoPath)) && !isRetiredLegacyPath(repoPath)) {
      references.push({ path: repoPath, context });
    }
  }
  return references;
}

export function cleanAcceptanceVerificationPath(value) {
  return value
    .replace(/^\.\//u, "")
    .replace(/[),.;:'"]+$/u, "")
    .replace(/#.*$/u, "")
    .replace(/:\d+(?::\d+)?$/u, "");
}

export function isRetiredLegacyPath(repoPath) {
  return retiredLegacyPathPatterns.some((pattern) => pattern.test(repoPath));
}

export function isCheckableAcceptanceVerificationPath(repoPath) {
  return (
    repoPath.length > 0 &&
    !repoPath.endsWith("/") &&
    /\.[A-Za-z0-9]+$/u.test(repoPath) &&
    !/[{}<>*$]/u.test(repoPath) &&
    !repoPath.includes("...")
  );
}

export function isIntentionalMissingPathContext(context) {
  return (
    historicalMissingPathContextPattern.test(context) ||
    /^\s*(?:!|not\s+|test\s+!\s|test\s+-e\s+\S+\s+\|\|)/iu.test(context)
  );
}

export function localLineContext(text, index) {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const nextNewline = text.indexOf("\n", index);
  const end = nextNewline === -1 ? text.length : nextNewline;
  return text.slice(start, end).trim();
}
