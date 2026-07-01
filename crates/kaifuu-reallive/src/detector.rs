//! KAIFUU-189 RealLive directory detector.
//!
//! Locates the `REALLIVEDATA/` engine asset root inside an arbitrary
//! game directory tree, walking subdirectories case-insensitively up to a
//! bounded depth (default `REALLIVE_DETECTOR_DEFAULT_MAX_DEPTH = 3`). The
//! depth bound exists so the walker terminates on pathological install
//! trees; the default is large enough to cover the observed Sweetie HD
//! shape `<root>/<Japanese title subdir>/REALLIVEDATA/` (depth 2) and the
//! plain `<root>/REALLIVEDATA/` shape (depth 1) without descending into
//! every save / cache directory a player might leave around.
//!
//! Subdirectory names with non-ASCII / Japanese characters are traversed
//! normally — the walker reads `DirEntry::file_name` as raw `OsStr` and
//! does not apply any encoding-based filter. The case-insensitive match
//! on the marker name is ASCII-only (`REALLIVEDATA` is a fixed ASCII
//! token in every RealLive title since AVG32; see
//! `docs/research/reallive-engine.md` §C and the Sweetie HD verification
//! in `docs/audits/real-bytes-validation-2026-06-24.md` §2.1).
//!
//! # Three-state outcome (no silent zero-state)
//!
//! - `Ok(Some(evidence))` — a directory whose ASCII-lowercase name is
//!   `reallivedata` was found at depth ≤ `max_depth`. The reported path
//!   is the on-disk path (case preserved from the filesystem).
//! - `Ok(None)` — `root` is a readable directory but no REALLIVEDATA was
//!   found within `max_depth`. This is a *real* negative, not a
//!   read-failure swallow.
//! - `Err(RealLiveDetectError::RootMissing)` — `root` does not exist.
//! - `Err(RealLiveDetectError::RootNotDir)` — `root` exists but is not a
//!   directory.
//! - `Err(RealLiveDetectError::Io)` — an underlying `std::io` error
//!   surfaced while reading the directory tree.
//!
//! This three-state shape is the KAIFUU-189 "no silent zero-state"
//! contract: callers can distinguish a clean negative from a read error
//! without inspecting filesystem state out-of-band.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use thiserror::Error;

/// On-disk marker directory name. Case is preserved when matching against
/// `DirEntry::file_name` via ASCII-lowercase comparison. The audit
/// confirms Sweetie HD's marker is the upper-case form `REALLIVEDATA`;
/// the lookup accepts any ASCII-casing because some title repacks ship
/// `reallivedata` lowercase.
pub const REALLIVE_DATA_DIR_NAME: &str = "REALLIVEDATA";

/// Default bound for the directory descent. Covers the depth-2 Sweetie HD
/// shape (`<root>/<JP title subdir>/REALLIVEDATA/`) plus a one-level
/// cushion for installer wrappers that nest the title subdir under
/// `Setup/` or similar. See KAIFUU-189 §audit-focus for the bound
/// rationale.
pub const REALLIVE_DETECTOR_DEFAULT_MAX_DEPTH: usize = 3;

/// Successful positive: REALLIVEDATA was found at the on-disk path
/// `reallive_data_path` after a walk that descended `search_depth`
/// levels from the input root (`0` means the input root itself is named
/// `REALLIVEDATA`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealLiveDetectionEvidence {
    /// Resolved on-disk path of the REALLIVEDATA directory (case
    /// preserved from the filesystem entry).
    pub reallive_data_path: PathBuf,
    /// Number of directory levels descended from the input root. `0`
    /// when the input root itself is named `REALLIVEDATA`; `1` when the
    /// marker sits as a direct child of root; etc.
    pub search_depth: usize,
}

/// Errors the detector emits. The variants are mutually exclusive with
/// `Ok(None)` so callers can tell apart "no RealLive content here" from
/// "couldn't even look".
#[derive(Debug, Error)]
pub enum RealLiveDetectError {
    /// The root path does not exist on the filesystem.
    #[error("root path does not exist: {0}")]
    RootMissing(PathBuf),
    /// The root path exists but is not a directory.
    #[error("root path is not a directory: {0}")]
    RootNotDir(PathBuf),
    /// An I/O error surfaced while reading a directory.
    #[error("io error while scanning {path}: {source}")]
    Io {
        /// Path whose `read_dir` or `metadata` call failed.
        path: PathBuf,
        /// Underlying I/O error.
        #[source]
        source: io::Error,
    },
}

/// Detect a RealLive `REALLIVEDATA/` directory under `root` using the
/// default depth bound. See [`detect_with_max_depth`] for the bounded form.
pub fn detect(root: &Path) -> Result<Option<RealLiveDetectionEvidence>, RealLiveDetectError> {
    detect_with_max_depth(root, REALLIVE_DETECTOR_DEFAULT_MAX_DEPTH)
}

/// Detect a RealLive `REALLIVEDATA/` directory under `root` with an
/// explicit `max_depth`. A `max_depth` of `0` checks only whether
/// `root` itself is named `REALLIVEDATA`; `max_depth = 1` also checks
/// its direct children; and so on.
pub fn detect_with_max_depth(
    root: &Path,
    max_depth: usize,
) -> Result<Option<RealLiveDetectionEvidence>, RealLiveDetectError> {
    let metadata = match fs::metadata(root) {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Err(RealLiveDetectError::RootMissing(root.to_path_buf()));
        }
        Err(err) => {
            return Err(RealLiveDetectError::Io {
                path: root.to_path_buf(),
                source: err,
            });
        }
    };
    if !metadata.is_dir() {
        return Err(RealLiveDetectError::RootNotDir(root.to_path_buf()));
    }

    // `max_depth = 0` means "consider only the root itself". A root
    // named REALLIVEDATA (e.g. the user pointed `kaifuu detect` directly
    // at `<game>/REALLIVEDATA`) is the trivial positive.
    if dir_name_matches_reallivedata(root) {
        return Ok(Some(RealLiveDetectionEvidence {
            reallive_data_path: root.to_path_buf(),
            search_depth: 0,
        }));
    }

    if max_depth == 0 {
        return Ok(None);
    }

    walk_for_reallivedata(root, max_depth, 1)
}

fn walk_for_reallivedata(
    dir: &Path,
    max_depth: usize,
    current_depth: usize,
) -> Result<Option<RealLiveDetectionEvidence>, RealLiveDetectError> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            return Err(RealLiveDetectError::Io {
                path: dir.to_path_buf(),
                source: err,
            });
        }
    };

    // Two-pass: prefer a direct-child match at this level before
    // recursing into siblings. This ensures the shallowest REALLIVEDATA
    // wins (KAIFUU-189 audit-focus: "Behaviour when both root and nested
    // data dir contain SEEN.TXT (prefer nested)" — i.e. the shallowest
    // match that genuinely contains the engine's marker).
    let mut subdirs: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                return Err(RealLiveDetectError::Io {
                    path: dir.to_path_buf(),
                    source: err,
                });
            }
        };
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(err) => {
                return Err(RealLiveDetectError::Io {
                    path: entry.path(),
                    source: err,
                });
            }
        };
        if !file_type.is_dir() {
            continue;
        }
        let path = entry.path();
        if dir_name_matches_reallivedata(&path) {
            return Ok(Some(RealLiveDetectionEvidence {
                reallive_data_path: path,
                search_depth: current_depth,
            }));
        }
        subdirs.push(path);
    }

    if current_depth >= max_depth {
        return Ok(None);
    }

    for subdir in subdirs {
        if let Some(evidence) = walk_for_reallivedata(&subdir, max_depth, current_depth + 1)? {
            return Ok(Some(evidence));
        }
    }

    Ok(None)
}

fn dir_name_matches_reallivedata(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    name.eq_ignore_ascii_case(REALLIVE_DATA_DIR_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn unique_temp_dir(label: &str) -> PathBuf {
        // No `tempfile` dep in this crate; we hand-roll a unique dir.
        let dir = std::env::temp_dir().join(format!(
            "kaifuu-reallive-detector-{label}-{}-{}",
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
    fn detects_reallivedata_as_direct_child() {
        let root = unique_temp_dir("direct-child");
        fs::create_dir_all(root.join("REALLIVEDATA")).unwrap();

        let evidence = detect(&root)
            .expect("readable root must not error")
            .expect("direct REALLIVEDATA child must be detected");
        assert_eq!(evidence.reallive_data_path, root.join("REALLIVEDATA"));
        assert_eq!(evidence.search_depth, 1);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn detects_reallivedata_under_nonascii_parent() {
        // Mirrors the Sweetie HD shape:
        //   <root>/オシオキSweetie＋Sweets!! HD_DL版/REALLIVEDATA/
        let root = unique_temp_dir("nonascii-parent");
        let title = "オシオキSweetie＋Sweets!! HD_DL版";
        let nested = root.join(title).join("REALLIVEDATA");
        fs::create_dir_all(&nested).unwrap();

        let evidence = detect(&root)
            .expect("readable root must not error")
            .expect("nested REALLIVEDATA under non-ASCII parent must be detected");
        assert_eq!(evidence.reallive_data_path, nested);
        assert_eq!(evidence.search_depth, 2);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn detects_lowercase_reallivedata() {
        let root = unique_temp_dir("lowercase");
        fs::create_dir_all(root.join("reallivedata")).unwrap();

        let evidence = detect(&root)
            .expect("readable root must not error")
            .expect("case-insensitive ASCII match must find lowercase reallivedata");
        assert_eq!(evidence.reallive_data_path, root.join("reallivedata"));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn root_named_reallivedata_is_detected_at_depth_zero() {
        let parent = unique_temp_dir("root-marker-parent");
        let root = parent.join("REALLIVEDATA");
        fs::create_dir_all(&root).unwrap();

        let evidence = detect(&root)
            .expect("readable root must not error")
            .expect("input root named REALLIVEDATA must be the trivial positive");
        assert_eq!(evidence.reallive_data_path, root);
        assert_eq!(evidence.search_depth, 0);

        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn returns_none_for_unrelated_directory() {
        let root = unique_temp_dir("unrelated");
        fs::create_dir_all(root.join("data")).unwrap();
        fs::write(root.join("data/System.json"), b"{}").unwrap();

        let outcome = detect(&root).expect("readable root must not error");
        assert!(
            outcome.is_none(),
            "unrelated tree must produce Ok(None), not a swallowed error or false-positive"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn root_missing_is_an_error_not_a_silent_negative() {
        let parent = unique_temp_dir("root-missing-parent");
        let root = parent.join("nonexistent");
        // Do NOT create root.

        let err = detect(&root).expect_err("missing root must produce a typed error");
        assert!(matches!(err, RealLiveDetectError::RootMissing(_)));

        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn root_pointing_at_file_is_an_error_not_a_silent_negative() {
        let parent = unique_temp_dir("root-not-dir-parent");
        let file = parent.join("not-a-dir.txt");
        fs::write(&file, b"hello").unwrap();

        let err = detect(&file).expect_err("non-directory root must produce a typed error");
        assert!(matches!(err, RealLiveDetectError::RootNotDir(_)));

        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn unrelated_name_is_not_a_false_positive() {
        // KAIFUU-189 audit focus: "Case-insensitive directory match must
        // not match unrelated names (`reallive`, `data`)."
        let root = unique_temp_dir("partial-name");
        fs::create_dir_all(root.join("reallive")).unwrap();
        fs::create_dir_all(root.join("data")).unwrap();
        fs::create_dir_all(root.join("REALLIVE_DATA")).unwrap();

        let outcome = detect(&root).expect("readable root must not error");
        assert!(
            outcome.is_none(),
            "partial-name siblings (reallive, data, REALLIVE_DATA) must not match REALLIVEDATA"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn max_depth_zero_only_checks_root_itself() {
        let root = unique_temp_dir("max-depth-zero");
        fs::create_dir_all(root.join("REALLIVEDATA")).unwrap();

        let outcome =
            detect_with_max_depth(&root, 0).expect("readable root must not error at max_depth 0");
        assert!(
            outcome.is_none(),
            "max_depth = 0 must not descend into root's children"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn max_depth_bounds_recursion() {
        // REALLIVEDATA sits at depth 4 under root (a/b/c/REALLIVEDATA).
        // With max_depth = 2, the walker must NOT find it.
        let root = unique_temp_dir("max-depth-bound");
        fs::create_dir_all(root.join("a/b/c/REALLIVEDATA")).unwrap();

        let outcome_shallow = detect_with_max_depth(&root, 2).expect("readable root");
        assert!(
            outcome_shallow.is_none(),
            "REALLIVEDATA at depth 4 must NOT be found with max_depth = 2"
        );

        let outcome_deep = detect_with_max_depth(&root, 4).expect("readable root");
        let evidence = outcome_deep.expect("max_depth = 4 must reach the depth-4 REALLIVEDATA");
        assert_eq!(evidence.search_depth, 4);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn prefers_shallowest_when_multiple_candidates_exist() {
        // Two REALLIVEDATA dirs at different depths. The shallower one
        // (depth 1) must win.
        let root = unique_temp_dir("multi-candidate");
        fs::create_dir_all(root.join("REALLIVEDATA")).unwrap();
        fs::create_dir_all(root.join("nested/parent/REALLIVEDATA")).unwrap();

        let evidence = detect(&root)
            .expect("readable root must not error")
            .expect("shallowest REALLIVEDATA must win");
        assert_eq!(evidence.search_depth, 1);
        assert_eq!(evidence.reallive_data_path, root.join("REALLIVEDATA"));

        fs::remove_dir_all(&root).unwrap();
    }
}
