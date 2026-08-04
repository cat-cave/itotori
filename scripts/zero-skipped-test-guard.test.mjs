import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  MAX_RUST_IGNORED_TESTS,
  countRustIgnoredTests,
  findSkippedTestViolations,
  repoRoot,
} from "./zero-skipped-test-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const guard = join(here, "zero-skipped-test-guard.mjs");

function withGitFixture(files, run) {
  const root = mkdtempSync(join(tmpdir(), "itotori-zero-skips-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    const fixtureFiles = Object.keys(files).some((file) => file.startsWith("crates/"))
      ? files
      : {
          ...files,
          "crates/example/tests/private.rs": privateCorpusIgnoreFixture(MAX_RUST_IGNORED_TESTS),
        };
    for (const [file, contents] of Object.entries(fixtureFiles)) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    run(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function privateCorpusIgnoreFixture(count) {
  return Array.from(
    { length: count },
    (_, index) => `#[ignore = "private corpus"]\n#[test]\nfn private_${index}() {}\n`,
  ).join("\n");
}

function runGuard(root) {
  return spawnSync(process.execPath, [guard, "--root", root], { encoding: "utf8" });
}

test("rejects direct skip, todo, Node context skips, disabled aliases, and skip options", () => {
  const source = `
    describe.skip("hidden", () => {});
    test.todo("later");
    t.skip("node test context");
    xit("disabled", () => {});
    test("option", { skip: true }, () => {});
  `;
  const violations = findSkippedTestViolations("apps/example/test/proof.test.ts", source);
  assert.equal(violations.length, 5);
  assert.match(violations.map((violation) => violation.kind).join("\n"), /\.skip/u);
  assert.match(violations.map((violation) => violation.kind).join("\n"), /\.todo/u);
  assert.match(violations.map((violation) => violation.kind).join("\n"), /\.skip/u);
  assert.match(violations.map((violation) => violation.kind).join("\n"), /xit/u);
  assert.match(violations.map((violation) => violation.kind).join("\n"), /skip\/todo option/u);
});

test("rejects process.env conditional and logical registration vanish paths", () => {
  const ternary = findSkippedTestViolations(
    "apps/example/test/proof.test.ts",
    "const liveDescribe = process.env.LIVE_DATABASE ? describe : describe.skip;",
  );
  assert.equal(ternary.length, 1);
  assert.match(ternary[0].kind, /process\.env conditional/u);

  const logical = findSkippedTestViolations(
    "apps/example/test/proof.test.ts",
    'process.env.REAL_BYTES && describe("private", () => {});',
  );
  assert.equal(logical.length, 1);
  assert.match(logical[0].kind, /process\.env logical/u);

  const statement = findSkippedTestViolations(
    "apps/example/test/proof.test.ts",
    'if (process.env.PRIVATE_DB) { describe("private", () => {}); }',
  );
  assert.equal(statement.length, 1);
  assert.match(statement[0].kind, /process\.env conditional statement/u);
});

test("CLI fails on an untracked reintroduced describe.skip and passes once removed", () => {
  withGitFixture(
    { "apps/example/test/proof.test.ts": 'describe.skip("hidden", () => {});\n' },
    (root) => {
      const rejected = runGuard(root);
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /prohibited test registration/u);
      assert.match(rejected.stdout, /1 JS\/TS test source file/u);

      writeFileSync(join(root, "apps/example/test/proof.test.ts"), 'describe("runs", () => {});\n');
      const accepted = runGuard(root);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.match(accepted.stdout, /Rust #\[ignore = \.\.\.\] count 169\/169/u);
    },
  );
});

test("does not scan generated dist test-shaped files", () => {
  withGitFixture(
    {
      "apps/example/test/proof.test.ts": 'describe("runs", () => {});\n',
      "apps/example/dist/proof.test.js": 'describe.skip("generated", () => {});\n',
    },
    (root) => {
      const result = runGuard(root);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /1 JS\/TS test source file/u);
    },
  );
});

test("current crate source reports the 169-test Rust ignore inventory", () => {
  assert.equal(countRustIgnoredTests(repoRoot).count, MAX_RUST_IGNORED_TESTS);
});

test("Rust inventory reports the exact current ceiling and fails on a 170th ignore", () => {
  const ignoredTests = privateCorpusIgnoreFixture(MAX_RUST_IGNORED_TESTS + 1);
  withGitFixture({ "crates/example/tests/private.rs": ignoredTests }, (root) => {
    assert.equal(countRustIgnoredTests(root).count, MAX_RUST_IGNORED_TESTS + 1);
    const rejected = runGuard(root);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stdout, /count 170\/169/u);
    assert.match(rejected.stderr, /grew from 169 to 170/u);
  });
});

test("Rust inventory rejects a missing private-corpus ignore", () => {
  const ignoredTests = privateCorpusIgnoreFixture(MAX_RUST_IGNORED_TESTS - 1);
  withGitFixture({ "crates/example/tests/private.rs": ignoredTests }, (root) => {
    const rejected = runGuard(root);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stdout, /count 168\/169/u);
    assert.match(rejected.stderr, /changed from 169 to 168/u);
  });
});

test("Rust inventory counts reasoned attributes, not prose that resembles an ignore", () => {
  withGitFixture(
    {
      "crates/example/tests/private.rs": `
        const NOTE: &str = "#[ignore]-gated prose";
        #[ignore = "private corpus"]
        #[test]
        fn private() {}
      `,
    },
    (root) => assert.equal(countRustIgnoredTests(root).count, 1),
  );
});
