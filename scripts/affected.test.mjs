import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { affectedCiLanes, affectedTasks, buildCrateFamilyDependents } from "./affected.mjs";
import { selectLanes } from "./qd-full-ci.mjs";

function parseWorkspaceMembers(cargoToml) {
  const match = cargoToml.match(/^\[workspace\][\s\S]*?^members\s*=\s*\[([\s\S]*?)^\]/m);
  assert.ok(match, "Cargo.toml must declare workspace members");

  return [...match[1].matchAll(/"([^"]+)"/g)].map((member) => member[1]);
}

function parsePackageName(crateManifest) {
  let inPackageSection = false;

  for (const line of crateManifest.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "[package]") {
      inPackageSection = true;
      continue;
    }
    if (inPackageSection && trimmed.startsWith("[") && trimmed.endsWith("]")) {
      break;
    }

    const name = inPackageSection ? trimmed.match(/^name\s*=\s*"([^"]+)"/) : null;
    if (name) {
      return name[1];
    }
  }

  assert.fail("crate manifest must declare a [package] name");
}

function workspacePackagesByPrefix(prefix) {
  return parseWorkspaceMembers(readFileSync("Cargo.toml", "utf8"))
    .filter((member) => member.startsWith(`crates/${prefix}`))
    .map((member) => parsePackageName(readFileSync(`${member}/Cargo.toml`, "utf8")));
}

function parseJustRecipeBody(justfile, recipeName) {
  const lines = justfile.split(/\r?\n/);
  const recipeStart = lines.findIndex((line) => line.startsWith(`${recipeName}:`));
  assert.notEqual(recipeStart, -1, `justfile must declare ${recipeName}`);

  const body = [];
  for (const line of lines.slice(recipeStart + 1)) {
    if (/^[A-Za-z0-9_-][^:]*:/.test(line)) {
      break;
    }
    body.push(line);
  }
  return body.join("\n");
}

function parseCargoTestPackages(recipeBody) {
  return new Set(
    [...recipeBody.matchAll(/^\s*cargo\s+test\b.*$/gm)].flatMap((line) =>
      [...line[0].matchAll(/-p\s+([^\s]+)/g)].map((pkg) => pkg[1]),
    ),
  );
}

test("kaifuu and utsushi CI gates cover every matching workspace crate", () => {
  const justfile = readFileSync("justfile", "utf8");
  const expectations = [
    ["kaifuu-", "ci-kaifuu"],
    ["utsushi-", "ci-utsushi"],
  ];

  for (const [prefix, recipe] of expectations) {
    const workspacePackages = workspacePackagesByPrefix(prefix);
    const coveredPackages = parseCargoTestPackages(parseJustRecipeBody(justfile, recipe));
    const uncovered = workspacePackages.filter((pkg) => !coveredPackages.has(pkg));

    assert.deepEqual(uncovered, [], `${recipe} must cover all crates/${prefix} workspace packages`);
  }
});

test("affected routes representative kaifuu crate changes to ci-kaifuu", () => {
  assert.deepEqual(affectedTasks(["crates/kaifuu-reallive/src/lib.rs"]), ["ci-kaifuu"]);
  assert.deepEqual(affectedTasks(["crates/kaifuu-vault-source/src/lib.rs"]), ["ci-kaifuu"]);
});

test("affected routes representative utsushi crate changes to ci-utsushi", () => {
  assert.deepEqual(affectedTasks(["crates/utsushi-reallive/src/lib.rs"]), ["ci-utsushi"]);
  assert.deepEqual(affectedTasks(["crates/utsushi-siglus/src/lib.rs"]), ["ci-utsushi"]);
});

test("affected routes localize-project suite script changes to its node test gate", () => {
  assert.deepEqual(affectedTasks(["suite/scripts/localize-project/run.mjs"]), [
    "localize-project-test",
  ]);
  assert.deepEqual(affectedTasks(["suite/scripts/localize-project/verify-artifacts.mjs"]), [
    "localize-project-test",
  ]);
  assert.deepEqual(
    affectedTasks(["suite/scripts/localize-project/run.mjs", "unowned-tooling/file.txt"]),
    ["check"],
  );
});

test("check gate runs localize-project node tests", () => {
  const justfile = readFileSync("justfile", "utf8");
  const checkBody = parseJustRecipeBody(justfile, "check");
  const localizeProjectTestBody = parseJustRecipeBody(justfile, "localize-project-test");

  assert.match(checkBody, /^\s*just localize-project-test$/m);
  assert.match(
    localizeProjectTestBody,
    /^\s*node --test suite\/scripts\/localize-project\/\*\.test\.mjs$/m,
  );
});

// ---------------------------------------------------------------------------
// qd-full-ci affected-lane selection (affectedCiLanes / buildCrateFamilyDependents)
// ---------------------------------------------------------------------------

test("crate family dependency graph: utsushi depends on kaifuu, nothing depends on utsushi", () => {
  const dependents = buildCrateFamilyDependents();
  // A kaifuu change must also run the utsushi family (utsushi crates depend on kaifuu).
  assert.deepEqual([...(dependents.get("kaifuu") ?? [])], ["utsushi"]);
  // Nothing depends on the utsushi family, so a utsushi change stays within utsushi.
  assert.equal(dependents.has("utsushi"), false);
});

test("qd-full-ci lanes: apps/itotori-only diff excludes the rust build/test + mutation-differential lanes", () => {
  const lanes = affectedCiLanes(["apps/itotori/src/server.ts"]);
  assert.ok(lanes.includes("ci-itotori"), "itotori change runs the itotori gate");
  assert.ok(lanes.includes("check"), "itotori change still runs the base check gate");
  assert.ok(
    !lanes.includes("mutation-differential"),
    "itotori-only must NOT run the rust mutation-differential lane",
  );
  assert.ok(!lanes.includes("ci-real-bytes"), "per-gate CI never runs the real-bytes lane");
  assert.ok(!lanes.includes("ci-kaifuu"));
  assert.ok(!lanes.includes("ci-utsushi"));
  assert.ok(!lanes.includes("ci"), "itotori-only must NOT escalate to the full ci gate");
});

test("qd-full-ci lanes: a packages/itotori-db diff also stays off the rust mutation-differential lane", () => {
  const lanes = affectedCiLanes(["packages/itotori-db/src/index.ts"]);
  assert.ok(lanes.includes("ci-itotori"));
  assert.ok(!lanes.includes("mutation-differential"));
});

test("qd-full-ci lanes: a utsushi crate diff includes the utsushi rust + mutation-differential lanes (synthetic; NO real-bytes)", () => {
  const lanes = affectedCiLanes(["crates/utsushi-reallive/src/lib.rs"]);
  assert.ok(lanes.includes("ci-utsushi"), "utsushi change runs the utsushi gate");
  assert.ok(
    lanes.includes("mutation-differential"),
    "utsushi change runs the synthetic differential guardrail",
  );
  assert.ok(!lanes.includes("ci-real-bytes"), "per-gate CI is copyright-free — no real-bytes lane");
  assert.ok(lanes.includes("check"));
  assert.ok(!lanes.includes("ci"), "a crate change must not escalate to the full ci sentinel");
});

test("qd-full-ci lanes: a kaifuu crate diff runs kaifuu AND utsushi (dep direction) + mutation-differential", () => {
  const lanes = affectedCiLanes(["crates/kaifuu-reallive/src/lib.rs"]);
  assert.ok(lanes.includes("ci-kaifuu"));
  assert.ok(
    lanes.includes("ci-utsushi"),
    "utsushi depends on kaifuu, so a kaifuu change must also run utsushi's lane",
  );
  assert.ok(lanes.includes("mutation-differential"));
  assert.ok(!lanes.includes("ci-real-bytes"));
});

test("qd-full-ci lanes: a shared-file diff selects the full ci gate (everything)", () => {
  assert.deepEqual(affectedCiLanes(["justfile"]), ["ci"]);
  assert.deepEqual(affectedCiLanes(["Cargo.toml"]), ["ci"]);
  assert.deepEqual(affectedCiLanes(["Cargo.lock"]), ["ci"]);
  assert.deepEqual(affectedCiLanes(["scripts/qd-full-ci.mjs"]), ["ci"]);
  assert.deepEqual(affectedCiLanes([".github/workflows/ci.yml"]), ["ci"]);
});

test("qd-full-ci lanes: a docs-only diff selects no build/real-bytes lane", () => {
  assert.deepEqual(affectedCiLanes(["docs/foo.md"]), []);
  assert.deepEqual(affectedCiLanes(["README.md"]), []);
});

test("qd-full-ci lanes: a repo-root fixtures/ diff selects the rust lanes incl mutation-differential + ci-itotori", () => {
  const lanes = affectedCiLanes(["fixtures/kaifuu/kirikiri/plain.xp3"]);
  // Root fixtures are byte-asserted by rust tests (kaifuu + utsushi read repo_fixture_path)
  // AND by ~18 apps/itotori vitest files (via ../../../fixtures/), neither of which runs
  // under `just check`, so a fixture-byte change must run BOTH sets of test lanes.
  assert.ok(
    lanes.includes("mutation-differential"),
    "root fixtures change must run the synthetic differential guardrail",
  );
  assert.ok(!lanes.includes("ci-real-bytes"), "per-gate CI never runs the real-bytes lane");
  assert.ok(lanes.includes("ci-kaifuu"), "root fixtures change must run the kaifuu rust lane");
  assert.ok(lanes.includes("ci-utsushi"), "root fixtures change must run the utsushi rust lane");
  assert.ok(
    lanes.includes("ci-itotori"),
    "root fixtures change must run the ci-itotori lane (apps/itotori vitest byte-asserts fixtures/)",
  );
  assert.ok(
    lanes.includes("fixtures-validate"),
    "root fixtures change still runs fixtures-validate",
  );
  assert.ok(!lanes.includes("ci"), "stays fine-grained, not the full ci sentinel");
});

test("qd-full-ci lanes: package-local (apps/itotori) fixtures stay itotori-only (no real-bytes)", () => {
  const lanes = affectedCiLanes(["apps/itotori/test/fixtures/agentic-loop-smoke-bridge.json"]);
  assert.ok(lanes.includes("ci-itotori"));
  assert.ok(
    !lanes.includes("mutation-differential"),
    "package-local fixtures are not read by rust",
  );
  assert.ok(!lanes.includes("ci-kaifuu"));
  assert.ok(!lanes.includes("ci-utsushi"));
});

test("qd-full-ci selectLanes: an undeterminable diff falls back to the full ci gate", () => {
  // A directory that is not a git worktree cannot be diffed, so selection is
  // conservative: the complete ci gate, never a pruned subset.
  const noGitDir = mkdtempSync(path.join(os.tmpdir(), "affected-nogit-"));
  assert.deepEqual(selectLanes(noGitDir, {}, ["node", "qd-full-ci"]), ["ci"]);
});

test("affected + lanes: a presets/ diff selects ci-itotori AND localize-project-test (both read it)", () => {
  // presets/localize-project.pair-policy.json is consumed by BOTH the ci-itotori
  // localize-project-stage vitest AND suite/scripts/localize-project/run.test.mjs
  // (which runs only under the localize-project-test lane); `just check` runs
  // neither, so a preset change must select both fine-grained lanes.
  assert.deepEqual(affectedTasks(["presets/localize-project.pair-policy.json"]), [
    "ci-itotori",
    "localize-project-test",
  ]);
  const lanes = affectedCiLanes(["presets/localize-project.pair-policy.json"]);
  assert.ok(lanes.includes("ci-itotori"), "preset change must run the ci-itotori lane");
  assert.ok(
    lanes.includes("localize-project-test"),
    "preset change must run the localize-project-test lane (run.test.mjs reads the preset)",
  );
  assert.ok(lanes.includes("check"), "preset change still runs the base check gate");
  assert.ok(!lanes.includes("ci"), "preset change stays fine-grained, not the full ci sentinel");
});

test("affected + lanes: the alpha-public-fixture + iteration suites select alpha-proof (the gate that executes them)", () => {
  for (const p of [
    "suite/scripts/alpha-public-fixture/run.mjs",
    "suite/scripts/itotori-fixture-iteration/schema-validate.mjs",
    "suite/scripts/itotori-iteration-fixture/schema-validate.mjs",
  ]) {
    assert.deepEqual(affectedTasks([p]), ["alpha-proof"], `${p} routes to alpha-proof`);
    const lanes = affectedCiLanes([p]);
    assert.ok(lanes.includes("alpha-proof"), `${p} lane selection includes alpha-proof`);
    assert.ok(!lanes.includes("ci"), `${p} stays fine-grained, not the full ci sentinel`);
  }
});

test("alpha-proof runs every alpha and iteration sibling Node unit suite", () => {
  const justfile = readFileSync("justfile", "utf8");
  const alphaProofBody = parseJustRecipeBody(justfile, "alpha-proof");
  const unitTestBody = parseJustRecipeBody(justfile, "alpha-iteration-unit-test");

  assert.match(justfile, /^alpha-proof: alpha-iteration-unit-test$/m);
  assert.match(alphaProofBody, /^\s*pnpm exec vp run alpha:public-fixture$/m);
  assert.match(
    unitTestBody,
    /^\s*node --test suite\/scripts\/alpha-public-fixture\/\*\.test\.mjs suite\/scripts\/itotori-fixture-iteration\/\*\.test\.mjs suite\/scripts\/itotori-iteration-fixture\/\*\.test\.mjs$/m,
  );
});

test("affected + lanes: a packages/spec-dag-dashboard diff selects the full ci gate", () => {
  // spec-dag-dashboard vitest (incl. the ci-Postgres db-audit-findings suite)
  // runs in no fine-grained lane, only the full `ci` gate's recursive test run.
  assert.deepEqual(affectedTasks(["packages/spec-dag-dashboard/src/generate.ts"]), ["ci"]);
  assert.deepEqual(affectedCiLanes(["packages/spec-dag-dashboard/src/generate.ts"]), ["ci"]);
  assert.deepEqual(
    affectedCiLanes(["packages/spec-dag-dashboard/test/db-audit-findings.test.ts"]),
    ["ci"],
  );
});

test("qd-full-ci lanes: an itotori + utsushi diff runs both gates + mutation-differential but not full ci", () => {
  const lanes = affectedCiLanes(["apps/itotori/src/server.ts", "crates/utsushi-siglus/src/lib.rs"]);
  assert.ok(lanes.includes("ci-itotori"));
  assert.ok(lanes.includes("ci-utsushi"));
  assert.ok(lanes.includes("mutation-differential"));
  assert.ok(!lanes.includes("ci-real-bytes"));
  assert.ok(!lanes.includes("ci"));
});
