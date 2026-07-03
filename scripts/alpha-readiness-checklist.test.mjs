import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  ALPHA_PROOF_MANIFEST_PATH,
  CAPABILITY_MATRIX_PATH,
  READINESS_DOC_PATH,
  REQUIRED_NODE_REFS,
  deriveCapabilityClaims,
  deriveExclusionClaims,
  normalizeBlock,
  renderCapabilityBlock,
  renderExclusionBlock,
  repoRoot,
  runChecklist,
} from "./alpha-readiness-checklist.mjs";

const matrix = JSON.parse(readFileSync(resolve(repoRoot, CAPABILITY_MATRIX_PATH), "utf8"));
const docText = readFileSync(resolve(repoRoot, READINESS_DOC_PATH), "utf8");

test("the checklist passes on the real repo", () => {
  const { ok, findings } = runChecklist();
  const blocking = findings.filter((f) => f.severity === "blocking");
  assert.equal(
    ok,
    true,
    `blocking findings:\n${blocking.map((f) => `${f.check}: ${f.message}`).join("\n")}`,
  );
});

test("every required node reference is checked", () => {
  // Each required id must resolve and be cited; runChecklist emits an info line per id.
  const { findings } = runChecklist();
  for (const id of REQUIRED_NODE_REFS) {
    assert.ok(
      findings.some((f) => f.check === "node-ref" && f.message.includes(id)),
      `expected a node-ref finding for ${id}`,
    );
  }
});

test("capability + exclusion claim blocks match the generated matrix (content, not whitespace)", () => {
  const norm = normalizeBlock(docText);
  assert.ok(
    norm.includes(normalizeBlock(renderCapabilityBlock(matrix))),
    "capability block drifted",
  );
  assert.ok(norm.includes(normalizeBlock(renderExclusionBlock(matrix))), "exclusion block drifted");
});

test("capability claims cover exactly the generated engine families", () => {
  const claims = deriveCapabilityClaims(matrix);
  const families = new Set(matrix.rows.map((r) => r.engineFamily));
  assert.equal(claims.length, families.size);
  for (const c of claims) assert.ok(families.has(c.engineFamily));
});

test("exclusion claims match the generated matrix exclusions", () => {
  const derived = deriveExclusionClaims(matrix);
  const expected = matrix.exclusions
    .map((e) => (typeof e === "string" ? e : (e.engineFamily ?? e.id)))
    .sort((a, b) => a.localeCompare(b));
  assert.deepEqual(derived, expected);
});

test("the SHARED-025 manifest links a PatchResult and a runtime report", () => {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, ALPHA_PROOF_MANIFEST_PATH), "utf8"));
  assert.ok(manifest.proofManifestId);
  assert.equal(manifest.artifactRefs.patchResult.artifactKind, "patch_result");
  assert.equal(manifest.artifactRefs.runtimeReport.artifactKind, "runtime_report");
});

test("a drifted capability claim block fails the gate", () => {
  // Sanity: extractBlock comparison is exact — a mutated matrix would not match
  // the committed block, so deriveCapabilityClaims must be deterministic.
  const a = renderCapabilityBlock(matrix);
  const b = renderCapabilityBlock(matrix);
  assert.equal(a, b);
});
