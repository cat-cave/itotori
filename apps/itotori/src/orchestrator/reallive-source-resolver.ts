// reallive-source-resolver — align the STRUCTURE stage's game-root resolution
// with the EXTRACT stage's, so `itotori localize-game --source <ROOT>` accepts
// the SAME `--source` for both stages (issue #64 E2).
//
// The extract stage forwards `--source` verbatim to `kaifuu-cli extract
// --game-root`, whose Rust resolver (`resolve_reallive_game_root` in
// crates/kaifuu-cli/src/main.rs) DESCENDS a bounded single-child chain to find
// the directory that directly contains `REALLIVEDATA/` — so a `--source` that
// points at a staging parent wrapping a nested game folder (the observed
// Sweetie HD shape `<min-root>/<JP title subdir>/REALLIVEDATA/`) still resolves.
//
// The structure stage previously derived `<source>/REALLIVEDATA/{Gameexe.ini,
// Seen.txt}` with NO descent, so that same `--source` passed extract then failed
// structure loud. This module REIMPLEMENTS the extract resolver's algorithm in
// TypeScript (byte-for-byte semantics: exact-case `REALLIVEDATA`, bounded
// depth-4 single-child descent, the exactly-one-match rules, and the
// `game_root_gameexe_path` Gameexe probe order) so the two stages resolve the
// same root. It is engine-generic: any RealLive title with a nested game dir
// resolves, and the classic `<root>/REALLIVEDATA/` shape still resolves at
// depth 0.
//
// When NO `REALLIVEDATA/` is found within the descent bound, the resolver falls
// back to `<sourceRoot>/REALLIVEDATA/*` — identical to the prior default, so a
// genuinely-absent data dir fails loud downstream EXACTLY as extract does
// (`resolve_reallive_game_root` errors on the same input), and callers that pass
// a non-existent path get the same paths as before.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** On-disk marker directory name (exact case, mirroring the Rust resolver). */
const REALLIVE_DATA_DIR_NAME = "REALLIVEDATA";

/**
 * Descent bound mirroring `resolve_reallive_game_root`'s `visited >= 4` guard:
 * up to 4 single-child descent steps below the input root before giving up.
 */
const MAX_DESCENT_STEPS = 4;

/**
 * Filesystem probe the resolver reads through. Injected so the resolution
 * algorithm is unit-testable without touching the real filesystem; the default
 * (`defaultRealliveSourceFsProbe`) does the real `node:fs` IO.
 */
export type RealliveSourceFsProbe = {
  /** True when `path` exists and is a directory. */
  isDir(path: string): boolean;
  /** True when `path` exists and is a regular file. */
  isFile(path: string): boolean;
  /** Absolute paths of the DIRECT child directories of `path` (or [] on any IO error). */
  listChildDirs(path: string): string[];
};

/** The two source-tree inputs the structure + validate stages read. */
export type RealliveSourcePaths = {
  gameexePath: string;
  seenPath: string;
};

/** Real `node:fs` probe. Swallows IO errors into the negative/empty answer. */
export function defaultRealliveSourceFsProbe(): RealliveSourceFsProbe {
  return {
    isDir: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    isFile: (path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    listChildDirs: (path) => {
      try {
        return readdirSync(path, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(path, entry.name));
      } catch {
        return [];
      }
    },
  };
}

/**
 * Resolve the game root (the directory that DIRECTLY contains `REALLIVEDATA/`)
 * under `sourceRoot`, mirroring the Rust `resolve_reallive_game_root`:
 *
 *   loop from `current = sourceRoot`, `visited = 0`:
 *     1. `current/REALLIVEDATA/` is a dir            -> return `current`
 *     2. `visited >= 4`                              -> stop (null)
 *     3. exactly ONE direct child has `REALLIVEDATA/` -> return that child
 *     4. exactly ONE direct child dir total          -> descend into it, visited++
 *     5. otherwise                                    -> stop (null)
 *
 * Returns `null` when no `REALLIVEDATA/` is found within the bound (the caller
 * falls back to the plain `<sourceRoot>/REALLIVEDATA/*` default).
 */
export function resolveRealliveGameRoot(
  sourceRoot: string,
  probe: RealliveSourceFsProbe = defaultRealliveSourceFsProbe(),
): string | null {
  let current = sourceRoot;
  let visited = 0;
  for (;;) {
    if (probe.isDir(join(current, REALLIVE_DATA_DIR_NAME))) {
      return current;
    }
    if (visited >= MAX_DESCENT_STEPS) {
      return null;
    }
    const childDirs = probe.listChildDirs(current);
    const childRoots = childDirs.filter((child) =>
      probe.isDir(join(child, REALLIVE_DATA_DIR_NAME)),
    );
    const soleChildRoot = childRoots.length === 1 ? childRoots[0] : undefined;
    if (soleChildRoot !== undefined) {
      return soleChildRoot;
    }
    // Only auto-descend through a single-child wrapper directory; 0 or >=2
    // children with no REALLIVEDATA match is ambiguous, so stop (mirrors the
    // Rust `children.len() != 1` break).
    const soleChildDir = childDirs.length === 1 ? childDirs[0] : undefined;
    if (soleChildDir === undefined) {
      return null;
    }
    current = soleChildDir;
    visited += 1;
  }
}

/**
 * Resolve the Gameexe.ini path under a resolved game root, mirroring the Rust
 * `game_root_gameexe_path` probe order (first existing file wins):
 *   1. `<root>/REALLIVEDATA/Gameexe.ini`
 *   2. `<root>/Gameexe.ini`
 *   3. for each direct child: `<child>/REALLIVEDATA/Gameexe.ini`, `<child>/Gameexe.ini`
 *   4. fallback: `<root>/REALLIVEDATA/Gameexe.ini` (fails loud downstream if absent)
 */
export function resolveRealliveGameexePath(
  resolvedRoot: string,
  probe: RealliveSourceFsProbe = defaultRealliveSourceFsProbe(),
): string {
  const primaryGameexe = join(resolvedRoot, REALLIVE_DATA_DIR_NAME, "Gameexe.ini");
  for (const candidate of [primaryGameexe, join(resolvedRoot, "Gameexe.ini")]) {
    if (probe.isFile(candidate)) {
      return candidate;
    }
  }
  for (const child of probe.listChildDirs(resolvedRoot)) {
    for (const sub of [
      join(child, REALLIVE_DATA_DIR_NAME, "Gameexe.ini"),
      join(child, "Gameexe.ini"),
    ]) {
      if (probe.isFile(sub)) {
        return sub;
      }
    }
  }
  return primaryGameexe;
}

/**
 * Resolve the `{gameexePath, seenPath}` the structure + validate stages read
 * from a `--source` game root, aligned with the extract stage's resolution.
 *
 * `Seen.txt` lives at `<resolvedRoot>/REALLIVEDATA/Seen.txt` (exact case, no
 * probing — identical to the Rust `seen_path`). When no `REALLIVEDATA/` is found
 * the resolved root falls back to `sourceRoot`, so the derived paths equal the
 * prior `<sourceRoot>/REALLIVEDATA/*` default (loud downstream failure, same as
 * extract on the same input).
 */
export function resolveRealliveSourcePaths(
  sourceRoot: string,
  probe: RealliveSourceFsProbe = defaultRealliveSourceFsProbe(),
): RealliveSourcePaths {
  const resolvedRoot = resolveRealliveGameRoot(sourceRoot, probe) ?? sourceRoot;
  return {
    gameexePath: resolveRealliveGameexePath(resolvedRoot, probe),
    seenPath: join(resolvedRoot, REALLIVE_DATA_DIR_NAME, "Seen.txt"),
  };
}
