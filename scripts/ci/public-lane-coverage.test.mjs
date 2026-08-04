import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  APP_SUITE_SHARDS,
  DB_OWNED_LANE,
  DB_OWNED_APP_PROOFS,
  REQUIRED_CATEGORY_IDS,
  REQUIRED_DB_OWNED_PROOF_IDS,
  REQUIRED_PUBLIC_CATEGORIES,
  evaluateCoverage,
  extractRecipeBody,
  repoRoot,
  runCoverage,
} from "./public-lane-coverage.mjs";
import { databaseAppVitestArguments } from "./run-db-owned-app-proofs.mjs";

const justfileText = readFileSync(join(repoRoot, "scripts", "developer-command.mjs"), "utf8");
const realProbe = {
  categories: REQUIRED_PUBLIC_CATEGORIES,
  requiredIds: REQUIRED_CATEGORY_IDS,
  justfileText,
  readFile: (p) => readFileSync(join(repoRoot, p), "utf8"),
  fileExists: (p) => {
    try {
      readFileSync(join(repoRoot, p));
      return true;
    } catch {
      return false;
    }
  },
};

test("all required public categories and DB-owned proofs are covered against the real tree", () => {
  const result = runCoverage();
  assert.equal(result.ok, true, `coverage gaps: ${result.failures.join("; ")}`);
  assert.equal(result.rows.length, REQUIRED_PUBLIC_CATEGORIES.length + DB_OWNED_APP_PROOFS.length);
});

test("the registry covers exactly the ten required category ids", () => {
  assert.equal(REQUIRED_CATEGORY_IDS.length, 10);
  const present = new Set(REQUIRED_PUBLIC_CATEGORIES.map((c) => c.category));
  for (const id of REQUIRED_CATEGORY_IDS) assert.ok(present.has(id), `missing ${id}`);
});

test("the registry keeps every live-Postgres app proof explicitly owned by the DB lane", () => {
  assert.equal(DB_OWNED_LANE, "ci-tier1-db");
  assert.equal(DB_OWNED_APP_PROOFS.length, 29);
  assert.equal(REQUIRED_DB_OWNED_PROOF_IDS.length, DB_OWNED_APP_PROOFS.length);
  for (const id of [
    "durable-restart",
    "workflow-memo-model-variant",
    "durable-pause-resume",
    "patchback-produce-engine-detection",
    "provider-budget-fair-share",
  ])
    assert.ok(REQUIRED_DB_OWNED_PROOF_IDS.includes(id), id);
});

test("command-selector extraction isolates the meta lane from another scope", () => {
  const body = extractRecipeBody(justfileText, "ci-tier0-meta");
  assert.ok(body?.includes("audit-no-legacy-llm-residue"));
  assert.ok(body?.includes("migrations-parity.test.ts"));
  // Must NOT bleed into the next scope (ts runs vp check).
  assert.ok(!body?.includes("pnpm exec vp check"), "recipe body leaked into ci-tier0-ts");
});

// --- NEGATIVE: dropping a required category fails the gate --------------------
test("dropping a required category surfaces as a coverage gap", () => {
  const dropped = REQUIRED_PUBLIC_CATEGORIES.filter((c) => c.category !== "migration");
  const result = evaluateCoverage({ ...realProbe, categories: dropped });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes("migration") && f.includes("missing")));
});

test("dropping a required DB-owned proof surfaces as a coverage gap", () => {
  const result = evaluateCoverage({
    ...realProbe,
    dbOwnedProofs: DB_OWNED_APP_PROOFS.filter((proof) => proof.proof !== "durable-restart"),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some(
      (failure) => failure.includes("durable-restart") && failure.includes("missing"),
    ),
  );
});

test("removing a DB-owned category member surfaces as a coverage gap", () => {
  const result = evaluateCoverage({
    ...realProbe,
    dbOwnedProofs: DB_OWNED_APP_PROOFS.filter((proof) => proof.proof !== "memo-fault"),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some(
      (failure) => failure.includes("memo-fault") && failure.includes("ownership registry"),
    ),
  );
});

// --- NEGATIVE: citing a private/secret lane fails the gate -------------------
test("a category cited against a PRIVATE lane is rejected", () => {
  const poisoned = REQUIRED_PUBLIC_CATEGORIES.map((c) =>
    c.category === "migration"
      ? {
          ...c,
          proof: {
            kind: "recipe-token",
            lane: "ci-real-bytes",
            token: "migrations-parity.test.ts",
          },
        }
      : c,
  );
  const result = evaluateCoverage({ ...realProbe, categories: poisoned });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes("ci-real-bytes") && f.includes("PRIVATE")));
});

// --- NEGATIVE: a missing test file fails the gate ----------------------------
test("a citation to a non-existent test file is rejected", () => {
  const poisoned = REQUIRED_PUBLIC_CATEGORIES.map((c) =>
    c.category === "tool" ? { ...c, test: "apps/itotori/test/does-not-exist.test.ts" } : c,
  );
  const result = evaluateCoverage({ ...realProbe, categories: poisoned });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes("does not exist")));
});

// --- NEGATIVE: a stale marker (test renamed away) fails the gate -------------
test("a marker absent from the cited test is rejected", () => {
  const poisoned = REQUIRED_PUBLIC_CATEGORIES.map((c) =>
    c.category === "strict-schema" ? { ...c, marker: "this marker does not appear anywhere" } : c,
  );
  const result = evaluateCoverage({ ...realProbe, categories: poisoned });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes("marker") && f.includes("not found")));
});

// --- NEGATIVE: an app-suite citation not under the app test dir is rejected --
test("an app-suite-member citation outside apps/itotori/test is rejected", () => {
  const poisoned = REQUIRED_PUBLIC_CATEGORIES.map((c) =>
    c.category === "tool"
      ? {
          ...c,
          test: "packages/itotori-db/test/migrations-parity.test.ts",
          marker: "migrations registration parity",
        }
      : c,
  );
  const result = evaluateCoverage({ ...realProbe, categories: poisoned });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes("must live under apps/itotori/test/")));
});

test("app-suite shards both run the @itotori/app vitest suite", () => {
  for (const lane of APP_SUITE_SHARDS) {
    const body = extractRecipeBody(justfileText, lane);
    assert.ok(body?.includes("--filter @itotori/app"), `${lane} missing app filter`);
    assert.ok(body?.includes("--shard"), `${lane} missing shard`);
  }
});

test("DB-owned app proofs are collected by the DB runner and excluded from portable discovery", () => {
  const dbRecipe = extractRecipeBody(justfileText, "ci-tier1-db");
  assert.ok(dbRecipe);
  assert.ok(dbRecipe.includes("run-db-owned-app-proofs.mjs"));
  const argumentsForDb = databaseAppVitestArguments();
  const portableConfig = readFileSync(join(repoRoot, "apps/itotori/vitest.config.ts"), "utf8");
  assert.ok(portableConfig.includes("DB_OWNED_APP_TEST_FILES"));
  for (const proof of DB_OWNED_APP_PROOFS) {
    const appPath = proof.test.replace("apps/itotori/", "");
    assert.ok(argumentsForDb.includes(appPath), `${proof.proof} missing DB runner invocation`);
    for (const lane of APP_SUITE_SHARDS) {
      const shardRecipe = extractRecipeBody(justfileText, lane);
      assert.ok(
        shardRecipe?.includes("--filter @itotori/app"),
        `${proof.proof} is collected by ${lane}`,
      );
    }
  }
});

test("removing the DB-owned runner invocation fails coverage", () => {
  const missingInvocation = evaluateCoverage({
    ...realProbe,
    justfileText: justfileText.replace("run-db-owned-app-proofs.mjs", "unowned-app-proofs.mjs"),
  });
  assert.equal(missingInvocation.ok, false);
  assert.ok(
    missingInvocation.failures.some(
      (failure) => failure.includes("DB lane") && failure.includes("DB-owned app runner"),
    ),
  );
});
