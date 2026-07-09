// beta-user-mode-readme-and-docs — pins the user-mode README + top-level docs
// to the REAL CLI surface so the docs cannot drift or invent commands.
//
// This is a docs-content test on shipped paths: it reads README.md /
// docs/install.md / docs/README.md from the repo and cross-checks every
// `itotori <command>` they reference against the actual `case "..."` command
// dispatch in cli-handlers.ts, and every `localize-game` flag against the real
// `requiredFlag(...)` set inside runLocalizeGame. It also asserts the README
// leads with the USER quickstart (install → init → localize-game → review →
// output) and that developer-only setup is linked out, not the front page.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// test/ → apps/itotori/ (..) → apps/ (../..) → repo root (../../..)
const repoRoot = join(here, "..", "..", "..");
const appSrc = join(here, "..", "src");

const readDoc = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

function fencedBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
}

// Collect the command token for every `itotori <command>` invocation that
// appears inside fenced code blocks or inline code spans (real invocations
// only — prose like "change itotori itself", and argument positions like
// `npm install -g itotori`, are excluded). Tokenizes each code region
// shell-style: joins `\`-continuations into logical lines, strips `#`
// comments, and for each logical line whose FIRST word is `itotori` takes the
// SECOND word as the command/flag. Placeholders like `<version>` are returned
// as-is for the caller to skip.
function itotoriInvocations(markdown: string): string[] {
  const spans: string[] = [...fencedBlocks(markdown)];
  for (const m of markdown.matchAll(/`([^`\n]+)`/g)) spans.push(m[1]);
  const tokens: string[] = [];
  for (const span of spans) {
    const logicalLines: string[] = [];
    let buf = "";
    for (const rawLine of span.split("\n")) {
      const decommented = rawLine.replace(/(^|\s)#.*$/, "$1").replace(/\s+$/, "");
      if (decommented.endsWith("\\")) {
        buf += `${decommented.slice(0, -1)} `;
      } else {
        buf += decommented;
        logicalLines.push(buf);
        buf = "";
      }
    }
    if (buf.trim().length > 0) logicalLines.push(buf);
    for (const line of logicalLines) {
      const words = line.split(/\s+/).filter(Boolean);
      if (words[0] === "itotori" && words.length > 1) {
        tokens.push(words[1]);
      }
    }
  }
  return tokens;
}

function realCliCommands(): Set<string> {
  const handlers = readFileSync(join(appSrc, "cli-handlers.ts"), "utf8");
  const cmds = new Set<string>();
  for (const m of handlers.matchAll(/^\s*case "([a-z][a-z0-9-]*)":/gm)) {
    cmds.add(m[1]);
  }
  // Sanity: the dispatch must actually surface the user commands we document.
  expect(cmds.has("init")).toBe(true);
  expect(cmds.has("localize-game")).toBe(true);
  return cmds;
}

function runLocalizeGameRequiredFlags(): string[] {
  const handlers = readFileSync(join(appSrc, "cli-handlers.ts"), "utf8");
  const start = handlers.indexOf("async function runLocalizeGame(");
  expect(start).toBeGreaterThan(-1);
  const after = handlers.slice(start);
  const nextFn = after.slice(1).search(/\n(?:async )?function /);
  const body = nextFn === -1 ? after : after.slice(0, nextFn + 1);
  return [...body.matchAll(/requiredFlag\([^)]*?"--([a-z0-9-]+)"/g)].map((m) => m[1]);
}

const globalFlags = new Set(["--help", "-h", "--version", "-v", "--env-file"]);

describe("README leads with the USER path, not the developer clone/nix flow", () => {
  const readme = readDoc("README.md");

  it("describes what itotori does for a user in the first screenful", () => {
    const firstScreen = readme.split(/(?=^## )/m)[0];
    expect(firstScreen.toLowerCase()).toContain("localiz");
  });

  it("has no developer-first quickstart heading (the old 'fresh clone' path)", () => {
    expect(readme).not.toMatch(/#{1,4}\s.*Quickstart.*fresh clone/i);
    expect(readme).not.toMatch(/#{1,4}\s.*fresh clone/i);
  });

  it("the first code block is the user install (itotori/npm), not just/nix/direnv", () => {
    const blocks = fencedBlocks(readme);
    expect(blocks.length).toBeGreaterThan(0);
    const first = blocks[0];
    expect(first).toMatch(/itotori/);
    expect(first).not.toMatch(/just install/);
    expect(first).not.toMatch(/just alpha-demo/);
    expect(first).not.toMatch(/\bnix develop\b/);
    expect(first).not.toMatch(/direnv/);
  });

  it("the user quickstart comes before any developer (just ...) command", () => {
    const userStart = readme.indexOf("itotori init");
    expect(userStart).toBeGreaterThan(-1);
    for (const devMarker of ["just install", "just alpha-demo", "just check"]) {
      const devStart = readme.indexOf(devMarker);
      if (devStart !== -1) {
        expect(userStart).toBeLessThan(devStart);
      }
    }
  });

  it("documents the full user flow: install → init → db-migrate → localize-game → review → output", () => {
    expect(readme).toContain("itotori init");
    expect(readme).toContain("itotori db-migrate");
    expect(readme).toContain("itotori localize-game");
    // review surface
    expect(readme.toLowerCase()).toContain("replay");
    expect(readme.toLowerCase()).toContain("render");
    // patched output surface
    expect(readme.toLowerCase()).toContain("patched");
    expect(readme.toLowerCase()).toContain("--target");
  });

  it("links developer-only setup out (CONTRIBUTING + docs/dev), not as the front-page path", () => {
    expect(readme).toMatch(/CONTRIBUTING\.md/);
    expect(readme).toMatch(/docs\/dev/);
  });
});

describe("every itotori command referenced in the docs is a REAL CLI command", () => {
  const commands = realCliCommands();

  for (const doc of ["README.md", "docs/install.md"]) {
    it(`${doc} references only real itotori commands/flags`, () => {
      const markdown = readDoc(doc);
      const tokens = new Set(itotoriInvocations(markdown));
      const problems: string[] = [];
      for (const token of tokens) {
        if (token.startsWith("<")) continue; // placeholder, e.g. <version>
        if (token.startsWith("-")) {
          if (!globalFlags.has(token)) problems.push(`unknown flag: itotori ${token}`);
          continue;
        }
        if (!commands.has(token)) problems.push(`unknown command: itotori ${token}`);
      }
      expect(problems, problems.join("\n")).toEqual([]);
    });
  }
});

describe("the README localize-game block matches the CLI's required flags", () => {
  it("documents every flag runLocalizeGame actually requires", () => {
    const required = runLocalizeGameRequiredFlags();
    expect(required.length).toBeGreaterThan(0);
    const readme = readDoc("README.md");
    const localizeBlock = fencedBlocks(readme).find((b) => b.includes("localize-game"));
    expect(localizeBlock).toBeDefined();
    const missing = required.filter((flag) => !localizeBlock!.includes(`--${flag}`));
    expect(missing, `missing required flags: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("docs/install.md and docs/README.md are user-first", () => {
  it("install.md leads with the user package install before the developer path", () => {
    const install = readDoc("docs/install.md");
    const userSection = install.search(/#{1,4}\s.*User install/i);
    const devSection = install.search(/#{1,4}\s.*Developer.*fresh-clone/i);
    expect(userSection).toBeGreaterThan(-1);
    expect(devSection).toBeGreaterThan(-1);
    expect(userSection).toBeLessThan(devSection);
    expect(install).toContain("itotori init");
    expect(install).toContain("npm install -g itotori");
  });

  it("docs/README.md user-facing section points at the README user quickstart first", () => {
    const docsIndex = readDoc("docs/README.md");
    const startHere = docsIndex.indexOf("start here");
    expect(startHere).toBeGreaterThan(-1);
    const after = docsIndex.slice(startHere);
    const readmeIdx = after.indexOf("README");
    const alphaIdx = after.indexOf("alpha-readiness.md");
    expect(readmeIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeGreaterThan(-1);
    // The README user quickstart must be referenced before the alpha doc.
    expect(readmeIdx).toBeLessThan(alphaIdx);
  });
});
