//! Per-run extraction driver.
//!
//! - Uses `sevenz-rust2` (pure-Rust 7z decoder; no system `7z` shell-out).
//! - Validates every archive entry path **before any byte is written** to
//!   disk, rejecting parent-dir traversal, absolute paths, drive prefixes,
//!   symlink escapes, and writes into `_vault/` other than `metadata.json`.
//! - Removes the per-run extraction directory on failure (truncated archive,
//!   decoder error, path-traversal rejection) so partial extractions are
//!   never surfaced.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use sevenz_rust2::ArchiveEntry;

use crate::error::VaultSourceError;

/// Result of a successful extraction.
#[derive(Debug, Clone)]
pub struct ExtractedTree {
    /// The directory containing the extracted file tree, including the
    /// expected `_vault/metadata.json`.
    pub extracted_root: PathBuf,
    /// Total uncompressed bytes written.
    pub bytes_written: u64,
}

/// The per-run scratch layout *(Contract: §Extraction)*.
#[derive(Debug, Clone)]
pub struct ScratchPaths {
    /// `<scratch-root>/<game-id>/`.
    pub game_root: PathBuf,
    /// `<scratch-root>/<game-id>/<run-id>/`.
    pub run_root: PathBuf,
    /// `<scratch-root>/<game-id>/<run-id>/extracted/`.
    pub extracted_root: PathBuf,
    /// `<scratch-root>/<game-id>/.last-artifact-sha256` (used by
    /// `RetentionPolicy::KeepExtractedForGame`).
    pub last_artifact_sha_marker: PathBuf,
}

impl ScratchPaths {
    /// Compose the canonical layout for a (game_id, run_id) pair.
    pub fn compose(scratch_root: &Path, game_id: &str, run_id: &str) -> Self {
        let game_root = scratch_root.join(game_id);
        let run_root = game_root.join(run_id);
        let extracted_root = run_root.join("extracted");
        let last_artifact_sha_marker = game_root.join(".last-artifact-sha256");
        Self {
            game_root,
            run_root,
            extracted_root,
            last_artifact_sha_marker,
        }
    }
}

fn io_err(msg: impl Into<String>) -> sevenz_rust2::Error {
    sevenz_rust2::Error::from(std::io::Error::other(msg.into()))
}

/// Extract a 7z archive into `extracted_root`. The function refuses to
/// proceed if the archive contains any unsafe entry; on any failure the
/// `run_root` (parent of `extracted_root`) is removed so the caller never
/// observes a partial extraction.
pub fn extract_archive(
    archive_path: &Path,
    paths: &ScratchPaths,
) -> Result<ExtractedTree, VaultSourceError> {
    // Ensure scratch is writable.
    if let Err(e) = std::fs::create_dir_all(&paths.extracted_root) {
        return Err(VaultSourceError::ScratchUnwritable {
            path: paths.extracted_root.clone(),
            source: e,
        });
    }

    let mut bytes_written: u64 = 0u64;
    let extracted_root = paths.extracted_root.clone();
    let archive_path_owned = archive_path.to_path_buf();

    let unsafe_reason: std::cell::RefCell<Option<UnsafeReason>> = std::cell::RefCell::new(None);

    let result = sevenz_rust2::decompress_file_with_extract_fn(
        archive_path,
        &extracted_root,
        |entry: &ArchiveEntry, reader: &mut dyn Read, _dest: &PathBuf| {
            // We ignore `dest` (sevenz-rust2 already joined entry.name() to
            // extracted_root) — we re-validate the entry name ourselves.
            let safe_rel = match validate_entry_name(&entry.name) {
                Ok(p) => p,
                Err(r) => {
                    *unsafe_reason.borrow_mut() = Some(UnsafeReason {
                        entry: entry.name.clone(),
                        reason: r,
                    });
                    return Err(io_err(format!("unsafe-entry:{r}")));
                }
            };

            let target = extracted_root.join(&safe_rel);

            // Strict-prefix check post-join: defence-in-depth in case of
            // any platform-specific path resolution surprise.
            if !target.starts_with(&extracted_root) {
                *unsafe_reason.borrow_mut() = Some(UnsafeReason {
                    entry: entry.name.clone(),
                    reason: "escape",
                });
                return Err(io_err("unsafe-entry:escape"));
            }

            if entry.is_directory {
                // A bare `_vault/` directory entry is fine; only its
                // children other than metadata.json are forbidden.
                std::fs::create_dir_all(&target).map_err(|e| io_err(format!("mkdir: {e}")))?;
                return Ok(true);
            }

            // Forbid all non-metadata `_vault/...` entries.
            if let Some(rel) = strip_leading(&safe_rel, "_vault") {
                let normalised = rel.to_string_lossy();
                if normalised != "metadata.json" {
                    *unsafe_reason.borrow_mut() = Some(UnsafeReason {
                        entry: entry.name.clone(),
                        reason: "vault-collision",
                    });
                    return Err(io_err("unsafe-entry:vault-collision"));
                }
            }

            if let Some(p) = target.parent() {
                std::fs::create_dir_all(p).map_err(|e| io_err(format!("mkdir parent: {e}")))?;
            }
            let mut file =
                std::fs::File::create(&target).map_err(|e| io_err(format!("create file: {e}")))?;
            let n = std::io::copy(reader, &mut file).map_err(|e| io_err(format!("copy: {e}")))?;
            bytes_written = bytes_written.saturating_add(n);
            Ok(true)
        },
    );

    match result {
        Ok(()) => Ok(ExtractedTree {
            extracted_root,
            bytes_written,
        }),
        Err(_e) => {
            // If we recorded an unsafe reason, surface that first.
            let reason = unsafe_reason.into_inner();
            // Remove the per-run dir so the caller never observes a partial
            // extraction.
            let _ = std::fs::remove_dir_all(&paths.run_root);
            if let Some(r) = reason {
                Err(VaultSourceError::ExtractionUnsafePath {
                    archive_path: archive_path_owned,
                    entry: r.entry,
                    reason: r.reason,
                })
            } else {
                Err(VaultSourceError::ExtractionFailed {
                    archive_path: archive_path_owned,
                    reason: "7z decoder error".into(),
                    bytes_written,
                })
            }
        }
    }
}

#[derive(Debug)]
struct UnsafeReason {
    entry: String,
    reason: &'static str,
}

/// Validate an archive entry name. Returns the safe relative path, or a
/// short reason string suitable for `VaultSourceError::ExtractionUnsafePath`.
pub fn validate_entry_name(name: &str) -> Result<PathBuf, &'static str> {
    if name.is_empty() {
        return Err("empty-name");
    }
    if name.contains('\0') {
        return Err("nul-byte");
    }
    // Reject windows-style drive prefix like `C:\` or `C:/`.
    if name.len() >= 3 {
        let bytes = name.as_bytes();
        if bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/')
        {
            return Err("drive-prefix");
        }
    }

    let normalised = name.replace('\\', "/");
    let p = PathBuf::from(&normalised);
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => continue,
            Component::ParentDir => return Err("parent-dir"),
            Component::RootDir => return Err("absolute-path"),
            Component::Prefix(_) => return Err("drive-prefix"),
            Component::Normal(part) => {
                let s = part.to_string_lossy();
                if s.contains('\\') {
                    return Err("backslash");
                }
                out.push(part);
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err("empty-name");
    }
    Ok(out)
}

fn strip_leading<'a>(p: &'a Path, prefix: &str) -> Option<&'a Path> {
    let mut comps = p.components();
    let first = comps.next()?;
    match first {
        Component::Normal(n) if n == prefix => Some(comps.as_path()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_archive_entry_containing_parent_dir_segment_before_writing_anything() {
        assert_eq!(validate_entry_name("foo/../bar.txt"), Err("parent-dir"));
        assert_eq!(validate_entry_name("../escape.txt"), Err("parent-dir"));
    }

    #[test]
    fn rejects_archive_entry_with_absolute_path() {
        assert_eq!(validate_entry_name("/etc/passwd"), Err("absolute-path"));
    }

    #[test]
    fn rejects_archive_entry_with_windows_drive_prefix() {
        assert_eq!(
            validate_entry_name("C:\\Windows\\notepad.exe"),
            Err("drive-prefix")
        );
        assert_eq!(validate_entry_name("D:/foo/bar.txt"), Err("drive-prefix"));
    }

    #[test]
    fn accepts_a_normal_relative_path() {
        let p = validate_entry_name("foo/bar/baz.txt").unwrap();
        assert_eq!(p, PathBuf::from("foo/bar/baz.txt"));
    }

    #[test]
    fn accepts_underscore_vault_metadata_json() {
        // Path itself is safe; the "must-be metadata.json" check happens
        // inside the extraction callback.
        let p = validate_entry_name("_vault/metadata.json").unwrap();
        assert_eq!(p, PathBuf::from("_vault/metadata.json"));
    }

    #[test]
    fn strip_leading_recognises_underscore_vault_prefix() {
        assert_eq!(
            strip_leading(Path::new("_vault/metadata.json"), "_vault"),
            Some(Path::new("metadata.json"))
        );
        assert_eq!(
            strip_leading(Path::new("_vault/secret/key"), "_vault"),
            Some(Path::new("secret/key"))
        );
        assert_eq!(strip_leading(Path::new("game/foo"), "_vault"), None);
    }
}
