import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const require = createRequire(import.meta.url);
export const dagPath = resolve(root, "roadmap/spec-dag.json");
export const schemaPath = resolve(root, "roadmap/spec-dag.schema.json");
export const auditSchemaPath = resolve(root, "roadmap/audit-report.schema.json");
export const auditExamplesPath = resolve(root, "roadmap/examples");
export const schema = loadJson(schemaPath);
export const nodeSchema = schema.$defs.node.properties;

export const allowed = {
  status: new Set(nodeSchema.status.enum),
  priority: new Set(nodeSchema.priority.enum),
  target: new Set(nodeSchema.target.enum),
  project: new Set(nodeSchema.projects.items.enum),
  parallelGroup: new Set(nodeSchema.parallelGroup.enum),
  verificationType: new Set(nodeSchema.verification.items.properties.type.enum),
};

export const requiredNodeFields = [
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

export const optionalNodeFields = [
  "statusReason",
  "issue",
  "branch",
  "worktree",
  "owner",
  "blockedBy",
];

// qd 0.4.0 emits schema_version 3; qd 0.1.16 emits 2; earlier exports and test
// fixtures use 1. All share the same top-level node/edge/registry/run shape this
// validator checks (v3 = migration 010 merge-queue lifecycle, no structural change).
export const qdExportSchemaVersions = new Set([1, 2, 3]);
export const legacyLifecycleApplyCommands = new Set([
  "claim",
  "worktree",
  "ingest-audit",
  "complete",
]);
export const qdExportLifecycleRefusal =
  "legacy spec-dag lifecycle --apply is disabled for qd export state; use qd claim/complete/gate/check/ci/merge and re-export roadmap/spec-dag.json";
export const qdStatusMap = {
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
export const qdAllowedStatuses = new Set(Object.keys(qdStatusMap));
export const qdPlaceholderTextPattern =
  /^(?:test(?:\s+(?:spec|acc|acceptance|focus))?|todo|tbd)$/iu;
export const qdActiveAuditFixStatuses = new Set([
  "ready",
  "claimed",
  "working",
  "review",
  "fixing",
  "ci",
  "mergeable",
]);
export const qdGenericAuditFixAcceptancePattern = /^finding is addressed and verified\.$/iu;
export const qdCiReuseSummaryPattern =
  /\b(?:covered by|covered-by|reused|reuse|record-pass|(?:implementation\s+)?ci already passed|(?:qd\s+)?full[- ]ci passed|integrated .*?\bci\b|integrated .*?\bqd-full-ci\b)\b/iu;
export const qdLocalLogPathPattern =
  /(?:^|[\s=])(?:\.qd\/logs\/|\/[^\s]*\/\.qd\/logs\/|[A-Za-z]:[\\/][^\s]*[\\/]\.qd[\\/]logs[\\/])/u;
export const qdEvidenceLogPathPattern = /(?:^|\n)Evidence:\s*log_path=([^\s]+)/iu;
export const windowsAbsolutePathPattern = /^[A-Za-z]:[\\/]/u;
export const acceptanceVerificationPathRoots =
  "(?:\\.github|apps|bin|crates|docs|fixtures|packages|presets|roadmap|scripts|suite|tests|tools)";
export const acceptanceVerificationPathPattern = new RegExp(
  "(?:^|[\\s([`'\"])(\\.?\\/?" + acceptanceVerificationPathRoots + "\\/[A-Za-z0-9._@%+~/-]+)",
  "gu",
);
export const historicalMissingPathContextPattern =
  /\b(?:absent|deleted|does not exist|do not exist|missing\s+(?:artifact|file|path|reference|script|target|test)s?|no longer|no such file|removed|renamed|replaced|retired|stale|successor|superseded|historical|returns 0|returns no hits)\b/iu;
// `roadmap/spec-dag.json` retains completed qd records as an audit trail. The
// no-legacy cutover deliberately removed these old-world surfaces, so their
// historical evidence must not make the current-tree validator fail. Keep this
// list precise: a newly missing path outside these retired roots remains an
// error for a completed record.
export const retiredLegacyPathPatterns = [
  /^apps\/itotori\/src\/(?:agents|batch-planner|draft(?:-feedback)?|experiment-matrix|orchestrator|providers|qa|route-reliability|telemetry)\//u,
  /^apps\/itotori\/test\/(?:api-handlers|experiment-matrix|localize-project-stage|openrouter-provider|provider-abstraction)\.test\.ts$/u,
  /^apps\/itotori\/test\/character-relationship[^/]*\.test\.ts$/u,
  /^apps\/itotori\/test\/fixtures\/agentic-loop-smoke-/u,
  /^packages\/localization-bridge-schema\/test\/pair-policy\.v0\.3\.test\.ts$/u,
  /^presets\/localize-project\./u,
  /^suite\/scripts\/(?:alpha-public-fixture|localize-project)\//u,
];
export const justfilePath = resolve(root, "justfile");
export const viteConfigPath = resolve(root, "vite.config.ts");

export const priorityRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
export const targetRank = {
  baseline: 0,
  "real-game-testing-ready": 1,
  alpha: 2,
  beta: 3,
  continuous: 4,
};
export const semanticValidationStatuses = new Set(["planned", "in_progress", "blocked"]);
export const genericDeliverableValues = new Set([
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
export const titleDerivedGenericDeliverableSuffixes = [
  "implementation",
  "fixtures",
  "tests",
  "regression coverage",
  "end to end fixture",
  "e2e fixture",
  "integration surface",
];
export const placeholderAcceptancePatterns = [
  /^(?:.+\s+)?has concrete executable behavior or schema validation$/iu,
  /^has concrete executable behavior$/iu,
  /^has schema validation$/iu,
  /^acceptance is based on executable fixtures, validators, services, or commands$/iu,
  /^the integration composes (?:the )?prerequisite implementation slices without expanding their scope$/iu,
];
export const manualOnlyVerificationPattern =
  /\b(?:test|tests|smoke|fixture|fixtures|golden|round[- ]trip|validation|validate|check)\b/iu;
export const docsOnlyPattern =
  /\b(?:docs?|documentation|readme|adr|policy|spec|guide|playbook)\b/iu;
export const implementationPattern =
  /\b(?:adapter|api|artifact|bridge|cli|command|contract|dashboard|database|delta|fixture|generator|harness|implementation|ingest|migration|model|parser|patch|queue|repository|runner|schema|service|smoke|test|ui|validator|workflow)\b/iu;
export const metaNodePattern =
  /\b(?:meta[- ]?pack|follow[- ]up pack|normalize[- ]later|granularity follow[- ]up normalizer|report[- ]only|decision[- ]only|decision node|decision record|feasibility[- ]only|feasibility (?:assessment|report|node|study)|research[- ]only|research only|investigation[- ]only|investigation only|research node|investigation node|spike(?!-)|proof[- ]of[- ]concept|POC|research phase|investigation phase)\b/iu;
export const implementableDecisionPattern =
  /\b(?:api|command|contract|dashboard|events?|generator|import|model|persistence|queue|read model|renderer|schema|service|ui|validator|workflow|wiring)\b/iu;
export const placeholderCommandVerificationPattern =
  /^(?:tbd|todo|manual review|command|verification command|exact command|owned command(?:,\s+service,\s+schema,\s+or artifact surface)?)$/iu;
export const commandLikeVerificationPattern =
  /^(?:(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*|env\s+(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*)(?:cargo|node|pnpm|just|npm|npx|uv|python|python3|bash|sh|test|make|go|deno|bun|ruby|rspec|pytest|ruff|vitest|jest|tsx|ts-node|docker|docker\s+compose|git|gh)\b(?:\s+[^\n]+)?$/iu;
export const concreteCommandEvidencePatterns = [
  /\s(?:--?[a-z][a-z0-9-]*)(?:[=\s]|$)/iu,
  /\s(?:\.{0,2}\/|[a-z0-9._-]+\/|[a-z0-9._/-]+\.[a-z0-9]+)\S*/iu,
  /(?:^|\s)@[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?\b/iu,
  /\b[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._:-]*\b/iu,
  /^(?:(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*|env\s+(?:-[a-z]\s+[A-Z_][A-Z0-9_]*\s+|[A-Z_][A-Z0-9_]*=[^\s]+\s+)*)(?:cargo|go)\s+(?:build|check|clippy|deny|fmt|test)\b/iu,
  /^(?:(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*|env\s+(?:-[a-z]\s+[A-Z_][A-Z0-9_]*\s+|[A-Z_][A-Z0-9_]*=[^\s]+\s+)*)(?:just|make|npm|npx|pnpm|uv|pytest|ruff|vitest|jest|rspec)\s+[a-z0-9][a-z0-9:_-]*\b/iu,
  /^(?:(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*|env\s+(?:-[a-z]\s+[A-Z_][A-Z0-9_]*\s+|[A-Z_][A-Z0-9_]*=[^\s]+\s+)*)(?:docker\s+compose|docker|git|gh)\s+[a-z0-9][a-z0-9:_-]*\b/iu,
  /^(?:(?:[A-Z_][A-Z0-9_]*=[^\s]+\s+)*|env\s+(?:-[a-z]\s+[A-Z_][A-Z0-9_]*\s+|[A-Z_][A-Z0-9_]*=[^\s]+\s+)*)(?:bash|sh|node|python|python3|deno|bun|ruby|tsx|ts-node)\s+\S*(?:\/|\.[a-z0-9]+)\S*/iu,
];
export const timeEstimateFieldPattern =
  /(?:estimate|estimated|duration|hours?|days?|effort|points?|tshirt|t[- ]shirt)/iu;
export const timeEstimateQuantityPattern =
  /(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|a|an|half|couple(?:\s+of)?|few|several)/iu;
export const compactTimeEstimateQuantityPattern = String.raw`\d+(?:\.\d+)?\s*(?:m|h|d|w|mo|mos)`;
export const effortSizePattern = String.raw`(?:x[-\s]?s|xs|s|m|l|x[-\s]?l|xl|small|medium|large|low|high)`;
export const timeEstimateTextPattern = new RegExp(
  String.raw`\b(?:${timeEstimateQuantityPattern.source})(?:\s+|-)(?:person[-\s]?)?(?:minutes?|hours?|days?|weeks?|months?|story\s+points?|points?|pts?)\b|\bt[- ]?shirt\s+size(?:\s*(?:[:=]|\bis\b|\bas\b)\s*${effortSizePattern})?\b|\b(?:estimated?\s+)?(?:effort|duration)\s*(?:[:=]|\bis\b|\bof\b|\bat\b|\babout\b|\baround\b|\broughly\b)?\s*(?:(?:${timeEstimateQuantityPattern.source})(?:\s+|-)(?:minutes?|hours?|days?|weeks?|months?|story\s+points?|points?|pts?)|${compactTimeEstimateQuantityPattern}|${effortSizePattern})\b|\b(?:sized|sizing)\s*(?:[:=]|\bas\b|\bat\b|\bfor\b)\s*${effortSizePattern}\b`,
  "iu",
);
export const schedulingTextPattern =
  /\b(?:in\s+sprint\s+\d+|planned\s+for\s+sprint\s+\d+|scheduled\s+for\s+(?:next\s+)?sprint|runs\s+next\s+sprint)\b/iu;
export const exactIntegrationSurfaceQualifierPattern = String.raw`(?:asset|benchmark|bgi|binary|branch|catalog|capability|capture|community|corpus|cost|cross[- ]source|dashboard|decision|delta|draft|edition|encrypted|encrypted[- ]profile|engine|event|experiment|feedback|full[- ]surface|helper|install[- ]state|key|kirikiri|ledger|locale|local|local[- ]corpus|manual|matrix|model|mv\/mz|openrouter|patch|permission|private[- ]local|provider|public[- ]fixture|qa|quality|readiness|real[- ]engine|review|reviewer|runtime|siglus|source|style|trace|translation|triage|vm|wolf|xp3)`;
export const exactIntegrationSurfaceNounPattern = String.raw`(?:adapter|api|artifact|artifacts|bridge|command|contract|dashboard|delta|diagnostic|diagnostics|evidence|export|fixture|fixtures|generator|harness|import|ledger|manifest|matrix|model|parser|patcher|profile|queue|record|records|renderer|report|resolver|route|run|schema|service|smoke|storage|store|surface|tool|tools|ui|ux|validator|workflow)`;
export const genericIntegrationSurfaceCandidateTerms = new Set([
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
export const exactIntegrationSurfaceCandidatePatterns = [
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
export const explicitIntegrationSurfaceMatchers = [
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

export function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
