// @itotori-meta-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isProductDatabaseContainer,
  isProductDatabaseLookalike,
  ProductDatabaseNotRunningError,
  requireDatabaseUrl,
  sweep,
} from "./itotori-db-lifecycle.mjs";
import { resolveWorktreeDatabaseUrl } from "./itotori-db-compose-env.mjs";
import {
  allocateHostPort,
  candidatePorts,
  HostPortUnavailableError,
} from "./itotori-db-host-port.mjs";

const commandSurface = readFileSync("scripts/developer-command.mjs", "utf8");
const compose = readFileSync("docker-compose.yml", "utf8");
const flake = readFileSync("flake.nix", "utf8");
const lifecycle = readFileSync("scripts/itotori-db-lifecycle.mjs", "utf8");
const hostPort = readFileSync("scripts/itotori-db-host-port.mjs", "utf8");

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

test("lifecycle allocates via bind-checked host-port module (no raw name-pattern reap)", () => {
  assert.match(lifecycle, /allocateHostPort/u);
  assert.match(lifecycle, /HostPortUnavailableError/u);
  assert.match(hostPort, /isPortBindable/u);
  assert.match(hostPort, /candidatePorts/u);
  // Sweep reaps only the product-db label — not a container name pattern.
  assert.doesNotMatch(lifecycle, /_postgres_1/u);
  assert.match(lifecycle, /PRODUCT_DB_LABEL/u);
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

test("sweep removes only labeled orphans; reports unlabeled foreign containers", () => {
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
          managed: true,
          productDb: true,
        },
        {
          id: "live1",
          name: "itotori-live_postgres_1",
          worktreeRoot: "/scratch/worktrees/itotori-live",
          managed: true,
          productDb: true,
        },
        {
          id: "foreign",
          name: "itotori-budget-validation-pg",
          worktreeRoot: "",
          managed: false,
          productDb: false,
        },
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
  assert.equal(result.reported.length, 1);
  assert.match(logs.join("\n"), /swept orphan.*itotori-gone/u);
  assert.match(logs.join("\n"), /reporting unlabeled.*itotori-budget-validation-pg/u);
  assert.match(logs.join("\n"), /removed 1 orphan/u);
});

test("isProductDatabaseContainer requires the lifecycle label (not a name pattern)", () => {
  assert.equal(isProductDatabaseContainer({ productDb: "1" }), true);
  assert.equal(isProductDatabaseContainer({ productDb: "" }), false);
  assert.equal(isProductDatabaseContainer({ productDb: undefined }), false);
});

test("isProductDatabaseLookalike recognizes unlabeled itotori stacks for reporting only", () => {
  assert.equal(
    isProductDatabaseLookalike({
      project: "itotori-itotori-noskip2",
      configFiles: "docker-compose.yml",
      service: "postgres",
      workdir: "/scratch/worktrees/itotori-noskip2",
    }),
    true,
  );
  assert.equal(
    isProductDatabaseLookalike({
      project: "tanren",
      configFiles: "compose.dev.yml",
      service: "postgres",
      workdir: "/home/trevor/projects/tanren",
    }),
    false,
  );
});

test("candidatePorts walks forward from preferred and wraps within the span", () => {
  assert.deepEqual(
    candidatePorts(56005, { base: 56000, span: 10 }),
    [56005, 56006, 56007, 56008, 56009, 56000, 56001, 56002, 56003, 56004],
  );
});

test("allocateHostPort on explicit busy port fails typed naming the holder", async () => {
  const root = "/scratch/worktrees/itotori-port-alloc-fixture";
  const preferred = 62003;
  const pinned = await allocateHostPort(
    root,
    {
      ITOTORI_DB_WORKTREE_ROOT: root,
      ITOTORI_DB_HOST_PORT: String(preferred),
      ITOTORI_DB_HOST_PORT_BASE: "62000",
      ITOTORI_DB_HOST_PORT_SPAN: "10",
    },
    {
      isBindable: async () => false,
      describeHolder: (port) => ({
        port,
        identity: `fixture-holder-${port}`,
        kind: "container",
      }),
    },
  ).then(
    () => {
      throw new Error("explicit busy port must not allocate");
    },
    (error) => error,
  );
  assert.ok(pinned instanceof HostPortUnavailableError);
  assert.equal(pinned.code, "host-port-unavailable");
  assert.equal(pinned.preferredPort, preferred);
  assert.deepEqual(pinned.portsTried, [preferred]);
  assert.match(pinned.message, /fixture-holder-62003/u);
  assert.match(pinned.message, /itotori-port-alloc-fixture/u);
});

test("allocateHostPort probes forward from preferred when early candidates are busy", async () => {
  const root = "/scratch/worktrees/itotori-port-probe-fixture";
  const env = {
    ITOTORI_DB_WORKTREE_ROOT: root,
    ITOTORI_DB_HOST_PORT_BASE: "62000",
    ITOTORI_DB_HOST_PORT_SPAN: "10",
  };
  let call = 0;
  const sequence = [false, false, true]; // busy, busy, free
  const probed = await allocateHostPort(root, env, {
    isBindable: async () => sequence[Math.min(call++, sequence.length - 1)],
    describeHolder: (port) => ({ port, identity: `skip-${port}`, kind: "process" }),
  });
  assert.equal(probed.portsTried.length, 3);
  assert.equal(probed.skipped.length, 2);
  assert.ok(probed.port >= 62000 && probed.port < 62010);
  assert.notEqual(probed.port, probed.preferredPort);
});

test("allocateHostPort is deterministic: same free preferred always wins", async () => {
  const root = "/scratch/worktrees/itotori-port-determinism";
  const env = {
    ITOTORI_DB_WORKTREE_ROOT: root,
    ITOTORI_DB_HOST_PORT_BASE: "63000",
    ITOTORI_DB_HOST_PORT_SPAN: "20",
  };
  const a = await allocateHostPort(root, env, { isBindable: async () => true });
  const b = await allocateHostPort(root, env, { isBindable: async () => true });
  assert.equal(a.port, b.port);
  assert.equal(a.port, a.preferredPort);
});
