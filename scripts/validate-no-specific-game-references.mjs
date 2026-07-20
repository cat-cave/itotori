#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    tokens: [["swe", "etie"].join(""), "oshioki", "オシオキ"],
  },
  {
    id: "concrete-vendor-token",
    label: "concrete vendor token",
    tokens: ["sukara"],
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
  // (Sweetie HD) preserved AS DATA — a named target record + its pinned
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

const SLASH_COMMENT_EXTENSIONS = new Set(["rs", "ts", "tsx", "js", "mjs", "cjs", "jsonc"]);

function supportsSlashComments(path) {
  const dot = path.lastIndexOf(".");
  if (dot === -1) {
    return false;
  }
  return SLASH_COMMENT_EXTENSIONS.has(path.slice(dot + 1));
}

// Blanks the comment portions of a line (preserving column positions) so a
// token match can be classified as code vs comment. Carries block-comment
// state across lines. Comments are historical/research "memory of real games"
// documentation and are allowed on any surface.
export function stripComments(line, inBlock) {
  const out = line.split("");
  const length = line.length;
  let index = 0;
  let stringDelimiter = null;
  let block = inBlock;

  while (index < length) {
    const char = line[index];
    const next = line[index + 1];

    if (block) {
      if (char === "*" && next === "/") {
        out[index] = " ";
        out[index + 1] = " ";
        block = false;
        index += 2;
        continue;
      }
      out[index] = " ";
      index += 1;
      continue;
    }

    if (stringDelimiter) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === stringDelimiter) {
        stringDelimiter = null;
      }
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      stringDelimiter = char;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      for (let blank = index; blank < length; blank += 1) {
        out[blank] = " ";
      }
      break;
    }

    if (char === "/" && next === "*") {
      out[index] = " ";
      out[index + 1] = " ";
      block = true;
      index += 2;
      continue;
    }

    index += 1;
  }

  return { code: out.join(""), inBlockNext: block };
}

export function buildMatchers(groups = defaultForbiddenTokens) {
  return groups.flatMap((group) =>
    group.tokens.map((token) => ({
      groupId: group.id,
      label: group.label,
      token,
      pattern: new RegExp(escapeRegExp(token), group.caseSensitive ? "gu" : "giu"),
    })),
  );
}

export function scanFiles({
  root,
  files,
  readFile = (path) => readFileSync(resolve(root, path), "utf8"),
  surfaces = historicalResearchSurfaces,
  forbiddenTokens = defaultForbiddenTokens,
}) {
  const matchers = buildMatchers(forbiddenTokens);
  const active = [];
  const historical = [];
  let scannedFileCount = 0;
  let skippedEnvFileCount = 0;
  let historicalSurfaceFileCount = 0;

  for (const file of files) {
    if (isEnvPath(file)) {
      skippedEnvFileCount += 1;
      continue;
    }

    const surface = classifySurface(file, surfaces);
    if (surface) {
      historicalSurfaceFileCount += 1;
    }
    const record = (violation) => {
      if (surface) {
        historical.push({
          ...violation,
          classification: "historical-surface",
          reason: surface.reason,
        });
      } else if (violation.comment) {
        historical.push({
          ...violation,
          classification: "historical-comment",
          reason: "in-source comment",
        });
      } else {
        active.push({ ...violation, classification: "active-surface" });
      }
    };

    for (const match of matchesForText(file, matchers)) {
      record({
        path: file,
        location: "filename",
        line: null,
        label: match.label,
        token: match.token,
        excerpt: file,
        comment: false,
      });
    }

    let contents;
    try {
      contents = readFile(file);
    } catch {
      continue;
    }

    scannedFileCount += 1;
    const slashComments = supportsSlashComments(file);
    const lines = contents.split(/\r?\n/u);
    let inBlock = false;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      let codeLine = line;
      if (slashComments) {
        const stripped = stripComments(line, inBlock);
        codeLine = stripped.code;
        inBlock = stripped.inBlockNext;
      }
      for (const match of matchesForText(line, matchers)) {
        // A match is a comment when the same span in the comment-stripped line
        // no longer contains the token (only classifiable when we can strip).
        const isComment =
          slashComments &&
          codeLine.slice(match.start, match.end).trim() !==
            line.slice(match.start, match.end).trim();
        record({
          path: file,
          location: "content",
          line: lineIndex + 1,
          label: match.label,
          token: match.token,
          excerpt: line.trim().slice(0, 220),
          comment: isComment,
        });
      }
    }
  }

  return {
    active,
    historical,
    scannedFileCount,
    historicalSurfaceFileCount,
    skippedEnvFileCount,
  };
}

export function renderReport(result, { mode = "check" } = {}) {
  const lines = [];
  const activeCount = result.active.length;
  const historicalCount = result.historical.length;

  lines.push(
    `generalization-purge gate: ${activeCount} active-surface leak${activeCount === 1 ? "" : "s"} found`,
  );
  lines.push(
    `scanned ${result.scannedFileCount} tracked file${result.scannedFileCount === 1 ? "" : "s"}; classified ${historicalCount} historical/research reference${historicalCount === 1 ? "" : "s"} across ${result.historicalSurfaceFileCount} allowlisted surface file${result.historicalSurfaceFileCount === 1 ? "" : "s"}; skipped ${result.skippedEnvFileCount} env file${result.skippedEnvFileCount === 1 ? "" : "s"}`,
  );

  if (activeCount === 0) {
    lines.push("no active-surface title/vendor leaks found");
    return `${lines.join("\n")}\n`;
  }

  lines.push("");
  lines.push(
    "active-surface title references are generalization leaks: move the reference to a classified historical/research surface or remove it.",
  );

  const byPath = new Map();
  for (const violation of result.active) {
    const current = byPath.get(violation.path) ?? [];
    current.push(violation);
    byPath.set(violation.path, current);
  }

  for (const [path, pathViolations] of [...byPath.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push("");
    lines.push(path);
    for (const violation of pathViolations) {
      const location = violation.line === null ? violation.location : `line ${violation.line}`;
      lines.push(`  - ${location}: ${violation.label} (${violation.token})`);
      if (violation.excerpt) {
        lines.push(`    ${violation.excerpt}`);
      }
    }
  }

  if (mode === "check") {
    lines.push("");
    lines.push("gate FAILED: active-surface generalization leaks must be resolved");
  }

  return `${lines.join("\n")}\n`;
}

function matchesForText(text, matchers) {
  const matches = [];
  for (const matcher of matchers) {
    matcher.pattern.lastIndex = 0;
    for (const match of text.matchAll(matcher.pattern)) {
      matches.push({
        ...matcher,
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
      });
    }
  }

  matches.sort((left, right) => {
    const lengthDelta = right.end - right.start - (left.end - left.start);
    return lengthDelta || left.start - right.start || left.token.localeCompare(right.token);
  });

  const selected = [];
  for (const match of matches) {
    if (selected.some((existing) => rangesOverlap(existing, match))) {
      continue;
    }
    selected.push(match);
  }

  return selected.sort((left, right) => left.start - right.start);
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function rangesOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
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
