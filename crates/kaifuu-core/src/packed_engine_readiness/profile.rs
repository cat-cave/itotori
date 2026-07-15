use serde::{Deserialize, Serialize};

use crate::{
    CapabilityLevel, CodecTransform, ContainerTransform, CryptoTransform, KaifuuResult,
    LayeredAccessHelperStatus, LayeredAccessKeyMaterialStatus, OperationStatus,
    PartialDiagnosticSeverity, PatchBackTransform, ProofHash, SecretRef, SurfaceTransform,
    redact_for_log_or_report, sha256_hash_bytes, stable_json,
};

use super::{EngineProfileSpec, PackedEngineFamily, is_media_codec};

mod validator;
pub use validator::{
    validate_packed_engine_readiness_dir, validate_packed_engine_readiness_profile,
};

#[cfg(test)]
mod tests;

// Profile input schema

/// A reusable packed-engine readiness profile fixture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackedEngineReadinessProfile {
    pub schema_version: String,
    /// Stable profile id (synthetic; no retail names or local paths).
    pub profile_id: String,
    /// Stable fixture id this profile is derived from.
    pub fixture_id: String,
    /// The spec-DAG node id this profile is authored for (e.g. ``).
    pub source_node_id: String,
    pub engine_family: PackedEngineFamily,
    pub container: ContainerTransform,
    pub crypto: CryptoTransform,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    pub patch_back: PatchBackTransform,
    /// The capability posture this profile declares it is ready for.
    pub declared_capability: CapabilityLevel,
    pub key: PackedKeyRequirement,
    pub helper: PackedHelperRequirement,
    /// Synthetic packed-asset content descriptors (hash-only, never bytes).
    pub content: Vec<PackedContentEntry>,
    /// Declared content hash over the canonical serialization of `content`.
    /// The validator recomputes and compares.
    pub content_hash: ProofHash,
}

/// Key-material gating for the profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackedKeyRequirement {
    pub status: LayeredAccessKeyMaterialStatus,
    /// Local-scheme reference to the key material (never raw key bytes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_ref: Option<SecretRef>,
    /// Stable id of the key requirement (cross-references helper evidence).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requirement_id: Option<String>,
}

/// Helper gating for the profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackedHelperRequirement {
    pub status: LayeredAccessHelperStatus,
    /// Stable id of the helper (never a local path / binary).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_id: Option<String>,
}

/// One synthetic packed-asset content descriptor.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackedContentEntry {
    pub asset_id: String,
    pub byte_count: u64,
    pub content_sha256: ProofHash,
}

/// Recompute the canonical content hash over `content` (sorted by `assetId`).
/// Deterministic and pure; no disk access.
pub fn recompute_content_hash(content: &[PackedContentEntry]) -> KaifuuResult<ProofHash> {
    let mut sorted = content.to_vec();
    sorted.sort();
    let canonical = stable_json(&sorted)?;
    ProofHash::new(sha256_hash_bytes(canonical.as_bytes())).map_err(Into::into)
}

// Outcome + posture (the mechanical line)

/// The mechanically-derived outcome of a packed-engine readiness profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackedReadinessOutcome {
    /// Profile-ready postures (gates clear).
    Identify,
    Inventory,
    Extract,
    Patch,
    /// Readiness-only postures (gated).
    HelperRequired,
    MissingKey,
    UnsupportedLayeredTransform,
}

impl PackedReadinessOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Identify => "identify",
            Self::Inventory => "inventory",
            Self::Extract => "extract",
            Self::Patch => "patch",
            Self::HelperRequired => "helper_required",
            Self::MissingKey => "missing_key",
            Self::UnsupportedLayeredTransform => "unsupported_layered_transform",
        }
    }

    /// THE mechanical gate: a profile-ready outcome is one of the four
    /// capability rungs; every readiness-only outcome returns `false` and can
    /// therefore never present a resolved extract/patch capability.
    pub fn is_profile_ready(self) -> bool {
        matches!(
            self,
            Self::Identify | Self::Inventory | Self::Extract | Self::Patch
        )
    }

    /// The posture bucket for this outcome.
    pub fn posture(self) -> PackedReadinessPosture {
        if self.is_profile_ready() {
            PackedReadinessPosture::ProfileReady
        } else {
            PackedReadinessPosture::ReadinessOnly
        }
    }
}

/// The two mechanically-distinct postures (mirrors ALPHA-004's claimed-vs-
/// readiness distinction).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackedReadinessPosture {
    ProfileReady,
    ReadinessOnly,
}

impl PackedReadinessPosture {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProfileReady => "profile_ready",
            Self::ReadinessOnly => "readiness_only",
        }
    }
}

/// THE single source of truth for the profile-ready-vs-readiness-only line.
/// A profile resolves to a capability rung (`identify`/`inventory`/`extract`/
/// `patch`, capped at the engine ceiling) **if and only if** the layered
/// transform is supported (no media-asset transform), the key material is
/// resolved (or not required), and the helper is available (or not required).
/// Any media transform, missing/helper-gated key, or unavailable helper
/// collapses to the corresponding readiness-only outcome. Total and
/// side-effect-free.
pub fn derive_packed_readiness_outcome(
    spec: &EngineProfileSpec,
    declared_capability: CapabilityLevel,
    codec: CodecTransform,
    key_status: LayeredAccessKeyMaterialStatus,
    helper_status: LayeredAccessHelperStatus,
) -> PackedReadinessOutcome {
    if spec.media_transform || is_media_codec(codec) {
        return PackedReadinessOutcome::UnsupportedLayeredTransform;
    }
    match key_status {
        LayeredAccessKeyMaterialStatus::Missing => return PackedReadinessOutcome::MissingKey,
        LayeredAccessKeyMaterialStatus::HelperGated => {
            return PackedReadinessOutcome::HelperRequired;
        }
        LayeredAccessKeyMaterialStatus::Resolved | LayeredAccessKeyMaterialStatus::NotRequired => {}
    }
    if helper_status == LayeredAccessHelperStatus::Unavailable {
        return PackedReadinessOutcome::HelperRequired;
    }
    // Gates clear: resolve to the declared rung, capped at the engine ceiling.
    let level = declared_capability.min(spec.capability_ceiling);
    match level {
        CapabilityLevel::Identify => PackedReadinessOutcome::Identify,
        CapabilityLevel::Inventory => PackedReadinessOutcome::Inventory,
        CapabilityLevel::Extract => PackedReadinessOutcome::Extract,
        CapabilityLevel::Patch => PackedReadinessOutcome::Patch,
    }
}

// Findings + report

/// A structured validation finding — never prose, never silent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedReadinessFinding {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    pub semantic_code: String,
}

impl PackedReadinessFinding {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code.clone(),
        }
    }
}

/// The shared transform stack as recorded in the report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedTransformStack {
    pub container: ContainerTransform,
    pub crypto: CryptoTransform,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    pub patch_back: PatchBackTransform,
}

/// Per-profile report entry. Carries the full acceptance tuple: profile id,
/// fixture id, capability levels, helper id, key ref, diagnostics, and hashes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedReadinessEntryReport {
    pub profile_id: String,
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: PackedEngineFamily,
    pub transform_stack: PackedTransformStack,
    pub declared_capability: CapabilityLevel,
    /// Mechanically-derived outcome (the single source of truth).
    pub effective_outcome: PackedReadinessOutcome,
    /// The mechanically-distinct posture bucket.
    pub posture: PackedReadinessPosture,
    pub key_status: LayeredAccessKeyMaterialStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_ref: Option<SecretRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_requirement_id: Option<String>,
    pub helper_status: LayeredAccessHelperStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_id: Option<String>,
    pub content_hash: ProofHash,
    pub content_entry_count: u64,
    pub status: OperationStatus,
    pub findings: Vec<PackedReadinessFinding>,
}

impl PackedReadinessEntryReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            profile_id: redact_for_log_or_report(&self.profile_id),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: self.engine_family,
            transform_stack: self.transform_stack,
            declared_capability: self.declared_capability,
            effective_outcome: self.effective_outcome,
            posture: self.posture,
            key_status: self.key_status,
            key_ref: self.key_ref.clone(),
            key_requirement_id: self
                .key_requirement_id
                .as_deref()
                .map(redact_for_log_or_report),
            helper_status: self.helper_status,
            helper_id: self.helper_id.as_deref().map(redact_for_log_or_report),
            content_hash: self.content_hash.clone(),
            content_entry_count: self.content_entry_count,
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(PackedReadinessFinding::redacted_for_report)
                .collect(),
        }
    }
}

/// The aggregate validation report written to
/// `target/kaifuu/packed-readiness-validation.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedReadinessValidationReport {
    pub schema_version: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub profile_count: u64,
    pub profile_ready_count: u64,
    pub readiness_only_count: u64,
    pub entries: Vec<PackedReadinessEntryReport>,
}

impl PackedReadinessValidationReport {
    pub fn entry(&self, profile_id: &str) -> Option<&PackedReadinessEntryReport> {
        self.entries
            .iter()
            .find(|entry| entry.profile_id == profile_id)
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            profile_count: self.profile_count,
            profile_ready_count: self.profile_ready_count,
            readiness_only_count: self.readiness_only_count,
            entries: self
                .entries
                .iter()
                .map(PackedReadinessEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}
