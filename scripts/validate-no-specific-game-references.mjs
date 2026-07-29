#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMatchers as buildMatchersInternal,
  renderReport,
  scanFiles as scanFilesInternal,
  stripComments,
} from "./validate-no-specific-game-references-scanner.mjs";

export { renderReport, stripComments };
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
// Enforceable generalization-purge gate. The configured terms represent
// concrete title names/slugs, vendor slugs, and title-derived environment
// variables that MUST NOT appear as active code on generalized product or
// operator surfaces (where a specific title is a real generalization bug).
export const defaultForbiddenTokens = [
  {
    id: "concrete-title-token",
    label: "concrete title token",
    tokens: [
      ["swe", "etie"].join(""),
      ["kare", "toshi"].join(""),
      ["game", "koi"].join(""),
      ["オシ", "オキ"].join(""),
    ],
  },
  {
    id: "concrete-vendor-token",
    label: "concrete vendor token",
    tokens: [["suka", "ra"].join("")],
  },
  {
    id: "title-derived-env",
    label: "title-derived env var",
    caseSensitive: true,
    tokens: [["KAIFUU_REAL_", "SWE", "ETIE", "_HD_PATH"].join("")],
  },
];
// Classified allowlist.
//
// These are the ONLY surfaces whose PURPOSE is to hold real-game references:
// test corpora catalogues, real-bytes harnesses, fixtures, diagnostic
// examples, the RealLive decode/render research substrate ("own the bytes /
// memory of real games"), planning/audit records, and the real-bytes CI /
// operator harness that names the primary corpus by design. A specific-title
// reference is EXPECTED (historical/research) on these surfaces.
//
// Everything NOT matched here is an ACTIVE product/operator surface: a title
// token appearing there in active code (i.e. not inside a comment) is a real
// generalization leak and FAILS the enforceable gate.
//
// `kind`:
//   "prefix"   path starts with `value`
//   "segment"  a "/"-delimited path segment equals `value`
//   "suffix"   path ends with `value`
//   "exact"    path equals `value`
export const historicalResearchSurfaces = [
  // Planning / audit / research records and documentation.
  { id: "roadmap", kind: "prefix", value: "roadmap/", reason: "roadmap/planning records" },
  { id: "plan", kind: "prefix", value: ".plan/", reason: "worker planning records" },
  { id: "docs", kind: "prefix", value: "docs/", reason: "research & audit documentation" },
  // Real-bytes test corpora and harnesses.
  {
    id: "tests-dir",
    kind: "segment",
    value: "tests",
    reason: "real-bytes test corpora & harnesses",
  },
  { id: "test-dir", kind: "segment", value: "test", reason: "test directories" },
  { id: "ts-test", kind: "suffix", value: ".test.ts", reason: "colocated TypeScript tests" },
  { id: "mjs-test", kind: "suffix", value: ".test.mjs", reason: "colocated ESM tests" },
  { id: "js-test", kind: "suffix", value: ".test.js", reason: "colocated JS tests" },
  { id: "rs-test", kind: "suffix", value: "_test.rs", reason: "colocated Rust tests" },
  // Fixtures (synthetic + real-corpus catalogues).
  { id: "fixtures-dir", kind: "segment", value: "fixtures", reason: "fixture/corpus catalogues" },
  { id: "ts-fixtures", kind: "suffix", value: "fixtures.ts", reason: "TypeScript fixture modules" },
  { id: "rs-fixtures", kind: "suffix", value: "fixtures.rs", reason: "Rust fixture modules" },
  {
    id: "fixture-crate",
    kind: "prefix",
    value: "crates/kaifuu-engine-fixture/",
    reason: "engine-fixture crate",
  },
  // Alpha-target / pilot config data records. Presets encode the alpha target
  // (primary_corpus HD) preserved AS DATA — a named target record + its pinned
  // pair-policy — not generalized runtime defaults.
  {
    id: "presets",
    kind: "prefix",
    value: "presets/",
    reason: "alpha-target/pilot config data records",
  },
  // Diagnostic / example binaries.
  { id: "examples-dir", kind: "segment", value: "examples", reason: "example/diagnostic binaries" },
  // RealLive decode/render research substrate. These crates own the real bytes
  // and encode real-corpus observations (compiler versions, opcode aliases,
  // scene layouts) as their reason for existing; they reference the real
  // corpora by design ("memory of real games").
  {
    id: "kaifuu-reallive",
    kind: "prefix",
    value: "crates/kaifuu-reallive/",
    reason: "RealLive decode research substrate",
  },
  {
    id: "utsushi-reallive",
    kind: "prefix",
    value: "crates/utsushi-reallive/",
    reason: "RealLive render research substrate",
  },
  {
    id: "kaifuu-cli",
    kind: "prefix",
    value: "crates/kaifuu-cli/",
    reason: "RealLive decode CLI substrate",
  },
  {
    id: "utsushi-cli",
    kind: "prefix",
    value: "crates/utsushi-cli/",
    reason: "RealLive render CLI substrate",
  },
  {
    id: "utsushi-core",
    kind: "prefix",
    value: "crates/utsushi-core/",
    reason: "runtime substrate ground-truth scope",
  },
  {
    id: "kaifuu-vault-source",
    kind: "prefix",
    value: "crates/kaifuu-vault-source/",
    reason: "vault-source substrate keyed by real canonical ids",
  },
  // Real-bytes CI / operator harness recipes that name the primary corpus by
  // design (the alpha target preserved as data), consistent with each other.
  {
    id: "real-bytes-oracle",
    kind: "exact",
    value: ".github/workflows/real-bytes-oracle.yml",
    reason: "real-bytes CI oracle corpora config",
  },
  {
    id: "justfile",
    kind: "exact",
    value: "justfile",
    reason: "operator real-bytes/localize harness recipes name the primary corpus by design",
  },
  // Archived one-off DAG migration / node / evidence scripts. These embed
  // historical node specifications, corpus catalogues, and per-node audit
  // trails as string payloads (research/planning records), not generalized
  // operator logic. They have been retired to scripts/history/ so no
  // game-hardcoded source remains in the active top-level scripts/ tree.
  {
    id: "scripts-history",
    kind: "prefix",
    value: "scripts/history/",
    reason: "archived historical one-off migration/audit/evidence scripts",
  },
  {
    id: "synthetic-coverage-manifest",
    kind: "exact",
    value: "scripts/synthetic-coverage-manifest.mjs",
    reason: "synthetic corpus coverage catalogue derivation",
  },
  // This scanner and its test document the guardrail and must name the terms.
  {
    id: "scanner",
    kind: "exact",
    value: "scripts/validate-no-specific-game-references.mjs",
    reason: "scanner self-reference",
  },
  {
    id: "scanner-test",
    kind: "exact",
    value: "scripts/validate-no-specific-game-references.test.mjs",
    reason: "scanner test self-reference",
  },
  // Must name banned terms; irreducible guard surface, not a product/operator reference.
  {
    id: "game-name-guard",
    kind: "exact",
    value: "scripts/audit-no-game-names.mjs",
    reason: "absolute game-name guard pattern table",
  },
];
export function parseArgs(argv) {
  const options = {
    mode: "check",
    root: repoRoot,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      index += 1;
      options.mode = argv[index];
    } else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
    } else if (arg === "--root") {
      index += 1;
      options.root = resolve(argv[index]);
    } else if (arg.startsWith("--root=")) {
      options.root = resolve(arg.slice("--root=".length));
    } else if (arg === "--token") {
      index += 1;
      options.tokens = [...(options.tokens ?? []), argv[index]];
    } else if (arg.startsWith("--token=")) {
      options.tokens = [...(options.tokens ?? []), arg.slice("--token=".length)];
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!["report", "check"].includes(options.mode)) {
    throw new Error(`--mode must be report or check, got: ${options.mode}`);
  }

  return options;
}

export function listTrackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || "git ls-files failed").trim());
  }

  return result.stdout.split("\0").filter(Boolean);
}

export function isEnvPath(path) {
  return path.split("/").some((part) => part === ".env" || part.startsWith(".env."));
}

// Returns the matching historical/research surface entry, or null when the
// path is an ACTIVE product/operator surface.
export function classifySurface(path, surfaces = historicalResearchSurfaces) {
  for (const entry of surfaces) {
    if (entry.kind === "prefix" && path.startsWith(entry.value)) {
      return entry;
    }
    if (entry.kind === "exact" && path === entry.value) {
      return entry;
    }
    if (entry.kind === "suffix" && path.endsWith(entry.value)) {
      return entry;
    }
    if (entry.kind === "segment" && path.split("/").includes(entry.value)) {
      return entry;
    }
  }
  return null;
}

export function buildMatchers(groups = defaultForbiddenTokens) {
  return buildMatchersInternal(groups);
}

export function scanFiles({
  root,
  files,
  readFile,
  surfaces = historicalResearchSurfaces,
  forbiddenTokens = defaultForbiddenTokens,
}) {
  return scanFilesInternal({
    root,
    files,
    readFile,
    surfaces,
    forbiddenTokens,
    isEnvPath,
    classifySurface,
  });
}

function printHelp() {
  process.stdout
    .write(`usage: node scripts/validate-no-specific-game-references.mjs [--mode check|report] [--root PATH] [--token TOKEN...]

Enforceable generalization-purge gate. Title/vendor references are classified
against historicalResearchSurfaces (allowed) vs active product/operator
surfaces (forbidden). Comments on active surfaces are historical "memory of
real games" and are allowed.

Modes:
  check   Print active-surface leaks and exit 1 when any exist. Default.
  report  Print active-surface leaks and exit 0 (advisory audit).

Options:
  --token TOKEN  Override the default configured token set. Repeatable; intended for tests.
`);
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exit(0);
    }

    const result = scanFiles({
      root: options.root,
      files: listTrackedFiles(options.root),
      forbiddenTokens:
        options.tokens === undefined
          ? defaultForbiddenTokens
          : [{ id: "cli-token", label: "configured token", tokens: options.tokens }],
    });
    process.stdout.write(renderReport(result, { mode: options.mode }));
    process.exit(options.mode === "check" && result.active.length > 0 ? 1 : 0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
