// @itotori-meta-check
// Regression suite for the app-css contract guard.
//
// Proves the guard catches the two defect classes that shipped invisibly —
// a `var(--ito-*)` reference no stylesheet declares, and a class written in
// app source with no CSS rule anywhere — and that neither the fallback form
// nor the shrink-only ratchet can be used to smuggle a new one in.
//
// The scanner is exercised against REAL temporary trees (a git repo with the
// files actually on disk), not against stubbed inputs, so a change that guts
// the scanning path fails here rather than passing against a mock.

import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildNextWhitelist,
  declaredTokens,
  evaluateUnstyled,
  evaluateUpdate,
  findDanglingTokens,
  findUnstyledClasses,
  inlineStyleBlocks,
  referencedTokens,
  scanTree,
  styledClasses,
  usedClasses,
} from "./audit-app-css-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "audit-app-css-contract.mjs");

// Build a throwaway git repo with the given `path -> contents` map so the
// scanner's `git ls-files` walk has something real to walk.
function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), "app-css-contract-"));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  execSync("git init -q && git add -A", { cwd: root, stdio: "ignore" });
  return root;
}

function runCli(root, whitelistPath, ...extra) {
  try {
    const stdout = execFileSync(
      "node",
      [scriptPath, "--root", root, "--whitelist", whitelistPath, ...extra],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const DS_TOKENS = ":root { --ito-color-text: #fff; --ito-space-4: 4px; }";

// ---- parsing ---------------------------------------------------------------

test("declaredTokens reads custom-property declarations, not references", () => {
  assert.deepEqual(declaredTokens(":root { --ito-a: var(--ito-b); }"), ["--ito-a"]);
});

test("referencedTokens reads BOTH sides of a var() fallback chain", () => {
  assert.deepEqual(referencedTokens("a { color: var(--ito-a, var(--ito-b)); }"), [
    "--ito-a",
    "--ito-b",
  ]);
});

test("comments never count as declarations, references, or rules", () => {
  const css = "/* --ito-ghost: 1px; var(--ito-ghost); .ghost {} */ .real { color: red; }";
  assert.deepEqual(declaredTokens(css), []);
  assert.deepEqual(referencedTokens(css), []);
  assert.deepEqual(styledClasses(css), ["real"]);
});

test("usedClasses reads className, class, and the braced-literal form", () => {
  const src = [
    '<div className="a b" />',
    '<main class="c" />',
    '<span className={"d"} />',
    "<i className={cx('skipped', x)} />",
  ].join("\n");
  assert.deepEqual(usedClasses(src).sort(), ["a", "b", "c", "d"]);
});

test("a line carrying the app-css-allow marker contributes no class names", () => {
  const src = [
    '<div className="counted" />',
    '<div className="exempt" /> {/* app-css-allow: runtime hook, never styled */}',
    '<div className="bare" /> {/* app-css-allow: */}',
  ].join("\n");
  // The reason is MANDATORY: a bare marker with no reason does not exempt.
  assert.deepEqual(usedClasses(src).sort(), ["bare", "counted"]);
});

test("inlineStyleBlocks extracts CSS a source file ships in a <style> block", () => {
  const src = "return `<style>\n  .self-styled { color: red; }\n</style>`;";
  assert.deepEqual(styledClasses(inlineStyleBlocks(src).join("\n")), ["self-styled"]);
});

// ---- check A: dangling tokens ----------------------------------------------

test("a dangling var(--ito-*) in an app stylesheet is a violation", () => {
  const offenders = findDanglingTokens(
    [{ path: "apps/x/src/a.css", contents: ".a { color: var(--ito-color-ink); }" }],
    [{ path: "tokens.css", contents: DS_TOKENS }],
  );
  assert.deepEqual(offenders, [{ file: "apps/x/src/a.css", tokens: ["--ito-color-ink"] }]);
});

test("a var() FALLBACK does not excuse a dangling primary token", () => {
  const offenders = findDanglingTokens(
    [
      {
        path: "apps/x/src/a.css",
        contents: ".a { font-size: var(--ito-text-small, var(--ito-text-pixel)); }",
      },
    ],
    [{ path: "tokens.css", contents: ":root { --ito-text-pixel: 0.68rem; }" }],
  );
  assert.deepEqual(offenders, [{ file: "apps/x/src/a.css", tokens: ["--ito-text-small"] }]);
});

test("a resolved token reference is clean", () => {
  assert.deepEqual(
    findDanglingTokens(
      [{ path: "apps/x/src/a.css", contents: ".a { color: var(--ito-color-text); }" }],
      [{ path: "tokens.css", contents: DS_TOKENS }],
    ),
    [],
  );
});

// ---- check B: unstyled classes ---------------------------------------------

test("a class used in app source with no rule anywhere is reported", () => {
  const unstyled = findUnstyledClasses(
    [{ path: "apps/x/src/a.tsx", contents: '<div className="itotori-shell-frame styled" />' }],
    [{ path: "apps/x/src/a.css", contents: ".styled { color: red; }" }],
  );
  assert.deepEqual(unstyled, [{ name: "itotori-shell-frame", files: ["apps/x/src/a.tsx"] }]);
});

test("a class styled by ANY stylesheet (including the DS) is clean", () => {
  assert.deepEqual(
    findUnstyledClasses(
      [{ path: "apps/x/src/a.tsx", contents: '<div className="itotori-panel" />' }],
      [{ path: "packages/itotori-ds/src/p.css", contents: ".itotori-panel { color: red; }" }],
    ),
    [],
  );
});

test("the checked-in app has no unstyled static classes without a whitelist", () => {
  const root = join(here, "..");
  const scanned = scanTree(root);
  assert.equal(existsSync(join(here, "lint", "app-css-unstyled-class-whitelist.json")), false);
  assert.deepEqual(findUnstyledClasses(scanned.appSource, scanned.allCss), []);
});

// The measured false-positive source: a server-rendered route that ships its
// own <style> block instead of importing a .css file. Eight real classes were
// mis-reported as unstyled before this was handled.
test("a class styled by an inline <style> block in the SAME file is clean", () => {
  assert.deepEqual(
    findUnstyledClasses(
      [
        {
          path: "apps/x/src/route.ts",
          contents:
            'const page = `<main class="self-styled"></main>` + ' +
            "`<style>.self-styled { display: flex; }</style>`;",
        },
      ],
      [],
    ),
    [],
  );
});

test("the allow marker keeps a deliberately unstyled class out of the report", () => {
  assert.deepEqual(
    findUnstyledClasses(
      [
        {
          path: "apps/x/src/a.tsx",
          contents: '<div className="hook-only" /> // app-css-allow: selector for an external tool',
        },
      ],
      [],
    ),
    [],
  );
});

test("the whitelist grandfathers an existing offender but not a new one", () => {
  const unstyled = [
    { name: "old-class", files: ["apps/x/src/a.tsx"] },
    { name: "new-class", files: ["apps/x/src/a.tsx"] },
  ];
  const result = evaluateUnstyled(unstyled, { classes: ["old-class"] });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.violations.map((v) => v.name),
    ["new-class"],
  );
});

test("a whitelisted class that got styled is reported as stale, not as a failure", () => {
  const result = evaluateUnstyled([], { classes: ["now-styled"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.stale, ["now-styled"]);
});

// ---- ratchet ---------------------------------------------------------------

test("--update REFUSES to add a new unstyled class (shrink-only)", () => {
  const result = evaluateUpdate([{ name: "new-class", files: ["apps/x/src/a.tsx"] }], {
    classes: [],
    total: 0,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.newEntries, ["new-class"]);
});

test("--update accepts a shrink and rewrites the whitelist", () => {
  const result = evaluateUpdate([{ name: "kept", files: ["apps/x/src/a.tsx"] }], {
    classes: ["kept", "dropped"],
    total: 2,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.whitelist.classes, ["kept"]);
  assert.equal(result.whitelist.total, 1);
});

test("buildNextWhitelist emits a sorted, stable class list", () => {
  const next = buildNextWhitelist(
    [
      { name: "b", files: [] },
      { name: "a", files: [] },
    ],
    "2026-01-01T00:00:00.000Z",
  );
  assert.deepEqual(next.classes, ["a", "b"]);
  assert.equal(next.total, 2);
});

// ---- end-to-end over a real tree -------------------------------------------

test("scanTree partitions app stylesheets, all stylesheets, and app source", () => {
  const root = makeTree({
    "apps/x/src/a.css": ".a {}",
    "apps/x/src/a.tsx": '<div className="a" />',
    "packages/ds/tokens.css": DS_TOKENS,
    "scripts/not-app.ts": '<div className="z" />',
  });
  const scanned = scanTree(root);
  assert.deepEqual(
    scanned.appCss.map((f) => f.path),
    ["apps/x/src/a.css"],
  );
  assert.deepEqual(scanned.allCss.map((f) => f.path).sort(), [
    "apps/x/src/a.css",
    "packages/ds/tokens.css",
  ]);
  assert.deepEqual(
    scanned.appSource.map((f) => f.path),
    ["apps/x/src/a.tsx"],
  );
});

test("CLI exits 1 and names the file on a dangling token", () => {
  const root = makeTree({
    "apps/x/src/a.css": ".a { color: var(--ito-color-ink); }",
    "apps/x/src/a.tsx": '<div className="a" />',
    "packages/ds/tokens.css": DS_TOKENS,
  });
  const out = runCli(root, join(root, "whitelist.json"));
  assert.equal(out.code, 1);
  assert.match(out.stderr, /dangling design-token reference/u);
  assert.match(out.stderr, /apps\/x\/src\/a\.css: --ito-color-ink/u);
});

test("CLI exits 1 and names the class on an unstyled class", () => {
  const root = makeTree({
    "apps/x/src/a.css": ".a { color: var(--ito-color-text); }",
    "apps/x/src/a.tsx": '<div className="a itotori-shell-frame" />',
    "packages/ds/tokens.css": DS_TOKENS,
  });
  const out = runCli(root, join(root, "whitelist.json"));
  assert.equal(out.code, 1);
  assert.match(out.stderr, /no CSS rule anywhere/u);
  assert.match(out.stderr, /\.itotori-shell-frame/u);
});

test("CLI exits 0 on a tree whose tokens resolve and whose classes are styled", () => {
  const root = makeTree({
    "apps/x/src/a.css": ".a { color: var(--ito-color-text); }",
    "apps/x/src/a.tsx": '<div className="a" />',
    "packages/ds/tokens.css": DS_TOKENS,
  });
  const out = runCli(root, join(root, "whitelist.json"));
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /app-css-contract ok/u);
});

test("CLI scans a NEW untracked stylesheet, not only committed ones", () => {
  const root = makeTree({
    "apps/x/src/a.tsx": '<div className="a" />',
    "packages/ds/tokens.css": DS_TOKENS,
  });
  // Written after `git add`, so it is untracked-but-not-ignored.
  writeFileSync(join(root, "apps/x/src/a.css"), ".a { color: var(--ito-nope); }");
  const out = runCli(root, join(root, "whitelist.json"));
  assert.equal(out.code, 1);
  assert.match(out.stderr, /--ito-nope/u);
});
