#!/usr/bin/env node
/*
 * ALPHA-005 — Alpha localization-project readiness checklist.
 *
 * The FINAL alpha-milestone gate: it proves the repository is ready to START a
 * first real localization project (catalog -> inventory -> extraction ->
 * localization -> patching -> validation), NOT that localization is a finished
 * product.
 *
 * This command is evidence-first: every claim in the readiness docs is
 * re-derived from a GENERATED / committed artifact and compared byte-for-byte,
 * so the docs cannot silently drift from the real capability surface. It never
 * asserts a hand-maintained success string.
 *
 * Generated / committed artifacts it validates against:
 *   1. apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.json
 *      (ALPHA-004 generated capability matrix; drift-guarded by
 *      `scripts/generate-engine-capability-matrix.mjs --check`). The readiness
 *      doc's capability + exclusion claim blocks must EXACTLY equal the block
 *      re-derived from this matrix.
 *   2. fixtures/alpha-vertical-proof/hello-game-alpha-proof-v0.2.fr-FR.json
 *      (SHARED-025 alpha vertical proof manifest) + the committed artifact
 *      fixtures it references (bridge / patchExport / patchResult / deltaPackage
 *      / runtimeReport / provider proof / benchmark report). Every referenced
 *      artifact must exist and its sha256 must match the manifest.
 *   3. roadmap/spec-dag.json — the required node references must resolve to real
 *      nodes and be cited in the readiness doc.
 *
 * Checks:
 *   A. Node references (KAIFUU-042, ALPHA-006, ALPHA-007, ALPHA-008,
 *      ITOTORI-116, ITOTORI-117, UTSUSHI-119, SHARED-025, UNIV-013, SHARED-013,
 *      SHARED-014, UNIV-021) resolve in the DAG AND are cited in the readiness
 *      doc.
 *   B. Capability + exclusion claim blocks in the readiness doc match the block
 *      re-derived from the generated capability matrix (docs-can't-drift).
 *   C. Patched-output runtime proof: the SHARED-025 manifest links a PatchResult
 *      AND a runtime report for the SAME source bridge + bundle hash, every
 *      referenced artifact hash matches its committed fixture, and a provider
 *      proof + benchmark report are present — i.e. UTSUSHI-119's contract
 *      (runtime observation consumes PatchResult + SHARED-025 manifest ids for
 *      patched-output proof, not a static/pre-patch read) is grounded.
 *   D. Fresh-clone public-fixture demo command exists in the justfile and is
 *      public-fixture-only (no live/secret env in the recipe body).
 *
 * Usage:
 *   node scripts/alpha-readiness-checklist.mjs            # run the checklist
 *   node scripts/alpha-readiness-checklist.mjs --print-claims
 *        # print the canonical capability/exclusion doc blocks (source of the
 *        # committed readiness-doc claim blocks; regenerate the doc from here)
 */
"use strict";

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..");

export const CAPABILITY_MATRIX_PATH =
  "apps/itotori/src/engine-capability/engine-capability-matrix.v0.1.json";
export const ALPHA_PROOF_MANIFEST_PATH =
  "fixtures/alpha-vertical-proof/hello-game-alpha-proof-v0.2.fr-FR.json";
export const READINESS_DOC_PATH = "docs/alpha-readiness.md";
export const JUSTFILE_PATH = "justfile";
export const SPEC_DAG_PATH = "roadmap/spec-dag.json";

// The fresh-clone public-fixture demo command. Public-fixture-only, deterministic,
// no DB / creds / private corpora.
export const DEMO_RECIPE = "alpha-demo";

// Required node references the readiness gate must validate.
export const REQUIRED_NODE_REFS = [
  "KAIFUU-042",
  "ALPHA-006",
  "ALPHA-007",
  "ALPHA-008",
  "ITOTORI-116",
  "ITOTORI-117",
  "UTSUSHI-119",
  "SHARED-025",
  "UNIV-013",
  "SHARED-013",
  "SHARED-014",
  "UNIV-021",
];

// Marker fences that delimit the machine-checked claim blocks in the readiness
// doc. The content between the markers is re-derived and compared exactly.
const CAPABILITY_MARKER = "ALPHA-READINESS-CAPABILITY-CLAIMS";
const EXCLUSION_MARKER = "ALPHA-READINESS-EXCLUSION-CLAIMS";

function readJson(relPath) {
  return JSON.parse(readFileSync(resolve(repoRoot, relPath), "utf8"));
}

function sha256OfFile(relPath) {
  return `sha256:${createHash("sha256")
    .update(readFileSync(resolve(repoRoot, relPath)))
    .digest("hex")}`;
}

/**
 * Derive the per-family capability posture from the generated matrix. A family
 * is `positive_adapter` if ANY of its rows carries that posture, else
 * `readiness_only`. Families are sorted for a deterministic block.
 */
export function deriveCapabilityClaims(matrix) {
  const byFamily = new Map();
  for (const row of matrix.rows) {
    const prior = byFamily.get(row.engineFamily);
    const posture =
      prior === "positive_adapter" || row.evidencePosture === "positive_adapter"
        ? "positive_adapter"
        : "readiness_only";
    byFamily.set(row.engineFamily, posture);
  }
  return [...byFamily.entries()]
    .map(([engineFamily, posture]) => ({ engineFamily, posture }))
    .sort((a, b) => a.engineFamily.localeCompare(b.engineFamily));
}

export function deriveExclusionClaims(matrix) {
  return matrix.exclusions
    .map((e) => (typeof e === "string" ? e : (e.engineFamily ?? e.id)))
    .sort((a, b) => a.localeCompare(b));
}

/** Render the canonical capability claim block (between the markers). */
export function renderCapabilityBlock(matrix) {
  const claims = deriveCapabilityClaims(matrix);
  const lines = [
    `<!-- ${CAPABILITY_MARKER}:START -->`,
    `<!-- generated from ${CAPABILITY_MATRIX_PATH}; edit that generator, not this block -->`,
    `Engine families in the generated capability matrix: **${claims.length}**.`,
    "",
    "| engine family | evidence posture |",
    "| --- | --- |",
    ...claims.map((c) => `| \`${c.engineFamily}\` | ${c.posture} |`),
    `<!-- ${CAPABILITY_MARKER}:END -->`,
  ];
  return lines.join("\n");
}

/** Render the canonical exclusion claim block (between the markers). */
export function renderExclusionBlock(matrix) {
  const exclusions = deriveExclusionClaims(matrix);
  const lines = [
    `<!-- ${EXCLUSION_MARKER}:START -->`,
    `<!-- generated from ${CAPABILITY_MATRIX_PATH}; edit that generator, not this block -->`,
    `Engine families explicitly EXCLUDED from the capability breadth: **${exclusions.length}**.`,
    "",
    ...exclusions.map((e) => `- \`${e}\``),
    `<!-- ${EXCLUSION_MARKER}:END -->`,
  ];
  return lines.join("\n");
}

function extractBlock(docText, marker) {
  const start = `<!-- ${marker}:START -->`;
  const end = `<!-- ${marker}:END -->`;
  const startIdx = docText.indexOf(start);
  const endIdx = docText.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return null;
  return docText.slice(startIdx, endIdx + end.length);
}

/**
 * Normalize a claim block for comparison so that a markdown formatter's table
 * column padding, alignment-dash width, and blank-line reflow do NOT count as
 * drift — while a real content change (family added/removed, posture flipped,
 * count changed) still does. Content, not whitespace, is what is compared.
 */
export function normalizeBlock(text) {
  return text
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/-{2,}/gu, "-").replace(/\s+/gu, " "))
    .join("\n");
}

/**
 * Run the full readiness checklist. Returns `{ ok, findings }` where each
 * finding is `{ check, severity, message }`. A `blocking` finding fails the gate.
 */
export function runChecklist() {
  const findings = [];
  const fail = (check, message) => findings.push({ check, severity: "blocking", message });
  const pass = (check, message) => findings.push({ check, severity: "info", message });

  const matrix = readJson(CAPABILITY_MATRIX_PATH);
  const specDag = readJson(SPEC_DAG_PATH);
  const nodesById = new Map((specDag.nodes ?? []).map((n) => [n.id, n]));
  const docExists = existsSync(resolve(repoRoot, READINESS_DOC_PATH));
  const docText = docExists ? readFileSync(resolve(repoRoot, READINESS_DOC_PATH), "utf8") : "";

  if (!docExists) {
    fail("readiness-doc", `${READINESS_DOC_PATH} is missing`);
  }

  // Check A — node references resolve in the DAG and are cited in the doc.
  for (const id of REQUIRED_NODE_REFS) {
    const node = nodesById.get(id);
    if (!node) {
      fail("node-ref", `required node reference ${id} does not resolve in ${SPEC_DAG_PATH}`);
      continue;
    }
    if (docExists && !docText.includes(id)) {
      fail("node-ref", `required node reference ${id} is not cited in ${READINESS_DOC_PATH}`);
      continue;
    }
    pass("node-ref", `${id} resolves in DAG [${node.status}] and is cited in the readiness doc`);
  }

  // Check B — capability + exclusion claim blocks match the generated matrix.
  if (docExists) {
    const expectedCap = normalizeBlock(renderCapabilityBlock(matrix));
    const rawCap = extractBlock(docText, CAPABILITY_MARKER);
    const actualCap = rawCap === null ? null : normalizeBlock(rawCap);
    if (actualCap === null) {
      fail("capability-claims", `no ${CAPABILITY_MARKER} block found in ${READINESS_DOC_PATH}`);
    } else if (actualCap !== expectedCap) {
      fail(
        "capability-claims",
        `capability claim block in ${READINESS_DOC_PATH} drifted from ${CAPABILITY_MATRIX_PATH}; regenerate with \`node scripts/alpha-readiness-checklist.mjs --print-claims\``,
      );
    } else {
      pass(
        "capability-claims",
        `capability claim block matches ${deriveCapabilityClaims(matrix).length} generated engine families`,
      );
    }

    const expectedExc = normalizeBlock(renderExclusionBlock(matrix));
    const rawExc = extractBlock(docText, EXCLUSION_MARKER);
    const actualExc = rawExc === null ? null : normalizeBlock(rawExc);
    if (actualExc === null) {
      fail("exclusion-claims", `no ${EXCLUSION_MARKER} block found in ${READINESS_DOC_PATH}`);
    } else if (actualExc !== expectedExc) {
      fail(
        "exclusion-claims",
        `exclusion claim block in ${READINESS_DOC_PATH} drifted from ${CAPABILITY_MATRIX_PATH}; regenerate with \`node scripts/alpha-readiness-checklist.mjs --print-claims\``,
      );
    } else {
      pass(
        "exclusion-claims",
        `exclusion claim block matches ${deriveExclusionClaims(matrix).join(", ")}`,
      );
    }
  }

  // Check C — patched-output runtime proof grounded in committed artifacts.
  const manifest = readJson(ALPHA_PROOF_MANIFEST_PATH);
  const refs = manifest.artifactRefs ?? {};
  const patchResult = refs.patchResult;
  const runtimeReport = refs.runtimeReport;

  if (!manifest.proofManifestId) {
    fail("patched-output-proof", `${ALPHA_PROOF_MANIFEST_PATH} has no proofManifestId`);
  }
  if (!patchResult || patchResult.artifactKind !== "patch_result") {
    fail(
      "patched-output-proof",
      `SHARED-025 manifest is missing a patch_result artifact ref (UTSUSHI-119 must consume a PatchResult)`,
    );
  }
  if (!runtimeReport || runtimeReport.artifactKind !== "runtime_report") {
    fail(
      "patched-output-proof",
      `SHARED-025 manifest is missing a runtime_report artifact ref (patched-output runtime proof)`,
    );
  }

  // Every referenced artifact must exist and its sha256 must match the manifest.
  const hashRefs = { ...refs };
  for (const bench of manifest.benchmarkOutputRefs ?? []) {
    if (bench.artifactRef) hashRefs[`benchmark:${bench.benchmarkRunId}`] = bench.artifactRef;
  }
  for (const [role, ref] of Object.entries(hashRefs)) {
    if (!ref?.uri || !ref?.hash) continue;
    if (!existsSync(resolve(repoRoot, ref.uri))) {
      fail("patched-output-proof", `manifest artifact ${role} (${ref.uri}) is missing on disk`);
      continue;
    }
    const actual = sha256OfFile(ref.uri);
    if (actual !== ref.hash) {
      fail(
        "patched-output-proof",
        `manifest artifact ${role} (${ref.uri}) hash ${actual} != manifest ${ref.hash}`,
      );
    }
  }

  // The runtime report must observe the SAME source the patch/manifest describes
  // (not a static/pre-patch read against a different revision).
  if (runtimeReport?.uri && existsSync(resolve(repoRoot, runtimeReport.uri))) {
    const rr = readJson(runtimeReport.uri);
    if (rr.sourceBridgeId !== manifest.sourceBridgeId) {
      fail(
        "patched-output-proof",
        `runtime report sourceBridgeId ${rr.sourceBridgeId} != manifest ${manifest.sourceBridgeId}`,
      );
    }
    if (rr.sourceBundleHash !== manifest.sourceBundleHash) {
      fail(
        "patched-output-proof",
        `runtime report sourceBundleHash != manifest (mismatched source revision)`,
      );
    }
  }

  if (!(manifest.providerProofIds ?? []).length) {
    fail("patched-output-proof", `SHARED-025 manifest records no providerProofIds`);
  }
  if (!(manifest.benchmarkOutputRefs ?? []).length) {
    fail("patched-output-proof", `SHARED-025 manifest records no benchmarkOutputRefs`);
  }
  if (!findings.some((f) => f.check === "patched-output-proof" && f.severity === "blocking")) {
    pass(
      "patched-output-proof",
      `UTSUSHI-119 patched-output proof grounded: manifest ${manifest.proofManifestId} links PatchResult ${patchResult.artifactId} + runtime report ${runtimeReport.artifactId} on the same source revision (all artifact hashes verified)`,
    );
  }

  // Check D — fresh-clone public-fixture demo command exists and is public-only.
  const justfile = readFileSync(resolve(repoRoot, JUSTFILE_PATH), "utf8");
  const recipeRe = new RegExp(`^${DEMO_RECIPE}(?:\\s+\\S+)?:.*$`, "mu");
  const recipeMatch = justfile.match(recipeRe);
  if (!recipeMatch) {
    fail(
      "demo-command",
      `justfile has no \`${DEMO_RECIPE}\` recipe (fresh-clone public-fixture demo)`,
    );
  } else {
    // Grab the recipe body (indented lines following the header).
    const bodyStart = justfile.indexOf(recipeMatch[0]) + recipeMatch[0].length;
    const rest = justfile.slice(bodyStart).split("\n");
    const body = [];
    for (const line of rest) {
      if (line.startsWith("    ") || line.trim() === "") {
        if (line.trim() !== "") body.push(line);
      } else break;
    }
    const bodyText = body.join("\n");
    const forbidden =
      /OPENROUTER_API_KEY|ITOTORI_LIVE|--live|ITOTORI_REAL_GAME_ROOT|DATABASE_URL|db-up/u;
    if (forbidden.test(bodyText)) {
      fail(
        "demo-command",
        `\`${DEMO_RECIPE}\` recipe references live creds / real bytes / DB; the fresh-clone demo must be public-fixture-only`,
      );
    } else {
      pass("demo-command", `\`just ${DEMO_RECIPE}\` is a public-fixture-only fresh-clone demo`);
    }
  }

  const ok = !findings.some((f) => f.severity === "blocking");
  return { ok, findings };
}

function main(argv) {
  if (argv.includes("--print-claims")) {
    const matrix = readJson(CAPABILITY_MATRIX_PATH);
    process.stdout.write(`${renderCapabilityBlock(matrix)}\n\n${renderExclusionBlock(matrix)}\n`);
    return 0;
  }
  const { ok, findings } = runChecklist();
  for (const f of findings) {
    const tag = f.severity === "blocking" ? "FAIL" : "ok";
    process.stdout.write(`[alpha-readiness] [${tag}] ${f.check}: ${f.message}\n`);
  }
  if (!ok) {
    const n = findings.filter((f) => f.severity === "blocking").length;
    process.stderr.write(`[alpha-readiness] FAILED: ${n} blocking finding(s)\n`);
    return 1;
  }
  process.stdout.write("[alpha-readiness] PASS: alpha readiness checklist green\n");
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

export { main };
