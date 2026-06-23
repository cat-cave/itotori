//! Typed semantic errors for the vault-source adapter.
//!
//! Every variant maps 1:1 to a row in the contract's *Failure Modes* table
//! (`docs/itotori-vault-source-adapter.md` §Failure Modes). The adapter
//! never falls back silently — every recoverable disagreement is surfaced
//! via a [`crate::findings::CrossCheckFinding`] instead.

use std::io;
use std::path::PathBuf;

/// Semantic-code constants. Stable identifiers for downstream telemetry /
/// findings sinks. Kept local to this crate per the orchestrator's decision
/// on Risk #2 (semantic codes stay scoped here, not in `kaifuu-core`).
/// Semantic code for [`VaultSourceError::VaultRootMissing`].
pub const SEMANTIC_VAULT_ROOT_MISSING: &str = "kaifuu.vault.root_missing";
/// Semantic code for [`VaultSourceError::VaultRootIncomplete`].
pub const SEMANTIC_VAULT_ROOT_INCOMPLETE: &str = "kaifuu.vault.root_incomplete";
/// Semantic code for [`VaultSourceError::CatalogOpenFailed`].
pub const SEMANTIC_VAULT_CATALOG_OPEN_FAILED: &str = "kaifuu.vault.catalog_open_failed";
/// Semantic code for [`VaultSourceError::CatalogSchemaUnsupported`].
pub const SEMANTIC_VAULT_CATALOG_SCHEMA_UNSUPPORTED: &str =
    "kaifuu.vault.catalog_schema_unsupported";
/// Semantic code for [`VaultSourceError::ReleaseNotResolved`].
pub const SEMANTIC_VAULT_RELEASE_NOT_RESOLVED: &str = "kaifuu.vault.release_not_resolved";
/// Semantic code for [`VaultSourceError::ArtifactMissing`].
pub const SEMANTIC_VAULT_ARTIFACT_MISSING: &str = "kaifuu.vault.artifact_missing";
/// Semantic code for [`VaultSourceError::ArtifactSizeMismatch`].
pub const SEMANTIC_VAULT_ARTIFACT_SIZE_MISMATCH: &str = "kaifuu.vault.artifact_size_mismatch";
/// Semantic code for [`VaultSourceError::ArtifactHashMismatch`].
pub const SEMANTIC_VAULT_ARTIFACT_HASH_MISMATCH: &str = "kaifuu.vault.artifact_hash_mismatch";
/// Semantic code for [`VaultSourceError::ExtractionFailed`].
pub const SEMANTIC_VAULT_EXTRACTION_FAILED: &str = "kaifuu.vault.extraction_failed";
/// Semantic code for [`VaultSourceError::ExtractionUnsafePath`].
pub const SEMANTIC_VAULT_EXTRACTION_UNSAFE_PATH: &str = "kaifuu.vault.extraction_unsafe_path";
/// Semantic code for [`VaultSourceError::EmbeddedMetadataMissing`].
pub const SEMANTIC_VAULT_EMBEDDED_METADATA_MISSING: &str = "kaifuu.vault.embedded_metadata_missing";
/// Semantic code for [`VaultSourceError::EmbeddedMetadataInvalid`].
pub const SEMANTIC_VAULT_EMBEDDED_METADATA_INVALID: &str = "kaifuu.vault.embedded_metadata_invalid";
/// Semantic code for [`VaultSourceError::CatalogEmbeddedMismatch`].
pub const SEMANTIC_VAULT_CATALOG_EMBEDDED_MISMATCH: &str = "kaifuu.vault.catalog_embedded_mismatch";
/// Semantic code for [`VaultSourceError::ScratchUnwritable`].
pub const SEMANTIC_VAULT_SCRATCH_UNWRITABLE: &str = "kaifuu.vault.scratch_unwritable";

/// Schema version this adapter knows how to read. Hard-pinned per the
/// orchestrator's decision on Risk #3.
pub const SUPPORTED_SCHEMA_VERSION: u32 = 1;

/// The typed error surface for every vault-source operation.
///
/// Mapping to *Failure Modes* table is 1:1 — see `SemanticCode::from`.
#[derive(Debug, thiserror::Error)]
pub enum VaultSourceError {
    /// Configured vault root does not exist or is not a directory.
    #[error("vault root missing: {path:?}")]
    VaultRootMissing {
        /// Resolved root that was probed.
        path: PathBuf,
    },

    /// Vault root exists but lacks a required child.
    #[error("vault root incomplete: {path:?} missing {missing}")]
    VaultRootIncomplete {
        /// Resolved root that was probed.
        path: PathBuf,
        /// Required child that is missing (`catalog.db` or `artifacts/by-sha/`).
        missing: &'static str,
    },

    /// `catalog.db` exists but cannot be opened read-only.
    #[error("catalog.db could not be opened read-only: {path:?}: {source}")]
    CatalogOpenFailed {
        /// Path that was passed to the SQLite open call.
        path: PathBuf,
        /// Underlying SQLite error.
        #[source]
        source: rusqlite::Error,
    },

    /// `schema_version.version` is missing or higher than this adapter supports.
    #[error("catalog schema unsupported: observed={observed:?}, supported={supported}")]
    CatalogSchemaUnsupported {
        /// Highest schema version observed in the `schema_version` table, if any.
        observed: Option<u32>,
        /// Schema version this adapter pins to.
        supported: u32,
    },

    /// Discovery returned zero releases for the claim.
    #[error("no release resolved for claim {claim_summary}")]
    ReleaseNotResolved {
        /// Human-readable summary of the claim, for operator triage.
        claim_summary: String,
    },

    /// The `by-sha` path for the resolved sha256 does not exist.
    #[error("artifact missing on disk: {path:?} sha256={sha256}")]
    ArtifactMissing {
        /// Expected on-disk path under `<vault-root>/artifacts/by-sha/`.
        path: PathBuf,
        /// Catalog-declared sha256.
        sha256: String,
        /// Release this artifact resolves from.
        release_id: i64,
        /// `artifacts.id` row this resolution targeted.
        artifact_id: i64,
    },

    /// On-disk file size differs from `artifacts.size_bytes`.
    #[error("artifact size mismatch at {path:?}: expected={expected} actual={actual}")]
    ArtifactSizeMismatch {
        /// On-disk path.
        path: PathBuf,
        /// Catalog-declared sha256 (for triage).
        sha256: String,
        /// Catalog-declared size.
        expected: u64,
        /// Observed size on disk.
        actual: u64,
    },

    /// Streamed sha256 differs from `artifacts.sha256`.
    #[error("artifact hash mismatch at {path:?}: expected={expected} actual={actual}")]
    ArtifactHashMismatch {
        /// On-disk path.
        path: PathBuf,
        /// Catalog-declared sha256.
        expected: String,
        /// Observed sha256.
        actual: String,
    },

    /// 7z decompression failed; truncated archive, decoder error, disk full.
    #[error("extraction failed for {archive_path:?}: {reason}")]
    ExtractionFailed {
        /// Archive on disk that was being extracted.
        archive_path: PathBuf,
        /// Operator-facing reason string.
        reason: String,
        /// Bytes that had been written to the per-run scratch dir before
        /// failure. Surfaced for operator triage; the partial dir is
        /// removed before this error returns.
        bytes_written: u64,
    },

    /// Archive entry rejected for path traversal or symlink escape.
    #[error("unsafe archive entry rejected: {entry:?} reason={reason}")]
    ExtractionUnsafePath {
        /// Archive being extracted.
        archive_path: PathBuf,
        /// The offending entry name as found in the archive header.
        entry: String,
        /// Why it was rejected (parent-dir, absolute-path, drive-prefix,
        /// vault-collision, symlink-escape).
        reason: &'static str,
    },

    /// Extraction completed but `_vault/metadata.json` is absent.
    #[error("_vault/metadata.json missing under {extracted_root:?}")]
    EmbeddedMetadataMissing {
        /// Per-run extracted root.
        extracted_root: PathBuf,
        /// The artifact's sha256, for triage.
        artifact_sha256: String,
    },

    /// `_vault/metadata.json` fails schema validation.
    #[error("_vault/metadata.json failed schema validation under {extracted_root:?}")]
    EmbeddedMetadataInvalid {
        /// Per-run extracted root.
        extracted_root: PathBuf,
        /// The embedded `schema_version` field as observed (or `"unknown"`).
        schema_version: String,
        /// One human-readable line per failed JSON-Schema rule.
        errors: Vec<String>,
    },

    /// Cross-check disagreement exceeded the configured tolerance.
    ///
    /// The default tolerance (per contract) rejects only mismatched
    /// work identity; everything else is a [`crate::findings::CrossCheckFinding`].
    #[error("catalog/embedded disagreement on {field} for {entity_type}:{entity_id}")]
    CatalogEmbeddedMismatch {
        /// `work` | `release` | `artifact`.
        entity_type: String,
        /// Catalog row id of the entity.
        entity_id: i64,
        /// Field that disagreed.
        field: String,
        /// Catalog-side value.
        catalog_value: serde_json::Value,
        /// Embedded-side value.
        embedded_value: serde_json::Value,
    },

    /// Resolved scratch root cannot be created or written.
    #[error("scratch root unwritable: {path:?}: {source}")]
    ScratchUnwritable {
        /// Resolved scratch root.
        path: PathBuf,
        /// Underlying I/O error.
        #[source]
        source: io::Error,
    },
}

impl VaultSourceError {
    /// Stable semantic-code string for this error variant.
    ///
    /// The string is suitable for telemetry, findings sinks, and operator
    /// dashboards. Each variant has exactly one code.
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::VaultRootMissing { .. } => SEMANTIC_VAULT_ROOT_MISSING,
            Self::VaultRootIncomplete { .. } => SEMANTIC_VAULT_ROOT_INCOMPLETE,
            Self::CatalogOpenFailed { .. } => SEMANTIC_VAULT_CATALOG_OPEN_FAILED,
            Self::CatalogSchemaUnsupported { .. } => SEMANTIC_VAULT_CATALOG_SCHEMA_UNSUPPORTED,
            Self::ReleaseNotResolved { .. } => SEMANTIC_VAULT_RELEASE_NOT_RESOLVED,
            Self::ArtifactMissing { .. } => SEMANTIC_VAULT_ARTIFACT_MISSING,
            Self::ArtifactSizeMismatch { .. } => SEMANTIC_VAULT_ARTIFACT_SIZE_MISMATCH,
            Self::ArtifactHashMismatch { .. } => SEMANTIC_VAULT_ARTIFACT_HASH_MISMATCH,
            Self::ExtractionFailed { .. } => SEMANTIC_VAULT_EXTRACTION_FAILED,
            Self::ExtractionUnsafePath { .. } => SEMANTIC_VAULT_EXTRACTION_UNSAFE_PATH,
            Self::EmbeddedMetadataMissing { .. } => SEMANTIC_VAULT_EMBEDDED_METADATA_MISSING,
            Self::EmbeddedMetadataInvalid { .. } => SEMANTIC_VAULT_EMBEDDED_METADATA_INVALID,
            Self::CatalogEmbeddedMismatch { .. } => SEMANTIC_VAULT_CATALOG_EMBEDDED_MISMATCH,
            Self::ScratchUnwritable { .. } => SEMANTIC_VAULT_SCRATCH_UNWRITABLE,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The contract's *Failure Modes* table has exactly 14 rows. Each row
    /// maps to exactly one variant; this test pins the count and the
    /// code-string mapping.
    #[test]
    fn every_failure_mode_row_maps_to_exactly_one_variant() {
        let expected: &[(&str, &str)] = &[
            ("VaultRootMissing", SEMANTIC_VAULT_ROOT_MISSING),
            ("VaultRootIncomplete", SEMANTIC_VAULT_ROOT_INCOMPLETE),
            ("CatalogOpenFailed", SEMANTIC_VAULT_CATALOG_OPEN_FAILED),
            (
                "CatalogSchemaUnsupported",
                SEMANTIC_VAULT_CATALOG_SCHEMA_UNSUPPORTED,
            ),
            ("ReleaseNotResolved", SEMANTIC_VAULT_RELEASE_NOT_RESOLVED),
            ("ArtifactMissing", SEMANTIC_VAULT_ARTIFACT_MISSING),
            (
                "ArtifactSizeMismatch",
                SEMANTIC_VAULT_ARTIFACT_SIZE_MISMATCH,
            ),
            (
                "ArtifactHashMismatch",
                SEMANTIC_VAULT_ARTIFACT_HASH_MISMATCH,
            ),
            ("ExtractionFailed", SEMANTIC_VAULT_EXTRACTION_FAILED),
            (
                "ExtractionUnsafePath",
                SEMANTIC_VAULT_EXTRACTION_UNSAFE_PATH,
            ),
            (
                "EmbeddedMetadataMissing",
                SEMANTIC_VAULT_EMBEDDED_METADATA_MISSING,
            ),
            (
                "EmbeddedMetadataInvalid",
                SEMANTIC_VAULT_EMBEDDED_METADATA_INVALID,
            ),
            (
                "CatalogEmbeddedMismatch",
                SEMANTIC_VAULT_CATALOG_EMBEDDED_MISMATCH,
            ),
            ("ScratchUnwritable", SEMANTIC_VAULT_SCRATCH_UNWRITABLE),
        ];
        assert_eq!(expected.len(), 14, "Failure Modes table size pin");

        // Build a sample of each variant and check the code.
        let samples: Vec<(&str, VaultSourceError)> = vec![
            (
                "VaultRootMissing",
                VaultSourceError::VaultRootMissing {
                    path: PathBuf::from("/x"),
                },
            ),
            (
                "VaultRootIncomplete",
                VaultSourceError::VaultRootIncomplete {
                    path: PathBuf::from("/x"),
                    missing: "catalog.db",
                },
            ),
            (
                "CatalogSchemaUnsupported",
                VaultSourceError::CatalogSchemaUnsupported {
                    observed: Some(2),
                    supported: SUPPORTED_SCHEMA_VERSION,
                },
            ),
            (
                "ReleaseNotResolved",
                VaultSourceError::ReleaseNotResolved {
                    claim_summary: "x".into(),
                },
            ),
            (
                "ArtifactMissing",
                VaultSourceError::ArtifactMissing {
                    path: PathBuf::from("/x"),
                    sha256: "00".into(),
                    release_id: 1,
                    artifact_id: 1,
                },
            ),
            (
                "ArtifactSizeMismatch",
                VaultSourceError::ArtifactSizeMismatch {
                    path: PathBuf::from("/x"),
                    sha256: "00".into(),
                    expected: 1,
                    actual: 2,
                },
            ),
            (
                "ArtifactHashMismatch",
                VaultSourceError::ArtifactHashMismatch {
                    path: PathBuf::from("/x"),
                    expected: "a".into(),
                    actual: "b".into(),
                },
            ),
            (
                "ExtractionFailed",
                VaultSourceError::ExtractionFailed {
                    archive_path: PathBuf::from("/x"),
                    reason: "truncated".into(),
                    bytes_written: 0,
                },
            ),
            (
                "ExtractionUnsafePath",
                VaultSourceError::ExtractionUnsafePath {
                    archive_path: PathBuf::from("/x"),
                    entry: "..".into(),
                    reason: "parent-dir",
                },
            ),
            (
                "EmbeddedMetadataMissing",
                VaultSourceError::EmbeddedMetadataMissing {
                    extracted_root: PathBuf::from("/x"),
                    artifact_sha256: "00".into(),
                },
            ),
            (
                "EmbeddedMetadataInvalid",
                VaultSourceError::EmbeddedMetadataInvalid {
                    extracted_root: PathBuf::from("/x"),
                    schema_version: "1.0".into(),
                    errors: vec!["x".into()],
                },
            ),
            (
                "CatalogEmbeddedMismatch",
                VaultSourceError::CatalogEmbeddedMismatch {
                    entity_type: "work".into(),
                    entity_id: 1,
                    field: "identifiers".into(),
                    catalog_value: serde_json::Value::Null,
                    embedded_value: serde_json::Value::Null,
                },
            ),
        ];

        for (name, sample) in &samples {
            let expected_code = expected
                .iter()
                .find(|(n, _)| *n == *name)
                .map(|(_, c)| *c)
                .unwrap_or_else(|| panic!("variant {name} not in expected table"));
            assert_eq!(
                sample.semantic_code(),
                expected_code,
                "variant {name} semantic_code drift"
            );
        }
    }
}
