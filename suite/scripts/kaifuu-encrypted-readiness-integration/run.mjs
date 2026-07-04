#!/usr/bin/env node
/*
 * KAIFUU-042 — `pnpm exec vp run kaifuu:encrypted-readiness`
 *
 * Alpha encrypted-readiness evidence integration. COMPOSES the already-generated
 * encrypted-readiness EVIDENCE of the prerequisite slices (KAIFUU-103 packed
 * -engine readiness surface + KAIFUU-104 alpha-encrypted readiness evidence)
 * into an alpha-readiness composed-evidence artifact, and — the key deliverable
 * — emits a deterministic REDACTED no-corpus artifact when NO private encrypted
 * corpus is configured.
 *
 * This is a FIRST-CLASS LOCAL workflow, intentionally ABSENT from public/per
 * -gate CI (no `just check`/`ci` lane and no affected.mjs / qd-full-ci.mjs
 * selection reference it). It composes existing prerequisite proofs by content
 * HASH; it never re-owns a prerequisite slice, never re-derives readiness, and
 * never shells out.
 *
 * Inputs (all optional; default is the no-corpus path):
 *   --no-corpus                 Force the deterministic redacted no-corpus
 *                               artifact (private encrypted corpus absent).
 *   --private-manifest <path>   Aggregate an operator's already-redacted
 *                               private-encrypted-corpus manifest.
 *   --prerequisites <path>      Prerequisites manifest override (default the
 *                               committed prerequisites.manifest.json).
 *   --out <path>                Output path override.
 *
 * Outputs (under .tmp/kaifuu-private-local/):
 *   no-corpus  -> encrypted-readiness-no-corpus-skipped.json  (status skipped)
 *   report     -> encrypted-readiness-report.json             (status ok/failed)
 *
 * A missing/tampered/unsupported prerequisite makes the artifact status
 * `failed` with structured semantic diagnostics — never a hidden success.
 */
"use strict";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildComposedReport,
  buildNoCorpusArtifact,
  composePrerequisites,
  normalizePrivateManifest,
  stableStringify,
} from "./compose.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..", "..");

const DEFAULT_PREREQUISITES = join(
  "suite",
  "scripts",
  "kaifuu-encrypted-readiness-integration",
  "prerequisites.manifest.json",
);
const OUTPUT_DIR = join(".tmp", "kaifuu-private-local");
const NO_CORPUS_OUTPUT = join(OUTPUT_DIR, "encrypted-readiness-no-corpus-skipped.json");
const REPORT_OUTPUT = join(OUTPUT_DIR, "encrypted-readiness-report.json");

export function parseArgs(argv) {
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
      options.noCorpus = true;
    } else if (arg === "--private-manifest") {
      options.privateManifest = argv[(i += 1)];
    } else if (arg === "--prerequisites") {
      options.prerequisites = argv[(i += 1)];
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

function readJsonFile(path) {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${error instanceof Error ? error.message : error}`);
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

// Produce the artifact (no-corpus OR aggregate report) for the given options.
export function integrate(options, root = REPO_ROOT) {
  const composed = compose(options, root);

  // Private encrypted corpus present ONLY when an operator manifest is given and
  // resolves; otherwise (default, or --no-corpus) the private inputs are absent.
  const wantsPrivate = !options.noCorpus && options.privateManifest;
  const privatePath = wantsPrivate ? resolve(root, options.privateManifest) : null;
  if (privatePath && existsSync(privatePath)) {
    const entries = normalizePrivateManifest(readJsonFile(privatePath));
    return { kind: "report", artifact: buildComposedReport(entries, { composed }) };
  }
  return { kind: "no-corpus", artifact: buildNoCorpusArtifact({ composed }) };
}

function usage() {
  return [
    "usage: pnpm exec vp run kaifuu:encrypted-readiness -- [options]",
    "",
    "  --no-corpus                emit the deterministic redacted no-corpus artifact",
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
  const { kind, artifact } = integrate(options, root);
  const defaultOut = kind === "no-corpus" ? NO_CORPUS_OUTPUT : REPORT_OUTPUT;
  const outPath = resolve(root, options.out ?? defaultOut);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, stableStringify(artifact), "utf8");
  process.stdout.write(
    `kaifuu-encrypted-readiness: ${kind} -> ${options.out ?? defaultOut} ` +
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
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
