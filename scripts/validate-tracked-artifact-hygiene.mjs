#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

export const defaultTrackedIgnoredArtifactAllowlist = [
  {
    path: "artifacts/catalog/resolver-integration.json",
    reason:
      "static resolver integration fixture; contains no live/provider request or response envelope",
  },
];

const liveProviderPathPattern =
  /(?:^|\/)(?:openrouter|provider|provider-runs|live-smoke|telemetry)(?:\/|[-_.]|$)/iu;
const liveProviderContentPatterns = [
  /\bOPENROUTER\b/u,
  /\bOpenRouter\b/u,
  /openrouter-chat-completions/u,
  /itotori\.provider-run\.v\d+/u,
  /providerProofId/u,
  /providerFamily/u,
  /usageResponseJson/u,
  /request\/response envelope/u,
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

export function listTrackedIgnoredFiles(root) {
  const result = spawnSync("git", ["ls-files", "-ci", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || "git ls-files -ci --exclude-standard failed").trim());
  }

  return result.stdout.split("\0").filter(Boolean);
}

export function isEnvPath(path) {
  return path.split("/").some((part) => part === ".env" || part.startsWith(".env."));
}

export function isAllowlisted(path, allowlist = defaultTrackedIgnoredArtifactAllowlist) {
  return allowlist.some((entry) => entry.path === path);
}

export function scanTrackedIgnoredArtifacts({
  root,
  files,
  readFile = (path) => readFileSync(resolve(root, path), "utf8"),
  allowlist = defaultTrackedIgnoredArtifactAllowlist,
}) {
  const violations = [];
  const allowlisted = [];
  let skippedEnvFileCount = 0;

  for (const file of files) {
    if (isEnvPath(file)) {
      skippedEnvFileCount += 1;
      continue;
    }
    const allowlistEntry = allowlist.find((entry) => entry.path === file);
    if (allowlistEntry !== undefined) {
      allowlisted.push({ path: file, reason: allowlistEntry.reason });
      continue;
    }
    if (!file.startsWith("artifacts/")) {
      continue;
    }

    const reasons = [];
    if (liveProviderPathPattern.test(file)) {
      reasons.push("path names live/provider artifact storage");
    }

    let contents = "";
    try {
      contents = readFile(file);
    } catch {
      // A tracked ignored artifact that cannot be read is still not allowed.
    }
    for (const pattern of liveProviderContentPatterns) {
      if (pattern.test(contents)) {
        reasons.push(`content matches ${pattern.source}`);
      }
    }

    violations.push({
      path: file,
      reasons: reasons.length > 0 ? reasons : ["tracked ignored artifact is not allowlisted"],
    });
  }

  return {
    violations,
    allowlisted,
    trackedIgnoredFileCount: files.length,
    skippedEnvFileCount,
  };
}

export function renderReport(result) {
  const lines = [];
  const count = result.violations.length;
  lines.push(`tracked ignored artifact hygiene: ${count} violation${count === 1 ? "" : "s"} found`);
  lines.push(
    `tracked ignored files: ${result.trackedIgnoredFileCount}; allowlisted artifacts: ${result.allowlisted.length}; skipped env files: ${result.skippedEnvFileCount}`,
  );

  if (result.allowlisted.length > 0) {
    lines.push("");
    lines.push("committed ignored artifact allowlist:");
    for (const entry of result.allowlisted.sort((left, right) =>
      left.path.localeCompare(right.path),
    )) {
      lines.push(`  - ${entry.path}: ${entry.reason}`);
    }
  }

  if (count === 0) {
    lines.push("");
    lines.push("no unallowlisted tracked ignored artifacts found");
    return `${lines.join("\n")}\n`;
  }

  lines.push("");
  lines.push("violations:");
  for (const violation of [...result.violations].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    lines.push(`  - ${violation.path}`);
    for (const reason of violation.reasons) {
      lines.push(`    ${reason}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function usage() {
  return [
    "usage: node scripts/validate-tracked-artifact-hygiene.mjs [--mode check|report] [--root <DIR>]",
    "",
    "Fails on tracked files that are ignored by .gitignore under artifacts/ unless they are explicitly allowlisted.",
  ].join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = scanTrackedIgnoredArtifacts({
    root: options.root,
    files: listTrackedIgnoredFiles(options.root),
  });
  process.stdout.write(renderReport(result));
  if (options.mode === "check" && result.violations.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[tracked-artifact-hygiene] FAILED: ${error.message}\n`);
    process.exit(1);
  }
}
