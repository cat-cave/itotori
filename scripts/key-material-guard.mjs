#!/usr/bin/env node
// @itotori-meta-check
// Guard the Git index against private-key filenames and PEM private-key headers.
//
// The index is the enforcement boundary: it includes tracked files and staged
// additions, including files force-added past .gitignore. Content matches are
// reported by pathname only; key bodies are never emitted.
//
// Limit: this cannot see untracked or ignored files. Content detection covers
// contiguous ASCII PEM private-key headers only; it cannot recognize binary,
// encoded, split, or obfuscated key material whose filename is otherwise bland.
//
// Exit codes: 0 = clean; 1 = violation; 2 = Git invocation failure.
// Wired into `just check meta` and therefore `just ci tier0-meta`.

import { spawnSync } from "node:child_process";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const SENSITIVE_EXTENSIONS = new Set([".key", ".p8", ".p12", ".pem", ".pfx", ".pkcs8", ".pkcs12"]);
const SENSITIVE_BASENAMES = new Set([
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "private-key",
  "private_key",
  "privatekey",
]);
const PEM_HEADER_PATTERN = ["-----BEGIN ", "([A-Z0-9]+ )*PRIVATE KEY-----"].join("");

function git(root, args, acceptedStatuses = [0]) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (!acceptedStatuses.includes(result.status)) {
    const detail = result.stderr.toString("utf8").trim();
    throw new Error(detail === "" ? `git ${args[0]} failed` : detail);
  }
  return result.stdout;
}

function nulPaths(buffer) {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

export function sensitivePathReason(path) {
  const name = basename(path).toLowerCase();
  const extension = extname(name);
  if (SENSITIVE_EXTENSIONS.has(extension)) return `private-key extension ${extension}`;
  if (SENSITIVE_BASENAMES.has(name)) return `private-key basename ${name}`;
  return null;
}

export function inspectIndex(root) {
  const indexedPaths = nulPaths(git(root, ["ls-files", "--cached", "-z"]));
  const violations = [];
  for (const path of indexedPaths) {
    const reason = sensitivePathReason(path);
    if (reason !== null) violations.push({ path, reason });
  }

  const contentPaths = nulPaths(
    git(root, ["grep", "--cached", "-l", "-z", "-E", "--", PEM_HEADER_PATTERN], [0, 1]),
  );
  for (const path of contentPaths) {
    violations.push({ path, reason: "PEM private-key header" });
  }

  return {
    indexedCount: indexedPaths.length,
    violations: violations.toSorted((left, right) =>
      left.path === right.path
        ? left.reason.localeCompare(right.reason)
        : left.path.localeCompare(right.path),
    ),
  };
}

function parseArgs(argv) {
  const options = { root: repoRoot, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.root = resolve(argv[(index += 1)]);
    else if (arg.startsWith("--root=")) options.root = resolve(arg.slice("--root=".length));
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function scopeMessage() {
  return (
    "Limit: scans the Git index only; untracked/ignored files are outside its view. " +
    "Content detection recognizes contiguous ASCII PEM private-key headers, not binary, " +
    "encoded, split, or obfuscated key material with a bland filename.\n"
  );
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("usage: node scripts/key-material-guard.mjs [--root DIR]\n");
      return;
    }
    const result = inspectIndex(options.root);
    if (result.violations.length === 0) {
      process.stdout.write(
        `key-material guard: passed. ${result.indexedCount} indexed path(s) scanned; 0 violations.\n` +
          scopeMessage(),
      );
      return;
    }
    process.stderr.write(
      `key-material guard: FAILED. ${result.violations.length} violation(s) found.\n` +
        "Remove private-key material from the index; do not commit or publish it.\n" +
        scopeMessage() +
        "\n",
    );
    for (const violation of result.violations) {
      process.stderr.write(`  ${violation.path}  ${violation.reason}\n`);
    }
    process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `key-material guard: ERROR. ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
