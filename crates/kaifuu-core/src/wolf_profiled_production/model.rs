//! Profiled Wolf production domain model.

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WolfProfiledHelperWorkflow {
    DirectLocalKey,
    StaticKeyImport,
    DynamicKeyHelper,
}

impl WolfProfiledHelperWorkflow {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::DirectLocalKey => "direct-local-key",
            Self::StaticKeyImport => "static-key-import",
            Self::DynamicKeyHelper => "dynamic-key-helper",
        }
    }

    pub(super) fn requires_helper(self) -> bool {
        !matches!(self, Self::DirectLocalKey)
    }

    pub(super) fn minimum_capability(self) -> HelperCapabilityLevel {
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
    pub(super) fn as_str(self) -> &'static str {
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
    pub(super) fn claimed(
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
    pub(super) fn expected_member_ids(&self) -> Vec<String> {
        self.tables
            .iter()
            .map(|table| table_member_id(&table.table_name))
            .collect()
    }
}

/// Build a resolver from `(secret_ref, fixture label)` entries.
/// Raw fixture material is first confined in shared zeroize-on-drop holders,
/// then the Wolf resolver binds refs to those holders. The resolver's
/// crate-visible construction path never accepts raw bytes.
pub(super) fn resolver_from_fixture_labels(
    entries: Vec<(String, &'static str)>,
) -> WolfEncryptedFixtureSecretResolver {
    let holders = entries
        .into_iter()
        .map(|(secret_ref, label)| {
            let secret_ref = SecretRef::new(secret_ref).expect("fixture secret ref is valid");
            let holder = private_fixture_secret_holder(&secret_ref, fixture_key_material(label));
            (secret_ref.as_str().to_string(), holder)
        })
        .collect::<Vec<_>>();
    WolfEncryptedFixtureSecretResolver::from_key_refs(
        holders
            .iter()
            .map(|(secret_ref, holder)| (secret_ref.clone(), holder))
            .collect(),
    )
}

fn private_fixture_secret_holder(
    secret_ref: &SecretRef,
    bytes: Vec<u8>,
) -> WolfEncryptedArchiveKey {
    SecretRefSecretResolver::from_entries(vec![(secret_ref.as_str().to_string(), bytes)])
        .into_resolved(secret_ref)
        .expect("newly inserted Wolf production key must resolve by its SecretRef")
}

/// Profiled variant registry. Raw fixture key material is held only in private
/// redacting resolvers.
pub struct WolfProfiledProductionRegistry {
    pub registry_id: String,
    pub variants: Vec<WolfProfiledProductionVariant>,
    pub(super) archive_keys: WolfEncryptedFixtureSecretResolver,
    pub(super) resolved_keys: WolfEncryptedFixtureSecretResolver,
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
    /// for downstream composers (smoke) without ever handing the raw
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
