// reallive-source-resolver — the structure stage resolves its game root the
// SAME way the extract stage does (issue #64 E2). These tests pin the
// resolution algorithm against the Rust `resolve_reallive_game_root` /
// `game_root_gameexe_path` semantics with a fully in-memory fs probe, plus an
// env-gated check on the REAL Sweetie HD min-root (nested game dir).

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveRealliveGameRoot,
  resolveRealliveSourcePaths,
  type RealliveSourceFsProbe,
} from "../src/orchestrator/reallive-source-resolver.js";

/**
 * Build an in-memory probe from a set of directory paths and file paths. Dirs
 * and files are matched exactly (case-sensitive, mirroring the Rust resolver on
 * a case-sensitive filesystem).
 */
function fakeProbe(opts: { dirs: string[]; files?: string[] }): RealliveSourceFsProbe {
  const dirs = new Set(opts.dirs);
  const files = new Set(opts.files ?? []);
  return {
    isDir: (path) => dirs.has(path),
    isFile: (path) => files.has(path),
    listChildDirs: (path) => {
      const prefix = `${path}/`;
      const children = new Set<string>();
      for (const d of dirs) {
        if (!d.startsWith(prefix)) continue;
        const rest = d.slice(prefix.length);
        if (rest.length === 0 || rest.includes("/")) continue; // direct children only
        children.add(d);
      }
      return [...children].sort();
    },
  };
}

describe("resolveRealliveGameRoot (mirrors kaifuu resolve_reallive_game_root)", () => {
  it("returns the root itself when it directly contains REALLIVEDATA/ (depth 0)", () => {
    const root = "/g/title";
    const probe = fakeProbe({ dirs: [root, `${root}/REALLIVEDATA`] });
    expect(resolveRealliveGameRoot(root, probe)).toBe(root);
  });

  it("descends into the single nested game folder that holds REALLIVEDATA/ (Sweetie HD shape)", () => {
    const parent = "/g/min-root";
    const title = `${parent}/JP-Title`;
    const probe = fakeProbe({ dirs: [parent, title, `${title}/REALLIVEDATA`] });
    // The staging parent has no REALLIVEDATA directly, but exactly one child does.
    expect(resolveRealliveGameRoot(parent, probe)).toBe(title);
  });

  it("returns null (ambiguous) when two children each contain REALLIVEDATA/", () => {
    const parent = "/g/multi";
    const a = `${parent}/a`;
    const b = `${parent}/b`;
    const probe = fakeProbe({
      dirs: [parent, a, `${a}/REALLIVEDATA`, b, `${b}/REALLIVEDATA`],
    });
    expect(resolveRealliveGameRoot(parent, probe)).toBeNull();
  });

  it("descends through single-child wrapper directories up to the bound", () => {
    // parent -> only child w1 -> only child w2 (holds REALLIVEDATA)
    const parent = "/g/wrap";
    const w1 = `${parent}/w1`;
    const w2 = `${w1}/w2`;
    const probe = fakeProbe({ dirs: [parent, w1, w2, `${w2}/REALLIVEDATA`] });
    expect(resolveRealliveGameRoot(parent, probe)).toBe(w2);
  });

  it("returns null when nothing is found within the descent bound", () => {
    const probe = fakeProbe({ dirs: ["/nope"] });
    expect(resolveRealliveGameRoot("/nope", probe)).toBeNull();
  });
});

describe("resolveRealliveSourcePaths", () => {
  it("resolves gameexe + seen inside the nested game folder", () => {
    const parent = "/g/min-root";
    const title = `${parent}/JP-Title`;
    const data = `${title}/REALLIVEDATA`;
    const probe = fakeProbe({
      dirs: [parent, title, data],
      files: [`${data}/Gameexe.ini`, `${data}/Seen.txt`],
    });
    const paths = resolveRealliveSourcePaths(parent, probe);
    expect(paths.gameexePath).toBe(`${data}/Gameexe.ini`);
    expect(paths.seenPath).toBe(`${data}/Seen.txt`);
  });

  it("prefers REALLIVEDATA/Gameexe.ini, then a root-level Gameexe.ini", () => {
    const root = "/g/title";
    const data = `${root}/REALLIVEDATA`;
    // Gameexe sits at the root, not in REALLIVEDATA.
    const probe = fakeProbe({
      dirs: [root, data],
      files: [`${root}/Gameexe.ini`, `${data}/Seen.txt`],
    });
    const paths = resolveRealliveSourcePaths(root, probe);
    expect(paths.gameexePath).toBe(`${root}/Gameexe.ini`);
    expect(paths.seenPath).toBe(`${data}/Seen.txt`);
  });

  it("falls back to <sourceRoot>/REALLIVEDATA/* when no REALLIVEDATA is found (prior default preserved)", () => {
    // A non-existent path (the CI orchestration test's fake source) must yield
    // exactly the legacy default so the existing tests keep passing.
    const probe = fakeProbe({ dirs: [] });
    const paths = resolveRealliveSourcePaths("/games/sweetie", probe);
    expect(paths.gameexePath).toBe(join("/games/sweetie", "REALLIVEDATA", "Gameexe.ini"));
    expect(paths.seenPath).toBe(join("/games/sweetie", "REALLIVEDATA", "Seen.txt"));
  });
});

// ---------------------------------------------------------------------------
// Real-bytes multi-game invariant: the SAME resolver descends into the nested
// Sweetie HD game folder from the staging-parent `--source`, proving extract and
// structure now accept the same root. Env-gated so CI (no real bytes) skips.
// ---------------------------------------------------------------------------
const REAL_ROOTS = ["/scratch/itotori-research/sweetie-hd/min-root"];

describe("resolveRealliveSourcePaths on real game roots (nested descent)", () => {
  for (const root of REAL_ROOTS) {
    const present = existsSync(root) && statSync(root).isDirectory();
    it.skipIf(!present)(`descends ${root} to a real REALLIVEDATA/{Gameexe.ini,Seen.txt}`, () => {
      const paths = resolveRealliveSourcePaths(root);
      // The staging parent does NOT directly contain REALLIVEDATA; resolution
      // must have descended into the nested game folder.
      expect(paths.seenPath.endsWith("/REALLIVEDATA/Seen.txt")).toBe(true);
      expect(paths.seenPath).not.toBe(join(root, "REALLIVEDATA", "Seen.txt"));
      expect(existsSync(paths.seenPath)).toBe(true);
      expect(existsSync(paths.gameexePath)).toBe(true);
    });
  }
});
