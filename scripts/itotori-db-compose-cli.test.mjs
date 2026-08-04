import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { composeEnvValues, renderComposeEnvFile } from "./itotori-db-compose-env.mjs";

// This is an integration proof for Docker Compose's compose-go semantics. It
// belongs to ci-tier1-db, whose runner provides Docker; a missing or podman
// substitute is a loud failed proof, never a skipped test.
test("docker compose config preserves a $-bearing generated credential", () => {
  let composeVersion;
  try {
    composeVersion = execFileSync("docker", ["compose", "version"], { encoding: "utf8" });
  } catch (error) {
    assert.fail(
      `Docker Compose is required for the DB compose integration proof: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  assert.doesNotMatch(
    composeVersion,
    /podman/iu,
    "DB compose integration proof requires Docker Compose, not podman-compose's divergent dotenv parser",
  );

  const dir = mkdtempSync(path.join(tmpdir(), "univ022-compose-"));
  writeFileSync(
    path.join(dir, "docker-compose.yml"),
    [
      "services:",
      "  postgres:",
      "    image: postgres:18",
      "    environment:",
      "      POSTGRES_PASSWORD: ${ITOTORI_DB_PASSWORD:-itotori}",
      "",
    ].join("\n"),
  );

  for (const credential of ["p$4ssw0rd", "a$$b", "sp ace$x", 'q"q$y', "back\\slash$z"]) {
    const values = composeEnvValues({
      DATABASE_URL: `postgres://itotori:${encodeURIComponent(credential)}@127.0.0.1:56000/itotori`,
    });
    writeFileSync(path.join(dir, "gen.env"), renderComposeEnvFile(values));
    const out = execFileSync(
      "docker",
      ["compose", "--env-file", "gen.env", "config", "--format", "json"],
      { cwd: dir, encoding: "utf8" },
    );
    const environment = JSON.parse(out).services?.postgres?.environment;
    const resolved = Array.isArray(environment)
      ? environment
          .find((entry) => entry.startsWith("POSTGRES_PASSWORD="))
          ?.slice("POSTGRES_PASSWORD=".length)
      : environment?.POSTGRES_PASSWORD;
    const expected = credential.split("$").join("$$");
    assert.equal(
      resolved,
      expected,
      `compose config must resolve POSTGRES_PASSWORD to ${JSON.stringify(credential)} ` +
        `(reported with compose's $->$$ output escaping as ${JSON.stringify(expected)})`,
    );
  }
});
