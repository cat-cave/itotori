#!/usr/bin/env node
// Lane-union guard regression suite. Asserts the db-app-exclusion-union guard
// PASSES against the current justfile + _tier1.yml configuration, and FAILS
// closed on the exact regressions the audit named: duplicate/missing shards,
// stranded exclusions, and missing native artifact wiring.
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guardPath = path.join(repoRoot, "scripts/assert-db-app-exclusion-union.mjs");
const realJustfile = path.join(repoRoot, "justfile");
const realWorkflow = path.join(repoRoot, ".github/workflows/_tier1.yml");

function runGuard(env = {}) {
  return spawnSync(process.execPath, [guardPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function gateOutput(r) {
  return `${r.stdout}\n${r.stderr}`;
}

test("guard passes against the current justfile + workflow — no excluded app test is stranded", () => {
  const result = runGuard();
  assert.equal(
    result.status,
    0,
    `guard must pass against the current config\n${gateOutput(result)}`,
  );
  assert.match(result.stdout, /db-app-exclusion-union: OK/u);
  assert.match(result.stdout, /--shard=1\/2|--shard|complementary portable shards/u);
});

test("the DB-excluded wholegame test file exists as a real app test", async () => {
  const candidate = path.join(
    repoRoot,
    "apps/itotori/test/wholegame-render-validation-seam.test.ts",
  );
  await assert.doesNotReject(access(candidate));
});

async function withMutatedConfig(mutate, run) {
  const dir = await mkdtemp(path.join(tmpdir(), "db-app-union-"));
  try {
    const justSrc = await readFile(realJustfile, "utf8");
    const wfSrc = await readFile(realWorkflow, "utf8");
    const state = { justfile: justSrc, workflow: wfSrc };
    mutate(state);
    const justPath = path.join(dir, "justfile");
    const wfPath = path.join(dir, "_tier1.yml");
    await writeFile(justPath, state.justfile);
    await writeFile(wfPath, state.workflow);
    return run({
      ITOTORI_JUSTFILE_PATH: justPath,
      ITOTORI_TIER1_WORKFLOW_PATH: wfPath,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("guard FAILS when both portable shards use --shard=2/2 (complementary partition broken)", async () => {
  const result = await withMutatedConfig((state) => {
    // Break 1of2 so it also runs 2/2 — rank-12 file lands in no shard after DB excludes it.
    state.justfile = state.justfile.replace(
      /^(ci-tier1-ts-public-1of2:[\s\S]*?--shard=)1\/2/mu,
      "$12/2",
    );
  }, runGuard);
  assert.equal(result.status, 1, `guard must fail on duplicate 2/2 shards\n${gateOutput(result)}`);
  assert.match(gateOutput(result), /--shard=1\/2|complementary/u);
});

test("guard FAILS when a portable shard recipe is missing from the justfile", async () => {
  const result = await withMutatedConfig((state) => {
    state.justfile = state.justfile.replace(
      /^ci-tier1-ts-public-1of2:[\s\S]*?(?=^ci-tier1-ts-public-2of2:)/mu,
      "",
    );
  }, runGuard);
  assert.equal(
    result.status,
    1,
    `guard must fail when a shard recipe is missing\n${gateOutput(result)}`,
  );
  assert.match(gateOutput(result), /ci-tier1-ts-public-1of2 not found/u);
});

test("guard FAILS when portable job loses needs: [native] / download-artifact / ITOTORI_*_BIN wiring", async () => {
  const result = await withMutatedConfig((state) => {
    // Strip native dependency, artifact download, and env wiring from portable.
    state.workflow = state.workflow
      .replace(/^\s*needs:\s*\[native\]\s*$/mu, "")
      .replace(/^\s*- uses: actions\/download-artifact@v\d+[\s\S]*?path:\s*\.ci\/bin\s*$/mu, "")
      .replace(/^\s*- name: Wire native bins into env[\s\S]*?>> "\$GITHUB_ENV"\s*$/mu, "");
  }, runGuard);
  assert.equal(
    result.status,
    1,
    `guard must fail when native wiring is removed\n${gateOutput(result)}`,
  );
  assert.match(gateOutput(result), /needs:\s*\[native\]|download-artifact|ITOTORI_UTSUSHI_BIN/u);
});

test("guard FAILS when ts-public-1of2 is removed from the portable matrix", async () => {
  const result = await withMutatedConfig((state) => {
    state.workflow = state.workflow.replace(/^\s*-\s*ts-public-1of2\s*$/mu, "");
  }, runGuard);
  assert.equal(
    result.status,
    1,
    `guard must fail when matrix drops a portable TS shard\n${gateOutput(result)}`,
  );
  assert.match(gateOutput(result), /ts-public-1of2/u);
});

test("guard FAILS when a portable shard also excludes the DB-excluded file (stranded)", async () => {
  const result = await withMutatedConfig((state) => {
    state.justfile = state.justfile.replace(
      /(ci-tier1-ts-public-1of2:[\s\S]*?vitest run --shard=1\/2)( --exclude '^\*\*\/\.direnv\/\*\*')?/mu,
      "$1 --exclude '**/wholegame-render-validation-seam.test.ts'$2",
    );
  }, runGuard);
  assert.equal(
    result.status,
    1,
    `guard must fail when portable shard also excludes the file\n${gateOutput(result)}`,
  );
  assert.match(gateOutput(result), /wholegame-render-validation-seam|run NOWHERE/u);
});
