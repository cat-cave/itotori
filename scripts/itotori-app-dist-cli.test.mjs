// @itotori-meta-check
// Built-artifact proof for the apps/itotori tsc CLI: engine-project adapter
// manifests must reach dist, and `node apps/itotori/dist/cli.js` must discover
// every declared engine. Source-run vitest cannot see this class of defect.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const appDir = path.join(repoRoot, "apps", "itotori");
const distCli = path.join(appDir, "dist", "cli.js");
const adaptersDist = path.join(appDir, "dist", "engine-project", "adapters");
const emitScript = path.join(appDir, "scripts", "emit-engine-project-adapters.mjs");
const EXPECTED_ENGINES = ["reallive", "rpg-maker", "siglus", "softpal"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    cwd: repoRoot,
    timeout: options.timeout ?? 120_000,
    env: options.env ?? process.env,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function runDistCli(args) {
  return run(process.execPath, [distCli, ...args], { timeout: 30_000 });
}

function adapterManifestNames() {
  if (!existsSync(adaptersDist)) return [];
  return readdirSync(adaptersDist)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function emitAdapters() {
  const result = run(process.execPath, [emitScript], { timeout: 15_000 });
  if (result.status !== 0) {
    throw new Error(
      `emit-engine-project-adapters failed (status ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

describe("apps/itotori built CLI — engine-project adapter manifests", () => {
  before(() => {
    // Build workspace packages the compiled CLI imports, then the app package
    // build (tsc + declared adapter emit + vite). The emit step is the surface
    // under test: without it, dist has no adapters/ directory.
    const build = run("pnpm", ["--filter", "@itotori/app...", "run", "build"], {
      timeout: 300_000,
    });
    if (build.status !== 0) {
      throw new Error(
        `apps/itotori build failed (status ${build.status}):\n${build.stdout}\n${build.stderr}`,
      );
    }
  });

  after(() => {
    // Leave dist healthy if a later suite reuses the worktree artifact.
    if (existsSync(distCli) && adapterManifestNames().length === 0) {
      emitAdapters();
    }
  });

  test("package.json build declares the adapter emit after tsc", () => {
    const pkg = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8"));
    const build = pkg.scripts?.build;
    assert.equal(typeof build, "string");
    assert.match(build, /tsc -p tsconfig\.json/u);
    assert.match(build, /emit-engine-project-adapters\.mjs/u);
    assert.ok(
      build.indexOf("tsc -p tsconfig.json") < build.indexOf("emit-engine-project-adapters.mjs"),
      "adapter emit must run after tsc so outDir exists",
    );
  });

  test("build emits all four adapter manifests beside the compiled catalog", () => {
    assert.ok(existsSync(distCli), "apps/itotori/dist/cli.js must exist after build");
    assert.deepEqual(
      adapterManifestNames(),
      EXPECTED_ENGINES.map((engine) => `${engine}.json`),
    );
  });

  test("built CLI describes every declared engine from dist", () => {
    for (const engine of EXPECTED_ENGINES) {
      const result = runDistCli(["extract", "--engine", engine, "--describe"]);
      assert.equal(
        result.status,
        0,
        `extract --engine ${engine} --describe exited ${result.status}: ${result.stderr}`,
      );
      const document = JSON.parse(result.stdout);
      assert.equal(document.engine, engine);
      assert.equal(typeof document.summary, "string");
      assert.ok(Array.isArray(document.sharedParameters));
      assert.ok(document.sharedParameters.length > 0);
    }
  });

  test("built CLI fails closed when adapter manifests are absent from dist", () => {
    assert.ok(existsSync(adaptersDist), "precondition: adapters present after build");
    rmSync(adaptersDist, { recursive: true, force: true });
    try {
      const result = runDistCli(["extract", "--engine", "siglus", "--describe"]);
      assert.notEqual(result.status, 0, "describe must fail when adapters/ is missing");
      assert.match(
        `${result.stderr}${result.stdout}`,
        /ENOENT|scandir|adapters/u,
        "failure must name the missing adapters path",
      );
    } finally {
      emitAdapters();
    }
    const restored = runDistCli(["extract", "--engine", "siglus", "--describe"]);
    assert.equal(
      restored.status,
      0,
      `restore describe exited ${restored.status}: ${restored.stderr}`,
    );
    assert.equal(JSON.parse(restored.stdout).engine, "siglus");
  });
});
