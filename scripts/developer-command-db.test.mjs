// @itotori-meta-check
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

function copyDeveloperCommand(fixture) {
  const scripts = path.join(fixture, "scripts");
  const ci = path.join(scripts, "ci");
  mkdirSync(ci, { recursive: true });
  copyFileSync("scripts/developer-command.mjs", path.join(scripts, "developer-command.mjs"));
  copyFileSync("scripts/ci/lane-routing.mjs", path.join(ci, "lane-routing.mjs"));
  copyFileSync("scripts/ci/test-ownership.mjs", path.join(ci, "test-ownership.mjs"));
}

function copyLifecycle(fixture) {
  const scripts = path.join(fixture, "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const file of [
    "itotori-db-lifecycle.mjs",
    "itotori-db-compose-env.mjs",
    "itotori-db-wait.mjs",
  ]) {
    copyFileSync(path.join("scripts", file), path.join(scripts, file));
  }
}

test("db-up delegates to the declared lifecycle and writes a worktree compose env", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "itotori-db-up-"));
  try {
    const bin = path.join(fixture, "bin");
    mkdirSync(bin);
    copyDeveloperCommand(fixture);
    copyLifecycle(fixture);
    // Lifecycle shells out to docker; stub it so the unit test stays offline.
    const docker = path.join(bin, "docker");
    writeFileSync(
      docker,
      `#!/bin/sh
printf "%s\\n" "$@" >> docker-invocation
if [ "$1" = "compose" ] && echo "$*" | grep -q "ps -q"; then
  printf 'stub-container\\n'
  exit 0
fi
if [ "$1" = "inspect" ]; then
  printf 'healthy\\n'
  exit 0
fi
exit 0
`,
    );
    chmodSync(docker, 0o755);

    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
    delete env.ITOTORI_DB_COMPOSE_ENV_PATH;
    delete env.DATABASE_URL;
    env.ITOTORI_DB_WORKTREE_ROOT = fixture;

    const result = spawnSync(process.execPath, ["scripts/developer-command.mjs", "dev", "db-up"], {
      cwd: fixture,
      encoding: "utf8",
      env,
    });

    assert.equal(result.status, 0, result.stderr + result.stdout);
    const composeEnv = readFileSync(path.join(fixture, ".tmp/itotori-db/compose.env"), "utf8");
    assert.match(composeEnv, /^ITOTORI_DB_HOST_PORT='\d+'$/mu);
    assert.match(composeEnv, /^ITOTORI_DB_WORKTREE_ROOT=/mu);
    // Ambient DATABASE_URL must not have been required to derive the port.
    assert.match(
      result.stdout,
      /DATABASE_URL=postgres:\/\/itotori:itotori@127\.0\.0\.1:\d+\/itotori/u,
    );
    const invocation = readFileSync(path.join(fixture, "docker-invocation"), "utf8");
    assert.match(
      invocation,
      /compose\n--env-file\n\.tmp\/itotori-db\/compose\.env\nup\n-d\npostgres/u,
    );
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("db-up ignores ambient DATABASE_URL when declaring the worktree port", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "itotori-db-up-ambient-"));
  try {
    const bin = path.join(fixture, "bin");
    mkdirSync(bin);
    copyDeveloperCommand(fixture);
    copyLifecycle(fixture);
    const docker = path.join(bin, "docker");
    writeFileSync(
      docker,
      `#!/bin/sh
printf "%s\\n" "$@" >> docker-invocation
if [ "$1" = "compose" ] && echo "$*" | grep -q "ps -q"; then printf 'c\\n'; exit 0; fi
if [ "$1" = "inspect" ]; then printf 'healthy\\n'; exit 0; fi
exit 0
`,
    );
    chmodSync(docker, 0o755);

    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      // Stale ambient URL on a foreign port — must not become this worktree's stack.
      DATABASE_URL: "postgres://itotori:itotori@127.0.0.1:57171/itotori",
      ITOTORI_DB_WORKTREE_ROOT: fixture,
    };
    delete env.ITOTORI_DB_COMPOSE_ENV_PATH;

    const result = spawnSync(process.execPath, ["scripts/developer-command.mjs", "dev", "db-up"], {
      cwd: fixture,
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const composeEnv = readFileSync(path.join(fixture, ".tmp/itotori-db/compose.env"), "utf8");
    assert.doesNotMatch(composeEnv, /ITOTORI_DB_HOST_PORT='57171'/u);
    assert.doesNotMatch(result.stdout, /:57171\//u);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("db-sweep is a declared development selector", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "itotori-db-sweep-"));
  try {
    const bin = path.join(fixture, "bin");
    mkdirSync(bin);
    copyDeveloperCommand(fixture);
    copyLifecycle(fixture);
    const docker = path.join(bin, "docker");
    writeFileSync(docker, "#!/bin/sh\nprintf ''\nexit 0\n");
    chmodSync(docker, 0o755);

    const result = spawnSync(
      process.execPath,
      ["scripts/developer-command.mjs", "dev", "db-sweep"],
      {
        cwd: fixture,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /db-sweep:/u);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});
