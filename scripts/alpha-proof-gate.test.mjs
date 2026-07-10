import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

// ALPHA-009 — regression guard for the alpha proof / public-fixture vertical
// integration gate. These assertions enforce that the literal "Hello World"
// CI source of truth stays retired and that the alpha proof gate cannot quietly
// degrade back into a success-string smoke or a divergent `just hello` path.
//
// Atomic CI swap: alpha-proof lives as the `alpha` job inside `_tier1.yml`
// (not a standalone workflow). Assertions that touch DATABASE_URL / services
// are job-scoped so the file-level postgres job does not false-fail them.

const justfile = readFileSync("justfile", "utf8");
const viteConfig = readFileSync("vite.config.ts", "utf8");
const tier1Workflow = readFileSync(".github/workflows/_tier1.yml", "utf8");

/** Extract a top-level job block (`  jobId:`) from a GitHub Actions workflow YAML. */
function extractWorkflowJob(workflow, jobId) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  assert.notEqual(start, -1, `workflow must define job ${jobId}`);
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // Next job key at the same indent under `jobs:`, or a new top-level key.
    if (/^  [A-Za-z0-9_-]+:\s*$/u.test(line) || /^[A-Za-z0-9_-]+:/u.test(line)) {
      break;
    }
    body.push(line);
  }
  return `${body.join("\n")}\n`;
}

const tier1AlphaJob = extractWorkflowJob(tier1Workflow, "alpha");

function justRecipeBody(name) {
  const lines = justfile.split(/\r?\n/);
  // Match `name:` or `name: deps...` recipe headers.
  const start = lines.findIndex((line) => new RegExp(`^${name}(:| .*:|: )`).test(line));
  assert.notEqual(start, -1, `justfile must declare a \`${name}\` recipe`);
  const header = lines[start];
  const body = [];
  for (const line of lines.slice(start + 1)) {
    // Recipe bodies are indented; any non-empty line at column 0 (another
    // recipe header or a top-level comment) ends this recipe.
    if (line.length > 0 && !/^\s/.test(line)) break;
    body.push(line);
  }
  return { header, body: body.join("\n") };
}

test("`just alpha-proof` runs the public-fixture vertical command", () => {
  const { body } = justRecipeBody("alpha-proof");
  assert.match(
    body,
    /^\s*pnpm exec vp run alpha:public-fixture$/m,
    "alpha-proof must run `pnpm exec vp run alpha:public-fixture`",
  );
  assert.match(
    body,
    /^\s*pnpm exec vp run alpha:public-fixture-validate$/m,
    "alpha-proof must re-prove linkage with the independent validator",
  );
});

test("`just hello` is only a non-divergent compatibility alias for alpha-proof", () => {
  const { header } = justRecipeBody("hello");
  // The alias must delegate to alpha-proof as a dependency and carry no body of
  // its own (so it cannot diverge from the alpha proof gate).
  assert.match(header, /^hello:\s*alpha-proof\s*$/, "hello must be `hello: alpha-proof`");
  const { body } = justRecipeBody("hello");
  assert.equal(body.trim(), "", "the hello alias must have no recipe body of its own");
});

test("the literal hello-world loop and its success-string printer are gone", () => {
  assert.ok(
    !existsSync(".github/workflows/hello.yml"),
    "the literal Hello World workflow must be removed",
  );
  assert.ok(
    !existsSync("scripts/print-hello-summary.mjs"),
    "the placeholder success-string printer must be removed",
  );
  assert.doesNotMatch(
    justfile,
    /print-hello-summary/u,
    "no recipe may print the hello-world success string",
  );
  // The retired loop's literal fixture pipeline must not be reintroduced.
  assert.doesNotMatch(justfile, /\.tmp\/hello-world/u);
});

test("the alpha proof job is named for the vertical, not Hello World", () => {
  // Job lives under `_tier1.yml` (workflow name is "reusable tier1").
  assert.match(
    tier1AlphaJob,
    /^\s+name:\s*Tier 1 \/ alpha proof\s*$/mu,
    "alpha job must be named for the alpha-proof vertical",
  );
  assert.doesNotMatch(tier1AlphaJob, /name:\s*Hello World/u);
  // Tier recipe delegates to `alpha-proof` (`ci-tier1-alpha: alpha-proof`).
  assert.match(
    tier1AlphaJob,
    /run: just ci-tier1-alpha\n/u,
    "the alpha job must run `just ci-tier1-alpha`",
  );
  assert.match(justfile, /^ci-tier1-alpha: alpha-proof$/mu);
  // Public-fixture-only and deterministic: no database, no live credentials.
  // Job-scoped — the sibling `db` job in the same file wires DATABASE_URL.
  assert.doesNotMatch(tier1AlphaJob, /just db-up|just db-wait|just db-down|DATABASE_URL/u);
  assert.doesNotMatch(
    tier1AlphaJob,
    /^\s+services:\n/mu,
    "alpha-proof job must not provision GH service containers",
  );
});

test("there is no independent hello_world_passed CI gate", () => {
  assert.doesNotMatch(tier1AlphaJob, /hello_world_passed/u);
  // The Vite+ task graph must not keep a separate `hello` integration task.
  assert.doesNotMatch(
    viteConfig,
    /\bhello:\s*\{[\s\S]*?command:\s*"just hello"/u,
    "the Vite+ `hello` task must not be a separate integration source of truth",
  );
});
