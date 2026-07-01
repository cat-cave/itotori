#![allow(dead_code)]

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub const REAL_GAME_ROOT_ENV: &str = "ITOTORI_REAL_GAME_ROOT";
pub const REAL_GAME_ROOT_2_ENV: &str = "ITOTORI_REAL_GAME_ROOT_2";

pub fn game_root() -> Option<PathBuf> {
    let root = PathBuf::from(env::var_os(REAL_GAME_ROOT_ENV)?);
    resolve_reallive_game_root(&root)
}

/// Locate the g00 asset directory reachable from the game root named by
/// `env_var`. Handles BOTH the standard `REALLIVEDATA/g00` layout
/// (Sweetie HD) and title variants that ship a top-level (case-varying)
/// `G00` directory (Kanon). Returns `None` when the env var is unset or
/// no g00 directory can be found. Directory search is bounded to a depth
/// of 4 from the raw env path.
pub fn g00_dir_for_env(env_var: &str) -> Option<PathBuf> {
    let root = PathBuf::from(env::var_os(env_var)?);
    find_g00_dir(&root, 4)
}

/// Breadth-first search from `root` (bounded to `max_depth`) for a
/// directory whose ASCII-case-folded name is `g00` that contains at
/// least one `*.g00` file.
fn find_g00_dir(root: &Path, max_depth: usize) -> Option<PathBuf> {
    let mut frontier = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = frontier.pop() {
        if dir_is_g00_with_assets(&dir) {
            return Some(dir);
        }
        if depth >= max_depth {
            continue;
        }
        for child in child_dirs(&dir) {
            frontier.push((child, depth + 1));
        }
    }
    None
}

fn dir_is_g00_with_assets(dir: &Path) -> bool {
    let is_named_g00 = dir
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case("g00"))
        .unwrap_or(false);
    if !is_named_g00 {
        return false;
    }
    fs::read_dir(dir)
        .map(|entries| {
            entries.flatten().any(|entry| {
                entry
                    .path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("g00"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
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
