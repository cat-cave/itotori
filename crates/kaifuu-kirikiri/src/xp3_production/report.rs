use super::*;

/// The operation a member's delta records across the patch-back rebuild.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Xp3ProductionMemberOperation {
    /// The member's plaintext changed across the rebuild.
    Replace,
    /// The member's plaintext was byte-identical across the rebuild.
    Unchanged,
}

/// One member's hash-based delta (no raw plaintext).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProductionMemberDelta {
    /// The in-archive member id.
    pub member_id: String,
    /// Whether the member changed.
    pub operation: Xp3ProductionMemberOperation,
    /// sha-256 commitment to the source (pre-patch) plaintext.
    pub source_plaintext_hash: ProofHash,
    /// sha-256 commitment to the target (post-patch) plaintext.
    pub target_plaintext_hash: ProofHash,
    /// Byte-length delta (target - source).
    pub length_delta: i64,
}

impl Xp3ProductionMemberDelta {
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

/// A claimed variant that extracted + patched successfully.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProductionVariantReport {
    /// The variant id.
    pub variant_id: String,
    /// The declared crypt-scheme profile.
    pub crypto_profile: Xp3CryptoProfile,
    /// The extracted-content surface.
    pub surface: KirikiriXp3Surface,
    /// The secret **requirement** id (never a raw key).
    pub secret_requirement_id: String,
    /// The structured secret ref the key was resolved through.
    pub secret_ref: SecretRef,
    /// The required key/helper workflow.
    pub helper_workflow: Xp3HelperWorkflow,
    /// Whether a corroborating helper result was consumed.
    pub helper_evidence_present: bool,
    /// Key material kind.
    pub key_material_kind: KeyMaterialKind,
    /// One-way sha-256 commitment to the resolved key (never the key).
    pub key_material_hash: ProofHash,
    /// Resolved key byte length (disclosed; the bytes are not).
    pub key_bytes: u32,
    /// sha-256 of the source encrypted container.
    pub source_container_hash: ProofHash,
    /// sha-256 of the rebuilt (patched) encrypted container.
    pub rebuilt_container_hash: ProofHash,
    /// The identity (no-change) rebuild was byte-identical to the source.
    pub identity_byte_identical: bool,
    /// Members in the archive.
    pub members_total: u32,
    /// Members the patch changed.
    pub members_patched: u32,
    /// Members that stayed byte-identical (plaintext) across the rebuild.
    pub members_byte_preserved: u32,
    /// Per-member hash-based deltas.
    pub members: Vec<Xp3ProductionMemberDelta>,
    /// A hash over the member deltas (proves this exact round-trip).
    pub round_trip_proof: KeyValidationProof,
    /// Always `Passed` on a returned report (a claimed failure aborts the run).
    pub status: OperationStatus,
}

impl Xp3ProductionVariantReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            variant_id: redact_for_log_or_report(&self.variant_id),
            crypto_profile: self.crypto_profile,
            surface: self.surface,
            secret_requirement_id: redact_for_log_or_report(&self.secret_requirement_id),
            secret_ref: self.secret_ref.clone(),
            helper_workflow: self.helper_workflow,
            helper_evidence_present: self.helper_evidence_present,
            key_material_kind: self.key_material_kind,
            key_material_hash: self.key_material_hash.clone(),
            key_bytes: self.key_bytes,
            source_container_hash: self.source_container_hash.clone(),
            rebuilt_container_hash: self.rebuilt_container_hash.clone(),
            identity_byte_identical: self.identity_byte_identical,
            members_total: self.members_total,
            members_patched: self.members_patched,
            members_byte_preserved: self.members_byte_preserved,
            members: self
                .members
                .iter()
                .map(Xp3ProductionMemberDelta::redacted_for_report)
                .collect(),
            round_trip_proof: self.round_trip_proof.clone(),
            status: self.status.clone(),
        }
    }
}

/// An explicit out-of-scope row: a variant the profile does NOT claim. Recorded
/// (never silently dropped), never advanced to a claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProductionNotClaimedReport {
    /// The variant id.
    pub variant_id: String,
    /// The declared crypt-scheme profile.
    pub crypto_profile: Xp3CryptoProfile,
    /// The required key/helper workflow.
    pub helper_workflow: Xp3HelperWorkflow,
    /// A short, honest reason the variant is out of scope.
    pub reason: String,
}

impl Xp3ProductionNotClaimedReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            variant_id: redact_for_log_or_report(&self.variant_id),
            crypto_profile: self.crypto_profile,
            helper_workflow: self.helper_workflow,
            reason: redact_for_log_or_report(&self.reason),
        }
    }
}

/// One variant's outcome: either a claimed extract+patch report or an explicit
/// out-of-scope not-claimed row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Xp3ProductionOutcome {
    /// A claimed variant that extracted + patched.
    Claimed(Xp3ProductionVariantReport),
    /// An explicit out-of-scope variant.
    NotClaimed(Xp3ProductionNotClaimedReport),
}

impl Xp3ProductionOutcome {
    fn redacted_for_report(&self) -> Self {
        match self {
            Self::Claimed(report) => Self::Claimed(report.redacted_for_report()),
            Self::NotClaimed(report) => Self::NotClaimed(report.redacted_for_report()),
        }
    }
}

/// The full production extract+patch report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3ProductionReport {
    /// Report schema version.
    pub schema_version: String,
    /// Capability id.
    pub capability_id: String,
    /// Provenance node id stamped into generated reports.
    pub source_node_id: String,
    /// The blunt support boundary.
    pub support_boundary: String,
    /// Registry id.
    pub registry_id: String,
    /// Engine family (`kirikiri`).
    pub engine_family: String,
    /// Container (`xp3`).
    pub container: String,
    /// Redaction posture.
    pub redaction_status: HelperRedactionStatus,
    /// Distinct crypt-scheme profiles claimed + round-tripped (proves the path
    /// is engine-general across ≥2 schemes from data alone).
    pub claimed_profiles: Vec<Xp3CryptoProfile>,
    /// How many variants were claimed + round-tripped.
    pub claimed_count: u32,
    /// How many variants were explicit out-of-scope rows.
    pub not_claimed_count: u32,
    /// Per-variant outcomes, in registry order.
    pub outcomes: Vec<Xp3ProductionOutcome>,
    /// Overall status.
    pub status: OperationStatus,
}

impl Xp3ProductionReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            capability_id: self.capability_id.clone(),
            source_node_id: self.source_node_id.clone(),
            support_boundary: self.support_boundary.clone(),
            registry_id: redact_for_log_or_report(&self.registry_id),
            engine_family: self.engine_family.clone(),
            container: self.container.clone(),
            redaction_status: self.redaction_status,
            claimed_profiles: self.claimed_profiles.clone(),
            claimed_count: self.claimed_count,
            not_claimed_count: self.not_claimed_count,
            outcomes: self
                .outcomes
                .iter()
                .map(Xp3ProductionOutcome::redacted_for_report)
                .collect(),
            status: self.status.clone(),
        }
    }

    /// Stable, redacted JSON for committing as proof (no raw key, no plaintext).
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }

    /// True when every claimed variant round-tripped.
    #[must_use]
    pub fn is_ok(&self) -> bool {
        self.status == OperationStatus::Passed
    }
}
