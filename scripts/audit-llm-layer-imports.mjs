#!/usr/bin/env node
// CI guard: LLM-layer import boundary.
//
// The new LLM layer (apps/itotori/src/llm/) is the sole production home for
// model dispatch. Three rules are enforced:
//
//   1. At most ONE production dispatcher — only the designated dispatcher
//      module may import the provider SDK. No other LLM-layer file constructs
//      or calls a provider client directly.
//   2. The LLM layer MUST NOT import domain/decode modules (extract,
//      structure-export, patch-export, localization, play, services, etc.).
//      Decoded facts flow in through strict contract types, not by reaching
//      into decode internals.
//   3. NO imports of the old agents/orchestrator/providers/journal surface.
//      The old surface is frozen for deletion; new code may not couple to it.
//
// Rules are enforced via AST-based import extraction (comments and strings do
// not count) plus relative-path resolution. When the LLM-layer directory does
// not yet exist the guard passes with zero violations — it is proactive, not
// retroactive.
//
// Exit codes: 0 = clean; 1 = violation.
// Wired into `just ci-tier0-meta`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTypeScript, walk } from "./stable-ts-ast.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(join(here, ".."));
const DEFAULT_LEDGER_PATH = join(here, "lint", "deletion-ledger.json");

const TS_LIKE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

// Packages whose import constitutes provider-SDK coupling (dispatcher signal).
const DISPATCHER_SDK_PATTERNS = [
  /^@openrouter\/sdk/u,
  /^@tanstack\/ai-openrouter/u,
  /^@ai-sdk\//u,
  /^ai$/u,
  /^openai$/u,
  /^@anthropic-ai\/sdk/u,
];

function loadLedger(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function getLlmLayerConfig(ledger) {
  return ledger.llmLayer ?? {};
}

function normalizeSlashes(path) {
  return path.replaceAll("\\", "/");
}

// Resolve a relative import specifier against the importing file's directory,
// stripping the .ts/.tsx/.js extension that ESM specifiers carry.
function resolveRelativeImport(importerRepoPath, specifier) {
  const importerDir = dirname(importerRepoPath);
  const stripped = specifier.replace(/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u, "");
  const resolved = normalize(join(importerDir, stripped));
  return normalizeSlashes(resolved);
}

// Extract every import specifier from a parsed AST.
export function extractImportSpecifiers(root) {
  const specifiers = [];
  walk(root, (node) => {
    if (node.type === "ImportDeclaration" && node.source?.value) {
      specifiers.push({
        value: node.source.value,
        line: node.loc?.start.line ?? 0,
      });
    }
    if (node.type === "TSImportEqualsDeclaration" && node.moduleReference) {
      const ref = node.moduleReference;
      if (ref.type === "TSExternalModuleReference" && ref.expression?.value) {
        specifiers.push({
          value: ref.expression.value,
          line: node.loc?.start.line ?? 0,
        });
      }
    }
  });
  return specifiers;
}

function isRelative(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

// Check whether a resolved repo-relative path falls under any forbidden root.
function matchesForbiddenRoot(resolvedPath, forbiddenRoots) {
  for (const root of forbiddenRoots) {
    // The ledger stores roots relative to the LLM layer (e.g. "../agents/").
    // Normalize: strip leading "../" sequences and compare segments.
    const stripped = root.replace(/^(\.\.\/)+/u, "");
    if (resolvedPath.includes(stripped)) return root;
  }
  return null;
}

// Check whether a package import matches a forbidden package name.
function matchesForbiddenPackage(specifier, forbiddenPackages) {
  for (const pkg of forbiddenPackages) {
    if (specifier.includes(pkg)) return pkg;
  }
  return null;
}

function isDispatcherSdkImport(specifier) {
  return DISPATCHER_SDK_PATTERNS.some((re) => re.test(specifier));
}

/**
 * Find import-boundary violations in one LLM-layer source file.
 * Exported for the companion regression suite.
 *
 * @param {string} repoPath - repo-relative path of the file
 * @param {string} contents - file contents
 * @param {object} config - the llmLayer config from the ledger
 */
export function findImportViolations(repoPath, contents, config) {
  const root = parseTypeScript(contents, repoPath);
  const specifiers = extractImportSpecifiers(root);
  const violations = [];
  const forbiddenPackages = config.forbiddenPackageImports ?? [];

  for (const { value, line } of specifiers) {
    if (isRelative(value)) {
      const resolved = resolveRelativeImport(repoPath, value);

      const oldRoot = matchesForbiddenRoot(resolved, config.forbiddenImportRoots ?? []);
      if (oldRoot) {
        violations.push({
          file: repoPath,
          line,
          rule: "forbidden-old-surface",
          import: value,
          matched: oldRoot,
        });
        continue;
      }

      const domainRoot = matchesForbiddenRoot(resolved, config.forbiddenDomainDecodeRoots ?? []);
      if (domainRoot) {
        violations.push({
          file: repoPath,
          line,
          rule: "forbidden-domain-decode",
          import: value,
          matched: domainRoot,
        });
      }
    } else {
      const pkg = matchesForbiddenPackage(value, forbiddenPackages);
      if (pkg) {
        violations.push({
          file: repoPath,
          line,
          rule: "forbidden-package",
          import: value,
          matched: pkg,
        });
      }
    }
  }

  return violations;
}

/**
 * Identify which files in the LLM layer import a provider SDK.
 */
export function findDispatcherCandidates(files, config) {
  const dispatcherPath = config.dispatcherModule ?? null;
  const candidates = [];

  for (const { path, contents } of files) {
    const root = parseTypeScript(contents, path);
    const specifiers = extractImportSpecifiers(root);
    const hasSdk = specifiers.some((s) => isDispatcherSdkImport(s.value));
    if (hasSdk) candidates.push(path);
  }

  return { candidates, dispatcherPath };
}

function listLlmLayerFiles(llmRoot) {
  const absRoot = join(repoRoot, llmRoot);
  if (!existsSync(absRoot)) return [];

  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", llmRoot],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        existsSync(join(repoRoot, l)) &&
        TS_LIKE_EXTENSIONS.some((ext) => l.endsWith(ext)),
    );
}

export function runGuard(ledgerPath) {
  const path = ledgerPath ?? DEFAULT_LEDGER_PATH;
  const ledger = loadLedger(path);
  const config = getLlmLayerConfig(ledger);
  const llmRoot = config.root;

  if (!llmRoot) {
    process.stderr.write("llm-layer-imports guard: no llmLayer.root in ledger.\n");
    return 1;
  }

  const files = listLlmLayerFiles(llmRoot);

  if (files.length === 0) {
    process.stdout.write(
      `llm-layer-imports guard: passed. LLM layer '${llmRoot}' is empty (no code yet).\n`,
    );
    return 0;
  }

  // --- Rule 1: at most one dispatcher ---
  const fileContents = files.map((f) => ({
    path: f,
    contents: readFileSync(join(repoRoot, f), "utf8"),
  }));
  const { candidates, dispatcherPath } = findDispatcherCandidates(fileContents, config);
  const dispatcherViolations = [];

  // Non-dispatcher files that import the SDK are violations.
  for (const candidate of candidates) {
    if (candidate !== dispatcherPath) {
      dispatcherViolations.push({
        file: candidate,
        rule: "unauthorized-dispatcher",
        detail: "imports provider SDK but is not the designated dispatcher module",
      });
    }
  }
  // More than one file total (even if one is the dispatcher) is a violation
  // when the count exceeds 1.
  if (candidates.length > 1) {
    for (const candidate of candidates) {
      if (!dispatcherViolations.some((v) => v.file === candidate)) {
        dispatcherViolations.push({
          file: candidate,
          rule: "multiple-dispatchers",
          detail: `${candidates.length} files import the provider SDK; only one is allowed`,
        });
      }
    }
  }

  // --- Rules 2 & 3: forbidden imports ---
  const importViolations = [];
  for (const { path: f, contents } of fileContents) {
    importViolations.push(...findImportViolations(f, contents, config));
  }

  const allViolations = [...dispatcherViolations, ...importViolations];

  if (allViolations.length > 0) {
    process.stderr.write(
      `llm-layer-imports guard: FAILED. ${allViolations.length} violation(s).\n\n`,
    );
    for (const v of allViolations) {
      if (v.rule === "unauthorized-dispatcher" || v.rule === "multiple-dispatchers") {
        process.stderr.write(`  ${v.file}  [${v.rule}]  ${v.detail}\n`);
      } else {
        process.stderr.write(
          `  ${v.file}:${v.line}  [${v.rule}]  import "${v.import}" matches ${v.matched}\n`,
        );
      }
    }
    return 1;
  }

  process.stdout.write(
    `llm-layer-imports guard: passed. ${files.length} LLM-layer file(s) scanned; ` +
      `${candidates.length} dispatcher(s), 0 forbidden imports.\n`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(runGuard());
}
