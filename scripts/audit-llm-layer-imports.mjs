#!/usr/bin/env node
// CI guard: LLM-layer import boundary.
//
// The new LLM layer (apps/itotori/src/llm/) is the sole production home for
// model dispatch. Four rules are enforced:
//
//   1. Exactly ONE production dispatcher — only the designated dispatcher
//      module may import the provider SDK. No other production file constructs
//      or calls a provider client directly.
//   2. The LLM layer MUST NOT import domain/decode modules (extract,
//      structure-export, patch-export, localization, play, services, etc.).
//      Decoded facts flow in through strict contract types, not by reaching
//      into decode internals.
//   3. NO imports of the old agents/orchestrator/providers/journal surface.
//      The old surface is frozen for deletion; new code may not couple to it.
//   4. The complete production dependency graph contains no edge to a retired
//      root, repository, proof surface, or old-loop schema module.
//
// Rules are enforced via AST-based import extraction (comments and strings do
// not count) plus relative-path resolution.
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

// Extract every module-loading specifier from a parsed AST. Re-exports,
// dynamic imports, and CommonJS require calls are dependency edges too.
export function extractImportSpecifiers(root) {
  const specifiers = [];
  const addSpecifier = (node, source) => {
    if (typeof source !== "string") return;
    specifiers.push({
      value: source,
      line: node.loc?.start.line ?? 0,
    });
  };
  walk(root, (node) => {
    if (node.type === "ImportDeclaration" && node.source?.value) {
      addSpecifier(node, node.source.value);
    }
    if (
      (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
      node.source?.value
    ) {
      addSpecifier(node, node.source.value);
    }
    if (node.type === "TSImportEqualsDeclaration" && node.moduleReference) {
      const ref = node.moduleReference;
      if (ref.type === "TSExternalModuleReference" && ref.expression?.value) {
        addSpecifier(node, ref.expression.value);
      }
    }
    if (node.type === "ImportExpression" && node.source?.value) {
      addSpecifier(node, node.source.value);
    }
    if (node.type === "CallExpression") {
      const isDynamicImport = node.callee?.type === "Import";
      const isRequire = node.callee?.type === "Identifier" && node.callee.name === "require";
      if ((isDynamicImport || isRequire) && node.arguments?.[0]?.type === "StringLiteral") {
        addSpecifier(node, node.arguments[0].value);
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
 * Identify which production files import a provider SDK.
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

export function findDispatcherViolations(candidates, dispatcherPath) {
  const violations = [];
  if (dispatcherPath === null) {
    return [{ file: "<ledger>", rule: "missing-dispatcher-module", detail: "not configured" }];
  }
  if (candidates.length === 0) {
    return [
      {
        file: dispatcherPath,
        rule: "missing-dispatcher",
        detail: "does not import a provider SDK",
      },
    ];
  }
  for (const candidate of candidates) {
    if (candidate !== dispatcherPath) {
      violations.push({
        file: candidate,
        rule: "unauthorized-dispatcher",
        detail: "imports a provider SDK but is not the designated dispatcher module",
      });
    }
  }
  if (!candidates.includes(dispatcherPath)) {
    violations.push({
      file: dispatcherPath,
      rule: "missing-dispatcher",
      detail: "does not import a provider SDK",
    });
  }
  if (candidates.length > 1) {
    violations.push({
      file: dispatcherPath,
      rule: "multiple-dispatchers",
      detail: `${candidates.length} files import a provider SDK; exactly one is required`,
    });
  }
  return violations;
}

/**
 * Reject a production dependency edge that reaches a retired surface. The
 * ledger tokens work for both resolved relative paths and package specifiers.
 */
export function findDependencyGraphViolations(files, config) {
  const tokens = config.forbiddenProductionImportTokens ?? [];
  const violations = [];
  for (const { path, contents } of files) {
    const root = parseTypeScript(contents, path);
    for (const { value, line } of extractImportSpecifiers(root)) {
      const resolved = isRelative(value) ? resolveRelativeImport(path, value) : value;
      const matched = tokens.find((token) => resolved.includes(token));
      if (matched !== undefined) {
        violations.push({
          file: path,
          line,
          rule: "retired-dependency-edge",
          import: value,
          matched,
        });
      }
    }
  }
  return violations;
}

function listTrackedSourceFiles(sourceRoots) {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        existsSync(join(repoRoot, l)) &&
        sourceRoots.some((root) => l.startsWith(root)) &&
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

  const files = listTrackedSourceFiles([llmRoot]);

  if (files.length === 0) {
    process.stderr.write(`llm-layer-imports guard: FAILED. LLM layer '${llmRoot}' is empty.\n`);
    return 1;
  }

  const productionRoots = config.productionSourceRoots ?? [llmRoot];
  const productionFiles = listTrackedSourceFiles(productionRoots);
  if (productionFiles.length === 0) {
    process.stderr.write("llm-layer-imports guard: FAILED. no production source files found.\n");
    return 1;
  }

  // --- Rule 1: exactly one dispatcher across the production graph ---
  const fileContents = files.map((f) => ({
    path: f,
    contents: readFileSync(join(repoRoot, f), "utf8"),
  }));
  const productionContents = productionFiles.map((f) => ({
    path: f,
    contents: readFileSync(join(repoRoot, f), "utf8"),
  }));
  const { candidates, dispatcherPath } = findDispatcherCandidates(productionContents, config);
  const dispatcherViolations = findDispatcherViolations(candidates, dispatcherPath);

  // --- Rules 2 & 3: forbidden imports ---
  const importViolations = [];
  for (const { path: f, contents } of fileContents) {
    importViolations.push(...findImportViolations(f, contents, config));
  }
  const graphViolations = findDependencyGraphViolations(productionContents, config);

  const allViolations = [...dispatcherViolations, ...importViolations, ...graphViolations];

  if (allViolations.length > 0) {
    process.stderr.write(
      `llm-layer-imports guard: FAILED. ${allViolations.length} violation(s).\n\n`,
    );
    for (const v of allViolations) {
      if (v.detail !== undefined) {
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
    `llm-layer-imports guard: passed. ${files.length} LLM-layer and ${productionFiles.length} ` +
      `production file(s) scanned; exactly ${candidates.length} dispatcher, 0 forbidden imports.\n`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(runGuard());
}
