#!/usr/bin/env node
// CI guard: retired LLM repair and old-loop residue must not return.

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const sourceRoots = [
  "apps/itotori/src/",
  "packages/itotori-db/src/",
  "packages/localization-bridge-schema/src/",
];
const forbiddenSymbols = [
  { id: "json-object-repair", pattern: /\brepairJsonObject\b/u },
  { id: "bounded-json-reparse", pattern: /\bparseWithBoundedRepair\b|\bboundedRepair\b/u },
  {
    id: "first-or-balanced-json-extraction",
    pattern: /\b(?:extractFirstJson|extractBalancedJson|first[-_]?json|balanced\w*json)\b/iu,
  },
  { id: "supervisor-salvage", pattern: /\bsupervisor\W+salvage\b/iu },
  { id: "raw-128-token-draft", pattern: /\braw\W{0,3}128\W{0,3}token\b/iu },
  { id: "legacy-provider-interface", pattern: /\bModelProvider\b/u },
  { id: "legacy-provider-registry", pattern: /\bProviderRegistry\b/u },
  {
    id: "legacy-provider-client",
    pattern: /\b(?:OpenRouterProvider|OpenRouterClient|ProviderClient)\b/u,
  },
  { id: "legacy-agent-registry", pattern: /\bAgentRegistry\b/u },
  { id: "legacy-tool-registry", pattern: /\b(?:DeterministicToolRegistry|AgentToolRuntime)\b/u },
  { id: "legacy-generic-scheduler", pattern: /\b(?:Agent|Work|Generic)Scheduler\b/u },
  { id: "legacy-agentic-loop", pattern: /\bAgenticLoop\b/u },
  { id: "legacy-invocation-supervisor", pattern: /\bInvocationSupervisor\b/u },
  { id: "legacy-attempt-journal", pattern: /\bAttemptOutcomeJournal\b/u },
  { id: "legacy-run-ownership", pattern: /\b(?:ActiveRunLease|TerminalRunReservation)\b/u },
  { id: "legacy-artifact-brain", pattern: /\b(?:ContextBrain|SemanticContextStore)\b/u },
  { id: "legacy-finalizer", pattern: /\b(?:TerminalRunFinalizer|LocalizationRunFinalizer)\b/u },
  { id: "legacy-judge", pattern: /\b(?:BlindJudge|ScoredFinding|RegradeLoop)\b/u },
  { id: "legacy-proof", pattern: /\b(?:ProviderProof|RawMtlBaseline)\b/u },
];
const forbiddenPaths = [
  "apps/itotori/src/agents/",
  "apps/itotori/src/providers/",
  "apps/itotori/src/orchestrator/",
  "apps/itotori/src/qa/",
  "apps/itotori/src/batch-planner/",
  "apps/itotori/src/benchmark-harness/",
  "apps/itotori/src/benchmark-set/",
  "apps/itotori/src/benchmark-stages/",
  "apps/itotori/src/experiment-matrix/",
  "apps/itotori/src/experiment-report/",
  "packages/localization-bridge-schema/src/agentic-loop-bundle.ts",
  "packages/localization-bridge-schema/src/raw-mtl-baseline-proof.ts",
  "apps/itotori/src/provider-proof/",
  "apps/itotori/src/raw-mtl-baseline-proof/",
];

export function listTrackedSourceFiles(root = repoRoot) {
  return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((path) => sourceRoots.some((prefix) => path.startsWith(prefix)))
    .filter((path) => /\.(?:ts|tsx|js|mjs)$/u.test(path));
}

export function scanLegacyLlmResidue({
  root = repoRoot,
  files = listTrackedSourceFiles(root),
  readFile = (path) => readFileSync(resolve(root, path), "utf8"),
  pathExists = (path) => existsSync(resolve(root, path)),
} = {}) {
  const violations = [];
  for (const path of forbiddenPaths) {
    if (pathExists(path)) violations.push({ id: "retired-module-present", path });
  }
  for (const path of files) {
    if (!pathExists(path)) continue;
    const text = readFile(path);
    for (const rule of forbiddenSymbols) {
      if (rule.pattern.test(text)) violations.push({ id: rule.id, path });
    }
  }
  return { violations, scannedFiles: files.length };
}

export function renderReport(result) {
  if (result.violations.length === 0) {
    return `legacy-llm-residue guard: passed. ${result.scannedFiles} source file(s) scanned.\n`;
  }
  return [
    `legacy-llm-residue guard: FAILED. ${result.violations.length} violation(s).`,
    ...result.violations.map((violation) => `  ${violation.id}: ${violation.path}`),
    "",
  ].join("\n");
}

function main() {
  const root = process.argv[2] === undefined ? repoRoot : resolve(process.argv[2]);
  const result = scanLegacyLlmResidue({ root });
  const output = renderReport(result);
  if (result.violations.length === 0) process.stdout.write(output);
  else process.stderr.write(output);
  process.exitCode = result.violations.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
