#!/usr/bin/env node
// Lane-union guard for the DB-decoupled app vitest invocation.
//
// ci-tier1-db runs the @itotori/app vitest suite EXCLUDING the files listed
// below (their sole real-binary assertions spawn utsushi-cli, which the DB lane
// no longer downloads after the native-decoupling). Those files remain covered
// by the portable TS shards (ci-tier1-ts-public-1of2 / 2of2), where the native
// artifact IS wired in _tier1.yml.
//
// This guard PROVES the excluded file is genuinely EXECUTED under native
// wiring — not merely "mentioned somewhere":
//   1. Every DB-excluded file exists as a real test under apps/itotori/test/.
//   2. BOTH portable shard recipes run @itotori/app vitest with the
//      complementary --shard=1/2 and --shard=2/2 partition (so the file lands
//      in exactly one shard), and NEITHER excludes any DB-excluded file.
//   3. The DB recipe (ci-tier1-db) DOES exclude each listed file.
//   4. The _tier1.yml portable job actually downloads + wires the native
//      artifact (needs: [native], download-artifact, ITOTORI_*_BIN) and its
//      matrix schedules both ts-public shards.
//
// Run inside ci-tier1-db right before the excluded app vitest invocation, and
// as a static check in just check / ci-tier0-meta.
//
// Paths are overridable for mutation tests (ITOTORI_JUSTFILE_PATH /
// ITOTORI_TIER1_WORKFLOW_PATH).
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const justfilePath = process.env.ITOTORI_JUSTFILE_PATH
  ? path.resolve(process.env.ITOTORI_JUSTFILE_PATH)
  : path.join(repoRoot, "justfile");
const workflowPath = process.env.ITOTORI_TIER1_WORKFLOW_PATH
  ? path.resolve(process.env.ITOTORI_TIER1_WORKFLOW_PATH)
  : path.join(repoRoot, ".github/workflows/_tier1.yml");
const appTestDir = path.join(repoRoot, "apps/itotori/test");

// The app test files the DB lane excludes (non-DB; need the native utsushi-cli
// artifact). Each must remain executed by a portable shard under native wiring.
const dbExcludedAppTests = ["wholegame-render-validation-seam.test.ts"];

// Complementary portable shard recipes: each must use its exact --shard=N/2.
const portableShardRecipes = [
  { recipe: "ci-tier1-ts-public-1of2", requiredShard: "1/2" },
  { recipe: "ci-tier1-ts-public-2of2", requiredShard: "2/2" },
];

const dbRecipe = "ci-tier1-db";
const portableMatrixShards = ["ts-public-1of2", "ts-public-2of2"];

const justfile = await readFile(justfilePath, "utf8");
const workflow = await readFile(workflowPath, "utf8");
const problems = [];

// 1. Each excluded file must exist as a real app test.
for (const file of dbExcludedAppTests) {
  const candidate = path.join(appTestDir, file);
  try {
    await access(candidate);
  } catch {
    problems.push(
      `excluded app test ${file} not found at apps/itotori/test/${file} — the DB exclusion list is stale`,
    );
  }
}

// 2. Portable shards: complementary 1/2 + 2/2, run app vitest, do NOT exclude
//    any DB-excluded file (a file excluded from DB AND both portable shards
//    would run nowhere).
const observedShards = new Set();
for (const { recipe, requiredShard } of portableShardRecipes) {
  const body = extractRecipeBody(justfile, recipe);
  if (!body) {
    problems.push(`portable shard recipe ${recipe} not found in justfile`);
    continue;
  }
  if (!body.includes("@itotori/app") || !body.includes("vitest run")) {
    problems.push(
      `portable shard recipe ${recipe} does not run @itotori/app vitest — the app test union is broken`,
    );
  }
  const shardMatches = [...body.matchAll(/--shard=(\d+\/\d+)/gu)].map((m) => m[1]);
  if (shardMatches.length === 0) {
    problems.push(
      `portable shard recipe ${recipe} has no --shard=N/M — the app test union may not be complete`,
    );
  } else if (!shardMatches.includes(requiredShard)) {
    problems.push(
      `portable shard recipe ${recipe} must use --shard=${requiredShard} (found: ${shardMatches.join(", ")}) — complementary partition required so every app file lands in exactly one shard`,
    );
  } else {
    observedShards.add(requiredShard);
  }
  // Reject any other shard value on the app vitest line (e.g. both recipes 2/2).
  const unexpected = shardMatches.filter((s) => s !== requiredShard);
  if (unexpected.length > 0) {
    problems.push(
      `portable shard recipe ${recipe} has unexpected --shard value(s): ${unexpected.join(", ")} (required ${requiredShard})`,
    );
  }
  for (const file of dbExcludedAppTests) {
    // Only flag if the file is used as an exclusion (or otherwise referenced in
    // a way that would skip it). A bare comment is unlikely; any reference is
    // treated as a stranding risk for this guard.
    if (body.includes(file)) {
      problems.push(
        `portable shard recipe ${recipe} references ${file} — the file is also excluded from the DB lane and would run NOWHERE`,
      );
    }
  }
}
if (observedShards.size > 0 && !(observedShards.has("1/2") && observedShards.has("2/2"))) {
  problems.push(
    `portable shard recipes must form complementary --shard=1/2 + --shard=2/2 (observed: ${[...observedShards].sort().join(", ") || "none"})`,
  );
}

// 3. The DB recipe must actually exclude each listed file (the list is live).
const dbBody = extractRecipeBody(justfile, dbRecipe);
if (!dbBody) {
  problems.push(`DB recipe ${dbRecipe} not found in justfile`);
} else {
  for (const file of dbExcludedAppTests) {
    if (!dbBody.includes(file)) {
      problems.push(
        `DB recipe ${dbRecipe} no longer excludes ${file} — remove it from the guard's dbExcludedAppTests list or restore the exclusion`,
      );
    }
  }
}

// 4. Portable job in _tier1.yml must schedule both TS shards AND download +
//    wire the native artifact (ITOTORI_*_BIN). Without that wiring the
//    wholegame real-binary assertion green-skips even when the file is selected.
const portableJob = extractWorkflowJob(workflow, "portable");
if (!portableJob) {
  problems.push("workflow job `portable` not found in _tier1.yml");
} else {
  if (!/needs:\s*\[native\]/u.test(portableJob) && !/needs:\s*\n\s*-\s*native/u.test(portableJob)) {
    problems.push(
      "portable job must `needs: [native]` so the native artifact is available before app vitest runs",
    );
  }
  if (!/download-artifact@/u.test(portableJob)) {
    problems.push(
      "portable job must download the native artifact (actions/download-artifact) — without it ITOTORI_*_BIN cannot be wired",
    );
  }
  if (!/native-\$\{\{\s*github\.sha\s*\}\}-linux-x64/u.test(portableJob)) {
    problems.push("portable job must download artifact name native-${{ github.sha }}-linux-x64");
  }
  if (!/ITOTORI_UTSUSHI_BIN=/u.test(portableJob)) {
    problems.push(
      "portable job must wire ITOTORI_UTSUSHI_BIN into the environment (wholegame real-binary assertion depends on it)",
    );
  }
  if (!/ITOTORI_KAIFUU_BIN=/u.test(portableJob)) {
    problems.push("portable job must wire ITOTORI_KAIFUU_BIN into the environment");
  }
  for (const shard of portableMatrixShards) {
    // Matrix entries look like: `- ts-public-1of2`
    if (!new RegExp(`^\\s*-\\s*${shard}\\s*$`, "mu").test(portableJob)) {
      problems.push(
        `portable job matrix must schedule shard ${shard} — otherwise its justfile recipe is never executed`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(
    "db-app-exclusion-union: FAILED — DB-excluded app test(s) not safely covered by the portable shard union under native wiring:",
  );
  for (const p of problems) {
    console.error(`  - ${p}`);
  }
  console.error(
    "  A test file excluded from the DB lane MUST still run in a complementary portable shard with the native artifact wired.",
  );
  process.exit(1);
}

console.log(
  `db-app-exclusion-union: OK — ${dbExcludedAppTests.length} DB-excluded app test(s) covered by complementary portable shards ` +
    `(${portableShardRecipes.map((r) => `${r.recipe}=${r.requiredShard}`).join(", ")}) with native artifact wiring; ` +
    `DB lane (${dbRecipe}) excludes each as expected.`,
);

/**
 * Extract the body (indented lines) of a named justfile recipe.
 * @param {string} justfile
 * @param {string} recipeName
 * @returns {string | null}
 */
function extractRecipeBody(justfile, recipeName) {
  const lines = justfile.split("\n");
  const escaped = recipeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerRe = new RegExp(`^${escaped}\\b[^:]*:\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) {
      const body = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (/^\s/.test(line) || line === "") {
          body.push(line);
        } else {
          break;
        }
      }
      while (body.length > 0 && body[body.length - 1] === "") {
        body.pop();
      }
      return body.join("\n");
    }
  }
  return null;
}

/**
 * Extract a top-level job block (`  jobId:`) from a GitHub Actions workflow YAML.
 * @param {string} workflow
 * @param {string} jobId
 * @returns {string | null}
 */
function extractWorkflowJob(workflow, jobId) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) return null;
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^  [A-Za-z0-9_-]+:\s*$/u.test(line) || /^[A-Za-z0-9_-]+:/u.test(line)) {
      break;
    }
    body.push(line);
  }
  return body.join("\n");
}
