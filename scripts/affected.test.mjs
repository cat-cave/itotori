// @itotori-meta-check
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

test("the parameterized test delegate covers every kaifuu and utsushi workspace crate", () => {
  const commandSurface = readFileSync("scripts/developer-command.mjs", "utf8");
  assert.match(commandSurface, /cargo test --workspace/u);
  for (const prefix of ["kaifuu-", "utsushi-"]) {
    assert.ok(
      workspacePackagesByPrefix(prefix).length > 0,
      `workspace must retain ${prefix} crates`,
    );
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

test("affected routes shared corpus registry changes to both rust families", () => {
  assert.deepEqual(affectedTasks(["crates/corpus-registry/src/lib.rs"]), [
    "ci-kaifuu",
    "ci-utsushi",
  ]);
});
