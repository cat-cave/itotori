#!/usr/bin/env node
// CI guard: the APP CSS contract — no dangling design tokens, no unstyled classes.
//
// Why this exists. `packages/itotori-ds/test/tokens.test.ts` proves every
// `var(--ito-*)` reference resolves — but ONLY across DS component surfaces
// (the files reachable from the DS component barrel). App stylesheets were
// never checked by anything, and app TSX class names were never checked by
// anything at all. Both holes shipped real, invisible breakage:
//
//   * `var(--ito-color-ink)` on an amber-filled button. The token does not
//     exist, so the whole `color:` declaration is DROPPED by the CSS parser and
//     the button inherited lavender-white ink on an amber fill.
//   * `.itotori-shell-frame` (33 uses), `.itotori-shell` (35 uses),
//     `.itotori-status-strip`, `.itotori-section-grid`, `.itotori-shell-toolbar`
//     and `.itotori-shell-toast-viewport` had no rule in any stylesheet, so the
//     entire app chrome rendered as unstyled browser default HTML around a
//     fully styled interior.
//
// Neither failure raises an error anywhere: an undefined custom property is a
// silent no-op, and a class with no rule is silently inert. Only a guard or a
// human looking at a screenshot can catch them. This is the guard.
//
// Two checks:
//
//   A. DANGLING TOKENS (absolute, no whitelist). Every `var(--ito-*)`
//      referenced by an app stylesheet must be declared by some stylesheet in
//      the repo (the DS token groups, or the app sheet itself). A fallback
//      (`var(--ito-x, var(--ito-y))`) does NOT excuse the reference: a fallback
//      silently pins the surface to the wrong value forever and hides the fact
//      that the intended token was never added. Fix the name or add the token.
//
//   B. UNSTYLED CLASSES (shrink-only ratchet). Every class name written in app
//      source (`className="…"` in TSX, `class="…"` in server-rendered HTML
//      template strings) must have a rule in some stylesheet. The current
//      backlog of rule-less classes is GRANDFATHERED in a whitelist that may
//      only shrink, mirroring `scripts/file-line-cap-guard.mjs`: `--update`
//      REFUSES to add a new entry, so a newly introduced class must be styled —
//      it can never appear invisibly again. As classes get styled the whitelist
//      ratchets toward empty, at which point the check is absolute.
//
// Scope: app stylesheets + app source under `apps/*/src/`. Class RULES are
// collected from EVERY stylesheet in the repo (app + DS) AND from `<style>`
// blocks carried inline in source files, because an app class is legitimately
// allowed to be styled by the design system or by a self-styled server-rendered
// route. Handling the inline case removed 8 measured false positives (the
// asset-decisions and catalog-context routes ship their own <style> block);
// an independent cross-check of the remaining 93 grandfathered classes, run
// with a separate implementation, found 0 that had a rule after all.
//
// Check B is deliberately conservative about what it even looks at:
//   * only STATIC class literals — an interpolated or `cx(…)`-computed class is
//     never guessed at;
//   * a per-line `app-css-allow: <reason>` marker (non-empty reason required)
//     is an explicit, reviewable opt-out for a class that is genuinely not a
//     styling hook, so the guard can never become a cry-wolf blocker.
//
// Exit codes: 0 = clean / update applied; 1 = violation or refused update.
// Wired into `just audit` and `just ci-tier0-meta` (test then run), mirroring
// the `audit-no-hardcoded-cost` / `file-line-cap-guard` house style.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const DEFAULT_WHITELIST_PATH = join(here, "lint", "app-css-unstyled-class-whitelist.json");

const WHITELIST_HEADER = `RATCHET WHITELIST (shrink-only). Do not hand-edit; regenerate via
"node scripts/audit-app-css-contract.mjs --update". Each entry is a class name
written in app source that has no CSS rule in any stylesheet. Entries may only
be REMOVED (by styling the class or deleting the usage) — the update mode
refuses to add one, so a newly introduced class must ship with a rule. When
empty/deleted the check is absolute.`;

/** App stylesheets: the sheets this guard holds to the token contract. */
export const APP_CSS_PATTERN = /^apps\/[^/]+\/.*\.css$/u;
/** App source: TSX components plus TS modules that emit HTML strings. */
export const APP_SOURCE_PATTERN = /^apps\/[^/]+\/src\/.*\.(?:tsx|ts)$/u;
/** Every stylesheet in the repo defines rules an app class may rely on. */
export const ANY_CSS_PATTERN = /\.css$/u;

export function emptyWhitelist() {
  return {
    description: WHITELIST_HEADER,
    generatedAt: null,
    total: 0,
    classes: [],
  };
}

export function loadWhitelist(path) {
  if (!existsSync(path)) return emptyWhitelist();
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return {
    description: WHITELIST_HEADER,
    generatedAt: parsed.generatedAt ?? null,
    total: parsed.total ?? 0,
    classes: parsed.classes ?? [],
  };
}

// ---- CSS / source parsing ---------------------------------------------------

/** Strip `/* … *\/` comments so commented-out names never count. */
export function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//gu, "");
}

/** Custom properties DECLARED by a stylesheet (`--ito-x: value`). */
export function declaredTokens(css) {
  return [...stripCssComments(css).matchAll(/(--ito-[a-z0-9-]+)\s*:/gu)].map((m) => m[1]);
}

/**
 * Custom properties REFERENCED by a stylesheet. A `var(--a, var(--b))` chain
 * yields BOTH names — a fallback does not excuse a dangling primary.
 */
export function referencedTokens(css) {
  return [...stripCssComments(css).matchAll(/var\(\s*(--ito-[a-z0-9-]+)/gu)].map((m) => m[1]);
}

/** Class names a stylesheet defines a rule for (`.name` in any selector). */
export function styledClasses(css) {
  return [...stripCssComments(css).matchAll(/\.(-?[_a-zA-Z][\w-]*)/gu)].map((m) => m[1]);
}

/**
 * CSS carried INLINE in a source file, inside `<style>…</style>` blocks. The
 * server-rendered HTML routes ship their own stylesheet in a template literal
 * rather than importing a `.css` file, so their rules are invisible to a
 * stylesheet-only scan. Counting them is what keeps a self-styled route from
 * being reported as unstyled.
 */
export function inlineStyleBlocks(source) {
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gu)].map((m) => m[1]);
}

/**
 * A per-line opt-out for the class check, mirroring the `cost-audit-allow:`
 * marker in `audit-no-hardcoded-cost.mjs`. A line carrying
 * `app-css-allow: <reason>` (non-empty reason REQUIRED) contributes no class
 * names. This exists so the guard can never become a cry-wolf blocker for a
 * class that is genuinely not a styling hook — the opt-out is explicit, local,
 * and reviewable in the diff, rather than a silent global exemption.
 */
// The reason must contain an actual word — comment-closing punctuation
// (`app-css-allow: */}`) is NOT a reason and does not exempt the line.
export const ALLOW_MARKER = /app-css-allow:[^A-Za-z0-9\n]*[A-Za-z0-9]/u;

/**
 * Class names written in app source. Reads static `className="a b"` /
 * `class="a b"` attributes and the `className={"a b"}` expression form.
 * Interpolated values (`${…}` / `{cx(…)}`) are deliberately NOT parsed: a
 * computed class cannot be resolved statically, and guessing would produce
 * false failures. Static literals are where the observed defects lived.
 */
export function usedClasses(source) {
  const names = [];
  const attr = /(?:className|class)=(?:"([^"{}]*)"|\{\s*"([^"{}$`]*)"\s*\})/gu;
  for (const line of source.split(/\r?\n/u)) {
    if (ALLOW_MARKER.test(line)) continue;
    for (const m of line.matchAll(attr)) {
      const value = m[1] ?? m[2] ?? "";
      for (const name of value.split(/\s+/u)) {
        if (name.length > 0) names.push(name);
      }
    }
  }
  return names;
}

// ---- evaluation -------------------------------------------------------------

/**
 * Check A. Returns `[{ file, tokens: [...] }]` for every app stylesheet that
 * references an `--ito-*` custom property no stylesheet declares.
 */
export function findDanglingTokens(appCss, allCss) {
  const declared = new Set();
  for (const { contents } of allCss) {
    for (const name of declaredTokens(contents)) declared.add(name);
  }
  const offenders = [];
  for (const { path, contents } of appCss) {
    const missing = [...new Set(referencedTokens(contents))]
      .filter((name) => !declared.has(name))
      .sort();
    if (missing.length > 0) offenders.push({ file: path, tokens: missing });
  }
  return offenders;
}

/**
 * Check B (raw). Returns the sorted set of class names used in app source with
 * no rule in ANY stylesheet — a `.css` file, or a `<style>` block carried
 * inline in a source file. Each entry lists the files that use it.
 */
export function findUnstyledClasses(appSource, allCss) {
  const styled = new Set();
  for (const { contents } of allCss) {
    for (const name of styledClasses(contents)) styled.add(name);
  }
  // Rules a source file ships inline count exactly as much as a .css file's.
  for (const { contents } of appSource) {
    for (const block of inlineStyleBlocks(contents)) {
      for (const name of styledClasses(block)) styled.add(name);
    }
  }
  const byClass = new Map();
  for (const { path, contents } of appSource) {
    for (const name of usedClasses(contents)) {
      if (styled.has(name)) continue;
      if (!byClass.has(name)) byClass.set(name, new Set());
      byClass.get(name).add(path);
    }
  }
  return [...byClass.entries()]
    .map(([name, files]) => ({ name, files: [...files].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Apply the shrink-only whitelist to the raw check-B result. */
export function evaluateUnstyled(unstyled, whitelist) {
  const allowed = new Set(whitelist.classes ?? []);
  const violations = unstyled.filter((entry) => !allowed.has(entry.name));
  const stale = [...allowed].filter((name) => !unstyled.some((e) => e.name === name)).sort();
  return { ok: violations.length === 0, violations, stale };
}

export function buildNextWhitelist(unstyled, at) {
  const classes = unstyled.map((entry) => entry.name).sort();
  return {
    description: WHITELIST_HEADER,
    generatedAt: at,
    total: classes.length,
    classes,
  };
}

/** `--update`: refuse to grow. A newly unstyled class must be styled instead. */
export function evaluateUpdate(unstyled, oldWhitelist) {
  const oldClasses = new Set(oldWhitelist.classes ?? []);
  const next = buildNextWhitelist(unstyled, new Date().toISOString());
  const newEntries = next.classes.filter((name) => !oldClasses.has(name));
  return {
    ok: newEntries.length === 0,
    newEntries,
    oldTotal: oldWhitelist.total ?? 0,
    newTotal: next.total,
    whitelist: next,
  };
}

// ---- tree scanning ----------------------------------------------------------

/**
 * Tracked files PLUS new-but-not-ignored files, so a stylesheet or component
 * added in the working tree is scanned before it is ever committed.
 */
export function listRepoFiles(root) {
  const out = execSync("git ls-files --cached --others --exclude-standard", {
    cwd: root,
    encoding: "utf8",
  });
  return [
    ...new Set(
      out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    ),
  ].sort();
}

function readAll(root, paths) {
  const out = [];
  for (const path of paths) {
    let contents;
    try {
      contents = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    out.push({ path, contents });
  }
  return out;
}

export function scanTree(root) {
  const files = listRepoFiles(root);
  return {
    appCss: readAll(
      root,
      files.filter((p) => APP_CSS_PATTERN.test(p)),
    ),
    allCss: readAll(
      root,
      files.filter((p) => ANY_CSS_PATTERN.test(p)),
    ),
    appSource: readAll(
      root,
      files.filter((p) => APP_SOURCE_PATTERN.test(p)),
    ),
  };
}

// ---- CLI --------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { mode: "check", whitelist: DEFAULT_WHITELIST_PATH, root: repoRoot, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--update" || a === "--regenerate") opts.mode = "update";
    else if (a === "--init") opts.mode = "init";
    else if (a === "--check") opts.mode = "check";
    else if (a === "--whitelist") opts.whitelist = argv[(i += 1)];
    else if (a.startsWith("--whitelist=")) opts.whitelist = a.slice("--whitelist=".length);
    else if (a === "--root") opts.root = resolve(argv[(i += 1)]);
    else if (a.startsWith("--root=")) opts.root = resolve(a.slice("--root=".length));
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function usage() {
  return [
    "usage: node scripts/audit-app-css-contract.mjs [--check|--update|--init] [--whitelist PATH] [--root DIR]",
    "",
    "check   fail on a dangling var(--ito-*) in any app stylesheet (absolute), or a",
    "        class used in app source with no CSS rule that is not grandfathered (default).",
    "update  rewrite the unstyled-class whitelist; REFUSE to add an entry (shrink ratchet).",
    "init    one-time bootstrap: write the whitelist from the current tree unconditionally.",
  ].join("\n");
}

function writeWhitelist(path, whitelist) {
  writeFileSync(path, `${JSON.stringify(whitelist, null, 2)}\n`);
}

export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const { appCss, allCss, appSource } = scanTree(opts.root);
  const dangling = findDanglingTokens(appCss, allCss);
  const unstyled = findUnstyledClasses(appSource, allCss);

  if (opts.mode === "init") {
    writeWhitelist(opts.whitelist, buildNextWhitelist(unstyled, new Date().toISOString()));
    process.stdout.write(`app-css-contract: wrote ${unstyled.length} grandfathered classes\n`);
    return 0;
  }

  const whitelist = loadWhitelist(opts.whitelist);

  if (opts.mode === "update") {
    const result = evaluateUpdate(unstyled, whitelist);
    if (!result.ok) {
      process.stderr.write(
        "app-css-contract: refusing to grow the unstyled-class whitelist.\n" +
          "  These classes are written in app source but have no CSS rule anywhere.\n" +
          "  Add a rule (or delete the usage) — the ratchet only shrinks:\n" +
          result.newEntries.map((n) => `    ${n}\n`).join(""),
      );
      return 1;
    }
    writeWhitelist(opts.whitelist, result.whitelist);
    process.stdout.write(
      `app-css-contract: whitelist ${result.oldTotal} -> ${result.newTotal} unstyled classes\n`,
    );
    return 0;
  }

  let failed = false;

  if (dangling.length > 0) {
    failed = true;
    process.stderr.write(
      "app-css-contract: dangling design-token reference(s).\n" +
        "  A var(--ito-*) that no stylesheet declares makes the WHOLE declaration a\n" +
        "  silent no-op. Map it to an existing token, or add it to the DS token groups:\n" +
        dangling.map((d) => `    ${d.file}: ${d.tokens.join(", ")}\n`).join(""),
    );
  }

  const classResult = evaluateUnstyled(unstyled, whitelist);
  if (!classResult.ok) {
    failed = true;
    process.stderr.write(
      "app-css-contract: class(es) used in app source with no CSS rule anywhere.\n" +
        "  An unstyled class is silently inert — the element renders as raw browser HTML:\n" +
        classResult.violations
          .map((v) => `    .${v.name}  (${v.files.length} file(s), e.g. ${v.files[0]})\n`)
          .join(""),
    );
  }

  if (failed) return 1;

  if (classResult.stale.length > 0) {
    process.stdout.write(
      `app-css-contract: ${classResult.stale.length} whitelisted class(es) now styled — ` +
        "run `node scripts/audit-app-css-contract.mjs --update` to shrink the ratchet.\n",
    );
  }
  process.stdout.write(
    `app-css-contract ok: ${appCss.length} app stylesheet(s), 0 dangling tokens; ` +
      `${appSource.length} app source file(s), ${unstyled.length} grandfathered unstyled class(es)\n`,
  );
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
