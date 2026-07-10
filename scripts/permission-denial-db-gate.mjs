#!/usr/bin/env node
// SHARED-027: DB-backed local gate for the full repository permission-denial
// matrix in packages/itotori-db/test/authorization-matrix.test.ts. The suite is
// DB-classified: without a reachable Postgres the @itotori/db runner skips it,
// and skipped denial fixtures are NOT authorization coverage. This gate makes
// "the full permission matrix denied unauthorized actors against the real DB"
// provable rather than confusable with a green-on-skip local run.
//
//   * No DATABASE_URL  -> write a machine-readable skipped artifact and FAIL
//     (non-zero). A skip can never masquerade as permission-denial coverage.
//   * DATABASE_URL set -> run ONLY authorization-matrix.test.ts against the
//     (disposable) database, then ASSERT every matrix entry produced one
//     DB-backed denial test (all passed, zero skipped, zero failed). A partial,
//     zero-test, or skipped outcome is a hard failure, and a deterministic proof
//     artifact records the matrix and test counts.
//
// Run against a disposable Postgres (see `just db-up` / `just db-migrate`):
//   just permission-denial-db-strict
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { forEachChild, parseTypeScript, unwrapTsTypeAssertions } from "./stable-ts-ast.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredEnv = "DATABASE_URL";
const packageName = "@itotori/db";
const gateId = "permission-denial-db-strict";
const node = "SHARED-027";
const permissionDenialSuites = ["authorization-matrix.test.ts"];
const authorizationMatrixPath = path.join(
  repoRoot,
  "packages/itotori-db/test/authorization-matrix.test.ts",
);

const tmpDir = path.join(repoRoot, ".tmp/itotori-db");
const skipArtifactPath = path.join(tmpDir, "permission-denial-skipped.json");
const proofArtifactPath = path.join(tmpDir, "permission-denial-proof.json");
const resultsPath = path.join(tmpDir, "permission-denial-results.json");
const generalSkipMarkerPath = path.join(tmpDir, "no-database-skipped.json");

const remediationCommand =
  'just db-up && just db-migrate && DATABASE_URL="$(node scripts/itotori-db-compose-env.mjs --print-database-url)" just permission-denial-db-strict';

await mkdir(tmpDir, { recursive: true });
await rm(skipArtifactPath, { force: true });
await rm(proofArtifactPath, { force: true });
await rm(resultsPath, { force: true });

const expectedMatrixEntries = await countRepositoryPermissionGateMatrixEntries();

if (!process.env[requiredEnv]) {
  const skipArtifact = {
    status: "skipped",
    gate: gateId,
    node,
    package: packageName,
    reason: `${requiredEnv} unset`,
    requiredEnv,
    coverage: "none",
    permissionDenialCovered: false,
    expectedMatrixEntries,
    skippedSuites: permissionDenialSuites,
    skippedSuiteCount: permissionDenialSuites.length,
    remediationCommand,
    timestamp: new Date().toISOString(),
  };
  await writeFile(skipArtifactPath, `${JSON.stringify(skipArtifact, null, 2)}\n`);
  printBanner([
    `${gateId}: PERMISSION-DENIAL DB TESTS SKIPPED - NOT AUTHORIZATION COVERAGE`,
    `required env:     ${requiredEnv} (unset)`,
    `skipped suites:   ${permissionDenialSuites.length} (${permissionDenialSuites.join(", ")})`,
    `matrix entries:   ${expectedMatrixEntries}`,
    "this run proved ZERO DB-backed permission-denial coverage",
    `skip artifact:    ${path.relative(repoRoot, skipArtifactPath)}`,
    `remediation:      ${remediationCommand}`,
  ]);
  console.log(`PERMISSION_DENIAL_DB_SKIP ${JSON.stringify(skipArtifact)}`);
  process.exit(1);
}

const suiteFilters = permissionDenialSuites.map((name) => name.replace(/\.test\.ts$/u, ""));
const runnerArgs = [
  "--filter",
  packageName,
  "exec",
  "node",
  "scripts/run-tests.mjs",
  "--require-database",
  ...suiteFilters,
  "--reporter=default",
  "--reporter=json",
  `--outputFile=${resultsPath}`,
];

const run = spawnSync("pnpm", runnerArgs, {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});

if (run.error) {
  console.error(`${gateId}: failed to launch DB test runner: ${run.error.message}`);
  process.exit(1);
}
if (run.signal) {
  process.kill(process.pid, run.signal);
}

const generalSkip = await readJsonIfPresent(generalSkipMarkerPath);
if (generalSkip) {
  console.error(
    `${gateId}: FAILED - @itotori/db reported a no-DATABASE_URL skip; permission denials did NOT run.`,
  );
  process.exit(1);
}

if (run.status !== 0) {
  console.error(
    `${gateId}: FAILED - permission-denial DB test run exited ${run.status ?? "null"}.`,
  );
  process.exit(run.status ?? 1);
}

const report = await readJsonIfPresent(resultsPath);
if (!report || !Array.isArray(report.testResults)) {
  console.error(`${gateId}: FAILED - missing/unreadable vitest report at ${resultsPath}.`);
  process.exit(1);
}

const perSuite = [];
const problems = [];
for (const suite of permissionDenialSuites) {
  const suiteResults = report.testResults.filter(
    (entry) =>
      typeof entry?.name === "string" && entry.name.replace(/\\/gu, "/").endsWith(`/test/${suite}`),
  );
  if (suiteResults.length === 0) {
    problems.push(`suite ${suite} did not run (0 files matched) - skipped != covered`);
    continue;
  }
  const assertions = suiteResults.flatMap((entry) =>
    Array.isArray(entry.assertionResults) ? entry.assertionResults : [],
  );
  const passed = assertions.filter((a) => a.status === "passed").length;
  const failed = assertions.filter((a) => a.status === "failed").length;
  const skipped = assertions.filter((a) => a.status === "skipped" || a.status === "pending").length;
  const denialAssertions = assertions.filter(isRepositoryPermissionDenialAssertion);

  if (assertions.length === 0) {
    problems.push(`suite ${suite} ran 0 tests - skipped != covered`);
  }
  if (skipped > 0) {
    problems.push(`suite ${suite} has ${skipped} skipped test(s) - skipped != covered`);
  }
  if (failed > 0) {
    problems.push(`suite ${suite} has ${failed} failed test(s)`);
  }
  if (denialAssertions.length !== expectedMatrixEntries) {
    problems.push(
      `suite ${suite} ran ${denialAssertions.length} permission-denial matrix test(s), expected ${expectedMatrixEntries}`,
    );
  }
  perSuite.push({
    suite,
    tests: assertions.length,
    passed,
    failed,
    skipped,
    permissionDenialTests: denialAssertions.length,
  });
}

if (problems.length > 0) {
  printBanner([
    `${gateId}: PERMISSION-DENIAL DB COVERAGE NOT PROVEN`,
    ...problems.map((p) => `- ${p}`),
    "a skipped / partial / zero-test outcome is NOT authorization coverage",
    `remediation:      ${remediationCommand}`,
  ]);
  process.exit(1);
}

const totalTests = perSuite.reduce((sum, s) => sum + s.tests, 0);
const totalPermissionDenialTests = perSuite.reduce((sum, s) => sum + s.permissionDenialTests, 0);
const proof = {
  status: "passed",
  gate: gateId,
  node,
  package: packageName,
  requiredEnv,
  databaseBacked: true,
  permissionDenialCovered: true,
  expectedMatrixEntries,
  totalPermissionDenialTests,
  totalTests,
  suites: perSuite,
  timestamp: new Date().toISOString(),
};
await writeFile(proofArtifactPath, `${JSON.stringify(proof, null, 2)}\n`);

printBanner([
  `${gateId}: PERMISSION-DENIAL DB COVERAGE PROVEN`,
  `suites executed:  ${perSuite.length} against a real database`,
  `matrix entries:   ${expectedMatrixEntries}`,
  `denial tests:     ${totalPermissionDenialTests} (all passed, 0 skipped)`,
  `total tests:      ${totalTests}`,
  `proof artifact:   ${path.relative(repoRoot, proofArtifactPath)}`,
]);
process.exit(0);

async function countRepositoryPermissionGateMatrixEntries() {
  const source = await readFile(authorizationMatrixPath, "utf8");
  const ast = parseTypeScript(source, authorizationMatrixPath);
  let count;
  visit(ast);
  if (count === undefined) {
    throw new Error("repositoryPermissionGateMatrix declaration not found");
  }
  return count;

  function visit(node) {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.id.name === "repositoryPermissionGateMatrix"
    ) {
      const initializer = unwrapTsTypeAssertions(node.init);
      if (initializer && initializer.type === "ArrayExpression") {
        count = initializer.elements.length;
      }
    }
    forEachChild(node, visit);
  }
}

function isRepositoryPermissionDenialAssertion(assertion) {
  const label = [
    assertion?.fullName,
    assertion?.title,
    ...(Array.isArray(assertion?.ancestorTitles) ? assertion.ancestorTitles : []),
  ]
    .filter((part) => typeof part === "string")
    .join(" ");
  return (
    label.includes("repository permission denial fixtures") &&
    label.includes("denies ") &&
    label.includes(" without ")
  );
}

async function readJsonIfPresent(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function printBanner(lines) {
  const width = Math.max(64, ...lines.map((line) => line.length + 4));
  const rule = "=".repeat(width);
  console.log(rule);
  for (const line of lines) {
    console.log(`  ${line}`);
  }
  console.log(rule);
}
