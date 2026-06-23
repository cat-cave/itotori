//! Stable semantic diagnostics for the runtime conformance contract.
//!
//! Mirrors the [`crate::sink::errors`] and [`crate::vfs::diagnostics`]
//! precedents: every variant carries a stable `utsushi.conformance.*`
//! semantic code and a `codes::ALL` registry the downstream allowed-code
//! validator joins against (UTSUSHI-022). The audit-focus item is
//! "Skipped != Pass": the enum below makes a manifest-declared
//! `Skip`/`Unsupported` outcome a typed rejection rather than a silent
//! omission.

use std::fmt;

use crate::EvidenceTier;

use super::ProfileId;
use super::manifest::SubsystemRequirement;

/// Stable Utsushi conformance semantic codes.
pub mod codes {
    pub const UNSUPPORTED_SCHEMA_VERSION: &str = "utsushi.conformance.unsupported_schema_version";
    pub const ADAPTER_ID_MALFORMED: &str = "utsushi.conformance.adapter_id_malformed";
    pub const UNKNOWN_ABI_VERSION: &str = "utsushi.conformance.unknown_abi_version";
    pub const MANIFEST_EMPTY: &str = "utsushi.conformance.manifest_empty";
    pub const DUPLICATE_PROFILE: &str = "utsushi.conformance.duplicate_profile";
    pub const MISSING_SUBSYSTEM: &str = "utsushi.conformance.missing_subsystem";
    pub const DUPLICATE_SUBSYSTEM: &str = "utsushi.conformance.duplicate_subsystem";
    pub const EVIDENCE_TIER_ABOVE_PROFILE_CEILING: &str =
        "utsushi.conformance.evidence_tier_above_profile_ceiling";
    pub const ORPHANED_EXTENSION: &str = "utsushi.conformance.orphaned_extension";
    pub const DUPLICATE_EXTENSION: &str = "utsushi.conformance.duplicate_extension";
    pub const EXTENSION_KEY_MALFORMED: &str = "utsushi.conformance.extension_key_malformed";
    pub const RECORDED_AT_MALFORMED: &str = "utsushi.conformance.recorded_at_malformed";
    pub const EVIDENCE_REF_INVALID: &str = "utsushi.conformance.evidence_ref_invalid";
    pub const PASS_WITHOUT_EVIDENCE: &str = "utsushi.conformance.pass_without_evidence";
    pub const MALFORMED_SEMANTIC_CODE: &str = "utsushi.conformance.malformed_semantic_code";
    pub const DECLARED_PROFILE_REPORTED_AS_UNSUPPORTED: &str =
        "utsushi.conformance.declared_profile_reported_as_unsupported";
    pub const DECLARED_PROFILE_SKIPPED: &str = "utsushi.conformance.declared_profile_skipped";
    pub const PROFILE_NOT_DECLARED: &str = "utsushi.conformance.profile_not_declared";
    pub const PROFILE_NOT_REPORTED: &str = "utsushi.conformance.profile_not_reported";
    pub const ADAPTER_ID_MISMATCH: &str = "utsushi.conformance.adapter_id_mismatch";
    pub const PASS_ABOVE_MANIFEST_CEILING: &str = "utsushi.conformance.pass_above_manifest_ceiling";

    /// Full set of stable conformance semantic codes. Conformance
    /// schemas that gate runtime diagnostics by allowed-code list
    /// include each of these.
    pub const ALL: &[&str] = &[
        UNSUPPORTED_SCHEMA_VERSION,
        ADAPTER_ID_MALFORMED,
        UNKNOWN_ABI_VERSION,
        MANIFEST_EMPTY,
        DUPLICATE_PROFILE,
        MISSING_SUBSYSTEM,
        DUPLICATE_SUBSYSTEM,
        EVIDENCE_TIER_ABOVE_PROFILE_CEILING,
        ORPHANED_EXTENSION,
        DUPLICATE_EXTENSION,
        EXTENSION_KEY_MALFORMED,
        RECORDED_AT_MALFORMED,
        EVIDENCE_REF_INVALID,
        PASS_WITHOUT_EVIDENCE,
        MALFORMED_SEMANTIC_CODE,
        DECLARED_PROFILE_REPORTED_AS_UNSUPPORTED,
        DECLARED_PROFILE_SKIPPED,
        PROFILE_NOT_DECLARED,
        PROFILE_NOT_REPORTED,
        ADAPTER_ID_MISMATCH,
        PASS_ABOVE_MANIFEST_CEILING,
    ];
}

/// Diagnostic variants emitted by the conformance manifest and result
/// validators. Each variant is a stable conformance signal; never
/// silent. Audit-focus invariants ("Skipped != Pass",
/// "declared profile cannot be Skip/Unsupported") are enforced by the
/// `DeclaredProfile*` variants below.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConformanceError {
    /// `schema_version` field did not match the literal pin.
    UnsupportedSchemaVersion {
        observed: String,
        expected: &'static str,
    },
    /// Adapter id did not match the lowercase kebab pattern.
    AdapterIdMalformed { id: String },
    /// Conformance ABI version is not in `SUPPORTED_ABI_VERSIONS`.
    UnknownAbiVersion {
        declared: u32,
        supported: &'static [u32],
    },
    /// Manifest declared no profiles.
    ManifestEmpty,
    /// Two `ConformanceProfile` entries share the same id.
    DuplicateProfile { id: ProfileId },
    /// Profile is missing a substrate subsystem its `ProfileId` requires.
    MissingSubsystem {
        profile: ProfileId,
        missing: SubsystemRequirement,
    },
    /// Profile declared the same subsystem twice.
    DuplicateSubsystem {
        profile: ProfileId,
        subsystem: SubsystemRequirement,
    },
    /// Profile or result claimed an evidence tier above the profile-id
    /// ceiling.
    EvidenceTierAboveProfileCeiling {
        profile: ProfileId,
        claimed: EvidenceTier,
        ceiling: EvidenceTier,
    },
    /// Extension referenced a profile id that is not declared.
    OrphanedExtension { key: String, profile_id: ProfileId },
    /// Two extensions on the same profile share the same key.
    DuplicateExtension { profile_id: ProfileId, key: String },
    /// Extension key did not match the lowercase kebab pattern.
    ExtensionKeyMalformed { key: String },
    /// `recorded_at` did not parse as RFC3339.
    RecordedAtMalformed { recorded_at: String },
    /// Evidence ref failed structural validation (URI shape, whitespace,
    /// or local-path leak).
    EvidenceRefInvalid {
        artifact_kind: &'static str,
        reason: String,
    },
    /// Pass outcome carried no evidence references.
    PassWithoutEvidence { profile: ProfileId },
    /// Outcome `semantic_code` did not match the provider-namespaced
    /// shape regex.
    MalformedSemanticCode { code: String },
    /// `Unsupported.declared_in_manifest == true`. A declared profile
    /// cannot be Unsupported.
    DeclaredProfileReportedAsUnsupported { profile: ProfileId },
    /// Manifest declared the profile but the result reported `Skip`.
    DeclaredProfileSkipped { profile: ProfileId },
    /// Result reported a profile that is not in the manifest.
    ProfileNotDeclared { profile: ProfileId },
    /// Manifest declared the profile but no result reported it.
    ProfileNotReported { profile: ProfileId },
    /// Result adapter id did not match manifest adapter id.
    AdapterIdMismatch { manifest: String, result: String },
    /// Pass outcome tier exceeds the manifest's per-profile ceiling.
    PassAboveManifestCeiling {
        profile: ProfileId,
        claimed: EvidenceTier,
        ceiling: EvidenceTier,
    },
}

impl ConformanceError {
    /// Stable `utsushi.conformance.*` semantic code for this variant.
    pub fn semantic_code(&self) -> &'static str {
        match self {
            Self::UnsupportedSchemaVersion { .. } => codes::UNSUPPORTED_SCHEMA_VERSION,
            Self::AdapterIdMalformed { .. } => codes::ADAPTER_ID_MALFORMED,
            Self::UnknownAbiVersion { .. } => codes::UNKNOWN_ABI_VERSION,
            Self::ManifestEmpty => codes::MANIFEST_EMPTY,
            Self::DuplicateProfile { .. } => codes::DUPLICATE_PROFILE,
            Self::MissingSubsystem { .. } => codes::MISSING_SUBSYSTEM,
            Self::DuplicateSubsystem { .. } => codes::DUPLICATE_SUBSYSTEM,
            Self::EvidenceTierAboveProfileCeiling { .. } => {
                codes::EVIDENCE_TIER_ABOVE_PROFILE_CEILING
            }
            Self::OrphanedExtension { .. } => codes::ORPHANED_EXTENSION,
            Self::DuplicateExtension { .. } => codes::DUPLICATE_EXTENSION,
            Self::ExtensionKeyMalformed { .. } => codes::EXTENSION_KEY_MALFORMED,
            Self::RecordedAtMalformed { .. } => codes::RECORDED_AT_MALFORMED,
            Self::EvidenceRefInvalid { .. } => codes::EVIDENCE_REF_INVALID,
            Self::PassWithoutEvidence { .. } => codes::PASS_WITHOUT_EVIDENCE,
            Self::MalformedSemanticCode { .. } => codes::MALFORMED_SEMANTIC_CODE,
            Self::DeclaredProfileReportedAsUnsupported { .. } => {
                codes::DECLARED_PROFILE_REPORTED_AS_UNSUPPORTED
            }
            Self::DeclaredProfileSkipped { .. } => codes::DECLARED_PROFILE_SKIPPED,
            Self::ProfileNotDeclared { .. } => codes::PROFILE_NOT_DECLARED,
            Self::ProfileNotReported { .. } => codes::PROFILE_NOT_REPORTED,
            Self::AdapterIdMismatch { .. } => codes::ADAPTER_ID_MISMATCH,
            Self::PassAboveManifestCeiling { .. } => codes::PASS_ABOVE_MANIFEST_CEILING,
        }
    }
}

impl fmt::Display for ConformanceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = self.semantic_code();
        match self {
            Self::UnsupportedSchemaVersion { observed, expected } => {
                write!(formatter, "{code}: observed={observed} expected={expected}")
            }
            Self::AdapterIdMalformed { id } => write!(formatter, "{code}: id={id}"),
            Self::UnknownAbiVersion {
                declared,
                supported,
            } => write!(
                formatter,
                "{code}: declared={declared} supported={supported:?}"
            ),
            Self::ManifestEmpty => write!(formatter, "{code}: no profiles declared"),
            Self::DuplicateProfile { id } => {
                write!(formatter, "{code}: profile={}", id.as_str())
            }
            Self::MissingSubsystem { profile, missing } => write!(
                formatter,
                "{code}: profile={} missing={}",
                profile.as_str(),
                missing.as_str()
            ),
            Self::DuplicateSubsystem { profile, subsystem } => write!(
                formatter,
                "{code}: profile={} subsystem={}",
                profile.as_str(),
                subsystem.as_str()
            ),
            Self::EvidenceTierAboveProfileCeiling {
                profile,
                claimed,
                ceiling,
            } => write!(
                formatter,
                "{code}: profile={} claimed={} ceiling={}",
                profile.as_str(),
                claimed.as_str(),
                ceiling.as_str()
            ),
            Self::OrphanedExtension { key, profile_id } => write!(
                formatter,
                "{code}: key={key} profile={}",
                profile_id.as_str()
            ),
            Self::DuplicateExtension { profile_id, key } => write!(
                formatter,
                "{code}: profile={} key={key}",
                profile_id.as_str()
            ),
            Self::ExtensionKeyMalformed { key } => write!(formatter, "{code}: key={key}"),
            Self::RecordedAtMalformed { recorded_at } => {
                write!(formatter, "{code}: recorded_at={recorded_at}")
            }
            Self::EvidenceRefInvalid {
                artifact_kind,
                reason,
            } => write!(
                formatter,
                "{code}: artifact_kind={artifact_kind} reason={reason}"
            ),
            Self::PassWithoutEvidence { profile } => {
                write!(formatter, "{code}: profile={}", profile.as_str())
            }
            Self::MalformedSemanticCode { code: bad_code } => {
                write!(formatter, "{code}: code={bad_code}")
            }
            Self::DeclaredProfileReportedAsUnsupported { profile } => {
                write!(formatter, "{code}: profile={}", profile.as_str())
            }
            Self::DeclaredProfileSkipped { profile } => {
                write!(formatter, "{code}: profile={}", profile.as_str())
            }
            Self::ProfileNotDeclared { profile } => {
                write!(formatter, "{code}: profile={}", profile.as_str())
            }
            Self::ProfileNotReported { profile } => {
                write!(formatter, "{code}: profile={}", profile.as_str())
            }
            Self::AdapterIdMismatch { manifest, result } => write!(
                formatter,
                "{code}: manifest_adapter_id={manifest} result_adapter_id={result}"
            ),
            Self::PassAboveManifestCeiling {
                profile,
                claimed,
                ceiling,
            } => write!(
                formatter,
                "{code}: profile={} claimed={} ceiling={}",
                profile.as_str(),
                claimed.as_str(),
                ceiling.as_str()
            ),
        }
    }
}

impl std::error::Error for ConformanceError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn variants() -> Vec<ConformanceError> {
        vec![
            ConformanceError::UnsupportedSchemaVersion {
                observed: "0.0.0".to_string(),
                expected: "0.1.0-alpha",
            },
            ConformanceError::AdapterIdMalformed {
                id: "Bad-Id".to_string(),
            },
            ConformanceError::UnknownAbiVersion {
                declared: 99,
                supported: &[1],
            },
            ConformanceError::ManifestEmpty,
            ConformanceError::DuplicateProfile {
                id: ProfileId::TextTrace,
            },
            ConformanceError::MissingSubsystem {
                profile: ProfileId::TextTrace,
                missing: SubsystemRequirement::TextSink,
            },
            ConformanceError::DuplicateSubsystem {
                profile: ProfileId::TextTrace,
                subsystem: SubsystemRequirement::TextSink,
            },
            ConformanceError::EvidenceTierAboveProfileCeiling {
                profile: ProfileId::TextTrace,
                claimed: EvidenceTier::E2,
                ceiling: EvidenceTier::E1,
            },
            ConformanceError::OrphanedExtension {
                key: "orphan".to_string(),
                profile_id: ProfileId::FrameCapture,
            },
            ConformanceError::DuplicateExtension {
                profile_id: ProfileId::FrameCapture,
                key: "rgba8".to_string(),
            },
            ConformanceError::ExtensionKeyMalformed {
                key: "Bad-Key".to_string(),
            },
            ConformanceError::RecordedAtMalformed {
                recorded_at: "not-a-time".to_string(),
            },
            ConformanceError::EvidenceRefInvalid {
                artifact_kind: "runtime_artifact",
                reason: "bad uri".to_string(),
            },
            ConformanceError::PassWithoutEvidence {
                profile: ProfileId::TextTrace,
            },
            ConformanceError::MalformedSemanticCode {
                code: "bogus.code".to_string(),
            },
            ConformanceError::DeclaredProfileReportedAsUnsupported {
                profile: ProfileId::TextTrace,
            },
            ConformanceError::DeclaredProfileSkipped {
                profile: ProfileId::TextTrace,
            },
            ConformanceError::ProfileNotDeclared {
                profile: ProfileId::TextTrace,
            },
            ConformanceError::ProfileNotReported {
                profile: ProfileId::TextTrace,
            },
            ConformanceError::AdapterIdMismatch {
                manifest: "utsushi-a".to_string(),
                result: "utsushi-b".to_string(),
            },
            ConformanceError::PassAboveManifestCeiling {
                profile: ProfileId::TextTrace,
                claimed: EvidenceTier::E1,
                ceiling: EvidenceTier::E0,
            },
        ]
    }

    #[test]
    fn every_conformance_error_variant_returns_a_code_in_codes_all() {
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
    fn conformance_error_display_does_not_leak_host_paths() {
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
    fn conformance_error_implements_std_error() {
        fn assert_std_error<E: std::error::Error>(_: &E) {}
        let error = ConformanceError::ManifestEmpty;
        assert_std_error(&error);
    }
}
