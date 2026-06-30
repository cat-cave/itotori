#![allow(dead_code)]

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub const REAL_GAME_ROOT_ENV: &str = "ITOTORI_REAL_GAME_ROOT";

/// Second RealLive corpus root, used for multi-game validation (project
/// law: engine-family behaviour must validate against >=2 real RealLive
/// games). Points at a *different* RealLive title than [`REAL_GAME_ROOT_ENV`]
/// (e.g. Kanon, a 1.2.6.8 title) so the Sweetie-HD opcode/Choice layout can
/// be exercised against a second, independently-authored bytecode corpus.
pub const REAL_GAME_ROOT_2_ENV: &str = "ITOTORI_REAL_GAME_ROOT_2";

/// Opt-in flag (`ITOTORI_REQUIRE_REAL_BYTES=1`) that turns an absent corpus
/// from a skip into a hard failure, for contexts where real-bytes coverage is
/// expected to actually run (e.g. CI that stages Sweetie HD).
pub const REQUIRE_REAL_BYTES_ENV: &str = "ITOTORI_REQUIRE_REAL_BYTES";

/// A resolved real-bytes RealLive corpus: the game root plus the located
/// SEEN archive.
///
/// Supports both observed on-disk layouts:
/// - **modern** `<root>/REALLIVEDATA/Seen.txt` (Sweetie HD, the newer
///   compiler line);
/// - **flat** `<root>/SEEN.TXT` (older 1.2.6.x titles such as Kanon, which
///   keep the archive directly in the game root with no `REALLIVEDATA/`
///   subdirectory).
///
/// This is the single accessor the multi-game-validation harness uses so a
/// test can iterate over every staged corpus without caring which layout a
/// given title ships.
pub struct RealCorpus {
    /// Human-readable label for diagnostics (e.g. `"corpus-1"`).
    pub label: &'static str,
    /// The resolved game root (the directory holding the SEEN archive or a
    /// `REALLIVEDATA/` subdirectory).
    pub root: PathBuf,
    /// The located SEEN archive (`Seen.txt` / `SEEN.TXT`).
    pub seen_txt: PathBuf,
}

/// Resolve the first corpus (`ITOTORI_REAL_GAME_ROOT`, Sweetie HD).
pub fn corpus_1() -> Option<RealCorpus> {
    corpus_for_env("corpus-1", REAL_GAME_ROOT_ENV)
}

/// Resolve the second corpus (`ITOTORI_REAL_GAME_ROOT_2`, e.g. Kanon).
pub fn corpus_2() -> Option<RealCorpus> {
    corpus_for_env("corpus-2", REAL_GAME_ROOT_2_ENV)
}

/// Every staged real RealLive corpus, in declaration order. Empty when no
/// corpus root is set.
pub fn corpora() -> Vec<RealCorpus> {
    [corpus_1(), corpus_2()].into_iter().flatten().collect()
}

fn corpus_for_env(label: &'static str, env_name: &str) -> Option<RealCorpus> {
    let root = PathBuf::from(env::var_os(env_name)?);
    let resolved = resolve_corpus_root(&root)?;
    let seen_txt = find_seen_archive(&resolved)?;
    Some(RealCorpus {
        label,
        root: resolved,
        seen_txt,
    })
}

/// Descend up to depth 4 looking for a directory that contains a SEEN
/// archive under either supported layout.
fn resolve_corpus_root(root: &Path) -> Option<PathBuf> {
    let mut current = root.to_path_buf();
    for _ in 0..=4 {
        if find_seen_archive(&current).is_some() {
            return Some(current);
        }
        let children = child_dirs(&current);
        let with_seen: Vec<PathBuf> = children
            .iter()
            .filter(|path| find_seen_archive(path).is_some())
            .cloned()
            .collect();
        if with_seen.len() == 1 {
            return with_seen.into_iter().next();
        }
        if children.len() != 1 {
            return None;
        }
        current = children.into_iter().next()?;
    }
    None
}

/// Locate the SEEN archive under either the modern `REALLIVEDATA/Seen.txt`
/// layout or the flat root-level `SEEN.TXT` layout (case-insensitive).
fn find_seen_archive(dir: &Path) -> Option<PathBuf> {
    if let Some(reallivedata) = find_child_ci(dir, "REALLIVEDATA")
        && let Some(seen) = find_child_ci(&reallivedata, "Seen.txt")
        && seen.is_file()
    {
        return Some(seen);
    }
    let flat = find_child_ci(dir, "Seen.txt")?;
    flat.is_file().then_some(flat)
}

/// Find a direct child entry whose file name equals `name` case-insensitively.
fn find_child_ci(dir: &Path, name: &str) -> Option<PathBuf> {
    fs::read_dir(dir).ok()?.flatten().find_map(|entry| {
        let path = entry.path();
        let matches = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case(name));
        matches.then_some(path)
    })
}

pub fn game_root() -> Option<PathBuf> {
    let root = PathBuf::from(env::var_os(REAL_GAME_ROOT_ENV)?);
    resolve_reallive_game_root(&root)
}

pub fn seen_txt_path() -> Option<PathBuf> {
    file_in_reallivedata("Seen.txt")
}

pub fn gameexe_ini_path() -> Option<PathBuf> {
    file_in_reallivedata("Gameexe.ini").or_else(|| game_root().map(|root| root.join("Gameexe.ini")))
}

pub fn skip_message(test_name: &str) -> String {
    format!("{REAL_GAME_ROOT_ENV} unset or no REALLIVEDATA directory found; skipping {test_name}")
}

/// `true` when the operator demanded real-bytes coverage actually run, via
/// `ITOTORI_REQUIRE_REAL_BYTES=1`.
pub fn require_real_bytes() -> bool {
    env::var_os(REQUIRE_REAL_BYTES_ENV).is_some_and(|value| value == "1")
}

/// Resolve the corpus-unavailable branch of an env-gated real-bytes test.
///
/// This is the single chokepoint for the "no silent pass" contract: a
/// real-bytes test must never report a green PASS when it asserted nothing.
///
/// - With `ITOTORI_REQUIRE_REAL_BYTES=1` set, an absent corpus is a hard
///   failure: this panics, naming the missing [`REAL_GAME_ROOT_ENV`], so the
///   absence of real bytes can never masquerade as success.
/// - Otherwise it emits an explicit, non-silent skip notice and returns; the
///   caller then returns from the (already `#[ignore]`-d) test so the run
///   reports it as ignored/skipped rather than passed.
pub fn skip_or_require_real_bytes(test_name: &str) {
    let detail = format!(
        "{REAL_GAME_ROOT_ENV} unset; {test_name} did not exercise real bytes \
         (re-run with {REAL_GAME_ROOT_ENV}=/path/to/reallive-game-root)"
    );
    assert!(
        !require_real_bytes(),
        "{REQUIRE_REAL_BYTES_ENV}=1 demands real-bytes coverage, but {detail}"
    );
    eprintln!("SKIP (no silent pass): {detail}");
}

fn file_in_reallivedata(name: &str) -> Option<PathBuf> {
    let path = game_root()?.join("REALLIVEDATA").join(name);
    path.is_file().then_some(path)
}

fn resolve_reallive_game_root(root: &Path) -> Option<PathBuf> {
    let mut current = root.to_path_buf();
    for _ in 0..=4 {
        if current.join("REALLIVEDATA").is_dir() {
            return Some(current);
        }

        let direct_children = child_dirs_with_reallivedata(&current);
        if direct_children.len() == 1 {
            return direct_children.into_iter().next();
        }

        let children = child_dirs(&current);
        if children.len() != 1 {
            return None;
        }
        current = children.into_iter().next()?;
    }
    None
}

fn child_dirs_with_reallivedata(root: &Path) -> Vec<PathBuf> {
    child_dirs(root)
        .into_iter()
        .filter(|path| path.join("REALLIVEDATA").is_dir())
        .collect()
}

fn child_dirs(root: &Path) -> Vec<PathBuf> {
    fs::read_dir(root)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect()
        })
        .unwrap_or_default()
}
