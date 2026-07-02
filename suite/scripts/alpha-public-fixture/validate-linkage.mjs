#!/usr/bin/env node
/*
 * ALPHA-007 — `pnpm exec vp run alpha:public-fixture-validate`
 *
 * Independent artifact-linkage validator. Re-reads the emitted public fixture
 * vertical artifacts and PROVES linkage from the artifacts themselves — it
 * never trusts a success string. It re-checks, for every emitted artifact:
 *   - schema validity (Ajv 2020),
 *   - hash-addressing (sha256 of the file == the hash recorded in the manifest),
 *   - cross-artifact linkage (same fixture id, source revision, locale branch,
 *     content hash) across bridge, patch, provider proof, benchmark, runtime
 *     observation, dashboard/read-model, and the SHARED-025 manifest record.
 *
 * Exit 0 when the vertical is fully linked; exit 1 with structured findings.
 */
"use strict";

import { existsSync, readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { schemaErrors } from "./schema-validate.mjs";
import {
  REPO_ROOT,
  assertRuntimeProofIsRealRun,
  loadVerticalInputs,
  sha256OfBytes,
  validateLinkage,
} from "./vertical.mjs";

const DEFAULT_DIR = join(REPO_ROOT, "artifacts", "alpha", "public-fixture");

const EMITTED = [
  { role: "runtime-observation-proof", filename: "runtime-observation-proof.json" },
  { role: "provider-proof", filename: "provider-proof.json" },
  { role: "benchmark-report", filename: "benchmark-report.json" },
  { role: "read-model-ingestion", filename: "read-model-ingestion.json" },
  { role: "shared-025-manifest-linkage", filename: "shared-025-manifest-linkage.json" },
];

function finding(code, severity, subject, message) {
  return { code, severity, subject, message };
}

/**
 * Validate an emitted artifact directory. Returns { verdict, findings }.
 * Pure (reads disk, no writes), so tests can call it directly.
 */
export function validateEmittedDir(dir) {
  const findings = [];

  const manifestPath = join(dir, "vertical-manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      verdict: "broken",
      findings: [
        finding(
          "validator.manifest_missing",
          "blocking",
          "vertical-manifest.json",
          `vertical manifest not found at ${manifestPath}; run \`vp run alpha:public-fixture\` first`,
        ),
      ],
    };
  }
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  for (const e of schemaErrors("vertical-manifest", manifest)) {
    findings.push(finding("validator.schema_invalid", "blocking", "vertical-manifest.json", e));
  }

  // Re-read each emitted artifact; check existence, schema, and hash-addressing.
  const byRole = new Map((manifest.emittedArtifacts ?? []).map((x) => [x.role, x]));
  let linkage;
  let runtimeObservationProof;
  for (const { role, filename } of EMITTED) {
    const path = join(dir, filename);
    if (!existsSync(path)) {
      findings.push(
        finding(
          "validator.artifact_missing",
          "blocking",
          filename,
          `emitted artifact missing: ${filename}`,
        ),
      );
      continue;
    }
    const bytes = readFileSync(path);
    const value = JSON.parse(bytes.toString("utf8"));
    if (role === "shared-025-manifest-linkage") linkage = value;
    if (role === "runtime-observation-proof") runtimeObservationProof = value;

    // Hash-addressing: the manifest must record this file's exact content hash.
    const recorded = byRole.get(role);
    const actualHash = sha256OfBytes(bytes);
    if (recorded === undefined) {
      findings.push(
        finding(
          "validator.artifact_unlisted",
          "blocking",
          filename,
          `manifest does not list emitted artifact '${role}'`,
        ),
      );
    } else if (recorded.hash !== actualHash) {
      findings.push(
        finding(
          "validator.hash_mismatch",
          "blocking",
          filename,
          `manifest recorded hash ${recorded.hash} but file content hash is ${actualHash}`,
        ),
      );
    }

    // Schema validity (benchmark-report envelope is gated by producedBy below).
    if (role !== "benchmark-report") {
      for (const e of schemaErrors(role, value)) {
        findings.push(finding("validator.schema_invalid", "blocking", filename, e));
      }
    } else if (value.producedBy !== "ITOTORI-026") {
      findings.push(
        finding(
          "benchmark.placeholder",
          "blocking",
          filename,
          `benchmark-report.json producedBy='${value.producedBy}' (expected ITOTORI-026; placeholder files are rejected)`,
        ),
      );
    }
  }

  // Re-EXECUTE the runtime observation from the public fixture bytes and REJECT
  // the emitted proof unless its renderHash reproduces a genuine, localized,
  // span-preserving run. This is the independent artifact-bytes proof: the
  // validator re-renders the patch over the source instead of trusting the
  // emitted (or any checked-in) runtime report.
  if (runtimeObservationProof !== undefined && linkage?.sharedManifest?.uri) {
    try {
      const inputs = loadVerticalInputs({ proofManifestPath: linkage.sharedManifest.uri });
      findings.push(...inputs.hashFindings);
      const { findings: guardFindings } = assertRuntimeProofIsRealRun(runtimeObservationProof, {
        bridge: inputs.loadedArtifacts.bridgeBundle,
        patchExport: inputs.loadedArtifacts.patchExport,
        runtimeSceneLog: inputs.loadedArtifacts.runtimeReport,
        proof: inputs.proof,
      });
      findings.push(...guardFindings);
    } catch (error) {
      findings.push(
        finding(
          "validator.runtime_reexecution_failed",
          "blocking",
          "runtime-observation-proof.json",
          `could not re-execute the runtime observation from public fixtures: ${error.message}`,
        ),
      );
    }
  }

  // Re-prove cross-artifact linkage from the linkage record itself.
  if (linkage !== undefined) {
    const { findings: linkFindings } = validateLinkage(linkage);
    findings.push(...linkFindings);
  } else {
    findings.push(
      finding(
        "validator.linkage_missing",
        "blocking",
        "shared-025-manifest-linkage.json",
        "linkage record could not be read; cannot prove artifact linkage",
      ),
    );
  }

  const blocking = findings.filter((f) => f.severity === "blocking");
  return { verdict: blocking.length === 0 ? "linked" : "broken", findings };
}

function main() {
  const argv = process.argv.slice(2);
  let dir = DEFAULT_DIR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--dir requires a value");
      dir = resolvePath(v);
    } else if (argv[i] === "-h" || argv[i] === "--help") {
      process.stdout.write(
        "usage: node suite/scripts/alpha-public-fixture/validate-linkage.mjs [--dir <PATH>]\n",
      );
      return 0;
    } else {
      throw new Error(`unknown flag: ${argv[i]}`);
    }
  }
  const { verdict, findings } = validateEmittedDir(dir);
  for (const f of findings) {
    process.stdout.write(
      `[alpha:public-fixture-validate] [${f.severity}] ${f.code} (${f.subject}): ${f.message}\n`,
    );
  }
  process.stdout.write(
    `[alpha:public-fixture-validate] verdict=${verdict} findings=${findings.length}\n`,
  );
  return verdict === "linked" ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`[alpha:public-fixture-validate] FAILED: ${error.message}\n`);
    process.exit(1);
  }
}
