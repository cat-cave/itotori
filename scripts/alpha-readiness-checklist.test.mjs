import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  ALPHA_PROOF_MANIFEST_PATH,
  CAPABILITY_MATRIX_PATH,
  DEMO_RECIPE,
  JUSTFILE_PATH,
  READINESS_DOC_PATH,
  REQUIRED_NODE_REFS,
  collectReachableRecipes,
  deriveCapabilityClaims,
  deriveExclusionClaims,
  normalizeBlock,
  parseJustfileRecipes,
  renderCapabilityBlock,
  renderExclusionBlock,
  repoRoot,
  runChecklist,
  scanDemoRecipeChain,
} from "./alpha-readiness-checklist.mjs";

const matrix = JSON.parse(readFileSync(resolve(repoRoot, CAPABILITY_MATRIX_PATH), "utf8"));
const docText = readFileSync(resolve(repoRoot, READINESS_DOC_PATH), "utf8");
const CAPABILITY_MARKER = "ALPHA-READINESS-CAPABILITY-CLAIMS";
const CAPABILITY_START = `<!-- ${CAPABILITY_MARKER}:START -->`;
const CAPABILITY_END = `<!-- ${CAPABILITY_MARKER}:END -->`;

function replaceCapabilityBlock(readinessDocText, replacementBlock) {
  const startIdx = readinessDocText.indexOf(CAPABILITY_START);
  const endIdx = readinessDocText.indexOf(CAPABILITY_END);
  assert.notEqual(startIdx, -1, "readiness doc should contain capability-claim start marker");
  assert.notEqual(endIdx, -1, "readiness doc should contain capability-claim end marker");
  assert.ok(endIdx > startIdx, "readiness doc capability-claim markers should be ordered");
  return [
    readinessDocText.slice(0, startIdx),
    replacementBlock,
    readinessDocText.slice(endIdx + CAPABILITY_END.length),
  ].join("");
}

function copyRepoFile(root, relPath) {
  const dest = join(root, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(resolve(repoRoot, relPath), dest);
}

function createChecklistFixture(readinessDocText) {
  const root = mkdtempSync(join(tmpdir(), "alpha-readiness-checklist-"));
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, ALPHA_PROOF_MANIFEST_PATH), "utf8"));
  const artifactPaths = new Set(
    [
      ...Object.values(manifest.artifactRefs ?? {}).map((ref) => ref?.uri),
      ...(manifest.benchmarkOutputRefs ?? []).map((bench) => bench.artifactRef?.uri),
    ].filter(Boolean),
  );

  for (const relPath of [
    "scripts/alpha-readiness-checklist.mjs",
    CAPABILITY_MATRIX_PATH,
    ALPHA_PROOF_MANIFEST_PATH,
    "roadmap/spec-dag.json",
    JUSTFILE_PATH,
    ...artifactPaths,
  ]) {
    copyRepoFile(root, relPath);
  }

  const readinessDocPath = join(root, READINESS_DOC_PATH);
  mkdirSync(dirname(readinessDocPath), { recursive: true });
  writeFileSync(readinessDocPath, readinessDocText);
  return root;
}

function runChecklistInFixture(readinessDocText) {
  const root = createChecklistFixture(readinessDocText);
  try {
    return spawnSync(process.execPath, [join(root, "scripts/alpha-readiness-checklist.mjs")], {
      cwd: root,
      encoding: "utf8",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function renderPaddingReflowedCapabilityBlock() {
  return renderCapabilityBlock(matrix)
    .split("\n")
    .map((line) => {
      if (line === "| engine family | evidence posture |") {
        return "| engine family              | evidence posture   |";
      }
      if (line === "| --- | --- |") {
        return "| -------------------------- | ------------------ |";
      }
      if (line.startsWith("| `")) {
        return line.replace(" | ", "        |     ");
      }
      return line;
    })
    .join("\n")
    .replace("\n| engine family", "\n\n| engine family");
}

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

// --- Check D: transitive demo-recipe forbidden-token scan (not vacuous) ---

test("Check D walks the transitive demo dependency chain, not just the (empty) demo body", () => {
  const justfile = readFileSync(resolve(repoRoot, JUSTFILE_PATH), "utf8");
  const recipes = parseJustfileRecipes(justfile);
  // The real `alpha-demo` recipe delegates and has an EMPTY inline body...
  assert.equal(recipes.get(DEMO_RECIPE).body.trim(), "");
  // ...but it declares `alpha-proof` as a dependency, which carries the real body.
  assert.ok(recipes.get(DEMO_RECIPE).deps.includes("alpha-proof"));
  const scan = scanDemoRecipeChain(justfile, DEMO_RECIPE);
  assert.equal(scan.missing, false);
  // The scan reaches beyond the empty demo body into alpha-proof (and any deeper
  // deps) — proving it is not vacuous.
  assert.ok(scan.scanned.includes(DEMO_RECIPE));
  assert.ok(
    scan.scanned.includes("alpha-proof"),
    `expected the transitive chain to include alpha-proof, got ${scan.scanned.join(", ")}`,
  );
  assert.ok(scan.scanned.length >= 2);
  // The real chain is clean.
  assert.deepEqual(scan.offenders, []);
});

test("Check D CATCHES a forbidden token planted in a transitively-reached recipe (not vacuous)", () => {
  // Demo delegates to alpha-proof, whose body is where a real secret would hide.
  // Prior (vacuous) scan read only the empty `alpha-demo` body and would MISS this.
  const justfile = [
    "alpha-demo: alpha-proof",
    "",
    "alpha-proof: inner-step",
    "    pnpm exec vp run alpha:public-fixture",
    "",
    "inner-step:",
    "    OPENROUTER_API_KEY=$SECRET node run.mjs --live",
    "",
  ].join("\n");

  // Sanity: the demo body itself is empty — a body-only scan would pass vacuously.
  assert.equal(parseJustfileRecipes(justfile).get("alpha-demo").body.trim(), "");

  const scan = scanDemoRecipeChain(justfile, "alpha-demo");
  assert.equal(scan.missing, false);
  assert.ok(
    scan.scanned.includes("inner-step"),
    "the transitive walk must reach the delegated-to recipe",
  );
  const offenders = scan.offenders.map((o) => `${o.recipe}:${o.token}`);
  assert.ok(
    offenders.includes("inner-step:OPENROUTER_API_KEY"),
    `expected OPENROUTER_API_KEY caught in inner-step, got ${offenders.join(", ")}`,
  );
  assert.ok(
    offenders.includes("inner-step:--live"),
    `expected --live caught in inner-step, got ${offenders.join(", ")}`,
  );
});

test("Check D passes a clean transitive chain and reports a missing root", () => {
  const clean = [
    "alpha-demo: alpha-proof",
    "",
    "alpha-proof:",
    "    pnpm exec vp run alpha:public-fixture",
    "    pnpm exec vp run alpha:public-fixture-validate",
    "",
  ].join("\n");
  const scan = scanDemoRecipeChain(clean, "alpha-demo");
  assert.equal(scan.missing, false);
  assert.deepEqual(scan.offenders, []);
  assert.deepEqual(scan.scanned, ["alpha-demo", "alpha-proof"]);

  const missing = scanDemoRecipeChain("some-other:\n    echo hi\n", "alpha-demo");
  assert.equal(missing.missing, true);
});

test("collectReachableRecipes is the transitive closure and does not loop on cycles", () => {
  const cyclic = ["a: b", "", "b: a c", "    echo b", "", "c:", "    echo c"].join("\n");
  const order = collectReachableRecipes(cyclic, "a");
  const names = order.map((r) => r.name).sort();
  assert.deepEqual(names, ["a", "b", "c"]);
});

test("parseJustfileRecipes ignores `:=` assignments and comments", () => {
  const jf = ['export FOO := "bar"', "# a comment: not a recipe", "real:", "    echo hi"].join(
    "\n",
  );
  const recipes = parseJustfileRecipes(jf);
  assert.ok(recipes.has("real"));
  assert.equal(recipes.has("FOO"), false);
  assert.equal(recipes.has("export"), false);
});

test("the real repo demo chain passes Check D (no real forbidden tokens)", () => {
  const { findings } = runChecklist();
  const d = findings.filter((f) => f.check === "demo-command");
  assert.ok(d.length > 0, "expected a demo-command finding");
  assert.equal(
    d.some((f) => f.severity === "blocking"),
    false,
    `Check D unexpectedly failed:\n${d.map((f) => f.message).join("\n")}`,
  );
});

test("a drifted capability claim block fails the gate", () => {
  const reflowedBlock = renderPaddingReflowedCapabilityBlock();
  assert.equal(
    normalizeBlock(reflowedBlock),
    normalizeBlock(renderCapabilityBlock(matrix)),
    "padding-only table reflow should normalize to the canonical capability block",
  );
  const paddingOnly = runChecklistInFixture(replaceCapabilityBlock(docText, reflowedBlock));
  assert.equal(
    paddingOnly.status,
    0,
    `padding-only capability block reflow should pass\nstdout:\n${paddingOnly.stdout}\nstderr:\n${paddingOnly.stderr}`,
  );

  const capabilityClaimCount = deriveCapabilityClaims(matrix).length;
  const driftedBlock = renderCapabilityBlock(matrix)
    .replace(
      `Engine families in the generated capability matrix: **${capabilityClaimCount}**.`,
      `Engine families in the generated capability matrix: **${capabilityClaimCount - 1}**.`,
    )
    .replace(
      "| `synthetic_fixture` | positive_adapter |",
      "| `synthetic_fixture` | readiness_only |",
    );
  assert.notEqual(
    normalizeBlock(driftedBlock),
    normalizeBlock(renderCapabilityBlock(matrix)),
    "mutated count/posture should be real capability-claim drift",
  );

  const drifted = runChecklistInFixture(replaceCapabilityBlock(docText, driftedBlock));
  assert.notEqual(
    drifted.status,
    0,
    `drifted capability block should fail the checklist gate\nstdout:\n${drifted.stdout}\nstderr:\n${drifted.stderr}`,
  );
  assert.match(drifted.stdout, /\[alpha-readiness\] \[FAIL\] capability-claims:/u);
  assert.match(drifted.stderr, /\[alpha-readiness\] FAILED: \d+ blocking finding\(s\)/u);
});
