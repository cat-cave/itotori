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

test("db-up supplies its generated default compose env path to Docker", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "itotori-db-up-"));
  try {
    const bin = path.join(fixture, "bin");
    const scripts = path.join(fixture, "scripts");
    mkdirSync(bin);
    mkdirSync(scripts);
    copyFileSync("scripts/developer-command.mjs", path.join(scripts, "developer-command.mjs"));
    copyFileSync(
      "scripts/itotori-db-compose-env.mjs",
      path.join(scripts, "itotori-db-compose-env.mjs"),
    );
    const docker = path.join(bin, "docker");
    writeFileSync(docker, '#!/bin/sh\nprintf "%s\\n" "$@" > docker-invocation\n');
    chmodSync(docker, 0o755);

    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
    delete env.ITOTORI_DB_COMPOSE_ENV_PATH;
    const result = spawnSync(process.execPath, ["scripts/developer-command.mjs", "dev", "db-up"], {
      cwd: fixture,
      encoding: "utf8",
      env,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      readFileSync(path.join(fixture, ".tmp/itotori-db/compose.env"), "utf8"),
      /^ITOTORI_DB_HOST_PORT='\d+'$/mu,
    );
    assert.deepEqual(
      readFileSync(path.join(fixture, "docker-invocation"), "utf8").trim().split("\n"),
      ["compose", "--env-file", ".tmp/itotori-db/compose.env", "up", "-d", "postgres"],
    );
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});
