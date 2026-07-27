// Regression suite for the absolute no-game-name CI guard.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { findGameNameViolations, isExcludedPath, shouldScan } from "./audit-no-game-names.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "audit-no-game-names.mjs");
const CRATE = "crates/utsushi-reallive/src/lib.rs";
const SLUG = "sweetie";

test("extracts one token per game reference, including multiple per line", () => {
  const found = findGameNameViolations(
    CRATE,
    `// ${SLUG} HD save format; the sukara decompressor mirrors it.\n`,
  );
  assert.deepEqual(found.map((entry) => entry.token).sort(), ["sukara", "sweetie"]);
});

test("catches every curated title, id, and corpus marker", () => {
  const found = findGameNameViolations(
    CRATE,
    `/// ${SLUG} / karetoshi / gamekoi / oshioki / sukara all match.\n` +
      "/// Japanese title オシオキ matches too.\n" +
      "/// Real VNDB ids v60663 and v21465 match; synthetic v1234 does NOT.\n" +
      "/// A corpus-observed cap is a game-coupling smell.\n",
  );
  assert.deepEqual(found.map((entry) => entry.token).sort(), [
    "corpus-observed",
    "gamekoi",
    "karetoshi",
    "oshioki",
    "sukara",
    "sweetie",
    "v21465",
    "v60663",
    "オシオキ",
  ]);
});

test("catches title fragments embedded in snake_case, camelCase, and digit identifiers", () => {
  const found = findGameNameViolations(
    CRATE,
    "fn parses_sweetie_hd_2() {}\nfn parsesSweetieHd2() {}\nfn parses2sweetie3() {}\n",
  );
  assert.deepEqual(
    found.map((entry) => entry.token),
    ["sweetie", "sweetie", "sweetie"],
  );
});

test("does not treat synthetic VNDB ids as game names", () => {
  assert.deepEqual(findGameNameViolations(CRATE, "// v1001, v1234, v9999, v12345\n"), []);
});

test("scope excludes data and tests but includes shared source", () => {
  for (const path of [
    "crates/x/tests/real_bytes.rs",
    "crates/x/src/foo_test.rs",
    "apps/itotori/src/x.test.ts",
    "crates/kaifuu-engine-fixture/src/lib.rs",
    "packages/x/src/corpus.fixtures.ts",
    "crates/x/examples/demo.rs",
    "packages/x/dist/index.js",
    "docs/research/note.mjs",
    "scripts/audit-no-game-names.mjs",
  ])
    assert.equal(isExcludedPath(path), true);
  assert.equal(shouldScan("crates/utsushi-reallive/src/syscall.rs"), true);
  assert.equal(shouldScan("apps/itotori/src/play/launcher.ts"), true);
});

test("CLI rejects a planted game name and accepts clean source", () => {
  const dir = mkdtempSync(join(tmpdir(), "game-name-cli-"));
  const probe = join(dir, "probe.rs");
  writeFileSync(probe, `// ${SLUG} HD must not be hardcoded.\n`);
  const failed = runCli(probe);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /game-name guard: FAILED/u);
  assert.match(failed.stderr, /sweetie/u);

  writeFileSync(probe, "// compiler-110002 corpus must not be hardcoded.\n");
  const clean = runCli(probe);
  assert.equal(clean.code, 0);
  assert.match(clean.stdout, /0 references/u);
});

function runCli(...args) {
  try {
    return {
      code: 0,
      stdout: execFileSync("node", [scriptPath, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}
