// @itotori-meta-check
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  changedRustIgnoreAttributes,
  countRustIgnoredTests,
  findSkippedTestViolations,
  mergeBaseRustIgnoredTests,
  repoRoot,
} from "./zero-skipped-test-guard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const guard = join(here, "zero-skipped-test-guard.mjs");

function withGitFixture(files, run) {
  const root = mkdtempSync(join(tmpdir(), "itotori-zero-skips-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    for (const [file, contents] of Object.entries(files)) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    execFileSync("git", ["add", ...Object.keys(files)], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--quiet",
        "-m",
        "baseline",
      ],
      { cwd: root },
    );
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
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
      assert.match(accepted.stdout, /Rust #\[ignore = \.\.\.\] count 0\/0 from merge-base/u);
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

test("current crate source matches its merge-base-derived Rust ignore inventory", () => {
  assert.equal(countRustIgnoredTests(repoRoot).count, mergeBaseRustIgnoredTests(repoRoot).count);
});

test("Rust inventory derives its ceiling from the merge base and fails on a new ignore", () => {
  withGitFixture({ "crates/example/tests/private.rs": privateCorpusIgnoreFixture(1) }, (root) => {
    writeFileSync(join(root, "crates/example/tests/private.rs"), privateCorpusIgnoreFixture(2));
    assert.equal(countRustIgnoredTests(root).count, 2);
    const rejected = runGuard(root);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stdout, /count 2\/1 from merge-base/u);
    assert.match(rejected.stderr, /grew from 1 to 2/u);
    assert.match(rejected.stderr, /attributes changed from the merge-base inventory/u);
  });
});

test("Rust inventory rejects a missing private-corpus ignore", () => {
  withGitFixture({ "crates/example/tests/private.rs": privateCorpusIgnoreFixture(2) }, (root) => {
    writeFileSync(join(root, "crates/example/tests/private.rs"), privateCorpusIgnoreFixture(1));
    const rejected = runGuard(root);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stdout, /count 1\/2 from merge-base/u);
    assert.match(rejected.stderr, /changed from 2 to 1/u);
  });
});

test("Rust inventory rejects an equal-sized replacement from its merge-base inventory", () => {
  withGitFixture({ "crates/example/tests/private.rs": privateCorpusIgnoreFixture(1) }, (root) => {
    writeFileSync(
      join(root, "crates/example/tests/private.rs"),
      privateCorpusIgnoreFixture(1).replace("private corpus", "different private corpus"),
    );
    assert.equal(countRustIgnoredTests(root).count, mergeBaseRustIgnoredTests(root).count);
    assert.equal(changedRustIgnoreAttributes(root).length, 2);
    const rejected = runGuard(root);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /attributes changed from the merge-base inventory/u);
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
