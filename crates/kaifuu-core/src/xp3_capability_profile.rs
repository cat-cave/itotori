//! KiriKiri XP3 capability-profile generator and validator.
//! A *capability profile* is the aggregate, evidence-derived readiness record
//! for a KiriKiri/XP3 corpus. It is **generated** from the existing kaifuu
//! evidence surfaces — the detector proof
//! ([`crate::xp3_profile_proof`]), the key/helper result
//! ([`crate::HelperResult`]), the crypt-profile routing taxonomy, and the
//! archive fixture bytes — never hand-authored as readiness prose. Each entry's
//! capability tuple is a pure function of that evidence.
//! THE LINE (mechanical, not prose): only **plain** XP3 can enter the
//! [`Xp3CapabilitySupportTier::Claimed`] tier (real detect + extract +
//! patch-back). Encrypted, compressed, helper-required, protected-executable,
//! and universal-dump entries are described **for routing diagnostics only** and
//! are advertised as [`Xp3CapabilitySupportTier::Research`] — they can never
//! show a claimed patch capability. Plaintext `.ks` is the degenerate
//! [`Xp3CapabilitySupportTier::NullContainer`] special case, explicitly NOT the
//! commercial KiriKiri baseline. The single point of truth is
//! [`derive_support_tier`]; the report's capability tuple is always recomputed
//! from evidence, so the manifest cannot talk a non-plain variant into a claim.
//! The validator (folded into generation) fails — with structured findings,
//! never a panic — on bad detector evidence, a helper-requirement mismatch, a
//! keyRef-state mismatch, an archive-hash mismatch, or a patch-capability-tuple
//! mismatch. Every string surfaced in the report is funnelled through
//! [`crate::redact_for_log_or_report`]; the report carries only counts and
//! hashes, never raw archive bytes, keys, helper dumps, decrypted text, private
//! archive names, or local paths.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{
    HelperDiagnosticCode, HelperResult, KaifuuResult, OperationStatus, PartialDiagnosticSeverity,
    ProofHash, SecretRef, Xp3CryptProfileStatus, Xp3HelperRequirement, Xp3PatchCapabilityLevel,
    Xp3ProfileClassification, Xp3ProfileProofFixture, Xp3ProfileProofRequest, read_json,
    redact_for_log_or_report, sha256_hash_bytes, stable_json, xp3_profile_proof,
};

#[path = "xp3_capability_profile/evidence.rs"]
mod evidence;
#[path = "xp3_capability_profile/generation.rs"]
mod generation;

pub const XP3_CAPABILITY_PROFILE_SCHEMA_VERSION: &str = "0.1.0";

/// The support boundary surfaced in every capability-profile report.
pub const XP3_CAPABILITY_PROFILE_SUPPORT_BOUNDARY: &str = "KiriKiri XP3 capability profiles are generated from detector, key/helper, crypt-profile, and archive fixture evidence. Only plain XP3 enters claimed patch-back support; encrypted, compressed, helper-required, protected-executable, and universal-dump entries are research-tier routing diagnostics only and never claim extract or patch-back. Plaintext .ks is the null-container special case, not the commercial KiriKiri baseline.";

/// Semantic code: an entry's declared expectation did not match the evidence.
pub const SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH: &str =
    "kaifuu.capability_profile.evidence_mismatch";
/// Semantic code: a non-plain variant tried to advertise a patch-back claim.
pub const SEMANTIC_CAPABILITY_ENCRYPTED_PATCH_OVERCLAIM: &str =
    "kaifuu.capability_profile.encrypted_patch_overclaim";

/// The mechanical support tier of a capability-profile entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Xp3CapabilitySupportTier {
    /// Plain XP3 only: detect + extract + patch-back is a real claimed
    /// capability.
    Claimed,
    /// Encrypted / compressed / helper-required / protected-executable /
    /// universal-dump: described for routing diagnostics only, never a
    /// patch-back claim.
    Research,
    /// Plaintext `.ks`: the null-container degenerate case, explicitly not the
    /// commercial KiriKiri baseline.
    NullContainer,
}

impl Xp3CapabilitySupportTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claimed => "claimed",
            Self::Research => "research",
            Self::NullContainer => "null_container",
        }
    }
}

/// The workflow taxonomy a capability-profile entry can describe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Xp3CapabilityVariant {
    /// Plaintext `.ks` script with no archive container (null-container case).
    PlaintextKs,
    /// Plain XP3 archive — the only claimed patch-back concern.
    PlainXp3,
    /// Encrypted XP3 archive — research-tier routing diagnostics only.
    EncryptedXp3,
    /// Helper-required XP3 archive — research-tier routing diagnostics only.
    HelperRequiredXp3,
    /// Protected-executable container — research-tier routing diagnostics only.
    ProtectedExecutable,
    /// Universal dump triage workflow over a non-plain archive — research-tier.
    UniversalDump,
}

impl Xp3CapabilityVariant {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PlaintextKs => "plaintext_ks",
            Self::PlainXp3 => "plain_xp3",
            Self::EncryptedXp3 => "encrypted_xp3",
            Self::HelperRequiredXp3 => "helper_required_xp3",
            Self::ProtectedExecutable => "protected_executable",
            Self::UniversalDump => "universal_dump",
        }
    }

    /// The detector classification this variant requires the detector evidence
    /// to route to. `None` means the variant carries no XP3 archive
    /// (plaintext `.ks`); `UniversalDump` accepts any non-plain classification
    /// (it is a triage workflow over archives nothing else can patch back).
    fn expected_classification(self) -> Option<Xp3ProfileClassification> {
        match self {
            Self::PlainXp3 => Some(Xp3ProfileClassification::Plain),
            Self::EncryptedXp3 => Some(Xp3ProfileClassification::Encrypted),
            Self::HelperRequiredXp3 => Some(Xp3ProfileClassification::HelperRequired),
            Self::ProtectedExecutable => {
                Some(Xp3ProfileClassification::UnsupportedProtectedExecutable)
            }
            Self::PlaintextKs | Self::UniversalDump => None,
        }
    }

    fn carries_archive(self) -> bool {
        !matches!(self, Self::PlaintextKs)
    }
}

/// THE mechanical plain-vs-encrypted line. An entry enters the `Claimed`
/// tier (patch-back support) **if and only if** the detector classified the
/// archive bytes as `Plain` AND the derived patch capability is `PatchBack`.
/// Every other classification collapses to `Research`. No classification means
/// plaintext `.ks` → `NullContainer`.
/// Total and side-effect-free; the single source of truth, exercised directly
/// by `encrypted_variant_can_never_be_claimed`.
pub fn derive_support_tier(
    classification: Option<Xp3ProfileClassification>,
    patch_capability: Xp3PatchCapabilityLevel,
) -> Xp3CapabilitySupportTier {
    match classification {
        Some(Xp3ProfileClassification::Plain)
            if patch_capability == Xp3PatchCapabilityLevel::PatchBack =>
        {
            Xp3CapabilitySupportTier::Claimed
        }
        None => Xp3CapabilitySupportTier::NullContainer,
        _ => Xp3CapabilitySupportTier::Research,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Xp3CapabilityProfileFixture {
    pub schema_version: String,
    pub capability_profile_id: String,
    /// Provenance node id stamped into generated reports.
    pub source_node_id: String,
    pub engine_family: String,
    pub entries: Vec<Xp3CapabilityProfileFixtureEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Xp3CapabilityProfileFixtureEntry {
    pub entry_id: String,
    pub variant: Xp3CapabilityVariant,
    pub workflow: String,
    /// Path (relative to the manifest file) to the detector proof
    /// fixture supplying detector / archive / crypt-profile evidence. Required
    /// for every variant that carries an archive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detector_fixture: Option<String>,
    /// Path (relative to the manifest file) to a plaintext `.ks` source. Only
    /// the `plaintext_ks` variant uses it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plaintext_source: Option<String>,
    /// Path (relative to the manifest file) to a helper result
    /// supplying key/helper-requirement evidence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_result_fixture: Option<String>,
    /// The author's declared expectation. The validator confirms it matches the
    /// evidence; the generated tuple is always recomputed from evidence.
    pub expected: Xp3CapabilityProfileExpected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Xp3CapabilityProfileExpected {
    pub support_tier: Xp3CapabilitySupportTier,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub classification: Option<Xp3ProfileClassification>,
    pub patch_capability: Xp3PatchCapabilityLevel,
    pub helper_requirement: Xp3HelperRequirement,
    pub crypt_profile_status: Xp3CryptProfileStatus,
    pub key_ref_present: bool,
    pub archive_hash: ProofHash,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_count: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3CapabilityProfileReport {
    pub schema_version: String,
    pub capability_profile_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub entries: Vec<Xp3CapabilityProfileEntryReport>,
}

impl Xp3CapabilityProfileReport {
    pub fn entry(&self, entry_id: &str) -> Option<&Xp3CapabilityProfileEntryReport> {
        self.entries.iter().find(|entry| entry.entry_id == entry_id)
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            capability_profile_id: redact_for_log_or_report(&self.capability_profile_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            entries: self
                .entries
                .iter()
                .map(Xp3CapabilityProfileEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3CapabilityProfileEntryReport {
    pub entry_id: String,
    /// Acceptance: every entry records the source node id …
    pub source_node_id: String,
    /// … fixture id …
    pub fixture_id: String,
    /// … engine variant …
    pub engine_variant: Xp3CapabilityVariant,
    pub workflow: String,
    /// … archive profile …
    pub archive_profile: Xp3CapabilityArchiveProfile,
    /// … key/helper requirement …
    pub key_helper_requirement: Xp3CapabilityKeyHelperRequirement,
    /// … capability tuple …
    pub capability_tuple: Xp3CapabilityTuple,
    /// … validation command …
    pub validation_command: String,
    /// … and redaction status.
    pub redaction_status: String,
    pub status: OperationStatus,
    pub findings: Vec<Xp3CapabilityFinding>,
}

impl Xp3CapabilityProfileEntryReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            entry_id: redact_for_log_or_report(&self.entry_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            engine_variant: self.engine_variant,
            workflow: redact_for_log_or_report(&self.workflow),
            archive_profile: self.archive_profile.redacted_for_report(),
            key_helper_requirement: self.key_helper_requirement.redacted_for_report(),
            capability_tuple: self.capability_tuple,
            validation_command: redact_for_log_or_report(&self.validation_command),
            redaction_status: redact_for_log_or_report(&self.redaction_status),
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(Xp3CapabilityFinding::redacted_for_report)
                .collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3CapabilityArchiveProfile {
    /// `archiveId` from the detector evidence, or a synthetic id for the
    /// null container. Never a private archive name.
    pub archive_id: String,
    pub archive_hash: ProofHash,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_count: Option<u64>,
}

impl Xp3CapabilityArchiveProfile {
    fn redacted_for_report(&self) -> Self {
        Self {
            archive_id: redact_for_log_or_report(&self.archive_id),
            archive_hash: self.archive_hash.clone(),
            entry_count: self.entry_count,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3CapabilityKeyHelperRequirement {
    pub helper_requirement: Xp3HelperRequirement,
    pub crypt_profile_status: Xp3CryptProfileStatus,
    pub key_ref_present: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requirement_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<SecretRef>,
    /// `true` once a helper result corroborated the requirement.
    pub helper_result_present: bool,
}

impl Xp3CapabilityKeyHelperRequirement {
    fn redacted_for_report(&self) -> Self {
        Self {
            helper_requirement: self.helper_requirement,
            crypt_profile_status: self.crypt_profile_status,
            key_ref_present: self.key_ref_present,
            requirement_id: self.requirement_id.as_deref().map(redact_for_log_or_report),
            secret_ref: self.secret_ref.clone(),
            helper_result_present: self.helper_result_present,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3CapabilityTuple {
    pub support_tier: Xp3CapabilitySupportTier,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub classification: Option<Xp3ProfileClassification>,
    pub patch_capability: Xp3PatchCapabilityLevel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3CapabilityFinding {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_code: Option<String>,
}

impl Xp3CapabilityFinding {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code.as_deref().map(redact_for_log_or_report),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Xp3CapabilityProfileRequest<'a> {
    pub fixture: &'a Xp3CapabilityProfileFixture,
    /// Directory the manifest lives in; entry evidence paths resolve here.
    pub fixture_dir: &'a Path,
    /// The manifest file name (no directory), recorded in each entry's
    /// `validationCommand` without leaking a local path.
    pub fixture_file_name: &'a str,
}

/// Generate (and, inseparably, validate) a KiriKiri XP3 capability profile
/// from the manifest's evidence inputs.
/// Every entry's capability tuple is recomputed from evidence via
/// [`derive_support_tier`]; the manifest's declared `expected` block is used
/// only to raise structured validation findings on a mismatch. The function
/// returns `Err` only on an environmental failure (a manifest-shaped problem
/// the report could not represent); evidence/validation problems surface as
/// per-entry findings with a `Failed` status.
pub fn generate_xp3_capability_profile(
    request: Xp3CapabilityProfileRequest<'_>,
) -> KaifuuResult<Xp3CapabilityProfileReport> {
    let fixture = request.fixture;
    let validation_command = format!(
        "kaifuu xp3 capability-profile --fixture {}",
        sanitize_file_name(request.fixture_file_name)
    );

    let mut entries = Vec::with_capacity(fixture.entries.len());
    for entry in &fixture.entries {
        entries.push(generation::generate_entry(
            entry,
            &fixture.source_node_id,
            request.fixture_dir,
            &validation_command,
        ));
    }

    let status = if entries
        .iter()
        .all(|entry| matches!(entry.status, OperationStatus::Passed))
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    Ok(Xp3CapabilityProfileReport {
        schema_version: XP3_CAPABILITY_PROFILE_SCHEMA_VERSION.to_string(),
        capability_profile_id: fixture.capability_profile_id.clone(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        support_boundary: XP3_CAPABILITY_PROFILE_SUPPORT_BOUNDARY.to_string(),
        status,
        entries,
    })
}

/// Evidence derived for one entry before validation against the declared
/// expectation.
struct DerivedEvidence {
    fixture_id: String,
    classification: Option<Xp3ProfileClassification>,
    patch_capability: Xp3PatchCapabilityLevel,
    helper_requirement: Xp3HelperRequirement,
    crypt_profile_status: Xp3CryptProfileStatus,
    key_ref_present: bool,
    requirement_id: Option<String>,
    secret_ref: Option<SecretRef>,
    archive_id: String,
    archive_hash: ProofHash,
    entry_count: Option<u64>,
    helper_result_present: bool,
    findings: Vec<Xp3CapabilityFinding>,
}

fn finding(
    code: &str,
    severity: PartialDiagnosticSeverity,
    field: &str,
    message: String,
    semantic_code: &str,
) -> Xp3CapabilityFinding {
    Xp3CapabilityFinding {
        code: code.to_string(),
        severity,
        field: field.to_string(),
        message,
        semantic_code: Some(semantic_code.to_string()),
    }
}

fn internal_finding(context: &str, error: &str) -> Xp3CapabilityFinding {
    finding(
        "xp3.capability.internal",
        PartialDiagnosticSeverity::P0,
        context,
        redact_for_log_or_report(error),
        SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
    )
}

/// Keep only the file-name component of a declared manifest name so the
/// recorded validation command can never echo a local directory path.
fn sanitize_file_name(name: &str) -> String {
    Path::new(name)
        .file_name()
        .and_then(|component| component.to_str())
        .map_or_else(
            || "xp3-capability-profile.json".to_string(),
            std::string::ToString::to_string,
        )
}

#[cfg(test)]
mod tests;
