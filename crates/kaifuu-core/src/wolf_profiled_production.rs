//! KAIFUU-058 - profiled Wolf encrypted archive extract + patch.
//!
//! This module composes the existing Wolf pieces into a data-driven profiled
//! archive/protection-key workflow:
//!
//! - container + crypto: KAIFUU-073 [`crate::wolf_encrypted_smoke`]
//!   pack/decrypt using [`crate::wolf_encrypted_smoke::WolfEncryptedArchiveKey`]
//!   (zeroize-on-drop, `Debug` redacted);
//! - text surface: KAIFUU-012 [`crate::wolf_adapter`] Shift-JIS text-table
//!   codec and patch coordinates; and
//! - key/helper evidence: a concrete [`SecretRef`] and, for helper-gated
//!   profiles, a KAIFUU-085 [`crate::HelperResult`] bound to that EXACT ref.
//!
//! A claimed profile that cannot extract + patch is a compatibility BUG:
//! [`WolfProfiledProductionError::ClaimedProfileFailed`]. Unclaimed profiles are
//! explicit out-of-scope rows. All fixtures are synthetic.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::wolf_adapter::{
    WolfAdapterError, WolfAdapterPatchCoordinate, WolfTextPatchRequest, WolfTextTable,
    decode_wolf_text_table, encode_wolf_text_table,
};
use crate::wolf_encrypted_smoke::{
    WOLF_ENCRYPTED_SMOKE_CAPABILITY_ID, WolfEncryptedCryptoProfile,
    WolfEncryptedFixtureSecretResolver, WolfEncryptedSmokeError, WolfPlainMember,
    decrypt_archive_members, pack_encrypted_archive,
};
use crate::wolf_helper_boundary::WolfHelperBoundaryKind;
use crate::wolf_protection_detector::{WOLF_ENGINE_FAMILY, WolfProtectionProfile};
use crate::{
    HELPER_RESULT_SCHEMA_VERSION, HelperCapabilityLevel, HelperDiagnostic, HelperDiagnosticCode,
    HelperExecutionFilesystemAccess, HelperExecutionSummary, HelperProvenance, HelperRedaction,
    HelperRedactionStatus, HelperResult, HelperResultSecretRef, KaifuuResult, KeyMaterialKind,
    KeyValidationMethod, KeyValidationProof, OperationStatus, ProofHash, SecretRef,
    deterministic_id, redact_for_log_or_report, sha256_hash_bytes, stable_json,
};

pub const WOLF_PROFILED_PRODUCTION_MARKER: &str = "kaifuu.wolf.profiled_production";
pub const WOLF_PROFILED_PRODUCTION_SCHEMA_VERSION: &str = "0.1.0";
pub const WOLF_PROFILED_PRODUCTION_CAPABILITY_ID: &str =
    "kaifuu-wolf-profiled-encrypted-archive-production";
pub const WOLF_PROFILED_PRODUCTION_CONTAINER: &str = "wolf-like-encrypted-archive";
pub const WOLF_PROFILED_PRODUCTION_SUPPORT_BOUNDARY: &str = "Kaifuu Wolf profiled encrypted-archive production extract+patch drives PROFILED archive/protection-key workflows on SYNTHETIC Wolf-like encrypted archive fixtures. A variant is DATA: declared protection profile + crypto profile + text-table surfaces + required key/helper evidence (a SecretRef, never raw key material, and an exact-ref-bound KAIFUU-085 helper result when helper-gated). A claimed profile must extract text-bearing data and patch it back through the same protection/container; claimed failures are loud typed compatibility bugs, never silent skips. Keys remain inside module-private zeroize-on-drop Debug-redacting holders and reports carry refs, hashes, and counts only. This is not commercial Wolf/DXArchive coverage.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WolfProfiledHelperWorkflow {
    DirectLocalKey,
    StaticKeyImport,
    DynamicKeyHelper,
}

impl WolfProfiledHelperWorkflow {
    fn as_str(self) -> &'static str {
        match self {
            Self::DirectLocalKey => "direct-local-key",
            Self::StaticKeyImport => "static-key-import",
            Self::DynamicKeyHelper => "dynamic-key-helper",
        }
    }

    fn requires_helper(self) -> bool {
        !matches!(self, Self::DirectLocalKey)
    }

    fn minimum_capability(self) -> HelperCapabilityLevel {
        match self {
            Self::DirectLocalKey | Self::StaticKeyImport => HelperCapabilityLevel::LocalKeyImport,
            Self::DynamicKeyHelper => HelperCapabilityLevel::WineLocal,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WolfProfiledProductionStage {
    EvidenceCheck,
    KeyResolve,
    Extract,
    Identity,
    Patch,
    Verify,
}

impl WolfProfiledProductionStage {
    fn as_str(self) -> &'static str {
        match self {
            Self::EvidenceCheck => "evidence-check",
            Self::KeyResolve => "key-resolve",
            Self::Extract => "extract",
            Self::Identity => "identity",
            Self::Patch => "patch",
            Self::Verify => "verify",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WolfProfiledProductionError {
    ClaimedProfileFailed {
        variant_id: String,
        stage: &'static str,
        cause: String,
    },
    Internal {
        message: String,
    },
}

impl WolfProfiledProductionError {
    fn claimed(
        variant_id: &str,
        stage: WolfProfiledProductionStage,
        cause: impl fmt::Display,
    ) -> Self {
        Self::ClaimedProfileFailed {
            variant_id: variant_id.to_string(),
            stage: stage.as_str(),
            cause: redact_for_log_or_report(&cause.to_string()),
        }
    }
}

impl fmt::Display for WolfProfiledProductionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ClaimedProfileFailed {
                variant_id,
                stage,
                cause,
            } => write!(
                formatter,
                "{WOLF_PROFILED_PRODUCTION_MARKER}.claimed_profile_failed: claimed profile {} failed at stage {stage}: {}",
                redact_for_log_or_report(variant_id),
                redact_for_log_or_report(cause)
            ),
            Self::Internal { message } => write!(
                formatter,
                "{WOLF_PROFILED_PRODUCTION_MARKER}.internal: {}",
                redact_for_log_or_report(message)
            ),
        }
    }
}

impl std::error::Error for WolfProfiledProductionError {}

impl From<WolfEncryptedSmokeError> for WolfProfiledProductionError {
    fn from(error: WolfEncryptedSmokeError) -> Self {
        Self::Internal {
            message: error.to_string(),
        }
    }
}

impl From<WolfAdapterError> for WolfProfiledProductionError {
    fn from(error: WolfAdapterError) -> Self {
        Self::Internal {
            message: error.to_string(),
        }
    }
}

/// One profiled Wolf archive/protection-key variant. This is public DATA and
/// intentionally carries no raw key bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WolfProfiledProductionVariant {
    pub variant_id: String,
    pub protection_profile: WolfProtectionProfile,
    pub crypto_profile: WolfEncryptedCryptoProfile,
    pub helper_workflow: WolfProfiledHelperWorkflow,
    pub secret_requirement_id: String,
    pub secret_ref: SecretRef,
    pub helper_evidence: Option<HelperResult>,
    pub tables: Vec<WolfTextTable>,
    pub patches: Vec<WolfTextPatchRequest>,
    pub claimed: bool,
}

impl WolfProfiledProductionVariant {
    fn expected_member_ids(&self) -> Vec<String> {
        self.tables
            .iter()
            .map(|table| table_member_id(&table.table_name))
            .collect()
    }
}

/// Build a resolver from `(secret_ref, fixture label)` entries.
///
/// The raw key material is derived from each label and minted into a
/// zeroize-on-drop holder ONLY inside the owning `wolf_encrypted_smoke` module,
/// through the controlled [`WolfEncryptedFixtureSecretResolver::from_entries`]
/// construction entry. This module never touches the raw-key holder constructor
/// directly, so the "keys are only minted via the resolve path" invariant holds
/// crate-wide (mirrors the KAIFUU-057 `Xp3CryptKey` boundary).
fn resolver_from_fixture_labels(
    entries: Vec<(String, &'static str)>,
) -> WolfEncryptedFixtureSecretResolver {
    WolfEncryptedFixtureSecretResolver::from_entries(
        entries
            .into_iter()
            .map(|(secret_ref, label)| (secret_ref, fixture_key_material(label)))
            .collect(),
    )
}

/// Profiled variant registry. Raw fixture key material is held only in private
/// redacting resolvers.
pub struct WolfProfiledProductionRegistry {
    pub registry_id: String,
    pub variants: Vec<WolfProfiledProductionVariant>,
    archive_keys: WolfEncryptedFixtureSecretResolver,
    resolved_keys: WolfEncryptedFixtureSecretResolver,
}

impl fmt::Debug for WolfProfiledProductionRegistry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WolfProfiledProductionRegistry")
            .field("registry_id", &self.registry_id)
            .field("variants", &self.variants)
            .field("archive_keys", &self.archive_keys)
            .field("resolved_keys", &self.resolved_keys)
            .finish()
    }
}

impl WolfProfiledProductionRegistry {
    /// True iff any raw key material held by this registry's module-private
    /// resolvers appears verbatim in `haystack`. Backs the runtime no-leak guard
    /// for downstream composers (KAIFUU-145 smoke) without ever handing the raw
    /// bytes out — the check stays inside the owning resolver boundary.
    pub fn archive_keys_leak_into(&self, haystack: &[u8]) -> bool {
        self.archive_keys.any_key_appears_in(haystack)
            || self.resolved_keys.any_key_appears_in(haystack)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WolfProfiledMemberOperation {
    Replace,
    Unchanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfProfiledMemberDelta {
    pub member_id: String,
    pub operation: WolfProfiledMemberOperation,
    pub source_plaintext_hash: ProofHash,
    pub target_plaintext_hash: ProofHash,
    pub length_delta: i64,
}

impl WolfProfiledMemberDelta {
    fn redacted_for_report(&self) -> Self {
        Self {
            member_id: redact_for_log_or_report(&self.member_id),
            operation: self.operation,
            source_plaintext_hash: self.source_plaintext_hash.clone(),
            target_plaintext_hash: self.target_plaintext_hash.clone(),
            length_delta: self.length_delta,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfProfiledPatchReport {
    pub table_name: String,
    pub coordinates: Vec<WolfAdapterPatchCoordinate>,
    pub source_member_hash: ProofHash,
    pub patched_member_hash: ProofHash,
    pub patched_text_verified: bool,
    pub old_text_absent: bool,
}

impl WolfProfiledPatchReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            table_name: redact_for_log_or_report(&self.table_name),
            coordinates: self.coordinates.clone(),
            source_member_hash: self.source_member_hash.clone(),
            patched_member_hash: self.patched_member_hash.clone(),
            patched_text_verified: self.patched_text_verified,
            old_text_absent: self.old_text_absent,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfProfiledVariantReport {
    pub variant_id: String,
    pub protection_profile: WolfProtectionProfile,
    pub crypto_profile: WolfEncryptedCryptoProfile,
    pub helper_workflow: WolfProfiledHelperWorkflow,
    pub secret_requirement_id: String,
    pub secret_ref: SecretRef,
    pub helper_evidence_present: bool,
    pub key_material_kind: KeyMaterialKind,
    pub key_material_hash: ProofHash,
    pub key_bytes: u32,
    pub source_archive_hash: ProofHash,
    pub rebuilt_archive_hash: ProofHash,
    pub identity_byte_identical: bool,
    pub members_total: u32,
    pub members_patched: u32,
    pub members_byte_preserved: u32,
    pub member_deltas: Vec<WolfProfiledMemberDelta>,
    pub patch_reports: Vec<WolfProfiledPatchReport>,
    pub round_trip_proof: KeyValidationProof,
    pub status: OperationStatus,
}

impl WolfProfiledVariantReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            variant_id: redact_for_log_or_report(&self.variant_id),
            protection_profile: self.protection_profile,
            crypto_profile: self.crypto_profile,
            helper_workflow: self.helper_workflow,
            secret_requirement_id: redact_for_log_or_report(&self.secret_requirement_id),
            secret_ref: self.secret_ref.clone(),
            helper_evidence_present: self.helper_evidence_present,
            key_material_kind: self.key_material_kind,
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            source_archive_hash: self.source_archive_hash.clone(),
            rebuilt_archive_hash: self.rebuilt_archive_hash.clone(),
            identity_byte_identical: self.identity_byte_identical,
            members_total: self.members_total,
            members_patched: self.members_patched,
            members_byte_preserved: self.members_byte_preserved,
            member_deltas: self
                .member_deltas
                .iter()
                .map(WolfProfiledMemberDelta::redacted_for_report)
                .collect(),
            patch_reports: self
                .patch_reports
                .iter()
                .map(WolfProfiledPatchReport::redacted_for_report)
                .collect(),
            round_trip_proof: self.round_trip_proof.clone(),
            status: self.status.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfProfiledNotClaimedReport {
    pub variant_id: String,
    pub protection_profile: WolfProtectionProfile,
    pub crypto_profile: WolfEncryptedCryptoProfile,
    pub helper_workflow: WolfProfiledHelperWorkflow,
    pub reason: String,
}

impl WolfProfiledNotClaimedReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            variant_id: redact_for_log_or_report(&self.variant_id),
            protection_profile: self.protection_profile,
            crypto_profile: self.crypto_profile,
            helper_workflow: self.helper_workflow,
            reason: redact_for_log_or_report(&self.reason),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum WolfProfiledOutcome {
    Claimed(WolfProfiledVariantReport),
    NotClaimed(WolfProfiledNotClaimedReport),
}

impl WolfProfiledOutcome {
    fn redacted_for_report(&self) -> Self {
        match self {
            Self::Claimed(report) => Self::Claimed(report.redacted_for_report()),
            Self::NotClaimed(report) => Self::NotClaimed(report.redacted_for_report()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfProfiledProductionReport {
    pub schema_version: String,
    pub capability_id: String,
    pub cited_smoke_capability_id: String,
    pub source_node_id: String,
    pub support_boundary: String,
    pub registry_id: String,
    pub engine_family: String,
    pub container: String,
    pub redaction_status: HelperRedactionStatus,
    pub claimed_profiles: Vec<WolfProtectionProfile>,
    pub claimed_count: u32,
    pub not_claimed_count: u32,
    pub outcomes: Vec<WolfProfiledOutcome>,
    pub status: OperationStatus,
}

impl WolfProfiledProductionReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            capability_id: redact_for_log_or_report(&self.capability_id),
            cited_smoke_capability_id: redact_for_log_or_report(&self.cited_smoke_capability_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            registry_id: redact_for_log_or_report(&self.registry_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            container: redact_for_log_or_report(&self.container),
            redaction_status: self.redaction_status,
            claimed_profiles: self.claimed_profiles.clone(),
            claimed_count: self.claimed_count,
            not_claimed_count: self.not_claimed_count,
            outcomes: self
                .outcomes
                .iter()
                .map(WolfProfiledOutcome::redacted_for_report)
                .collect(),
            status: self.status.clone(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }

    pub fn is_ok(&self) -> bool {
        self.status == OperationStatus::Passed
    }
}

pub fn run_wolf_profiled_production(
    registry: &WolfProfiledProductionRegistry,
    source_node_id: &str,
) -> Result<WolfProfiledProductionReport, WolfProfiledProductionError> {
    let mut outcomes = Vec::with_capacity(registry.variants.len());
    let mut claimed_profiles = Vec::new();
    let mut claimed_count = 0u32;
    let mut not_claimed_count = 0u32;

    for variant in &registry.variants {
        if !variant.claimed {
            not_claimed_count += 1;
            outcomes.push(WolfProfiledOutcome::NotClaimed(
                WolfProfiledNotClaimedReport {
                    variant_id: variant.variant_id.clone(),
                    protection_profile: variant.protection_profile,
                    crypto_profile: variant.crypto_profile,
                    helper_workflow: variant.helper_workflow,
                    reason:
                        "profile is not claimed (out of scope beyond the bounded synthetic evidence)"
                            .to_string(),
                },
            ));
            continue;
        }

        let report = run_claimed_variant(registry, variant)?;
        if !claimed_profiles.contains(&variant.protection_profile) {
            claimed_profiles.push(variant.protection_profile);
        }
        claimed_count += 1;
        outcomes.push(WolfProfiledOutcome::Claimed(report));
    }

    let report = WolfProfiledProductionReport {
        schema_version: WOLF_PROFILED_PRODUCTION_SCHEMA_VERSION.to_string(),
        capability_id: WOLF_PROFILED_PRODUCTION_CAPABILITY_ID.to_string(),
        cited_smoke_capability_id: WOLF_ENCRYPTED_SMOKE_CAPABILITY_ID.to_string(),
        source_node_id: source_node_id.to_string(),
        support_boundary: WOLF_PROFILED_PRODUCTION_SUPPORT_BOUNDARY.to_string(),
        registry_id: registry.registry_id.clone(),
        engine_family: WOLF_ENGINE_FAMILY.to_string(),
        container: WOLF_PROFILED_PRODUCTION_CONTAINER.to_string(),
        redaction_status: HelperRedactionStatus::Redacted,
        claimed_profiles,
        claimed_count,
        not_claimed_count,
        outcomes,
        status: OperationStatus::Passed,
    };

    let json = report
        .stable_json()
        .map_err(|error| WolfProfiledProductionError::Internal {
            message: error.to_string(),
        })?;
    if registry.archive_keys.any_key_appears_in(json.as_bytes())
        || registry.resolved_keys.any_key_appears_in(json.as_bytes())
    {
        return Err(WolfProfiledProductionError::Internal {
            message: "refusing to emit a report that leaks raw key material".to_string(),
        });
    }

    Ok(report)
}

fn run_claimed_variant(
    registry: &WolfProfiledProductionRegistry,
    variant: &WolfProfiledProductionVariant,
) -> Result<WolfProfiledVariantReport, WolfProfiledProductionError> {
    let id = variant.variant_id.as_str();
    if variant.protection_profile == WolfProtectionProfile::Unknown {
        return Err(WolfProfiledProductionError::claimed(
            id,
            WolfProfiledProductionStage::EvidenceCheck,
            "unknown protection profile cannot be a claimed extract+patch profile",
        ));
    }
    if variant.tables.is_empty() {
        return Err(WolfProfiledProductionError::claimed(
            id,
            WolfProfiledProductionStage::EvidenceCheck,
            "claimed profile declares no text-bearing tables",
        ));
    }

    let archive_key = registry
        .archive_keys
        .resolve(&variant.secret_requirement_id, &variant.secret_ref)
        .map_err(|cause| {
            WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::KeyResolve, cause)
        })?;
    let source_members = encode_tables_to_members(&variant.tables).map_err(|error| {
        WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::Patch, error)
    })?;
    let source_archive = pack_encrypted_archive(&source_members, archive_key).map_err(|error| {
        WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::Patch, error)
    })?;

    check_helper_evidence(variant).map_err(|cause| {
        WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::EvidenceCheck, cause)
    })?;
    let resolved_key = registry
        .resolved_keys
        .resolve(&variant.secret_requirement_id, &variant.secret_ref)
        .map_err(|cause| {
            WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::KeyResolve, cause)
        })?;

    let extracted = decrypt_archive_members(&source_archive, resolved_key).map_err(|error| {
        WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::Extract, error)
    })?;
    let extracted_ids: Vec<String> = extracted
        .iter()
        .map(|member| member.member_id.clone())
        .collect();
    if extracted_ids != variant.expected_member_ids() {
        return Err(WolfProfiledProductionError::claimed(
            id,
            WolfProfiledProductionStage::Extract,
            "extracted member set did not match the declared profile surfaces",
        ));
    }

    let identity_rebuilt = pack_encrypted_archive(&extracted, resolved_key).map_err(|error| {
        WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::Identity, error)
    })?;
    let identity_byte_identical = identity_rebuilt == source_archive;
    if !identity_byte_identical {
        return Err(WolfProfiledProductionError::claimed(
            id,
            WolfProfiledProductionStage::Identity,
            "identity rebuild diverged from the source archive",
        ));
    }

    let (patched_members, source_cells) =
        apply_patches(&extracted, &variant.patches).map_err(|error| {
            WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::Patch, error)
        })?;
    if source_cells.is_empty() {
        return Err(WolfProfiledProductionError::claimed(
            id,
            WolfProfiledProductionStage::Patch,
            "claimed profile declared no applicable patch",
        ));
    }
    let rebuilt_archive =
        pack_encrypted_archive(&patched_members, resolved_key).map_err(|error| {
            WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::Patch, error)
        })?;
    let verified = decrypt_archive_members(&rebuilt_archive, resolved_key).map_err(|error| {
        WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::Verify, error)
    })?;
    let patch_reports =
        verify_patch_isolation(&extracted, &verified, &variant.patches, &source_cells).map_err(
            |cause| {
                WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::Verify, cause)
            },
        )?;

    let mut member_deltas = Vec::with_capacity(extracted.len());
    let mut proof_material = Vec::new();
    let mut members_patched = 0u32;
    for source_member in &extracted {
        let target = verified
            .iter()
            .find(|member| member.member_id == source_member.member_id)
            .ok_or_else(|| WolfProfiledProductionError::Internal {
                message: "rebuilt archive dropped a source member".to_string(),
            })?;
        let source_hash = proof_hash(&source_member.plaintext)?;
        let target_hash = proof_hash(&target.plaintext)?;
        let operation = if source_hash == target_hash {
            WolfProfiledMemberOperation::Unchanged
        } else {
            members_patched += 1;
            WolfProfiledMemberOperation::Replace
        };
        proof_material.extend_from_slice(source_member.member_id.as_bytes());
        proof_material.extend_from_slice(source_hash.as_str().as_bytes());
        proof_material.extend_from_slice(target_hash.as_str().as_bytes());
        member_deltas.push(WolfProfiledMemberDelta {
            member_id: source_member.member_id.clone(),
            operation,
            source_plaintext_hash: source_hash,
            target_plaintext_hash: target_hash,
            length_delta: target.plaintext.len() as i64 - source_member.plaintext.len() as i64,
        });
    }

    let members_total = u32::try_from(extracted.len()).unwrap_or(u32::MAX);
    Ok(WolfProfiledVariantReport {
        variant_id: variant.variant_id.clone(),
        protection_profile: variant.protection_profile,
        crypto_profile: variant.crypto_profile,
        helper_workflow: variant.helper_workflow,
        secret_requirement_id: variant.secret_requirement_id.clone(),
        secret_ref: variant.secret_ref.clone(),
        helper_evidence_present: variant.helper_evidence.is_some(),
        key_material_kind: KeyMaterialKind::FixedBytes,
        key_material_hash: resolved_key.material_hash().map_err(|error| {
            WolfProfiledProductionError::claimed(id, WolfProfiledProductionStage::Verify, error)
        })?,
        key_bytes: u32::try_from(resolved_key.byte_len()).unwrap_or(u32::MAX),
        source_archive_hash: proof_hash(&source_archive)?,
        rebuilt_archive_hash: proof_hash(&rebuilt_archive)?,
        identity_byte_identical,
        members_total,
        members_patched,
        members_byte_preserved: members_total.saturating_sub(members_patched),
        member_deltas,
        patch_reports,
        round_trip_proof: KeyValidationProof {
            method: KeyValidationMethod::FixtureRoundTripProof,
            proof_hash: proof_hash(&proof_material)?,
        },
        status: OperationStatus::Passed,
    })
}

fn check_helper_evidence(variant: &WolfProfiledProductionVariant) -> Result<(), String> {
    if !variant.helper_workflow.requires_helper() {
        return Ok(());
    }
    let helper = variant.helper_evidence.as_ref().ok_or_else(|| {
        format!(
            "helper workflow {} requires helper evidence but none was supplied",
            variant.helper_workflow.as_str()
        )
    })?;
    let validation = helper.validate();
    if validation.status == OperationStatus::Failed {
        let failure_codes = validation
            .failures
            .iter()
            .map(|failure| format!("{}:{}", failure.field, failure.code))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "helper result failed KAIFUU-085 validation ({} failure(s): {failure_codes})",
            validation.failures.len(),
        ));
    }
    if helper.diagnostic.code != HelperDiagnosticCode::Success {
        return Err(format!(
            "helper result diagnostic is {:?}, not a resolved key",
            helper.diagnostic.code
        ));
    }
    let exact_ref = helper.secret_refs.iter().any(|secret| {
        secret.requirement_id == variant.secret_requirement_id
            && secret.secret_ref == variant.secret_ref
    });
    if !exact_ref {
        return Err(
            "helper result does not bind the variant requirement to the exact SecretRef"
                .to_string(),
        );
    }
    if helper.capability_level < variant.helper_workflow.minimum_capability() {
        return Err(format!(
            "helper capability level {:?} is below the {:?} required by workflow {}",
            helper.capability_level,
            variant.helper_workflow.minimum_capability(),
            variant.helper_workflow.as_str()
        ));
    }
    Ok(())
}

fn encode_tables_to_members(
    tables: &[WolfTextTable],
) -> Result<Vec<WolfPlainMember>, WolfAdapterError> {
    tables
        .iter()
        .map(|table| {
            Ok(WolfPlainMember {
                member_id: table_member_id(&table.table_name),
                plaintext: encode_wolf_text_table(table)?,
            })
        })
        .collect()
}

#[derive(Debug, Clone)]
struct SourceCell {
    table_name: String,
    coordinate: WolfAdapterPatchCoordinate,
    old_text: String,
}

fn apply_patches(
    extracted: &[WolfPlainMember],
    patches: &[WolfTextPatchRequest],
) -> Result<(Vec<WolfPlainMember>, Vec<SourceCell>), WolfAdapterError> {
    let mut patched_members = Vec::with_capacity(extracted.len());
    let mut source_cells = Vec::new();

    for member in extracted {
        let mut table = decode_wolf_text_table(&member.plaintext)?;
        let member_patches: Vec<&WolfTextPatchRequest> = patches
            .iter()
            .filter(|patch| table_member_id(&patch.table_name) == member.member_id)
            .collect();
        if member_patches.is_empty() {
            patched_members.push(member.clone());
            continue;
        }
        for patch in member_patches {
            let record = table
                .records
                .get_mut(patch.record_index as usize)
                .ok_or_else(|| WolfAdapterError::PatchTargetMissing {
                    detail: format!(
                        "record {} out of range for table {}",
                        patch.record_index, patch.table_name
                    ),
                })?;
            let cell = record.get_mut(patch.field_index as usize).ok_or_else(|| {
                WolfAdapterError::PatchTargetMissing {
                    detail: format!(
                        "field {} out of range for table {}",
                        patch.field_index, patch.table_name
                    ),
                }
            })?;
            source_cells.push(SourceCell {
                table_name: patch.table_name.clone(),
                coordinate: WolfAdapterPatchCoordinate {
                    record_index: patch.record_index,
                    field_index: patch.field_index,
                },
                old_text: cell.clone(),
            });
            cell.clone_from(&patch.new_text);
        }
        patched_members.push(WolfPlainMember {
            member_id: member.member_id.clone(),
            plaintext: encode_wolf_text_table(&table)?,
        });
    }

    Ok((patched_members, source_cells))
}

fn verify_patch_isolation(
    source: &[WolfPlainMember],
    verified: &[WolfPlainMember],
    patches: &[WolfTextPatchRequest],
    source_cells: &[SourceCell],
) -> Result<Vec<WolfProfiledPatchReport>, String> {
    let patched_ids: std::collections::BTreeSet<String> = patches
        .iter()
        .map(|patch| table_member_id(&patch.table_name))
        .collect();
    let mut reports = Vec::new();

    for patch in patches {
        let member_id = table_member_id(&patch.table_name);
        let source_member = find_member(source, &member_id)
            .ok_or_else(|| format!("source patched table {} missing", patch.table_name))?;
        let verified_member = find_member(verified, &member_id)
            .ok_or_else(|| format!("verified patched table {} missing", patch.table_name))?;
        let table = decode_wolf_text_table(&verified_member.plaintext)
            .map_err(|error| error.to_string())?;
        let actual = table
            .records
            .get(patch.record_index as usize)
            .and_then(|record| record.get(patch.field_index as usize))
            .ok_or_else(|| format!("patched coordinate missing in table {}", patch.table_name))?;
        let old = source_cells
            .iter()
            .find(|cell| {
                cell.table_name == patch.table_name
                    && cell.coordinate.record_index == patch.record_index
                    && cell.coordinate.field_index == patch.field_index
            })
            .ok_or_else(|| format!("source cell missing for table {}", patch.table_name))?;
        let patched_text_verified = actual == &patch.new_text;
        let old_text_absent = !flattened_table_text(&table).contains(&old.old_text);
        if !patched_text_verified || !old_text_absent {
            return Err(format!(
                "patched table {} did not verify new text present and old text gone",
                patch.table_name
            ));
        }
        reports.push(WolfProfiledPatchReport {
            table_name: patch.table_name.clone(),
            coordinates: vec![WolfAdapterPatchCoordinate {
                record_index: patch.record_index,
                field_index: patch.field_index,
            }],
            source_member_hash: proof_hash(&source_member.plaintext).map_err(|e| e.to_string())?,
            patched_member_hash: proof_hash(&verified_member.plaintext)
                .map_err(|e| e.to_string())?,
            patched_text_verified,
            old_text_absent,
        });
    }

    for source_member in source {
        if patched_ids.contains(&source_member.member_id) {
            continue;
        }
        let verified_member = find_member(verified, &source_member.member_id)
            .ok_or_else(|| format!("verified archive dropped {}", source_member.member_id))?;
        if verified_member.plaintext != source_member.plaintext {
            return Err(format!(
                "unpatched member {} was not byte-identical",
                source_member.member_id
            ));
        }
    }
    Ok(reports)
}

fn find_member<'a>(members: &'a [WolfPlainMember], member_id: &str) -> Option<&'a WolfPlainMember> {
    members.iter().find(|member| member.member_id == member_id)
}

fn flattened_table_text(table: &WolfTextTable) -> String {
    table
        .records
        .iter()
        .flat_map(|record| record.iter())
        .fold(String::new(), |mut acc, cell| {
            acc.push_str(cell);
            acc.push('\n');
            acc
        })
}

fn table_member_id(table_name: &str) -> String {
    format!("Data/{table_name}.wolftable")
}

fn proof_hash(bytes: &[u8]) -> Result<ProofHash, WolfProfiledProductionError> {
    ProofHash::new(sha256_hash_bytes(bytes))
        .map_err(|message| WolfProfiledProductionError::Internal { message })
}

fn fixture_key_material(label: &str) -> Vec<u8> {
    let mut bytes = b"kaifuu-wolf-profiled-production-key\0".to_vec();
    bytes.extend_from_slice(sha256_hash_bytes(label.as_bytes()).as_bytes());
    bytes
}

pub mod synthetic {
    use super::*;

    const STATIC_KEY_LABEL: &str = "wolf-profiled-production/static";
    const DYNAMIC_KEY_LABEL: &str = "wolf-profiled-production/dynamic";
    const RESEARCH_KEY_LABEL: &str = "wolf-profiled-production/research";

    fn proof_hash(byte: u8) -> ProofHash {
        ProofHash::new(format!("sha256:{}", format!("{byte:02x}").repeat(32)))
            .expect("synthetic proof hash is valid")
    }

    pub fn satisfied_helper(
        workflow: WolfProfiledHelperWorkflow,
        requirement_id: &str,
        secret_ref: &SecretRef,
    ) -> HelperResult {
        let boundary_kind = match workflow {
            WolfProfiledHelperWorkflow::DirectLocalKey
            | WolfProfiledHelperWorkflow::StaticKeyImport => {
                WolfHelperBoundaryKind::StaticKeyLocalImport
            }
            WolfProfiledHelperWorkflow::DynamicKeyHelper => {
                WolfHelperBoundaryKind::DynamicKeyLocalHelper
            }
        };
        HelperResult {
            schema_version: HELPER_RESULT_SCHEMA_VERSION.to_string(),
            fixture_id: "kaifuu-wolf-profiled-helper".to_string(),
            helper_result_id: format!("helper-result-kaifuu-wolf-profiled-{}", workflow.as_str()),
            profile_id: "kaifuu-wolf-profiled-helper".to_string(),
            helper: HelperProvenance {
                helper_id: "kaifuu.fixture.wolf-profiled-helper".to_string(),
                helper_version: "0.1.0".to_string(),
                helper_kind: boundary_kind.helper_kind(),
            },
            capability_level: boundary_kind.capability_level(),
            execution: HelperExecutionSummary {
                mode: boundary_kind.execution_mode(),
                platform: "fixture-local".to_string(),
                bounded: true,
                timeout_ms: 1000,
                duration_ms: Some(0),
                network_access: false,
                filesystem_access: HelperExecutionFilesystemAccess::ReadOnlyWorkspace,
            },
            diagnostic: HelperDiagnostic {
                code: HelperDiagnosticCode::Success,
                message: "synthetic Wolf profiled helper resolved the exact SecretRef".to_string(),
            },
            redaction: HelperRedaction {
                status: HelperRedactionStatus::Redacted,
                redacted_log_hash: proof_hash(0x58),
            },
            secret_refs: vec![HelperResultSecretRef {
                requirement_id: requirement_id.to_string(),
                secret_ref: secret_ref.clone(),
                material_kind: KeyMaterialKind::FixedBytes,
                bytes: None,
                validation: None,
            }],
            proof_hashes: vec![KeyValidationProof {
                method: KeyValidationMethod::ArchiveIndexProof,
                proof_hash: proof_hash(0x59),
            }],
        }
    }

    pub fn production_registry() -> WolfProfiledProductionRegistry {
        let static_ref = SecretRef::new("local-secret:kaifuu/k058/wolf-static-key")
            .expect("synthetic secret ref is valid");
        let dynamic_ref = SecretRef::new("local-secret:kaifuu/k058/wolf-dynamic-helper-key")
            .expect("synthetic secret ref is valid");
        let research_ref = SecretRef::new("local-secret:kaifuu/k058/wolf-research-key")
            .expect("synthetic secret ref is valid");

        let static_req = "kaifuu-k058-wolf-static-key".to_string();
        let dynamic_req = "kaifuu-k058-wolf-dynamic-key".to_string();
        let research_req = "kaifuu-k058-wolf-research-key".to_string();

        let static_variant = WolfProfiledProductionVariant {
            variant_id: "kaifuu-k058-wolf-static-profile".to_string(),
            protection_profile: WolfProtectionProfile::Protected,
            crypto_profile: WolfEncryptedCryptoProfile::XorFixture,
            helper_workflow: WolfProfiledHelperWorkflow::StaticKeyImport,
            secret_requirement_id: static_req.clone(),
            secret_ref: static_ref.clone(),
            helper_evidence: Some(satisfied_helper(
                WolfProfiledHelperWorkflow::StaticKeyImport,
                &static_req,
                &static_ref,
            )),
            tables: vec![
                WolfTextTable {
                    table_name: "ScenarioDB".to_string(),
                    field_count: 2,
                    records: vec![
                        vec![
                            "speaker-a".to_string(),
                            "synthetic-k058-line-before".to_string(),
                        ],
                        vec![
                            "speaker-b".to_string(),
                            "synthetic-k058-unchanged".to_string(),
                        ],
                    ],
                },
                WolfTextTable {
                    table_name: "MenuDB".to_string(),
                    field_count: 1,
                    records: vec![vec!["synthetic-menu=start".to_string()]],
                },
            ],
            patches: vec![WolfTextPatchRequest {
                table_name: "ScenarioDB".to_string(),
                record_index: 0,
                field_index: 1,
                new_text: "synthetic-k058-line-after-longer".to_string(),
            }],
            claimed: true,
        };

        let dynamic_variant = WolfProfiledProductionVariant {
            variant_id: "kaifuu-k058-wolf-dynamic-helper-profile".to_string(),
            protection_profile: WolfProtectionProfile::HelperRequired,
            crypto_profile: WolfEncryptedCryptoProfile::XorFixture,
            helper_workflow: WolfProfiledHelperWorkflow::DynamicKeyHelper,
            secret_requirement_id: dynamic_req.clone(),
            secret_ref: dynamic_ref.clone(),
            helper_evidence: Some(satisfied_helper(
                WolfProfiledHelperWorkflow::DynamicKeyHelper,
                &dynamic_req,
                &dynamic_ref,
            )),
            tables: vec![
                WolfTextTable {
                    table_name: "EventDB".to_string(),
                    field_count: 1,
                    records: vec![
                        vec!["synthetic-k058-event-before".to_string()],
                        vec!["synthetic-k058-event-untouched".to_string()],
                    ],
                },
                WolfTextTable {
                    table_name: "ItemDB".to_string(),
                    field_count: 1,
                    records: vec![vec!["synthetic-item=potion".to_string()]],
                },
            ],
            patches: vec![WolfTextPatchRequest {
                table_name: "EventDB".to_string(),
                record_index: 0,
                field_index: 0,
                new_text: "synthetic-k058-event-after".to_string(),
            }],
            claimed: true,
        };

        let research_variant = WolfProfiledProductionVariant {
            variant_id: "kaifuu-k058-wolf-unclaimed-research-profile".to_string(),
            protection_profile: WolfProtectionProfile::Protected,
            crypto_profile: WolfEncryptedCryptoProfile::XorFixture,
            helper_workflow: WolfProfiledHelperWorkflow::DirectLocalKey,
            secret_requirement_id: research_req.clone(),
            secret_ref: research_ref.clone(),
            helper_evidence: None,
            tables: vec![WolfTextTable {
                table_name: "ResearchDB".to_string(),
                field_count: 1,
                records: vec![vec!["synthetic-research-only".to_string()]],
            }],
            patches: Vec::new(),
            claimed: false,
        };

        WolfProfiledProductionRegistry {
            registry_id: deterministic_id("kaifuu-k058-wolf-profiled-production-registry", 1),
            variants: vec![static_variant, dynamic_variant, research_variant],
            archive_keys: resolver_from_fixture_labels(vec![
                (static_ref.as_str().to_string(), STATIC_KEY_LABEL),
                (dynamic_ref.as_str().to_string(), DYNAMIC_KEY_LABEL),
                (research_ref.as_str().to_string(), RESEARCH_KEY_LABEL),
            ]),
            resolved_keys: resolver_from_fixture_labels(vec![
                (static_ref.as_str().to_string(), STATIC_KEY_LABEL),
                (dynamic_ref.as_str().to_string(), DYNAMIC_KEY_LABEL),
            ]),
        }
    }

    /// Test seam: return the registry with its resolved-keys resolver rebuilt
    /// with a WRONG label for the static variant's ref, so the composed extract
    /// stage fails as a loud KAIFUU-058 compatibility bug. Used by the KAIFUU-145
    /// smoke fail-loud test; the raw bytes still stay inside the module-private
    /// resolver.
    pub fn production_registry_with_wrong_resolved_key(
        mut registry: WolfProfiledProductionRegistry,
    ) -> WolfProfiledProductionRegistry {
        let static_ref = registry.variants[0].secret_ref.as_str().to_string();
        registry.resolved_keys =
            resolver_from_fixture_labels(vec![(static_ref, "wolf-profiled-production/wrong")]);
        registry
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> WolfProfiledProductionRegistry {
        synthetic::production_registry()
    }

    #[test]
    fn profiled_wolf_variants_extract_and_patch_round_trip() {
        let report =
            run_wolf_profiled_production(&registry(), "KAIFUU-058").expect("profiled run passes");
        assert!(report.is_ok());
        assert_eq!(report.claimed_count, 2);
        assert_eq!(report.not_claimed_count, 1);
        assert!(
            report
                .claimed_profiles
                .contains(&WolfProtectionProfile::Protected)
        );
        assert!(
            report
                .claimed_profiles
                .contains(&WolfProtectionProfile::HelperRequired)
        );

        let claimed: Vec<&WolfProfiledVariantReport> = report
            .outcomes
            .iter()
            .filter_map(|outcome| match outcome {
                WolfProfiledOutcome::Claimed(report) => Some(report),
                WolfProfiledOutcome::NotClaimed(_) => None,
            })
            .collect();
        assert_eq!(claimed.len(), 2);
        for variant in claimed {
            assert!(variant.identity_byte_identical);
            assert_eq!(variant.members_patched, 1);
            assert_eq!(variant.members_byte_preserved, 1);
            assert_ne!(
                variant.source_archive_hash.as_str(),
                variant.rebuilt_archive_hash.as_str()
            );
            assert_eq!(variant.patch_reports.len(), 1);
            assert!(variant.patch_reports[0].patched_text_verified);
            assert!(variant.patch_reports[0].old_text_absent);
        }
    }

    #[test]
    fn claimed_but_broken_profile_fails_loud() {
        let mut registry = registry();
        let secret_ref = registry.variants[0].secret_ref.as_str().to_string();
        registry.resolved_keys =
            resolver_from_fixture_labels(vec![(secret_ref, "wolf-profiled-production/wrong")]);
        let err = run_wolf_profiled_production(&registry, "KAIFUU-058")
            .expect_err("wrong key is a compatibility bug");
        match err {
            WolfProfiledProductionError::ClaimedProfileFailed {
                variant_id, stage, ..
            } => {
                assert_eq!(variant_id, "kaifuu-k058-wolf-static-profile");
                assert_eq!(stage, "extract");
            }
            other @ WolfProfiledProductionError::Internal { .. } => {
                panic!("expected claimed profile failure, got {other}")
            }
        }
    }

    #[test]
    fn no_raw_key_leaks_through_debug_or_report() {
        let registry = registry();
        let debug = format!("{registry:?}");
        let report =
            run_wolf_profiled_production(&registry, "KAIFUU-058").expect("profiled run passes");
        let json = report.stable_json().expect("stable json");

        for plaintext in [
            "synthetic-k058-line-before",
            "synthetic-k058-line-after-longer",
            "synthetic-k058-event-before",
            "synthetic-k058-event-after",
        ] {
            assert!(
                !json.contains(plaintext),
                "plaintext {plaintext} leaked through report"
            );
        }
        assert!(
            !registry.archive_keys.any_key_appears_in(debug.as_bytes()),
            "archive key appeared in registry Debug"
        );
        assert!(
            !registry.resolved_keys.any_key_appears_in(json.as_bytes()),
            "resolved key appeared in report JSON"
        );
    }

    #[test]
    fn helper_evidence_must_bind_exact_secret_ref() {
        let mut registry = registry();
        let requirement = registry.variants[1].secret_requirement_id.clone();
        let wrong_ref = SecretRef::new("local-secret:kaifuu/k058/wolf-wrong-ref")
            .expect("synthetic secret ref is valid");
        registry.variants[1].helper_evidence = Some(synthetic::satisfied_helper(
            WolfProfiledHelperWorkflow::DynamicKeyHelper,
            &requirement,
            &wrong_ref,
        ));
        let err = run_wolf_profiled_production(&registry, "KAIFUU-058")
            .expect_err("wrong-ref helper evidence must not satisfy the gate");
        match err {
            WolfProfiledProductionError::ClaimedProfileFailed {
                variant_id,
                stage,
                cause,
                ..
            } => {
                assert_eq!(variant_id, "kaifuu-k058-wolf-dynamic-helper-profile");
                assert_eq!(stage, "evidence-check");
                assert!(cause.contains("exact SecretRef"));
            }
            other @ WolfProfiledProductionError::Internal { .. } => {
                panic!("expected claimed profile failure, got {other}")
            }
        }
    }

    #[test]
    fn unclaimed_profile_is_explicit_out_of_scope() {
        let report =
            run_wolf_profiled_production(&registry(), "KAIFUU-058").expect("profiled run passes");
        let not_claimed: Vec<&WolfProfiledNotClaimedReport> = report
            .outcomes
            .iter()
            .filter_map(|outcome| match outcome {
                WolfProfiledOutcome::NotClaimed(report) => Some(report),
                WolfProfiledOutcome::Claimed(_) => None,
            })
            .collect();
        assert_eq!(not_claimed.len(), 1);
        assert_eq!(
            not_claimed[0].variant_id,
            "kaifuu-k058-wolf-unclaimed-research-profile"
        );
        assert!(not_claimed[0].reason.contains("not claimed"));
    }
}
