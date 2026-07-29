import {
  commandLikeVerificationPattern,
  concreteCommandEvidencePatterns,
  docsOnlyPattern,
  exactIntegrationSurfaceCandidatePatterns,
  explicitIntegrationSurfaceMatchers,
  genericDeliverableValues,
  genericIntegrationSurfaceCandidateTerms,
  implementableDecisionPattern,
  implementationPattern,
  isRecord,
  manualOnlyVerificationPattern,
  metaNodePattern,
  placeholderAcceptancePatterns,
  placeholderCommandVerificationPattern,
  schedulingTextPattern,
  timeEstimateTextPattern,
  titleDerivedGenericDeliverableSuffixes,
} from "./spec-dag-shared.mjs";

export function validateRunnableVerification(node, errors) {
  if (isDocsOnlyNode(node)) {
    return;
  }
  const verification = Array.isArray(node.verification) ? node.verification : [];
  const hasCommand = verification.some(
    (entry) => isRecord(entry) && entry.type === "command" && typeof entry.value === "string",
  );
  if (hasCommand) {
    return;
  }

  errors.push(
    `${node.id} verification must include at least one command entry for runnable evidence`,
  );
  for (const [index, entry] of verification.entries()) {
    if (
      isRecord(entry) &&
      entry.type === "manual" &&
      typeof entry.value === "string" &&
      manualOnlyVerificationPattern.test(entry.value)
    ) {
      errors.push(
        `${node.id} verification[${index}] manual entry is not runnable evidence for tests or smoke behavior: ${entry.value}`,
      );
    }
  }
}

export function validateConcreteDeliverables(node, errors) {
  if (!Array.isArray(node.deliverables)) {
    return;
  }
  for (const [index, deliverable] of node.deliverables.entries()) {
    if (typeof deliverable !== "string") {
      continue;
    }
    if (isGenericDeliverable(node, deliverable)) {
      errors.push(`${node.id} deliverables[${index}] is a placeholder deliverable: ${deliverable}`);
    }
  }
}

export function validateNonPlaceholderAcceptance(node, errors) {
  if (!Array.isArray(node.acceptanceCriteria)) {
    return;
  }
  for (const [index, criterion] of node.acceptanceCriteria.entries()) {
    if (typeof criterion !== "string") {
      continue;
    }
    if (isPlaceholderAcceptanceCriterion(criterion)) {
      errors.push(
        `${node.id} acceptanceCriteria[${index}] is placeholder acceptance: ${criterion}`,
      );
    }
  }
}

export function validateImplementableNodeKind(node, errors) {
  const fields = [
    ["title", node.title],
    ["summary", node.summary],
    ...(Array.isArray(node.deliverables)
      ? node.deliverables.map((value, index) => [`deliverables[${index}]`, value])
      : []),
    ...(Array.isArray(node.acceptanceCriteria)
      ? node.acceptanceCriteria.map((value, index) => [`acceptanceCriteria[${index}]`, value])
      : []),
  ];

  for (const [field, value] of fields) {
    if (typeof value !== "string") {
      continue;
    }
    if (isMetaNodeText(field, value)) {
      errors.push(`${node.id} ${field} describes meta or decision-only work: ${value}`);
    }
  }

  if (
    typeof node.title === "string" &&
    /\bdecision\b/iu.test(node.title) &&
    !implementableDecisionPattern.test(node.title)
  ) {
    errors.push(`${node.id} title describes a decision-only node: ${node.title}`);
  }
}

export function validateNoTimeEstimateText(node, errors) {
  const fields = [
    ["title", node.title],
    ["summary", node.summary],
    ["statusReason", node.statusReason],
    ...(Array.isArray(node.deliverables)
      ? node.deliverables.map((value, index) => [`deliverables[${index}]`, value])
      : []),
    ...(Array.isArray(node.acceptanceCriteria)
      ? node.acceptanceCriteria.map((value, index) => [`acceptanceCriteria[${index}]`, value])
      : []),
    ...(Array.isArray(node.verification)
      ? node.verification.map((entry, index) => [
          `verification[${index}].value`,
          isRecord(entry) ? entry.value : undefined,
        ])
      : []),
    ...(Array.isArray(node.auditFocus)
      ? node.auditFocus.map((value, index) => [`auditFocus[${index}]`, value])
      : []),
  ];

  for (const [field, value] of fields) {
    if (typeof value !== "string") {
      continue;
    }
    if (timeEstimateTextPattern.test(value) || schedulingTextPattern.test(value)) {
      errors.push(
        `${node.id} ${field} contains time-estimate wording; roadmap nodes must use dependencies and verification instead of time estimates: ${value}`,
      );
    }
  }
}

// Classifies whether the composed node text names an exact integration surface.
// Returns { ok: true, tokenType, value } naming the recognized token TYPE on
// success, or { ok: false, rejected } listing the generic candidates that were
// shaped like a surface but rejected as too generic, so the caller can build an
// actionable diagnostic.
export function classifyIntegrationSurface(text) {
  for (const matcher of explicitIntegrationSurfaceMatchers) {
    const match = matcher.pattern.exec(text);
    if (match) {
      return { ok: true, tokenType: matcher.tokenType, value: match[0].trim(), rejected: [] };
    }
  }

  const rejected = [];
  for (const line of text.split(/\n+/u)) {
    for (const pattern of exactIntegrationSurfaceCandidatePatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        if (isExactIntegrationSurfaceCandidate(match[0])) {
          return { ok: true, tokenType: "composed surface", value: match[0].trim(), rejected: [] };
        }
        const value = match[0].trim();
        if (!rejected.includes(value)) {
          rejected.push(value);
        }
      }
    }
  }

  return { ok: false, rejected };
}

export function isConcreteCommandVerification(value) {
  const normalized = value.trim();
  return (
    normalized.length > 0 &&
    !placeholderCommandVerificationPattern.test(normalized) &&
    commandLikeVerificationPattern.test(normalized) &&
    concreteCommandEvidencePatterns.some((pattern) => pattern.test(normalized))
  );
}

export function exactSurfaceVerificationValues(node) {
  if (!Array.isArray(node.verification)) {
    return [];
  }
  return node.verification
    .filter(
      (entry) =>
        isRecord(entry) &&
        entry.type === "command" &&
        typeof entry.value === "string" &&
        !isGenericRoadmapVerificationCommand(entry.value),
    )
    .map((entry) => `command: ${entry.value}`);
}

export function isGenericRoadmapVerificationCommand(value) {
  const normalized = value.trim();
  return (
    /^node\s+scripts\/spec-dag(?:-validator)?(?:\.test)?\.mjs(?:\s+validate)?$/iu.test(
      normalized,
    ) || /^just\s+(?:check|ci)$/iu.test(normalized)
  );
}

export function isExactIntegrationSurfaceCandidate(candidate) {
  const tokens = normalizeSemanticText(candidate).split(" ").filter(Boolean);
  return tokens.some((token) => !genericIntegrationSurfaceCandidateTerms.has(token));
}

export function isDocsOnlyNode(node) {
  if (!Array.isArray(node.deliverables) || node.deliverables.length === 0) {
    return false;
  }
  const deliverablesAreDocs = node.deliverables.every(
    (deliverable) => typeof deliverable === "string" && docsOnlyPattern.test(deliverable),
  );
  if (!deliverablesAreDocs) {
    return false;
  }
  const nodeText = [node.title, node.summary, ...(node.acceptanceCriteria ?? [])]
    .filter((value) => typeof value === "string")
    .join("\n");
  return !implementationPattern.test(nodeText);
}

export function isGenericDeliverable(node, deliverable) {
  const normalized = normalizeSemanticText(deliverable);
  if (genericDeliverableValues.has(normalized) || isOwnedSurfacePlaceholder(deliverable)) {
    return true;
  }

  const normalizedTitle = typeof node.title === "string" ? normalizeSemanticText(node.title) : "";
  if (!normalizedTitle) {
    return false;
  }
  return titleDerivedGenericDeliverableSuffixes.some(
    (suffix) => normalized === `${normalizedTitle} ${suffix}`,
  );
}

export function isPlaceholderAcceptanceCriterion(criterion) {
  return (
    placeholderAcceptancePatterns.some((pattern) => pattern.test(criterion.trim())) ||
    isOwnedSurfacePlaceholder(criterion)
  );
}

export function isMetaNodeText(field, value) {
  if (!metaNodePattern.test(value)) {
    return false;
  }
  if (
    field.startsWith("acceptanceCriteria[") &&
    /\b(?:validation fails|validator fails|rejects?|not accepted|not allowed|must not|does not|without)\b/iu.test(
      value,
    )
  ) {
    return false;
  }
  return true;
}

export function isIntegrationOrReadinessNode(node) {
  if (node.parallelGroup === "alpha-integration") {
    return true;
  }
  const text = [
    node.title,
    node.summary,
    ...(Array.isArray(node.deliverables) ? node.deliverables : []),
  ]
    .filter((value) => typeof value === "string")
    .join("\n")
    .replace(/\bintegration[- ]nodes?\b/giu, "");
  return /\b(?:integration|vertical|end[- ]to[- ]end|readiness)\b/iu.test(text);
}

export function normalizeSemanticText(value) {
  return value
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/[^a-z0-9/]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

export function isOwnedSurfacePlaceholder(value) {
  const normalized = value
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
  return /^(?:names an? )?owned command service schema (?:(?:or|and) )?artifact surfaces?$/iu.test(
    normalized,
  );
}

export function validateStringArray(node, field, errors, options) {
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
