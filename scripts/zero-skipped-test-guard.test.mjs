// @itotori-meta-check
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  countRustIgnoredTests,
  findSkippedTestViolations,
  MAX_RUST_IGNORED_TESTS,
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
          "crates/example/tests/private.rs": "",
        };
    for (const [file, contents] of Object.entries(fixtureFiles)) {
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

function rustIgnoreFixture(attributes) {
  return Array.from(
    attributes,
    (attribute, index) => `${attribute}\n#[test]\nfn private_${index}() {}\n`,
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
      assert.match(accepted.stdout, /Rust #\[ignore\] attribute count 0\/0/u);
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

test("current crate source has no Rust ignore attributes", () => {
  assert.equal(countRustIgnoredTests(repoRoot).count, MAX_RUST_IGNORED_TESTS);
});

test("Rust guard rejects direct, multiline, and cfg_attr ignore attributes", () => {
  const ignoredTests = rustIgnoreFixture([
    "#[ignore]",
    '#[ignore = "private corpus"]',
    '#[ignore =\n  "multiline private corpus"\n]',
    "#[ignore /* permitted comment */]",
    "#[ignore] /* permitted comment */",
    "#[ignore // permitted comment\n]",
    "#[r#ignore]",
    "# /* permitted comment */ [ignore]",
    "/* permitted comment */ #[ignore]",
    '#[ignore = r#"valid raw string with a quote " and ] inside"#]',
    '#[cfg_attr(feature = "private", ignore)]',
    '#[cfg_attr(all(feature = "private", target_os = "linux"), ignore = "private corpus")]',
    '#[cfg_attr(feature = "private", ignore // permitted comment\n)]',
    '#[cfg_attr(feature = "private", r#ignore)]',
    '#[cfg_attr(feature = "private", ignore = r#"valid raw string with a quote " and ] inside"#)]',
  ]);
  withGitFixture({ "crates/example/tests/private.rs": ignoredTests }, (root) => {
    assert.equal(countRustIgnoredTests(root).count, 15);
    const rejected = runGuard(root);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stdout, /attribute count 15\/0/u);
    assert.match(rejected.stderr, /Rust #\[ignore\] attributes are forbidden; found 15/u);
  });
});

test("Rust inventory counts reasoned attributes, not prose that resembles an ignore", () => {
  withGitFixture(
    {
      "crates/example/tests/private.rs": `
        const NOTE: &str = "#[ignore]-gated prose";
        #[ignore]
        #[test]
        fn private() {}
      `,
    },
    (root) => assert.equal(countRustIgnoredTests(root).count, 1),
  );
});

test("Rust inventory does not mistake a non-ignore cfg_attr for an ignore", () => {
  withGitFixture(
    {
      "crates/example/tests/private.rs":
        '#[cfg_attr(feature = "private", allow(dead_code))]\nfn helper() {}\n',
    },
    (root) => assert.equal(countRustIgnoredTests(root).count, 0),
  );
});

test("Rust inventory does not let string contents hide a following attribute", () => {
  withGitFixture(
    {
      "crates/example/tests/private.rs":
        'const DECOY: &str = "/* not a comment */";\n#[ignore]\n#[test]\nfn private() {}\n',
    },
    (root) => assert.equal(countRustIgnoredTests(root).count, 1),
  );
});

test("Rust inventory recognizes raw and same-line attribute forms", () => {
  withGitFixture(
    {
      "crates/example/tests/private.rs": [
        "#[test] #[ignore] fn inline() {}",
        "fn helper() {} #[test] #[ignore] fn after_item() {}",
        "#[r#cfg_attr(all(), ignore)] #[test] fn raw_conditional() {}",
      ].join("\n"),
    },
    (root) => assert.equal(countRustIgnoredTests(root).count, 3),
  );
});

test("Rust inventory does not mistake a lifetime for a character literal", () => {
  withGitFixture(
    {
      "crates/example/tests/private.rs":
        "fn helper() { let _: &'static str; }\n#[test] #[ignore] fn hidden() {}\n",
    },
    (root) => assert.equal(countRustIgnoredTests(root).count, 1),
  );
});
