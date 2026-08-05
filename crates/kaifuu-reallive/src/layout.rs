//! RealLive on-disk layout discovery.
//!
//! RealLive titles ship in two observed layouts:
//!
//! - **data-directory** — `REALLIVEDATA/Seen.txt` (and `Gameexe.ini`) under a
//!   data directory whose name is the fixed ASCII token `REALLIVEDATA`
//!   (any ASCII casing).
//! - **flat-root** — `Seen.txt` / `SEEN.TXT` and `Gameexe.ini` / `GAMEEXE.INI`
//!   directly in the title directory, with no `REALLIVEDATA/` wrapper.
//!
//! Case variation is expected: these are Windows-origin trees mounted on
//! case-sensitive volumes. Layout discovery is a format property — operators
//! pass a game root, not a layout flag.

use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use thiserror::Error;

/// Maximum single-child / unique-match descent from the input root when
/// looking for either known layout. Covers installer wrappers that nest the
/// title directory one or more levels under a versioned parent.
pub const REALLIVE_LAYOUT_MAX_DESCENT: usize = 4;

/// The two known RealLive on-disk layouts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RealLiveLayoutKind {
    /// SEEN archive under a `REALLIVEDATA/` data directory.
    DataDirectory,
    /// SEEN archive at the game root (no `REALLIVEDATA/` wrapper).
    FlatRoot,
}

impl RealLiveLayoutKind {
    /// Stable machine-readable label for reports and diagnostics.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DataDirectory => "data-directory",
            Self::FlatRoot => "flat-root",
        }
    }

    /// Relative SEEN path pattern this layout probes (case-insensitive match).
    pub const fn seen_pattern(self) -> &'static str {
        match self {
            Self::DataDirectory => "REALLIVEDATA/Seen.txt",
            Self::FlatRoot => "Seen.txt",
        }
    }
}

impl fmt::Display for RealLiveLayoutKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A game root resolved to one known RealLive layout, with concrete paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealLiveResolvedLayout {
    /// Which known layout matched.
    pub kind: RealLiveLayoutKind,
    /// Directory treated as the game root (parent of `REALLIVEDATA/`, or the
    /// flat asset directory itself).
    pub game_root: PathBuf,
    /// Directory that holds `Seen.txt` and typically `Gameexe.ini`.
    pub asset_dir: PathBuf,
    /// Located SEEN archive (`Seen.txt` / `SEEN.TXT`, case preserved).
    pub seen_txt: PathBuf,
    /// Best-effort `Gameexe.ini` path under the resolved asset directory
    /// (case preserved when found; otherwise the conventional name under
    /// `asset_dir`). Callers validate presence separately.
    pub gameexe_ini: PathBuf,
}

/// Layout discovery failures. Absence of every known layout is a typed
/// error that lists what was probed — never a single hardcoded path.
#[derive(Debug, Error)]
pub enum RealLiveLayoutError {
    /// No known layout matched under `root`.
    #[error(
        "kaifuu.reallive.layout_not_found: no known RealLive layout under {root}; \
         probed: {probed}; pass --game-root pointing at a RealLive game root"
    )]
    NotFound {
        /// Operator-supplied game root that failed to resolve.
        root: String,
        /// Human-readable list of layout probes (path pattern + layout kind)
        /// attempted under the root and via nested descent.
        probed: String,
    },
}

/// Resolve which known RealLive layout lives under `root`.
///
/// Probes both layouts at the input root, then descends through single-child
/// wrappers and unique layout-bearing children up to
/// [`REALLIVE_LAYOUT_MAX_DESCENT`]. Prefers the data-directory layout when
/// both would match at the same directory.
pub fn resolve_layout(root: &Path) -> Result<RealLiveResolvedLayout, RealLiveLayoutError> {
    let mut current = root.to_path_buf();
    for _ in 0..=REALLIVE_LAYOUT_MAX_DESCENT {
        if let Some(resolved) = try_resolve_at(&current) {
            return Ok(resolved);
        }

        let children = child_dirs(&current);
        let with_layout: Vec<PathBuf> = children
            .iter()
            .filter(|path| try_resolve_at(path).is_some())
            .cloned()
            .collect();
        if with_layout.len() == 1 {
            let only = with_layout
                .into_iter()
                .next()
                .expect("len == 1 guarantees one entry");
            return Ok(try_resolve_at(&only).expect("filtered by try_resolve_at"));
        }
        if children.len() != 1 {
            break;
        }
        current = children
            .into_iter()
            .next()
            .expect("len == 1 guarantees one entry");
    }

    Err(RealLiveLayoutError::NotFound {
        root: root.display().to_string(),
        probed: probed_layouts_description(root),
    })
}

fn try_resolve_at(dir: &Path) -> Option<RealLiveResolvedLayout> {
    // Prefer data-directory when both would match (a rare dual-shape tree).
    if let Some(resolved) = try_data_directory(dir) {
        return Some(resolved);
    }
    try_flat_root(dir)
}

fn try_data_directory(dir: &Path) -> Option<RealLiveResolvedLayout> {
    let data_dir = find_child_ci(dir, "REALLIVEDATA")?;
    if !data_dir.is_dir() {
        return None;
    }
    let seen_txt = find_child_ci(&data_dir, "Seen.txt")?;
    if !seen_txt.is_file() {
        return None;
    }
    let gameexe_ini = find_child_ci(&data_dir, "Gameexe.ini")
        .filter(|path| path.is_file())
        .unwrap_or_else(|| data_dir.join("Gameexe.ini"));
    Some(RealLiveResolvedLayout {
        kind: RealLiveLayoutKind::DataDirectory,
        game_root: dir.to_path_buf(),
        asset_dir: data_dir,
        seen_txt,
        gameexe_ini,
    })
}

fn try_flat_root(dir: &Path) -> Option<RealLiveResolvedLayout> {
    let seen_txt = find_child_ci(dir, "Seen.txt")?;
    if !seen_txt.is_file() {
        return None;
    }
    let gameexe_ini = find_child_ci(dir, "Gameexe.ini")
        .filter(|path| path.is_file())
        .unwrap_or_else(|| dir.join("Gameexe.ini"));
    Some(RealLiveResolvedLayout {
        kind: RealLiveLayoutKind::FlatRoot,
        game_root: dir.to_path_buf(),
        asset_dir: dir.to_path_buf(),
        seen_txt,
        gameexe_ini,
    })
}

fn probed_layouts_description(root: &Path) -> String {
    let root_display = root.display();
    format!(
        "{root_display}/{} ({}), {root_display}/{} ({}); \
         also searched nested directories up to depth {REALLIVE_LAYOUT_MAX_DESCENT} for either layout",
        RealLiveLayoutKind::DataDirectory.seen_pattern(),
        RealLiveLayoutKind::DataDirectory.as_str(),
        RealLiveLayoutKind::FlatRoot.seen_pattern(),
        RealLiveLayoutKind::FlatRoot.as_str(),
    )
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn unique_temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kaifuu-reallive-layout-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolves_data_directory_layout() {
        let root = unique_temp_dir("data-dir");
        let data = root.join("REALLIVEDATA");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("Seen.txt"), b"seen").unwrap();
        fs::write(data.join("Gameexe.ini"), b"#ini").unwrap();

        let resolved = resolve_layout(&root).expect("data-directory layout must resolve");
        assert_eq!(resolved.kind, RealLiveLayoutKind::DataDirectory);
        assert_eq!(resolved.game_root, root);
        assert_eq!(resolved.seen_txt, data.join("Seen.txt"));
        assert_eq!(resolved.gameexe_ini, data.join("Gameexe.ini"));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn resolves_flat_root_layout_uppercase() {
        let root = unique_temp_dir("flat-root");
        let title = root.join("title-dir");
        fs::create_dir_all(&title).unwrap();
        fs::write(title.join("SEEN.TXT"), b"seen").unwrap();
        fs::write(title.join("GAMEEXE.INI"), b"#ini").unwrap();

        let resolved = resolve_layout(&root).expect("flat-root under single child must resolve");
        assert_eq!(resolved.kind, RealLiveLayoutKind::FlatRoot);
        assert_eq!(resolved.game_root, title);
        assert_eq!(resolved.seen_txt, title.join("SEEN.TXT"));
        assert_eq!(resolved.gameexe_ini, title.join("GAMEEXE.INI"));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn not_found_lists_both_probed_layouts() {
        let root = unique_temp_dir("empty");
        fs::create_dir_all(root.join("unrelated")).unwrap();

        let err = resolve_layout(&root).expect_err("empty tree must fail");
        let message = err.to_string();
        assert!(
            message.starts_with("kaifuu.reallive.layout_not_found:"),
            "typed error code prefix missing: {message}"
        );
        assert!(
            message.contains("REALLIVEDATA/Seen.txt") && message.contains("data-directory"),
            "data-directory probe missing: {message}"
        );
        assert!(
            message.contains("Seen.txt") && message.contains("flat-root"),
            "flat-root probe missing: {message}"
        );
        assert!(
            message.contains(&root.display().to_string()),
            "root path missing: {message}"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn prefers_data_directory_when_both_present() {
        let root = unique_temp_dir("both");
        let data = root.join("REALLIVEDATA");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("Seen.txt"), b"nested").unwrap();
        fs::write(root.join("Seen.txt"), b"flat").unwrap();

        let resolved = resolve_layout(&root).expect("dual-shape tree must resolve");
        assert_eq!(resolved.kind, RealLiveLayoutKind::DataDirectory);
        assert_eq!(resolved.seen_txt, data.join("Seen.txt"));

        fs::remove_dir_all(&root).unwrap();
    }
}
