//! Wolf adapter report and diagnostic model.

use super::*;

// Report (generated) schema

/// The outcome the adapter mechanically reaches: a full extract+patch round-trip
/// (`supported`) or an unsupported variant carrying a semantic diagnostic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WolfAdapterOutcome {
    /// The gate cleared (`protected` + `key_resolved`); the round-trip ran.
    Supported,
    /// An unsupported protection/key posture; extract/patch were refused.
    Unsupported,
}

/// The layered transform legs the adapter drove (identify → patch-back).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfAdapterTransformLegs {
    pub container: ContainerTransform,
    pub crypto: CryptoTransform,
    pub crypto_profile: WolfEncryptedCryptoProfile,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    pub patch_back: PatchBackTransform,
}

impl WolfAdapterTransformLegs {
    pub(super) fn canonical() -> Self {
        Self {
            container: ContainerTransform::WolfArchive,
            crypto: CryptoTransform::FixedKey,
            crypto_profile: WolfEncryptedCryptoProfile::XorFixture,
            codec: CodecTransform::ShiftJisText,
            surface: SurfaceTransform::TableRecord,
            patch_back: PatchBackTransform::RepackArchive,
        }
    }
}

/// One extracted text table digest (counts + hash; never the decoded text).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfAdapterTableDigest {
    pub table_name: String,
    pub record_count: u32,
    pub field_count: u32,
    pub text_cell_count: u32,
    /// sha256 of the decrypted binary table member (never the text).
    pub member_hash: ProofHash,
    pub member_byte_len: u64,
}

impl WolfAdapterTableDigest {
    pub(super) fn redacted_for_report(&self) -> Self {
        Self {
            table_name: redact_for_log_or_report(&self.table_name),
            ..self.clone()
        }
    }
}

/// One patched-cell coordinate (indices only — never the text).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfAdapterPatchCoordinate {
    pub record_index: u32,
    pub field_index: u32,
}

/// A deterministic per-table patch report: byte-length + hash before/after, plus
/// whether the string-table offset index was rewritten by the patch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfAdapterTablePatchReport {
    pub table_name: String,
    pub coordinates: Vec<WolfAdapterPatchCoordinate>,
    pub source_member_hash: ProofHash,
    pub patched_member_hash: ProofHash,
    pub source_member_byte_len: u64,
    pub patched_member_byte_len: u64,
    /// True iff the patch REWROTE the string-table offset index — the per-cell
    /// `(offset,len)` table differs after repack (a downstream offset shifted or
    /// a cell length changed). A same-length in-place edit leaves the layout
    /// untouched and keeps this false, even though the member bytes differ (which
    /// is proven separately by `source_member_hash`!= `patched_member_hash`).
    pub layout_changed: bool,
    /// True iff every patched cell decoded to its requested text after repack.
    pub patched_text_verified: bool,
}

impl WolfAdapterTablePatchReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            table_name: redact_for_log_or_report(&self.table_name),
            ..self.clone()
        }
    }
}

/// A semantic capability diagnostic for an unsupported variant, carrying the
/// claimed-support tuple context (acceptance criterion 4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfAdapterCapabilityDiagnostic {
    pub semantic_code: String,
    pub field: String,
    pub message: String,
    /// The claimed-support tuple context (what the adapter can/can't claim here).
    pub claimed_support: WolfCapabilityTuple,
}

impl WolfAdapterCapabilityDiagnostic {
    fn redacted_for_report(&self) -> Self {
        Self {
            semantic_code: self.semantic_code.clone(),
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            claimed_support: self.claimed_support.clone(),
        }
    }
}

/// The full adapter report. Serialize through [`WolfTextTableAdapterReport::stable_json`]
/// for redaction discipline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfTextTableAdapterReport {
    pub schema_version: String,
    pub capability_id: String,
    pub source_node_id: String,
    pub support_boundary: String,
    /// The smoke evidence this encrypted variant cites.
    pub cited_smoke_capability_id: String,
    pub fixture_id: String,
    pub engine_family: String,
    pub outcome: WolfAdapterOutcome,
    pub protection_profile: WolfProtectionProfile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_outcome: Option<WolfHelperBoundaryOutcome>,
    /// The claimed-support tuple context (present for every outcome).
    pub claimed_support: WolfCapabilityTuple,
    pub transform_legs: WolfAdapterTransformLegs,
    pub secret_requirement_id: String,
    pub secret_ref: SecretRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_material_hash: Option<ProofHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_bytes: Option<u32>,
    pub key_material_kind: KeyMaterialKind,
    pub redaction_status: HelperRedactionStatus,
    /// Present only for a supported round-trip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_archive_hash: Option<ProofHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rebuilt_archive_hash: Option<ProofHash>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extract_manifest: Vec<WolfAdapterTableDigest>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub patch_reports: Vec<WolfAdapterTablePatchReport>,
    /// Number of unchanged tables verified byte-identical after repack.
    pub unchanged_tables_verified: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify_proof: Option<KeyValidationProof>,
    /// The semantic capability diagnostics (present for an unsupported variant).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capability_diagnostics: Vec<WolfAdapterCapabilityDiagnostic>,
    pub delta_package_id: String,
    pub status: OperationStatus,
}

impl WolfTextTableAdapterReport {
    pub(super) fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            capability_id: redact_for_log_or_report(&self.capability_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            cited_smoke_capability_id: redact_for_log_or_report(&self.cited_smoke_capability_id),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            outcome: self.outcome,
            protection_profile: self.protection_profile,
            helper_outcome: self.helper_outcome,
            claimed_support: self.claimed_support.clone(),
            transform_legs: self.transform_legs.clone(),
            secret_requirement_id: redact_for_log_or_report(&self.secret_requirement_id),
            secret_ref: self.secret_ref.clone(),
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            key_material_kind: self.key_material_kind,
            redaction_status: self.redaction_status,
            source_archive_hash: self.source_archive_hash.clone(),
            rebuilt_archive_hash: self.rebuilt_archive_hash.clone(),
            extract_manifest: self
                .extract_manifest
                .iter()
                .map(WolfAdapterTableDigest::redacted_for_report)
                .collect(),
            patch_reports: self
                .patch_reports
                .iter()
                .map(WolfAdapterTablePatchReport::redacted_for_report)
                .collect(),
            unchanged_tables_verified: self.unchanged_tables_verified,
            verify_proof: self.verify_proof.clone(),
            capability_diagnostics: self
                .capability_diagnostics
                .iter()
                .map(WolfAdapterCapabilityDiagnostic::redacted_for_report)
                .collect(),
            delta_package_id: redact_for_log_or_report(&self.delta_package_id),
            status: self.status.clone(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}
