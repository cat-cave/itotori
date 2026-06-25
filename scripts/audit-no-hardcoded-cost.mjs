#!/usr/bin/env node
// ITOTORI-225 — CI guard: fail on any hardcoded model cost, deprecated
// cost-tier abstraction, or revived `unknown` / `provider_estimate` /
// `local_estimate` enum literal in the itotori codebase.
//
// Per the standing rule from Trevor (2026-06-25):
//   "There should never be a single hardcoded model cost anywhere in this
//   repo, under any circumstances, ever. There should also never be a
//   'fallback' or 'unknown' cost. Every model on openrouter has publicly
//   and easily queryable cost stats..."
//
// And per docs/audits/openrouter-cost-tracking-audit-2026-06-25.md §3 N1,
// once the rip-out lands (ITOTORI-225), no commit may re-introduce the
// deleted shapes. This script greps the source tree for the forbidden
// patterns, skipping allow-listed paths (recorded fixtures preserve real
// captured costs; this script itself documents the patterns it forbids).
//
// Exit codes:
//   0 — no violations
//   1 — at least one violation detected; details printed to stderr
//
// Run: `node scripts/audit-no-hardcoded-cost.mjs`
// Wired into `just check` via the orchestrator's CI invocation in the same
// change that introduces this file.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// Allow-list: paths whose contents are exempt from the audit. Recorded
// bundles store real captured spend amounts that we deliberately want to
// keep verbatim. The audit script itself prints the forbidden patterns as
// part of its error messages and so must self-exempt.
const ALLOW_LIST = [
  "apps/itotori/test/fixtures/recorded-bundles/",
  "scripts/audit-no-hardcoded-cost.mjs",
  // Bridge-schema is a cross-app contract that owns the legacy
  // BenchmarkCostKindV02 enum until the corresponding schema-side
  // corrective node lands. Itotori narrows at the ingest boundary
  // (see services/project-workflow.ts narrowBenchmarkCostToItotoriShape).
  "packages/localization-bridge-schema/",
  // Historical migrations are immutable (checksum-locked by the migration
  // runner). 0006 created the legacy 5-value enum; 0039 is the rip-out
  // that narrows it. Re-running the audit against 0006 would block any
  // commit because the legacy enum names appear in its CHECK constraint.
  "packages/itotori-db/migrations/0006_model_registry_cost_ledger.sql",
];

// Patterns: each pattern fires a violation if matched anywhere in a file
// outside the allow-list. `label` is human-readable for the error report.
const FORBIDDEN_PATTERNS = [
  {
    label: "deprecated costTier field/enum",
    regex: /\bcostTier\b/u,
  },
  {
    label: "deprecated ProviderCostTier type",
    regex: /\bProviderCostTier\b/u,
  },
  {
    label: 'costKind: "unknown" / "provider_estimate" / "local_estimate"',
    regex: /costKind\s*:\s*['"`](unknown|provider_estimate|local_estimate)['"`]/u,
  },
  {
    label: 'cost_kind = "unknown" / "provider_estimate" / "local_estimate" (SQL)',
    regex: /cost_kind\s*=\s*['"`](unknown|provider_estimate|local_estimate)['"`]/u,
  },
  {
    label: "deprecated unknownCost() helper",
    regex: /\bunknownCost\s*\(/u,
  },
  {
    label: "hardcoded model USD cost literal",
    // Catches `costUsd: 0.0123` and `cost_usd: 1.23` — the standing rule
    // forbids any compile-time cost number in source. Numeric `cost: 0`
    // / `costMicros: 0` are excluded because zero is the legitimate
    // ZERO_COST shape; the pattern requires the keyword `costUsd` or
    // `cost_usd` to fire.
    regex: /\bcost[_]?[Uu]sd\b\s*:\s*\d/u,
  },
];

function listTrackedFiles() {
  const out = execSync("git ls-files apps packages scripts fixtures", {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isAllowListed(path) {
  return ALLOW_LIST.some((prefix) => path === prefix || path.startsWith(prefix));
}

function shouldScan(path) {
  if (isAllowListed(path)) return false;
  // Source-code shapes only; binary or generated artifacts get skipped.
  return (
    path.endsWith(".ts") ||
    path.endsWith(".tsx") ||
    path.endsWith(".mts") ||
    path.endsWith(".cts") ||
    path.endsWith(".js") ||
    path.endsWith(".mjs") ||
    path.endsWith(".cjs") ||
    path.endsWith(".json") ||
    path.endsWith(".sql") ||
    path.endsWith(".rs")
  );
}

const violations = [];

for (const file of listTrackedFiles()) {
  if (!shouldScan(file)) continue;
  let contents;
  try {
    contents = readFileSync(join(repoRoot, file), "utf8");
  } catch {
    // Submodules or absent files (e.g. when the tree is partially checked
    // out) get silently skipped — they cannot host a violation.
    continue;
  }
  const lines = contents.split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    // Skip comment-only lines so that the audit's own forbidden-pattern
    // names + historical/JSDoc references do not trigger violations. We
    // only flag lines that look like real code/data: bare comment lines
    // beginning with `//`, `*`, `--`, or `#` are exempt.
    const trimmed = line.trim();
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("--") ||
      trimmed.startsWith("#")
    ) {
      continue;
    }
    // Per-line escape hatch: `// itotori-225-audit-allow: <reason>`
    // marks a line whose legacy-enum or hardcoded-cost reference is
    // load-bearing (e.g. a boundary test asserting the narrower rejects
    // the legacy value). Reasons must be supplied so a reviewer can
    // judge the exemption.
    if (/itotori-225-audit-allow:/u.test(line)) {
      continue;
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.regex.test(line)) {
        violations.push({
          file,
          line: lineIndex + 1,
          pattern: pattern.label,
          excerpt: trimmed.slice(0, 200),
        });
      }
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(
    `ITOTORI-225 audit failed: ${violations.length} forbidden cost pattern${violations.length === 1 ? "" : "s"} found.\n` +
      "The standing rule (Trevor, 2026-06-25): no hardcoded model costs, no fallback costs, no unknown costs.\n" +
      "See docs/audits/openrouter-cost-tracking-audit-2026-06-25.md §3 N1 for the rip-out spec.\n\n",
  );
  for (const v of violations) {
    process.stderr.write(`  ${v.file}:${v.line}  [${v.pattern}]\n    ${v.excerpt}\n`);
  }
  process.exit(1);
}

const scannedCount = listTrackedFiles().filter(shouldScan).length;
process.stdout.write(
  `ITOTORI-225 audit passed: ${scannedCount} source files scanned; no forbidden cost patterns found.\n`,
);
process.exit(0);
