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
// Run: `node scripts/audit-no-hardcoded-cost.mjs`            (scan repo)
//      `node scripts/audit-no-hardcoded-cost.mjs <file>...`  (scan files)
// Wired into `just check` via the orchestrator's CI invocation in the same
// change that introduces this file. The companion regression suite
// `scripts/audit-no-hardcoded-cost.test.mjs` exercises the patterns below.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// Allow-list: paths whose contents are exempt from the audit entirely.
// Recorded bundles store real captured spend amounts that we deliberately
// want to keep verbatim. The audit script itself prints the forbidden
// patterns as part of its error messages and so must self-exempt.
const ALLOW_LIST = [
  "apps/itotori/test/fixtures/recorded-bundles/",
  "scripts/audit-no-hardcoded-cost.mjs",
  "scripts/audit-no-hardcoded-cost.test.mjs",
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

// Cost-literal exemption: paths that legitimately synthesize provider
// cost responses / ledger rows to exercise the cost-tracking pipeline.
// A test that cannot construct a non-zero `amountMicrosUsd` or a bundle's
// `usage.cost` cannot verify the machinery that records real spend, so the
// hardcoded-cost-literal patterns (and ONLY those — see `costLiteral`
// below) are skipped here. The legacy-enum / cost-tier patterns still
// fire everywhere so a revived `unknown`/`provider_estimate` literal is
// caught even inside a test. A path is cost-literal-exempt when it lives
// under a `test/` tree or the top-level `fixtures/` tree.
//
// NB: no source-tree (`src/`) module is listed here. PROJECT LAW forbids a
// fabricated cost literal in scanned production source, even in a "test
// fixture". apps/itotori/src/draft/draft-attempt-fixtures.ts used to be
// exempted here while it carried invented billed amounts; it now carries
// only the canonical ZERO_COST sentinel, so it passes the audit with NO
// exemption. A fixture that needs a non-zero billed cost must source it
// from a captured recorded-bundle under the allow-listed
// apps/itotori/test/fixtures/recorded-bundles/ tree, never from a literal.
const COST_FIXTURE_FILES = [];

function isCostFixturePath(path) {
  if (COST_FIXTURE_FILES.includes(path)) return true;
  if (path === "fixtures" || path.startsWith("fixtures/")) return true;
  return /(?:^|\/)test\//u.test(path);
}

// Patterns: each pattern fires a violation if matched on a line outside the
// allow-list. `label` is human-readable for the error report. Patterns
// flagged `costLiteral: true` target hardcoded cost numbers and are skipped
// for cost-fixture paths (see `isCostFixturePath`); all other patterns fire
// everywhere a file is scanned.
//
// The cost-literal patterns deliberately match only NON-ZERO numbers:
// `amountMicrosUsd: 0` / `cost: 0` / `amount: "0.00000000"` are the
// canonical ZERO_COST shape (apps/itotori/src/providers/cost.ts) and appear
// throughout production failure paths, so zero must never be flagged. The
// key may be optionally quoted so JSON literals (`"amountMicrosUsd": 12`)
// are caught too. Numeric separators (`12_500`) are tolerated.
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
    // `costUsd: 0.0123` / `cost_usd: 1.23` — a bare numeric assigned to the
    // canonical decimal-USD cost key.
    label: "hardcoded costUsd/cost_usd numeric literal",
    regex: /\b["'`]?cost[_]?[Uu]sd["'`]?\s*:\s*\d/u,
    costLiteral: true,
  },
  {
    // `amountMicrosUsd: 12_500` — the primary integer-micros cost field
    // (ProviderCost.amountMicrosUsd). Non-zero only; `: 0` is ZERO_COST.
    label: "hardcoded non-zero amountMicrosUsd literal",
    regex: /\b["'`]?amountMicrosUsd["'`]?\s*:\s*(?=[\d_]*[1-9])[\d_]/u,
    costLiteral: true,
  },
  {
    // Bare `cost: 0.0125` — the upstream `usage.cost` shape mirrored into a
    // usageResponseJson literal. Non-zero only; `cost: { ... }` object
    // forms and `cost: 0` are not matched (no digit / a zero number).
    label: "hardcoded non-zero bare cost numeric literal",
    regex: /\b["'`]?cost["'`]?\s*:\s*(?=[\d_.]*[1-9])[\d_.]/u,
    costLiteral: true,
  },
  {
    // Object-form `costUsd: { unit: "usd", amount: "0.01250000" }` — the
    // decimal-string amount inside a costUsd money object. Non-zero only;
    // `amount: "0.00000000"` is the zero shape and is left alone. Scoped to
    // an `amount:` that sits inside a `costUsd: { ... }` object on the same
    // line so unrelated `amount:` fields never trip.
    label: "hardcoded non-zero costUsd object amount literal",
    regex: /\b["'`]?costUsd["'`]?\s*:\s*\{[^}]*\b["'`]?amount["'`]?\s*:\s*["'`](?=[\d.]*[1-9])/u,
    costLiteral: true,
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
  // Source-code / data shapes only; binary or generated artifacts get
  // skipped. NB: `.rs` is intentionally absent — every Rust crate lives
  // under `crates/` (outside this script's `git ls-files apps packages
  // scripts fixtures` scope) and the cost-tracking machinery is entirely
  // TypeScript. Adding `.rs` here would scan nothing, so it is dropped to
  // keep the extension list honest about what is actually inspected.
  return (
    path.endsWith(".ts") ||
    path.endsWith(".tsx") ||
    path.endsWith(".mts") ||
    path.endsWith(".cts") ||
    path.endsWith(".js") ||
    path.endsWith(".mjs") ||
    path.endsWith(".cjs") ||
    path.endsWith(".json") ||
    path.endsWith(".sql")
  );
}

// Return every forbidden-pattern violation in `contents`, tagged with the
// repo-relative `path` (used both for reporting and to decide whether the
// cost-literal patterns apply). Exported for the regression suite.
export function findViolations(path, contents) {
  const found = [];
  const costFixture = isCostFixturePath(path);
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
      if (pattern.costLiteral && costFixture) continue;
      if (pattern.regex.test(line)) {
        found.push({
          file: path,
          line: lineIndex + 1,
          pattern: pattern.label,
          excerpt: trimmed.slice(0, 200),
        });
      }
    }
  }
  return found;
}

// Resolve the set of repo-relative paths to scan. With no CLI args we scan
// the tracked source tree; with args we scan exactly those files (used by
// the regression suite / ad-hoc checks against a crafted fixture).
function resolveScanTargets(args) {
  if (args.length === 0) {
    return listTrackedFiles().map((file) => ({ relPath: file, absPath: join(repoRoot, file) }));
  }
  return args.map((arg) => {
    const absPath = resolve(arg);
    const relPath = relative(repoRoot, absPath);
    // Paths outside the repo keep their absolute form so extension/fixture
    // checks still apply sensibly.
    return { relPath: relPath.startsWith("..") ? absPath : relPath, absPath };
  });
}

function runAudit(args) {
  const targets = resolveScanTargets(args);
  const violations = [];
  let scannedCount = 0;
  for (const { relPath, absPath } of targets) {
    if (!shouldScan(relPath)) continue;
    let contents;
    try {
      contents = readFileSync(absPath, "utf8");
    } catch {
      // Submodules or absent files (e.g. when the tree is partially checked
      // out) get silently skipped — they cannot host a violation.
      continue;
    }
    scannedCount += 1;
    violations.push(...findViolations(relPath, contents));
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
    return 1;
  }

  process.stdout.write(
    `ITOTORI-225 audit passed: ${scannedCount} source files scanned; no forbidden cost patterns found.\n`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(runAudit(process.argv.slice(2)));
}
