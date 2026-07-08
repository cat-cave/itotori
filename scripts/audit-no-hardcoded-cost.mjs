#!/usr/bin/env node
// ITOTORI-225 — CI guard: fail on any hardcoded model cost, deprecated
// cost-tier abstraction, or revived `unknown` / `local_estimate` enum
// literal in the itotori codebase.
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
// ITOTORI-134 — `provider_estimate` is RE-INTRODUCED as a legitimate,
// narrowly-scoped deterministic cost-estimate state (derived from
// cost_details or endpoint-pricing × tokens) and is therefore REMOVED from
// the forbidden legacy-enum list. Only `unknown` and `local_estimate`
// remain forbidden — the guess-based / fabricated-cost states the standing
// rule forbids. A production `costKind: "provider_estimate"` literal is now
// allowed (it is a real cost state, not a hardcoded cost AMOUNT); the
// cost-literal patterns still guard every hardcoded numeric amount.
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
  // Bridge-schema benchmark-report fixtures. These carry a synthetic estimated
  // `amountMicrosUsd` under an external-system `costKind: "provider_estimate"`
  // row: the benchmark subsystem compares third-party systems whose per-call
  // cost is genuinely unknowable, so the amount is an ESTIMATE. These are
  // enumerated per-file because JSON cannot host a per-line marker; a NEW
  // un-listed schema fixture with a cost literal still fails the guard.
  // (ITOTORI-134: `provider_estimate` is now a generally-allowed costKind for
  // itotori's own OpenRouter spend too, but the synthetic AMOUNT here still
  // needs this per-file cost-literal exemption.)
  [
    "packages/localization-bridge-schema/test/examples/benchmark-report-v0.2.json",
    "external-system benchmark cost, genuinely unknowable per audit-3; synthetic provider_estimate amount exercises the benchmark cost ledger",
  ],
  [
    "packages/localization-bridge-schema/test/examples/benchmark-report-v0.2-multi-system-qa.json",
    "external-system benchmark cost, genuinely unknowable per audit-3; synthetic provider_estimate amount exercises the multi-system benchmark cost ledger",
  ],
  [
    "packages/localization-bridge-schema/test/examples/invalid/benchmark-report-v0.2-mismatched-finding-coverage.json",
    "external-system benchmark cost, genuinely unknowable per audit-3; synthetic provider_estimate amount in an intentionally-invalid finding-coverage fixture",
  ],
  [
    "packages/localization-bridge-schema/test/examples/invalid/benchmark-report-v0.2-global-provider-coverage.json",
    "external-system benchmark cost, genuinely unknowable per audit-3; synthetic provider_estimate amount in an intentionally-invalid provider-coverage fixture",
  ],
]);

// LEGACY_ENUM_ALLOW — enumerated JSON fixtures permitted to carry the
// `costKind: "local_estimate" | "unknown"` legacy-enum literal. Unlike
// itotori's own OpenRouter spend (`provider_estimate` is re-introduced as a
// legitimate deterministic estimate state by ITOTORI-134; `billed` /
// `provider_estimate` / `zero` are all allowed everywhere), the cross-app
// BENCHMARK cost schema (BenchmarkCostAmountV02) compares EXTERNAL third-party
// systems. The `local_estimate` / `unknown` kinds are kept there for
// genuinely-unknowable external benchmark costs (audit-3); forcing `billed`
// would fabricate a cost, violating this very guard. Because JSON cannot host
// a `// itotori-225-audit-allow:` marker, each such benchmark fixture is
// enumerated here with its reason. The legacy-enum pattern is skipped ONLY for
// these exact paths; every other pattern still fires, and a NEW un-listed
// schema fixture with a revived legacy enum still fails. A `.ts`/`.tsx` file
// is NEVER eligible here — it carries a per-line marker.
//
// NB: the currently-enumerated benchmark fixtures use `costKind:
// "provider_estimate"` (now generally allowed by ITOTORI-134), so this map is
// retained for completeness / future `local_estimate`/`unknown` benchmark
// fixtures but is not currently load-bearing for the four listed files.
const LEGACY_ENUM_ALLOW = new Map([
  [
    "packages/localization-bridge-schema/test/examples/benchmark-report-v0.2.json",
    "external-system benchmark cost, genuinely unknowable per audit-3",
  ],
  [
    "packages/localization-bridge-schema/test/examples/benchmark-report-v0.2-multi-system-qa.json",
    "external-system benchmark cost, genuinely unknowable per audit-3",
  ],
  [
    "packages/localization-bridge-schema/test/examples/invalid/benchmark-report-v0.2-mismatched-finding-coverage.json",
    "external-system benchmark cost, genuinely unknowable per audit-3",
  ],
  [
    "packages/localization-bridge-schema/test/examples/invalid/benchmark-report-v0.2-global-provider-coverage.json",
    "external-system benchmark cost, genuinely unknowable per audit-3",
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
    label: 'costKind: "unknown" / "local_estimate"',
    // Optional quotes around the key so the JSON form (`"costKind": "unknown"`)
    // is caught alongside the TS object-literal form (`costKind: "unknown"`).
    // ITOTORI-134 — `provider_estimate` is REMOVED from this forbidden list: it
    // is re-introduced as a legitimate deterministic cost-estimate state
    // (derived from cost_details / endpoint pricing). Only the guess-based
    // `unknown` and `local_estimate` states remain forbidden. `legacyEnum`
    // gates the per-file LEGACY_ENUM_ALLOW opt-out (the enumerated
    // external-system benchmark fixtures); the pattern still fires everywhere
    // else, including any new un-listed schema JSON fixture.
    regex: /["'`]?costKind["'`]?\s*:\s*['"`](unknown|local_estimate)['"`]/u,
    legacyEnum: true,
  },
  {
    label: 'cost_kind = "unknown" / "local_estimate" (SQL)',
    regex: /cost_kind\s*=\s*['"`](unknown|local_estimate)['"`]/u,
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
    // `keyValueForm: true` diverts this pattern into the multi-line-aware
    // keyed-value scanner below so `amountMicrosUsd:\n  12_500` cannot escape
    // the guard when a formatter or fixture splits the property value.
    label: "hardcoded non-zero amountMicrosUsd literal",
    regex: /\b["'`]?amountMicrosUsd["'`]?\s*:\s*(?=[\d_]*[1-9])[\d_]/u,
    costLiteral: true,
    keyValueForm: true,
    keyOpenRegex: /\b["'`]?amountMicrosUsd["'`]?\s*:/u,
  },
  {
    // `amountUsd: "0.00000602"` / `amountUsd: 0.00157` — the AUTHORITATIVE
    // full-precision decimal-USD ledger cost (ProviderCost.amountUsd). This is
    // the field `assertBilledCostDecimal` returns VERBATIM and that migration
    // 0041 persists as `cost_amount` under the 1e-9 CHECK basis — the value the
    // codebase made the authoritative billed cost. A hardcoded amountUsd is
    // therefore exactly as forbidden as a hardcoded amountMicrosUsd, and this
    // pattern mirrors that rule. The value may be a quoted decimal STRING (the
    // canonical shape) or a bare NUMERIC literal, so an optional value-quote is
    // consumed before the non-zero lookahead. Non-zero only: `: "0"` /
    // `: "0.00000000"` / `: 0` is the ZERO_COST shape and is left alone (same
    // zero-lookahead posture as amountMicrosUsd). Key may be optionally quoted
    // so the JSON form (`"amountUsd": "0.0125"`) is caught too. `amountUsd`
    // used as a variable / shorthand / type / expression (no numeric literal
    // after the colon) never matches; `costAmountUsd` (capital A) is not this
    // field and is not matched.
    label: "hardcoded non-zero amountUsd literal",
    regex: /\b["'`]?amountUsd["'`]?\s*:\s*["'`]?(?=[\d._]*[1-9])[\d._]/u,
    costLiteral: true,
  },
  {
    // Bare `cost: 0.0125` — the upstream `usage.cost` shape mirrored into a
    // usageResponseJson literal. Non-zero only; `cost: { ... }` object
    // forms and `cost: 0` are not matched (no digit / a zero number).
    // Routed through the keyed-value scanner so `cost:\n  0.0125` is covered
    // alongside the single-line shape.
    label: "hardcoded non-zero bare cost numeric literal",
    regex: /\b["'`]?cost["'`]?\s*:\s*(?=[\d_.]*[1-9])[\d_.]/u,
    costLiteral: true,
    keyValueForm: true,
    keyOpenRegex: /\b["'`]?cost["'`]?\s*:/u,
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
    // an `amount:` that sits inside a `costUsd: { ... }` object.
    //
    // `objectForm: true` diverts this pattern OUT of the per-line loop into
    // the dedicated block scanner below (`findCostUsdObjectViolations`): the
    // costUsd `{ ... }` object is joined across newlines FIRST, then this
    // regex is applied to the joined block. That catches the prettier-split
    // shape
    //     costUsd: {
    //       unit: "usd",
    //       amount: "0.0125",
    //     }
    // which the per-line pass missed (its `amount:` line carried no costUsd
    // token), while staying scoped to a costUsd object so unrelated `amount:`
    // fields (token counts, versions, UI dimensions) never trip.
    label: "hardcoded non-zero costUsd object amount literal",
    regex: /\b["'`]?costUsd["'`]?\s*:\s*\{[^}]*\b["'`]?amount["'`]?\s*:\s*["'`](?=[\d.]*[1-9])/u,
    costLiteral: true,
    objectForm: true,
  },
];

// The per-line comment prefixes that mark a line as commentary rather than
// real code/data. Shared by the per-line pass and the block scanners.
function isCommentLine(trimmed) {
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("--") ||
    trimmed.startsWith("#")
  );
}

// The per-line audit-allow escape hatch: `// itotori-225-audit-allow: <reason>`
// with a non-empty reason. Shared by all passes.
function hasAuditAllowMarker(line) {
  return /itotori-225-audit-allow:\s*\S/u.test(line);
}

// Multi-line-aware scan for keyed numeric cost literals.
//
// The per-line loop cannot see a formatter-split property like:
//     amountMicrosUsd:
//       12_500,
// or:
//     cost:
//       0.0125,
// because the key and numeric literal live on different physical lines. For
// these value forms we locate the key opener, join a small continuation window
// into one logical line, then apply the same regex the per-line pass used.
// This subsumes the single-line case, so keyed-value patterns are removed from
// the per-line loop via `keyValueForm` to avoid double-reporting. Reported
// against the line the key opens on.
function findKeyedValueViolations(path, lines, pattern, costLiteralAllowed) {
  if (costLiteralAllowed) return [];
  const found = [];
  const openRe = pattern.keyOpenRegex;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (isCommentLine(trimmed)) continue;
    const opener = openRe.exec(lines[i]);
    if (!opener) continue;

    let markerSeen = false;
    let joined = "";
    for (let j = i; j < lines.length && j <= i + 4; j += 1) {
      if (hasAuditAllowMarker(lines[j])) markerSeen = true;
      const seg = j === i ? lines[j].slice(opener.index) : lines[j];
      if (j > i && isCommentLine(seg.trim())) continue;
      joined += ` ${seg}`;
      if (j > i && /\S/u.test(seg)) break;
    }

    if (markerSeen) continue;
    if (pattern.regex.test(joined)) {
      found.push({
        file: path,
        line: i + 1,
        pattern: pattern.label,
        excerpt: trimmed.slice(0, 200),
      });
    }
  }
  return found;
}

// Multi-line-aware scan for object-form `costUsd` cost literals.
//
// Prettier can split a large `costUsd: { unit: "usd", amount: "0.0125" }`
// object across several lines, in which case the `amount:` line stands alone
// with no `cost` token and the per-line pass matches NOTHING. Here we locate
// each `costUsd: {` opener, walk forward accumulating lines until the object's
// braces balance, JOIN the block into one logical line, and apply the same
// costUsd-object regex. Because we anchor on `costUsd: {` and only join up to
// its matching `}`, an unrelated `amount:` outside a costUsd object is never
// considered — no false positives on token counts / versions / UI dimensions.
//
// This subsumes the single-line case too (the object simply balances on its
// opening line), so the pattern is removed from the per-line loop via its
// `objectForm` flag to avoid double-reporting. Reported against the line the
// object opens on.
function findCostUsdObjectViolations(path, lines, pattern, costLiteralAllowed) {
  if (costLiteralAllowed) return [];
  const found = [];
  const openRe = /["'`]?costUsd["'`]?\s*:\s*\{/u;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (isCommentLine(trimmed)) continue;
    const opener = openRe.exec(lines[i]);
    if (!opener) continue;
    // Walk forward from the matched `{`, balancing braces, until the object
    // closes; join the block (newlines flattened to spaces) for matching.
    let depth = 0;
    let started = false;
    let markerSeen = false;
    let joined = "";
    for (let j = i; j < lines.length; j += 1) {
      if (hasAuditAllowMarker(lines[j])) markerSeen = true;
      const seg = j === i ? lines[j].slice(opener.index) : lines[j];
      joined += ` ${seg}`;
      for (const ch of seg) {
        if (ch === "{") {
          depth += 1;
          started = true;
        } else if (ch === "}") {
          depth -= 1;
        }
      }
      if (started && depth <= 0) break;
    }
    // A per-line audit-allow marker anywhere in the object block opts it out,
    // matching the per-line pass's single-line behaviour.
    if (markerSeen) continue;
    if (pattern.regex.test(joined)) {
      found.push({
        file: path,
        line: i + 1,
        pattern: pattern.label,
        excerpt: trimmed.slice(0, 200),
      });
    }
  }
  return found;
}

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
  // Enumerated JSON benchmark fixtures skip the legacy-enum `costKind` pattern
  // ONLY (external-system benchmark cost, genuinely unknowable per audit-3).
  // Every other pattern still fires on them.
  const legacyEnumAllowed = LEGACY_ENUM_ALLOW.has(path);
  const lines = contents.split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    // Skip comment-only lines so that the audit's own forbidden-pattern
    // names + historical/JSDoc references do not trigger violations. We
    // only flag lines that look like real code/data: bare comment lines
    // beginning with `//`, `*`, `--`, or `#` are exempt.
    const trimmed = line.trim();
    if (isCommentLine(trimmed)) {
      continue;
    }
    // Per-line escape hatch: `// itotori-225-audit-allow: <reason>` marks a
    // single line whose legacy-enum or hardcoded-cost reference is
    // load-bearing (e.g. a boundary test asserting the narrower rejects the
    // legacy value, or a synthetic fixture that must carry a non-zero billed
    // amount to exercise the ledger). This is the ONLY per-line opt-out; a
    // non-empty reason must follow the marker so a reviewer can judge each
    // exemption individually. There is no blanket per-tree exemption.
    if (hasAuditAllowMarker(line)) {
      continue;
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
      // Multi-line-aware forms are handled by block scanners below, not the
      // per-line pass (see `objectForm` / `keyValueForm` on the patterns).
      if (pattern.objectForm) continue;
      if (pattern.keyValueForm) continue;
      if (pattern.costLiteral && costLiteralAllowed) continue;
      if (pattern.legacyEnum && legacyEnumAllowed) continue;
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
  // Multi-line-aware keyed-value scan (subsumes the single-line case).
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (!pattern.keyValueForm) continue;
    found.push(...findKeyedValueViolations(path, lines, pattern, costLiteralAllowed));
  }
  // Multi-line-aware object-form costUsd scan (subsumes the single-line case).
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (!pattern.objectForm) continue;
    found.push(...findCostUsdObjectViolations(path, lines, pattern, costLiteralAllowed));
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
