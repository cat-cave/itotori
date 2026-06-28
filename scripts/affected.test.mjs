import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { affectedTasks } from "./affected.mjs";

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
  const recipeStart = lines.findIndex((line) => line === `${recipeName}:`);
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
