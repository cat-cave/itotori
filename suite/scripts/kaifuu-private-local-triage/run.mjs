#!/usr/bin/env node
/*
 * KAIFUU-036 — `pnpm exec vp run kaifuu:private-local-triage`
 *
 * Private-local encrypted owned-game corpus triage. This is a FIRST-CLASS LOCAL
 * workflow, ABSENT from public/per-gate CI (no `just check`/`ci` lane and no
 * affected.mjs / qd-full-ci.mjs selection reference it). It scans operator
 * private-local triage manifests and emits ONLY redacted aggregate readiness
 * evidence.
 *
 * Inputs (all optional; default is the no-corpus path):
 *   --no-corpus            Force the deterministic redacted no-corpus artifact.
 *   --manifest <path>      Read a single private-triage-manifest.local.json.
 *   --corpus-dir <dir>     Scan <dir> for private-triage-manifest.local.json
 *                          files (dir root + one level of corpus subdirs).
 *   --root <dir>           Private-local root to probe when neither --manifest
 *                          nor --corpus-dir is given (default fixtures/private-local).
 *   --out <path>           Output path (default .tmp/kaifuu-private-local/...).
 *
 * Behavior:
 *   - Manifests are the ONLY thing read. They are operator-authored and already
 *     redacted; the triage validates + aggregates them and secret-scans the
 *     result. It never reads raw keys, encrypted bytes, or retail assets, and
 *     never shells out.
 *   - When no private inputs are present (default root absent, or --no-corpus,
 *     or an empty corpus dir), it writes the deterministic REDACTED no-corpus
 *     artifact to .tmp/kaifuu-private-local/no-corpus-skipped.json and exits 0.
 *     Absence of fixtures/private-local NEVER fails.
 *   - Otherwise it writes the aggregate readiness report to
 *     .tmp/kaifuu-private-local/readiness-report.json.
 */
"use strict";

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  COMMANDS,
  buildNoCorpusArtifact,
  buildReadinessReport,
  normalizeManifest,
  stableStringify,
} from "./triage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..", "..");

const MANIFEST_FILENAME = "private-triage-manifest.local.json";
const DEFAULT_PRIVATE_ROOT = "fixtures/private-local";
const OUTPUT_DIR = join(".tmp", "kaifuu-private-local");
const NO_CORPUS_OUTPUT = join(OUTPUT_DIR, "no-corpus-skipped.json");
const REPORT_OUTPUT = join(OUTPUT_DIR, "readiness-report.json");

export function parseArgs(argv) {
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
      options.noCorpus = true;
    } else if (arg === "--manifest") {
      options.manifest = argv[(i += 1)];
    } else if (arg === "--corpus-dir") {
      options.corpusDir = argv[(i += 1)];
    } else if (arg === "--root") {
      options.root = argv[(i += 1)];
    } else if (arg === "--out") {
      options.out = argv[(i += 1)];
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function readManifestFile(path) {
  const text = readFileSync(path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${error instanceof Error ? error.message : error}`);
  }
  return parsed;
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
    return found.sort();
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

// Resolve which manifest paths (if any) to triage, and the logical ids for the
// no-corpus artifact's redacted checkedPaths. Returns { command, manifestPaths,
// checkedPaths }.
export function resolveInputs(options, root = REPO_ROOT) {
  if (options.noCorpus) {
    return { command: COMMANDS.noCorpus, manifestPaths: [], checkedPaths: ["private-local-root"] };
  }
  if (options.manifest) {
    const path = resolve(root, options.manifest);
    return {
      command: COMMANDS.manifest,
      manifestPaths: existsSync(path) ? [path] : [],
      checkedPaths: ["private-manifest"],
    };
  }
  if (options.corpusDir) {
    const dir = resolve(root, options.corpusDir);
    const manifestPaths = existsSync(dir) ? discoverManifestPaths(dir) : [];
    return {
      command: COMMANDS.corpusDir,
      manifestPaths,
      checkedPaths: ["private-corpus-directory"],
    };
  }
  const rootDir = resolve(root, options.root);
  const manifestPaths =
    existsSync(rootDir) && statSync(rootDir).isDirectory() ? discoverManifestPaths(rootDir) : [];
  return { command: COMMANDS.corpusDir, manifestPaths, checkedPaths: ["private-local-root"] };
}

// Produce the artifact (no-corpus OR aggregate report) for the given options.
// Pure w.r.t. output: reads only manifest JSON, returns { artifact, kind }.
export function triage(options, root = REPO_ROOT) {
  const { command, manifestPaths, checkedPaths } = resolveInputs(options, root);
  if (manifestPaths.length === 0) {
    return {
      kind: "no-corpus",
      artifact: buildNoCorpusArtifact({
        command: options.noCorpus ? COMMANDS.noCorpus : command,
        checkedPaths,
      }),
    };
  }
  const entries = [];
  for (const path of manifestPaths) {
    const parsed = readManifestFile(path);
    for (const entry of normalizeManifest(parsed, MANIFEST_FILENAME)) {
      entries.push(entry);
    }
  }
  return { kind: "report", artifact: buildReadinessReport(entries, { command }) };
}

function usage() {
  return [
    "usage: pnpm exec vp run kaifuu:private-local-triage -- [options]",
    "",
    "  --no-corpus          emit the deterministic redacted no-corpus artifact",
    "  --manifest <path>    triage a single private-triage-manifest.local.json",
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
  const { kind, artifact } = triage(options, root);
  const defaultOut = kind === "no-corpus" ? NO_CORPUS_OUTPUT : REPORT_OUTPUT;
  const outPath = resolve(root, options.out ?? defaultOut);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, stableStringify(artifact), "utf8");
  process.stdout.write(
    `kaifuu-private-local-triage: ${kind} -> ${options.out ?? defaultOut} ` +
      `(status=${artifact.status}, corpora=${artifact.aggregateCounts.corpora}, ` +
      `entries=${artifact.aggregateCounts.entries})\n`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
