#!/usr/bin/env node
/*
 * the relevant capability — `pnpm exec vp run kaifuu:encrypted-readiness`
 *
 * Alpha encrypted-readiness evidence integration. COMPOSES the already-generated
 * encrypted-readiness EVIDENCE of the prerequisite slices (the relevant capability packed
 * -engine readiness surface + the relevant capability alpha-encrypted readiness evidence)
 * into an alpha-readiness composed-evidence artifact.
 *
 * This is a FIRST-CLASS LOCAL workflow, intentionally ABSENT from public/per
 * -gate CI (no `just check`/`ci` lane and no affected.mjs
 * selection reference it). It composes existing prerequisite proofs by content
 * HASH; it never re-owns a prerequisite slice, never re-derives readiness, and
 * never shells out.
 *
 * Inputs:
 *   --no-corpus                 Exercise the explicit absent-input failure path.
 *   --private-manifest <path>   Aggregate an operator's already-redacted
 *                               private-encrypted-corpus manifest.
 *   --prerequisites <path>      Prerequisites manifest override (default the
 *                               committed prerequisites.manifest.json).
 *   --out <path>                Output path override.
 *
 * Output: .tmp/kaifuu-private-local/encrypted-readiness-report.json.
 * Missing or empty private input emits a typed content-free diagnostic,
 * creates no evidence artifact, and exits nonzero.
 *
 * A missing/tampered/unsupported prerequisite makes the artifact status
 * `failed` with structured semantic diagnostics — never a hidden success.
 */
"use strict";

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildComposedReport,
  composePrerequisites,
  normalizePrivateManifest,
  stableStringify,
} from "./compose.mjs";
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

const DEFAULT_PREREQUISITES = join(
  "suite",
  "scripts",
  "kaifuu-encrypted-readiness-integration",
  "prerequisites.manifest.json",
);
const OUTPUT_DIR = join(".tmp", "kaifuu-private-local");
const REPORT_OUTPUT = join(OUTPUT_DIR, "encrypted-readiness-report.json");

export function parseArgs(argv) {
  const seen = new Set();
  const selectors = new Set();
  const options = {
    noCorpus: false,
    privateManifest: null,
    prerequisites: DEFAULT_PREREQUISITES,
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    if (arg === "--no-corpus") {
      claimPrivateOption(seen, arg);
      selectors.add("absent");
      options.noCorpus = true;
    } else if (arg === "--private-manifest") {
      claimPrivateOption(seen, arg);
      selectors.add("manifest");
      options.privateManifest = requirePrivateOptionValue(argv, i);
      i += 1;
    } else if (arg === "--prerequisites") {
      claimPrivateOption(seen, arg);
      options.prerequisites = requirePrivateOptionValue(argv, i);
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

function readJsonFile(path) {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new PrivateInputContractError("private-input-invalid");
  }
}

// Compose the prerequisite proofs for the given options. Reads the committed
// prerequisite manifest + the public fixture artifacts it names; every artifact
// path is resolved relative to `root`.
export function compose(options, root = REPO_ROOT) {
  const manifestPath = resolve(root, options.prerequisites);
  const manifest = readJsonFile(manifestPath);
  const readArtifact = (relPath) => {
    if (typeof relPath !== "string") {
      return null;
    }
    const path = resolve(root, relPath);
    return existsSync(path) ? readJsonFile(path) : null;
  };
  return composePrerequisites(manifest, readArtifact);
}

// Produce an aggregate report or a typed failure for the given options.
export function integrate(options, root = REPO_ROOT) {
  const task = "kaifuu:encrypted-readiness";
  if (options.noCorpus) {
    return privateInputFailure(task, "private-input-explicitly-absent");
  }
  if (!options.privateManifest) {
    return privateInputFailure(task, "private-input-manifest-missing");
  }
  const privatePath = resolve(root, options.privateManifest);
  if (!existsSync(privatePath)) {
    return privateInputFailure(task, "private-input-manifest-missing");
  }
  const file = statSync(privatePath);
  if (!file.isFile()) {
    return privateInputFailure(task, "private-input-manifest-not-file");
  }
  if (file.size === 0) {
    return privateInputFailure(task, "private-input-zero-bytes");
  }
  const entries = normalizePrivateManifest(readJsonFile(privatePath));
  if (entries.length === 0) {
    return privateInputFailure(task, "private-input-selection-empty");
  }
  const composed = compose(options, root);
  return { kind: "report", artifact: buildComposedReport(entries, { composed }) };
}

function usage() {
  return [
    "usage: pnpm exec vp run kaifuu:encrypted-readiness -- [options]",
    "",
    "  --no-corpus                fail with the typed absent-input diagnostic",
    "  --private-manifest <path>  aggregate an already-redacted private-encrypted-corpus manifest",
    "  --prerequisites <path>     prerequisites manifest override",
    "  --out <path>               output path override",
  ].join("\n");
}

export function main(argv = process.argv.slice(2), root = REPO_ROOT) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const result = integrate(options, root);
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
    `kaifuu-encrypted-readiness: ${kind} written ` +
      `(status=${artifact.status}, prerequisiteArtifacts=${artifact.composes.artifacts.length}, ` +
      `prerequisiteFindings=${artifact.prerequisiteFindings.length}, ` +
      `composedEvidenceHash=${artifact.composedEvidenceHash})\n`,
  );
  // A failed composition (missing/tampered/unsupported prerequisite) is a hard
  // failure — never a hidden success.
  return artifact.status === "failed" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main());
  } catch (error) {
    const failure = privateInputFailureFromError("kaifuu:encrypted-readiness", error);
    process.stderr.write(stableStringify(failure.diagnostic));
    process.exit(1);
  }
}
