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

// NO blanket cost-literal exemption for `test/` / `fixtures/` trees.
//
// Earlier revisions of this guard skipped the hardcoded-cost-literal
// patterns for ANY path under a `test/` tree or the top-level `fixtures/`
// tree. That blanket exemption directly contradicted the guard's own
// standing rule ("no hardcoded model cost anywhere ... ever"): fabricated
// billed-cost literals could live undetected across the entire test corpus.
// It is removed.
//
// A test or fixture that genuinely needs a non-zero billed cost has these
// auditable options:
//   (a) SOURCE it from a captured recorded-bundle under the allow-listed
//       apps/itotori/test/fixtures/recorded-bundles/ tree (real spend,
//       preserved verbatim — see ALLOW_LIST above), OR
//   (b) carry an EXPLICIT per-line `// itotori-225-audit-allow: <reason>`
//       marker on the offending line — a documented, reviewer-auditable
//       per-line opt-out (NOT a blanket tree exemption). The reason string
//       is mandatory so a reviewer can judge each exemption individually.
//   (c) for a JSON fixture ONLY — JSON has no line-comment syntax, so a
//       per-line marker is physically impossible — an EXPLICIT per-file
//       entry in COST_LITERAL_ALLOW below (path -> reason). This exempts
//       that one file from the cost-literal patterns ONLY; the legacy-enum
//       / token-fabrication patterns still fire on it. It is an enumerated,
//       individually-justified file list, NOT a blanket `test/`/`fixtures/`
//       tree exemption: a NEW un-listed JSON fixture with a cost literal
//       still fails the guard.
//
// PROJECT LAW is unchanged: a fabricated cost literal in scanned production
// source (`src/`) is never permitted, and there is no path-level cost-literal
// allowance for any `src/` module. The cost-literal patterns fire in EVERY
// scanned file except the enumerated JSON fixtures in (c); a new un-annotated
// cost literal in a `.ts`/`.tsx`/`.js` test tree fails the guard exactly as
// it would in production source.

// COST_LITERAL_ALLOW — explicit, enumerated JSON fixtures permitted to carry
// synthetic non-zero cost literals. These are deterministic PUBLIC fixtures
// (no live credentials, no real captured spend) that replay through the
// recorded-cost / benchmark / experiment paths and therefore must embed a
// non-zero `amountMicrosUsd` / `cost` to exercise the ledger. Because JSON
// cannot host a `// itotori-225-audit-allow:` marker, each such file is
// listed here with its reason. Cost-literal patterns are skipped for these
// exact paths; every other pattern (revived `unknown` costKind, token
// fabrication, cost-tier) still fires. A `.ts`/`.tsx` fixture is NEVER
// eligible here — it can and must carry per-line markers instead.
const COST_LITERAL_ALLOW = new Map([
  [
    "fixtures/benchmark-stages/public-fixture.json",
    "deterministic public benchmark-stages fixture; synthetic recorded-run costs exercise the raw-MTL-vs-draft report",
  ],
  [
    "fixtures/itotori-experiment-report/experiment-matrix-run-manifest.json",
    "deterministic experiment-matrix run manifest fixture; synthetic per-cell costs exercise the experiment-report roll-up",
  ],
  [
    "fixtures/itotori-style-guide/provider-smoke-suggestion.json",
    "deterministic style-guide provider-smoke fixture; synthetic provider-result cost exercises the smoke-suggestion path",
  ],
  [
    "fixtures/provider-proof/recorded-fallback-proof-input.json",
    "deterministic provider-proof replay input (fallback); synthetic per-attempt costs exercise the recorded-fallback proof",
  ],
  [
    "fixtures/provider-proof/recorded-proof-input.json",
    "deterministic provider-proof replay input; synthetic per-attempt costs exercise the recorded-provider proof",
  ],
  [
    "fixtures/provider-proof/recorded-raw-mtl-baseline-input.json",
    "deterministic raw-MTL-baseline replay input; synthetic per-attempt costs exercise the raw-MTL baseline proof",
  ],
]);

// Patterns: each pattern fires a violation if matched on a line outside the
// allow-list, unless the line carries the per-line audit-allow marker.
// `label` is human-readable for the error report. Every pattern fires in
// every scanned file; there is no per-tree exemption.
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
    // general-audit-1 (genaudit1-00): token-count fabrication. The
    // unambiguous signature is a `?? estimateTokens(...)` fallback on a real
    // token field — the char/4 heuristic substituted when a provider omits
    // usage, which then landed in the ledger indistinguishable from a
    // provider-reported count. PROJECT LAW: token counts come ONLY from real
    // provider output (mirror of the no-hardcoded-cost rule). The legitimate
    // pre-flight uses (`estimateTokens(...)` in batch-planner, and the
    // explicitly-named `inputTokenEstimate = estimateTokens(...)`) do NOT use
    // the `?? estimateTokens(` fallback form, so they are untouched. Like
    // every pattern here it fires in every scanned file, tests included.
    label: "token-count fabrication: `?? estimateTokens(...)` fallback in a recording path",
    regex: /\?\?\s*estimateTokens\s*\(/u,
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
  // Enumerated JSON fixtures (option (c)) skip the cost-literal patterns
  // ONLY. Every other pattern still fires on them. `.ts`/`.tsx`/`.js` paths
  // are never eligible — they use per-line markers.
  const costLiteralAllowed = COST_LITERAL_ALLOW.has(path);
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
    // Per-line escape hatch: `// itotori-225-audit-allow: <reason>` marks a
    // single line whose legacy-enum or hardcoded-cost reference is
    // load-bearing (e.g. a boundary test asserting the narrower rejects the
    // legacy value, or a synthetic fixture that must carry a non-zero billed
    // amount to exercise the ledger). This is the ONLY per-line opt-out; a
    // non-empty reason must follow the marker so a reviewer can judge each
    // exemption individually. There is no blanket per-tree exemption.
    if (/itotori-225-audit-allow:\s*\S/u.test(line)) {
      continue;
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.costLiteral && costLiteralAllowed) continue;
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
