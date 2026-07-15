#!/usr/bin/env node
// CI guard: LLM-layer LOC budget.
//
// Production LLM TypeScript is capped at the budget defined in the deletion
// ledger (default 5,000 lines). The count EXCLUDES:
//   - prompt prose (subdirectories listed in llmLayer.locExcludedSubdirs)
//   - generated schemas (same exclusion mechanism)
//   - test files (*.test.ts, *.test.tsx, *.spec.ts, *.spec.tsx)
//
// When the LLM-layer directory does not yet exist the guard passes at zero
// lines. This is the shrink-only ratchet's starting point: the budget is a
// ceiling, not a target.
//
// Exit codes: 0 = at or under budget; 1 = over budget.
// Wired into `just ci-tier0-meta`.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const DEFAULT_LEDGER_PATH = join(here, "lint", "deletion-ledger.json");

const COUNT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const TEST_PATTERNS = [/\.test\.(?:ts|tsx|mts|cts)$/u, /\.spec\.(?:ts|tsx|mts|cts)$/u];

function loadLedger(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function getLlmLayerConfig(ledger) {
  return ledger.llmLayer ?? {};
}

export function countLines(contents) {
  let n = 0;
  for (let i = 0; i < contents.length; i += 1) {
    if (contents.charCodeAt(i) === 10) n += 1;
  }
  return n;
}

function isTestFile(path) {
  return TEST_PATTERNS.some((re) => re.test(path));
}

// Check whether a file path falls under an excluded subdirectory.
function isExcluded(path, excludedSubdirs, llmRoot) {
  for (const sub of excludedSubdirs) {
    const excludedPrefix = normalizeSlashes(join(llmRoot, sub));
    if (path.startsWith(excludedPrefix)) return true;
  }
  return false;
}

function normalizeSlashes(p) {
  return p.replaceAll("\\", "/");
}

// Recursively collect production TS files under the LLM layer root, applying
// the exclusion rules. Exported for testing.
export function collectCountedFiles(rootAbs, llmRoot, excludedSubdirs) {
  const results = [];

  function walk(dir, repoRelativeDir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const repoRel = normalizeSlashes(join(repoRelativeDir, entry.name));
      if (entry.isDirectory()) {
        walk(full, repoRel);
      } else if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf("."));
        if (!COUNT_EXTENSIONS.has(ext)) continue;
        if (isTestFile(repoRel)) continue;
        if (isExcluded(repoRel, excludedSubdirs, llmRoot)) continue;
        results.push({ path: repoRel, abs: full });
      }
    }
  }

  walk(rootAbs, llmRoot);
  return results;
}

export function evaluateBudget(ledger, rootDir) {
  const root = rootDir ?? repoRoot;
  const config = getLlmLayerConfig(ledger);
  const llmRoot = config.root;
  const budget = config.locBudget ?? 5000;
  const excludedSubdirs = config.locExcludedSubdirs ?? [];

  if (!llmRoot) {
    return { ok: false, error: "no llmLayer.root in ledger", counted: 0, budget };
  }

  const absRoot = join(root, llmRoot);
  if (!existsSync(absRoot)) {
    return { ok: true, counted: 0, budget, files: [] };
  }

  const files = collectCountedFiles(absRoot, llmRoot, excludedSubdirs);
  let total = 0;
  const perFile = [];
  for (const { path, abs } of files) {
    const lines = countLines(readFileSync(abs, "utf8"));
    total += lines;
    perFile.push({ path, lines });
  }

  perFile.sort((a, b) => b.lines - a.lines);

  return {
    ok: total <= budget,
    counted: total,
    budget,
    files: perFile,
  };
}

export function runGuard(ledgerPath) {
  const path = ledgerPath ?? DEFAULT_LEDGER_PATH;
  const ledger = loadLedger(path);
  const { ok, counted, budget, files, error } = evaluateBudget(ledger);

  if (error) {
    process.stderr.write(`llm-loc-budget guard: FAILED. ${error}.\n`);
    return 1;
  }

  if (ok) {
    process.stdout.write(
      `llm-loc-budget guard: passed. ${counted}/${budget} lines ` +
        `(${files.length} production file(s)).\n`,
    );
    return 0;
  }

  process.stderr.write(
    `llm-loc-budget guard: FAILED. ${counted} lines exceeds the ${budget}-line budget ` +
      `by ${counted - budget}.\n` +
      `Top files by line count:\n`,
  );
  for (const f of files.slice(0, 20)) {
    process.stderr.write(`  ${String(f.lines).padStart(6)}  ${f.path}\n`);
  }
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(runGuard());
}
