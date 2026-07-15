//! Resolve a release id into one or more on-disk artifacts, addressed BY-ID.
//! The on-disk path is the content-addressed *by-id* store:
//! ```text
//! <vault-root>/artifacts/by-id/<canonical_id>/<canonical_id>.7z
//! `canonical_id` is the catalog's STABLE identity for an artifact
//! (`artifacts.canonical_id`); the path is reconstructed from it and
//! cross-checked against the catalog's `artifacts.vault_path`. The legacy
//! sha-addressed archive path and the archive-level sha256/size integrity
//! coupling have been removed: a content hash is brittle identity (any
//! folder/metadata change mints a new hash), so identity is `canonical_id`
//! plus the embedded `_vault/metadata.json` cross-check, and byte-fidelity is
//! a per-game-file hash (e.g. the extracted `Seen.txt`), never the archive
//! hash.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

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

/// A resolved artifact: catalog-side facts plus an on-disk by-id path we have
/// confirmed exists and is a regular file.
#[derive(Debug, Clone)]
pub struct ResolvedArtifact {
    /// `artifacts.id`.
    pub id: i64,
    /// `release_artifacts.role`.
    pub role: String,
    /// `release_artifacts.subpath` (None when the artifact is a whole
    /// release).
    pub subpath: Option<String>,
    /// `artifacts.canonical_id` — the stable identity and the by-id store key.
    pub canonical_id: String,
    /// Reconstructed `<vault-root>/artifacts/by-id/<canonical_id>/<canonical_id>.7z`.
    pub on_disk_path: PathBuf,
    /// `artifacts.original_sha256` (provenance only; the pre-repack download
    /// hash, never used for path reconstruction or verification).
    pub original_sha256: Option<String>,
    /// `artifacts.artifact_kind`.
    pub artifact_kind: String,
    /// `artifacts.canonical_sha256` — the repacked by-id archive hash
    /// (informational provenance only; NOT an identity or verification gate).
    pub canonical_sha256: Option<String>,
    /// `artifacts.vault_path` (the catalog's recorded by-id path; cross-checked
    /// against the reconstruction).
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
        let canonical_id = match r.canonical_id {
            Some(c) if !c.is_empty() => c,
            _ => {
                return Err(VaultSourceError::ReleaseNotResolved {
                    claim_summary: format!(
                        "release-id({release_id}) artifact-id({}) has no by-id canonical_id",
                        r.id
                    ),
                });
            }
        };
        let on_disk_path = by_id_path(vault_root, &canonical_id)?;
        verify_vault_path_is_by_id(&r.vault_path, &canonical_id, release_id, r.id)?;
        verify_artifact_present(&on_disk_path, &canonical_id, release_id, r.id)?;
        out.push(ResolvedArtifact {
            id: r.id,
            role: r.role,
            subpath: r.subpath,
            canonical_id,
            on_disk_path,
            original_sha256: r.original_sha256,
            artifact_kind: r.artifact_kind,
            canonical_sha256: r.canonical_sha256,
            vault_path: r.vault_path,
        });
    }
    Ok(out)
}

/// Construct the on-disk path for an artifact addressed by `canonical_id`, per
/// `<vault-root>/artifacts/by-id/<canonical_id>/<canonical_id>.7z`.
/// The `canonical_id` is validated as a single safe path segment before use
/// (no separators, no `..`, no NUL, non-empty), so a corrupt
/// `artifacts.canonical_id` surfaces a typed
/// [`VaultSourceError::ReleaseNotResolved`] instead of escaping the by-id
/// store.
pub fn by_id_path(vault_root: &Path, canonical_id: &str) -> Result<PathBuf, VaultSourceError> {
    validate_canonical_id(canonical_id)?;
    Ok(vault_root
        .join("artifacts")
        .join("by-id")
        .join(canonical_id)
        .join(format!("{canonical_id}.7z")))
}

/// A `canonical_id` is a single filesystem-safe directory segment.
fn validate_canonical_id(canonical_id: &str) -> Result<(), VaultSourceError> {
    let bad = canonical_id.is_empty()
        || canonical_id == "."
        || canonical_id == ".."
        || canonical_id.contains('/')
        || canonical_id.contains('\\')
        || canonical_id.contains('\0')
        || canonical_id.starts_with('.');
    if bad {
        return Err(VaultSourceError::ReleaseNotResolved {
            claim_summary: format!("canonical_id({canonical_id}) is not a safe by-id segment"),
        });
    }
    Ok(())
}

/// Defence in depth: the catalog's recorded `vault_path` must be the by-id
/// path for this `canonical_id`. A row still pointing at the removed legacy
/// sha-addressed layout (or any other path) is a typed resolution failure,
/// never silently honoured.
fn verify_vault_path_is_by_id(
    vault_path: &str,
    canonical_id: &str,
    release_id: i64,
    artifact_id: i64,
) -> Result<(), VaultSourceError> {
    let expected = format!("artifacts/by-id/{canonical_id}/{canonical_id}.7z");
    if vault_path != expected {
        return Err(VaultSourceError::ReleaseNotResolved {
            claim_summary: format!(
                "release-id({release_id}) artifact-id({artifact_id}) vault_path {vault_path:?} \
                 is not the by-id path {expected:?}"
            ),
        });
    }
    Ok(())
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
    canonical_id: Option<String>,
    vault_path: String,
    original_sha256: Option<String>,
    artifact_kind: String,
    canonical_sha256: Option<String>,
}

fn load_release_artifact_rows(
    conn: &Connection,
    release_id: i64,
) -> Result<Vec<RawRow>, VaultSourceError> {
    // v3 links an artifact to its release primarily via the direct
    // `artifacts.release_id` column (that artifact IS the release's primary
    // content, role `primary`); the `release_artifacts` junction carries the
    // supplementary roles (patch / translation / bundle_member /...). The v1
    // synthetic fixture leaves `artifacts.release_id` NULL and uses only the
    // junction. We union both and dedupe per artifact, keeping the
    // strongest-precedence role.
    let mut stmt = conn
        .prepare(
            "SELECT 'primary' AS role, NULL AS subpath, a.id, a.canonical_id, a.vault_path, \
                    a.original_sha256, a.artifact_kind, a.canonical_sha256 \
             FROM artifacts a \
             WHERE a.release_id = ?1 \
             UNION ALL \
             SELECT ra.role, ra.subpath, a.id, a.canonical_id, a.vault_path, \
                    a.original_sha256, a.artifact_kind, a.canonical_sha256 \
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
                canonical_id: r.get::<_, Option<String>>(3)?,
                vault_path: r.get::<_, String>(4)?,
                original_sha256: r.get::<_, Option<String>>(5)?,
                artifact_kind: r.get::<_, String>(6)?,
                canonical_sha256: r.get::<_, Option<String>>(7)?,
            })
        })
        .map_err(map_query_err)?;

    // Dedupe per artifact id, keeping the strongest-precedence role (e.g. a
    // `primary` direct-column row wins over a `bundle_member` junction row for
    // the same artifact).
    let mut by_id: std::collections::BTreeMap<i64, RawRow> = std::collections::BTreeMap::new();
    for r in rows {
        let r = r.map_err(map_query_err)?;
        match by_id.get(&r.id) {
            Some(existing) if role_order(&existing.role) <= role_order(&r.role) => {}
            _ => {
                by_id.insert(r.id, r);
            }
        }
    }
    Ok(by_id.into_values().collect())
}

fn map_query_err(_e: rusqlite::Error) -> VaultSourceError {
    VaultSourceError::CatalogSchemaUnsupported {
        observed: None,
        supported: crate::error::SUPPORTED_SCHEMA_VERSIONS,
    }
}

/// Stat the by-id archive: it must exist and be a regular file. Symlinks are
/// refused (`symlink_metadata` does not follow them), so nothing under
/// `by-name/` or elsewhere can stand in for the addressed artifact. No
/// archive-level sha256/size verification is performed — byte-fidelity is a
/// per-game-file concern, not an archive-repack-hash concern.
fn verify_artifact_present(
    on_disk_path: &Path,
    canonical_id: &str,
    release_id: i64,
    artifact_id: i64,
) -> Result<(), VaultSourceError> {
    let Ok(meta) = std::fs::symlink_metadata(on_disk_path) else {
        return Err(VaultSourceError::ArtifactMissing {
            path: on_disk_path.to_path_buf(),
            canonical_id: canonical_id.to_string(),
            release_id,
            artifact_id,
        });
    };
    if !meta.file_type().is_file() {
        return Err(VaultSourceError::ArtifactMissing {
            path: on_disk_path.to_path_buf(),
            canonical_id: canonical_id.to_string(),
            release_id,
            artifact_id,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn computes_by_id_path_from_canonical_id() {
        let root = Path::new("/vault");
        let cid = "oshioki-sweetie.vj013077.v1-0.ja";
        let p = by_id_path(root, cid).expect("valid canonical_id");
        assert_eq!(
            p,
            Path::new("/vault/artifacts/by-id")
                .join(cid)
                .join(format!("{cid}.7z"))
        );
    }

    #[test]
    fn by_id_path_rejects_unsafe_canonical_id_with_typed_error_instead_of_escaping() {
        let root = Path::new("/vault");
        for bad in ["", ".", "..", "a/b", "a\\b", ".hidden", "x/../etc"] {
            assert!(
                matches!(
                    by_id_path(root, bad),
                    Err(VaultSourceError::ReleaseNotResolved { .. })
                ),
                "expected rejection for {bad:?}"
            );
        }
    }

    #[test]
    fn verify_vault_path_rejects_removed_legacy_sha_layout() {
        // A catalog row still pointing at the removed legacy sha-addressed
        // layout must surface a typed resolution failure, never be honoured.
        let err = verify_vault_path_is_by_id(
            "artifacts/sha-addressed/aa/bb/aabb....7z",
            "some-id.v1.ja",
            1,
            1,
        )
        .unwrap_err();
        assert!(matches!(err, VaultSourceError::ReleaseNotResolved { .. }));
    }

    #[test]
    fn verify_vault_path_accepts_matching_by_id_path() {
        let cid = "some-id.v1.ja";
        verify_vault_path_is_by_id(&format!("artifacts/by-id/{cid}/{cid}.7z"), cid, 1, 1).unwrap();
    }

    #[test]
    fn returns_missing_when_by_id_archive_does_not_exist() {
        let p = PathBuf::from("/tmp/itotori-vault-source-by-id-nope.7z");
        let err = verify_artifact_present(&p, "nope.v1.ja", 1, 1).unwrap_err();
        assert!(matches!(err, VaultSourceError::ArtifactMissing { .. }));
    }

    #[test]
    fn returns_missing_when_by_id_path_is_a_directory_not_a_file() {
        let td = tempdir().unwrap();
        let dir = td.path().join("notafile.7z");
        std::fs::create_dir_all(&dir).unwrap();
        let err = verify_artifact_present(&dir, "notafile.v1.ja", 1, 1).unwrap_err();
        assert!(matches!(err, VaultSourceError::ArtifactMissing { .. }));
    }
}
