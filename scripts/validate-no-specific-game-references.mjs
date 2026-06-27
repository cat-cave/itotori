#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// Advisory-only guardrail. The configured terms represent concrete title
// names/slugs and title-derived environment variables that should not spread
// into new implementation surfaces.
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

// Explicit exemptions are intentionally narrow: roadmap/planning records,
// committed audit records, a root generalization audit artifact if present, and
// this advisory scanner/test pair because they must document the configured
// guardrail.
export const defaultAllowlist = [
  { path: "roadmap/", reason: "roadmap/planning records" },
  { path: ".plan/", reason: "worker planning records" },
  { path: "docs/audits/", reason: "audit records" },
  { path: "GENERALIZATION_AUDIT.md", reason: "temporary root audit artifact" },
  { path: "scripts/validate-no-specific-game-references.mjs", reason: "scanner self-exemption" },
  {
    path: "scripts/validate-no-specific-game-references.test.mjs",
    reason: "scanner test self-exemption",
  },
];

export function parseArgs(argv) {
  const options = {
    mode: "report",
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

export function isAllowlisted(path, allowlist = defaultAllowlist) {
  return allowlist.some((entry) => {
    if (entry.path.endsWith("/")) {
      return path.startsWith(entry.path);
    }
    return path === entry.path;
  });
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
  allowlist = defaultAllowlist,
  forbiddenTokens = defaultForbiddenTokens,
}) {
  const matchers = buildMatchers(forbiddenTokens);
  const violations = [];
  let scannedFileCount = 0;
  let skippedEnvFileCount = 0;
  let skippedAllowlistedFileCount = 0;

  for (const file of files) {
    if (isEnvPath(file)) {
      skippedEnvFileCount += 1;
      continue;
    }
    if (isAllowlisted(file, allowlist)) {
      skippedAllowlistedFileCount += 1;
      continue;
    }

    const filenameMatches = matchesForText(file, matchers);
    for (const match of filenameMatches) {
      violations.push({
        path: file,
        location: "filename",
        line: null,
        label: match.label,
        token: match.token,
        excerpt: file,
      });
    }

    let contents;
    try {
      contents = readFile(file);
    } catch {
      continue;
    }

    scannedFileCount += 1;
    const lines = contents.split(/\r?\n/u);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      for (const match of matchesForText(line, matchers)) {
        violations.push({
          path: file,
          location: "content",
          line: lineIndex + 1,
          label: match.label,
          token: match.token,
          excerpt: line.trim().slice(0, 220),
        });
      }
    }
  }

  return {
    violations,
    scannedFileCount,
    skippedAllowlistedFileCount,
    skippedEnvFileCount,
  };
}

export function renderReport(result) {
  const lines = [];
  const count = result.violations.length;
  lines.push(`specific-game-reference advisory: ${count} violation${count === 1 ? "" : "s"} found`);
  lines.push(
    `scanned ${result.scannedFileCount} tracked file${result.scannedFileCount === 1 ? "" : "s"}; skipped ${result.skippedAllowlistedFileCount} allowlisted and ${result.skippedEnvFileCount} env file${result.skippedEnvFileCount === 1 ? "" : "s"}`,
  );

  if (count === 0) {
    lines.push("no forbidden title/vendor references found");
    return `${lines.join("\n")}\n`;
  }

  const byPath = new Map();
  for (const violation of result.violations) {
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
    .write(`usage: node scripts/validate-no-specific-game-references.mjs [--mode report|check] [--root PATH] [--token TOKEN...]

Modes:
  report  Print grouped violations and exit 0. Default; advisory-only.
  check   Print grouped violations and exit 1 when violations exist.

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
    process.stdout.write(renderReport(result));
    process.exit(options.mode === "check" && result.violations.length > 0 ? 1 : 0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
