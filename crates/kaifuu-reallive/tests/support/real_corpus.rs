#![allow(dead_code)]

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub const REAL_GAME_ROOT_ENV: &str = "ITOTORI_REAL_GAME_ROOT";

/// Opt-in flag (`ITOTORI_REQUIRE_REAL_BYTES=1`) that turns an absent corpus
/// from a skip into a hard failure, for contexts where real-bytes coverage is
/// expected to actually run (e.g. CI that stages Sweetie HD).
pub const REQUIRE_REAL_BYTES_ENV: &str = "ITOTORI_REQUIRE_REAL_BYTES";

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
