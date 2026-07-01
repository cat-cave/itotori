//! KAIFUU-054 — KiriKiri XP3 capability-profile generator and validator.
//!
//! A *capability profile* is the aggregate, evidence-derived readiness record
//! for a KiriKiri/XP3 corpus. It is **generated** from the existing kaifuu
//! evidence surfaces — the KAIFUU-038 detector proof
//! ([`crate::xp3_profile_proof`]), the KAIFUU-085 key/helper result
//! ([`crate::HelperResult`]), the crypt-profile routing taxonomy, and the
//! archive fixture bytes — never hand-authored as readiness prose. Each entry's
//! capability tuple is a pure function of that evidence.
//!
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
//!
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

pub const XP3_CAPABILITY_PROFILE_SCHEMA_VERSION: &str = "0.1.0";

/// The support boundary surfaced in every capability-profile report.
pub const XP3_CAPABILITY_PROFILE_SUPPORT_BOUNDARY: &str = "KiriKiri XP3 capability profiles are generated from detector, key/helper, crypt-profile, and archive fixture evidence. Only plain XP3 enters claimed patch-back support; encrypted, compressed, helper-required, protected-executable, and universal-dump entries are research-tier routing diagnostics only and never claim extract or patch-back. Plaintext .ks is the null-container special case, not the commercial KiriKiri baseline.";

/// Semantic code: an entry's declared expectation did not match the evidence.
pub const SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH: &str =
    "kaifuu.capability_profile.evidence_mismatch";
/// Semantic code: a non-plain variant tried to advertise a patch-back claim.
pub const SEMANTIC_CAPABILITY_ENCRYPTED_PATCH_OVERCLAIM: &str =
    "kaifuu.capability_profile.encrypted_patch_overclaim";

// --- Taxonomy ---------------------------------------------------------------

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
///
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

// --- Fixture (input manifest) -----------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Xp3CapabilityProfileFixture {
    pub schema_version: String,
    pub capability_profile_id: String,
    /// The spec-DAG node id this profile is generated for (e.g. `KAIFUU-054`).
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
    /// Path (relative to the manifest file) to the KAIFUU-038 detector proof
    /// fixture supplying detector / archive / crypt-profile evidence. Required
    /// for every variant that carries an archive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detector_fixture: Option<String>,
    /// Path (relative to the manifest file) to a plaintext `.ks` source. Only
    /// the `plaintext_ks` variant uses it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plaintext_source: Option<String>,
    /// Path (relative to the manifest file) to a KAIFUU-085 helper result
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

// --- Report (generated output) ----------------------------------------------

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
    /// `true` once a KAIFUU-085 helper result corroborated the requirement.
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

// --- Request + generator ----------------------------------------------------

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
///
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
        entries.push(generate_entry(
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

fn generate_entry(
    entry: &Xp3CapabilityProfileFixtureEntry,
    source_node_id: &str,
    fixture_dir: &Path,
    validation_command: &str,
) -> Xp3CapabilityProfileEntryReport {
    let mut evidence = match derive_evidence(entry, fixture_dir) {
        Ok(evidence) => evidence,
        Err(finding) => {
            // An unreadable / malformed evidence input is itself a blocking
            // finding, never an `Err` from the generator.
            return failed_entry(entry, source_node_id, validation_command, finding);
        }
    };

    let mut findings = std::mem::take(&mut evidence.findings);

    // --- Validate evidence against the declared expectation. ---------------

    // (1) Bad detector evidence: the routed classification must match the
    //     variant's required classification.
    validate_detector_evidence(entry, &evidence, &mut findings);

    // (2) Helper requirement mismatch.
    if entry.expected.helper_requirement != evidence.helper_requirement {
        findings.push(finding(
            "xp3.capability.helper_requirement_mismatch",
            PartialDiagnosticSeverity::P0,
            "expected.helperRequirement",
            format!(
                "entry declared helperRequirement {} but evidence derived {}",
                entry.expected.helper_requirement.as_str(),
                evidence.helper_requirement.as_str()
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }

    // (3) KeyRef state mismatch (presence + crypt-profile status).
    if entry.expected.key_ref_present != evidence.key_ref_present {
        findings.push(finding(
            "xp3.capability.key_ref_state_mismatch",
            PartialDiagnosticSeverity::P0,
            "expected.keyRefPresent",
            format!(
                "entry declared keyRefPresent={} but evidence derived {}",
                entry.expected.key_ref_present, evidence.key_ref_present
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }
    if entry.expected.crypt_profile_status != evidence.crypt_profile_status {
        findings.push(finding(
            "xp3.capability.crypt_profile_status_mismatch",
            PartialDiagnosticSeverity::P0,
            "expected.cryptProfileStatus",
            format!(
                "entry declared cryptProfileStatus {} but evidence derived {}",
                entry.expected.crypt_profile_status.as_str(),
                evidence.crypt_profile_status.as_str()
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }

    // (4) Archive hash mismatch.
    if entry.expected.archive_hash.as_str() != evidence.archive_hash.as_str() {
        findings.push(finding(
            "xp3.capability.archive_hash_mismatch",
            PartialDiagnosticSeverity::P0,
            "expected.archiveHash",
            "entry declared archiveHash does not match the hashed archive bytes".to_string(),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }
    if entry.expected.entry_count != evidence.entry_count {
        findings.push(finding(
            "xp3.capability.entry_count_mismatch",
            PartialDiagnosticSeverity::P1,
            "expected.entryCount",
            format!(
                "entry declared entryCount {:?} but evidence derived {:?}",
                entry.expected.entry_count, evidence.entry_count
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }

    // --- Recompute the capability tuple from evidence. ---------------------
    // This is THE mechanical line: support tier is a pure function of the
    // routed classification + derived patch capability, NOT of the declared
    // expectation. A non-plain variant therefore cannot be generated into a
    // claimed tuple no matter what the manifest declares.
    let support_tier = derive_support_tier(evidence.classification, evidence.patch_capability);
    let mut tuple = Xp3CapabilityTuple {
        support_tier,
        classification: evidence.classification,
        patch_capability: evidence.patch_capability,
    };
    // Research / null-container tiers never advertise a patch-back capability.
    if support_tier != Xp3CapabilitySupportTier::Claimed
        && tuple.patch_capability == Xp3PatchCapabilityLevel::PatchBack
    {
        tuple.patch_capability = Xp3PatchCapabilityLevel::Unsupported;
    }

    // (5) Patch-capability-tuple mismatch: the declared tier / patch capability
    //     must match the evidence-derived tuple.
    if entry.expected.support_tier != tuple.support_tier
        || entry.expected.patch_capability != tuple.patch_capability
    {
        findings.push(finding(
            "xp3.capability.patch_tuple_mismatch",
            PartialDiagnosticSeverity::P0,
            "expected.supportTier",
            format!(
                "entry declared (tier={}, patch={}) but evidence derived (tier={}, patch={})",
                entry.expected.support_tier.as_str(),
                entry.expected.patch_capability.as_str(),
                tuple.support_tier.as_str(),
                tuple.patch_capability.as_str()
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }

    // (6) Mechanical overclaim guard: a non-plain variant that DECLARES a
    //     claimed tier or patch-back capability is a hard overclaim, even
    //     though the generated tuple already refused it.
    if entry.variant != Xp3CapabilityVariant::PlainXp3
        && entry.variant != Xp3CapabilityVariant::PlaintextKs
        && (entry.expected.support_tier == Xp3CapabilitySupportTier::Claimed
            || entry.expected.patch_capability == Xp3PatchCapabilityLevel::PatchBack)
    {
        findings.push(finding(
            "xp3.capability.encrypted_patch_overclaim",
            PartialDiagnosticSeverity::P0,
            "expected.supportTier",
            format!(
                "variant {} is research-tier only and must not claim patch-back support",
                entry.variant.as_str()
            ),
            SEMANTIC_CAPABILITY_ENCRYPTED_PATCH_OVERCLAIM,
        ));
    }

    let status = if findings
        .iter()
        .any(|finding| finding.severity.is_blocking())
    {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    Xp3CapabilityProfileEntryReport {
        entry_id: entry.entry_id.clone(),
        source_node_id: source_node_id.to_string(),
        fixture_id: evidence.fixture_id,
        engine_variant: entry.variant,
        workflow: entry.workflow.clone(),
        archive_profile: Xp3CapabilityArchiveProfile {
            archive_id: evidence.archive_id,
            archive_hash: evidence.archive_hash,
            entry_count: evidence.entry_count,
        },
        key_helper_requirement: Xp3CapabilityKeyHelperRequirement {
            helper_requirement: evidence.helper_requirement,
            crypt_profile_status: evidence.crypt_profile_status,
            key_ref_present: evidence.key_ref_present,
            requirement_id: evidence.requirement_id,
            secret_ref: evidence.secret_ref,
            helper_result_present: evidence.helper_result_present,
        },
        capability_tuple: tuple,
        validation_command: validation_command.to_string(),
        redaction_status: "redacted".to_string(),
        status,
        findings,
    }
}

/// Derive the evidence for one entry from its detector / helper / archive
/// inputs. Returns `Err(finding)` only when an input is structurally
/// unusable; routing-level problems are accumulated into `findings`.
fn derive_evidence(
    entry: &Xp3CapabilityProfileFixtureEntry,
    fixture_dir: &Path,
) -> Result<DerivedEvidence, Xp3CapabilityFinding> {
    if entry.variant.carries_archive() {
        derive_archive_evidence(entry, fixture_dir)
    } else {
        derive_plaintext_ks_evidence(entry, fixture_dir)
    }
}

fn derive_archive_evidence(
    entry: &Xp3CapabilityProfileFixtureEntry,
    fixture_dir: &Path,
) -> Result<DerivedEvidence, Xp3CapabilityFinding> {
    let detector_rel = entry.detector_fixture.as_deref().ok_or_else(|| {
        finding(
            "xp3.capability.detector_fixture_missing",
            PartialDiagnosticSeverity::P0,
            "detectorFixture",
            format!(
                "variant {} requires a detectorFixture",
                entry.variant.as_str()
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        )
    })?;
    let detector_path = fixture_dir.join(detector_rel);
    let detector_dir = detector_path
        .parent()
        .ok_or_else(|| {
            finding(
                "xp3.capability.detector_fixture_path",
                PartialDiagnosticSeverity::P0,
                "detectorFixture",
                "detectorFixture path must have a parent directory".to_string(),
                SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
            )
        })?
        .to_path_buf();
    let proof_fixture: Xp3ProfileProofFixture = read_json(&detector_path).map_err(|error| {
        finding(
            "xp3.capability.detector_fixture_unreadable",
            PartialDiagnosticSeverity::P0,
            "detectorFixture",
            format!(
                "detector fixture could not be read: {}",
                redact_for_log_or_report(&error.to_string())
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        )
    })?;

    let proof = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &proof_fixture,
        fixture_dir: &detector_dir,
    })
    .map_err(|error| {
        finding(
            "xp3.capability.detector_proof_errored",
            PartialDiagnosticSeverity::P0,
            "detectorFixture",
            format!(
                "detector proof errored: {}",
                redact_for_log_or_report(&error.to_string())
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        )
    })?;

    let mut findings = Vec::new();
    // The detector proof legitimately reports a `Failed` status for the
    // research-tier variants — the P1 routing diagnostic (encrypted /
    // helper-required / protected-executable) is exactly the detector flagging
    // the variant as unsupported. A `Failed` status is only *bad* detector
    // evidence for the claimed-support concern: a plain archive must produce a
    // clean detector proof, or its patch-back claim is unfounded.
    if entry.variant.expected_classification() == Some(Xp3ProfileClassification::Plain)
        && proof.status == OperationStatus::Failed
    {
        findings.push(finding(
            "xp3.capability.detector_evidence_failed",
            PartialDiagnosticSeverity::P0,
            "detectorFixture",
            "plain XP3 detector proof reported a failed status (bad detector evidence)".to_string(),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }

    // Helper-result evidence (optional): corroborates the helper requirement
    // and keyRef state.
    let helper_result_present = entry.helper_result_fixture.is_some();
    if let Some(helper_rel) = entry.helper_result_fixture.as_deref() {
        let helper_path = fixture_dir.join(helper_rel);
        match read_json::<HelperResult>(&helper_path) {
            Ok(helper) => {
                cross_check_helper_evidence(entry, &proof, &helper, &mut findings);
            }
            Err(error) => findings.push(finding(
                "xp3.capability.helper_result_unreadable",
                PartialDiagnosticSeverity::P0,
                "helperResultFixture",
                format!(
                    "helper result could not be read: {}",
                    redact_for_log_or_report(&error.to_string())
                ),
                SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
            )),
        }
    }

    Ok(DerivedEvidence {
        fixture_id: proof.fixture_id,
        classification: Some(proof.classification),
        patch_capability: proof.patch_capability_level,
        helper_requirement: proof.helper_requirement,
        crypt_profile_status: proof.crypt_profile.status,
        key_ref_present: proof.crypt_profile.key_ref_requirement_present,
        requirement_id: proof.crypt_profile.requirement_id,
        secret_ref: proof.crypt_profile.secret_ref,
        archive_id: proof.archive.archive_id,
        archive_hash: proof.archive.archive_hash,
        entry_count: proof.archive.entry_count,
        helper_result_present,
        findings,
    })
}

fn derive_plaintext_ks_evidence(
    entry: &Xp3CapabilityProfileFixtureEntry,
    fixture_dir: &Path,
) -> Result<DerivedEvidence, Xp3CapabilityFinding> {
    let source_rel = entry.plaintext_source.as_deref().ok_or_else(|| {
        finding(
            "xp3.capability.plaintext_source_missing",
            PartialDiagnosticSeverity::P0,
            "plaintextSource",
            "plaintext_ks variant requires a plaintextSource".to_string(),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        )
    })?;
    let source_path = fixture_dir.join(source_rel);
    let bytes = std::fs::read(&source_path).map_err(|error| {
        finding(
            "xp3.capability.plaintext_source_unreadable",
            PartialDiagnosticSeverity::P0,
            "plaintextSource",
            format!(
                "plaintext source could not be read: {}",
                redact_for_log_or_report(&error.to_string())
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        )
    })?;

    let mut findings = Vec::new();
    // A null container is plaintext — it must NOT carry the XP3 archive magic.
    // If it does, the entry is mis-classified (it is really an archive, not the
    // null-container baseline).
    if bytes.starts_with(b"XP3") {
        findings.push(finding(
            "xp3.capability.plaintext_is_archive",
            PartialDiagnosticSeverity::P0,
            "plaintextSource",
            "plaintext_ks source carries XP3 archive magic; it is not a null container".to_string(),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }

    let archive_hash = ProofHash::new(sha256_hash_bytes(&bytes))
        .map_err(|error| internal_finding("plaintext hash", &error))?;

    Ok(DerivedEvidence {
        fixture_id: format!("{}-null-container", entry.entry_id),
        // None classification => derive_support_tier yields NullContainer.
        classification: None,
        // The null container is plaintext; we detect it but do not advance a
        // patch-back claim (that claim belongs to plain XP3 archives only).
        patch_capability: Xp3PatchCapabilityLevel::Detect,
        helper_requirement: Xp3HelperRequirement::NotRequired,
        crypt_profile_status: Xp3CryptProfileStatus::NotRequired,
        key_ref_present: false,
        requirement_id: None,
        secret_ref: None,
        archive_id: "kirikiri-ks-null-container".to_string(),
        archive_hash,
        entry_count: None,
        helper_result_present: false,
        findings,
    })
}

/// Cross-check a helper result against the detector evidence: a
/// helper-required archive must carry a helper-required diagnostic, and the
/// helper's keyRef requirement id must match the crypt-profile requirement id.
fn cross_check_helper_evidence(
    entry: &Xp3CapabilityProfileFixtureEntry,
    proof: &crate::Xp3ProfileProofReport,
    helper: &HelperResult,
    findings: &mut Vec<Xp3CapabilityFinding>,
) {
    if entry.variant == Xp3CapabilityVariant::HelperRequiredXp3
        && helper.diagnostic.code != HelperDiagnosticCode::HelperRequired
    {
        findings.push(finding(
            "xp3.capability.helper_diagnostic_mismatch",
            PartialDiagnosticSeverity::P0,
            "helperResultFixture",
            "helper-required variant must reference a helper result whose diagnostic is helper_required"
                .to_string(),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }
    if let Some(requirement_id) = proof.crypt_profile.requirement_id.as_deref() {
        let matches = helper
            .secret_refs
            .iter()
            .any(|secret| secret.requirement_id == requirement_id);
        if !matches {
            findings.push(finding(
                "xp3.capability.helper_requirement_id_mismatch",
                PartialDiagnosticSeverity::P0,
                "helperResultFixture",
                "helper result declares no secretRef matching the crypt-profile requirement id"
                    .to_string(),
                SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
            ));
        }
    }
}

fn validate_detector_evidence(
    entry: &Xp3CapabilityProfileFixtureEntry,
    evidence: &DerivedEvidence,
    findings: &mut Vec<Xp3CapabilityFinding>,
) {
    match (
        entry.variant.expected_classification(),
        evidence.classification,
    ) {
        // Variants with a fixed required classification.
        (Some(required), Some(actual)) if required != actual => {
            findings.push(finding(
                "xp3.capability.detector_classification_mismatch",
                PartialDiagnosticSeverity::P0,
                "variant",
                format!(
                    "variant {} requires detector classification {} but evidence routed {}",
                    entry.variant.as_str(),
                    required.as_str(),
                    actual.as_str()
                ),
                SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
            ));
        }
        // Universal-dump: any non-plain archive is acceptable; a plain one is
        // a mis-route (universal dump is for archives nothing else patches).
        (None, Some(Xp3ProfileClassification::Plain))
            if entry.variant == Xp3CapabilityVariant::UniversalDump =>
        {
            findings.push(finding(
                "xp3.capability.universal_dump_on_plain",
                PartialDiagnosticSeverity::P0,
                "variant",
                "universal_dump must route to a non-plain archive (plain XP3 is the claimed-support concern)"
                    .to_string(),
                SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
            ));
        }
        _ => {}
    }

    // The author's declared classification, when present, must also match.
    if let (Some(declared), actual) = (entry.expected.classification, evidence.classification)
        && Some(declared) != actual
    {
        findings.push(finding(
            "xp3.capability.declared_classification_mismatch",
            PartialDiagnosticSeverity::P0,
            "expected.classification",
            format!(
                "entry declared classification {} but evidence routed {}",
                declared.as_str(),
                actual.map_or("none", Xp3ProfileClassification::as_str)
            ),
            SEMANTIC_CAPABILITY_EVIDENCE_MISMATCH,
        ));
    }
}

fn failed_entry(
    entry: &Xp3CapabilityProfileFixtureEntry,
    source_node_id: &str,
    validation_command: &str,
    finding: Xp3CapabilityFinding,
) -> Xp3CapabilityProfileEntryReport {
    // A placeholder archive hash for the empty byte stream so the report is
    // well-formed; the blocking finding + Failed status make it clear no
    // archive evidence was actually inspected.
    let archive_hash = ProofHash::new(sha256_hash_bytes(&[]))
        .unwrap_or_else(|_| unreachable!("empty sha256 is a valid proof hash"));
    Xp3CapabilityProfileEntryReport {
        entry_id: entry.entry_id.clone(),
        source_node_id: source_node_id.to_string(),
        fixture_id: format!("{}-unresolved", entry.entry_id),
        engine_variant: entry.variant,
        workflow: entry.workflow.clone(),
        archive_profile: Xp3CapabilityArchiveProfile {
            archive_id: "unresolved".to_string(),
            archive_hash,
            entry_count: None,
        },
        key_helper_requirement: Xp3CapabilityKeyHelperRequirement {
            helper_requirement: Xp3HelperRequirement::NotRequired,
            crypt_profile_status: Xp3CryptProfileStatus::NotRequired,
            key_ref_present: false,
            requirement_id: None,
            secret_ref: None,
            helper_result_present: entry.helper_result_fixture.is_some(),
        },
        capability_tuple: Xp3CapabilityTuple {
            support_tier: Xp3CapabilitySupportTier::Research,
            classification: None,
            patch_capability: Xp3PatchCapabilityLevel::Unsupported,
        },
        validation_command: validation_command.to_string(),
        redaction_status: "redacted".to_string(),
        status: OperationStatus::Failed,
        findings: vec![finding],
    }
}

// --- Helpers ----------------------------------------------------------------

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
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn manifest_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("fixtures/kaifuu/kirikiri")
    }

    fn load_fixture() -> Xp3CapabilityProfileFixture {
        let path = manifest_dir().join("xp3-capability-profile.json");
        read_json(&path).expect("capability-profile manifest must parse")
    }

    fn generate(fixture: &Xp3CapabilityProfileFixture) -> Xp3CapabilityProfileReport {
        generate_xp3_capability_profile(Xp3CapabilityProfileRequest {
            fixture,
            fixture_dir: &manifest_dir(),
            fixture_file_name: "xp3-capability-profile.json",
        })
        .expect("generation must not error environmentally")
    }

    fn entry_mut<'a>(
        fixture: &'a mut Xp3CapabilityProfileFixture,
        entry_id: &str,
    ) -> &'a mut Xp3CapabilityProfileFixtureEntry {
        fixture
            .entries
            .iter_mut()
            .find(|entry| entry.entry_id == entry_id)
            .expect("entry must exist")
    }

    fn has_finding(report: &Xp3CapabilityProfileReport, entry_id: &str, code: &str) -> bool {
        report
            .entry(entry_id)
            .is_some_and(|entry| entry.findings.iter().any(|finding| finding.code == code))
    }

    // --- Generation is evidence-driven and the happy path is green. --------

    #[test]
    fn capability_profile_generated_from_evidence_passes() {
        let fixture = load_fixture();
        let report = generate(&fixture);
        assert_eq!(
            report.status,
            OperationStatus::Passed,
            "{:?}",
            report.entries
        );
        assert_eq!(report.entries.len(), 6);
        for entry in &report.entries {
            assert_eq!(
                entry.status,
                OperationStatus::Passed,
                "entry {} failed: {:?}",
                entry.entry_id,
                entry.findings
            );
            // Every entry records the full acceptance tuple of provenance.
            assert_eq!(entry.source_node_id, "KAIFUU-054");
            assert!(!entry.fixture_id.is_empty());
            assert!(
                entry
                    .validation_command
                    .starts_with("kaifuu xp3 capability-profile --fixture")
            );
            assert_eq!(entry.redaction_status, "redacted");
        }
    }

    #[test]
    fn plain_is_the_only_claimed_tier_and_ks_is_null_container() {
        let fixture = load_fixture();
        let report = generate(&fixture);

        let plain = report.entry("plain-xp3").unwrap();
        assert_eq!(
            plain.capability_tuple.support_tier,
            Xp3CapabilitySupportTier::Claimed
        );
        assert_eq!(
            plain.capability_tuple.patch_capability,
            Xp3PatchCapabilityLevel::PatchBack
        );

        // The .ks null container is its OWN tier — never the commercial baseline
        // (which is the claimed plain-XP3 tier).
        let ks = report.entry("plaintext-ks-null-container").unwrap();
        assert_eq!(
            ks.capability_tuple.support_tier,
            Xp3CapabilitySupportTier::NullContainer
        );
        assert_ne!(
            ks.capability_tuple.support_tier,
            Xp3CapabilitySupportTier::Claimed
        );

        // Every non-plain archive variant is research-tier with no patch claim.
        for entry_id in [
            "encrypted-xp3",
            "helper-required-xp3",
            "protected-executable",
            "universal-dump",
        ] {
            let entry = report.entry(entry_id).unwrap();
            assert_eq!(
                entry.capability_tuple.support_tier,
                Xp3CapabilitySupportTier::Research,
                "{entry_id} must be research-tier"
            );
            assert_ne!(
                entry.capability_tuple.patch_capability,
                Xp3PatchCapabilityLevel::PatchBack,
                "{entry_id} must not claim patch-back"
            );
        }
    }

    // --- THE mechanical line. ----------------------------------------------

    #[test]
    fn encrypted_variant_can_never_be_claimed() {
        // Pure mechanical rule: no non-plain classification, under any patch
        // capability, can ever reach the Claimed tier.
        for classification in [
            Xp3ProfileClassification::Encrypted,
            Xp3ProfileClassification::Compressed,
            Xp3ProfileClassification::HelperRequired,
            Xp3ProfileClassification::UnsupportedProtectedExecutable,
        ] {
            for patch in [
                Xp3PatchCapabilityLevel::Detect,
                Xp3PatchCapabilityLevel::Extract,
                Xp3PatchCapabilityLevel::PatchBack,
                Xp3PatchCapabilityLevel::Unsupported,
            ] {
                assert_ne!(
                    derive_support_tier(Some(classification), patch),
                    Xp3CapabilitySupportTier::Claimed,
                    "{} + {} must never be claimed",
                    classification.as_str(),
                    patch.as_str()
                );
            }
        }
        // Only plain + patch_back yields Claimed.
        assert_eq!(
            derive_support_tier(
                Some(Xp3ProfileClassification::Plain),
                Xp3PatchCapabilityLevel::PatchBack
            ),
            Xp3CapabilitySupportTier::Claimed
        );
        // Plain without patch_back does not.
        assert_eq!(
            derive_support_tier(
                Some(Xp3ProfileClassification::Plain),
                Xp3PatchCapabilityLevel::Detect
            ),
            Xp3CapabilitySupportTier::Research
        );
        assert_eq!(
            derive_support_tier(None, Xp3PatchCapabilityLevel::Detect),
            Xp3CapabilitySupportTier::NullContainer
        );
    }

    #[test]
    fn declaring_a_patch_claim_on_an_encrypted_variant_is_a_blocking_overclaim() {
        let mut fixture = load_fixture();
        let entry = entry_mut(&mut fixture, "encrypted-xp3");
        entry.expected.support_tier = Xp3CapabilitySupportTier::Claimed;
        entry.expected.patch_capability = Xp3PatchCapabilityLevel::PatchBack;
        let report = generate(&fixture);

        assert_eq!(report.status, OperationStatus::Failed);
        assert!(has_finding(
            &report,
            "encrypted-xp3",
            "xp3.capability.encrypted_patch_overclaim"
        ));
        // Crucially: the GENERATED tuple still refuses the claim — the manifest
        // cannot talk the variant into a claimed patch capability.
        let entry = report.entry("encrypted-xp3").unwrap();
        assert_eq!(
            entry.capability_tuple.support_tier,
            Xp3CapabilitySupportTier::Research
        );
        assert_ne!(
            entry.capability_tuple.patch_capability,
            Xp3PatchCapabilityLevel::PatchBack
        );
    }

    // --- Validator fails on each evidence class. ---------------------------

    #[test]
    fn validator_fails_on_bad_detector_evidence() {
        let mut fixture = load_fixture();
        // Point the plain entry's detector evidence at the encrypted archive.
        entry_mut(&mut fixture, "plain-xp3").detector_fixture =
            Some("xp3-encrypted-profile.json".to_string());
        let report = generate(&fixture);

        assert_eq!(report.status, OperationStatus::Failed);
        assert!(has_finding(
            &report,
            "plain-xp3",
            "xp3.capability.detector_classification_mismatch"
        ));
    }

    #[test]
    fn validator_fails_on_helper_requirement_mismatch() {
        let mut fixture = load_fixture();
        entry_mut(&mut fixture, "encrypted-xp3")
            .expected
            .helper_requirement = Xp3HelperRequirement::Required;
        let report = generate(&fixture);

        assert_eq!(report.status, OperationStatus::Failed);
        assert!(has_finding(
            &report,
            "encrypted-xp3",
            "xp3.capability.helper_requirement_mismatch"
        ));
    }

    #[test]
    fn validator_fails_on_key_ref_state_mismatch() {
        let mut fixture = load_fixture();
        entry_mut(&mut fixture, "encrypted-xp3")
            .expected
            .key_ref_present = false;
        let report = generate(&fixture);

        assert_eq!(report.status, OperationStatus::Failed);
        assert!(has_finding(
            &report,
            "encrypted-xp3",
            "xp3.capability.key_ref_state_mismatch"
        ));
    }

    #[test]
    fn validator_fails_on_archive_hash_mismatch() {
        let mut fixture = load_fixture();
        entry_mut(&mut fixture, "plain-xp3").expected.archive_hash =
            ProofHash::new(format!("sha256:{}", "0".repeat(64))).unwrap();
        let report = generate(&fixture);

        assert_eq!(report.status, OperationStatus::Failed);
        assert!(has_finding(
            &report,
            "plain-xp3",
            "xp3.capability.archive_hash_mismatch"
        ));
    }

    #[test]
    fn validator_fails_on_patch_capability_tuple_mismatch() {
        let mut fixture = load_fixture();
        let entry = entry_mut(&mut fixture, "plain-xp3");
        entry.expected.patch_capability = Xp3PatchCapabilityLevel::Unsupported;
        let report = generate(&fixture);

        assert_eq!(report.status, OperationStatus::Failed);
        assert!(has_finding(
            &report,
            "plain-xp3",
            "xp3.capability.patch_tuple_mismatch"
        ));
    }

    // --- Redaction: counts / hashes only, never raw bytes. -----------------

    #[test]
    fn report_redacts_secrets_and_never_carries_raw_bytes() {
        let mut fixture = load_fixture();
        // A profile id carrying a private local path must be scrubbed (the
        // "local paths" redaction concern from the acceptance).
        fixture.capability_profile_id = "/home/trevor/private/game/leak.xp3".to_string();
        let report = generate(&fixture);
        let json = report.stable_json().expect("stable json");

        // The redaction sentinel replaced the path-bearing id.
        assert!(json.contains("[REDACTED:"));
        assert!(!json.contains("/home/trevor/private/game/leak.xp3"));

        // The raw .ks source text never appears — only its hash and counts do.
        let ks_bytes = std::fs::read(manifest_dir().join("plain-script.ks")).unwrap();
        let ks_text = String::from_utf8_lossy(&ks_bytes);
        for line in ks_text.lines().filter(|line| line.len() > 8) {
            assert!(
                !json.contains(line.trim()),
                "raw .ks source line leaked into the report: {line}"
            );
        }
        // The .ks evidence is present as a hash, not bytes.
        assert!(json.contains(&sha256_hash_bytes(&ks_bytes)));
    }

    #[test]
    fn missing_detector_evidence_is_a_blocking_finding_not_a_panic() {
        let mut fixture = load_fixture();
        entry_mut(&mut fixture, "plain-xp3").detector_fixture = None;
        let report = generate(&fixture);

        assert_eq!(report.status, OperationStatus::Failed);
        assert!(has_finding(
            &report,
            "plain-xp3",
            "xp3.capability.detector_fixture_missing"
        ));
    }
}
