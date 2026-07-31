#!/usr/bin/env node
/*
 * the relevant capability — `pnpm exec vp run kaifuu:key-hunt`
 *
 * Private-local key-hunting run workflow. Like the relevant capability's triage and
 * the relevant capability's Siglus validation renderer this is a FIRST-CLASS LOCAL workflow,
 * ABSENT from public/per-gate CI (no `just check`/`ci` lane and no affected.mjs /
 * CI selection references it). It reads operator private-local
 * key-hunt manifests (describing per-attempt helper outcomes) and emits ONLY a
 * redacted aggregate key-hunt report of the five outcome categories.
 *
 * Inputs:
 *   --no-corpus            Exercise the explicit absent-input failure path.
 *   --manifest <path>      Read a single kaifuu-key-hunt-manifest.local.json.
 *   --corpus-dir <dir>     Scan <dir> for kaifuu-key-hunt-manifest.local.json
 *                          files (dir root + one level of corpus subdirs).
 *   --root <dir>           Private-local root to probe when neither --manifest
 *                          nor --corpus-dir is given (default fixtures/private-local).
 *   --out <path>           Output path (default .tmp/kaifuu-private-local/...).
 *
 * Behavior:
 *   - Manifests are the ONLY thing read. They are operator-authored and already
 *     redacted; the workflow PLANS the applicable attempts per engine/capability,
 *     validates + aggregates the recorded outcomes, and secret-scans the result.
 *     It never reads raw keys, encrypted bytes, or decrypted text, and never
 *     shells out to a real helper (Wine/Proton/native Windows).
 *   - Missing or empty private input emits a typed content-free diagnostic,
 *     creates no evidence artifact, and exits nonzero.
 *   - Otherwise it writes the aggregate key-hunt report to
 *     .tmp/kaifuu-private-local/key-hunt-report.json.
 *   - A redaction violation (any leak in the emitted report) THROWS and exits
 *     non-zero — it never emits a leaking report.
 */
"use strict";

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMMANDS, buildKeyHuntReport, normalizeManifest, stableStringify } from "./key-hunt.mjs";
import {
  claimPrivateOption,
  PrivateInputContractError,
  privateInputFailure,
  privateInputFailureFromError,
  rejectPrivateHelpConflict,
  rejectPrivateSelectorConflict,
  requirePrivateOptionValue,
} from "../kaifuu-private-local-triage/triage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..", "..");

const MANIFEST_FILENAME = "kaifuu-key-hunt-manifest.local.json";
const DEFAULT_PRIVATE_ROOT = "fixtures/private-local";
const OUTPUT_DIR = join(".tmp", "kaifuu-private-local");
const REPORT_OUTPUT = join(OUTPUT_DIR, "key-hunt-report.json");

export function parseArgs(argv) {
  const seen = new Set();
  const selectors = new Set();
  const options = {
    noCorpus: false,
    manifest: null,
    corpusDir: null,
    root: DEFAULT_PRIVATE_ROOT,
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      // `vp run <task> -- <args>` forwards the literal separator; ignore it.
      continue;
    }
    if (arg === "--no-corpus") {
      claimPrivateOption(seen, arg);
      selectors.add("absent");
      options.noCorpus = true;
    } else if (arg === "--manifest") {
      claimPrivateOption(seen, arg);
      selectors.add("manifest");
      options.manifest = requirePrivateOptionValue(argv, i);
      i += 1;
    } else if (arg === "--corpus-dir") {
      claimPrivateOption(seen, arg);
      selectors.add("directory");
      options.corpusDir = requirePrivateOptionValue(argv, i);
      i += 1;
    } else if (arg === "--root") {
      claimPrivateOption(seen, arg);
      selectors.add("root");
      options.root = requirePrivateOptionValue(argv, i);
      i += 1;
    } else if (arg === "--out") {
      claimPrivateOption(seen, arg);
      options.out = requirePrivateOptionValue(argv, i);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  rejectPrivateHelpConflict(argv, options.help === true);
  rejectPrivateSelectorConflict(selectors);
  return options;
}

function readManifestFile(path) {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new PrivateInputContractError("private-input-invalid");
  }
}

// Discover manifest files under a corpus directory: an optional root-level
// manifest plus one manifest per immediate corpus subdirectory. Deterministic
// (sorted). Only the manifest JSON is read — never corpus contents.
export function discoverManifestPaths(dir) {
  const found = [];
  const rootManifest = join(dir, MANIFEST_FILENAME);
  if (existsSync(rootManifest)) {
    found.push(rootManifest);
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new PrivateInputContractError("private-input-directory-unreadable");
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = join(dir, entry.name, MANIFEST_FILENAME);
    if (existsSync(candidate)) {
      found.push(candidate);
    }
  }
  return [...new Set(found)].sort();
}

// Resolve selected manifest paths or a content-free input-failure reason.
export function resolveInputs(options, root = REPO_ROOT) {
  if (options.noCorpus) {
    return { failureReason: "private-input-explicitly-absent" };
  }
  if (options.manifest) {
    const path = resolve(root, options.manifest);
    if (!existsSync(path)) {
      return { failureReason: "private-input-manifest-missing" };
    }
    if (!statSync(path).isFile()) {
      return { failureReason: "private-input-manifest-not-file" };
    }
    return {
      command: COMMANDS.manifest,
      manifestPaths: [path],
    };
  }
  if (options.corpusDir) {
    const dir = resolve(root, options.corpusDir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      return { failureReason: "private-input-root-missing" };
    }
    const manifestPaths = discoverManifestPaths(dir);
    if (manifestPaths.length === 0) {
      return { failureReason: "private-input-directory-empty" };
    }
    return {
      command: COMMANDS.corpusDir,
      manifestPaths,
    };
  }
  const rootDir = resolve(root, options.root);
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
    return { failureReason: "private-input-root-missing" };
  }
  const manifestPaths = discoverManifestPaths(rootDir);
  return manifestPaths.length === 0
    ? { failureReason: "private-input-directory-empty" }
    : { command: COMMANDS.corpusDir, manifestPaths };
}

// Produce an aggregate report or a typed failure for the given options.
// Pure w.r.t. output: reads only manifest JSON and never writes.
export function keyHunt(options, root = REPO_ROOT) {
  const resolved = resolveInputs(options, root);
  if (resolved.failureReason) {
    return privateInputFailure("kaifuu:key-hunt", resolved.failureReason);
  }
  const attempts = [];
  for (const path of resolved.manifestPaths) {
    const file = statSync(path);
    if (!file.isFile()) {
      return privateInputFailure("kaifuu:key-hunt", "private-input-manifest-not-file");
    }
    if (file.size === 0) {
      return privateInputFailure("kaifuu:key-hunt", "private-input-zero-bytes");
    }
    const parsed = readManifestFile(path);
    const selected = normalizeManifest(parsed, MANIFEST_FILENAME);
    if (selected.length === 0) {
      return privateInputFailure("kaifuu:key-hunt", "private-input-selection-empty");
    }
    for (const attempt of selected) {
      attempts.push(attempt);
    }
  }
  if (attempts.length === 0) {
    return privateInputFailure("kaifuu:key-hunt", "private-input-selection-empty");
  }
  return {
    kind: "report",
    artifact: buildKeyHuntReport(attempts, { command: resolved.command }),
  };
}

function usage() {
  return [
    "usage: pnpm exec vp run kaifuu:key-hunt -- [options]",
    "",
    "  --no-corpus          fail with the typed absent-input diagnostic",
    "  --manifest <path>    scan a single kaifuu-key-hunt-manifest.local.json",
    "  --corpus-dir <dir>   scan a directory of private-local corpora",
    "  --root <dir>         private-local root to probe (default fixtures/private-local)",
    "  --out <path>         output path override",
  ].join("\n");
}

export function main(argv = process.argv.slice(2), root = REPO_ROOT) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const result = keyHunt(options, root);
  if (result.kind === "failure") {
    process.stderr.write(stableStringify(result.diagnostic));
    return 1;
  }
  const { kind, artifact } = result;
  const defaultOut = REPORT_OUTPUT;
  const outPath = resolve(root, options.out ?? defaultOut);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, stableStringify(artifact), "utf8");
  process.stdout.write(
    `kaifuu-key-hunt: ${kind} written ` +
      `(status=${artifact.status}, corpora=${artifact.aggregateCounts.corpora}, ` +
      `attempts=${artifact.aggregateCounts.attempts})\n`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main());
  } catch (error) {
    const failure = privateInputFailureFromError("kaifuu:key-hunt", error);
    process.stderr.write(stableStringify(failure.diagnostic));
    process.exit(1);
  }
}
