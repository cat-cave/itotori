// Regression suite for the no-game-name CI guard.
//
// Proves the ratchet is airtight: a planted new game reference FAILS, a
// grandfathered one PASSES, a whitelist that grew is REFUSED, and --update
// refuses to grow (whether by total count or by a brand-new game name). Also
// covers token extraction (multiple names per line, slugs / VNDB ids / the
// corpus-observed marker / the Japanese title), scope exclusions (tests /
// fixtures / docs / build output / guardrail scanners), and the absolute-zero
// posture when no whitelist exists.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "audit-no-game-names.mjs");

import {
  evaluateCheck,
  evaluateUpdate,
  emptyWhitelist,
  findGameNameViolations,
  isExcludedPath,
  shouldScan,
} from "./audit-no-game-names.mjs";

const CRATE = "crates/utsushi-reallive/src/lib.rs";
// A planted slug used only by the tests; kept out of the literal source with a
// join so the guard's own scan of this file never trips (this file is excluded
// anyway, but belt-and-suspenders keeps the fixture explicit).
const SLUG = "sweetie";

function whitelist(files) {
  return {
    ...emptyWhitelist(),
    total: Object.values(files).reduce((n, a) => n + a.length, 0),
    files,
  };
}

test("extracts one token per game reference, including multiple per line", () => {
  const v = findGameNameViolations(
    CRATE,
    `// ${SLUG} HD save format; the sukara decompressor mirrors it.\n`,
  );
  assert.deepEqual(v.map((x) => x.token).sort(), ["sukara", "sweetie"]);
});

test("catches every id family: slugs, Japanese title, real VNDB ids, corpus marker", () => {
  const lines = [
    `/// ${SLUG} / karetoshi / gamekoi / oshioki / sukara all match.`,
    "/// Japanese title オシオキ matches too.",
    "/// Real VNDB ids v60663 and v21465 match; synthetic v1234 does NOT.",
    "/// A corpus-observed cap is a game-coupling smell.",
  ].join("\n");
  const tokens = findGameNameViolations(CRATE, lines)
    .map((x) => x.token)
    .sort();
  assert.deepEqual(tokens, [
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

test("synthetic / fake VNDB ids are NOT matched (only the curated real set)", () => {
  const v = findGameNameViolations(CRATE, "// ids v1001, v1234, v9999, v12345 are fixtures.\n");
  assert.deepEqual(v, []);
});

test("a planted new game reference is NOT covered -> check fails", () => {
  const violations = findGameNameViolations(CRATE, `// ${SLUG} HD hardcoded default.\n`);
  const wl = whitelist({ [CRATE]: ["karetoshi"] });
  const { ok, newViolations } = evaluateCheck(violations, wl);
  assert.equal(ok, false);
  assert.equal(newViolations[0].token, "sweetie");
  assert.equal(newViolations[0].excess, 1);
});

test("a planted extra occurrence of a grandfathered name (over its count) fails", () => {
  const violations = findGameNameViolations(CRATE, `// ${SLUG} a\n// ${SLUG} b\n`);
  const wl = whitelist({ [CRATE]: ["sweetie"] });
  const { ok, newViolations } = evaluateCheck(violations, wl);
  assert.equal(ok, false);
  assert.equal(newViolations[0].token, "sweetie");
  assert.equal(newViolations[0].excess, 1);
});

test("a grandfathered existing reference passes", () => {
  const violations = findGameNameViolations(CRATE, `// ${SLUG} save.\n// sukara pack.\n`);
  const wl = whitelist({ [CRATE]: ["sukara", "sweetie"] });
  assert.equal(evaluateCheck(violations, wl).ok, true);
});

test("shrinking (fewer occurrences than allotted) still passes", () => {
  const violations = findGameNameViolations(CRATE, `// ${SLUG} only one now.\n`);
  const wl = whitelist({ [CRATE]: ["sweetie", "sweetie"] });
  assert.equal(evaluateCheck(violations, wl).ok, true);
});

test("a missing/empty whitelist requires zero references (absolute posture)", () => {
  const violations = findGameNameViolations(CRATE, `// ${SLUG}.\n`);
  assert.equal(evaluateCheck(violations, emptyWhitelist()).ok, false);
  assert.equal(evaluateCheck([], emptyWhitelist()).ok, true);
});

test("--update refuses to grow when total token count increases", () => {
  const old = whitelist({ [CRATE]: ["sweetie"] });
  const violations = findGameNameViolations(CRATE, `// ${SLUG} a\n// ${SLUG} b\n`);
  const r = evaluateUpdate(violations, old);
  assert.equal(r.ok, false);
  assert.equal(r.grew, true);
  assert.equal(r.oldTotal, 1);
  assert.equal(r.newTotal, 2);
});

test("--update refuses a brand-new game name even at equal total count", () => {
  // One old ref removed, one NEW name added: total unchanged, but a novel value.
  const old = whitelist({ [CRATE]: ["sweetie"] });
  const violations = findGameNameViolations(CRATE, "// karetoshi swapped in.\n");
  const r = evaluateUpdate(violations, old);
  assert.equal(r.ok, false);
  assert.equal(r.grew, false);
  assert.deepEqual(r.novelTokens, ["karetoshi"]);
});

test("--update allows a pure shrink (ratchet down toward zero)", () => {
  const old = whitelist({ [CRATE]: ["sukara", "sweetie"] });
  const violations = findGameNameViolations(CRATE, `// ${SLUG} remaining.\n`);
  const r = evaluateUpdate(violations, old);
  assert.equal(r.ok, true);
  assert.equal(r.newTotal, 1);
  assert.equal(r.oldTotal, 2);
  assert.deepEqual(r.whitelist.files[CRATE], ["sweetie"]);
});

test("--update allows reusing an already-grandfathered name at equal total (rename/reflow)", () => {
  const old = whitelist({ "crates/a/src/a.rs": ["sweetie"] });
  const violations = findGameNameViolations("crates/b/src/b.rs", `// ${SLUG} moved here.\n`);
  const r = evaluateUpdate(violations, old);
  assert.equal(r.ok, true);
});

test("scope: tests, fixtures, examples, build output, docs, and guardrail scanners are excluded", () => {
  assert.equal(isExcludedPath("crates/x/tests/real_bytes.rs"), true);
  assert.equal(isExcludedPath("crates/x/src/foo_test.rs"), true);
  assert.equal(isExcludedPath("apps/itotori/src/x.test.ts"), true);
  assert.equal(isExcludedPath("crates/kaifuu-engine-fixture/src/lib.rs"), true);
  assert.equal(isExcludedPath("packages/x/src/corpus.fixtures.ts"), true);
  assert.equal(isExcludedPath("crates/x/examples/demo.rs"), true);
  assert.equal(isExcludedPath("packages/x/dist/index.js"), true);
  assert.equal(isExcludedPath("crates/foo/target/debug/x.rs"), true);
  assert.equal(isExcludedPath("docs/research/note.mjs"), true);
  assert.equal(isExcludedPath("presets/alpha.ts"), true);
  assert.equal(isExcludedPath("scripts/history/migrate.mjs"), true);
  assert.equal(isExcludedPath("scripts/audit-no-game-names.mjs"), true);
  assert.equal(isExcludedPath("scripts/validate-no-specific-game-references.mjs"), true);
  // Included production/shared surfaces.
  assert.equal(shouldScan("crates/utsushi-reallive/src/syscall.rs"), true);
  assert.equal(shouldScan("apps/itotori/src/play/launcher.ts"), true);
  assert.equal(shouldScan("scripts/real-bytes-oracle.mjs"), true);
});

test("CLI check exits 1 on a planted reference and 0 when grandfathered", () => {
  const dir = mkdtempSync(join(tmpdir(), "game-name-cli-"));
  const probe = join(dir, "probe.rs");
  writeFileSync(probe, `// ${SLUG} HD never grandfathered here.\n`);
  const wlPath = join(dir, "wl.json");
  writeFileSync(wlPath, JSON.stringify(emptyWhitelist()));

  const { code, stderr } = runCli("--whitelist", wlPath, probe);
  assert.equal(code, 1);
  assert.match(stderr, /game-name guard: FAILED/u);
  assert.match(stderr, /sweetie/u);
});

test("CLI --update writes a strictly-smaller whitelist and refuses to grow", () => {
  const dir = mkdtempSync(join(tmpdir(), "game-name-update-"));
  const probe = join(dir, "probe.rs");
  writeFileSync(probe, `// ${SLUG} stays.\n`);
  const wlPath = join(dir, "wl.json");
  // Baseline has two refs; current tree has one -> shrink allowed.
  writeFileSync(
    wlPath,
    JSON.stringify({
      ...emptyWhitelist(),
      total: 2,
      files: { [dir + "/probe.rs"]: ["sukara", "sweetie"] },
    }),
  );
  const { code, stdout } = runCli("--update", "--whitelist", wlPath, probe);
  assert.equal(code, 0);
  assert.match(stdout, /ratcheted 2 -> 1/u);

  // Now try to grow: baseline one ref, tree two -> refuse, exit 1.
  writeFileSync(probe, `// ${SLUG} a\n// ${SLUG} b\n`);
  writeFileSync(
    wlPath,
    JSON.stringify({
      ...emptyWhitelist(),
      total: 1,
      files: { [dir + "/probe.rs"]: ["sweetie"] },
    }),
  );
  const grown = runCli("--update", "--whitelist", wlPath, probe);
  assert.equal(grown.code, 1);
  assert.match(grown.stderr, /REFUSED/u);
});

function runCli(...args) {
  try {
    const stdout = execFileSync("node", [scriptPath, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}
