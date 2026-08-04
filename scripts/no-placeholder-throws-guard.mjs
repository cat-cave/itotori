#!/usr/bin/env node
// @itotori-meta-check
// Reject direct production-path throws that admit a missing implementation.
// Caller/input validation remains valid and is deliberately outside this rule.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTypeScript, sourceLocation, unwrapTsTypeAssertions, walk } from "./stable-ts-ast.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const javaScriptExtension = /\.(?:[cm]?[jt]sx?)$/u;
const rustExtension = /\.rs$/u;
const testFileExtension = /\.(?:test|spec|e2e)\.(?:[cm]?[jt]sx?)$/u;
const rustTestFile = /(?:^|[_-])tests?(?:[_-].*)?\.rs$/u;

const implementationAdmissions = [
  /\b(?:not\s+(?:yet\s+)?implemented|unimplemented)\b/iu,
  /\bnot\s+(?:yet\s+)?(?:built|wired)\b/iu,
  /\b(?:production\s+)?(?:[a-z][\w-]*\s+){0,5}(?:binding|handler|implementation)\s+(?:has|have|is)\s+not\s+(?:been\s+)?(?:installed|built|wired)\b/iu,
  /\b(?:placeholder|stub)\s+(?:implementation|handler|binding)\b/iu,
  /\b(?:TODO|FIXME)\b/u,
];

/** @param {string} root */
export function listWorkingTreeFiles(root = repoRoot) {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .sort();
}

/** @param {string} file */
export function isProductionSource(file) {
  const parts = file.split("/");
  const baseName = parts.at(-1) ?? "";
  if (
    parts.includes("dist") ||
    parts.includes("test") ||
    parts.includes("tests") ||
    parts.includes("e2e") ||
    testFileExtension.test(file)
  ) {
    return false;
  }

  if ((parts[0] === "apps" || parts[0] === "packages") && parts.includes("src")) {
    return javaScriptExtension.test(file);
  }

  return (
    parts[0] === "crates" &&
    parts.includes("src") &&
    rustExtension.test(file) &&
    !rustTestFile.test(baseName)
  );
}

/** @param {import("@babel/types").Node | null | undefined} expression */
function staticMessage(expression) {
  const value = unwrapTsTypeAssertions(expression);
  if (!value) return null;
  if (value.type === "StringLiteral") return value.value;
  if (value.type === "TemplateLiteral") {
    return value.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw ?? "").join("${...}");
  }
  if (
    (value.type === "NewExpression" || value.type === "CallExpression") &&
    value.arguments[0] !== undefined
  ) {
    const first = value.arguments[0];
    return first.type === "SpreadElement" ? null : staticMessage(first);
  }
  return null;
}

/** @param {string} message */
export function isImplementationAdmission(message) {
  return implementationAdmissions.some((pattern) => pattern.test(message));
}

/**
 * @param {string} file
 * @param {string} contents
 */
export function findJavaScriptPlaceholderThrows(file, contents) {
  const root = parseTypeScript(contents, file);
  const violations = [];
  walk(root, (node) => {
    if (node.type !== "ThrowStatement") return;
    const message = staticMessage(node.argument);
    if (message === null || !isImplementationAdmission(message)) return;
    violations.push({
      file,
      line: node.loc?.start.line ?? 1,
      column: (node.loc?.start.column ?? 0) + 1,
      message,
      location: sourceLocation(file, node),
    });
  });
  return violations;
}

function replaceRange(text, start, end) {
  return `${text.slice(0, start)}${" ".repeat(end - start)}${text.slice(end)}`;
}

function matchingBrace(text, opening) {
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = opening; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return text.length;
}

// Rust source is included, but inline test modules are not production paths.
// Keep the match narrow: only remove a module directly marked #[cfg(test)], not
// everything after an arbitrary cfg(test) attribute.
const cfgTestModule =
  /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\](?:\s*#\s*\[[^\]]+\]\s*)*\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+[A-Za-z_]\w*\s*\{/gu;

/** @param {string} contents */
export function withoutCfgTestModules(contents) {
  let output = contents;
  for (const match of [...contents.matchAll(cfgTestModule)].reverse()) {
    const start = match.index ?? 0;
    const opening = start + match[0].lastIndexOf("{");
    output = replaceRange(output, start, matchingBrace(contents, opening));
  }
  return output;
}

/** @param {string} file @param {string} contents */
export function findRustPlaceholderThrows(file, contents) {
  const executable = withoutCfgTestModules(contents);
  const violations = [];
  for (const match of executable.matchAll(/\b(?:todo|unimplemented)\s*!\s*\(/gu)) {
    const offset = match.index ?? 0;
    const before = executable.slice(0, offset);
    const line = before.split("\n").length;
    const column = offset - before.lastIndexOf("\n");
    violations.push({
      file,
      line,
      column,
      message: match[0],
      location: `${file}:${line}:${column}`,
    });
  }
  return violations;
}

/** @param {string} root */
export function scanPlaceholderThrows(root = repoRoot) {
  const files = listWorkingTreeFiles(root).filter(isProductionSource);
  const violations = [];
  for (const file of files) {
    let contents;
    try {
      contents = readFileSync(join(root, file), "utf8");
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") continue;
      throw error;
    }
    if (javaScriptExtension.test(file))
      violations.push(...findJavaScriptPlaceholderThrows(file, contents));
    else violations.push(...findRustPlaceholderThrows(file, contents));
  }
  return { files, violations };
}

function parseArgs(argv) {
  let root = repoRoot;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--root") throw new Error(`unknown argument ${argv[index]}`);
    const value = argv[++index];
    if (!value) throw new Error("--root requires a path");
    root = resolve(value);
  }
  return { root };
}

function run() {
  const { root } = parseArgs(process.argv.slice(2));
  const result = scanPlaceholderThrows(root);
  if (result.violations.length > 0) {
    process.stderr.write(
      `no-placeholder-throws guard: FAILED — ${result.violations.length} production placeholder throw(s)\n`,
    );
    for (const violation of result.violations) {
      process.stderr.write(`  ${violation.location}: ${JSON.stringify(violation.message)}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `no-placeholder-throws guard: passed — ${result.files.length} production source files scanned.\n`,
  );
  process.stdout.write(
    "Limit: scans source below apps/*/src, packages/*/src, and crates/*/src only; it never scans dist, test, or tooling paths. It detects direct JS/TS throws with static implementation-admission messages and Rust todo!/unimplemented! macros, not dynamic messages, errors constructed elsewhere, aliases, or runtime reachability.\n",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    process.stderr.write(
      `no-placeholder-throws guard: FAILED — ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
