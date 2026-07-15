#!/usr/bin/env node
// CI guard: deletion-ledger reality check.
//
// The ledger (scripts/lint/deletion-ledger.json) freezes the exact old app
// surface scheduled for deletion, the DB/provider/QA collateral, the
// deterministic kernels to rehome, and the new LLM-layer boundary. This guard
// asserts the ledger matches the working tree: named paths exist (or are gone)
// as expected, and recorded line counts are accurate. A mismatch means either
// the tree drifted (a rename, a new file) or the ledger is stale — both require
// explicit reconciliation, never a silent pass.
//
// Exit codes: 0 = ledger matches reality; 1 = mismatch.
// Wired into `just ci-tier0-meta`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const DEFAULT_LEDGER_PATH = join(here, "lint", "deletion-ledger.json");

export function loadLedger(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function countLinesInFile(filePath) {
  return readFileSync(filePath, "utf8").split("\n").length - 1;
}

// Recursively collect files under root matching extensions.
export function collectFiles(root, extensions) {
  const results = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf("."));
        if (extensions.has(ext)) results.push(full);
      }
    }
  }
  walk(root);
  return results;
}

export function countLinesInDir(rootAbs, extensions) {
  return collectFiles(rootAbs, extensions).reduce((sum, f) => sum + countLinesInFile(f), 0);
}

export function evaluateLedger(ledger, rootDir) {
  const root = rootDir ?? repoRoot;
  const violations = [];

  function addViolation(id, kind, detail) {
    violations.push({ id, kind, detail });
  }

  // --- app surface: verify existence + line counts ---
  for (const entry of ledger.delete?.appSurface ?? []) {
    const expected = entry.expected ?? "present";

    if (entry.kind === "glob") {
      const absRoot = join(root, entry.root);
      const exists = existsSync(absRoot);
      if (expected === "present") {
        if (!exists) {
          addViolation(entry.id, "missing-dir", entry.root);
          continue;
        }
        const exts = new Set(entry.extensions ?? [".ts", ".tsx"]);
        const counted = countLinesInDir(absRoot, exts);
        if (counted !== entry.lines) {
          addViolation(entry.id, "line-count-drift", {
            root: entry.root,
            expected: entry.lines,
            actual: counted,
            delta: counted - entry.lines,
          });
        }
      } else {
        if (exists) addViolation(entry.id, "should-be-gone", entry.root);
      }
    }

    if (entry.kind === "globs") {
      let total = 0;
      let anyMissing = false;
      const exts = new Set(entry.extensions ?? [".ts", ".tsx"]);
      for (const rootPath of entry.roots) {
        const absRoot = join(root, rootPath);
        const exists = existsSync(absRoot);
        if (expected === "present") {
          if (!exists) {
            addViolation(entry.id, "missing-dir", rootPath);
            anyMissing = true;
            continue;
          }
          total += countLinesInDir(absRoot, exts);
        } else {
          if (exists) addViolation(entry.id, "should-be-gone", rootPath);
        }
      }
      if (expected === "present" && !anyMissing && total !== entry.lines) {
        addViolation(entry.id, "line-count-drift", {
          roots: entry.roots,
          expected: entry.lines,
          actual: total,
          delta: total - entry.lines,
        });
      }
    }

    if (entry.kind === "files") {
      for (const f of entry.files) {
        const abs = join(root, f);
        const exists = existsSync(abs);
        if (expected === "present") {
          if (!exists) addViolation(entry.id, "missing", f);
        } else {
          if (exists) addViolation(entry.id, "should-be-gone", f);
        }
      }
      if (expected === "present") {
        const total = entry.files.reduce((sum, f) => {
          const abs = join(root, f);
          return existsSync(abs) ? sum + countLinesInFile(abs) : sum;
        }, 0);
        if (total !== entry.lines) {
          addViolation(entry.id, "line-count-drift", {
            expected: entry.lines,
            actual: total,
            delta: total - entry.lines,
          });
        }
      }
    }
  }

  // --- contractual total ---
  const recordedTotal = ledger.contractualTotalLines;
  const sumOfParts = (ledger.delete?.appSurface ?? []).reduce((sum, e) => sum + (e.lines ?? 0), 0);
  if (recordedTotal !== sumOfParts) {
    addViolation("contractual-total", "total-mismatch", {
      contractual: recordedTotal,
      sumOfParts,
    });
  }

  // --- collateral paths ---
  function checkCollateral(id, paths) {
    for (const p of paths) {
      const abs = join(root, p);
      if (!existsSync(abs)) addViolation(id, "missing", p);
    }
  }
  checkCollateral("providerCollateral", ledger.delete?.providerCollateral ?? []);
  checkCollateral("qaCollateral", ledger.delete?.qaCollateral ?? []);
  checkCollateral("dbCollateral", ledger.delete?.dbCollateral ?? []);
  checkCollateral("schemaCollateral", ledger.delete?.schemaCollateral ?? []);
  checkCollateral("migrationsRetired", ledger.delete?.migrationsRetired ?? []);
  checkCollateral("migrationsSurgery", ledger.delete?.migrationsSurgery ?? []);

  // --- rehome sources ---
  for (const entry of ledger.rehome ?? []) {
    const abs = join(root, entry.from);
    if (!existsSync(abs)) addViolation("rehome", "missing", entry.from);
  }

  return { ok: violations.length === 0, violations };
}

function formatViolation(v) {
  switch (v.kind) {
    case "missing":
      return `  MISSING      ${v.id}: ${v.detail}`;
    case "missing-dir":
      return `  MISSING-DIR  ${v.id}: ${v.detail}`;
    case "should-be-gone":
      return `  PRESENT      ${v.id}: ${v.detail} (expected absent)`;
    case "line-count-drift": {
      const d = v.detail;
      const sign = d.delta >= 0 ? "+" : "";
      return `  LINE-DRIFT   ${v.id}: expected ${d.expected}, got ${d.actual} (${sign}${d.delta})`;
    }
    case "total-mismatch": {
      const d = v.detail;
      return `  TOTAL-MISMATCH  contractual=${d.contractual}, sumOfParts=${d.sumOfParts}`;
    }
    default:
      return `  UNKNOWN      ${v.id}: ${JSON.stringify(v.detail)}`;
  }
}

export function runGuard(ledgerPath) {
  const path = ledgerPath ?? DEFAULT_LEDGER_PATH;
  const ledger = loadLedger(path);
  const { ok, violations } = evaluateLedger(ledger);

  if (ok) {
    process.stdout.write(
      `deletion-ledger guard: passed. ${ledger.contractualTotalLines} contractual lines verified.\n`,
    );
    return 0;
  }

  process.stderr.write(
    `deletion-ledger guard: FAILED. ${violations.length} mismatch(es).\n` +
      `The ledger and the working tree disagree. Reconcile explicitly.\n\n`,
  );
  for (const v of violations) {
    process.stderr.write(`${formatViolation(v)}\n`);
  }
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(runGuard());
}
