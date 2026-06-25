// UTSUSHI-228 — driver unit tests. These use `node --test` so they run
// without depending on vitest's TypeScript pipeline; the driver itself is
// plain JS by design (it shells out to cargo / node).
//
// Covers:
//   1. `--dry-run --project ...` exits 0, prints the per-phase
//      commands, makes ZERO LLM calls, writes ZERO files.
//   2. `--dry-run` without `--project` exits non-zero with a usage line.
//   3. `--help` exits 0 with the usage string.
//   4. Missing OPENROUTER_API_KEY without `--dry-run` exits non-zero.
//   5. OPENROUTER_LIVE=1 without OPENROUTER_API_KEY exits non-zero with
//      a specific "no-fallback" message.
//
// Linux-only (the driver is Linux-only by design).

import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER_PATH = resolve(HERE, "run.mjs");

function runDriver(args, env = {}) {
  // The driver inherits PATH / NODE etc. from the caller. We
  // start from a CLEAN env so a stray OPENROUTER_API_KEY in the
  // dev shell doesn't pollute the negative-path tests; then layer
  // PATH back in so node can find itself.
  const cleanEnv = { PATH: process.env.PATH };
  return spawnSync(process.execPath, [DRIVER_PATH, ...args], {
    env: { ...cleanEnv, ...env },
    encoding: "utf8",
  });
}

test("--dry-run --project ... exits 0 and prints per-phase commands", () => {
  const result = runDriver(["--dry-run", "--project", "sweetie-hd-alpha-1"]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  // The dry-run plan must reference all four phases by their CLI
  // surfaces. We greet on substrings so a flag-shape refactor in a
  // sibling step doesn't break this test.
  assert.ok(
    result.stdout.includes("kaifuu-cli"),
    `dry-run plan must mention kaifuu-cli; got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("localize-sweetie-hd-stage"),
    `dry-run plan must mention the agentic-loop stage; got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("patch --engine reallive"),
    `dry-run plan must mention the kaifuu patch step; got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("replay-validate --engine reallive"),
    `dry-run plan must mention the replay-validate step; got:\n${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes("0 LLM calls"),
    `dry-run plan must declare zero LLM calls; got:\n${result.stdout}`,
  );
});

test("--dry-run without --project exits non-zero with a usage line", () => {
  const result = runDriver(["--dry-run"]);
  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes("--project is required"),
    `stderr should say --project is required; got:\n${result.stderr}`,
  );
});

test("--help exits 0 with the usage string", () => {
  const result = runDriver(["--help"]);
  assert.equal(result.status, 0);
  assert.ok(
    result.stdout.includes("just localize-sweetie-hd") ||
      result.stdout.includes("localize-sweetie-hd/run.mjs"),
    `--help must print the usage line; got:\n${result.stdout}`,
  );
});

test("missing OPENROUTER_API_KEY without --dry-run exits non-zero", () => {
  const result = runDriver(["--project", "sweetie-hd-alpha-1"], {
    // Deliberately omit OPENROUTER_API_KEY, KAIFUU_REAL_SWEETIE_HD_PATH,
    // and TARGET so the driver hits its first env-validation rejection.
  });
  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes("OPENROUTER_API_KEY"),
    `stderr should mention OPENROUTER_API_KEY; got:\n${result.stderr}`,
  );
});

test("OPENROUTER_LIVE=1 without OPENROUTER_API_KEY emits the no-fallback message", () => {
  const result = runDriver(["--project", "sweetie-hd-alpha-1"], {
    OPENROUTER_LIVE: "1",
    // No OPENROUTER_API_KEY — the no-fallback rule kicks in.
  });
  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes("OPENROUTER_LIVE=1") && result.stderr.includes("OPENROUTER_API_KEY"),
    `stderr should reference both env vars; got:\n${result.stderr}`,
  );
  assert.ok(
    result.stderr.includes("no-fallback") || result.stderr.includes("recorded provider"),
    `stderr should call out the no-fallback rule; got:\n${result.stderr}`,
  );
});
