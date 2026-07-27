#!/usr/bin/env node
// CI guard: workflow inputs must be immutable and toolchains centrally installed.
//
// Third-party GitHub Actions run repository-controlled code in CI. A symbolic
// tag is mutable, so every external `uses:` reference needs a complete commit
// SHA plus its reviewed version comment. `setup-itotori` is likewise the sole
// owner of the pinned `just` installer; workflow-local package-manager installs
// would create an unreviewed second toolchain path.
//
// Exit codes: 0 = clean; 1 = violation. Wired into `just ci-tier0-meta`.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const setupAction = ".github/actions/setup-itotori/action.yml";
const shaPattern = /^[0-9a-f]{40}$/u;
const adHocInstallPatterns = [
  /\b(?:sudo\s+)?snap\s+install\b/iu,
  /\bcargo\s+install\b/iu,
  /\b(?:sudo\s+)?(?:apt|apt-get)\s+install\b/iu,
  /\bbrew\s+install\b/iu,
  /\bpip(?:3|x)?\s+install\b/iu,
  /\b(?:npm|pnpm|yarn)\s+(?:install|add)\s+-g\b/iu,
  /\bnix\s+develop\b.*--command\s+just\b/iu,
];

export function listWorkflowFiles(root) {
  return execSync("git ls-files .github", { cwd: root, encoding: "utf8" })
    .split("\n")
    .map((path) => path.trim())
    .filter((path) => path.endsWith(".yml") || path.endsWith(".yaml"));
}

function withoutComment(line) {
  return line.split("#", 1)[0];
}

function add(violations, file, line, kind, message) {
  violations.push({ file, line, kind, message });
}

export function findCiInputViolations(file, contents) {
  const violations = [];
  const lines = contents.split(/\r?\n/u);
  let hasCanonicalJust = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const uses = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#\s*(.*))?\s*$/u);
    if (uses && !uses[1].startsWith("./")) {
      const [owner, ref] = uses[1].split("@", 2);
      if (!ref || !shaPattern.test(ref)) {
        add(
          violations,
          file,
          lineNumber,
          "mutable-action",
          `third-party uses ${uses[1]} is not a full commit SHA`,
        );
      } else if (!uses[2]?.trim()) {
        add(
          violations,
          file,
          lineNumber,
          "missing-version-comment",
          `third-party uses ${owner}@${ref} lacks a version comment`,
        );
      }
    }

    const command = withoutComment(line);
    for (const pattern of adHocInstallPatterns) {
      if (pattern.test(command)) {
        add(
          violations,
          file,
          lineNumber,
          "ad-hoc-install",
          "workflow-local toolchain installation is forbidden",
        );
      }
    }

    if (/\bjust@/u.test(command)) {
      if (file !== setupAction) {
        add(
          violations,
          file,
          lineNumber,
          "duplicate-just-installer",
          "only setup-itotori may install just",
        );
      } else if (/\bjust@1\.56\.0(?:,|\s|$)/u.test(command)) {
        hasCanonicalJust = true;
      } else {
        add(
          violations,
          file,
          lineNumber,
          "unexpected-just-version",
          "setup-itotori must install just@1.56.0",
        );
      }
    }
  }

  if (file === setupAction && !hasCanonicalJust) {
    add(violations, file, 1, "missing-just-installer", "setup-itotori must install just@1.56.0");
  }
  return violations;
}

function scanFiles(root, files) {
  const violations = [];
  let scanned = 0;
  for (const file of files) {
    try {
      const target = root === null ? file : join(root, file);
      violations.push(...findCiInputViolations(file, readFileSync(target, "utf8")));
      scanned += 1;
    } catch {
      // A disappeared file cannot contribute a mutable CI input.
    }
  }
  return { scanned, violations };
}

function parseArgs(argv) {
  const options = { root: repoRoot, files: [], help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.root = resolve(argv[(index += 1)]);
    else if (arg.startsWith("--root=")) options.root = resolve(arg.slice("--root=".length));
    else if (arg === "--help" || arg === "-h") options.help = true;
    else options.files.push(arg);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "usage: node scripts/audit-ci-input-pins.mjs [--root DIR] [<workflow.yml>...]\n",
    );
    return;
  }
  const result =
    options.files.length > 0
      ? scanFiles(null, options.files)
      : scanFiles(options.root, listWorkflowFiles(options.root));
  if (result.violations.length === 0) {
    process.stdout.write(
      `ci-input-pins guard: passed. ${result.scanned} workflow/action YAML file(s) scanned.\n`,
    );
    return;
  }
  process.stderr.write(
    `ci-input-pins guard: FAILED. ${result.violations.length} violation(s) found.\n\n`,
  );
  for (const violation of result.violations) {
    process.stderr.write(
      `  ${violation.file}:${violation.line}  ${violation.kind}  ${violation.message}\n`,
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
