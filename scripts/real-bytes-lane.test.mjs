import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { executedTestCount, selectProofs } from "./real-bytes-lane.mjs";

test("manifest engines select their own proof suites", () => {
  const proofs = selectProofs([
    { engine: "reallive", ordinal: 1, variant: "encrypted", path: "primary" },
    { engine: "siglus", ordinal: 1, variant: "encrypted", path: "secondary" },
  ]);

  assert.deepEqual(
    proofs.map(({ name, proofs: selected }) => [name, selected?.[0].args[2]]),
    [
      ["reallive", "kaifuu-reallive"],
      ["siglus", "kaifuu-siglus"],
    ],
  );
});

test("the declared Siglus engine selects Kaifuu and every Utsushi real-byte proof", () => {
  const [siglus] = selectProofs([
    { engine: "siglus", ordinal: 1, variant: "encrypted", path: "primary" },
  ]);
  assert.deepEqual(
    siglus.proofs.map((proof) => proof.name),
    [
      "kaifuu-siglus",
      "utsushi-siglus-observe",
      "utsushi-siglus-scene-vm",
      "utsushi-siglus-g00",
      "utsushi-siglus-structure",
      "utsushi-siglus-launch",
    ],
  );
});

test("a cargo receipt with zero passed tests is distinguishable from execution", () => {
  assert.equal(executedTestCount("test result: ok. 0 passed; 0 failed;"), 0);
  assert.equal(executedTestCount("test result: ok. 3 passed; 0 failed;"), 3);
});

function withoutRequiredInput(...names) {
  const env = { ...process.env };
  for (const name of names) delete env[name];
  return env;
}

test("the Kaifuu Siglus proof refuses missing declared titles", () => {
  const result = spawnSync(
    "cargo",
    ["test", "-p", "kaifuu-siglus", "--test", "siglus_gameexe_dat_real_bytes"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8", env: withoutRequiredInput("ITOTORI_REAL_GAME_ROOT_SIGLUS", "ITOTORI_REAL_GAME_ROOT_SIGLUS_2") },
  );
  assert.notEqual(result.status, 0, "missing input must not receive a green Cargo receipt");
  assert.match(result.stdout + result.stderr, /REAL-BYTES SKIP .*siglus\/1\/encrypted/u);
});

test("the Softpal Pal.dll proof refuses a missing named binary", () => {
  const result = spawnSync(
    "cargo",
    ["test", "-p", "kaifuu-softpal", "--test", "pal_dll_loose_override_real", "--", "--ignored"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8", env: withoutRequiredInput("ITOTORI_SOFTPAL_RESEARCH_ROOT") },
  );
  assert.notEqual(result.status, 0, "missing Pal.dll must not receive a green Cargo receipt");
  assert.match(result.stdout + result.stderr, /REAL-BYTES SKIP .*softpal\/Pal\.dll/u);
});

test("an engine without a proof is named as declared but unproven", () => {
  assert.deepEqual(
    selectProofs([{ engine: "unproven", ordinal: 1, variant: "plain", path: "." }]),
    [
      {
        name: "unproven",
        outcome: "failed",
        reason: "declared but unproven engine unproven",
      },
    ],
  );
});
