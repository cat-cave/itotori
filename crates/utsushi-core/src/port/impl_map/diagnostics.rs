//! Typed validator diagnostics for the implementation map.
//!
//! Every variant carries enough context for an auditor to fix the offending
//! map without re-running. User-supplied strings embedded in `raw:` fields
//! are upstream-redacted through [`crate::looks_like_local_path`] so a
//! diagnostic never echoes back a host path.

use std::fmt;

use super::schema::{EvidenceKind, SubsystemId, ValidationCommandId};

/// Sentinel token substituted for any user-supplied string that would
/// otherwise trip [`crate::looks_like_local_path`].
pub const REDACTED_LOCAL_PATH_TOKEN: &str = "<redacted:local-path>";

/// Top-level error surface returned by [`super::validate`]. Renderable
/// through `Display`; satisfies `looks_like_local_path` on every rendered
/// form (see test in this module).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImplMapError {
    UnsupportedSchemaVersion {
        declared: String,
        supported: &'static str,
    },
    PortIdMalformed {
        id: String,
    },
    EngineFamilyOtherWithoutNotes,
    NoSubsystemsDeclared,
    NoValidationCommandsDeclared,
    DuplicateSubsystemId {
        id: SubsystemId,
    },
    DuplicateValidationCommandId {
        id: ValidationCommandId,
    },
    OrphanValidationCommandRef {
        subsystem_id: SubsystemId,
        validation_command_id: ValidationCommandId,
    },
    OrphanValidationCommand {
        id: ValidationCommandId,
    },
    MissingFixtureProvenance {
        subsystem_id: SubsystemId,
        field: ProvenanceField,
    },
    FixtureHashMalformed {
        subsystem_id: SubsystemId,
        raw: String,
    },
    FixtureByteCountZero {
        subsystem_id: SubsystemId,
    },
    FixtureKindOtherWithoutNotes {
        subsystem_id: SubsystemId,
    },
    SyntheticInlineMismatch {
        subsystem_id: SubsystemId,
    },
    EmptyCapabilityList {
        subsystem_id: SubsystemId,
    },
    PartialWithoutLimitations {
        subsystem_id: SubsystemId,
    },
    UnsupportedReasonNotSemantic {
        subsystem_id: SubsystemId,
        raw: String,
    },
    ResearchEvidenceMissing {
        subsystem_id: SubsystemId,
    },
    ResearchEvidenceCaptionEmpty {
        subsystem_id: SubsystemId,
        index: usize,
    },
    ResearchEvidenceLocatorMalformed {
        subsystem_id: SubsystemId,
        index: usize,
        kind: EvidenceKind,
    },
    ValidationCommandEmpty {
        id: ValidationCommandId,
    },
    ValidationCommandUnsafeShape {
        id: ValidationCommandId,
        offending_token: String,
    },
    ValidationCommandPrefixUnknown {
        id: ValidationCommandId,
        prefix: String,
    },
    ValidationCommandCaptionEmpty {
        id: ValidationCommandId,
    },
    SkipReasonNotSemantic {
        id: ValidationCommandId,
        raw: String,
    },
    FailSemanticCodeMalformed {
        id: ValidationCommandId,
        raw: String,
    },
    ReferenceBehaviorMissing {
        field: ReferenceField,
    },
    GeneratedAtNotRfc3339 {
        raw: String,
    },
}

/// Which fixture-provenance field is missing or sentinel-shaped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProvenanceField {
    Id,
    Hash,
}

impl ProvenanceField {
    fn as_str(self) -> &'static str {
        match self {
            Self::Id => "id",
            Self::Hash => "hash",
        }
    }
}

/// Which reference-behavior field is empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ReferenceField {
    EngineRuntime,
    ObservableSignal,
}

impl ReferenceField {
    fn as_str(self) -> &'static str {
        match self {
            Self::EngineRuntime => "engineRuntime",
            Self::ObservableSignal => "observableSignal",
        }
    }
}

fn evidence_kind_label(kind: EvidenceKind) -> &'static str {
    match kind {
        EvidenceKind::Fixture => "fixture",
        EvidenceKind::Doc => "doc",
        EvidenceKind::RoadmapNode => "roadmap-node",
        EvidenceKind::ReferenceImplAnchor => "reference-impl-anchor",
    }
}

/// Upstream-redact any user-supplied string before embedding in a
/// diagnostic. Strings whose shape would trip
/// [`crate::looks_like_local_path`] are replaced with
/// [`REDACTED_LOCAL_PATH_TOKEN`] so rendered errors never leak host paths.
pub(crate) fn redact_for_diagnostic(raw: &str) -> String {
    if crate::looks_like_local_path(raw) {
        REDACTED_LOCAL_PATH_TOKEN.to_string()
    } else {
        raw.to_string()
    }
}

impl fmt::Display for ImplMapError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedSchemaVersion {
                declared,
                supported,
            } => write!(
                formatter,
                "impl_map schema version {} is not supported (this build supports {})",
                redact_for_diagnostic(declared),
                supported,
            ),
            Self::PortIdMalformed { id } => write!(
                formatter,
                "port id is malformed: {}",
                redact_for_diagnostic(id),
            ),
            Self::EngineFamilyOtherWithoutNotes => formatter
                .write_str("engine_family=other requires a non-empty engineFamilyNotes field"),
            Self::NoSubsystemsDeclared => formatter
                .write_str("implementation map declares no subsystems (must declare at least one)"),
            Self::NoValidationCommandsDeclared => formatter.write_str(
                "implementation map declares no validation commands (must declare at least one)",
            ),
            Self::DuplicateSubsystemId { id } => write!(
                formatter,
                "duplicate subsystem id: {}",
                redact_for_diagnostic(id.as_str()),
            ),
            Self::DuplicateValidationCommandId { id } => write!(
                formatter,
                "duplicate validation command id: {}",
                redact_for_diagnostic(id.as_str()),
            ),
            Self::OrphanValidationCommandRef {
                subsystem_id,
                validation_command_id,
            } => write!(
                formatter,
                "subsystem {} references unknown validation command id {}",
                redact_for_diagnostic(subsystem_id.as_str()),
                redact_for_diagnostic(validation_command_id.as_str()),
            ),
            Self::OrphanValidationCommand { id } => write!(
                formatter,
                "validation command id {} is not referenced by any subsystem",
                redact_for_diagnostic(id.as_str()),
            ),
            Self::MissingFixtureProvenance {
                subsystem_id,
                field,
            } => write!(
                formatter,
                "subsystem {} fixture provenance field {} is missing or sentinel-shaped",
                redact_for_diagnostic(subsystem_id.as_str()),
                field.as_str(),
            ),
            Self::FixtureHashMalformed { subsystem_id, raw } => write!(
                formatter,
                "subsystem {} fixture hash is malformed: {}",
                redact_for_diagnostic(subsystem_id.as_str()),
                redact_for_diagnostic(raw),
            ),
            Self::FixtureByteCountZero { subsystem_id } => write!(
                formatter,
                "subsystem {} fixture byte_count is zero",
                redact_for_diagnostic(subsystem_id.as_str()),
            ),
            Self::FixtureKindOtherWithoutNotes { subsystem_id } => write!(
                formatter,
                "subsystem {} fixture kind=other requires non-empty kindNotes",
                redact_for_diagnostic(subsystem_id.as_str()),
            ),
            Self::SyntheticInlineMismatch { subsystem_id } => write!(
                formatter,
                "subsystem {} synthetic-inline classification requires kind=SyntheticInline",
                redact_for_diagnostic(subsystem_id.as_str()),
            ),
            Self::EmptyCapabilityList { subsystem_id } => write!(
                formatter,
                "subsystem {} capability list is empty",
                redact_for_diagnostic(subsystem_id.as_str()),
            ),
            Self::PartialWithoutLimitations { subsystem_id } => write!(
                formatter,
                "subsystem {} status=Partial requires at least one non-empty limitation",
                redact_for_diagnostic(subsystem_id.as_str()),
            ),
            Self::UnsupportedReasonNotSemantic { subsystem_id, raw } => write!(
                formatter,
                "subsystem {} status=Unsupported reason is neither a semantic code nor a deferred-to sentinel: {}",
                redact_for_diagnostic(subsystem_id.as_str()),
                redact_for_diagnostic(raw),
            ),
            Self::ResearchEvidenceMissing { subsystem_id } => write!(
                formatter,
                "subsystem {} status=Research requires at least one evidence_ref",
                redact_for_diagnostic(subsystem_id.as_str()),
            ),
            Self::ResearchEvidenceCaptionEmpty {
                subsystem_id,
                index,
            } => write!(
                formatter,
                "subsystem {} evidence_ref[{}] caption is empty",
                redact_for_diagnostic(subsystem_id.as_str()),
                index,
            ),
            Self::ResearchEvidenceLocatorMalformed {
                subsystem_id,
                index,
                kind,
            } => write!(
                formatter,
                "subsystem {} evidence_ref[{}] locator does not match its kind ({}) shape",
                redact_for_diagnostic(subsystem_id.as_str()),
                index,
                evidence_kind_label(*kind),
            ),
            Self::ValidationCommandEmpty { id } => write!(
                formatter,
                "validation command {} has an empty command string",
                redact_for_diagnostic(id.as_str()),
            ),
            Self::ValidationCommandUnsafeShape {
                id,
                offending_token,
            } => write!(
                formatter,
                "validation command {} contains shell-unsafe token: {}",
                redact_for_diagnostic(id.as_str()),
                redact_for_diagnostic(offending_token),
            ),
            Self::ValidationCommandPrefixUnknown { id, prefix } => write!(
                formatter,
                "validation command {} uses unknown prefix {} (allowed: cargo, just, node, pnpm)",
                redact_for_diagnostic(id.as_str()),
                redact_for_diagnostic(prefix),
            ),
            Self::ValidationCommandCaptionEmpty { id } => write!(
                formatter,
                "validation command {} caption is empty",
                redact_for_diagnostic(id.as_str()),
            ),
            Self::SkipReasonNotSemantic { id, raw } => write!(
                formatter,
                "validation command {} skip reason is not a semantic code: {}",
                redact_for_diagnostic(id.as_str()),
                redact_for_diagnostic(raw),
            ),
            Self::FailSemanticCodeMalformed { id, raw } => write!(
                formatter,
                "validation command {} fail semantic code is malformed: {}",
                redact_for_diagnostic(id.as_str()),
                redact_for_diagnostic(raw),
            ),
            Self::ReferenceBehaviorMissing { field } => write!(
                formatter,
                "referenceBehavior field {} is empty",
                field.as_str(),
            ),
            Self::GeneratedAtNotRfc3339 { raw } => write!(
                formatter,
                "generatedAt is not a valid RFC 3339 timestamp: {}",
                redact_for_diagnostic(raw),
            ),
        }
    }
}

impl std::error::Error for ImplMapError {}

// ---------------------------------------------------------------------------
// Cross-validation against PortManifest (helper surface).
// ---------------------------------------------------------------------------

/// Diagnostics for the optional `validate_against_manifest` helper.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImplMapManifestMismatch {
    /// `map.port_id` differs from `manifest.id`.
    PortIdMismatch {
        map_port_id: String,
        manifest_id: String,
    },
    /// A subsystem claims a capability tag matching a known
    /// `PortCapability::as_str()` value but the manifest does not
    /// declare that capability.
    CapabilityAbsentFromManifest {
        subsystem_id: SubsystemId,
        capability: String,
    },
    /// `map.engine_family`'s expected prefix does not match `manifest.id`.
    EngineFamilyManifestIdMismatch {
        engine_family: String,
        manifest_id: String,
    },
}

impl fmt::Display for ImplMapManifestMismatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PortIdMismatch {
                map_port_id,
                manifest_id,
            } => write!(
                formatter,
                "port id mismatch: map={}, manifest={}",
                redact_for_diagnostic(map_port_id),
                redact_for_diagnostic(manifest_id),
            ),
            Self::CapabilityAbsentFromManifest {
                subsystem_id,
                capability,
            } => write!(
                formatter,
                "subsystem {} claims capability {} not declared in the port manifest",
                redact_for_diagnostic(subsystem_id.as_str()),
                redact_for_diagnostic(capability),
            ),
            Self::EngineFamilyManifestIdMismatch {
                engine_family,
                manifest_id,
            } => write!(
                formatter,
                "engine family {} does not match manifest id prefix {}",
                redact_for_diagnostic(engine_family),
                redact_for_diagnostic(manifest_id),
            ),
        }
    }
}

impl std::error::Error for ImplMapManifestMismatch {}

// ---------------------------------------------------------------------------
// verify_fixture_hashes helper diagnostics.
// ---------------------------------------------------------------------------

/// One mismatch discovered by [`super::verify_fixture_hashes`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FixtureHashMismatch {
    pub fixture_id: String,
    pub declared_hash: String,
    pub observed_hash: String,
}

impl fmt::Display for FixtureHashMismatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "fixture {} hash mismatch: declared={}, observed={}",
            redact_for_diagnostic(&self.fixture_id),
            redact_for_diagnostic(&self.declared_hash),
            redact_for_diagnostic(&self.observed_hash),
        )
    }
}

impl std::error::Error for FixtureHashMismatch {}
