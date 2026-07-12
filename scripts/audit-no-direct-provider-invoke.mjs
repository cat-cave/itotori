#!/usr/bin/env node
// p0-core-universal-invocation-supervisor-retry — architecture guard.
//
// Every physical ModelProvider call must pass through InvocationSupervisor.
// Provider adapters may delegate to their underlying transport, and the
// supervisor is the one orchestration boundary allowed to dispatch them. No
// other shipped source may call (or capture) a provider's `invoke` member.
//
// This is AST-based rather than a grep so comments and strings do not count,
// while optional chaining and literal-computed access still do. ModelProvider
// has the distinctive one-request `invoke(request)` signature; the app's
// higher-level QA agents use `invoke(actor, input)`, which this guard leaves
// alone. Provider-named/forwarding receivers are rejected regardless of arity
// so malformed calls and method extraction cannot evade the policy.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isCallExpression,
  isMemberExpression,
  memberPropertyName,
  nodeText,
  parseTypeScript,
  unwrapTsTypeAssertions,
  walk,
  zeroBasedStartLine,
} from "./stable-ts-ast.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const TS_LIKE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const PROVIDER_ADAPTER_PREFIX = "apps/itotori/src/providers/";
const SUPERVISOR_PATH = "apps/itotori/src/orchestrator/invocation-supervisor.ts";
const ADAPTER_DELEGATE_PATHS = new Set([
  "apps/itotori/src/orchestrator/localize-project-stage-command.ts",
  "apps/itotori/src/services/db-live-workflow-ports.ts",
]);

function normalizeRepoPath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function isExemptPath(path) {
  const normalized = normalizeRepoPath(path);
  return normalized.startsWith(PROVIDER_ADAPTER_PREFIX) || normalized === SUPERVISOR_PATH;
}

export function shouldScanPath(path) {
  const normalized = normalizeRepoPath(path);
  return (
    normalized.startsWith("apps/itotori/src/") &&
    TS_LIKE_EXTENSIONS.some((extension) => normalized.endsWith(extension))
  );
}

function receiverNames(node) {
  const names = [];

  function collect(current) {
    const unwrapped = unwrapTsTypeAssertions(current);
    if (!unwrapped) return;
    if (unwrapped.type === "Identifier") {
      names.push(unwrapped.name);
      return;
    }
    if (unwrapped.type === "ThisExpression") {
      names.push("this");
      return;
    }
    if (isMemberExpression(unwrapped)) {
      collect(unwrapped.object);
      const property = memberPropertyName(unwrapped);
      if (property !== undefined) names.push(property);
      return;
    }
    if (isCallExpression(unwrapped)) {
      collect(unwrapped.callee);
    }
  }

  collect(node);
  return names;
}

function isProviderForwardingReceiver(node) {
  return receiverNames(node).some(
    (name) => /provider(?:factory)?$/iu.test(name) || /^(?:inner|delegate)$/iu.test(name),
  );
}

function directCallForMember(member) {
  let expression = member;
  let parent = member.parent;

  while (
    parent &&
    (parent.type === "TSAsExpression" ||
      parent.type === "TSSatisfiesExpression" ||
      parent.type === "TSTypeAssertion" ||
      parent.type === "TSNonNullExpression" ||
      parent.type === "ParenthesizedExpression") &&
    parent.expression === expression
  ) {
    expression = parent;
    parent = parent.parent;
  }

  if (!isCallExpression(parent)) return undefined;
  return unwrapTsTypeAssertions(parent.callee) === member ? parent : undefined;
}

/**
 * Find forbidden provider-dispatch surfaces in one source file.
 * Exported for the companion regression suite.
 */
export function findViolations(path, contents) {
  const normalizedPath = normalizeRepoPath(path);
  if (isExemptPath(normalizedPath)) return [];

  const lines = contents.split(/\r?\n/u);
  const root = parseTypeScript(contents, normalizedPath);
  const violations = [];

  walk(root, (node) => {
    if (
      node.type === "Identifier" &&
      node.name === "dispatchProviderAdapter" &&
      !ADAPTER_DELEGATE_PATHS.has(normalizedPath) &&
      ((node.parent?.type === "ImportSpecifier" && node.parent.imported === node) ||
        (isCallExpression(node.parent) && unwrapTsTypeAssertions(node.parent.callee) === node))
    ) {
      const lineIndex = zeroBasedStartLine(node);
      violations.push({
        file: normalizedPath,
        line: lineIndex + 1,
        column: (node.loc?.start.column ?? 0) + 1,
        receiver: "dispatchProviderAdapter",
        excerpt: (lines[lineIndex] ?? "").trim().slice(0, 200),
      });
      return;
    }
    if (!isMemberExpression(node) || memberPropertyName(node) !== "invoke") return;

    const call = directCallForMember(node);
    const providerReceiver = isProviderForwardingReceiver(node.object);
    // ModelProvider.invoke accepts exactly one request. Higher-level agent
    // `invoke(actor, input)` calls have two arguments and are not dispatches.
    const modelProviderSignature = call !== undefined && call.arguments.length === 1;
    if (!providerReceiver && !modelProviderSignature) return;

    const lineIndex = zeroBasedStartLine(node);
    violations.push({
      file: normalizedPath,
      line: lineIndex + 1,
      column: (node.loc?.start.column ?? 0) + 1,
      receiver: nodeText(contents, node.object).replace(/\s+/gu, " ").slice(0, 120),
      excerpt: (lines[lineIndex] ?? "").trim().slice(0, 200),
    });
  });

  return violations;
}

function listSourceFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "apps/itotori/src"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return (
    output
      .split("\n")
      .map((line) => line.trim())
      // `git ls-files --cached` retains index entries for worktree deletions.
      // A deleted forbidden caller must disappear from the scan rather than
      // crashing the guard before it can inspect the replacement path.
      .filter((line) => line.length > 0 && shouldScanPath(line) && existsSync(join(repoRoot, line)))
  );
}

function resolveScanTargets(args) {
  if (args.length === 0) {
    return listSourceFiles().map((path) => ({ path, absolutePath: join(repoRoot, path) }));
  }
  return args.map((argument) => {
    const absolutePath = resolve(argument);
    const repoRelative = relative(repoRoot, absolutePath);
    return {
      path: normalizeRepoPath(repoRelative.startsWith("..") ? absolutePath : repoRelative),
      absolutePath,
    };
  });
}

export function runAudit(args = []) {
  const violations = [];
  let scannedCount = 0;

  for (const target of resolveScanTargets(args)) {
    if (args.length === 0 && !shouldScanPath(target.path)) continue;
    if (!TS_LIKE_EXTENSIONS.some((extension) => target.path.endsWith(extension))) continue;
    const contents = readFileSync(target.absolutePath, "utf8");
    scannedCount += 1;
    violations.push(...findViolations(target.path, contents));
  }

  if (violations.length > 0) {
    process.stderr.write(
      `no-direct-provider-invoke audit failed: ${violations.length} forbidden provider dispatch${violations.length === 1 ? "" : "es"} found.\n` +
        "Route every ModelProvider call through InvocationSupervisor. Only source under " +
        `${PROVIDER_ADAPTER_PREFIX} and ${SUPERVISOR_PATH} may dispatch directly.\n\n`,
    );
    for (const violation of violations) {
      process.stderr.write(
        `  ${violation.file}:${violation.line}:${violation.column}  [receiver: ${violation.receiver}]\n` +
          `    ${violation.excerpt}\n`,
      );
    }
    return 1;
  }

  process.stdout.write(
    `no-direct-provider-invoke audit passed: ${scannedCount} shipped source files scanned.\n`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exit(runAudit(process.argv.slice(2)));
}
