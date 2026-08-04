import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executedTestCount, selectProofs } from "./real-bytes-lane.mjs";
import { REAL_BYTES_PROOF_SCHEMA, discoverRealBytesProofs } from "./real-bytes-proof-manifest.mjs";

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
    new Set(siglus.proofs.map((proof) => proof.package)),
    new Set(["kaifuu-siglus", "utsushi-siglus"]),
  );
  assert.ok(
    siglus.proofs.some(
      (proof) => proof.target === "scene_vm_real_bytes" && !proof.args.includes("--ignored"),
    ),
    "the non-ignored execution-frontier proof must still run directly",
  );
  assert.ok(
    siglus.proofs.some(
      (proof) => proof.package === "utsushi-siglus" && proof.mode === "all-ignored",
    ),
    "the package-wide ignored proof convention must cover each ignored Utsushi proof",
  );
});

test("real-byte declarations derive cargo commands and reject a missing adjacent declaration", () => {
  const root = mkdtempSync(join(tmpdir(), "itotori-real-bytes-declaration-"));
  const crate = join(root, "crates/demo");
  const testFile = join(crate, "tests/live_real_bytes.rs");
  try {
    mkdirSync(join(crate, "tests"), { recursive: true });
    writeFileSync(
      join(crate, "Cargo.toml"),
      '[package]\n# @itotori-real-bytes-package\nname = "demo"\nversion = "0.0.0"\n',
    );
    writeFileSync(
      join(crate, "Cargo.toml.real-bytes-proof.json"),
      `${JSON.stringify({ schema: REAL_BYTES_PROOF_SCHEMA, engine: "demo", mode: "all-ignored" })}\n`,
    );
    writeFileSync(testFile, "// @itotori-real-bytes-proof\n");

    assert.throws(
      () => discoverRealBytesProofs(root),
      /real-bytes proof has no adjacent declaration/u,
    );

    writeFileSync(
      `${testFile}.real-bytes-proof.json`,
      `${JSON.stringify({ schema: REAL_BYTES_PROOF_SCHEMA, engine: "demo", mode: "default" })}\n`,
    );
    const proofs = discoverRealBytesProofs(root);
    assert.deepEqual(
      proofs.map(({ args }) => args),
      [
        ["test", "-p", "demo", "--", "--ignored"],
        ["test", "-p", "demo", "--test", "live_real_bytes"],
      ],
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a cargo receipt with zero passed tests is distinguishable from execution", () => {
  assert.equal(executedTestCount("test result: ok. 0 passed; 0 failed;"), 0);
  assert.equal(executedTestCount("test result: ok. 3 passed; 0 failed;"), 3);
});

test("the Kaifuu Siglus proof refuses missing declared titles", () => {
  const configHome = mkdtempSync(join(tmpdir(), "itotori-empty-config-"));
  try {
    const result = spawnSync(
      "cargo",
      ["test", "-p", "kaifuu-siglus", "--test", "siglus_gameexe_dat_real_bytes", "--", "--ignored"],
      {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: { ...process.env, XDG_CONFIG_HOME: configHome },
      },
    );
    assert.notEqual(result.status, 0, "missing input must not receive a green Cargo receipt");
    assert.match(result.stdout + result.stderr, /REAL-BYTES SKIP .*siglus\/1\/encrypted/u);
  } finally {
    rmSync(configHome, { force: true, recursive: true });
  }
});

test("the Softpal Pal.dll proof has a missing-binary regression assertion", () => {
  const result = spawnSync(
    "cargo",
    [
      "test",
      "-p",
      "kaifuu-softpal",
      "--test",
      "pal_dll_loose_override_real",
      "missing_pal_dll_is_a_non_passing_required_input",
    ],
    {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: process.env,
    },
  );
  assert.equal(
    result.status,
    0,
    "the #[should_panic] assertion must receive the missing-input panic",
  );
  assert.match(result.stdout + result.stderr, /1 passed/u);
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
