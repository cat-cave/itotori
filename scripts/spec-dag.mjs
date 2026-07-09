#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createIssueSyncPlan,
  issuesFromPayload,
  issueSyncLabelTaxonomy,
  issueSyncManagedLabelPrefixes,
  normalizeExistingIssues,
  renderIssueSyncDryRun,
} from "./spec-dag-issues.mjs";
import {
  applyAuditIngestionPlan,
  applyClaim,
  applyClaimRelease,
  applyCompletionPlan,
  applyWorktreePlan,
  createAuditIngestionPlan,
  createClaimPlan,
  createClaimReleasePlan,
  createCompletionPlan,
  createWorktreePlan,
  defaultBranchForNode,
  defaultClaimLockDir,
  defaultWorktreeForNode,
} from "./spec-dag-lifecycle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
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

// qd 0.1.16 emits schema_version 2; earlier exports and test fixtures use 1.
// Both share the same node/edge/registry/run shape this validator checks.
const qdExportSchemaVersions = new Set([1, 2]);
const legacyLifecycleApplyCommands = new Set(["claim", "worktree", "ingest-audit", "complete"]);
const qdExportLifecycleRefusal =
  "legacy spec-dag lifecycle --apply is disabled for qd export state; use qd claim/complete/gate/check/ci/merge and re-export roadmap/spec-dag.json";
const qdStatusMap = {
  ready: "planned",
  claimed: "in_progress",
  working: "in_progress",
  review: "in_progress",
  fixing: "in_progress",
  ci: "in_progress",
  mergeable: "in_progress",
  done: "complete",
  merged: "complete",
  cancelled: "cancelled",
  blocked: "blocked",
};
const qdAllowedStatuses = new Set(Object.keys(qdStatusMap));
const qdPlaceholderTextPattern = /^(?:test(?:\s+(?:spec|acc|acceptance|focus))?|todo|tbd)$/iu;
const qdActiveAuditFixStatuses = new Set([
  "ready",
  "claimed",
  "working",
  "review",
  "fixing",
  "ci",
  "mergeable",
]);
const qdGenericAuditFixAcceptancePattern = /^finding is addressed and verified\.$/iu;
const qdCiReuseSummaryPattern =
  /\b(?:covered by|covered-by|reused|reuse|record-pass|(?:implementation\s+)?ci already passed|(?:qd\s+)?full[- ]ci passed|integrated .*?\bci\b|integrated .*?\bqd-full-ci\b)\b/iu;
const qdLocalLogPathPattern =
  /(?:^|[\s=])(?:\.qd\/logs\/|\/[^\s]*\/\.qd\/logs\/|[A-Za-z]:[\\/][^\s]*[\\/]\.qd[\\/]logs[\\/])/u;
const qdEvidenceLogPathPattern = /(?:^|\n)Evidence:\s*log_path=([^\s]+)/iu;
const windowsAbsolutePathPattern = /^[A-Za-z]:[\\/]/u;
const acceptanceVerificationPathRoots =
  "(?:\\.github|apps|bin|crates|docs|fixtures|packages|presets|roadmap|scripts|suite|tests|tools)";
const acceptanceVerificationPathPattern = new RegExp(
  "(?:^|[\\s([`'\"])(\\.?\\/?" + acceptanceVerificationPathRoots + "\\/[A-Za-z0-9._@%+~/-]+)",
  "gu",
);
const historicalMissingPathContextPattern =
  /\b(?:absent|deleted|does not exist|do not exist|missing\s+(?:artifact|file|path|reference|script|target|test)s?|no longer|no such file|removed|renamed|replaced|retired|stale|successor|superseded|historical|returns 0|returns no hits)\b/iu;
const justfilePath = resolve(root, "justfile");
const viteConfigPath = resolve(root, "vite.config.ts");

const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
const targetRank = {
  baseline: 0,
  "real-game-testing-ready": 1,
  alpha: 2,
  beta: 3,
  continuous: 4,
};
const semanticValidationStatuses = new Set(["planned", "in_progress", "blocked"]);
const genericDeliverableValues = new Set([
  "implementation",
  "fixture",
  "fixtures",
  "test",
  "tests",
  "regression coverage",
  "end to end fixture",
  "e2e fixture",
  "integration surface",
  "owned command service schema or artifact surface",
]);
const titleDerivedGenericDeliverableSuffixes = [
  "implementation",
  "fixtures",
  "tests",
  "regression coverage",
  "end to end fixture",
  "e2e fixture",
  "integration surface",
];
const placeholderAcceptancePatterns = [
  /^(?:.+\s+)?has concrete executable behavior or schema validation$/iu,
  /^has concrete executable behavior$/iu,
  /^has schema validation$/iu,
  /^acceptance is based on executable fixtures, validators, services, or commands$/iu,
  /^the integration composes (?:the )?prerequisite implementation slices without expanding their scope$/iu,
];
const manualOnlyVerificationPattern =
  /\b(?:test|tests|smoke|fixture|fixtures|golden|round[- ]trip|validation|validate|check)\b/iu;
const docsOnlyPattern = /\b(?:docs?|documentation|readme|adr|policy|spec|guide|playbook)\b/iu;
const implementationPattern =
  /\b(?:adapter|api|artifact|bridge|cli|command|contract|dashboard|database|delta|fixture|generator|harness|implementation|ingest|migration|model|parser|patch|queue|repository|runner|schema|service|smoke|test|ui|validator|workflow)\b/iu;
const metaNodePattern =
  /\b(?:meta[- ]?pack|follow[- ]up pack|normalize[- ]later|granularity follow[- ]up normalizer|report[- ]only|decision[- ]only|decision node|decision record|feasibility[- ]only|feasibility (?:assessment|report|node|study)|research[- ]only|research only|investigation[- ]only|investigation only|research node|investigation node|spike(?!-)|proof[- ]of[- ]concept|POC|research phase|investigation phase)\b/iu;
const implementableDecisionPattern =
  /\b(?:api|command|contract|dashboard|events?|generator|import|model|persistence|queue|read model|renderer|schema|service|ui|validator|workflow|wiring)\b/iu;
const placeholderCommandVerificationPattern =
  /^(?:tbd|todo|manual review|command|verification command|exact command|owned command(?:,\s+service,\s+schema,\s+or artifact surface)?)$/iu;
const commandLikeVerificationPattern =
  /^(?:(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*|env\s+(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*)(?:cargo|node|pnpm|just|npm|npx|uv|python|python3|bash|sh|test|make|go|deno|bun|ruby|rspec|pytest|ruff|vitest|jest|tsx|ts-node|docker|docker\s+compose|git|gh)\b(?:\s+[^\n]+)?$/iu;
const concreteCommandEvidencePatterns = [
  /\s(?:--?[a-z][a-z0-9-]*)(?:[=\s]|$)/iu,
  /\s(?:\.{0,2}\/|[a-z0-9._-]+\/|[a-z0-9._/-]+\.[a-z0-9]+)\S*/iu,
  /(?:^|\s)@[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?\b/iu,
  /\b[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._:-]*\b/iu,
  /^(?:(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*|env\s+(?:-[a-z]\s+[A-Z_][A-Z0-9_]*\s+|[A-Z_][A-Z0-9_]*=[^\s]+\s+)*)(?:cargo|go)\s+(?:build|check|clippy|deny|fmt|test)\b/iu,
  /^(?:(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*|env\s+(?:-[a-z]\s+[A-Z_][A-Z0-9_]*\s+|[A-Z_][A-Z0-9_]*=[^\s]+\s+)*)(?:just|make|npm|npx|pnpm|uv|pytest|ruff|vitest|jest|rspec)\s+[a-z0-9][a-z0-9:_-]*\b/iu,
  /^(?:(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*|env\s+(?:-[a-z]\s+[A-Z_][A-Z0-9_]*\s+|[A-Z_][A-Z0-9_]*=[^\s]+\s+)*)(?:docker\s+compose|docker|git|gh)\s+[a-z0-9][a-z0-9:_-]*\b/iu,
  /^(?:(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*|env\s+(?:-[a-z]\s+[A-Z_][A-Z0-9_]*\s+|[A-Z_][A-Z0-9_]*=[^\s]+\s+)*)(?:bash|sh|node|python|python3|deno|bun|ruby|tsx|ts-node)\s+\S*(?:\/|\.[a-z0-9]+)\S*/iu,
];
const timeEstimateFieldPattern =
  /(?:estimate|estimated|duration|hours?|days?|effort|points?|tshirt|t[- ]shirt)/iu;
const timeEstimateQuantityPattern =
  /(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|a|an|half|couple(?:\s+of)?|few|several)/iu;
const compactTimeEstimateQuantityPattern = String.raw`\d+(?:\.\d+)?\s*(?:m|h|d|w|mo|mos)`;
const effortSizePattern = String.raw`(?:x[-\s]?s|xs|s|m|l|x[-\s]?l|xl|small|medium|large|low|high)`;
const timeEstimateTextPattern = new RegExp(
  String.raw`\b(?:${timeEstimateQuantityPattern.source})(?:\s+|-)(?:person[-\s]?)?(?:minutes?|hours?|days?|weeks?|months?|story\s+points?|points?|pts?)\b|\bt[- ]?shirt\s+size(?:\s*(?:[:=]|\bis\b|\bas\b)\s*${effortSizePattern})?\b|\b(?:estimated?\s+)?(?:effort|duration)\s*(?:[:=]|\bis\b|\bof\b|\bat\b|\babout\b|\baround\b|\broughly\b)?\s*(?:(?:${timeEstimateQuantityPattern.source})(?:\s+|-)(?:minutes?|hours?|days?|weeks?|months?|story\s+points?|points?|pts?)|${compactTimeEstimateQuantityPattern}|${effortSizePattern})\b|\b(?:sized|sizing)\s*(?:[:=]|\bas\b|\bat\b|\bfor\b)\s*${effortSizePattern}\b`,
  "iu",
);
const schedulingTextPattern =
  /\b(?:in\s+sprint\s+\d+|planned\s+for\s+sprint\s+\d+|scheduled\s+for\s+(?:next\s+)?sprint|runs\s+next\s+sprint)\b/iu;
const exactIntegrationSurfaceQualifierPattern = String.raw`(?:asset|benchmark|bgi|binary|branch|catalog|capability|capture|community|corpus|cost|cross[- ]source|dashboard|decision|delta|draft|edition|encrypted|encrypted[- ]profile|engine|event|experiment|feedback|full[- ]surface|helper|install[- ]state|key|kirikiri|ledger|locale|local|local[- ]corpus|manual|matrix|model|mv\/mz|openrouter|patch|permission|private[- ]local|provider|public[- ]fixture|qa|quality|readiness|real[- ]engine|review|reviewer|runtime|siglus|source|style|trace|translation|triage|vm|wolf|xp3)`;
const exactIntegrationSurfaceNounPattern = String.raw`(?:adapter|api|artifact|artifacts|bridge|command|contract|dashboard|delta|diagnostic|diagnostics|evidence|export|fixture|fixtures|generator|harness|import|ledger|manifest|matrix|model|parser|patcher|profile|queue|record|records|renderer|report|resolver|route|run|schema|service|smoke|storage|store|surface|tool|tools|ui|ux|validator|workflow)`;
const genericIntegrationSurfaceCandidateTerms = new Set([
  "adapter",
  "adapters",
  "alpha",
  "artifact",
  "artifacts",
  "bundle",
  "bundles",
  "checklist",
  "command",
  "commands",
  "composed",
  "coordination",
  "dependency",
  "dependencies",
  "evidence",
  "fixture",
  "fixtures",
  "gate",
  "generator",
  "integration",
  "manifest",
  "manifests",
  "matrix",
  "matrices",
  "path",
  "paths",
  "profile",
  "profiles",
  "project",
  "readiness",
  "record",
  "records",
  "renderer",
  "report",
  "reports",
  "schema",
  "schemas",
  "service",
  "services",
  "status",
  "surface",
  "surfaces",
  "suite",
  "validator",
  "validators",
  "vertical",
  "workflow",
  "workflows",
]);
const exactIntegrationSurfaceCandidatePatterns = [
  new RegExp(
    String.raw`\b${exactIntegrationSurfaceQualifierPattern}(?:[-\s/]+[a-z0-9.]+){0,4}[-\s/]+${exactIntegrationSurfaceNounPattern}\b`,
    "giu",
  ),
  new RegExp(
    String.raw`\b${exactIntegrationSurfaceNounPattern}(?:[-\s/]+[a-z0-9.]+){0,4}[-\s/]+${exactIntegrationSurfaceQualifierPattern}\b`,
    "giu",
  ),
];
// Each explicit integration-surface matcher is labelled with the token TYPE it
// recognizes so that failure diagnostics can tell spec authors which exact token
// types satisfy the integration-surface requirement (file path, package name,
// command, artifact token). The recognition is by token SHAPE, not on-disk
// existence, because a forward-looking roadmap legitimately references surfaces a
// node is about to create; command tokens are separately existence-checked
// against real just recipes and vp tasks in validateAlphaCommandReferences.
const explicitIntegrationSurfaceMatchers = [
  {
    tokenType: "file path",
    example: "scripts/spec-dag.mjs",
    pattern:
      /\b(?:apps|crates|docs|fixtures|packages|roadmap|scripts|src|tests|tools)\/[a-z0-9._/-]+\b/iu,
  },
  {
    tokenType: "package name",
    example: "@itotori/db",
    pattern: /(?:^|\s)@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\b/iu,
  },
  {
    tokenType: "file path",
    example: "provider-proof.json",
    pattern: /\b[a-z0-9][a-z0-9._-]*(?:\.json|\.mjs|\.ts|\.tsx|\.rs|\.md)\b/iu,
  },
  {
    tokenType: "command",
    example: "command: pnpm exec vp run alpha:public-fixture",
    pattern:
      /^command:\s*(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*(?:env\s+(?:-[a-z]\s+[A-Z_][A-Z0-9_]*\s+)?)*(?:cargo|node|pnpm|just|npm|npx|uv|python|bash|test|make)\s+[^\n]+$/imu,
  },
  {
    tokenType: "artifact token",
    example: "artifacts/alpha/public-fixture/provider-proof.json",
    pattern:
      /\b(?:map\/common[- ]event|database\/system\/terms|json text|plugin[- ]profile|source bundle|locale branch|runtime evidence|dashboard evidence|dashboard status|patch package|patch output|patch payload|delta apply|bridge import|feedback ux|style guide|triage wiring|repair rerun|before\/after dashboard|provider route|provider proof|provider ledger|cost report|quality report|benchmark report|experiment matrix|cost ledger|model ledger|reviewer queue|triage queue|decision queue|catalog resolver|cross[- ]source resolver|local corpus|corpus sidecar|adapter registry|engine capability|managed artifact|artifact store|capture hook|launch harness|vm adapter|text trace|trace smoke)\b/iu,
  },
];

if (isMainModule()) {
  runCli(process.argv.slice(2));
}

function runCli(argv) {
  const [command = "validate", ...args] = argv;
  const rawDag = loadJson(dagPath);
  const dag = normalizeDag(rawDag);
  const validation = validateDag(rawDag);
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

  try {
    assertNoQdExportLifecycleApply(command, args, rawDag);
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
      case "claim":
        printClaim(dag, args);
        break;
      case "worktree":
        printWorktree(dag, args);
        break;
      case "ingest-audit":
        printAuditIngestion(dag, args);
        break;
      case "complete":
        printCompletion(dag, args);
        break;
      default:
        printUsageAndExit();
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

export function assertNoQdExportLifecycleApply(command, args, rawDag) {
  if (
    legacyLifecycleApplyCommands.has(command) &&
    legacyLifecycleApplyRequested(command, args) &&
    isQdExportDag(rawDag)
  ) {
    throw new Error(qdExportLifecycleRefusal);
  }
}

function legacyLifecycleApplyRequested(command, args) {
  return (
    args.includes("--apply") || (command === "ingest-audit" && args.includes("--apply-follow-ups"))
  );
}

function isMainModule() {
  return (
    Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

export function loadDag() {
  return normalizeDag(loadJson(dagPath));
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
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

function validateNativeDag(value) {
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

function isQdExportDag(value) {
  return isRecord(value) && "schema_version" in value;
}

function validateQdExportDag(value) {
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

function normalizeQdExportDag(value) {
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

function normalizeQdExportNode(node, dependsOn) {
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

function splitQdSpec(value) {
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

function splitQdList(value) {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(/\n/u)
    .map((line) => line.replace(/^\s*-\s?/u, "").trim())
    .filter(Boolean);
}

function validateQdRegistry(registries, field, errors) {
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

function validateQdNode(node, index, errors) {
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

function validateQdActiveAuditFixNode(node, displayId, errors) {
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

function validateQdVerification(node, errors) {
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

function validateQdStringArray(node, field, errors) {
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

function validateQdEdge(edge, index, ids, errors) {
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

function validateQdRuns(runs, errors) {
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

function validateQdRunPortableCiReuseEvidence(run, index, errors) {
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

function validatePortableQdCiEvidenceLogPath(display, value, errors) {
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

function isQdCiReuseEvidenceRun(run) {
  return (
    run.kind === "ci" &&
    run.status === "passed" &&
    typeof run.summary === "string" &&
    qdCiReuseSummaryPattern.test(run.summary)
  );
}

function normalizeRepoRelativePath(value) {
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

function validateAuditReport(report, displayPath, validate, dagValue, options = {}) {
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

function validateAuditReportSemantics(report, displayPath, dagValue, options = {}) {
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

function validateAlphaReadinessPath(nodes, ids) {
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

function validateNodeSemantics(node, errors) {
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

function validateQdAcceptanceVerificationPaths(node, displayId, errors) {
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

function validateNativeAcceptanceVerificationPaths(node, errors) {
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

function validateAcceptanceVerificationPathReferences(nodeId, fields, errors) {
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

function missingAcceptanceVerificationPathReferences(value) {
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
    if (!existsSync(resolve(root, repoPath))) {
      references.push({ path: repoPath, context });
    }
  }
  return references;
}

function cleanAcceptanceVerificationPath(value) {
  return value
    .replace(/^\.\//u, "")
    .replace(/[),.;:'"]+$/u, "")
    .replace(/#.*$/u, "")
    .replace(/:\d+(?::\d+)?$/u, "");
}

function isCheckableAcceptanceVerificationPath(repoPath) {
  return (
    repoPath.length > 0 &&
    !repoPath.endsWith("/") &&
    /\.[A-Za-z0-9]+$/u.test(repoPath) &&
    !/[{}<>*$]/u.test(repoPath) &&
    !repoPath.includes("...")
  );
}

function isIntentionalMissingPathContext(context) {
  return (
    historicalMissingPathContextPattern.test(context) ||
    /^\s*(?:!|not\s+|test\s+!\s|test\s+-e\s+\S+\s+\|\|)/iu.test(context)
  );
}

function localLineContext(text, index) {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const nextNewline = text.indexOf("\n", index);
  const end = nextNewline === -1 ? text.length : nextNewline;
  return text.slice(start, end).trim();
}

function validateRunnableVerification(node, errors) {
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

function validateConcreteDeliverables(node, errors) {
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

function validateNonPlaceholderAcceptance(node, errors) {
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

function validateImplementableNodeKind(node, errors) {
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

function validateIntegrationNodeSurfaces(node, errors) {
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
function describeIntegrationSurfaceFailure(node, classification) {
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

function validateAlphaPriorityCommandVerification(node, errors) {
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

function validateAlphaCommandReferences(nodes) {
  const errors = [];
  const justRecipes = loadJustRecipeNames();
  const vpTasks = loadVpTaskNames();

  for (const node of nodes) {
    if (node.target !== "alpha") {
      continue;
    }
    const verification = Array.isArray(node.verification) ? node.verification : [];
    for (const [index, entry] of verification.entries()) {
      if (!isRecord(entry) || entry.type !== "command" || typeof entry.value !== "string") {
        continue;
      }
      const command = entry.value;
      for (const recipe of referencedJustRecipes(command)) {
        if (!justRecipes.has(recipe)) {
          errors.push(
            `${node.id} verification[${index}] references missing just recipe ${recipe}: ${command}`,
          );
        }
      }
      for (const task of referencedVpTasks(command)) {
        if (!vpTasks.has(task)) {
          errors.push(
            `${node.id} verification[${index}] references missing vp task ${task}: ${command}`,
          );
        }
      }
      if (
        commandIncludesFlag(command, "--include-ignored") &&
        !isExplicitIgnoredCargoTest(command)
      ) {
        errors.push(
          `${node.id} verification[${index}] include-ignored command must name an exact cargo integration test target and test filter: ${command}`,
        );
      }
      if (
        ["P0", "P1"].includes(node.priority) &&
        isPnpmItotoriAppPackageTestWithPassthrough(command)
      ) {
        errors.push(
          `${node.id} verification[${index}] must use "pnpm --filter @itotori/app exec vitest run" instead of package "test --" passthrough: ${command}`,
        );
      }
      for (const path of rootRelativeItotoriAppTestPaths(command)) {
        errors.push(
          `${node.id} verification[${index}] @itotori/app test path must be package-relative, not root-relative ${path}: ${command}`,
        );
      }
    }
  }

  return errors;
}

function loadJustRecipeNames() {
  let text;
  try {
    text = readFileSync(justfilePath, "utf8");
  } catch {
    return new Set();
  }

  const recipes = new Set();
  for (const match of text.matchAll(/^([A-Za-z0-9_-]+)(?:\s+[^:=\n]+)?\s*:/gmu)) {
    recipes.add(match[1]);
  }
  return recipes;
}

function loadVpTaskNames() {
  let text;
  try {
    text = readFileSync(viteConfigPath, "utf8");
  } catch {
    return new Set();
  }

  const tasksBlock = extractObjectBlock(text, "tasks");
  if (tasksBlock === undefined) {
    return new Set();
  }

  const tasks = new Set();
  for (const match of tasksBlock.matchAll(
    /(?:^|[\s,])(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*:\s*\{/gmu,
  )) {
    tasks.add(match[1] ?? match[2] ?? match[3]);
  }
  return tasks;
}

function extractObjectBlock(text, propertyName) {
  const propertyPattern = new RegExp(String.raw`\b${propertyName}\s*:\s*\{`, "u");
  const match = propertyPattern.exec(text);
  if (!match) {
    return undefined;
  }
  const start = match.index + match[0].lastIndexOf("{");
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start + 1, index);
      }
    }
  }
  return undefined;
}

function referencedJustRecipes(command) {
  const recipes = [];
  for (const segment of commandSegments(command)) {
    const tokens = shellWords(segment);
    let index = skipEnvAssignments(tokens, 0);
    if (tokens[index] === "direnv" && tokens[index + 1] === "exec") {
      index += 3;
      index = skipEnvAssignments(tokens, index);
    }
    if (tokens[index] === "just" && typeof tokens[index + 1] === "string") {
      recipes.push(tokens[index + 1]);
    }
  }
  return recipes;
}

function referencedVpTasks(command) {
  const tasks = [];
  for (const segment of commandSegments(command)) {
    const tokens = shellWords(segment);
    let index = skipEnvAssignments(tokens, 0);
    if (tokens[index] === "pnpm" && tokens[index + 1] === "exec" && tokens[index + 2] === "vp") {
      index += 3;
    } else if (tokens[index] === "vp") {
      index += 1;
    } else {
      continue;
    }
    if (tokens[index] !== "run") {
      continue;
    }
    index += 1;
    while (tokens[index]?.startsWith("-")) {
      index += 1;
    }
    if (typeof tokens[index] === "string") {
      tasks.push(tokens[index]);
    }
  }
  return tasks;
}

function isExplicitIgnoredCargoTest(command) {
  for (const segment of commandSegments(command)) {
    const tokens = shellWords(segment);
    let index = skipEnvAssignments(tokens, 0);
    if (tokens[index] === "direnv" && tokens[index + 1] === "exec") {
      index += 3;
      index = skipEnvAssignments(tokens, index);
    }
    const cargoIndex = tokens.indexOf("cargo", index);
    if (cargoIndex === -1 || tokens[cargoIndex + 1] !== "test") {
      continue;
    }
    const separatorIndex = tokens.indexOf("--", cargoIndex + 2);
    if (separatorIndex === -1 || !tokens.slice(separatorIndex + 1).includes("--include-ignored")) {
      continue;
    }
    const testTargetIndex = tokens.indexOf("--test", cargoIndex + 2);
    if (testTargetIndex === -1 || testTargetIndex > separatorIndex - 2) {
      return false;
    }
    const testTarget = tokens[testTargetIndex + 1];
    const testFilter = tokens[testTargetIndex + 2];
    return isRustIdentifier(testTarget) && isRustTestFilter(testFilter);
  }
  return false;
}

function isPnpmItotoriAppPackageTestWithPassthrough(command) {
  for (const segment of commandSegments(command)) {
    const tokens = shellWords(segment);
    const index = skipEnvAssignments(tokens, 0);
    if (isPnpmItotoriAppTestCommand(tokens, index) && tokens.includes("--")) {
      return true;
    }
  }
  return false;
}

function rootRelativeItotoriAppTestPaths(command) {
  const paths = [];
  for (const segment of commandSegments(command)) {
    const tokens = shellWords(segment);
    const index = skipEnvAssignments(tokens, 0);
    const pathStart = itotoriAppTestPathStart(tokens, index);
    if (pathStart === undefined) {
      continue;
    }
    for (const token of tokens.slice(pathStart)) {
      if (token.startsWith("apps/itotori/test/")) {
        paths.push(token);
      }
    }
  }
  return paths;
}

function itotoriAppTestPathStart(tokens, index) {
  if (isPnpmItotoriAppTestCommand(tokens, index)) {
    const passthroughIndex = tokens.indexOf("--", index);
    return passthroughIndex === -1 ? undefined : passthroughIndex + 1;
  }
  const execVitestRun = pnpmItotoriAppExecVitestRunAt(tokens, index);
  return execVitestRun?.nextIndex;
}

function isPnpmItotoriAppTestCommand(tokens, start) {
  if (tokens[start] !== "pnpm") {
    return false;
  }

  const filter = itotoriAppFilterAt(tokens, start + 1);
  return filter !== undefined && tokens[filter.nextIndex] === "test";
}

function pnpmItotoriAppExecVitestRunAt(tokens, start) {
  if (tokens[start] !== "pnpm") {
    return undefined;
  }

  const filter = itotoriAppFilterAt(tokens, start + 1);
  if (filter === undefined) {
    return undefined;
  }

  const index = filter.nextIndex;
  if (tokens[index] === "exec" && tokens[index + 1] === "vitest" && tokens[index + 2] === "run") {
    return { nextIndex: index + 3 };
  }
  return undefined;
}

function itotoriAppFilterAt(tokens, index) {
  if (tokens[index] === "--filter" && isItotoriAppFilterValue(tokens[index + 1])) {
    return { nextIndex: index + 2 };
  }
  if (tokens[index] === "-F" && isItotoriAppFilterValue(tokens[index + 1])) {
    return { nextIndex: index + 2 };
  }
  const filterValue = tokens[index]?.match(/^--filter=(.+)$/u)?.[1];
  if (filterValue !== undefined && isItotoriAppFilterValue(filterValue)) {
    return { nextIndex: index + 1 };
  }
  const shortFilterValue = tokens[index]?.match(/^-F(.+)$/u)?.[1];
  if (shortFilterValue !== undefined && isItotoriAppFilterValue(shortFilterValue)) {
    return { nextIndex: index + 1 };
  }
  return undefined;
}

function isItotoriAppFilterValue(value) {
  return value === "@itotori/app" || value === "itotori";
}

function commandIncludesFlag(command, flag) {
  return shellWords(command).includes(flag);
}

function commandSegments(command) {
  return command
    .split(/\s+(?:&&|\|\||;)\s+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function shellWords(value) {
  return [...value.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/gu)].map(
    (match) => match[1] ?? match[2] ?? match[3],
  );
}

function skipEnvAssignments(tokens, start) {
  let index = start;
  while (/^[A-Z_][A-Z0-9_]*=/u.test(tokens[index] ?? "")) {
    index += 1;
  }
  return index;
}

function isRustIdentifier(value) {
  return typeof value === "string" && /^[a-z_][a-z0-9_]*$/u.test(value);
}

function isRustTestFilter(value) {
  return typeof value === "string" && /^[a-z_][a-z0-9_:]*$/u.test(value);
}

function validateNoTimeEstimateText(node, errors) {
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
function classifyIntegrationSurface(text) {
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

function isConcreteCommandVerification(value) {
  const normalized = value.trim();
  return (
    normalized.length > 0 &&
    !placeholderCommandVerificationPattern.test(normalized) &&
    commandLikeVerificationPattern.test(normalized) &&
    concreteCommandEvidencePatterns.some((pattern) => pattern.test(normalized))
  );
}

function exactSurfaceVerificationValues(node) {
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

function isGenericRoadmapVerificationCommand(value) {
  const normalized = value.trim();
  return (
    /^node\s+scripts\/spec-dag(?:-validator)?(?:\.test)?\.mjs(?:\s+validate)?$/iu.test(
      normalized,
    ) || /^just\s+(?:check|ci)$/iu.test(normalized)
  );
}

function isExactIntegrationSurfaceCandidate(candidate) {
  const tokens = normalizeSemanticText(candidate).split(" ").filter(Boolean);
  return tokens.some((token) => !genericIntegrationSurfaceCandidateTerms.has(token));
}

function isDocsOnlyNode(node) {
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

function isGenericDeliverable(node, deliverable) {
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

function isPlaceholderAcceptanceCriterion(criterion) {
  return (
    placeholderAcceptancePatterns.some((pattern) => pattern.test(criterion.trim())) ||
    isOwnedSurfacePlaceholder(criterion)
  );
}

function isMetaNodeText(field, value) {
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

function isIntegrationOrReadinessNode(node) {
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

function normalizeSemanticText(value) {
  return value
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/[^a-z0-9/]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function isOwnedSurfacePlaceholder(value) {
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

function printClaim(value, args) {
  const options = parseClaimArgs(args);
  if (options.help) {
    printClaimUsage();
    return;
  }

  const plan = options.release
    ? options.apply
      ? applyClaimRelease({
          dagPath,
          lockDir: options.lockDir,
          nodeId: options.nodeId,
          owner: options.owner,
          branch: options.branch,
          worktree: options.worktree,
        })
      : createClaimReleasePlan(value, options.nodeId, options)
    : options.apply
      ? applyClaim({
          dagPath,
          lockDir: options.lockDir,
          nodeId: options.nodeId,
          owner: options.owner,
          branch: options.branch,
          worktree: options.worktree,
          forceStale: options.forceStale,
          staleAfterHours: options.staleAfterHours,
        })
      : createClaimPlan(value, options.nodeId, options);
  printLifecyclePlan(plan, options);
}

function parseClaimArgs(args) {
  validateArgs(args, {
    commandName: "claim",
    booleanFlags: new Set([
      "--apply",
      "--dry-run",
      "--json",
      "--help",
      "--release",
      "--force-stale",
    ]),
    valueFlags: new Set(["--owner", "--branch", "--worktree", "--lock-dir", "--stale-after-hours"]),
    positionalCount: 1,
  });
  if (args.includes("--apply") && args.includes("--dry-run")) {
    throw new Error("claim accepts either --dry-run or --apply, not both");
  }
  if (args.includes("--release") && args.includes("--force-stale")) {
    throw new Error("claim accepts either --release or --force-stale, not both");
  }
  const nodeId = positionalArgs(args)[0];
  if (!nodeId && !args.includes("--help")) {
    throw new Error("usage: spec-dag claim NODE-ID --owner OWNER [--apply]");
  }
  const staleAfterHours = numberFlag(args, "--stale-after-hours", 24);
  if (staleAfterHours <= 0) {
    throw new Error("--stale-after-hours must be greater than 0");
  }
  return {
    apply: args.includes("--apply"),
    branch: flag(args, "--branch") ?? (nodeId ? defaultBranchForNode(nodeId) : undefined),
    forceStale: args.includes("--force-stale"),
    help: args.includes("--help"),
    json: args.includes("--json"),
    lockDir: flag(args, "--lock-dir") ?? defaultClaimLockDir(root),
    nodeId,
    owner: flag(args, "--owner"),
    release: args.includes("--release"),
    staleAfterHours,
    worktree: flag(args, "--worktree") ?? (nodeId ? defaultWorktreeForNode(nodeId) : undefined),
  };
}

function printClaimUsage() {
  console.log(`usage: spec-dag claim NODE-ID --owner OWNER [--apply] [--json]

Atomically claims a ready planned node by creating a local claim lock and, only
with --apply, updating roadmap/spec-dag.json to in_progress. Without --apply it
prints a dry-run plan and creates no lock. Lock recovery is explicit: --release
removes a lock only when --owner matches the lock metadata and clears matching
in_progress DAG ownership; --force-stale may remove a lock only after its
claimedAt age exceeds staleAfterHours, then reacquires the lock atomically.
Completion --apply retires the completed node's lock after the DAG write.

Options:
  --owner OWNER       required stable owner string
  --branch BRANCH     default: spec/<node-id-lower>
  --worktree PATH     default: /scratch/worktrees/itotori-spec-<node-id-lower>
  --lock-dir DIR      default: /tmp/itotori-spec-dag-claims/<repo-hash>
  --release           explicitly release a matching claim lock and DAG claim
  --force-stale       recover an expired stale lock before claiming
  --stale-after-hours HOURS
                      default: 24; lock age required for --force-stale
  --dry-run           explicit non-mutating mode
  --apply             create the atomic lock and update DAG metadata
  --json              render machine-readable output`);
}

function printWorktree(value, args) {
  const options = parseWorktreeArgs(args);
  if (options.help) {
    printWorktreeUsage();
    return;
  }
  const plan = createWorktreePlan(value, options.nodeId, options);
  const result = options.apply ? applyWorktreePlan(plan) : plan;
  printLifecyclePlan(result, options);
}

function parseWorktreeArgs(args) {
  validateArgs(args, {
    commandName: "worktree",
    booleanFlags: new Set(["--apply", "--dry-run", "--json", "--help"]),
    valueFlags: new Set(["--base", "--branch", "--worktree"]),
    positionalCount: 1,
  });
  if (args.includes("--apply") && args.includes("--dry-run")) {
    throw new Error("worktree accepts either --dry-run or --apply, not both");
  }
  const nodeId = positionalArgs(args)[0];
  if (!nodeId && !args.includes("--help")) {
    throw new Error("usage: spec-dag worktree NODE-ID [--apply]");
  }
  return {
    apply: args.includes("--apply"),
    base: flag(args, "--base") ?? "main",
    branch: flag(args, "--branch") ?? (nodeId ? defaultBranchForNode(nodeId) : undefined),
    help: args.includes("--help"),
    json: args.includes("--json"),
    nodeId,
    worktree: flag(args, "--worktree") ?? (nodeId ? defaultWorktreeForNode(nodeId) : undefined),
  };
}

function printWorktreeUsage() {
  console.log(`usage: spec-dag worktree NODE-ID [--apply] [--json]

Prepares the canonical git worktree command for a DAG node. Without --apply it
prints the command sequence only. With --apply it runs git worktree add only for
legacy native DAG fixtures; canonical qd export state refuses --apply.

Options:
  --base REF           default: main
  --branch BRANCH      default: spec/<node-id-lower>
  --worktree PATH      default: /scratch/worktrees/itotori-spec-<node-id-lower>
  --dry-run            explicit non-mutating mode
  --apply              run git worktree add
  --json               render machine-readable output`);
}

function printAuditIngestion(value, args) {
  const options = parseAuditIngestionArgs(args);
  if (options.help) {
    printAuditIngestionUsage();
    return;
  }
  const report = loadValidatedAuditReport(options.reportPath, value);
  let plan = createAuditIngestionPlan(value, report, options);
  if (options.apply) {
    plan = applyAuditIngestionPlan({
      dagPath,
      plan,
      applyFollowUps: options.applyFollowUps,
    });
  }
  if (options.followUpsPath) {
    writeFileSync(
      resolve(process.cwd(), options.followUpsPath),
      `${JSON.stringify(plan.followUps, null, 2)}\n`,
    );
  }
  printLifecyclePlan(plan, options);
}

function parseAuditIngestionArgs(args) {
  validateArgs(args, {
    commandName: "ingest-audit",
    booleanFlags: new Set(["--apply", "--apply-follow-ups", "--dry-run", "--json", "--help"]),
    valueFlags: new Set(["--follow-ups"]),
    positionalCount: 1,
  });
  if (args.includes("--apply") && args.includes("--dry-run")) {
    throw new Error("ingest-audit accepts either --dry-run or --apply, not both");
  }
  const reportPath = positionalArgs(args)[0];
  if (!reportPath && !args.includes("--help")) {
    throw new Error("usage: spec-dag ingest-audit REPORT.json [--apply]");
  }
  if (args.includes("--apply-follow-ups") && !args.includes("--apply")) {
    throw new Error("ingest-audit --apply-follow-ups requires --apply");
  }
  return {
    apply: args.includes("--apply"),
    applyFollowUps: args.includes("--apply-follow-ups"),
    followUpsPath: flag(args, "--follow-ups"),
    help: args.includes("--help"),
    json: args.includes("--json"),
    reportPath,
  };
}

function printAuditIngestionUsage() {
  console.log(`usage: spec-dag ingest-audit REPORT.json [--apply] [--json]

Validates and ingests an audit report. Default mode is dry-run. P0/P1 findings
produce a schema-valid blocked repair patch for the audited node. P2/P3 findings
produce draft DAG node payloads or append updates without hand-copying.

Options:
  --follow-ups FILE       write generated P2/P3 follow-up payload JSON
  --dry-run               explicit non-mutating mode
  --apply                 apply the P0/P1 repair-state patch to roadmap/spec-dag.json
  --apply-follow-ups      also append generated P2/P3 follow-up changes to the DAG
  --json                  render machine-readable output`);
}

function printCompletion(value, args) {
  const options = parseCompletionArgs(args);
  if (options.help) {
    printCompletionUsage();
    return;
  }
  const report = options.auditPath ? loadValidatedAuditReport(options.auditPath, value) : undefined;
  let plan = createCompletionPlan(value, options.nodeId, {
    apply: options.apply,
    followUpsRecorded: options.followUpsRecorded,
    lockDir: options.lockDir,
    report,
  });
  if (options.apply) {
    plan = applyCompletionPlan({ dagPath, plan, validateDag });
  }
  printLifecyclePlan(plan, options);
  if (!plan.canApply && options.apply) {
    process.exit(1);
  }
}

function parseCompletionArgs(args) {
  validateArgs(args, {
    commandName: "complete",
    booleanFlags: new Set(["--apply", "--dry-run", "--follow-ups-recorded", "--json", "--help"]),
    valueFlags: new Set(["--audit", "--lock-dir"]),
    positionalCount: 1,
  });
  if (args.includes("--apply") && args.includes("--dry-run")) {
    throw new Error("complete accepts either --dry-run or --apply, not both");
  }
  const nodeId = positionalArgs(args)[0];
  if (!nodeId && !args.includes("--help")) {
    throw new Error("usage: spec-dag complete NODE-ID --audit REPORT.json [--apply]");
  }
  if (!flag(args, "--audit") && !args.includes("--help")) {
    throw new Error("complete requires --audit REPORT.json");
  }
  return {
    apply: args.includes("--apply"),
    auditPath: flag(args, "--audit"),
    followUpsRecorded: args.includes("--follow-ups-recorded"),
    help: args.includes("--help"),
    json: args.includes("--json"),
    lockDir: flag(args, "--lock-dir") ?? defaultClaimLockDir(root),
    nodeId,
  };
}

function printCompletionUsage() {
  console.log(`usage: spec-dag complete NODE-ID --audit REPORT.json [--apply] [--json]

Prepares DAG completion bookkeeping only. It never runs git merge and does not
grant merge authority. With an audit report, completion is refused while P0/P1
findings are open; P2/P3 findings require --follow-ups-recorded before --apply.

Options:
  --audit REPORT.json       validated audit report for the node
  --follow-ups-recorded     assert P2/P3 findings are already in DAG or durable artifacts
  --lock-dir DIR            default: /tmp/itotori-spec-dag-claims/<repo-hash>
  --dry-run                 explicit non-mutating mode
  --apply                   update roadmap/spec-dag.json to complete
  --json                    render machine-readable output`);
}

function loadValidatedAuditReport(reportPath, dagValue) {
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

function printLifecyclePlan(plan, options) {
  if (options.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(`${plan.action} ${plan.mode}`);
  console.log(`defaultMutating=${plan.defaultMutating}`);
  if (plan.nodeId) {
    console.log(`node=${plan.nodeId}`);
  }
  if (plan.specId) {
    console.log(`spec=${plan.specId}`);
  }
  if (plan.reportId) {
    console.log(`report=${plan.reportId}`);
  }
  if (plan.lockPath) {
    console.log(`lock=${plan.lockPath}`);
  }
  if (plan.releaseOwner) {
    console.log(`releaseOwner=${plan.releaseOwner}`);
  }
  if (plan.lockRecovery) {
    console.log(`lockRecovery=${JSON.stringify(plan.lockRecovery)}`);
  }
  if (plan.branch) {
    console.log(`branch=${plan.branch}`);
  }
  if (plan.worktree) {
    console.log(`worktree=${plan.worktree}`);
  }
  if (plan.repairState) {
    console.log(`repairState=${plan.repairState}`);
  }
  if (plan.nodePatch) {
    console.log(`nodePatch=${JSON.stringify(plan.nodePatch)}`);
  }
  if (plan.followUps) {
    console.log(`blockingFindings=${plan.blockingFindingIds.join(",") || "none"}`);
    console.log(`followUpFindings=${plan.followUpFindingIds.join(",") || "none"}`);
    console.log(
      `draftNodes=${plan.followUps.draftNodes.map((draft) => draft.node.id).join(",") || "none"}`,
    );
    console.log(
      `existingNodeUpdates=${plan.followUps.existingNodeUpdates.map((update) => update.targetNodeId).join(",") || "none"}`,
    );
  }
  if (plan.canApply === false) {
    console.log(`refusalReason=${plan.refusalReason}`);
  }
  if (plan.commands) {
    for (const commandParts of plan.commands) {
      console.log(`command=${commandParts.join(" ")}`);
    }
  }
  if (plan.mergeAuthority) {
    console.log(`mergeAuthority=${plan.mergeAuthority}`);
  }
  if (plan.gitMergeAttempted === false) {
    console.log("gitMergeAttempted=false");
  }
}

function validateArgs(args, options) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    if (options.booleanFlags.has(arg)) {
      continue;
    }
    if (options.valueFlags.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown ${options.commandName} option ${arg}`);
  }
  const positional = positionalArgs(args);
  if (positional.length > options.positionalCount) {
    throw new Error(`too many ${options.commandName} arguments: ${positional.join(" ")}`);
  }
}

function positionalArgs(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      values.push(arg);
      continue;
    }
    if (
      [
        "--owner",
        "--branch",
        "--worktree",
        "--lock-dir",
        "--base",
        "--follow-ups",
        "--audit",
        "--stale-after-hours",
      ].includes(arg)
    ) {
      index += 1;
    }
  }
  return values;
}

function numberFlag(args, name, defaultValue) {
  const value = flag(args, name);
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }
  return parsed;
}

function printUsageAndExit() {
  console.error(
    "usage: spec-dag <validate|validate-audit-report|ready|pop|show|graph|sync-issues|claim|worktree|ingest-audit|complete> [options]",
  );
  process.exit(1);
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
