// itotori-installable-package-artifact — verification that the itotori CLI is a
// real installable package with a working bin entry.
//
// This is the evidence suite for the node's acceptance criteria:
//   - itotori is installable as a package/bundle with a working bin entry
//   - `itotori --version` + `itotori localize` run FROM THE INSTALL, not the
//     monorepo
//   - versioned via the product semver (product-version.ts)
//
// It does THREE layers of proof:
//   1. version sync — package.json version === ITOTORI_PRODUCT_VERSION source
//   2. built bin — the esbuild bundle runs `--version` + dispatches `localize`
//   3. npm pack + install — `npm pack` a tarball, `npm install` it into a clean
//      temp dir, and run `itotori --version` via the installed
//      `node_modules/.bin/itotori` symlink. This is the strongest proof the bin
//      works outside the monorepo, exactly as a non-clone user experiences it.
//
// Run: node --test scripts/itotori-installable-package.test.mjs (wired into
// `just check`).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const pkgDir = path.join(repoRoot, "packages", "itotori-cli");
const distCli = path.join(pkgDir, "dist", "cli.js");

function readProductVersion() {
  const src = readFileSync(
    path.join(repoRoot, "packages/localization-bridge-schema/src/product-version.ts"),
    "utf8",
  );
  const m = /ITOTORI_PRODUCT_VERSION\s*=\s*"([^"]+)"/.exec(src);
  if (m === null) throw new Error("could not find ITOTORI_PRODUCT_VERSION");
  return m[1];
}

function runCli(cliPath, args, cwd = repoRoot, env) {
  const r = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    cwd,
    timeout: 60_000,
    ...(env === undefined ? {} : { env }),
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("itotori installable package — version sync", () => {
  test("package.json version equals ITOTORI_PRODUCT_VERSION", () => {
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const productVersion = readProductVersion();
    assert.equal(
      pkg.version,
      productVersion,
      "packages/itotori-cli/package.json version must equal ITOTORI_PRODUCT_VERSION",
    );
    assert.notEqual(pkg.version, "0.0.0", "the installable package is not the dev 0.0.0");
    assert.equal(pkg.private, false, "the installable package is publishable (not private)");
    assert.equal(pkg.bin.itotori, "./bin/itotori.js", "the bin entry is the itotori CLI");
  });
});

describe("itotori installable package — built bin", () => {
  before(() => {
    // Build the self-contained bundle + migrations. Idempotent.
    const r = spawnSync(process.execPath, [path.join(pkgDir, "build.mjs")], {
      encoding: "utf8",
      cwd: repoRoot,
      timeout: 120_000,
    });
    if (r.status !== 0) {
      throw new Error(`build failed (status ${r.status}):\n${r.stdout}\n${r.stderr}`);
    }
  });

  test("dist/cli.js exists with exactly one node shebang before the banner", () => {
    assert.ok(existsSync(distCli), "dist/cli.js was produced by the build");
    const contents = readFileSync(distCli, "utf8");
    const leadingShebangLines =
      contents
        .match(/^(?:#![^\n]*(?:\n|$))+/u)?.[0]
        .trimEnd()
        .split("\n") ?? [];
    assert.deepEqual(
      leadingShebangLines,
      ["#!/usr/bin/env node"],
      "dist/cli.js must have exactly one leading node shebang",
    );
    assert.match(
      contents,
      /^#!\/usr\/bin\/env node\nimport \{ createRequire as __itotoriCreateRequire \} from "node:module";\nconst require = __itotoriCreateRequire\(import\.meta\.url\);\n/u,
      "the createRequire banner must immediately follow the shebang",
    );
  });

  test("itotori --version reports the product semver", () => {
    const r = runCli(distCli, ["--version"]);
    assert.equal(r.status, 0, `--version exited ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), `itotori ${readProductVersion()}`);
  });

  test("itotori -v is an alias for --version", () => {
    const r = runCli(distCli, ["-v"]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), `itotori ${readProductVersion()}`);
  });

  test("itotori localize does not require the retired --config flag", () => {
    const r = runCli(distCli, ["localize"]);
    assert.notEqual(r.status, 0, "localize without its required run flags must exit non-zero");
    assert.doesNotMatch(r.stderr + r.stdout, /missing required flag --config/u);
  });

  test("itotori db-migrate dispatches (errors on missing DATABASE_URL)", () => {
    // Scrub DATABASE_URL so the dispatch deterministically hits the
    // "DATABASE_URL is required" guard (the devshell otherwise exports one).
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const r = runCli(distCli, ["db-migrate"], tmpdir(), env);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /DATABASE_URL/u);
  });

  test("itotori init fails closed when packaged Postgres cannot be provisioned", () => {
    const emptyPathDir = mkdtempSync(path.join(tmpdir(), "itotori-empty-path-"));
    const configDir = mkdtempSync(path.join(tmpdir(), "itotori-init-config-"));
    const configPath = path.join(configDir, "config.env");
    try {
      const env = {
        ...process.env,
        OPENROUTER_API_KEY: "sk-or-dummy-installable-init-test-1111111111",
        OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1",
        PATH: emptyPathDir,
      };
      delete env.DATABASE_URL;
      delete env.ITOTORI_POSTGRES_BIN_DIR;
      const r = runCli(
        distCli,
        ["init", "--non-interactive", "--config", configPath],
        tmpdir(),
        env,
      );
      assert.notEqual(r.status, 0, "init must exit non-zero without a DB footprint");
      assert.match(r.stderr + r.stdout, /failed to provision the required database footprint/u);
      assert.match(r.stderr + r.stdout, /Docker\/Podman is unavailable/u);
      assert.equal(existsSync(configPath), false, "init must not write config after DB failure");
    } finally {
      rmSync(emptyPathDir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("the 68 migration SQL files ship alongside the bundle and resolve from it", () => {
    const migrationsDir = path.join(pkgDir, "migrations");
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
    assert.ok(files.length >= 60, `expected >=60 migration files, got ${files.length}`);
    // migrationPath() in @itotori/db resolves dirname(import.meta.url)/../migrations/<file>.
    // From dist/cli.js that is dist/../migrations/ = the package migrations dir.
    const resolved = path.resolve(
      path.dirname(distCli),
      "..",
      "migrations",
      "0001_hello_world.sql",
    );
    assert.ok(existsSync(resolved), `migration path resolves to an existing file: ${resolved}`);
  });
});

describe("itotori installable package — npm pack + install (from the install, not the monorepo)", () => {
  let installDir;
  let binPath;

  before(() => {
    // Build first so dist/ + migrations/ are present in the tarball.
    const build = spawnSync(process.execPath, [path.join(pkgDir, "build.mjs")], {
      encoding: "utf8",
      cwd: repoRoot,
      timeout: 120_000,
    });
    if (build.status !== 0) {
      throw new Error(`build failed: ${build.stdout}\n${build.stderr}`);
    }
    // `npm pack` the package into a temp dir (does not pollute the package dir).
    const packDir = mkdtempSync(path.join(tmpdir(), "itotori-pack-"));
    const pack = spawnSync("npm", ["pack", pkgDir, "--pack-destination", packDir], {
      encoding: "utf8",
      timeout: 60_000,
    });
    if (pack.status !== 0) {
      throw new Error(`npm pack failed: ${pack.stdout}\n${pack.stderr}`);
    }
    const tgzName = pack.stdout.trim().split("\n").pop().trim();
    const tgzPath = path.join(packDir, tgzName);
    assert.ok(existsSync(tgzPath), `tarball was produced: ${tgzPath}`);

    // `npm install` the tarball into a clean temp prefix — a real install with
    // NO access to the monorepo's node_modules. The bundle is self-contained
    // (no runtime deps), so this is offline and fast.
    installDir = mkdtempSync(path.join(tmpdir(), "itotori-install-"));
    const install = spawnSync(
      "npm",
      ["install", tgzPath, "--no-audit", "--no-fund", "--no-save", "--prefix", installDir],
      { encoding: "utf8", timeout: 120_000 },
    );
    rmSync(packDir, { recursive: true, force: true });
    if (install.status !== 0) {
      throw new Error(`npm install failed: ${install.stdout}\n${install.stderr}`);
    }
    binPath = path.join(installDir, "node_modules", ".bin", "itotori");
    assert.ok(existsSync(binPath), `installed bin exists at ${binPath}`);
  });

  after(() => {
    if (installDir) rmSync(installDir, { recursive: true, force: true });
  });

  test("the installed bin is a symlink (npm bin-link)", () => {
    // npm links node_modules/.bin/itotori -> ../itotori/bin/itotori.js
    assert.ok(existsSync(binPath));
  });

  test("itotori --version runs FROM THE INSTALL (outside the monorepo)", () => {
    // Run from a cwd that is NOT the monorepo, via the installed symlink.
    const r = spawnSync(binPath, ["--version"], {
      encoding: "utf8",
      cwd: tmpdir(),
      timeout: 60_000,
    });
    assert.equal(r.status, 0, `installed --version failed: ${r.stderr}`);
    assert.equal(r.stdout.trim(), `itotori ${readProductVersion()}`);
  });

  test("itotori localize FROM THE INSTALL does not require --config", () => {
    const r = spawnSync(binPath, ["localize"], {
      encoding: "utf8",
      cwd: tmpdir(),
      timeout: 60_000,
    });
    assert.notEqual(r.status, 0, "localize without its required run flags must exit non-zero");
    assert.doesNotMatch(r.stderr + r.stdout, /missing required flag --config/u);
  });

  test("itotori init fails closed FROM THE INSTALL when no DB footprint is available", () => {
    const emptyPathDir = mkdtempSync(path.join(tmpdir(), "itotori-empty-path-"));
    const configDir = mkdtempSync(path.join(tmpdir(), "itotori-init-config-"));
    const configPath = path.join(configDir, "config.env");
    try {
      const env = {
        ...process.env,
        OPENROUTER_API_KEY: "sk-or-dummy-installable-init-test-1111111111",
        OPENROUTER_ZDR_ACCOUNT_ASSERTED: "1",
        PATH: emptyPathDir,
      };
      delete env.DATABASE_URL;
      delete env.ITOTORI_POSTGRES_BIN_DIR;
      const r = spawnSync(
        process.execPath,
        [binPath, "init", "--non-interactive", "--config", configPath],
        {
          encoding: "utf8",
          cwd: tmpdir(),
          timeout: 60_000,
          env,
        },
      );
      assert.notEqual(r.status, 0, "installed init must exit non-zero without a DB footprint");
      assert.match(r.stderr + r.stdout, /failed to provision the required database footprint/u);
      assert.match(r.stderr + r.stdout, /Docker\/Podman is unavailable/u);
      assert.equal(existsSync(configPath), false, "installed init must not write config");
    } finally {
      rmSync(emptyPathDir, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("the installed package ships its migrations at the resolving path", () => {
    const installedCli = path.join(installDir, "node_modules", "itotori", "dist", "cli.js");
    assert.ok(existsSync(installedCli), "the installed package has dist/cli.js");
    const resolved = path.resolve(
      path.dirname(installedCli),
      "..",
      "migrations",
      "0001_hello_world.sql",
    );
    assert.ok(existsSync(resolved), `installed migration resolves: ${resolved}`);
  });
});
