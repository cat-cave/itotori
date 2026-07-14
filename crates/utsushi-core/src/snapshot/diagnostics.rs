//! Stable semantic diagnostics for the inspectable-state and snapshot
//! primitives.
//!
//! Mirrors the [`crate::sink::errors`] and [`crate::conformance::diagnostics`]
//! precedents: every variant carries a stable `utsushi.snapshot.*` semantic
//! code and a `codes::ALL` registry so a downstream conformance allowed-code
//! validator cannot silently drop a variant. The audit-focus item for this
//! module is "no silent best-effort": every restore / diff / validation
//! failure surfaces as a typed `SnapshotError` variant.

use std::fmt;

use crate::EvidenceTier;

use super::envelope::SnapshotEnvelope;
use super::state::StatePath;

/// Stable Utsushi snapshot semantic codes.
pub mod codes {
    pub const SCHEMA_VERSION_MISMATCH: &str = "utsushi.snapshot.schema_version_mismatch";
    pub const INVALID_STATE_PATH: &str = "utsushi.snapshot.invalid_state_path";
    pub const UNKNOWN_STATE_NAMESPACE: &str = "utsushi.snapshot.unknown_state_namespace";
    pub const DUPLICATE_STATE_PATH: &str = "utsushi.snapshot.duplicate_state_path";
    pub const RESTORE_STATE_PATH_UNKNOWN: &str = "utsushi.snapshot.restore_state_path_unknown";
    pub const RESTORE_TYPE_MISMATCH: &str = "utsushi.snapshot.restore_type_mismatch";
    pub const RESTORE_VALUE_OUT_OF_RANGE: &str = "utsushi.snapshot.restore_value_out_of_range";
    pub const RESTORE_UNSUPPORTED: &str = "utsushi.snapshot.restore_unsupported";
    pub const INSPECTABLE_ID_MISMATCH: &str = "utsushi.snapshot.inspectable_id_mismatch";
    pub const DIFF_INSPECTABLE_ID_MISMATCH: &str = "utsushi.snapshot.diff_inspectable_id_mismatch";
    pub const REDACTION_VIOLATION: &str = "utsushi.snapshot.redaction_violation";
    pub const INVALID_BYTES_VALUE: &str = "utsushi.snapshot.invalid_bytes_value";
    pub const SNAPSHOT_ENVELOPE_OVERFLOW: &str = "utsushi.snapshot.snapshot_envelope_overflow";
    pub const EVIDENCE_TIER_OVERCLAIM: &str = "utsushi.snapshot.evidence_tier_overclaim";
    pub const INVALID_SNAPSHOT_ID: &str = "utsushi.snapshot.invalid_snapshot_id";
    pub const INVALID_INSPECTABLE_ID: &str = "utsushi.snapshot.invalid_inspectable_id";
    pub const INVALID_GENERATED_AT: &str = "utsushi.snapshot.invalid_generated_at";
    pub const EMPTY_STATE_TREE: &str = "utsushi.snapshot.empty_state_tree";
    pub const SERIALIZATION_FAILURE: &str = "utsushi.snapshot.serialization_failure";

    // additive store + state-drift codes. Source of
    // truth is `super::super::store::codes`; re-export here so legacy
    // dotted paths continue to resolve and so the unified `ALL` slice
    // can name each entry locally. ----
    pub use super::super::store::codes::{
        STATE_DRIFT, STORE_INSPECTABLE_ID_MISMATCH, STORE_INVALID_SNAPSHOT_REF,
        STORE_MISMATCHED_SCHEMA_VERSION, STORE_NOT_FOUND, STORE_UNAVAILABLE,
    };

    /// Full set of stable Utsushi snapshot semantic codes. Conformance
    /// schemas that gate runtime diagnostics by allowed-code list
    /// include each of these.
    pub const ALL: &[&str] = &[
        SCHEMA_VERSION_MISMATCH,
        INVALID_STATE_PATH,
        UNKNOWN_STATE_NAMESPACE,
        DUPLICATE_STATE_PATH,
        RESTORE_STATE_PATH_UNKNOWN,
        RESTORE_TYPE_MISMATCH,
        RESTORE_VALUE_OUT_OF_RANGE,
        RESTORE_UNSUPPORTED,
        INSPECTABLE_ID_MISMATCH,
        DIFF_INSPECTABLE_ID_MISMATCH,
        REDACTION_VIOLATION,
        INVALID_BYTES_VALUE,
        SNAPSHOT_ENVELOPE_OVERFLOW,
        EVIDENCE_TIER_OVERCLAIM,
        INVALID_SNAPSHOT_ID,
        INVALID_INSPECTABLE_ID,
        INVALID_GENERATED_AT,
        EMPTY_STATE_TREE,
        SERIALIZATION_FAILURE,
        // store + state-drift additions.
        STORE_NOT_FOUND,
        STORE_MISMATCHED_SCHEMA_VERSION,
        STORE_INVALID_SNAPSHOT_REF,
        STORE_INSPECTABLE_ID_MISMATCH,
        STORE_UNAVAILABLE,
        STATE_DRIFT,
    ];
}

/// Diagnostic variants emitted by the snapshot substrate validators and
/// operations. Each variant is a stable conformance signal; the snapshot
/// substrate never silently best-efforts a restore, diff, or validation
/// failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SnapshotError {
    /// `Snapshot::schema_version` is not the literal pin.
    SchemaVersionMismatch {
        observed: String,
        expected: &'static str,
    },

    /// `StatePath::parse` rejected a malformed path.
    InvalidStatePath { raw: String, reason: String },

    /// `StatePath` top-level segment is not a known `StateNamespace`.
    UnknownStateNamespace { raw: String, observed_root: String },

    /// Insert collided with an existing path of identical canonical form.
    DuplicateStatePath { path: String },

    /// `restore_snapshot` saw a path the port does not know how to consume.
    RestoreStatePathUnknown { path: StatePath },

    /// `restore_snapshot` saw a value whose type did not match the port's
    /// expectation.
    RestoreTypeMismatch {
        path: StatePath,
        expected: &'static str,
        found: &'static str,
    },

    /// `restore_snapshot` saw a value outside the port's accepted range.
    /// `reason` is a stable, public phrase.
    RestoreValueOutOfRange { path: StatePath, reason: String },

    /// `restore_snapshot` failed because the port does not implement
    /// `Restorable`. Conformance reports this as
    /// `utsushi.snapshot.restore_unsupported`.
    RestoreUnsupported { inspectable_id: String },

    /// Snapshot vs port inspectable id mismatch.
    InspectableIdMismatch { expected: String, found: String },

    /// `diff_snapshots` saw two snapshots with different inspectable ids.
    DiffInspectableIdMismatch { left: String, right: String },

    /// A field path inside the serialized snapshot or state tree matched
    /// `looks_like_local_path`.
    RedactionViolation { field_path: String },

    /// A `BytesValue` carried a sample longer than `BYTES_SAMPLE_HEX_LEN`
    /// a hash of wrong length, or a non-hex digest character.
    InvalidBytesValue { field_path: String, reason: String },

    /// Serialized snapshot exceeded the declared
    /// [`super::SnapshotEnvelope`] tier's `max_bytes()`. The runner
    /// produces no partial output and does not fall back to a larger
    /// tier.
    SnapshotEnvelopeOverflow {
        envelope_class: SnapshotEnvelope,
        observed_bytes: usize,
        limit_bytes: usize,
    },

    /// Snapshot was constructed with `evidence_tier > E3`.
    EvidenceTierOverclaim {
        claimed: EvidenceTier,
        ceiling: EvidenceTier,
    },

    /// `SnapshotId::parse` rejected a malformed id.
    InvalidSnapshotId { raw: String, reason: String },

    /// Inspectable id failed shape validation (empty, malformed, or
    /// host-path-shaped).
    InvalidInspectableId { raw: String, reason: String },

    /// `generated_at` failed RFC3339 validation.
    InvalidGeneratedAt { raw: String, reason: String },

    /// Snapshot or state tree was empty when validation required at least
    /// one path.
    EmptyStateTree,

    /// JSON serialization or deserialization failed (malformed wire
    /// payload). Carries the reason verbatim from `serde_json`.
    SerializationFailure { reason: String },
}

impl SnapshotError {
    /// Stable `utsushi.snapshot.*` semantic code for this variant.
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::SchemaVersionMismatch { .. } => codes::SCHEMA_VERSION_MISMATCH,
            Self::InvalidStatePath { .. } => codes::INVALID_STATE_PATH,
            Self::UnknownStateNamespace { .. } => codes::UNKNOWN_STATE_NAMESPACE,
            Self::DuplicateStatePath { .. } => codes::DUPLICATE_STATE_PATH,
            Self::RestoreStatePathUnknown { .. } => codes::RESTORE_STATE_PATH_UNKNOWN,
            Self::RestoreTypeMismatch { .. } => codes::RESTORE_TYPE_MISMATCH,
            Self::RestoreValueOutOfRange { .. } => codes::RESTORE_VALUE_OUT_OF_RANGE,
            Self::RestoreUnsupported { .. } => codes::RESTORE_UNSUPPORTED,
            Self::InspectableIdMismatch { .. } => codes::INSPECTABLE_ID_MISMATCH,
            Self::DiffInspectableIdMismatch { .. } => codes::DIFF_INSPECTABLE_ID_MISMATCH,
            Self::RedactionViolation { .. } => codes::REDACTION_VIOLATION,
            Self::InvalidBytesValue { .. } => codes::INVALID_BYTES_VALUE,
            Self::SnapshotEnvelopeOverflow { .. } => codes::SNAPSHOT_ENVELOPE_OVERFLOW,
            Self::EvidenceTierOverclaim { .. } => codes::EVIDENCE_TIER_OVERCLAIM,
            Self::InvalidSnapshotId { .. } => codes::INVALID_SNAPSHOT_ID,
            Self::InvalidInspectableId { .. } => codes::INVALID_INSPECTABLE_ID,
            Self::InvalidGeneratedAt { .. } => codes::INVALID_GENERATED_AT,
            Self::EmptyStateTree => codes::EMPTY_STATE_TREE,
            Self::SerializationFailure { .. } => codes::SERIALIZATION_FAILURE,
        }
    }
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = self.semantic_code();
        match self {
            Self::SchemaVersionMismatch { observed, expected } => {
                write!(formatter, "{code}: observed={observed} expected={expected}")
            }
            Self::InvalidStatePath { raw, reason }
            | Self::InvalidSnapshotId { raw, reason }
            | Self::InvalidInspectableId { raw, reason }
            | Self::InvalidGeneratedAt { raw, reason } => {
                write!(formatter, "{code}: raw={raw} reason={reason}")
            }
            Self::UnknownStateNamespace { raw, observed_root } => {
                write!(formatter, "{code}: raw={raw} root={observed_root}")
            }
            Self::DuplicateStatePath { path } => write!(formatter, "{code}: path={path}"),
            Self::RestoreStatePathUnknown { path } => {
                write!(formatter, "{code}: path={}", path.as_str())
            }
            Self::RestoreTypeMismatch {
                path,
                expected,
                found,
            } => write!(
                formatter,
                "{code}: path={} expected={expected} found={found}",
                path.as_str()
            ),
            Self::RestoreValueOutOfRange { path, reason } => {
                write!(formatter, "{code}: path={} reason={reason}", path.as_str())
            }
            Self::RestoreUnsupported { inspectable_id } => {
                write!(formatter, "{code}: inspectable_id={inspectable_id}")
            }
            Self::InspectableIdMismatch { expected, found } => {
                write!(formatter, "{code}: expected={expected} found={found}")
            }
            Self::DiffInspectableIdMismatch { left, right } => {
                write!(formatter, "{code}: left={left} right={right}")
            }
            Self::RedactionViolation { field_path } => {
                write!(formatter, "{code}: field_path={field_path}")
            }
            Self::InvalidBytesValue { field_path, reason } => {
                write!(formatter, "{code}: field_path={field_path} reason={reason}")
            }
            Self::SnapshotEnvelopeOverflow {
                envelope_class,
                observed_bytes,
                limit_bytes,
            } => write!(
                formatter,
                "{code}: envelope_class={} observed_bytes={observed_bytes} limit_bytes={limit_bytes}",
                envelope_class.as_str()
            ),
            Self::EvidenceTierOverclaim { claimed, ceiling } => write!(
                formatter,
                "{code}: claimed={} ceiling={}",
                claimed.as_str(),
                ceiling.as_str()
            ),
            Self::EmptyStateTree => write!(formatter, "{code}: state tree must not be empty"),
            Self::SerializationFailure { reason } => write!(formatter, "{code}: reason={reason}"),
        }
    }
}

impl std::error::Error for SnapshotError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn variants() -> Vec<SnapshotError> {
        let path = StatePath::parse("port.frame").expect("path");
        vec![
            SnapshotError::SchemaVersionMismatch {
                observed: "0.0.1".to_string(),
                expected: "0.2.0-alpha",
            },
            SnapshotError::InvalidStatePath {
                raw: "BAD..PATH".to_string(),
                reason: "uppercase".to_string(),
            },
            SnapshotError::UnknownStateNamespace {
                raw: "unknown.thing".to_string(),
                observed_root: "unknown".to_string(),
            },
            SnapshotError::DuplicateStatePath {
                path: "port.frame".to_string(),
            },
            SnapshotError::RestoreStatePathUnknown { path: path.clone() },
            SnapshotError::RestoreTypeMismatch {
                path: path.clone(),
                expected: "int",
                found: "string",
            },
            SnapshotError::RestoreValueOutOfRange {
                path: path.clone(),
                reason: "negative frame".to_string(),
            },
            SnapshotError::RestoreUnsupported {
                inspectable_id: "utsushi-fixture".to_string(),
            },
            SnapshotError::InspectableIdMismatch {
                expected: "a".to_string(),
                found: "b".to_string(),
            },
            SnapshotError::DiffInspectableIdMismatch {
                left: "a".to_string(),
                right: "b".to_string(),
            },
            SnapshotError::RedactionViolation {
                field_path: "stateTree.port.cache_dir".to_string(),
            },
            SnapshotError::InvalidBytesValue {
                field_path: "stateTree.port.frame".to_string(),
                reason: "hash too short".to_string(),
            },
            SnapshotError::SnapshotEnvelopeOverflow {
                envelope_class: SnapshotEnvelope::Small,
                observed_bytes: 32_000,
                limit_bytes: 16 * 1024,
            },
            SnapshotError::EvidenceTierOverclaim {
                claimed: EvidenceTier::E4,
                ceiling: EvidenceTier::E3,
            },
            SnapshotError::InvalidSnapshotId {
                raw: "bad-id".to_string(),
                reason: "must be uuidv7-shaped".to_string(),
            },
            SnapshotError::InvalidInspectableId {
                raw: "Bad ID".to_string(),
                reason: "shape".to_string(),
            },
            SnapshotError::InvalidGeneratedAt {
                raw: "not-rfc3339".to_string(),
                reason: "shape".to_string(),
            },
            SnapshotError::EmptyStateTree,
            SnapshotError::SerializationFailure {
                reason: "invalid utf-8".to_string(),
            },
        ]
    }

    #[test]
    fn every_snapshot_error_variant_returns_a_code_in_codes_all() {
        let all: std::collections::HashSet<&'static str> = codes::ALL.iter().copied().collect();
        for variant in variants() {
            let code = variant.semantic_code();
            assert!(
                all.contains(code),
                "code {code} missing from codes::ALL (variant {variant:?})"
            );
        }
        assert_eq!(
            all.len(),
            codes::ALL.len(),
            "codes::ALL must not contain duplicates"
        );
    }

    #[test]
    fn snapshot_error_display_does_not_leak_host_paths() {
        for variant in variants() {
            let rendered = variant.to_string();
            for forbidden in ["/home/", "/tmp/", "/Users/", "/var/folders/", "file://"] {
                assert!(
                    !rendered.contains(forbidden),
                    "rendered={rendered} contained forbidden substring {forbidden}"
                );
            }
        }
    }

    #[test]
    fn snapshot_error_implements_std_error() {
        fn assert_std_error<E: std::error::Error + Send + Sync + 'static>(_: &E) {}
        let error = SnapshotError::EmptyStateTree;
        assert_std_error(&error);
    }

    #[test]
    fn codes_all_starts_with_utsushi_snapshot_prefix() {
        for code in codes::ALL {
            assert!(
                code.starts_with("utsushi.snapshot."),
                "code {code} must use the utsushi.snapshot.* prefix"
            );
        }
    }
}
