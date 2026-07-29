import { explicitIntegrationSurfaceMatchers, isRecord } from "./spec-dag-shared.mjs";
import {
  classifyIntegrationSurface,
  exactSurfaceVerificationValues,
  isIntegrationOrReadinessNode,
  isConcreteCommandVerification,
} from "./spec-dag-validation-text.mjs";

export function validateIntegrationNodeSurfaces(node, errors) {
  if (!isIntegrationOrReadinessNode(node)) {
    return;
  }

  const text = [
    node.title,
    node.summary,
    ...(Array.isArray(node.deliverables) ? node.deliverables : []),
    ...(Array.isArray(node.acceptanceCriteria) ? node.acceptanceCriteria : []),
    ...exactSurfaceVerificationValues(node),
    ...(Array.isArray(node.auditFocus) ? node.auditFocus : []),
  ]
    .filter((value) => typeof value === "string")
    .join("\n");

  const classification = classifyIntegrationSurface(text);
  if (!classification.ok) {
    errors.push(
      `${node.id} integration/readiness node must name an exact file path, package name, command, or artifact token${describeIntegrationSurfaceFailure(node, classification)}`,
    );
  }
}

// Turns a failed integration-surface classification into an actionable, author
// facing diagnostic: it names the four exact token types (with examples), the
// parallel group under review, and every generic candidate that was rejected
// together with WHY it was rejected.
export function describeIntegrationSurfaceFailure(node, classification) {
  const seenTokenTypes = new Set();
  const examples = explicitIntegrationSurfaceMatchers
    .filter((matcher) => {
      if (seenTokenTypes.has(matcher.tokenType)) {
        return false;
      }
      seenTokenTypes.add(matcher.tokenType);
      return true;
    })
    .map((matcher) => `${matcher.tokenType} (e.g. ${matcher.example})`)
    .join(", ");
  let message = ` (parallelGroup ${node.parallelGroup}); expected one of: ${examples}`;
  if (classification.rejected.length > 0) {
    const rejected = classification.rejected
      .map((value) => `"${value}" uses only generic surface terms`)
      .join("; ");
    message += `. Rejected generic candidate(s): ${rejected}`;
  } else {
    message += ". No path, package, command, or artifact-shaped token was found in the node text.";
  }
  return message;
}

export function validateAlphaPriorityCommandVerification(node, errors) {
  if (node.target !== "alpha" || !["P0", "P1"].includes(node.priority)) {
    return;
  }

  const verification = Array.isArray(node.verification) ? node.verification : [];
  const commandEntries = verification.filter(
    (entry) => isRecord(entry) && entry.type === "command" && typeof entry.value === "string",
  );
  if (commandEntries.some((entry) => isConcreteCommandVerification(entry.value))) {
    return;
  }

  errors.push(`${node.id} alpha ${node.priority} node must include concrete command verification`);
  for (const [index, entry] of verification.entries()) {
    if (
      isRecord(entry) &&
      entry.type === "command" &&
      typeof entry.value === "string" &&
      !isConcreteCommandVerification(entry.value)
    ) {
      errors.push(
        `${node.id} verification[${index}] command entry is not concrete runnable evidence: ${entry.value}`,
      );
    }
  }
}
