//! Siglus key-profile and parser proof composition.
//! A *Siglus profile proof* COMPOSES the already-built Siglus slices into one
//! honestly-scoped, redacted proof report over a **synthetic** profile fixture:
//! - the **detector** slice ([`crate::DetectionResult`] from
//!   `kaifuu_engine_fixture::SiglusProfileDetectorAdapter`) — detector evidence;
//! - the **key-boundary** slice (known-key profile id + secret-ref
//!   surfaced through the parser-boundary key-refs) — key profile id;
//! - the **parser-boundary** slice
//!   ([`crate::run_siglus_known_key_parser_boundary_smoke`]) — parser profile id
//!   and outcome;
//! - the **redacted validation** slice — the compat-profile validator
//!   ([`crate::compat_profile::validate_claimed_support_tuple`]) and the
//!   094 redaction boundary
//!   ([`crate::validate_secret_redaction_boundary`]).
//!   HONEST SCOPE (the whole point): this proves the SYNTHETIC composition. It does
//!   **not** claim broad commercial Siglus compatibility — the real Siglus
//!   extract/decrypt/repack core stays `NotImplemented` in `kaifuu_siglus`. The
//!   [`SiglusProfileCapabilityLevel`] the report records is capped at
//!   `known-key-extract`; `broad_commercial_claim` is always `false`; a fixture
//!   that declares a level above the evidence ceiling is a blocking overclaim
//!   diagnostic, never a silent pass.
//!   DEEP-SCAN, FAIL-LOUD (acceptance 2): before any persisted artifact is
//!   produced, the fully-composed report is deep-scanned. A seeded raw key, helper
//!   dump, private path, or decrypted private text makes
//!   [`compose_siglus_profile_proof`] return `Err` — nothing is returned to write.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::compat_profile::{ClaimedSupportEntryReport, ClaimedSupportLevel, is_real_patch_back};
use crate::{
    DetectionResult, EvidenceStatus, HelperRedactionStatus, KaifuuResult, OperationStatus,
    PartialDiagnosticSeverity, PatchBackTransform, ProofHash, SecretRef,
    SiglusParserBoundaryOutcome, SiglusParserBoundaryReport, redact_for_log_or_report, stable_json,
    validate_secret_redaction_boundary,
};

pub const SIGLUS_PROFILE_PROOF_SCHEMA_VERSION: &str = "0.1.0";

/// The honest-scope support boundary surfaced in every profile-proof report.
pub const SIGLUS_PROFILE_PROOF_SUPPORT_BOUNDARY: &str = "Siglus profile proof COMPOSES the detector, known-key key-profile, parser-boundary, and redacted compat-profile validation slices over a SYNTHETIC profile fixture. It is honestly scoped: no broad commercial Siglus compatibility is claimed. The real Scene.pck/Gameexe.dat decrypt/extract/repack core is NotImplemented; the capability level is capped at known-key-extract and every persisted string is deep-scanned before write.";

/// Semantic code: the composed report failed the deep secret-leak scan.
pub const SEMANTIC_SIGLUS_PROFILE_PROOF_SECRET_LEAK: &str =
    "kaifuu.siglus.profile_proof.secret_leak";
/// Semantic code: the declared capability level overclaims past the evidence
/// ceiling (e.g. claims patch-verify when the extract/patch core is unimplemented).
pub const SEMANTIC_SIGLUS_PROFILE_PROOF_CAPABILITY_OVERCLAIM: &str =
    "kaifuu.siglus.profile_proof.capability_overclaim";
/// Semantic code: the detector slice did not identify a Siglus profile.
pub const SEMANTIC_SIGLUS_PROFILE_PROOF_DETECTOR_MISMATCH: &str =
    "kaifuu.siglus.profile_proof.detector_mismatch";
/// Semantic code: an underlying slice (parser boundary / compat validation)
/// failed, so the composition cannot be a passing proof.
pub const SEMANTIC_SIGLUS_PROFILE_PROOF_SLICE_FAILED: &str =
    "kaifuu.siglus.profile_proof.slice_failed";

// Honest capability vocabulary (shares the renderer's levels).

/// The honestly-scoped capability level a Siglus profile proof may record.
/// This mirrors the redacted-validation renderer's `CAPABILITY_LEVELS`.
/// There is deliberately **no** "broad commercial" variant — the type cannot
/// express an overclaim. The evidence ceiling for THIS node is
/// [`Self::KnownKeyExtract`]; [`Self::KnownKeyPatchVerify`] requires a real
/// patch-back evidence chain the Siglus core does not yet have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SiglusProfileCapabilityLevel {
    DetectOnly,
    KnownKeyExtract,
    KnownKeyPatchVerify,
    BroadUnsupported,
}

impl SiglusProfileCapabilityLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DetectOnly => "detect-only",
            Self::KnownKeyExtract => "known-key-extract",
            Self::KnownKeyPatchVerify => "known-key-patch-verify",
            Self::BroadUnsupported => "broad-unsupported",
        }
    }

    /// The monotonic claim rank used by the anti-overclaim gate. `BroadUnsupported`
    /// is an explicit "we do not support this" declaration and never overclaims,
    /// so it ranks at the bottom alongside `DetectOnly`.
    fn claim_rank(self) -> u8 {
        match self {
            Self::BroadUnsupported | Self::DetectOnly => 0,
            Self::KnownKeyExtract => 1,
            Self::KnownKeyPatchVerify => 2,
        }
    }
}

// Fixture (synthetic, deserialized from `--fixture <json>`).

/// A synthetic Siglus profile-proof fixture. Carries only logical ids, relative
/// input paths, and the honest capability claim — never raw keys or corpus bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiglusProfileProofFixture {
    pub schema_version: String,
    pub fixture_id: String,
    pub profile_id: String,
    /// Detector game directory (Scene.pck / Gameexe.dat), relative to the
    /// fixture file's directory. Consumed by the detector slice only; never
    /// persisted to the report.
    pub detector_game_dir: String,
    pub parser: SiglusProfileProofFixtureParser,
    pub key_profile: SiglusProfileProofFixtureKeyProfile,
    /// Compat-profile claimed-support tuple JSON, relative to the fixture dir.
    pub compat_tuple: String,
    pub capability_level: SiglusProfileCapabilityLevel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiglusProfileProofFixtureParser {
    pub parser_profile_id: String,
    /// Scene.pck, relative to the fixture dir.
    pub scene: String,
    /// Gameexe.dat, relative to the fixture dir.
    pub gameexe: String,
    /// key-ref helper request JSON, relative to the fixture dir.
    pub key_request: String,
    pub variant: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiglusProfileProofFixtureKeyProfile {
    pub key_profile_id: String,
    pub secret_ref: SecretRef,
}

// Composition input (already-run slice outputs).

/// The already-computed outputs of the composed slices. The CLI runs each real
/// slice (detector adapter, parser-boundary smoke, compat validator) and hands
/// the results here; `compose_siglus_profile_proof` records and cross-checks them.
#[derive(Debug, Clone, Copy)]
pub struct SiglusProfileProofComposeInput<'a> {
    pub fixture: &'a SiglusProfileProofFixture,
    pub detection: &'a DetectionResult,
    pub parser_boundary: &'a SiglusParserBoundaryReport,
    pub compat_entry: &'a ClaimedSupportEntryReport,
}

// Report.

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusProfileProofReport {
    pub schema_version: String,
    pub fixture_id: String,
    pub profile_id: String,
    pub status: OperationStatus,
    pub support_boundary: String,
    /// Always `false`: the composition never claims broad commercial support.
    pub broad_commercial_claim: bool,
    pub capability_level: SiglusProfileCapabilityLevel,
    pub detector: SiglusProfileProofDetector,
    pub key_profile: SiglusProfileProofKeyProfile,
    pub parser_profile: SiglusProfileProofParserProfile,
    pub compat: SiglusProfileProofCompat,
    pub redaction_summary: SiglusProfileProofRedactionSummary,
    pub diagnostics: Vec<SiglusProfileProofDiagnostic>,
}

impl SiglusProfileProofReport {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            profile_id: redact_for_log_or_report(&self.profile_id),
            status: self.status.clone(),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            broad_commercial_claim: self.broad_commercial_claim,
            capability_level: self.capability_level,
            detector: self.detector.redacted_for_report(),
            key_profile: self.key_profile.redacted_for_report(),
            parser_profile: self.parser_profile.redacted_for_report(),
            compat: self.compat.redacted_for_report(),
            redaction_summary: self.redaction_summary.clone(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(SiglusProfileProofDiagnostic::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusProfileProofDetector {
    pub adapter_id: String,
    pub detected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected_variant: Option<String>,
    pub evidence: Vec<SiglusProfileProofDetectorEvidence>,
}

impl SiglusProfileProofDetector {
    fn redacted_for_report(&self) -> Self {
        Self {
            adapter_id: redact_for_log_or_report(&self.adapter_id),
            detected: self.detected,
            engine_family: self.engine_family.as_deref().map(redact_for_log_or_report),
            detected_variant: self
                .detected_variant
                .as_deref()
                .map(redact_for_log_or_report),
            evidence: self
                .evidence
                .iter()
                .map(SiglusProfileProofDetectorEvidence::redacted_for_report)
                .collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusProfileProofDetectorEvidence {
    pub path: String,
    pub kind: String,
    pub status: EvidenceStatus,
}

impl SiglusProfileProofDetectorEvidence {
    fn redacted_for_report(&self) -> Self {
        Self {
            path: redact_for_log_or_report(&self.path),
            kind: redact_for_log_or_report(&self.kind),
            status: self.status.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusProfileProofKeyProfile {
    pub key_profile_id: String,
    pub secret_ref: SecretRef,
    /// Always `true`: extraction is limited to a catalogued known static key.
    pub known_key_only: bool,
    /// Honest core status: the real Siglus extract/decrypt/repack is unimplemented.
    pub extract_core_status: String,
    pub key_refs: Vec<SiglusProfileProofKeyRef>,
}

impl SiglusProfileProofKeyProfile {
    fn redacted_for_report(&self) -> Self {
        Self {
            key_profile_id: redact_for_log_or_report(&self.key_profile_id),
            secret_ref: self.secret_ref.clone(),
            known_key_only: self.known_key_only,
            extract_core_status: redact_for_log_or_report(&self.extract_core_status),
            key_refs: self
                .key_refs
                .iter()
                .map(SiglusProfileProofKeyRef::redacted_for_report)
                .collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusProfileProofKeyRef {
    pub requirement_id: String,
    pub secret_ref: SecretRef,
    pub redaction_status: HelperRedactionStatus,
}

impl SiglusProfileProofKeyRef {
    fn redacted_for_report(&self) -> Self {
        Self {
            requirement_id: redact_for_log_or_report(&self.requirement_id),
            secret_ref: self.secret_ref.clone(),
            redaction_status: self.redaction_status,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusProfileProofParserProfile {
    pub parser_profile_id: String,
    pub outcome: SiglusParserBoundaryOutcome,
    pub status: OperationStatus,
    pub patch_write_attempted: bool,
    pub source_count: u64,
    pub text_slot_count: u64,
    pub scene_hash: ProofHash,
}

impl SiglusProfileProofParserProfile {
    fn redacted_for_report(&self) -> Self {
        Self {
            parser_profile_id: redact_for_log_or_report(&self.parser_profile_id),
            outcome: self.outcome,
            status: self.status.clone(),
            patch_write_attempted: self.patch_write_attempted,
            source_count: self.source_count,
            text_slot_count: self.text_slot_count,
            scene_hash: self.scene_hash.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusProfileProofCompat {
    pub profile_or_fixture_id: String,
    pub claimed_level: ClaimedSupportLevel,
    pub patch_back_mode: PatchBackTransform,
    pub honest: bool,
    pub status: OperationStatus,
    pub diagnostic_count: u64,
}

impl SiglusProfileProofCompat {
    fn redacted_for_report(&self) -> Self {
        Self {
            profile_or_fixture_id: redact_for_log_or_report(&self.profile_or_fixture_id),
            claimed_level: self.claimed_level,
            patch_back_mode: self.patch_back_mode,
            honest: self.honest,
            status: self.status.clone(),
            diagnostic_count: self.diagnostic_count,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusProfileProofRedactionSummary {
    /// Always `true`: the composed report is deep-scanned before it is returned.
    pub deep_scan_performed: bool,
    /// The number of string values examined by the deep scan.
    pub strings_scanned: u64,
    /// Number of secret-leak findings. A persisted report always carries `0`
    /// (any finding fails the composition before a report is returned).
    pub secret_leak_findings: u64,
    /// `true` iff the report is clean against the redaction boundary.
    pub redaction_boundary_ok: bool,
    /// The aggregate redaction status of the composed key-refs.
    pub key_ref_redaction_status: HelperRedactionStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiglusProfileProofDiagnostic {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    pub semantic_code: String,
}

impl SiglusProfileProofDiagnostic {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: redact_for_log_or_report(&self.semantic_code),
        }
    }
}

// Composition.

#[path = "siglus_profile_proof_composition.rs"]
mod composition;
pub use composition::compose_siglus_profile_proof;
