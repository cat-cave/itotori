#!/usr/bin/env node
// real-bytes-periodic-ground-truth-oracle (P2) — the strict-proof ANCHOR for
// the synthetic-CI collapse.
//
// WHY THIS EXISTS
// ---------------
// The synthetic-CI collapse moves per-gate CI onto fast synthetic fixtures
// (the coverage manifest + differentially-validated synthetic archives) so a
// per-gate run no longer re-parses whole real games (~30-45 min). That is only
// SAFE while the synthetic still faithfully mirrors reality. This oracle is the
// safety net: a PERIODIC (nightly + on-demand) run — invoked OUTSIDE the
// per-gate `qd-full-ci` path — that keeps the REAL archives as ground truth and
// FAILS LOUD the moment the synthetic drifts away from what the real bytes
// exercise.
//
// It runs TWO stages, either of which fails the whole run (nonzero exit):
//
//   (A) GROUND TRUTH — re-run the FULL real-bytes suite (`just ci-real-bytes`)
//       against the real corpora under /scratch/itotori-research + the live
//       read-only vault (Sweetie HD + Kanon RealLive, LustMemory RPG Maker
//       MV/MZ, the vault-materialized Siglus installs). Read-only; never copies
//       copyrighted bytes. This proves the source-of-truth catalogues
//       (REAL_CATALOG, NamedOpcode, classify(), the g00 type matrix, …) still
//       match the real bytes — the 100%-decompilation / 0-unknown-opcode bar.
//
//   (B) SYNTHETIC-vs-REAL DRIFT CHECK — re-derive the coverage manifest from
//       the SAME live source-of-truth catalogues the real-bytes suite keys on
//       and diff it against the committed
//       fixtures/synthetic/coverage-manifest.v0.json. If a real-bytes-exercised
//       component appears that the manifest does not cover (`missing`), or the
//       manifest lists a component the sources no longer produce (`extra`), or
//       the manifest bytes otherwise diverged, the drift check FAILS LOUD.
//
// The two stages CHAIN into the guarantee the collapse depends on:
//   stage A proves  catalogues == real bytes   (0 unknown opcodes on real bytes)
//   stage B proves  manifest   == catalogues   (re-derived diff is empty)
//   => transitively manifest (the synthetic's coverage contract) == real bytes.
// If the synthetic ever silently diverged from reality, one of these links
// breaks and the run goes red, telling the operator to RE-DERIVE the synthetic.
//
// CADENCE + WHAT A FAILURE MEANS
// ------------------------------
//   * Nightly cron + manual workflow_dispatch (.github/workflows/real-bytes-oracle.yml),
//     and on-demand locally via `just real-bytes-oracle`.
//   * It is NOT wired into affected.mjs / qd-full-ci — a per-gate green never
//     pays for (or waits on) this. That separation is the whole point.
//   * A RED oracle means the synthetic fixtures / coverage manifest DRIFTED
//     from reality: RE-DERIVE the synthetic (regenerate the manifest with
//     `node scripts/synthetic-coverage-manifest.mjs`, re-author/re-validate the
//     synthetic fixtures) and land the update BEFORE trusting per-gate green.
//   See docs/real-bytes-periodic-oracle.md.
//
// Usage:
//   node scripts/real-bytes-oracle.mjs                # full oracle: (A) + (B)
//   node scripts/real-bytes-oracle.mjs --drift-only   # only (B) — no corpora
//                                                      #   needed (repo-only)
//   node scripts/real-bytes-oracle.mjs --real-bytes-only  # only (A)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildArtifact,
  diffManifests,
  GENERATOR_PATH,
  OUTPUT_JSON_PATH,
  repoRoot,
} from "./synthetic-coverage-manifest.mjs";

const REDERIVE_HINT =
  `RE-DERIVE THE SYNTHETIC: regenerate the coverage manifest with ` +
  `\`node ${GENERATOR_PATH}\` and re-validate the synthetic fixtures against ` +
  `the real corpora, then land the update before trusting per-gate green. ` +
  `See docs/real-bytes-periodic-oracle.md.`;

export class OracleGroundTruthError extends Error {
  constructor(message) {
    super(message);
    this.name = "OracleGroundTruthError";
  }
}

export class OracleDriftError extends Error {
  constructor(message) {
    super(message);
    this.name = "OracleDriftError";
  }
}

function banner(text) {
  console.log(`\n=== real-bytes-oracle: ${text} ===`);
}

// Stage A: full real-bytes ground-truth suite. `just ci-real-bytes` sets its
// own corpus-root env defaults and PRE-CHECKS every root up front, so a missing
// corpus fails cleanly (nonzero) rather than passing with zero real bytes.
function runGroundTruth() {
  banner("stage A — real-bytes GROUND TRUTH (full suite, ~30-45 min)");
  const result = spawnSync("just", ["ci-real-bytes"], { cwd: repoRoot, stdio: "inherit" });
  if (result.error) {
    throw new OracleGroundTruthError(
      `failed to launch \`just ci-real-bytes\`: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new OracleGroundTruthError(
      `the real-bytes GROUND-TRUTH suite failed (exit ${result.status}). The ` +
        `source-of-truth catalogues no longer match the real bytes — the ` +
        `synthetic's coverage contract is built on those catalogues. ${REDERIVE_HINT}`,
    );
  }
  console.log("real-bytes ground-truth suite PASSED (catalogues match real bytes).");
}

// Extractor integrity: the drift diff is only trustworthy if the manifest
// extractors themselves still parse the real catalogues. Run their regression
// suite so a silent parser break can't mask a real drift as "no diff".
function runExtractorSelfTest() {
  banner("stage B.1 — manifest extractor self-test");
  const result = spawnSync(
    "node",
    ["--test", "scripts/synthetic-coverage-manifest.test.mjs"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new OracleDriftError(
      `the coverage-manifest extractor self-test failed (exit ${result.status}); ` +
        `the drift diff cannot be trusted until the extractors are fixed. ${REDERIVE_HINT}`,
    );
  }
}

// Stage B.2: re-derive the manifest from the LIVE source-of-truth catalogues
// and diff it against the committed manifest. Mirrors the CLI `--check` but
// raises an oracle-branded loud failure (with the RE-DERIVE hint) so the
// periodic run's failure is unambiguous.
export function detectDrift(root = repoRoot) {
  const { manifest: derived, json: derivedJson } = buildArtifact(root);
  const committedPath = resolve(root, OUTPUT_JSON_PATH);
  if (!existsSync(committedPath)) {
    throw new OracleDriftError(
      `committed coverage manifest missing at ${OUTPUT_JSON_PATH}. ${REDERIVE_HINT}`,
    );
  }
  const committedRaw = readFileSync(committedPath, "utf8");
  let committed;
  try {
    committed = JSON.parse(committedRaw);
  } catch (error) {
    throw new OracleDriftError(
      `committed coverage manifest is not valid JSON: ${error?.message}. ${REDERIVE_HINT}`,
    );
  }
  const { missing, extra } = diffManifests(committed, derived);
  const problems = [];
  if (missing.length > 0) {
    problems.push(
      `SYNTHETIC DROPPED BELOW REAL COVERAGE — ${missing.length} real-bytes-exercised ` +
        `component(s) the manifest no longer covers:\n      ${missing.join("\n      ")}`,
    );
  }
  if (extra.length > 0) {
    problems.push(
      `INVENTED/STALE coverage — ${extra.length} manifest component(s) the live ` +
        `sources no longer produce:\n      ${extra.join("\n      ")}`,
    );
  }
  if (committedRaw !== derivedJson && problems.length === 0) {
    problems.push(
      "committed manifest bytes differ from the re-derived manifest (metadata/formatting drift)",
    );
  }
  return { problems, missing, extra };
}

function runDriftCheck() {
  runExtractorSelfTest();
  banner("stage B.2 — SYNTHETIC-vs-REAL drift check (manifest vs live catalogues)");
  const { problems } = detectDrift(repoRoot);
  if (problems.length > 0) {
    throw new OracleDriftError(
      `synthetic/real DRIFT DETECTED:\n  - ${problems.join("\n  - ")}\n\n${REDERIVE_HINT}`,
    );
  }
  console.log(
    "drift check PASSED: synthetic coverage manifest still matches 100% of the " +
      "real-bytes-exercised components.",
  );

  // Forward-compat hook: when the differential-validation node lands its
  // synthetic-vs-real archive validator, run it here too (guarded on existence
  // so this oracle degrades gracefully until then).
  const diffvalPath = resolve(repoRoot, "scripts/synthetic-differential-validation.mjs");
  if (existsSync(diffvalPath)) {
    banner("stage B.3 — synthetic differential validation");
    const result = spawnSync("node", [diffvalPath, "--check"], { cwd: repoRoot, stdio: "inherit" });
    if (result.status !== 0) {
      throw new OracleDriftError(
        `synthetic differential validation failed (exit ${result.status}). ${REDERIVE_HINT}`,
      );
    }
  }
}

function main(argv) {
  const driftOnly = argv.includes("--drift-only");
  const realOnly = argv.includes("--real-bytes-only");
  if (driftOnly && realOnly) {
    console.error("real-bytes-oracle: --drift-only and --real-bytes-only are mutually exclusive");
    process.exit(2);
  }

  banner(
    driftOnly
      ? "PERIODIC oracle — DRIFT-ONLY (no corpora required)"
      : realOnly
        ? "PERIODIC oracle — GROUND-TRUTH-ONLY"
        : "PERIODIC oracle — GROUND TRUTH + DRIFT (full)",
  );
  console.log(
    "NOT part of per-gate qd-full-ci; nightly cron + on-demand only. " +
      "A red run means the synthetic drifted from reality — re-derive it.",
  );

  try {
    if (!driftOnly) runGroundTruth();
    if (!realOnly) runDriftCheck();
  } catch (error) {
    if (error instanceof OracleGroundTruthError || error instanceof OracleDriftError) {
      console.error(`\nreal-bytes-oracle FAILED (${error.name}):\n  ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  banner("PASSED — real bytes are still ground truth and the synthetic matches");
}

function invokedAsMain() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (invokedAsMain()) {
  main(process.argv.slice(2));
}
