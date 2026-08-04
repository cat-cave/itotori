// @itotori-meta-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  APP_SUITE_SHARDS,
  DB_OWNED_LANE,
  evaluateCoverage,
  extractRecipeBody,
  repoRoot,
  runCoverage,
} from "./public-lane-coverage.mjs";
import {
  dbOwnedAppProofs,
  discoverTestOwnership,
  publicCoverageClaims,
} from "./test-ownership.mjs";
import { databaseAppVitestArguments } from "./run-db-owned-app-proofs.mjs";
import { discoverMetaChecks } from "../meta-check-manifest.mjs";

const ownerships = discoverTestOwnership();
const commandText = readFileSync(join(repoRoot, "scripts", "developer-command.mjs"), "utf8");
const metaChecks = discoverMetaChecks(repoRoot);
const portableAppConfig = readFileSync(
  join(repoRoot, "apps", "itotori", "vitest.config.ts"),
  "utf8",
);
const probe = {
  ownerships,
  commandText,
  metaChecks,
  portableAppConfig,
  readFile: (path) => readFileSync(join(repoRoot, path), "utf8"),
  fileExists: (path) => {
    try {
      readFileSync(join(repoRoot, path));
      return true;
    } catch {
      return false;
    }
  },
};

function replaceOwnership(testPath, change) {
  return ownerships.map((entry) => (entry.test === testPath ? change(entry) : entry));
}

test("all public categories and DB proofs are derived from adjacent declarations", () => {
  const result = runCoverage();
  assert.equal(result.ok, true, result.failures.join("; "));
  assert.equal(
    result.rows.length,
    publicCoverageClaims(ownerships).length + dbOwnedAppProofs(ownerships).length,
  );
  assert.ok(publicCoverageClaims(ownerships).length > 0);
  assert.ok(dbOwnedAppProofs(ownerships).length > 0);
});

test("the coverage implementation stores no public-category or DB-proof registry", () => {
  const source = readFileSync(join(repoRoot, "scripts", "ci", "public-lane-coverage.mjs"), "utf8");
  const dbSource = readFileSync(join(repoRoot, "scripts", "ci", "db-owned-app-proofs.mjs"), "utf8");
  assert.doesNotMatch(source, /REQUIRED_PUBLIC_CATEGORIES|REQUIRED_CATEGORY_IDS/u);
  assert.doesNotMatch(dbSource, /\[\s*\{[\s\S]*?proof:/u);
});

test("command-selector extraction isolates the meta lane from another scope", () => {
  const body = extractRecipeBody(commandText, "ci-tier0-meta");
  assert.ok(body?.includes("scripts/meta-check-manifest.mjs"));
  assert.ok(!body?.includes("pnpm exec vp check"), "recipe body leaked into ci-tier0-ts");
});

test("tier-zero meta coverage requires the discovered declaration for its token", () => {
  const category = publicCoverageClaims(ownerships).find(
    ({ category }) => category === "migration",
  );
  assert.ok(category);
  const result = evaluateCoverage({
    ...probe,
    metaChecks: metaChecks.filter(({ owner }) => !owner.includes("migrations-parity.test.ts")),
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.includes("discovered meta checks")));
});

test("a required category with its ownership removed fails coverage", () => {
  const category = publicCoverageClaims(ownerships).find(
    ({ category }) => category === "migration",
  );
  assert.ok(category);
  const result = evaluateCoverage({
    ...probe,
    ownerships: replaceOwnership(category.test, (entry) => ({ ...entry, lanes: [] })),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((failure) => failure.includes("required category is owned by no lane")),
  );
});

test("a deleted previously declared category or DB proof fails the derived baseline ratchet", () => {
  const category = publicCoverageClaims(ownerships)[0];
  const dbProof = dbOwnedAppProofs(ownerships)[0];
  assert.ok(category);
  assert.ok(dbProof);
  const categoryRemoved = evaluateCoverage({
    ...probe,
    ownerships: ownerships.filter((entry) => entry.test !== category.test),
    baselineOwnerships: ownerships,
  });
  assert.equal(categoryRemoved.ok, false);
  assert.ok(categoryRemoved.failures.some((failure) => failure.includes("public category")));
  const proofRemoved = evaluateCoverage({
    ...probe,
    ownerships: ownerships.filter((entry) => entry.test !== dbProof.test),
    baselineOwnerships: ownerships,
  });
  assert.equal(proofRemoved.ok, false);
  assert.ok(proofRemoved.failures.some((failure) => failure.includes("DB-owned proof")));
});

test("a category cited against a private lane is rejected", () => {
  const category = publicCoverageClaims(ownerships).find(
    ({ category }) => category === "migration",
  );
  assert.ok(category);
  const result = evaluateCoverage({
    ...probe,
    ownerships: replaceOwnership(category.test, (entry) => ({
      ...entry,
      lanes: ["ci-real-bytes"],
    })),
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.includes("private")));
});

test("a missing cited test and marker drift are rejected", () => {
  const category = publicCoverageClaims(ownerships).find(({ category }) => category === "tool");
  assert.ok(category);
  const missing = evaluateCoverage({
    ...probe,
    ownerships: replaceOwnership(category.test, (entry) => ({
      ...entry,
      test: "apps/itotori/test/does-not-exist.test.ts",
    })),
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.failures.some((failure) => failure.includes("does not exist")));
  const marker = evaluateCoverage({
    ...probe,
    ownerships: replaceOwnership(category.test, (entry) => ({
      ...entry,
      coverage: { ...entry.coverage, marker: "not in this test" },
    })),
  });
  assert.equal(marker.ok, false);
  assert.ok(marker.failures.some((failure) => failure.includes("marker")));
});

test("DB ownership is collected by the DB runner and excluded from portable discovery", () => {
  const dbRecipe = extractRecipeBody(commandText, DB_OWNED_LANE);
  assert.ok(dbRecipe?.includes("run-db-owned-app-proofs.mjs"));
  assert.ok(portableAppConfig.includes("DB_OWNED_APP_TEST_FILES"));
  const argumentsForDb = databaseAppVitestArguments();
  for (const proof of dbOwnedAppProofs(ownerships)) {
    assert.ok(argumentsForDb.includes(proof.test.replace("apps/itotori/", "")), proof.test);
  }
});

test("removing the discovered DB runner invocation fails coverage", () => {
  const result = evaluateCoverage({
    ...probe,
    commandText: commandText.replace("run-db-owned-app-proofs.mjs", "unowned-app-proofs.mjs"),
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.includes("DB lane")));
});

test("portable app claims expand to both public shards", () => {
  assert.equal(APP_SUITE_SHARDS.length, 2);
  for (const lane of APP_SUITE_SHARDS) {
    const body = extractRecipeBody(commandText, lane);
    assert.ok(body?.includes("--filter @itotori/app"), lane);
    assert.ok(body?.includes("--shard"), lane);
  }
});
