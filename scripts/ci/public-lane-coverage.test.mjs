import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  APP_SUITE_SHARDS,
  REQUIRED_CATEGORY_IDS,
  REQUIRED_PUBLIC_CATEGORIES,
  evaluateCoverage,
  extractRecipeBody,
  repoRoot,
  runCoverage,
} from "./public-lane-coverage.mjs";

const justfileText = readFileSync(join(repoRoot, "justfile"), "utf8");
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

test("all ten required public categories are covered secretlessly against the real tree", () => {
  const result = runCoverage();
  assert.equal(result.ok, true, `coverage gaps: ${result.failures.join("; ")}`);
  assert.equal(result.rows.length, 10);
});

test("the registry covers exactly the ten required category ids", () => {
  assert.equal(REQUIRED_CATEGORY_IDS.length, 10);
  const present = new Set(REQUIRED_PUBLIC_CATEGORIES.map((c) => c.category));
  for (const id of REQUIRED_CATEGORY_IDS) assert.ok(present.has(id), `missing ${id}`);
});

test("recipe-body extraction isolates a recipe from the next header", () => {
  const body = extractRecipeBody(justfileText, "ci-tier0-meta");
  assert.ok(body?.includes("audit-no-legacy-llm-residue"));
  assert.ok(body?.includes("migrations-parity.test.ts"));
  // Must NOT bleed into the next recipe (ci-tier0-ts runs vp check).
  assert.ok(!body?.includes("pnpm exec vp check"), "recipe body leaked into ci-tier0-ts");
});

// --- NEGATIVE: dropping a required category fails the gate --------------------
test("dropping a required category surfaces as a coverage gap", () => {
  const dropped = REQUIRED_PUBLIC_CATEGORIES.filter((c) => c.category !== "migration");
  const result = evaluateCoverage({ ...realProbe, categories: dropped });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes("migration") && f.includes("missing")));
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
