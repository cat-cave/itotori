import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

// ALPHA-009 — regression guard for the alpha proof / public-fixture vertical
// integration gate. These assertions enforce that the literal "Hello World"
// CI source of truth stays retired and that the alpha proof gate cannot quietly
// degrade back into a success-string smoke or a divergent `just hello` path.

const justfile = readFileSync("justfile", "utf8");
const viteConfig = readFileSync("vite.config.ts", "utf8");
const alphaProofWorkflow = readFileSync(".github/workflows/alpha-proof.yml", "utf8");

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

test("the alpha proof workflow is named for the vertical, not Hello World", () => {
  assert.match(alphaProofWorkflow, /^name:\s*Alpha Proof\s*$/mu);
  assert.doesNotMatch(alphaProofWorkflow, /name:\s*Hello World/u);
  assert.match(
    alphaProofWorkflow,
    /-\s*run:\s*just alpha-proof\n/u,
    "the workflow must run `just alpha-proof`",
  );
  // Public-fixture-only and deterministic: no database, no live credentials.
  assert.doesNotMatch(alphaProofWorkflow, /just db-up|just db-wait|just db-down|DATABASE_URL/u);
});

test("there is no independent hello_world_passed CI gate", () => {
  assert.doesNotMatch(alphaProofWorkflow, /hello_world_passed/u);
  // The Vite+ task graph must not keep a separate `hello` integration task.
  assert.doesNotMatch(
    viteConfig,
    /\bhello:\s*\{[\s\S]*?command:\s*"just hello"/u,
    "the Vite+ `hello` task must not be a separate integration source of truth",
  );
});
