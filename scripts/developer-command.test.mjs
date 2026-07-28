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
