import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("tier-one Rust selectors pass their distinct partition number to nextest", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "itotori-rust-partitions-"));
  try {
    const bin = path.join(fixture, "bin");
    const scripts = path.join(fixture, "scripts");
    const cargoLog = path.join(fixture, "cargo-invocation");
    mkdirSync(bin);
    mkdirSync(scripts);
    copyFileSync("scripts/developer-command.mjs", path.join(scripts, "developer-command.mjs"));
    const cargo = path.join(bin, "cargo");
    writeFileSync(cargo, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CARGO_LOG"\n');
    chmodSync(cargo, 0o755);

    for (const partition of [1, 2, 3]) {
      const result = spawnSync(
        process.execPath,
        ["scripts/developer-command.mjs", "ci", `tier1-rust-${partition}of3`],
        {
          cwd: fixture,
          encoding: "utf8",
          env: {
            ...process.env,
            CARGO_LOG: cargoLog,
            PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readFileSync(cargoLog, "utf8").trim().split("\n"), [
        "nextest",
        "run",
        "--workspace",
        "--partition",
        `hash:${partition}/3`,
      ]);
    }
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("doctor profiles reach native-deps through its profile flag", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "itotori-doctor-profile-"));
  try {
    const bin = path.join(fixture, "bin");
    const scripts = path.join(fixture, "scripts");
    const invocationLog = path.join(fixture, "native-deps-invocation");
    mkdirSync(bin);
    mkdirSync(scripts);
    copyFileSync("scripts/developer-command.mjs", path.join(scripts, "developer-command.mjs"));
    const node = path.join(bin, "node");
    writeFileSync(node, '#!/bin/sh\nprintf "%s\\n" "$@" > "$NATIVE_DEPS_LOG"\n');
    chmodSync(node, 0o755);

    const result = spawnSync(
      process.execPath,
      ["scripts/developer-command.mjs", "doctor", "render"],
      {
        cwd: fixture,
        encoding: "utf8",
        env: {
          ...process.env,
          NATIVE_DEPS_LOG: invocationLog,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(invocationLog, "utf8").trim().split("\n"), [
      "scripts/native-deps.mjs",
      "doctor",
      "--profile",
      "render",
    ]);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("tier-zero manifest lane fails when its local gate script is absent", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "itotori-manifest-gate-"));
  try {
    const scripts = path.join(fixture, "scripts");
    mkdirSync(scripts);
    copyFileSync("scripts/developer-command.mjs", path.join(scripts, "developer-command.mjs"));
    writeFileSync(path.join(scripts, "test-collection-guard.mjs"), "");

    const result = spawnSync(
      process.execPath,
      ["scripts/developer-command.mjs", "ci", "tier0-manifest"],
      { cwd: fixture, encoding: "utf8" },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /lane-manifest-gate\.mjs/u);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("tier-zero manifest lane runs live collection before the manifest gate", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "itotori-manifest-sequence-"));
  try {
    const bin = path.join(fixture, "bin");
    const scripts = path.join(fixture, "scripts");
    const invocationLog = path.join(fixture, "node-invocations");
    mkdirSync(bin);
    mkdirSync(scripts);
    copyFileSync("scripts/developer-command.mjs", path.join(scripts, "developer-command.mjs"));
    const node = path.join(bin, "node");
    writeFileSync(node, `#!/bin/sh\nprintf "%s\\n" "$*" >> "${invocationLog}"\n`);
    chmodSync(node, 0o755);

    const result = spawnSync(
      process.execPath,
      ["scripts/developer-command.mjs", "ci", "tier0-manifest", "--fixture"],
      {
        cwd: fixture,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(invocationLog, "utf8").trim().split("\n"), [
      "scripts/test-collection-guard.mjs",
      "scripts/ci/lane-manifest-gate.mjs --fixture",
    ]);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("tier-one behavior lane fails when its local proof runner is absent", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "itotori-behavior-gate-"));
  try {
    const scripts = path.join(fixture, "scripts");
    mkdirSync(scripts);
    copyFileSync("scripts/developer-command.mjs", path.join(scripts, "developer-command.mjs"));

    const result = spawnSync(
      process.execPath,
      ["scripts/developer-command.mjs", "ci", "tier1-behavior"],
      { cwd: fixture, encoding: "utf8" },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /run-behavior-proof\.mjs/u);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("tier-one behavior lane runs proof, local verification, and private-input contracts", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "itotori-behavior-sequence-"));
  try {
    const bin = path.join(fixture, "bin");
    const scripts = path.join(fixture, "scripts");
    const invocationLog = path.join(fixture, "bash-script");
    mkdirSync(bin);
    mkdirSync(scripts);
    copyFileSync("scripts/developer-command.mjs", path.join(scripts, "developer-command.mjs"));
    const bash = path.join(bin, "bash");
    writeFileSync(bash, `#!/bin/sh\nprintf "%s" "$5" > "${invocationLog}"\n`);
    chmodSync(bash, 0o755);

    const result = spawnSync(
      process.execPath,
      ["scripts/developer-command.mjs", "ci", "tier1-behavior"],
      {
        cwd: fixture,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(invocationLog, "utf8"),
      "node scripts/ci/run-behavior-proof.mjs\n" +
        "node scripts/ci/verify-behavior-gate.mjs --local-candidate\n" +
        "pnpm exec vp run private-input-contract:test",
    );
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("alpha readiness uses the supported public-fixture selector", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "itotori-alpha-selector-"));
  try {
    const bin = path.join(fixture, "bin");
    const scripts = path.join(fixture, "scripts");
    const invocationLog = path.join(fixture, "corepack-invocation");
    mkdirSync(bin);
    mkdirSync(scripts);
    copyFileSync("scripts/developer-command.mjs", path.join(scripts, "developer-command.mjs"));
    const corepack = path.join(bin, "corepack");
    writeFileSync(corepack, `#!/bin/sh\nprintf "%s\\n" "$@" > "${invocationLog}"\n`);
    chmodSync(corepack, 0o755);

    const result = spawnSync(process.execPath, ["scripts/developer-command.mjs", "test", "alpha"], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(invocationLog, "utf8").trim().split("\n"), [
      "pnpm",
      "--dir",
      "apps/itotori",
      "exec",
      "vitest",
      "run",
      "test/composition-reachability.test.ts",
      "--exclude",
      "**/.direnv/**",
    ]);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});
