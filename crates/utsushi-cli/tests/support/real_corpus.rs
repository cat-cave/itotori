// reason: shared real-bytes test-support helpers; not every consumer test uses every helper.
#![allow(dead_code)]

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub const REAL_GAME_ROOT_ENV: &str = "ITOTORI_REAL_GAME_ROOT";

/// Loud opt-OUT flag. Real-bytes coverage is STRICT BY DEFAULT; only this
/// downgrades an absent corpus to a skip (knowingly forgoing coverage).
pub const ALLOW_MISSING_CORPUS_ENV: &str = "ITOTORI_ALLOW_MISSING_CORPUS";

/// `true` when the operator explicitly opted OUT of real-bytes enforcement
/// via `ITOTORI_ALLOW_MISSING_CORPUS=1`.
pub fn allow_missing_corpus() -> bool {
    env::var_os(ALLOW_MISSING_CORPUS_ENV).is_some_and(|value| value == "1")
}

/// Resolve the corpus-unavailable branch of an env-gated real-bytes test.
///
/// The single chokepoint for the "no silent pass" contract: a real-bytes
/// test must never report a green PASS when it asserted nothing.
///
/// - By DEFAULT an absent corpus is a HARD FAILURE: this panics, naming the
///   missing [`REAL_GAME_ROOT_ENV`].
/// - Only the explicit opt-OUT `ITOTORI_ALLOW_MISSING_CORPUS=1` downgrades it
///   to a LOUD skip notice that returns; the caller then returns from the
///   (already `#[ignore]`-d) test so the run reports it as ignored/skipped.
pub fn skip_or_require_real_bytes(test_name: &str) {
    let detail = format!(
        "{REAL_GAME_ROOT_ENV} unset or no REALLIVEDATA directory found; {test_name} did not \
         exercise real bytes (re-run with {REAL_GAME_ROOT_ENV}=/path/to/reallive-game-root)"
    );
    assert!(
        allow_missing_corpus(),
        "real-bytes coverage is STRICT BY DEFAULT: {detail}. Set \
         {ALLOW_MISSING_CORPUS_ENV}=1 to explicitly opt out (knowingly forgoing real bytes)."
    );
    eprintln!(
        "WARNING: {ALLOW_MISSING_CORPUS_ENV}=1 set — SKIPPING real-bytes coverage (opted out): \
         {detail}"
    );
}

pub fn game_root() -> Option<PathBuf> {
    let root = PathBuf::from(env::var_os(REAL_GAME_ROOT_ENV)?);
    resolve_reallive_game_root(&root)
}

pub fn reallivedata_dir() -> Option<PathBuf> {
    Some(game_root()?.join("REALLIVEDATA"))
}

pub fn seen_txt_path() -> Option<PathBuf> {
    file_in_reallivedata("Seen.txt")
}

pub fn gameexe_ini_path() -> Option<PathBuf> {
    file_in_reallivedata("Gameexe.ini").or_else(|| game_root().map(|root| root.join("Gameexe.ini")))
}

pub fn reallivedata_subdir(name: &str) -> Option<PathBuf> {
    let path = reallivedata_dir()?.join(name);
    path.is_dir().then_some(path)
}

pub fn save_file_path(file_name: &str) -> Option<PathBuf> {
    let path = game_root()?.join("SAVEDATA").join(file_name);
    path.is_file().then_some(path)
}

pub fn skip_message(test_name: &str) -> String {
    format!("{REAL_GAME_ROOT_ENV} unset or no REALLIVEDATA directory found; skipping {test_name}")
}

fn file_in_reallivedata(name: &str) -> Option<PathBuf> {
    let path = reallivedata_dir()?.join(name);
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
