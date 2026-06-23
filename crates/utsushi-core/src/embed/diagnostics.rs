//! Stable semantic diagnostics for the WASM embed ABI substrate.
//!
//! Mirrors the [`crate::snapshot::diagnostics`], [`crate::sink::errors`], and
//! [`crate::conformance::diagnostics`] precedents: every variant carries a
//! stable `utsushi.embed.*` semantic code and a `codes::ALL` registry so a
//! downstream conformance allowed-code validator cannot silently drop a
//! variant. The audit-focus item for this module is "no silent best-effort":
//! every capability-mismatch, validation, or redaction failure surfaces as a
//! typed [`EmbedError`] variant.

use std::fmt;

use super::capability::EmbedCapabilityId;

/// Stable Utsushi embed semantic codes.
pub mod codes {
    pub const SCHEMA_VERSION_MISMATCH: &str = "utsushi.embed.schema_version_mismatch";
    pub const CAPABILITY_NOT_SUPPORTED: &str = "utsushi.embed.capability_not_supported";
    pub const INVALID_CAPABILITY: &str = "utsushi.embed.invalid_capability";
    pub const DUPLICATE_CAPABILITY: &str = "utsushi.embed.duplicate_capability";
    pub const UNSORTED_CAPABILITIES: &str = "utsushi.embed.unsorted_capabilities";
    pub const INVALID_ADAPTER_ID: &str = "utsushi.embed.invalid_adapter_id";
    pub const SNAPSHOT_ADAPTER_ID_MISMATCH: &str = "utsushi.embed.snapshot_adapter_id_mismatch";
    pub const INVALID_SNAPSHOT_REF: &str = "utsushi.embed.invalid_snapshot_ref";
    pub const INVALID_ARTIFACT_REF: &str = "utsushi.embed.invalid_artifact_ref";
    pub const REDACTION_VIOLATION: &str = "utsushi.embed.redaction_violation";
    pub const ENVELOPE_TOO_LARGE: &str = "utsushi.embed.envelope_too_large";
    pub const TRACE_TOO_LARGE: &str = "utsushi.embed.trace_too_large";
    pub const ARTIFACT_REFS_TOO_LARGE: &str = "utsushi.embed.artifact_refs_too_large";
    pub const CAPABILITIES_TOO_LARGE: &str = "utsushi.embed.capabilities_too_large";
    pub const JSON: &str = "utsushi.embed.json";

    /// Full set of stable Utsushi embed semantic codes. Conformance schemas
    /// that gate runtime diagnostics by allowed-code list include each of
    /// these.
    pub const ALL: &[&str] = &[
        SCHEMA_VERSION_MISMATCH,
        CAPABILITY_NOT_SUPPORTED,
        INVALID_CAPABILITY,
        DUPLICATE_CAPABILITY,
        UNSORTED_CAPABILITIES,
        INVALID_ADAPTER_ID,
        SNAPSHOT_ADAPTER_ID_MISMATCH,
        INVALID_SNAPSHOT_REF,
        INVALID_ARTIFACT_REF,
        REDACTION_VIOLATION,
        ENVELOPE_TOO_LARGE,
        TRACE_TOO_LARGE,
        ARTIFACT_REFS_TOO_LARGE,
        CAPABILITIES_TOO_LARGE,
        JSON,
    ];
}

/// Diagnostic variants emitted by the embed ABI substrate. Each variant is a
/// stable conformance signal; the substrate never silently best-efforts an
/// envelope, capability, or redaction failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EmbedError {
    /// Schema version mismatch on `from_json_value` or `validate`.
    SchemaVersionMismatch {
        observed: String,
        expected: &'static str,
    },

    /// Host asked for a field whose capability is declared `Unsupported`.
    CapabilityNotSupported { capability_id: EmbedCapabilityId },

    /// `EmbedCapability` validation failed (e.g. supported without ceiling,
    /// partial without limitations).
    InvalidCapability {
        capability_id: EmbedCapabilityId,
        reason: String,
    },

    /// Duplicate capability id in the declaration list.
    DuplicateCapability { capability_id: EmbedCapabilityId },

    /// Capability list is unsorted.
    UnsortedCapabilities,

    /// Adapter id failed shape validation (blank, whitespace, non-ASCII).
    InvalidAdapterId { observed: String },

    /// `EmbedState::current_snapshot`'s adapter id does not equal the
    /// envelope's `adapter_id`.
    SnapshotAdapterIdMismatch { envelope: String, snapshot: String },

    /// `EmbedSnapshotRef` failed shape validation (bad uuid, hash shape, size
    /// over ceiling, evidence tier > E3).
    InvalidSnapshotRef { reason: String },

    /// `EmbedArtifactRef` failed shape validation (URI not under managed
    /// prefix, traversal, scheme leak).
    InvalidArtifactRef { reason: String },

    /// A field anywhere in the serialized envelope matched
    /// `looks_like_local_path`.
    RedactionViolation { field_path: String },

    /// Envelope size exceeded `EMBED_STATE_MAX_SERIALIZED_BYTES`.
    EnvelopeTooLarge { size: usize, ceiling: usize },

    /// Trace exceeded `EMBED_TRACE_MAX_LINES`.
    TraceTooLarge { observed: usize, ceiling: usize },

    /// Artifact ref list exceeded `EMBED_MAX_ARTIFACT_REFS`.
    ArtifactRefsTooLarge { observed: usize, ceiling: usize },

    /// Capability list exceeded `EMBED_MAX_CAPABILITIES`.
    CapabilitiesTooLarge { observed: usize, ceiling: usize },

    /// Generic JSON serialization / deserialization error.
    Json { reason: String },
}

impl EmbedError {
    /// Stable `utsushi.embed.*` semantic code for this variant.
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::SchemaVersionMismatch { .. } => codes::SCHEMA_VERSION_MISMATCH,
            Self::CapabilityNotSupported { .. } => codes::CAPABILITY_NOT_SUPPORTED,
            Self::InvalidCapability { .. } => codes::INVALID_CAPABILITY,
            Self::DuplicateCapability { .. } => codes::DUPLICATE_CAPABILITY,
            Self::UnsortedCapabilities => codes::UNSORTED_CAPABILITIES,
            Self::InvalidAdapterId { .. } => codes::INVALID_ADAPTER_ID,
            Self::SnapshotAdapterIdMismatch { .. } => codes::SNAPSHOT_ADAPTER_ID_MISMATCH,
            Self::InvalidSnapshotRef { .. } => codes::INVALID_SNAPSHOT_REF,
            Self::InvalidArtifactRef { .. } => codes::INVALID_ARTIFACT_REF,
            Self::RedactionViolation { .. } => codes::REDACTION_VIOLATION,
            Self::EnvelopeTooLarge { .. } => codes::ENVELOPE_TOO_LARGE,
            Self::TraceTooLarge { .. } => codes::TRACE_TOO_LARGE,
            Self::ArtifactRefsTooLarge { .. } => codes::ARTIFACT_REFS_TOO_LARGE,
            Self::CapabilitiesTooLarge { .. } => codes::CAPABILITIES_TOO_LARGE,
            Self::Json { .. } => codes::JSON,
        }
    }
}

impl fmt::Display for EmbedError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = self.semantic_code();
        match self {
            Self::SchemaVersionMismatch { observed, expected } => {
                write!(formatter, "{code}: observed={observed} expected={expected}")
            }
            Self::CapabilityNotSupported { capability_id } => write!(
                formatter,
                "{code}: capability_id={}",
                capability_id.as_str()
            ),
            Self::InvalidCapability {
                capability_id,
                reason,
            } => write!(
                formatter,
                "{code}: capability_id={} reason={reason}",
                capability_id.as_str()
            ),
            Self::DuplicateCapability { capability_id } => write!(
                formatter,
                "{code}: capability_id={}",
                capability_id.as_str()
            ),
            Self::UnsortedCapabilities => {
                write!(formatter, "{code}: capability list must be sorted by id")
            }
            Self::InvalidAdapterId { observed } => {
                write!(formatter, "{code}: observed={observed}")
            }
            Self::SnapshotAdapterIdMismatch { envelope, snapshot } => {
                write!(formatter, "{code}: envelope={envelope} snapshot={snapshot}")
            }
            Self::InvalidSnapshotRef { reason } => write!(formatter, "{code}: reason={reason}"),
            Self::InvalidArtifactRef { reason } => write!(formatter, "{code}: reason={reason}"),
            Self::RedactionViolation { field_path } => {
                write!(formatter, "{code}: field_path={field_path}")
            }
            Self::EnvelopeTooLarge { size, ceiling } => {
                write!(formatter, "{code}: size={size} ceiling={ceiling}")
            }
            Self::TraceTooLarge { observed, ceiling } => {
                write!(formatter, "{code}: observed={observed} ceiling={ceiling}")
            }
            Self::ArtifactRefsTooLarge { observed, ceiling } => {
                write!(formatter, "{code}: observed={observed} ceiling={ceiling}")
            }
            Self::CapabilitiesTooLarge { observed, ceiling } => {
                write!(formatter, "{code}: observed={observed} ceiling={ceiling}")
            }
            Self::Json { reason } => write!(formatter, "{code}: reason={reason}"),
        }
    }
}

impl std::error::Error for EmbedError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn variants() -> Vec<EmbedError> {
        vec![
            EmbedError::SchemaVersionMismatch {
                observed: "0.0.1".to_string(),
                expected: "0.1.0-alpha",
            },
            EmbedError::CapabilityNotSupported {
                capability_id: EmbedCapabilityId::Trace,
            },
            EmbedError::InvalidCapability {
                capability_id: EmbedCapabilityId::Snapshot,
                reason: "supported without ceiling".to_string(),
            },
            EmbedError::DuplicateCapability {
                capability_id: EmbedCapabilityId::State,
            },
            EmbedError::UnsortedCapabilities,
            EmbedError::InvalidAdapterId {
                observed: "bad id".to_string(),
            },
            EmbedError::SnapshotAdapterIdMismatch {
                envelope: "utsushi-fixture".to_string(),
                snapshot: "reallive".to_string(),
            },
            EmbedError::InvalidSnapshotRef {
                reason: "non-hex hash".to_string(),
            },
            EmbedError::InvalidArtifactRef {
                reason: "non-managed uri".to_string(),
            },
            EmbedError::RedactionViolation {
                field_path: "trace.lines[0].speaker".to_string(),
            },
            EmbedError::EnvelopeTooLarge {
                size: 99_000,
                ceiling: 32 * 1024,
            },
            EmbedError::TraceTooLarge {
                observed: 300,
                ceiling: 256,
            },
            EmbedError::ArtifactRefsTooLarge {
                observed: 80,
                ceiling: 64,
            },
            EmbedError::CapabilitiesTooLarge {
                observed: 99,
                ceiling: 32,
            },
            EmbedError::Json {
                reason: "trailing comma".to_string(),
            },
        ]
    }

    #[test]
    fn every_embed_error_variant_returns_a_code_in_codes_all() {
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
    fn embed_error_display_does_not_leak_host_paths() {
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
    fn embed_error_implements_std_error() {
        fn assert_std_error<E: std::error::Error + Send + Sync + 'static>(_: &E) {}
        let error = EmbedError::UnsortedCapabilities;
        assert_std_error(&error);
    }

    #[test]
    fn codes_all_starts_with_utsushi_embed_prefix() {
        for code in codes::ALL {
            assert!(
                code.starts_with("utsushi.embed."),
                "code {code} must use the utsushi.embed.* prefix"
            );
        }
    }
}
