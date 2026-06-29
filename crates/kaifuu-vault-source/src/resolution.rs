//! Resolve a release id into one or more on-disk artifacts.
//!
//! The on-disk path is reconstructed purely from `artifacts.sha256`; the
//! catalog's informational `artifacts.vault_path` is never used. The
//! `by-name/` subtree is never consulted, listed, or stat-ed.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::error::VaultSourceError;

/// Caller-facing knob for *which* artifacts in a release the adapter
/// returns.
#[derive(Debug, Clone)]
pub struct ArtifactSelection {
    /// When `true`, only the `primary` role row is returned (the default
    /// contract behaviour).
    pub primary_only: bool,
    /// Roles to additionally include when `primary_only` is `false`.
    pub include_roles: HashSet<String>,
}

impl Default for ArtifactSelection {
    fn default() -> Self {
        Self {
            primary_only: true,
            include_roles: HashSet::new(),
        }
    }
}

impl ArtifactSelection {
    /// Convenience: select the primary role and the listed extra roles.
    pub fn with_roles<I, S>(mut self, roles: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        for r in roles {
            self.include_roles.insert(r.into());
        }
        self.primary_only = false;
        self
    }
}

/// A resolved artifact: catalog-side facts plus an on-disk path we have
/// confirmed exists, is a regular file, and matches both the catalog size
/// and the catalog sha256.
#[derive(Debug, Clone)]
pub struct ResolvedArtifact {
    /// `artifacts.id`.
    pub id: i64,
    /// `release_artifacts.role`.
    pub role: String,
    /// `release_artifacts.subpath` (None when the artifact is a whole
    /// release).
    pub subpath: Option<String>,
    /// `artifacts.sha256`.
    pub sha256: String,
    /// `artifacts.size_bytes`.
    pub size_bytes: u64,
    /// Reconstructed `<vault-root>/artifacts/by-sha/<aa>/<bb>/<hash>.7z`.
    pub on_disk_path: PathBuf,
    /// `artifacts.original_sha256` (for cross-check).
    pub original_sha256: Option<String>,
    /// `artifacts.artifact_kind`.
    pub artifact_kind: String,
    /// `artifacts.vault_path` (informational only; never used for I/O).
    pub vault_path: String,
}

/// Resolve a release id into one or more artifacts.
pub fn resolve_release(
    conn: &Connection,
    vault_root: &Path,
    release_id: i64,
    selection: &ArtifactSelection,
) -> Result<Vec<ResolvedArtifact>, VaultSourceError> {
    let rows = load_release_artifact_rows(conn, release_id)?;

    let mut wanted: Vec<RawRow> = rows
        .into_iter()
        .filter(|r| {
            if r.role == "primary" {
                return true;
            }
            !selection.primary_only && selection.include_roles.contains(r.role.as_str())
        })
        .collect();

    // Sort: primary first, then the contract's canonical role order.
    wanted.sort_by_key(|r| role_order(&r.role));

    let mut out = Vec::with_capacity(wanted.len());
    for r in wanted {
        let on_disk_path = by_sha_path(vault_root, &r.sha256);
        verify_artifact_on_disk(&on_disk_path, &r.sha256, r.size_bytes, release_id, r.id)?;
        out.push(ResolvedArtifact {
            id: r.id,
            role: r.role,
            subpath: r.subpath,
            sha256: r.sha256,
            size_bytes: r.size_bytes,
            on_disk_path,
            original_sha256: r.original_sha256,
            artifact_kind: r.artifact_kind,
            vault_path: r.vault_path,
        });
    }
    Ok(out)
}

/// Resolve directly from a sha256 (catalog-bypass mode). The catalog is
/// only consulted to identify which release_artifacts row, if any, holds
/// metadata about the artifact.
pub fn resolve_by_sha(
    conn: &Connection,
    vault_root: &Path,
    sha256: &str,
) -> Result<ResolvedArtifact, VaultSourceError> {
    let row: Option<(i64, String, u64, Option<String>, String, String)> = conn
        .query_row(
            "SELECT id, sha256, size_bytes, original_sha256, artifact_kind, vault_path \
             FROM artifacts WHERE sha256 = ?1",
            rusqlite::params![sha256],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? as u64,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            },
        )
        .ok();
    let (id, sha, size, original_sha256, artifact_kind, vault_path) = match row {
        Some(r) => r,
        None => {
            return Err(VaultSourceError::ReleaseNotResolved {
                claim_summary: format!("artifact-sha({sha256})"),
            });
        }
    };
    let on_disk_path = by_sha_path(vault_root, &sha);
    verify_artifact_on_disk(&on_disk_path, &sha, size, -1, id)?;
    Ok(ResolvedArtifact {
        id,
        role: "primary".into(),
        subpath: None,
        sha256: sha,
        size_bytes: size,
        on_disk_path,
        original_sha256,
        artifact_kind,
        vault_path,
    })
}

/// Construct the on-disk path for an artifact addressed by sha256, per
/// `<vault-root>/artifacts/by-sha/<aa>/<bb>/<hash>.7z`.
pub fn by_sha_path(vault_root: &Path, sha256: &str) -> PathBuf {
    let aa = &sha256[0..2];
    let bb = &sha256[2..4];
    vault_root
        .join("artifacts")
        .join("by-sha")
        .join(aa)
        .join(bb)
        .join(format!("{sha256}.7z"))
}

fn role_order(role: &str) -> u32 {
    match role {
        "primary" => 0,
        "bundle_member" => 1,
        "volume_part" => 2,
        "patch" => 3,
        "translation" => 4,
        "dlc" => 5,
        "crack" => 6,
        "docs" => 7,
        _ => 99,
    }
}

#[derive(Debug)]
struct RawRow {
    id: i64,
    role: String,
    subpath: Option<String>,
    sha256: String,
    size_bytes: u64,
    original_sha256: Option<String>,
    artifact_kind: String,
    vault_path: String,
}

fn load_release_artifact_rows(
    conn: &Connection,
    release_id: i64,
) -> Result<Vec<RawRow>, VaultSourceError> {
    let mut stmt = conn
        .prepare(
            "SELECT ra.role, ra.subpath, a.id, a.sha256, a.size_bytes, \
                    a.original_sha256, a.artifact_kind, a.vault_path \
             FROM release_artifacts ra \
             JOIN artifacts a ON a.id = ra.artifact_id \
             WHERE ra.release_id = ?1",
        )
        .map_err(map_query_err)?;
    let rows = stmt
        .query_map(rusqlite::params![release_id], |r| {
            Ok(RawRow {
                role: r.get::<_, String>(0)?,
                subpath: r.get::<_, Option<String>>(1)?,
                id: r.get::<_, i64>(2)?,
                sha256: r.get::<_, String>(3)?,
                size_bytes: r.get::<_, i64>(4)? as u64,
                original_sha256: r.get::<_, Option<String>>(5)?,
                artifact_kind: r.get::<_, String>(6)?,
                vault_path: r.get::<_, String>(7)?,
            })
        })
        .map_err(map_query_err)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(map_query_err)?);
    }
    Ok(out)
}

fn map_query_err(_e: rusqlite::Error) -> VaultSourceError {
    VaultSourceError::CatalogSchemaUnsupported {
        observed: None,
        supported: crate::error::SUPPORTED_SCHEMA_VERSIONS,
    }
}

/// Stat + size + streamed sha256 check.
fn verify_artifact_on_disk(
    on_disk_path: &Path,
    expected_sha: &str,
    expected_size: u64,
    release_id: i64,
    artifact_id: i64,
) -> Result<(), VaultSourceError> {
    // symlink_metadata: refuse to follow symlinks (would let `by-name` or
    // anything else stand in for the addressed artifact).
    let meta = match std::fs::symlink_metadata(on_disk_path) {
        Ok(m) => m,
        Err(_) => {
            return Err(VaultSourceError::ArtifactMissing {
                path: on_disk_path.to_path_buf(),
                sha256: expected_sha.to_string(),
                release_id,
                artifact_id,
            });
        }
    };
    if !meta.file_type().is_file() {
        return Err(VaultSourceError::ArtifactMissing {
            path: on_disk_path.to_path_buf(),
            sha256: expected_sha.to_string(),
            release_id,
            artifact_id,
        });
    }
    let actual_size = meta.len();
    if actual_size != expected_size {
        return Err(VaultSourceError::ArtifactSizeMismatch {
            path: on_disk_path.to_path_buf(),
            sha256: expected_sha.to_string(),
            expected: expected_size,
            actual: actual_size,
        });
    }
    let actual_sha = stream_sha256(on_disk_path)?;
    if actual_sha != expected_sha {
        return Err(VaultSourceError::ArtifactHashMismatch {
            path: on_disk_path.to_path_buf(),
            expected: expected_sha.to_string(),
            actual: actual_sha,
        });
    }
    Ok(())
}

fn stream_sha256(path: &Path) -> Result<String, VaultSourceError> {
    let mut file = std::fs::File::open(path).map_err(|_| VaultSourceError::ArtifactMissing {
        path: path.to_path_buf(),
        sha256: String::new(),
        release_id: -1,
        artifact_id: -1,
    })?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| VaultSourceError::ExtractionFailed {
                archive_path: path.to_path_buf(),
                reason: format!("read error during sha256 stream: {e}"),
                bytes_written: 0,
            })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let out = hasher.finalize();
    Ok(hex_lower(&out))
}

fn hex_lower(bytes: &[u8]) -> String {
    const TABLE: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(TABLE[(b >> 4) as usize] as char);
        out.push(TABLE[(b & 0xf) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn computes_by_sha_path_from_sha256_using_first_two_pairs_as_subdirs() {
        let root = Path::new("/vault");
        let sha = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
        let p = by_sha_path(root, sha);
        assert_eq!(
            p,
            Path::new("/vault/artifacts/by-sha/aa/bb").join(format!("{sha}.7z"))
        );
    }

    #[test]
    fn rejects_artifact_whose_on_disk_size_differs_from_catalog_size() {
        let td = tempdir().unwrap();
        let p = td.path().join("a.7z");
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(b"hello").unwrap();
        let err = verify_artifact_on_disk(&p, "deadbeef", 999, 1, 1).unwrap_err();
        match err {
            VaultSourceError::ArtifactSizeMismatch {
                expected: 999,
                actual: 5,
                ..
            } => {}
            other => panic!("expected size mismatch, got {other:?}"),
        }
    }

    #[test]
    fn rejects_artifact_whose_streamed_sha256_differs_from_catalog_sha256() {
        let td = tempdir().unwrap();
        let p = td.path().join("a.7z");
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(b"hello").unwrap();
        // sha256("hello") starts with 2cf24dba5fb0...
        let wrong = "0000000000000000000000000000000000000000000000000000000000000000";
        let err = verify_artifact_on_disk(&p, wrong, 5, 1, 1).unwrap_err();
        match err {
            VaultSourceError::ArtifactHashMismatch { expected, .. } => {
                assert_eq!(expected, wrong);
            }
            other => panic!("expected hash mismatch, got {other:?}"),
        }
    }

    #[test]
    fn returns_missing_when_artifact_path_does_not_exist() {
        let p = PathBuf::from("/tmp/itotori-vault-source-nope.7z");
        let err = verify_artifact_on_disk(&p, "deadbeef", 0, 1, 1).unwrap_err();
        assert!(matches!(err, VaultSourceError::ArtifactMissing { .. }));
    }
}
