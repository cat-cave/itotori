// reason: shared real-bytes test-support helpers; not every consumer test uses every helper.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use utsushi_fixture::corpus_registry::{Need, resolve};

pub fn game_root() -> Option<PathBuf> {
    let root = resolve(Need {
        engine: "reallive",
        ordinal: 1,
        variant: "encrypted",
    })
    .ok()?;
    resolve_reallive_game_root(&root)
}

pub fn seen_txt_path() -> Option<PathBuf> {
    file_in_reallivedata("Seen.txt")
}

pub fn skip_message(test_name: &str) -> String {
    format!("reallive/1/encrypted is unavailable or malformed; skipping {test_name}")
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
