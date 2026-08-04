#!/usr/bin/env node
// @itotori-meta-check
// Derive public-lane coverage from the adjacent ownership declaration of each
// cited test. Coverage is static wiring evidence, not proof that test bodies
// pass when a lane executes.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  APP_SUITE_SHARDS,
  DB_OWNED_LANE,
  PORTABLE_APP_LANE,
  dbOwnedAppProofs,
  discoverTestOwnership,
  laneOwnershipFailures,
  mergeBaseOwnership,
  ownershipAtRevision,
  publicCoverageClaims,
  removedOwnershipClaims,
} from "./test-ownership.mjs";
import { databaseAppVitestArguments } from "./run-db-owned-app-proofs.mjs";
import { discoverMetaChecks } from "../meta-check-manifest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..", "..");
export { APP_SUITE_SHARDS, DB_OWNED_LANE };

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

export function extractRecipeBody(commandText, recipeName) {
  if (recipeName === "ci-tier0-meta") {
    return (
      /if \(scope === "meta"\)\s*\{(?<body>[\s\S]*?)\n  \}/u.exec(commandText)?.groups?.body ?? null
    );
  }
  if (recipeName === DB_OWNED_LANE) {
    return (
      /if \(kindForLane\(lane\) === "db-owned-app"\)\s*return shell\(\s*"(?<body>[\s\S]*?)",\s*\)/u.exec(
        commandText,
      )?.groups?.body ?? null
    );
  }
  if (recipeName.startsWith("ci-tier1-")) {
    const selector = recipeName.slice(3);
    return (
      new RegExp(
        `if \\(lane === "${selector}"\\)\\s*return shell\\(\\s*"(?<body>[\\s\\S]*?)",\\s*\\)`,
        "u",
      ).exec(commandText)?.groups?.body ?? null
    );
  }
  return null;
}

function verifyPublicLane(lane, label, row, failures) {
  if (PRIVATE_LANES.has(lane)) {
    row.ok = false;
    failures.push(`${label}: lane "${lane}" is private and cannot prove public coverage`);
  } else if (!PUBLIC_SECRETLESS_LANES.has(lane)) {
    row.ok = false;
    failures.push(`${label}: lane "${lane}" is not a known public secretless recipe`);
  }
}

function expandedLanes(entry) {
  if (entry.lanes.length !== 1) return [];
  return entry.lanes[0] === PORTABLE_APP_LANE ? APP_SUITE_SHARDS : entry.lanes;
}

function verifyMarker(entry, readFile, fileExists, row, failures) {
  const claim = entry.coverage ?? entry.dbProof;
  if (!fileExists(entry.test)) {
    row.ok = false;
    failures.push(`${row.category}: cited test "${entry.test}" does not exist`);
  } else if (claim !== undefined && !readFile(entry.test).includes(claim.marker)) {
    row.ok = false;
    failures.push(`${row.category}: marker "${claim.marker}" not found in "${entry.test}"`);
  }
}

function isAppShard(body) {
  return (
    body !== null &&
    body.includes("--filter @itotori/app") &&
    body.includes("vitest") &&
    body.includes("--shard")
  );
}

function verifyPortableAppRoute(entry, commandText, row, failures) {
  if (!entry.test.startsWith("apps/itotori/test/")) {
    row.ok = false;
    failures.push(`${row.category}: portable app proof must live under apps/itotori/test/`);
  }
  for (const lane of APP_SUITE_SHARDS) {
    if (!isAppShard(extractRecipeBody(commandText, lane))) {
      row.ok = false;
      failures.push(`${row.category}: shard "${lane}" does not run the @itotori/app Vitest suite`);
    }
  }
}

function verifyDbRoute({
  entry,
  dbProofs,
  dbAppArguments,
  commandText,
  portableAppConfig,
  row,
  failures,
}) {
  const appPath = entry.test.replace("apps/itotori/", "");
  if (!dbProofs.some((proof) => proof.test === entry.test)) {
    row.ok = false;
    failures.push(`${row.category}: cited DB-owned test is absent from discovered ownership`);
  }
  if (!dbAppArguments.includes(appPath)) {
    row.ok = false;
    failures.push(`${row.category}: DB-owned runner does not collect "${appPath}"`);
  }
  const dbRecipe = extractRecipeBody(commandText, DB_OWNED_LANE);
  if (dbRecipe === null || !dbRecipe.includes("run-db-owned-app-proofs.mjs")) {
    row.ok = false;
    failures.push(`${row.category}: DB lane does not invoke the discovered DB-owned app runner`);
  }
  if (!portableAppConfig.includes("DB_OWNED_APP_TEST_FILES")) {
    row.ok = false;
    failures.push(
      `${row.category}: portable app configuration does not exclude discovered DB ownership`,
    );
  }
}

function metaCheckOwnsToken(metaChecks, token) {
  return metaChecks.some(
    ({ args, owner }) => owner.includes(token) || (args !== undefined && args.includes(token)),
  );
}

function verifyRecipeToken({ declaredLane, token, commandText, metaChecks, row, failures }) {
  const body = extractRecipeBody(commandText, declaredLane);
  if (declaredLane === "ci-tier0-meta") {
    if (body === null || !body.includes("scripts/meta-check-manifest.mjs")) {
      row.ok = false;
      failures.push(
        `${row.category}: recipe "${declaredLane}" does not invoke meta-check discovery`,
      );
    } else if (!metaCheckOwnsToken(metaChecks, token)) {
      row.ok = false;
      failures.push(`${row.category}: discovered meta checks do not invoke token "${token}"`);
    }
    return;
  }
  if (body === null || !body.includes(token)) {
    row.ok = false;
    failures.push(`${row.category}: recipe "${declaredLane}" does not invoke token "${token}"`);
  }
}

function verifyCoverageEntry({
  entry,
  dbProofs,
  dbAppArguments,
  commandText,
  metaChecks,
  portableAppConfig,
  readFile,
  fileExists,
  failures,
}) {
  const { coverage } = entry;
  const lanes = expandedLanes(entry);
  const row = {
    category: coverage.id,
    title: coverage.title,
    test: entry.test,
    lanes,
    ok: true,
  };
  if (lanes.length === 0) {
    row.ok = false;
    failures.push(`${coverage.id}: required category is owned by no lane`);
  }
  for (const lane of lanes) verifyPublicLane(lane, coverage.id, row, failures);
  verifyMarker(entry, readFile, fileExists, row, failures);
  const [declaredLane] = entry.lanes;
  if (entry.recipeToken !== undefined && declaredLane !== undefined) {
    verifyRecipeToken({
      declaredLane,
      token: entry.recipeToken,
      commandText,
      metaChecks,
      row,
      failures,
    });
  } else if (declaredLane === PORTABLE_APP_LANE) {
    verifyPortableAppRoute(entry, commandText, row, failures);
  } else if (declaredLane === DB_OWNED_LANE) {
    verifyDbRoute({
      entry,
      dbProofs,
      dbAppArguments,
      commandText,
      portableAppConfig,
      row,
      failures,
    });
  } else if (entry.lanes.length === 1) {
    row.ok = false;
    failures.push(`${coverage.id}: lane "${declaredLane}" has no declared coverage route`);
  }
  return row;
}

function dbEntryForProof(proof) {
  return {
    test: proof.test,
    lanes: [DB_OWNED_LANE],
    dbProof: { id: proof.proof, title: proof.title, marker: proof.marker },
  };
}

function verifyDbProof({
  proof,
  dbProofs,
  dbAppArguments,
  commandText,
  portableAppConfig,
  readFile,
  fileExists,
  failures,
}) {
  const entry = dbEntryForProof(proof);
  const row = {
    category: proof.proof,
    title: `${proof.title} (DB-owned)`,
    test: proof.test,
    lanes: [DB_OWNED_LANE],
    ok: true,
  };
  verifyPublicLane(DB_OWNED_LANE, proof.proof, row, failures);
  verifyMarker(entry, readFile, fileExists, row, failures);
  if (!entry.test.startsWith("apps/itotori/test/")) {
    row.ok = false;
    failures.push(`${proof.proof}: DB-owned proof must live under apps/itotori/test/`);
  }
  verifyDbRoute({ entry, dbProofs, dbAppArguments, commandText, portableAppConfig, row, failures });
  for (const lane of APP_SUITE_SHARDS) {
    if (!isAppShard(extractRecipeBody(commandText, lane))) {
      row.ok = false;
      failures.push(`${proof.proof}: public shard "${lane}" does not run the portable app suite`);
    }
  }
  return row;
}

// Pure over injected descriptors and command text so negative tests can prove
// failures without mutating the repository.
export function evaluateCoverage({
  ownerships,
  baselineOwnerships = [],
  commandText,
  metaChecks = discoverMetaChecks(repoRoot),
  dbAppArguments = databaseAppVitestArguments(),
  portableAppConfig,
  readFile,
  fileExists,
}) {
  const failures = [
    ...laneOwnershipFailures(ownerships),
    ...removedOwnershipClaims(ownerships, baselineOwnerships),
  ];
  const dbProofs = dbOwnedAppProofs(ownerships);
  const rows = publicCoverageClaims(ownerships).map((claim) =>
    verifyCoverageEntry({
      entry: ownerships.find((entry) => entry.test === claim.test),
      dbProofs,
      dbAppArguments,
      commandText,
      metaChecks,
      portableAppConfig,
      readFile,
      fileExists,
      failures,
    }),
  );
  for (const proof of dbProofs) {
    rows.push(
      verifyDbProof({
        proof,
        dbProofs,
        dbAppArguments,
        commandText,
        portableAppConfig,
        readFile,
        fileExists,
        failures,
      }),
    );
  }
  return { ok: failures.length === 0, rows, failures };
}

export function runCoverage(root = repoRoot) {
  const ownerships = discoverTestOwnership(root);
  return evaluateCoverage({
    ownerships,
    baselineOwnerships: [...mergeBaseOwnership(root), ...ownershipAtRevision(root, "HEAD")],
    commandText: readFileSync(join(root, "scripts", "developer-command.mjs"), "utf8"),
    metaChecks: discoverMetaChecks(root),
    portableAppConfig: readFileSync(join(root, "apps", "itotori", "vitest.config.ts"), "utf8"),
    readFile: (path) => readFileSync(join(root, path), "utf8"),
    fileExists: (path) => existsSync(join(root, path)),
  });
}

function main() {
  const check = process.argv.includes("--check");
  try {
    const result = runCoverage();
    for (const row of result.rows) {
      process.stdout.write(
        `${row.ok ? "ok  " : "FAIL"}  ${row.title.padEnd(24)} ${row.lanes.join(" + ")}  ⟵ ${row.test}\n`,
      );
    }
    if (!result.ok) {
      process.stderr.write(
        `\npublic-lane coverage GAPS:\n${result.failures.map((failure) => `  - ${failure}`).join("\n")}\n`,
      );
      if (check) process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `\nall ${result.rows.length} discovered public coverage claims are wired to public CI lanes.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `public-lane coverage GAPS:\n  - ${error instanceof Error ? error.message : String(error)}\n`,
    );
    if (check) process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
