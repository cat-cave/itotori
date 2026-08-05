// @itotori-meta-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isProductDatabaseContainer,
  ProductDatabaseNotRunningError,
  requireDatabaseUrl,
  sweep,
} from "./itotori-db-lifecycle.mjs";
import { resolveWorktreeDatabaseUrl } from "./itotori-db-compose-env.mjs";

const commandSurface = readFileSync("scripts/developer-command.mjs", "utf8");
const compose = readFileSync("docker-compose.yml", "utf8");
const flake = readFileSync("flake.nix", "utf8");

test("developer-command wires db-up/down/sweep through the lifecycle", () => {
  assert.match(commandSurface, /itotori-db-lifecycle\.mjs", "up"/u);
  assert.match(commandSurface, /itotori-db-lifecycle\.mjs", "down"/u);
  assert.match(commandSurface, /itotori-db-lifecycle\.mjs", "sweep"/u);
  assert.match(commandSurface, /itotori-db-lifecycle\.mjs require-database-url/u);
});

test("compose declares product-db labels for lifecycle sweep", () => {
  assert.match(compose, /com\.itotori\.product-db: "1"/u);
  assert.match(compose, /com\.itotori\.worktree-root: \$\{ITOTORI_DB_WORKTREE_ROOT/u);
});

test("devshell does not ambiently export DATABASE_URL", () => {
  assert.doesNotMatch(flake, /export DATABASE_URL=/u);
  assert.match(flake, /ITOTORI_DB_WORKTREE_ROOT/u);
});

test("requireDatabaseUrl throws a typed error naming just dev db-up when down", () => {
  const root = "/scratch/worktrees/itotori-lifecycle-absent";
  assert.throws(
    () => requireDatabaseUrl({ ITOTORI_DB_WORKTREE_ROOT: root }, { isUp: () => false }),
    (error) => {
      assert.ok(error instanceof ProductDatabaseNotRunningError);
      assert.equal(error.code, "product-database-not-running");
      assert.equal(error.remediation, "just dev db-up");
      assert.match(error.message, /just dev db-up/u);
      assert.match(error.message, /itotori-lifecycle-absent/u);
      return true;
    },
  );
});

test("requireDatabaseUrl returns the worktree-declared URL when up (ignores ambient)", () => {
  const root = "/scratch/worktrees/itotori-lifecycle-present";
  const env = {
    ITOTORI_DB_WORKTREE_ROOT: root,
    DATABASE_URL: "postgres://itotori:itotori@127.0.0.1:57171/itotori",
  };
  const url = requireDatabaseUrl(env, { isUp: () => true });
  assert.equal(url, resolveWorktreeDatabaseUrl(env));
  assert.doesNotMatch(url, /:57171\//u);
});

test("sweep removes containers whose worktree directory is gone and keeps live ones", () => {
  const removedIds = [];
  const logs = [];
  const result = sweep(
    {},
    {
      listContainers: () => [
        {
          id: "orphan1",
          name: "itotori-gone_postgres_1",
          worktreeRoot: "/scratch/worktrees/itotori-gone",
        },
        {
          id: "live1",
          name: "itotori-live_postgres_1",
          worktreeRoot: "/scratch/worktrees/itotori-live",
        },
        { id: "unlabeled", name: "other", worktreeRoot: "" },
      ],
      removeContainer: (id) => {
        removedIds.push(id);
      },
      directoryExists: (p) => p === "/scratch/worktrees/itotori-live",
      log: (line) => logs.push(line),
    },
  );

  assert.deepEqual(removedIds, ["orphan1"]);
  assert.equal(result.removed.length, 1);
  assert.equal(result.kept.length, 2);
  assert.match(logs.join("\n"), /swept orphan.*itotori-gone/u);
  assert.match(logs.join("\n"), /removed 1 orphan/u);
});

test("isProductDatabaseContainer recognizes labeled and legacy itotori stacks", () => {
  assert.equal(
    isProductDatabaseContainer({
      productDb: "1",
      project: "x",
      configFiles: "x",
      service: "x",
      workdir: "x",
    }),
    true,
  );
  assert.equal(
    isProductDatabaseContainer({
      productDb: "",
      project: "itotori-itotori-noskip2",
      configFiles: "docker-compose.yml",
      service: "postgres",
      workdir: "/scratch/worktrees/itotori-noskip2",
    }),
    true,
  );
  assert.equal(
    isProductDatabaseContainer({
      productDb: "",
      project: "tanren",
      configFiles: "compose.dev.yml",
      service: "postgres",
      workdir: "/home/trevor/projects/tanren",
    }),
    false,
  );
});
