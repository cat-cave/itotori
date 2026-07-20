// Token-foundation pin (ds-adopt-design-tokens).
//
// The design-system token foundation is a SINGLE source of truth: a
// `tokens/styles.css` entry that @imports nine token groups + the component
// layer; the dashboard shell consumes the bundle once and every component
// references `--ito-*` variables, never hard-coded literals. This test pins
// those three invariants behaviour-first / code-agnostic so a regression
// (a dropped module, a dangling `var()`, a stray hex) fails the gate.
//
// It is intentionally filesystem + string based — it asserts OBSERVABLE
// properties of the CSS (every `@import` resolves, every `var(--ito-x)` is
// defined, no colour literals leak into a component), never component internals.
import { readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const STYLES_ENTRY_REL = "tokens/styles.css";

// The nine token groups the design language names as the foundation
// (docs/design/itotori-design-system.md §Token groups). The entry must import
// exactly this set — a dropped or renamed module is a foundation regression.
const SPECCED_TOKEN_GROUPS = new Set([
  "colors",
  "fonts",
  "typography",
  "spacing",
  "interface",
  "forms",
  "prose",
  "diagram",
  "effects",
]);

// Extract every `@import "./rel.css";` path from a CSS source, returned as the
// literal relative string the barrel declares (unresolved).
function importPaths(css: string): string[] {
  const out: string[] = [];
  for (const line of css.split(/\r?\n/u)) {
    const m = /@import\s+"([^"]+\.css)"/u.exec(line);
    if (m !== null) out.push(m[1] as string);
  }
  return out;
}

// Resolve a CSS `@import` string against the importer file (repo-relative),
// returning a repo-relative path. `@import` paths are relative to the file
// that declares them, so `tokens/styles.css`'s `./colors.css` -> `tokens/colors.css`
// and its `../src/components/components.css` -> `src/components/components.css`.
function resolveImport(importerRel: string, importStr: string): string {
  const importerDir = join(pkgRoot, dirname(importerRel));
  return relative(pkgRoot, resolve(importerDir, importStr));
}

// Strip `/* … */` CSS comments so literals or names mentioned only in comments
// do not trip the value-scanning assertions below.
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, "");
}

// Custom-property declarations defined across the foundation (`--ito-x:`).
function definedTokens(tokenCss: string[]): Set<string> {
  const names = new Set<string>();
  for (const css of tokenCss) {
    for (const m of css.matchAll(/--ito-[a-z0-9-]+/gu)) {
      names.add(m[0] as string);
    }
  }
  return names;
}

// Custom-property references (`var(--ito-x)`, including the `, fallback` form)
// used by a consumer surface.
function referencedTokens(css: string): string[] {
  return [...css.matchAll(/var\((--ito-[a-z0-9-]+)/gu)].map((m) => m[1] as string);
}

// Colour literals a component must NOT inline — it must reference a token
// instead. Hex (`#rgb` / `#rrggbb` / `#rrggbbaa`) and the rgb/rgba/hsl/hsla
// functions. Comment-stripped first so commented-out values don't trip.
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/u;

function read(rel: string): string {
  return readFileSync(join(pkgRoot, rel), "utf8");
}

function readSafe(rel: string): string | null {
  try {
    return readFileSync(join(pkgRoot, rel), "utf8");
  } catch {
    return null;
  }
}

describe("design-system token foundation / single entry", () => {
  it("ships a styles.css entry that imports every specced token group + the component layer", () => {
    const entry = read(STYLES_ENTRY_REL);
    const resolved = importPaths(entry).map((p) => resolveImport(STYLES_ENTRY_REL, p));

    // Exactly the nine specced groups live under tokens/.
    const groups = new Set(
      resolved
        .filter((p) => p.startsWith("tokens/") && p !== "tokens/styles.css")
        .map((p) => basename(p).replace(/\.css$/u, "")),
    );
    expect(groups).toEqual(SPECCED_TOKEN_GROUPS);

    // Plus the component layer barrel, which is what makes this the SINGLE CSS
    // entry the dashboard imports once.
    expect(resolved).toContain("src/components/components.css");
  });

  it("resolves every @import declared by the entry and the component barrel to a real file", () => {
    const entry = read(STYLES_ENTRY_REL);
    for (const rel of importPaths(entry).map((p) => resolveImport(STYLES_ENTRY_REL, p))) {
      expect(readSafe(rel), `${rel} should exist`).not.toBeNull();
    }
    const barrelRel = "src/components/components.css";
    const barrel = read(barrelRel);
    for (const rel of importPaths(barrel).map((p) => resolveImport(barrelRel, p))) {
      expect(readSafe(rel), `${rel} should exist`).not.toBeNull();
    }
  });
});

describe("design-system token foundation / components reference tokens, never literals", () => {
  // The set of component + gallery CSS files — derived from the component
  // barrel (the shipped layer) plus the gallery demo surface that also consumes
  // the DS. Every one is held to the same tokens-not-literals bar.
  function componentSurfaces(): string[] {
    const barrelRel = "src/components/components.css";
    const barrel = read(barrelRel);
    const surfaces = importPaths(barrel).map((p) => resolveImport(barrelRel, p));
    surfaces.push("src/gallery/gallery.css");
    return surfaces;
  }

  it("every component surface is free of hard-coded colour literals (hex / rgb / hsl)", () => {
    const offenders: string[] = [];
    for (const rel of componentSurfaces()) {
      const css = stripComments(read(rel));
      if (COLOUR_LITERAL.test(css)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every var(--ito-*) reference in a component surface resolves to a defined token", () => {
    const tokenCss = [...SPECCED_TOKEN_GROUPS].map((g) => read(`tokens/${g}.css`));
    const defined = definedTokens(tokenCss);

    const dangling = new Map<string, string[]>();
    for (const rel of componentSurfaces()) {
      const used = referencedTokens(stripComments(read(rel)));
      const missing = [...new Set(used)].filter((name) => !defined.has(name));
      if (missing.length > 0) dangling.set(rel, missing);
    }
    expect([...dangling.entries()]).toEqual([]);
  });
});

describe("design-system token foundation / reconciled missing-token candidates", () => {
  it("defines the semantic tokens flagged by the design brief", () => {
    const tokenCss = [...SPECCED_TOKEN_GROUPS].map((g) => read(`tokens/${g}.css`));
    const defined = definedTokens(tokenCss);
    const required = [
      "--ito-cost-billed-ink",
      "--ito-cost-zero-muted",
      "--ito-cost-unknown-ink",
      "--ito-cost-unknown-dash",
      "--ito-privacy-ok-fg",
      "--ito-privacy-ok-bg",
      "--ito-privacy-ok-border",
      "--ito-render-scrim",
      "--ito-render-textbox-bg",
      "--ito-render-textbox-border",
      "--ito-render-textbox-blur",
      "--ito-render-nameplate-bg",
      "--ito-render-nameplate-fg",
      "--ito-render-nameplate-border",
      "--ito-redact-blur",
      "--ito-redact-overlay",
      "--ito-redact-fg",
      "--ito-redact-border",
      "--ito-severity-blocker",
      "--ito-severity-critical",
      "--ito-severity-warning",
      "--ito-severity-note",
      "--ito-pass-current-border",
      "--ito-pass-next-border",
      "--ito-pass-accepted-delta",
      "--ito-pass-superseded-fg",
      "--ito-pass-diff-added",
      "--ito-pass-diff-removed",
      "--ito-locale-source-accent",
      "--ito-locale-source-bg",
      "--ito-locale-source-border",
      "--ito-locale-target-accent",
      "--ito-locale-target-bg",
      "--ito-locale-target-border",
    ];

    expect(required.filter((name) => !defined.has(name))).toEqual([]);
  });
});
