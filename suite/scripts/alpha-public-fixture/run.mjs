#!/usr/bin/env node
/*
 * ALPHA-007 — `pnpm exec vp run alpha:public-fixture`
 *
 * Durable CI proof command that runs the PUBLIC FIXTURE VERTICAL across the
 * three suite engines and the benchmark + provider surfaces, then emits a
 * hash-addressed, schema-valid, linkage-proven manifest. It COMPOSES existing
 * public-fixture artifacts — it does not re-implement any stage:
 *
 *   1. Itotori   — bridge bundle + patch export (fixture-iteration output)
 *   2. Kaifuu    — patch result + delta package
 *   3. Utsushi   — runtime report  -> runtime-observation-proof.json
 *   4. Provider  — recorded provider runs (sanitized) -> provider-proof.json
 *   5. Benchmark — ITOTORI-026 `benchmark-harness-run` -> benchmark-report.json
 *   6. SHARED-025 alpha vertical proof manifest -> shared-025-manifest-linkage.json
 *
 * Emitted under artifacts/alpha/public-fixture/:
 *   - runtime-observation-proof.json
 *   - provider-proof.json
 *   - benchmark-report.json
 *   - read-model-ingestion.json
 *   - shared-025-manifest-linkage.json
 *   - vertical-manifest.json   (ties every artifact id + emitted-file hash)
 *
 * Hard contracts:
 *   - Public fixtures ONLY (no private corpora, no live creds, no retail bytes).
 *   - Cost is read verbatim from recorded artifacts; never hardcoded.
 *   - Every anomaly is a structured finding; a broken linkage exits non-zero.
 *   - The benchmark is produced by ITOTORI-026 (not a placeholder file).
 */
"use strict";

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { assertSchemaValid } from "./schema-validate.mjs";
import {
  DEFAULT_INPUTS,
  REPO_ROOT,
  assertPublicInputPath,
  assertRuntimeProofIsRealRun,
  composeVertical,
  listPublicInputs,
  loadVerticalInputs,
  portableRelativePath,
  repoRelativePath,
  sha256OfBytes,
  validateLinkage,
  VERTICAL_MANIFEST_SCHEMA_VERSION,
} from "./vertical.mjs";

const DEFAULT_OUT_DIR = join(REPO_ROOT, "artifacts", "alpha", "public-fixture");

function usage() {
  return [
    "usage: node suite/scripts/alpha-public-fixture/run.mjs [options]",
    "",
    "Options:",
    "  --out-dir <PATH>             emitted artifact dir (default artifacts/alpha/public-fixture)",
    "  --benchmark-output-dir <P>   consume an existing ITOTORI-026 harness output dir",
    "                               instead of running the harness fresh (offline tests)",
    "  --proof-manifest <PATH>      SHARED-025 alpha proof manifest (public fixture)",
    "  --recorded-provider <PATH>   recorded provider runs fixture (public)",
    "  --now <ISO>                  fixed generatedAt timestamp (determinism)",
    "  --dry-run                    print the composition plan and exit 0; emit nothing",
    "  --list-inputs                print the public input files and exit 0",
    "  -h, --help                   print this help",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    outDir: DEFAULT_OUT_DIR,
    benchmarkOutputDir: undefined,
    proofManifestPath: DEFAULT_INPUTS.proofManifestPath,
    recordedProviderPath: DEFAULT_INPUTS.recordedProviderPath,
    now: undefined,
    dryRun: false,
    listInputs: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--out-dir":
        args.outDir = resolvePath(next());
        break;
      case "--benchmark-output-dir":
        args.benchmarkOutputDir = resolvePath(next());
        break;
      case "--proof-manifest":
        args.proofManifestPath = next();
        break;
      case "--recorded-provider":
        args.recordedProviderPath = next();
        break;
      case "--now":
        args.now = next();
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--list-inputs":
        args.listInputs = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${arg}\n\n${usage()}`);
    }
  }
  return args;
}

/** Run ITOTORI-026 `benchmark-harness-run` into a fresh output dir. */
function runBenchmarkHarness(repoRoot) {
  const cli = join(repoRoot, "apps", "itotori", "dist", "cli.js");
  if (!existsSync(cli)) {
    throw new Error(
      `alpha-public-fixture: ${repoRelativePath(cli)} is missing; run \`vp run ts:build\` first (the alpha:public-fixture task depends on it)`,
    );
  }
  const outDir = mkdtempSync(join(tmpdir(), "alpha-public-fixture-bench-"));
  process.stdout.write(
    `[alpha:public-fixture] $ node apps/itotori/dist/cli.js benchmark-harness-run --output-dir ${outDir}\n`,
  );
  const result = spawnSync("node", [cli, "benchmark-harness-run", "--output-dir", outDir], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    throw new Error(`benchmark-harness-run failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`benchmark-harness-run exited with status ${result.status}`);
  }
  return outDir;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Write an emitted artifact + return its repo-relative path and sha256. */
function emit(outDir, filename, role, value) {
  assertSchemaValidIfRegistered(role, value);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const path = join(outDir, filename);
  writeFileSync(path, bytes);
  return { role, filename, path, hash: sha256OfBytes(Buffer.from(bytes, "utf8")) };
}

function assertSchemaValidIfRegistered(role, value) {
  // benchmark-report envelope is gated by ITOTORI-026 + the manifest binding.
  if (role === "benchmark-report") return;
  assertSchemaValid(role, value);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let ownsBenchmarkDir = false;
  let benchmarkOutputDir = args.benchmarkOutputDir;

  if (args.listInputs || args.dryRun) {
    // No harness run for dry-run / list-inputs (zero side effects).
    const inputs = loadVerticalInputs({
      proofManifestPath: args.proofManifestPath,
      recordedProviderPath: args.recordedProviderPath,
    });
    for (const uri of listPublicInputs(inputs)) assertPublicInputPath(uri);
    if (args.listInputs) {
      process.stdout.write(`${listPublicInputs(inputs).join("\n")}\n`);
      return 0;
    }
    process.stdout.write("[alpha:public-fixture] --dry-run composition plan:\n");
    process.stdout.write("  inputs (public fixtures only):\n");
    for (const uri of listPublicInputs(inputs)) process.stdout.write(`    - ${uri}\n`);
    process.stdout.write("  benchmark: ITOTORI-026 benchmark-harness-run (run fresh)\n");
    process.stdout.write(
      `  emit -> ${repoRelativePath(args.outDir)}/{runtime-observation-proof,provider-proof,benchmark-report,read-model-ingestion,shared-025-manifest-linkage,vertical-manifest}.json\n`,
    );
    return 0;
  }

  try {
    if (benchmarkOutputDir === undefined) {
      benchmarkOutputDir = runBenchmarkHarness(REPO_ROOT);
      ownsBenchmarkDir = true;
    }

    const inputs = loadVerticalInputs({
      proofManifestPath: args.proofManifestPath,
      recordedProviderPath: args.recordedProviderPath,
      benchmarkOutputDir,
    });

    // Guard: every input must be a public fixture path.
    for (const uri of listPublicInputs(inputs)) assertPublicInputPath(uri);

    const composed = composeVertical(inputs, { now: args.now ?? new Date() });

    // Artifact-bytes guard: re-EXECUTE the fixture and REJECT the emitted
    // runtime-observation proof unless its renderHash reproduces a genuine,
    // localized, span-preserving run. A re-emitted/placeholder record cannot
    // pass (it never executes the patch over the source).
    const { findings: runtimeGuardFindings } = assertRuntimeProofIsRealRun(
      composed.runtimeObservationProof,
      {
        bridge: inputs.loadedArtifacts.bridgeBundle,
        patchExport: inputs.loadedArtifacts.patchExport,
        runtimeSceneLog: inputs.loadedArtifacts.runtimeReport,
        proof: inputs.proof,
      },
    );

    // Carry forward hash-addressing findings from input loading, the executed
    // runtime render's own findings, and the artifact-bytes guard findings.
    const { findings } = validateLinkage(composed.linkage);
    const allFindings = [
      ...inputs.hashFindings,
      ...composed.runtimeRun.findings,
      ...runtimeGuardFindings,
      ...findings,
    ];
    const blocking = allFindings.filter((f) => f.severity === "blocking");
    composed.linkage.verdict = blocking.length === 0 ? "linked" : "broken";
    composed.linkage.findings = allFindings;

    mkdirSync(args.outDir, { recursive: true });

    const emitted = [
      emit(
        args.outDir,
        "runtime-observation-proof.json",
        "runtime-observation-proof",
        composed.runtimeObservationProof,
      ),
      emit(args.outDir, "provider-proof.json", "provider-proof", composed.providerProof),
      emit(args.outDir, "benchmark-report.json", "benchmark-report", composed.benchmarkReport),
      emit(
        args.outDir,
        "read-model-ingestion.json",
        "read-model-ingestion",
        composed.readModelIngestion,
      ),
      emit(
        args.outDir,
        "shared-025-manifest-linkage.json",
        "shared-025-manifest-linkage",
        composed.linkage,
      ),
    ];

    // The vertical manifest ties every composed artifact id + emitted-file hash.
    const a = composed.linkage.artifacts;
    const verticalManifest = {
      schemaVersion: VERTICAL_MANIFEST_SCHEMA_VERSION,
      generatedAt: composed.generatedAt,
      command: "vp run alpha:public-fixture",
      fixtureId: composed.linkage.verticalFixture.fixtureId,
      sourceBridgeId: composed.linkage.verticalFixture.sourceBridgeId,
      sourceBundleHash: composed.linkage.verticalFixture.sourceBundleHash,
      targetLocale: composed.linkage.verticalFixture.targetLocale,
      sharedManifest: {
        proofManifestId: composed.linkage.sharedManifest.proofManifestId,
        uri: composed.linkage.sharedManifest.uri,
        hash: composed.linkage.sharedManifest.hash,
        providerProofIds: composed.linkage.sharedManifest.providerProofIds,
      },
      composedArtifactIds: {
        bridge: a.bridge.artifactId,
        patchExport: a.patchExport.artifactId,
        patchResult: a.patchResult.artifactId,
        deltaPackage: a.deltaPackage.artifactId,
        runtimeReport: a.runtimeObservation.artifactId,
        providerProofId: a.providerProof.providerProofId,
        benchmarkRunId: a.benchmark.benchmarkRunId,
      },
      emittedArtifacts: emitted.map((e) => ({
        role: e.role,
        path: portableRelativePath(args.outDir, e.path),
        hash: e.hash,
        ...(e.role === "benchmark-report" ? { producedBy: "ITOTORI-026" } : {}),
      })),
      verdict: composed.linkage.verdict,
      findingCount: allFindings.length,
      blockingFindingCount: blocking.length,
    };
    assertSchemaValid("vertical-manifest", verticalManifest);
    writeJson(join(args.outDir, "vertical-manifest.json"), verticalManifest);

    // Report findings as structured lines.
    for (const f of allFindings) {
      process.stdout.write(
        `[alpha:public-fixture] finding [${f.severity}] ${f.code} (${f.subject}): ${f.message}\n`,
      );
    }
    process.stdout.write(
      `[alpha:public-fixture] verdict=${composed.linkage.verdict} fixture=${verticalManifest.fixtureId} target=${verticalManifest.targetLocale} benchmarkRunId=${verticalManifest.composedArtifactIds.benchmarkRunId} providerProofId=${verticalManifest.composedArtifactIds.providerProofId} billedMicrosUsd=${composed.providerProof.billedMicrosUsd}\n`,
    );
    process.stdout.write(
      `[alpha:public-fixture] emitted ${emitted.length + 1} artifacts under ${repoRelativePath(args.outDir)}\n`,
    );

    if (composed.linkage.verdict !== "linked") {
      process.stderr.write(
        `[alpha:public-fixture] FAILED: ${blocking.length} blocking finding(s) — see ${repoRelativePath(join(args.outDir, "shared-025-manifest-linkage.json"))}\n`,
      );
      return 1;
    }
    return 0;
  } finally {
    if (ownsBenchmarkDir && benchmarkOutputDir !== undefined) {
      rmSync(benchmarkOutputDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`[alpha:public-fixture] FAILED: ${error.message}\n`);
      process.exit(1);
    });
}

export { main };
