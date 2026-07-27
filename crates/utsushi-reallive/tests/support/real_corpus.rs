// reason: shared real-bytes test-support helpers; not every consumer test uses every helper.
#![allow(dead_code)]
use corpus_registry::{Need, resolve};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
pub const PRIMARY: Need<'static> = Need {
    engine: "reallive",
    ordinal: 1,
    variant: "encrypted",
};
pub const SECONDARY: Need<'static> = Need {
    engine: "reallive",
    ordinal: 2,
    variant: "plain",
};

// Legacy callers outside the migrated RealLive slice still name their local
// corpus roots directly. Keep this compatibility surface until that follow-up.
pub const REAL_GAME_ROOT_ENV: &str = "ITOTORI_REAL_GAME_ROOT";
pub const REAL_GAME_ROOT_2_ENV: &str = "ITOTORI_REAL_GAME_ROOT_2";

/// Prints a registry-identified, actionable real-bytes skip. Returns `()` (not
/// `!`) so call sites retain `return` without an `unreachable_code` lint.
pub fn require_real_bytes(test_name: &str) {
    eprintln!(
        "REAL-BYTES SKIP {test_name}: reallive/1/encrypted is unavailable; set ITOTORI_CORPUS_ROOT=/path/to/corpora and configure reallive/1/encrypted in corpora/manifest.v1.json to exercise real bytes."
    );
}

/// A resolved real-bytes RealLive corpus: the game root plus the located
/// SEEN archive. Supports both observed on-disk layouts — modern
/// `<root>/REALLIVEDATA/Seen.txt` (Sweetie HD) and flat `<root>/SEEN.TXT`
/// (older 1.2.6.x titles such as Kanon, which keep the archive directly in
/// the game root with no `REALLIVEDATA/` subdirectory).
pub struct RealCorpus {
    /// Human-readable label for diagnostics (e.g. `"corpus-1"`).
    pub label: &'static str,
    /// The located SEEN archive (`Seen.txt` / `SEEN.TXT`).
    pub seen_txt: PathBuf,
}

pub fn corpus_1() -> Option<RealCorpus> {
    corpus_for_need("corpus-1", PRIMARY)
}

pub fn corpus_2() -> Option<RealCorpus> {
    corpus_for_need("corpus-2", SECONDARY)
}

/// Every staged real RealLive corpus, in declaration order. Empty when no
/// corpus root is set.
pub fn corpora() -> Vec<RealCorpus> {
    [corpus_1(), corpus_2()].into_iter().flatten().collect()
}

impl RealCorpus {
    /// The game's configured ENTRY scene, read from `#SEEN_START` in the
    /// `Gameexe.ini` that sits beside the SEEN archive (Sweetie HD: scene
    /// 1; Kanon: scene 9030). This is the scene the engine begins the
    /// game at — the target of the entry-scene-to-terminus acceptance.
    /// Returns `None` if the Gameexe cannot be located / parsed or does
    /// not declare `#SEEN_START`.
    pub fn entry_scene(&self) -> Option<u16> {
        u16::try_from(self.gameexe()?.get_int("SEEN_START")?).ok()
    }

    /// Parse the `Gameexe.ini` that sits beside the SEEN archive. Used to
    /// drive the config-driven message-window box (`#WINDOW.000`) and the
    /// declared screen size.
    pub fn gameexe(&self) -> Option<utsushi_reallive::Gameexe> {
        let dir = self.seen_txt.parent()?;
        let gameexe = find_child_ci(dir, "Gameexe.ini")?;
        let bytes = fs::read(gameexe).ok()?;
        utsushi_reallive::Gameexe::parse(&bytes).ok()
    }
}

fn corpus_for_need(label: &'static str, need: Need<'_>) -> Option<RealCorpus> {
    let root = resolve(need).ok()?;
    let resolved = resolve_corpus_root(&root)?;
    let seen_txt = find_seen_archive(&resolved)?;
    Some(RealCorpus { label, seen_txt })
}

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
    resolve(PRIMARY)
        .ok()
        .and_then(|root| resolve_reallive_game_root(&root))
}

/// Locate a g00 directory from a registry request. Directory search is bounded
/// to depth 4 and supports both common layouts.
pub fn g00_dir_for(need: Need<'_>) -> Option<PathBuf> {
    let root = resolve(need).ok()?;
    find_g00_dir(&root, 4)
}

/// Legacy accessor retained for the unmigrated RealLive tests.
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
        .is_some_and(|name| name.eq_ignore_ascii_case("g00"));
    if !is_named_g00 {
        return false;
    }
    fs::read_dir(dir).is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            entry
                .path()
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("g00"))
        })
    })
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
    format!("reallive/1/encrypted is unavailable or malformed; skipping {test_name}")
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
