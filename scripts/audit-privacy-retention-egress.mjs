#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const manifestPath = "apps/itotori/src/contracts/privacy.ts";
const rebuildSourcePrefix = "apps/itotori/src/llm/";
const rebuildMigrationPrefix = "packages/itotori-db/migrations/";
const manifestRequirements = [
  "PrivacyRetentionEgressContractSchema",
  "RebuildCallWirePolicySchema",
  '"X-OpenRouter-Metadata"',
  '"X-OpenRouter-Cache"',
  "OPENROUTER_ZDR_ACCOUNT_ASSERTED",
  "OPENROUTER_ZDR_GUARDRAIL_ASSERTED",
  "operator-managed-envelope",
  'z.literal("content.read")',
  'z.literal("billing_unknown")',
  'z.literal("/generation")',
  'z.literal("web_search")',
  'z.literal("A7")',
  "QualifyingRunEgressSchema",
];

const contentColumnName =
  /(?:source|target|prompt|response|message|content|output|argument|result|excerpt|ocr|body|payload)/iu;
const metadataColumnName = /(?:hash|_id|key|ref|_at|state|deadline|length|count|version)/iu;
const encryptedColumnName = /(?:encrypted|ciphertext|cipher)/iu;
const metadataOnlyColumnName = /^validation_result$/u;
const contentLogValue =
  /\b(?:sourceText|targetText|prompt|response|message|excerpt|ocrText|arguments|result|content)\b/u;
const logCall =
  /(?:console\.(?:log|debug|info|warn|error)|\b(?:logger|telemetry|span)\.(?:log|debug|info|warn|error|event|record))/u;

function normalize(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function findManifestViolations(source, path = manifestPath) {
  return manifestRequirements
    .filter((requirement) => !source.includes(requirement))
    .map((requirement) => `${path}: missing privacy contract requirement ${requirement}`);
}

export function findPlaintextRebuildColumns(source, path) {
  if (!normalize(path).startsWith(rebuildMigrationPrefix)) return [];
  const violations = [];
  const tableBlocks = source.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(itotori_llm_[a-z0-9_]+)\s*\(([\s\S]*?)\);/giu,
  );
  for (const match of tableBlocks) {
    const table = match[1];
    if (table === undefined) continue;
    const block = match[2] ?? "";
    for (const rawLine of block.split(/\r?\n/u)) {
      const line = rawLine.trim().replace(/,$/u, "");
      if (line.length === 0 || line.startsWith("constraint ") || line.startsWith("primary key")) {
        continue;
      }
      const name = line.match(/^"?([a-z][a-z0-9_]*)"?\s+/iu)?.[1];
      if (
        name !== undefined &&
        contentColumnName.test(name) &&
        !metadataColumnName.test(name) &&
        !metadataOnlyColumnName.test(name) &&
        !encryptedColumnName.test(name)
      ) {
        violations.push(
          `${path}: ${table}.${name} is content-bearing and must use an encrypted/ciphertext column`,
        );
      }
    }
  }
  return violations;
}

export function findContentBearingLogs(source, path) {
  const normalized = normalize(path);
  if (!normalized.startsWith(rebuildSourcePrefix)) return [];
  const violations = [];
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const window = lines.slice(index, index + 8).join("\n");
    if (logCall.test(window) && contentLogValue.test(window)) {
      violations.push(
        `${path}:${index + 1}: content-bearing value reaches a log or telemetry call`,
      );
    }
  }
  return [...new Set(violations)];
}

export function findViolations(files) {
  const violations = [];
  const manifest = files.get(manifestPath);
  if (manifest === undefined) {
    violations.push(`${manifestPath}: privacy contract source is missing`);
  } else {
    violations.push(...findManifestViolations(manifest));
  }
  for (const [path, source] of files) {
    violations.push(...findPlaintextRebuildColumns(source, path));
    violations.push(...findContentBearingLogs(source, path));
  }
  return violations;
}

function trackedFiles() {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/u)
    .filter((path) => path.length > 0)
    .filter(
      (path) =>
        path === manifestPath ||
        path.startsWith(rebuildSourcePrefix) ||
        path.startsWith(rebuildMigrationPrefix),
    );
  return new Map(files.map((path) => [path, readFileSync(join(repoRoot, path), "utf8")]));
}

export function runAudit() {
  const violations = findViolations(trackedFiles());
  for (const violation of violations) console.error(violation);
  return violations.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!existsSync(join(repoRoot, manifestPath))) process.exit(1);
  process.exit(runAudit());
}
