#!/usr/bin/env node
// PUBLIC-CI-LANE COVERAGE MANIFEST — the checked assertion that the secretless
// per-gate lane provably runs every REQUIRED public test category.
//
// PROJECT LAW: coverage must be EXPLICIT, not implicit. It is not enough that a
// category "happens to" run somewhere; a fork PR or a secretless run must be
// able to point at the exact secretless recipe + test that exercises it. This
// manifest names, per required category, the concrete test file (with a
// distinguishing marker string that must appear in it) and the PUBLIC recipe
// that runs it, and `--check` proves each citation is real, secretless, and
// actually wired into the recipe — a NEW category or a citation that drifts to
// a private/secret lane fails the gate.
//
// The ten required public categories (from the CI-lanes acceptance):
//   strict schema, golden-wire interception, memo/fault, tool,
//   Wiki/invalidation, workflow, migration, patch-fixture, no-legacy, LOC.
//
// Usage:
//   node scripts/ci/public-lane-coverage.mjs            # print coverage table
//   node scripts/ci/public-lane-coverage.mjs --check     # fail (exit 1) on any gap
//
// Wired into `just ci tier0-meta` (a REQUIRED tier-0 merge-queue check), so the
// coverage assertion runs secretlessly on every PR — including fork PRs.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..", "..");

// ---------------------------------------------------------------------------
// Lane classification. PUBLIC lanes are the per-gate recipes wired into
// pr-tiers.yml (tier0 + tier1); ci-tier1-db gets a disposable Postgres service
// and the CI-built public native CLI artifact. PRIVATE lanes need staged real
// corpora, a real browser, or the opt-in real-byte profile and are NEVER a
// valid coverage citation — a category that can only be proven on a private
// lane is a gap.
// ---------------------------------------------------------------------------
export const PUBLIC_SECRETLESS_LANES = new Set([
  "ci-tier0-meta",
  "ci-tier0-ts",
  "ci-tier0-rust",
  "ci-tier0-manifest",
  "ci-tier1-ts-public-1of2",
  "ci-tier1-ts-public-2of2",
  "ci-tier1-rust-1of3",
  "ci-tier1-rust-2of3",
  "ci-tier1-rust-3of3",
  "ci-tier1-db",
  "alpha-proof",
  "ci-tier1-mutation",
]);

export const PRIVATE_LANES = new Set([
  "ci-real-bytes",
  "ci-real-bytes-private-proof",
  "real-bytes-oracle",
  "real-bytes-oracle-drift",
  "periodic-strict",
  "browser-e2e",
  "ci-tier1-browser",
]);

// The two public app-suite shards. Their UNION covers every public-owned app
// test. The two durable proofs in DB_OWNED_APP_PROOFS are explicitly excluded
// from both shards and directly invoked by ci-tier1-db: that is collection
// ownership, not a no-DATABASE_URL skip.
export const APP_SUITE_SHARDS = ["ci-tier1-ts-public-1of2", "ci-tier1-ts-public-2of2"];
export const DB_OWNED_LANE = "ci-tier1-db";

// These proofs need live Postgres and intentionally fail loudly if it is
// absent. Each must be directly invoked in ci-tier1-db and excluded from both
// portable shards; this registry keeps either side of that ownership split from
// silently drifting.
export const DB_OWNED_APP_PROOFS = [
  {
    proof: "durable-restart",
    title: "durable restart",
    test: "apps/itotori/test/production-localize-restart-live-db.test.ts",
    marker: "SIGKILLs a production child after P1, then resumes from its durable checkpoint",
    lane: DB_OWNED_LANE,
    invocation: "vitest run test/production-localize-restart-live-db.test.ts",
  },
  {
    proof: "workflow-memo-model-variant",
    title: "model-variant durable memo",
    test: "apps/itotori/test/workflow-memo-identity-live-db.test.ts",
    marker: "keeps a model-only variant in a distinct durable checkpoint",
    lane: DB_OWNED_LANE,
    invocation: "vitest run test/workflow-memo-identity-live-db.test.ts",
  },
];

export const REQUIRED_DB_OWNED_PROOF_IDS = ["durable-restart", "workflow-memo-model-variant"];

// ---------------------------------------------------------------------------
// The required-category coverage registry. Each entry cites:
//   - test:   a real file that must exist and contain `marker`.
//   - marker: a distinguishing describe()/name string proving it is THE test.
//   - proof:  how the PUBLIC recipe runs it —
//       { kind: "recipe-token", lane, token }  the recipe body must contain
//                                               `token` (an explicit invocation).
//       { kind: "app-suite-member" }           the file is an @itotori/app test,
//                                               run by both APP_SUITE_SHARDS.
// ---------------------------------------------------------------------------
export const REQUIRED_PUBLIC_CATEGORIES = [
  {
    category: "strict-schema",
    title: "strict schema",
    test: "packages/localization-bridge-schema/test/schema.test.ts",
    marker: "localization bridge schema",
    proof: {
      kind: "recipe-token",
      lane: "ci-tier1-ts-public-1of2",
      token: "@itotori/localization-bridge-schema",
    },
  },
  {
    category: "golden-wire-interception",
    title: "golden-wire interception",
    test: "apps/itotori/test/llm-zdr-golden-wire.test.ts",
    marker: "ZDR golden wire",
    proof: { kind: "app-suite-member" },
  },
  {
    category: "memo-fault",
    title: "memo/fault",
    test: "apps/itotori/test/llm-physical-step-memo.test.ts",
    marker: "memoizes every model step",
    proof: { kind: "app-suite-member" },
  },
  {
    category: "tool",
    title: "tool",
    test: "apps/itotori/test/read-tools.test.ts",
    marker: "read tools",
    proof: { kind: "app-suite-member" },
  },
  {
    category: "wiki-invalidation",
    title: "Wiki/invalidation",
    test: "apps/itotori/test/scoped-invalidation.test.ts",
    marker: "structured field/claim invalidation",
    proof: { kind: "app-suite-member" },
  },
  {
    category: "workflow",
    title: "workflow",
    test: "apps/itotori/test/workflow-driver-flow.test.ts",
    marker: "workflow driver",
    proof: { kind: "app-suite-member" },
  },
  {
    category: "migration",
    title: "migration",
    test: "packages/itotori-db/test/migrations-parity.test.ts",
    marker: "migrations registration parity",
    proof: {
      kind: "recipe-token",
      lane: "ci-tier0-meta",
      token: "migrations-parity.test.ts",
    },
  },
  {
    category: "patch-fixture",
    title: "patch-fixture",
    test: "apps/itotori/test/patch-exporter.test.ts",
    marker: "PatchExporter",
    proof: { kind: "app-suite-member" },
  },
  {
    category: "no-legacy",
    title: "no-legacy",
    test: "scripts/audit-no-legacy-llm-residue.test.mjs",
    marker: "legacy",
    proof: {
      kind: "recipe-token",
      lane: "ci-tier0-meta",
      token: "audit-no-legacy-llm-residue",
    },
  },
  {
    category: "loc",
    title: "LOC",
    test: "scripts/audit-llm-loc-budget.test.mjs",
    marker: "budget",
    proof: {
      kind: "recipe-token",
      lane: "ci-tier0-meta",
      token: "audit-llm-loc-budget",
    },
  },
];

// The fixed set of categories the acceptance requires. Kept separate from the
// registry so a DROPPED category (registry shrinks below this set) fails.
export const REQUIRED_CATEGORY_IDS = [
  "strict-schema",
  "golden-wire-interception",
  "memo-fault",
  "tool",
  "wiki-invalidation",
  "workflow",
  "migration",
  "patch-fixture",
  "no-legacy",
  "loc",
];

// ---------------------------------------------------------------------------
// Command-selector extraction. The justfile has only the six public delegates;
// lane implementation lives in the validated command dispatcher.
// ---------------------------------------------------------------------------
export function extractRecipeBody(justfileText, recipeName) {
  if (recipeName === "ci-tier0-meta") {
    return (
      /if \(scope === "meta"\)\s*return shell\(`(?<body>[\s\S]*?)`\);/u.exec(justfileText)?.groups
        ?.body ?? null
    );
  }
  if (recipeName.startsWith("ci-tier1-")) {
    const selector = recipeName.slice(3);
    return (
      new RegExp(
        `if \\(lane === "${selector}"\\)\\s*return shell\\(\\s*"(?<body>[\\s\\S]*?)",\\s*\\)`,
        "u",
      ).exec(justfileText)?.groups?.body ?? null
    );
  }
  const lines = justfileText.split(/\r?\n/u);
  const headerRe = new RegExp(`^${recipeName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:\\s|:)`);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headerRe.test(lines[i]) && lines[i].includes(":")) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // A new recipe header at column 0 (a word/hyphen name then `:`) ends this
    // recipe. Indented lines, comments, and blanks belong to the body.
    if (/^[A-Za-z0-9][\w-]*(?:\s+[A-Za-z0-9][\w-]*)*\s*:/u.test(line)) break;
    body.push(line);
  }
  return body.join("\n");
}

function verifyPublicLane(lane, label, row, failures) {
  if (PRIVATE_LANES.has(lane)) {
    row.ok = false;
    failures.push(`${label}: lane "${lane}" is a PRIVATE/secret lane — not valid public coverage`);
  } else if (!PUBLIC_SECRETLESS_LANES.has(lane)) {
    row.ok = false;
    failures.push(`${label}: lane "${lane}" is not a known public secretless recipe`);
  }
}

// ---------------------------------------------------------------------------
// Coverage evaluation. Returns { ok, rows, failures } — pure over injected
// justfile text + a file-exists/read probe so the regression suite can drive
// mutated inputs without touching the tree.
// ---------------------------------------------------------------------------
export function evaluateCoverage({
  categories,
  requiredIds,
  dbOwnedProofs = DB_OWNED_APP_PROOFS,
  requiredDbOwnedProofIds = REQUIRED_DB_OWNED_PROOF_IDS,
  justfileText,
  readFile,
  fileExists,
}) {
  const failures = [];
  const rows = [];

  // Every required category id must be present in the registry (no drop).
  const present = new Set(categories.map((c) => c.category));
  for (const id of requiredIds) {
    if (!present.has(id))
      failures.push(`required category "${id}" is missing from the coverage registry`);
  }

  for (const entry of categories) {
    const lanes = entry.proof.kind === "app-suite-member" ? APP_SUITE_SHARDS : [entry.proof.lane];
    const row = { category: entry.category, title: entry.title, test: entry.test, lanes, ok: true };

    // (a) every covering lane is a PUBLIC recipe, never a private one.
    for (const lane of lanes) verifyPublicLane(lane, entry.category, row, failures);

    // (b) the cited test exists and carries its distinguishing marker.
    if (!fileExists(entry.test)) {
      row.ok = false;
      failures.push(`${entry.category}: cited test "${entry.test}" does not exist`);
    } else if (!readFile(entry.test).includes(entry.marker)) {
      row.ok = false;
      failures.push(`${entry.category}: marker "${entry.marker}" not found in "${entry.test}"`);
    }

    // (c) the recipe is provably wired to run the test.
    if (entry.proof.kind === "recipe-token") {
      const body = extractRecipeBody(justfileText, entry.proof.lane);
      if (body === null) {
        row.ok = false;
        failures.push(`${entry.category}: recipe "${entry.proof.lane}" not found in the justfile`);
      } else if (!body.includes(entry.proof.token)) {
        row.ok = false;
        failures.push(
          `${entry.category}: recipe "${entry.proof.lane}" does not invoke token "${entry.proof.token}"`,
        );
      }
    } else if (entry.proof.kind === "app-suite-member") {
      if (!entry.test.startsWith("apps/itotori/test/")) {
        row.ok = false;
        failures.push(
          `${entry.category}: app-suite-member test must live under apps/itotori/test/`,
        );
      }
      for (const lane of APP_SUITE_SHARDS) {
        const body = extractRecipeBody(justfileText, lane);
        if (
          body === null ||
          !body.includes("--filter @itotori/app") ||
          !body.includes("vitest") ||
          !body.includes("--shard")
        ) {
          row.ok = false;
          failures.push(
            `${entry.category}: shard "${lane}" does not run the @itotori/app vitest suite`,
          );
        }
      }
    } else {
      row.ok = false;
      failures.push(`${entry.category}: unknown proof kind "${entry.proof.kind}"`);
    }

    rows.push(row);
  }

  const presentDbOwnedProofs = new Set(dbOwnedProofs.map((proof) => proof.proof));
  for (const id of requiredDbOwnedProofIds) {
    if (!presentDbOwnedProofs.has(id))
      failures.push(`required DB-owned proof "${id}" is missing from the coverage registry`);
  }

  for (const proof of dbOwnedProofs) {
    const row = {
      category: proof.proof,
      title: `${proof.title} (DB-owned)`,
      test: proof.test,
      lanes: [proof.lane],
      ok: true,
    };
    verifyPublicLane(proof.lane, proof.proof, row, failures);

    if (proof.lane !== DB_OWNED_LANE) {
      row.ok = false;
      failures.push(
        `${proof.proof}: DB-owned proof must be directly owned by "${DB_OWNED_LANE}", not "${proof.lane}"`,
      );
    }

    if (!fileExists(proof.test)) {
      row.ok = false;
      failures.push(`${proof.proof}: cited test "${proof.test}" does not exist`);
    } else if (!readFile(proof.test).includes(proof.marker)) {
      row.ok = false;
      failures.push(`${proof.proof}: marker "${proof.marker}" not found in "${proof.test}"`);
    }

    if (!proof.test.startsWith("apps/itotori/test/")) {
      row.ok = false;
      failures.push(`${proof.proof}: DB-owned proof must live under apps/itotori/test/`);
    }

    const dbRecipe = extractRecipeBody(justfileText, proof.lane);
    if (dbRecipe === null || !dbRecipe.includes(proof.invocation)) {
      row.ok = false;
      failures.push(
        `${proof.proof}: DB lane "${proof.lane}" does not directly invoke "${proof.invocation}"`,
      );
    }

    const appPath = proof.test.replace("apps/itotori/", "");
    const exclusion = `--exclude '${appPath}'`;
    if (dbRecipe === null || !dbRecipe.includes(exclusion)) {
      row.ok = false;
      failures.push(
        `${proof.proof}: DB lane "${proof.lane}" reruns the proof outside its direct invocation`,
      );
    }
    for (const lane of APP_SUITE_SHARDS) {
      const shardRecipe = extractRecipeBody(justfileText, lane);
      if (shardRecipe === null || !shardRecipe.includes(exclusion)) {
        row.ok = false;
        failures.push(`${proof.proof}: public shard "${lane}" does not exclude "${appPath}"`);
      }
    }

    rows.push(row);
  }

  return { ok: failures.length === 0, rows, failures };
}

export function runCoverage(root = repoRoot) {
  const justfileText = readFileSync(join(root, "scripts", "developer-command.mjs"), "utf8");
  return evaluateCoverage({
    categories: REQUIRED_PUBLIC_CATEGORIES,
    requiredIds: REQUIRED_CATEGORY_IDS,
    dbOwnedProofs: DB_OWNED_APP_PROOFS,
    requiredDbOwnedProofIds: REQUIRED_DB_OWNED_PROOF_IDS,
    justfileText,
    readFile: (p) => readFileSync(join(root, p), "utf8"),
    fileExists: (p) => existsSync(join(root, p)),
  });
}

function main() {
  const check = process.argv.includes("--check");
  const result = runCoverage();
  for (const row of result.rows) {
    const lane = row.lanes.join(" + ");
    process.stdout.write(
      `${row.ok ? "ok  " : "FAIL"}  ${row.title.padEnd(24)} ${lane}  ⟵ ${row.test}\n`,
    );
  }
  if (!result.ok) {
    process.stderr.write("\npublic-lane coverage GAPS:\n");
    for (const f of result.failures) process.stderr.write(`  - ${f}\n`);
    if (check) process.exit(1);
  } else {
    process.stdout.write(
      `\nall ${REQUIRED_PUBLIC_CATEGORIES.length} required public categories and ${DB_OWNED_APP_PROOFS.length} DB-owned proofs proven in public CI lanes.\n`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
