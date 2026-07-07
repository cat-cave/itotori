//! KAIFUU-015 — Siglus key-profile and parser proof composition.
//!
//! A *Siglus profile proof* COMPOSES the already-built Siglus slices into one
//! honestly-scoped, redacted proof report over a **synthetic** profile fixture:
//!
//! - the **detector** slice ([`crate::DetectionResult`] from
//!   `kaifuu_engine_fixture::SiglusProfileDetectorAdapter`) — detector evidence;
//! - the **key-boundary** slice (KAIFUU-070 known-key profile id + secret-ref,
//!   surfaced through the parser-boundary key-refs) — key profile id;
//! - the **parser-boundary** slice
//!   ([`crate::run_siglus_known_key_parser_boundary_smoke`]) — parser profile id
//!   and outcome;
//! - the **redacted validation** slice — the KAIFUU-105 compat-profile validator
//!   ([`crate::compat_profile::validate_claimed_support_tuple`]) and the
//!   KAIFUU-036/094 redaction boundary
//!   ([`crate::validate_secret_redaction_boundary`]).
//!
//! HONEST SCOPE (the whole point): this proves the SYNTHETIC composition. It does
//! **not** claim broad commercial Siglus compatibility — the real Siglus
//! extract/decrypt/repack core stays `NotImplemented` in `kaifuu_siglus`. The
//! [`SiglusProfileCapabilityLevel`] the report records is capped at
//! `known-key-extract`; `broad_commercial_claim` is always `false`; a fixture
//! that declares a level above the evidence ceiling is a blocking overclaim
//! diagnostic, never a silent pass.
//!
//! DEEP-SCAN, FAIL-LOUD (acceptance 2): before any persisted artifact is
//! produced, the fully-composed report is deep-scanned. A seeded raw key, helper
//! dump, private path, or decrypted private text makes
//! [`compose_siglus_profile_proof`] return `Err` — nothing is returned to write.

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

// ---------------------------------------------------------------------------
// Honest capability vocabulary (shares the KAIFUU-094 renderer's levels).
// ---------------------------------------------------------------------------

/// The honestly-scoped capability level a Siglus profile proof may record.
///
/// This mirrors the KAIFUU-094 redacted-validation renderer's `CAPABILITY_LEVELS`.
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

// ---------------------------------------------------------------------------
// Fixture (synthetic, deserialized from `--fixture <json>`).
// ---------------------------------------------------------------------------

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
    /// KAIFUU-087 key-ref helper request JSON, relative to the fixture dir.
    pub key_request: String,
    pub variant: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiglusProfileProofFixtureKeyProfile {
    pub key_profile_id: String,
    pub secret_ref: SecretRef,
}

// ---------------------------------------------------------------------------
// Composition input (already-run slice outputs).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

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
    /// `true` iff the report is clean against the KAIFUU-036/094 redaction boundary.
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

// ---------------------------------------------------------------------------
// Composition.
// ---------------------------------------------------------------------------

/// Compose the Siglus profile proof from the already-run slice outputs.
///
/// Records detector evidence, key-profile id, parser-profile id, capability
/// level, and a redaction summary. Cross-checks (blocking diagnostics → `Failed`
/// status): the detector must have identified a Siglus profile; the parser and
/// compat slices must not themselves be `Failed`; the declared capability level
/// must not overclaim past the evidence ceiling (`known-key-extract`).
///
/// FAIL-LOUD: the fully-composed report is deep-scanned; if any raw key, helper
/// dump, private path, or decrypted private text is present the function returns
/// `Err` — no report is returned, so nothing can be persisted.
pub fn compose_siglus_profile_proof(
    input: SiglusProfileProofComposeInput<'_>,
) -> KaifuuResult<SiglusProfileProofReport> {
    let fixture = input.fixture;
    let detection = input.detection;
    let parser = input.parser_boundary;
    let compat = input.compat_entry;

    let mut diagnostics: Vec<SiglusProfileProofDiagnostic> = Vec::new();

    // --- Detector slice -----------------------------------------------------
    let detector_is_siglus =
        detection.detected && detection.engine_family.as_deref() == Some("siglus");
    if !detector_is_siglus {
        diagnostics.push(SiglusProfileProofDiagnostic {
            code: "detector_mismatch".to_string(),
            severity: PartialDiagnosticSeverity::P1,
            field: "detector".to_string(),
            message: "detector slice did not identify a Siglus profile for the fixture game dir"
                .to_string(),
            semantic_code: SEMANTIC_SIGLUS_PROFILE_PROOF_DETECTOR_MISMATCH.to_string(),
        });
    }
    let detector = SiglusProfileProofDetector {
        adapter_id: detection.adapter_id.clone(),
        detected: detection.detected,
        engine_family: detection.engine_family.clone(),
        detected_variant: detection.detected_variant.clone(),
        evidence: detection
            .evidence
            .iter()
            .map(|evidence| SiglusProfileProofDetectorEvidence {
                path: evidence.path.clone(),
                kind: evidence.kind.clone(),
                status: evidence.status.clone(),
            })
            .collect(),
    };

    // --- Parser-boundary slice ---------------------------------------------
    if parser.status == OperationStatus::Failed {
        diagnostics.push(SiglusProfileProofDiagnostic {
            code: "parser_boundary_failed".to_string(),
            severity: PartialDiagnosticSeverity::P1,
            field: "parserProfile".to_string(),
            message: "parser-boundary slice reported a failed outcome".to_string(),
            semantic_code: SEMANTIC_SIGLUS_PROFILE_PROOF_SLICE_FAILED.to_string(),
        });
    }
    let scene_hash = parser
        .sources
        .first()
        .map_or_else(zeroed_proof_hash, |source| source.source_hash.clone());
    let parser_profile = SiglusProfileProofParserProfile {
        parser_profile_id: fixture.parser.parser_profile_id.clone(),
        outcome: parser.outcome,
        status: parser.status.clone(),
        patch_write_attempted: parser.patch_write_attempted,
        source_count: parser.sources.len() as u64,
        text_slot_count: parser.text_slots.len() as u64,
        scene_hash,
    };

    // --- Key-profile slice (KAIFUU-070 known-key, extract core NotImplemented)
    let key_refs: Vec<SiglusProfileProofKeyRef> = parser
        .key_refs
        .iter()
        .map(|key_ref| SiglusProfileProofKeyRef {
            requirement_id: key_ref.requirement_id.clone(),
            secret_ref: key_ref.secret_ref.clone(),
            redaction_status: key_ref.redaction_status,
        })
        .collect();
    let key_ref_redaction_status = aggregate_redaction_status(&key_refs);
    let key_profile = SiglusProfileProofKeyProfile {
        key_profile_id: fixture.key_profile.key_profile_id.clone(),
        secret_ref: fixture.key_profile.secret_ref.clone(),
        known_key_only: true,
        extract_core_status: "not_implemented".to_string(),
        key_refs,
    };

    // --- Redacted-validation slice (KAIFUU-105 compat-profile) -------------
    if compat.status == OperationStatus::Failed {
        diagnostics.push(SiglusProfileProofDiagnostic {
            code: "compat_validation_failed".to_string(),
            severity: PartialDiagnosticSeverity::P1,
            field: "compat".to_string(),
            message: "compat-profile validation reported an overclaim / failed tuple".to_string(),
            semantic_code: SEMANTIC_SIGLUS_PROFILE_PROOF_SLICE_FAILED.to_string(),
        });
    }
    let compat_report = SiglusProfileProofCompat {
        profile_or_fixture_id: compat.profile_or_fixture_id.clone(),
        claimed_level: compat.claimed_level,
        patch_back_mode: compat.patch_back_mode,
        honest: compat.status == OperationStatus::Passed,
        status: compat.status.clone(),
        diagnostic_count: compat.diagnostics.len() as u64,
    };

    // --- Honest-scope anti-overclaim gate ----------------------------------
    // The evidence ceiling is derived from the compat entry. Because the Siglus
    // extract/patch core is NotImplemented, patch-back is never a real write mode
    // here, so the ceiling can never exceed `known-key-extract`.
    let ceiling = capability_ceiling_from_compat(compat);
    if fixture.capability_level.claim_rank() > ceiling.claim_rank() {
        diagnostics.push(SiglusProfileProofDiagnostic {
            code: "capability_overclaim".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: "capabilityLevel".to_string(),
            message: format!(
                "declared capability level {} overclaims past the evidence ceiling {}",
                fixture.capability_level.as_str(),
                ceiling.as_str()
            ),
            semantic_code: SEMANTIC_SIGLUS_PROFILE_PROOF_CAPABILITY_OVERCLAIM.to_string(),
        });
    }

    let status = if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity.is_blocking())
    {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    // Assemble the report body WITHOUT the redaction summary, deep-scan it, then
    // attach the summary. The summary carries only counts + a boolean, so it
    // cannot itself hold a secret.
    let mut report = SiglusProfileProofReport {
        schema_version: SIGLUS_PROFILE_PROOF_SCHEMA_VERSION.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        profile_id: fixture.profile_id.clone(),
        status,
        support_boundary: SIGLUS_PROFILE_PROOF_SUPPORT_BOUNDARY.to_string(),
        broad_commercial_claim: false,
        capability_level: fixture.capability_level,
        detector,
        key_profile,
        parser_profile,
        compat: compat_report,
        redaction_summary: SiglusProfileProofRedactionSummary {
            deep_scan_performed: false,
            strings_scanned: 0,
            secret_leak_findings: 0,
            redaction_boundary_ok: false,
            key_ref_redaction_status,
        },
        diagnostics,
    };

    // FAIL-LOUD deep scan (acceptance 2). Scan the raw, un-redacted body so a
    // seeded secret cannot be silently scrubbed and then written.
    let body = serde_json::to_value(&report)
        .map_err(|error| format!("profile-proof serialization: {error}"))?;
    let scan = deep_scan_persisted_artifact(&body);
    if scan.finding_count > 0 {
        return Err(format!(
            "{SEMANTIC_SIGLUS_PROFILE_PROOF_SECRET_LEAK}: refusing to persist a Siglus profile-proof artifact carrying secret-shaped material ({} finding(s), first field: {})",
            scan.finding_count,
            scan.first_field.as_deref().unwrap_or("<unknown>"),
        )
        .into());
    }

    report.redaction_summary = SiglusProfileProofRedactionSummary {
        deep_scan_performed: true,
        strings_scanned: scan.strings_scanned,
        secret_leak_findings: 0,
        redaction_boundary_ok: true,
        key_ref_redaction_status,
    };

    Ok(report)
}

/// Derive the honest capability ceiling from the validated compat entry.
fn capability_ceiling_from_compat(
    compat: &ClaimedSupportEntryReport,
) -> SiglusProfileCapabilityLevel {
    // An overclaimed / failed tuple grants no capability beyond detection.
    if compat.status != OperationStatus::Passed {
        return SiglusProfileCapabilityLevel::DetectOnly;
    }
    match compat.claimed_level {
        ClaimedSupportLevel::Identify | ClaimedSupportLevel::Inventory => {
            SiglusProfileCapabilityLevel::DetectOnly
        }
        // Extract with a real patch-back write mode would be patch-verify, but the
        // Siglus core has no real patch-back, so extract caps at known-key-extract.
        ClaimedSupportLevel::Extract => SiglusProfileCapabilityLevel::KnownKeyExtract,
        ClaimedSupportLevel::Patch | ClaimedSupportLevel::Helper | ClaimedSupportLevel::Runtime => {
            if is_real_patch_back(compat.patch_back_mode) {
                SiglusProfileCapabilityLevel::KnownKeyPatchVerify
            } else {
                SiglusProfileCapabilityLevel::KnownKeyExtract
            }
        }
    }
}

/// The `sha256:` of the empty input. Used only as an unreachable fallback when
/// the parser slice reports no sources (it always reports Scene.pck + Gameexe.dat).
fn zeroed_proof_hash() -> ProofHash {
    ProofHash::new(
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string(),
    )
    .expect("static empty-input sha256 ref is valid")
}

fn aggregate_redaction_status(key_refs: &[SiglusProfileProofKeyRef]) -> HelperRedactionStatus {
    if key_refs
        .iter()
        .any(|key_ref| key_ref.redaction_status == HelperRedactionStatus::Failed)
    {
        HelperRedactionStatus::Failed
    } else if key_refs
        .iter()
        .any(|key_ref| key_ref.redaction_status == HelperRedactionStatus::Redacted)
    {
        HelperRedactionStatus::Redacted
    } else {
        HelperRedactionStatus::NotRequired
    }
}

/// Result of the fail-loud deep scan.
struct DeepScanResult {
    strings_scanned: u64,
    finding_count: u64,
    first_field: Option<String>,
}

/// Deep-scan a to-be-persisted artifact for secret-shaped material.
///
/// Combines two boundaries (KAIFUU-036/094): the canonical field-name-gated
/// [`validate_secret_redaction_boundary`] (catches forbidden field NAMES such as
/// `helperDump` / `rawKey`) and a full-string value scan (catches any raw key,
/// local absolute path, forbidden private payload, or private filename in ANY
/// field, via [`redact_for_log_or_report`]).
fn deep_scan_persisted_artifact(value: &Value) -> DeepScanResult {
    let mut strings_scanned = 0u64;
    let mut findings: Vec<String> = Vec::new();
    scan_strings(value, "$", &mut strings_scanned, &mut findings);
    for finding in validate_secret_redaction_boundary(value) {
        findings.push(finding.field);
    }
    let first_field = findings.first().cloned();
    DeepScanResult {
        strings_scanned,
        finding_count: findings.len() as u64,
        first_field,
    }
}

fn scan_strings(value: &Value, field: &str, strings_scanned: &mut u64, findings: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            *strings_scanned += 1;
            if redact_for_log_or_report(text) != *text {
                findings.push(field.to_string());
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                scan_strings(item, &format!("{field}.{index}"), strings_scanned, findings);
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                let child_field = if field == "$" {
                    key.clone()
                } else {
                    format!("{field}.{key}")
                };
                scan_strings(child, &child_field, strings_scanned, findings);
            }
        }
        _ => {}
    }
}
