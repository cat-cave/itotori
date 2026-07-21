//! Wolf RPG Editor archive + protection detector profile fixtures.
//! A *Wolf protection detector profile* records what a Wolf RPG Editor
//! (`.wolf` / DXArchive-family) container reveals about its **protection
//! posture** and mechanically classifies it into one of four detector
//! profiles: [`WolfProtectionProfile::Plain`],
//! [`WolfProtectionProfile::Protected`],
//! [`WolfProtectionProfile::HelperRequired`], and
//! [`WolfProtectionProfile::Unknown`]. It is the Wolf-family sibling of the
//! KiriKiri XP3 capability profile
//! ([`crate::Xp3CapabilityProfileReport`]) and the packed-engine
//! readiness validator ([`crate::PackedReadinessValidationReport`]): it reuses
//! the shared transform vocabulary ([`ContainerTransform`] /
//! [`CryptoTransform`] / [`CodecTransform`] / [`SurfaceTransform`]), the shared
//! capability ladder ([`CapabilityLevel`] / [`CapabilityLevelStatus`]), and the
//! shared semantic-diagnostic taxonomy ([`SemanticErrorCode`]).
//! # Scope (honest boundary — identify-level, synthetic-fixture-driven)
//! This node is a DETECTOR, not a Wolf archive parser. It does NOT open a real
//! `.wolf`/DXA container, walk its file table, or decrypt anything. The
//! fixtures encode the *publicly observable protection posture* a Wolf archive
//! exposes (unencrypted DX archive vs static-key-encrypted vs Wolf "Pro"
//! per-game dynamic-key vs unrecognized) as a small structured signal, and the
//! detector [`derive_wolf_protection_profile`] mechanically classifies that
//! signal into the four profiles with the correct capability tuple and
//! diagnostics. Real Wolf archive extraction / decryption / patch-back is a
//! later adapter node (profile-proof command, helper
//! boundary, encrypted-archive adapter); the dynamic-key helper
//! itself is the continuous-tier boundary. None of those are
//! claimed here.
//! # The mechanical line (computed, never asserted)
//! [`derive_wolf_protection_profile`] is the single source of truth. The
//! profile is a pure function of the recorded protection signal and whether a
//! **concrete key requirement** (secret requirement id) exists:
//! - `unencrypted` → `plain`
//! - `dynamic_key_helper_gated` → `helper_required`
//! - `static_key_protected` WITH a concrete key requirement → `protected`
//! - `static_key_protected` WITHOUT a concrete key requirement → `unknown`
//!   (reports `missing_capability.crypto`)
//! - `unrecognized_protection` → `unknown`
//!   (reports `unknown_engine_variant`)
//!   The capability tuple the detector advertises separates the *identify* and
//!   *inventory* rungs it can claim from the *extract*, *patch*, *helper*, and
//!   *runtime* rungs it can NEVER claim (those are later Wolf nodes). A protected
//!   helper-required / unknown archive can therefore never present a resolved
//!   extract, patch, helper, or runtime capability no matter what the fixture
//!   declares.
//! # Evidence is synthetic, redacted, hash-free-of-keys
//! Fixtures carry NO retail bytes and NO raw key material: only the structured
//! protection signal, the shared transform legs, local-scheme [`SecretRef`]
//! key references, and stable requirement ids. The report is funnelled through
//! [`redact_for_log_or_report`] and serialized via [`stable_json`].

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{
    CapabilityLevelStatus, CodecTransform, ContainerTransform, CryptoTransform, KaifuuResult,
    OperationStatus, PartialDiagnosticSeverity, SecretRef, SemanticErrorCode, SurfaceTransform,
    read_json, redact_for_log_or_report, stable_json,
};

/// Schema version of the detector-profile fixture input.
pub const WOLF_PROTECTION_DETECTOR_SCHEMA_VERSION: &str = "0.1.0";
/// Schema version of the generated detector report.
pub const WOLF_PROTECTION_DETECTOR_REPORT_SCHEMA_VERSION: &str = "0.1.0";
/// The engine family every Wolf detector fixture records.
pub const WOLF_ENGINE_FAMILY: &str = "wolf";

/// The support boundary surfaced in every Wolf detector report.
pub const WOLF_PROTECTION_DETECTOR_SUPPORT_BOUNDARY: &str = "Wolf RPG Editor protection detector classifies a `.wolf`/DXArchive-family container into a plain, protected, helper-required, or unknown protection profile at identify level. It advertises identify (and, for a plain unencrypted archive, inventory) support only; extract, patch, dynamic-key helper, and runtime support are later Wolf nodes (KAIFUU-119/KAIFUU-121/KAIFUU-131 and the KAIFUU-065 helper boundary) and are never claimed. Unknown protection reports unknown_engine_variant or missing_capability.crypto unless a concrete key requirement exists.";

// The four detector protection profiles

/// The mechanically-derived Wolf protection profile — the four detector
/// classifications this node distinguishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WolfProtectionProfile {
    /// Unencrypted DX archive — readable file table, no key material required.
    Plain,
    /// Encrypted DX archive gated by a concrete (static) key requirement.
    Protected,
    /// Wolf "Pro" per-game key that must be recovered by a dynamic-key helper
    /// (the continuous-tier boundary) before extraction is possible.
    HelperRequired,
    /// A Wolf-shaped container whose protection could not be recognized, or a
    /// key-gated container with no concrete key requirement.
    Unknown,
}

impl WolfProtectionProfile {
    /// The four profiles in canonical order.
    pub fn all() -> [Self; 4] {
        [
            Self::Plain,
            Self::Protected,
            Self::HelperRequired,
            Self::Unknown,
        ]
    }

    /// Stable canonical string used in ids, records, and findings.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plain => "plain",
            Self::Protected => "protected",
            Self::HelperRequired => "helper_required",
            Self::Unknown => "unknown",
        }
    }
}

/// Why an archive landed in [`WolfProtectionProfile::Unknown`]. Determines
/// which semantic diagnostic the detector reports (acceptance criterion 4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WolfUnknownReason {
    /// Unrecognized / ambiguous protection → `unknown_engine_variant`.
    UnrecognizedVariant,
    /// Key-gated container with no concrete key requirement →
    /// `missing_capability.crypto`.
    MissingCryptoRequirement,
}

// Protection signal (the classifier input)

/// The publicly observable protection posture a Wolf archive exposes. This is
/// the wolf-specific "crypto/protection state" the fixture records; the
/// detector classifies it into a [`WolfProtectionProfile`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WolfArchiveProtectionSignal {
    /// Readable DX archive header + file table, no encryption.
    Unencrypted,
    /// Encrypted DX archive gated by a known/static key.
    StaticKeyProtected,
    /// Encrypted DX archive whose key must be recovered by a dynamic-key helper
    /// (Wolf "Pro" per-game protection, continuous tier).
    DynamicKeyHelperGated,
    /// A `.wolf`/DXA-shaped container whose protection is unrecognized.
    UnrecognizedProtection,
}

impl WolfArchiveProtectionSignal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unencrypted => "unencrypted",
            Self::StaticKeyProtected => "static_key_protected",
            Self::DynamicKeyHelperGated => "dynamic_key_helper_gated",
            Self::UnrecognizedProtection => "unrecognized_protection",
        }
    }

    /// The canonical shared crypto transform this protection signal maps to.
    /// The validator checks the fixture's declared `crypto` against this.
    pub fn canonical_crypto(self) -> CryptoTransform {
        match self {
            Self::Unencrypted => CryptoTransform::NullKey,
            Self::StaticKeyProtected => CryptoTransform::FixedKey,
            Self::DynamicKeyHelperGated => CryptoTransform::HelperGated,
            Self::UnrecognizedProtection => CryptoTransform::Unknown,
        }
    }
}

// The mechanical classifier (single source of truth)

/// Classify a Wolf archive protection signal into one of the four detector
/// profiles. Total, pure, side-effect-free — the single source of truth
/// exercised directly by the regression tests.
/// `has_concrete_key_requirement` is `true` when the fixture records at least
/// one secret requirement id. A `static_key_protected` archive is only
/// `protected` when it names the concrete key it needs; without one it is
/// `unknown` (reported as `missing_capability.crypto`).
pub fn derive_wolf_protection_profile(
    signal: WolfArchiveProtectionSignal,
    has_concrete_key_requirement: bool,
) -> WolfProtectionProfile {
    match signal {
        WolfArchiveProtectionSignal::Unencrypted => WolfProtectionProfile::Plain,
        WolfArchiveProtectionSignal::DynamicKeyHelperGated => WolfProtectionProfile::HelperRequired,
        WolfArchiveProtectionSignal::StaticKeyProtected if has_concrete_key_requirement => {
            WolfProtectionProfile::Protected
        }
        WolfArchiveProtectionSignal::StaticKeyProtected
        | WolfArchiveProtectionSignal::UnrecognizedProtection => WolfProtectionProfile::Unknown,
    }
}

/// The `Unknown` sub-reason for a signal, or `None` when the signal does not
/// classify to `Unknown`.
fn unknown_reason(
    signal: WolfArchiveProtectionSignal,
    has_concrete_key_requirement: bool,
) -> Option<WolfUnknownReason> {
    match signal {
        WolfArchiveProtectionSignal::UnrecognizedProtection => {
            Some(WolfUnknownReason::UnrecognizedVariant)
        }
        WolfArchiveProtectionSignal::StaticKeyProtected if !has_concrete_key_requirement => {
            Some(WolfUnknownReason::MissingCryptoRequirement)
        }
        _ => None,
    }
}

// Capability tuple (identify/inventory vs extract/patch/helper/runtime)

/// The six-rung capability tuple the detector advertises for a profile. The
/// `identify` and `inventory` rungs the detector may claim are kept mechanically
/// separate from the `extract`, `patch`, `helper`, and `runtime` rungs it can
/// never claim (acceptance criterion 3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfCapabilityTuple {
    pub identify: CapabilityLevelStatus,
    pub inventory: CapabilityLevelStatus,
    pub extract: CapabilityLevelStatus,
    pub patch: CapabilityLevelStatus,
    pub helper: CapabilityLevelStatus,
    pub runtime: CapabilityLevelStatus,
}

impl WolfCapabilityTuple {
    /// True iff the tuple claims no capability strictly above `inventory`. The
    /// mechanical guard the report exposes: a detector profile must never
    /// advertise a resolved extract / patch / helper / runtime capability.
    pub fn is_detector_only(&self) -> bool {
        self.extract.is_unsupported()
            && self.patch.is_unsupported()
            && self.helper.is_unsupported()
            && self.runtime.is_unsupported()
    }
}

/// Reason strings for the rungs the detector never claims (kept per-profile so
/// the tuples are visibly distinct).
const EXTRACT_BOUNDARY: &str =
    "Wolf archive extraction is a later adapter node (KAIFUU-131), not this detector";
const PATCH_BOUNDARY: &str =
    "Wolf archive patch-back/repack is a later adapter node (KAIFUU-131), not this detector";
const RUNTIME_BOUNDARY: &str =
    "Wolf runtime replay is a later utsushi-wolf node, not this detector";

/// Derive the capability tuple for a profile. Every profile is identify-level;
/// only a plain unencrypted archive additionally advertises inventory (its file
/// table is readable without a key). Extract/patch/helper/runtime are always
/// unsupported here.
pub fn derive_wolf_capability_tuple(profile: WolfProtectionProfile) -> WolfCapabilityTuple {
    let identify = match profile {
        WolfProtectionProfile::Plain
        | WolfProtectionProfile::Protected
        | WolfProtectionProfile::HelperRequired => CapabilityLevelStatus::supported(),
        // An unknown/ambiguous container is recognized as Wolf-shaped but its
        // protection variant is not — identify is partial, never a clean claim.
        WolfProtectionProfile::Unknown => CapabilityLevelStatus::partial([
            "Wolf-shaped container recognized but its protection variant is unrecognized",
        ]),
    };
    let inventory = match profile {
        WolfProtectionProfile::Plain => CapabilityLevelStatus::supported(),
        WolfProtectionProfile::Protected => CapabilityLevelStatus::unsupported(
            "encrypted DX archive file table cannot be listed without resolving the key",
        ),
        WolfProtectionProfile::HelperRequired => CapabilityLevelStatus::unsupported(
            "the per-game dynamic key must be recovered before the file table can be listed",
        ),
        WolfProtectionProfile::Unknown => CapabilityLevelStatus::unsupported(
            "unrecognized protection: the file table cannot be listed",
        ),
    };
    // The helper rung is always unsupported by the detector: for a
    // helper-required archive the dynamic-key helper boundary is a later node;
    let helper = match profile {
        WolfProtectionProfile::HelperRequired => CapabilityLevelStatus::unsupported(
            "the dynamic-key helper boundary is KAIFUU-121/KAIFUU-065, not this detector",
        ),
        WolfProtectionProfile::Plain => {
            CapabilityLevelStatus::unsupported("no helper required for a plain unencrypted archive")
        }
        WolfProtectionProfile::Protected => CapabilityLevelStatus::unsupported(
            "a static-key archive needs a key ref, not a dynamic-key helper",
        ),
        WolfProtectionProfile::Unknown => CapabilityLevelStatus::unsupported(
            "no helper can be selected for an unrecognized protection variant",
        ),
    };
    WolfCapabilityTuple {
        identify,
        inventory,
        extract: CapabilityLevelStatus::unsupported(EXTRACT_BOUNDARY),
        patch: CapabilityLevelStatus::unsupported(PATCH_BOUNDARY),
        helper,
        runtime: CapabilityLevelStatus::unsupported(RUNTIME_BOUNDARY),
    }
}

// Diagnostics + the archive/protection diagnostic matrix

/// A structured detector diagnostic — never prose, never silent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfProtectionDiagnostic {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    pub semantic_code: String,
}

impl WolfProtectionDiagnostic {
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

fn diagnostic(
    code: &str,
    severity: PartialDiagnosticSeverity,
    field: &str,
    message: impl Into<String>,
    semantic_code: SemanticErrorCode,
) -> WolfProtectionDiagnostic {
    WolfProtectionDiagnostic {
        code: code.to_string(),
        severity,
        field: field.to_string(),
        message: message.into(),
        semantic_code: semantic_code.as_str().to_string(),
    }
}

/// The protection diagnostics for a classified profile. This is the per-profile
/// row of the archive/protection diagnostic matrix.
fn derive_wolf_protection_diagnostics(
    profile: WolfProtectionProfile,
    unknown_reason: Option<WolfUnknownReason>,
) -> Vec<WolfProtectionDiagnostic> {
    match profile {
        // A plain unencrypted archive is a clean detection: no diagnostics.
        WolfProtectionProfile::Plain => Vec::new(),
        // Protected: the concrete key requirement is recorded; extraction is a
        // later node, so the detector reports an unsupported-layered-transform
        // boundary (NOT missing_capability.crypto — the key IS named).
        WolfProtectionProfile::Protected => vec![diagnostic(
            "wolf.protection.extract_requires_key",
            PartialDiagnosticSeverity::P2,
            "protectionSignal",
            "static-key-protected Wolf archive: extraction requires resolving the recorded key requirement (later adapter node)",
            SemanticErrorCode::UnsupportedLayeredTransform,
        )],
        // Helper-required: the dynamic-key helper boundary applies.
        WolfProtectionProfile::HelperRequired => vec![diagnostic(
            "wolf.protection.dynamic_key_helper_required",
            PartialDiagnosticSeverity::P2,
            "protectionSignal",
            "Wolf \"Pro\" per-game key must be recovered by the dynamic-key helper (KAIFUU-121/KAIFUU-065) before extraction",
            SemanticErrorCode::HelperRequired,
        )],
        // Unknown: exactly one of the two acceptance-required diagnostics.
        WolfProtectionProfile::Unknown => match unknown_reason {
            Some(WolfUnknownReason::MissingCryptoRequirement) => vec![diagnostic(
                "wolf.protection.missing_crypto_capability",
                PartialDiagnosticSeverity::P1,
                "protectionSignal",
                "key-gated Wolf archive with no concrete key requirement: crypto capability is missing",
                SemanticErrorCode::MissingCryptoCapability,
            )],
            // Default to the unrecognized-variant diagnostic.
            Some(WolfUnknownReason::UnrecognizedVariant) | None => vec![diagnostic(
                "wolf.protection.unknown_variant",
                PartialDiagnosticSeverity::P1,
                "protectionSignal",
                "unrecognized Wolf protection variant",
                SemanticErrorCode::UnknownEngineVariant,
            )],
        },
    }
}

/// One row of the archive/protection diagnostic matrix: a profile mapped to the
/// canonical protection posture the detector reports for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfProtectionMatrixRow {
    pub profile: WolfProtectionProfile,
    pub capability_tuple: WolfCapabilityTuple,
    pub diagnostics: Vec<WolfProtectionDiagnostic>,
}

/// The archive/protection diagnostic matrix: every profile mapped to its
/// canonical capability tuple + diagnostics. For the two `Unknown` sub-reasons
/// the matrix carries a row each so both acceptance-required diagnostics
/// (`unknown_engine_variant` and `missing_capability.crypto`) are represented.
pub fn wolf_protection_diagnostic_matrix() -> Vec<WolfProtectionMatrixRow> {
    let mut rows = Vec::new();
    for profile in WolfProtectionProfile::all() {
        if profile == WolfProtectionProfile::Unknown {
            for reason in [
                WolfUnknownReason::UnrecognizedVariant,
                WolfUnknownReason::MissingCryptoRequirement,
            ] {
                rows.push(WolfProtectionMatrixRow {
                    profile,
                    capability_tuple: derive_wolf_capability_tuple(profile),
                    diagnostics: derive_wolf_protection_diagnostics(profile, Some(reason)),
                });
            }
        } else {
            rows.push(WolfProtectionMatrixRow {
                profile,
                capability_tuple: derive_wolf_capability_tuple(profile),
                diagnostics: derive_wolf_protection_diagnostics(profile, None),
            });
        }
    }
    rows
}

// Fixture (input) schema

/// A Wolf protection detector fixture set — a small manifest of synthetic
/// detector profile records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfProtectionDetectorFixture {
    pub schema_version: String,
    /// Stable id for the fixture set (synthetic; no retail names/local paths).
    pub detector_set_id: String,
    /// Provenance node id stamped into generated reports.
    pub source_node_id: String,
    pub engine_family: String,
    pub entries: Vec<WolfProtectionDetectorFixtureEntry>,
}

/// One synthetic Wolf detector profile record. Carries every acceptance field:
/// engine family, variant, container, crypto/protection state, codec, surface,
/// fixture id, secret requirement ids, and (expected) diagnostics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfProtectionDetectorFixtureEntry {
    /// Stable per-record fixture id.
    pub fixture_id: String,
    /// The detected/declared variant label (synthetic, human-readable).
    pub variant: String,
    /// Wolf-shaped container leg (expected `wolf_archive`).
    pub container: ContainerTransform,
    /// The wolf-specific protection state the record encodes.
    pub protection_signal: WolfArchiveProtectionSignal,
    /// The shared crypto transform leg (checked against the signal's canonical
    /// crypto).
    pub crypto: CryptoTransform,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    /// Concrete key requirements (secret requirement ids + optional local-scheme
    /// key refs). Empty for plain and unknown-unrecognized records.
    #[serde(default)]
    pub secret_requirements: Vec<WolfSecretRequirement>,
    /// The profile this record is authored to classify to. The detector
    /// recomputes it from evidence and raises a finding on a mismatch.
    pub expected_profile: WolfProtectionProfile,
    /// The semantic diagnostic codes this record expects. Recomputed from
    /// evidence; a mismatch is a finding.
    #[serde(default)]
    pub expected_semantic_codes: Vec<String>,
}

/// A concrete key requirement recorded by a protected / helper-required record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfSecretRequirement {
    /// Stable id of the key requirement (never raw key bytes).
    pub requirement_id: String,
    /// Local-scheme reference to the key material (never raw key bytes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_ref: Option<SecretRef>,
}

// Report (generated) schema

/// The generated per-record detector report. Echoes every acceptance field and
/// carries the mechanically-derived profile, capability tuple, and diagnostics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfProtectionDetectorEntryReport {
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub variant: String,
    pub container: ContainerTransform,
    pub protection_signal: WolfArchiveProtectionSignal,
    pub crypto: CryptoTransform,
    pub codec: CodecTransform,
    pub surface: SurfaceTransform,
    /// The secret requirement ids this record names (redacted; never key bytes).
    pub secret_requirement_ids: Vec<String>,
    /// The mechanically-derived protection profile (single source of truth).
    pub profile: WolfProtectionProfile,
    pub capability_tuple: WolfCapabilityTuple,
    pub diagnostics: Vec<WolfProtectionDiagnostic>,
    pub status: OperationStatus,
    /// Structured validation findings (declared-vs-derived mismatches).
    pub findings: Vec<WolfProtectionDiagnostic>,
}

impl WolfProtectionDetectorEntryReport {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            variant: redact_for_log_or_report(&self.variant),
            container: self.container,
            protection_signal: self.protection_signal,
            crypto: self.crypto,
            codec: self.codec,
            surface: self.surface,
            secret_requirement_ids: self
                .secret_requirement_ids
                .iter()
                .map(|id| redact_for_log_or_report(id))
                .collect(),
            profile: self.profile,
            capability_tuple: self.capability_tuple.clone(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(WolfProtectionDiagnostic::redacted_for_report)
                .collect(),
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(WolfProtectionDiagnostic::redacted_for_report)
                .collect(),
        }
    }
}

/// The aggregate detector report over a fixture set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfProtectionDetectorReport {
    pub schema_version: String,
    pub detector_set_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub entries: Vec<WolfProtectionDetectorEntryReport>,
}

impl WolfProtectionDetectorReport {
    pub fn entry(&self, fixture_id: &str) -> Option<&WolfProtectionDetectorEntryReport> {
        self.entries
            .iter()
            .find(|entry| entry.fixture_id == fixture_id)
    }

    /// The report's archive/protection diagnostic matrix: each classified
    /// record mapped to its profile → capability tuple + diagnostics.
    pub fn diagnostic_matrix(&self) -> Vec<WolfProtectionMatrixRow> {
        self.entries
            .iter()
            .map(|entry| WolfProtectionMatrixRow {
                profile: entry.profile,
                capability_tuple: entry.capability_tuple.clone(),
                diagnostics: entry.diagnostics.clone(),
            })
            .collect()
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            detector_set_id: redact_for_log_or_report(&self.detector_set_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            entries: self
                .entries
                .iter()
                .map(WolfProtectionDetectorEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

// Detector (generate + validate)

/// Run the Wolf protection detector over a fixture set. Every record is
/// classified into a profile mechanically; the record's declared expectation is
/// used only to raise structured findings on a mismatch. Never panics; a
/// blocking finding flips the record (and the report) to `Failed`.
pub fn run_wolf_protection_detector(
    fixture: &WolfProtectionDetectorFixture,
) -> WolfProtectionDetectorReport {
    let mut entries = Vec::with_capacity(fixture.entries.len());
    for entry in &fixture.entries {
        entries.push(detect_entry(
            entry,
            &fixture.source_node_id,
            &fixture.engine_family,
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
    WolfProtectionDetectorReport {
        schema_version: WOLF_PROTECTION_DETECTOR_REPORT_SCHEMA_VERSION.to_string(),
        detector_set_id: fixture.detector_set_id.clone(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        support_boundary: WOLF_PROTECTION_DETECTOR_SUPPORT_BOUNDARY.to_string(),
        status,
        entries,
    }
}

fn detect_entry(
    entry: &WolfProtectionDetectorFixtureEntry,
    source_node_id: &str,
    engine_family: &str,
) -> WolfProtectionDetectorEntryReport {
    let mut findings: Vec<WolfProtectionDiagnostic> = Vec::new();

    if entry.fixture_id.trim().is_empty() {
        findings.push(diagnostic(
            "wolf.detector.fixture_id_missing",
            PartialDiagnosticSeverity::P0,
            "fixtureId",
            "record is missing a non-empty fixtureId",
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }
    if engine_family != WOLF_ENGINE_FAMILY {
        findings.push(diagnostic(
            "wolf.detector.wrong_engine_family",
            PartialDiagnosticSeverity::P0,
            "engineFamily",
            format!(
                "Wolf detector requires engineFamily={WOLF_ENGINE_FAMILY}, got {engine_family}"
            ),
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }
    // Wolf-shaped container leg.
    if entry.container != ContainerTransform::WolfArchive {
        findings.push(diagnostic(
            "wolf.detector.out_of_family_container",
            PartialDiagnosticSeverity::P0,
            "container",
            format!(
                "Wolf detector requires a wolf_archive container, got {:?}",
                entry.container
            ),
            if entry.container == ContainerTransform::Unknown {
                SemanticErrorCode::MissingContainerCapability
            } else {
                SemanticErrorCode::UnsupportedVariantPacked
            },
        ));
    }
    // The declared crypto leg must match the protection signal's canonical
    // crypto — a record cannot claim a plain crypto with a protected signal.
    let canonical_crypto = entry.protection_signal.canonical_crypto();
    if entry.crypto != canonical_crypto {
        findings.push(diagnostic(
            "wolf.detector.crypto_signal_mismatch",
            PartialDiagnosticSeverity::P0,
            "crypto",
            format!(
                "protection signal {} implies crypto {:?} but the record declared {:?}",
                entry.protection_signal.as_str(),
                canonical_crypto,
                entry.crypto
            ),
            SemanticErrorCode::MissingCryptoCapability,
        ));
    }

    // --- The mechanical classification (always recomputed from evidence). --
    let has_requirement = !entry.secret_requirements.is_empty();
    let profile = derive_wolf_protection_profile(entry.protection_signal, has_requirement);
    let reason = unknown_reason(entry.protection_signal, has_requirement);
    let capability_tuple = derive_wolf_capability_tuple(profile);
    let diagnostics = derive_wolf_protection_diagnostics(profile, reason);

    if entry.expected_profile != profile {
        findings.push(diagnostic(
            "wolf.detector.profile_mismatch",
            PartialDiagnosticSeverity::P0,
            "expectedProfile",
            format!(
                "record declared profile {} but the detector classified {}",
                entry.expected_profile.as_str(),
                profile.as_str()
            ),
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }
    // Declared diagnostics (semantic codes) must match the derived set.
    let derived_codes: Vec<&str> = diagnostics
        .iter()
        .map(|d| d.semantic_code.as_str())
        .collect();
    let expected_codes: Vec<&str> = entry
        .expected_semantic_codes
        .iter()
        .map(String::as_str)
        .collect();
    if derived_codes != expected_codes {
        findings.push(diagnostic(
            "wolf.detector.diagnostic_mismatch",
            PartialDiagnosticSeverity::P0,
            "expectedSemanticCodes",
            format!(
                "record declared diagnostics {expected_codes:?} but the detector derived {derived_codes:?}"
            ),
            SemanticErrorCode::UnknownEngineVariant,
        ));
    }
    // A concrete key requirement must name a stable requirement id.
    for requirement in &entry.secret_requirements {
        if requirement.requirement_id.trim().is_empty() {
            findings.push(diagnostic(
                "wolf.detector.requirement_id_missing",
                PartialDiagnosticSeverity::P0,
                "secretRequirements",
                "a secret requirement is missing a non-empty requirementId",
                SemanticErrorCode::MissingKeyProfile,
            ));
        }
    }
    // Mechanical overclaim guard: the detector tuple can never resolve extract /
    // patch / helper / runtime.
    if !capability_tuple.is_detector_only() {
        findings.push(diagnostic(
            "wolf.detector.capability_overclaim",
            PartialDiagnosticSeverity::P0,
            "capabilityTuple",
            "the Wolf protection detector must not advertise extract, patch, helper, or runtime support",
            SemanticErrorCode::UnsupportedVariantPacked,
        ));
    }

    let status = if findings.iter().any(|f| f.severity.is_blocking()) {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    WolfProtectionDetectorEntryReport {
        fixture_id: entry.fixture_id.clone(),
        source_node_id: source_node_id.to_string(),
        engine_family: engine_family.to_string(),
        variant: entry.variant.clone(),
        container: entry.container,
        protection_signal: entry.protection_signal,
        crypto: entry.crypto,
        codec: entry.codec,
        surface: entry.surface,
        secret_requirement_ids: entry
            .secret_requirements
            .iter()
            .map(|requirement| requirement.requirement_id.clone())
            .collect(),
        profile,
        capability_tuple,
        diagnostics,
        status,
        findings,
    }
}

/// Load a Wolf protection detector fixture set from disk.
pub fn read_wolf_protection_detector_fixture(
    path: &Path,
) -> KaifuuResult<WolfProtectionDetectorFixture> {
    read_json(path)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn fixtures_dir() -> PathBuf {
        crate::test_manifest_dir()
            .join("../..")
            .join("fixtures/kaifuu/wolf")
    }

    fn load() -> WolfProtectionDetectorFixture {
        read_wolf_protection_detector_fixture(
            &fixtures_dir().join("protection-detector.profiles.json"),
        )
        .expect("Wolf detector fixture must parse")
    }

    fn run() -> WolfProtectionDetectorReport {
        run_wolf_protection_detector(&load())
    }

    // --- The whole fixture set is green + records the full acceptance tuple. -

    #[test]
    fn detector_fixture_set_passes_and_records_every_field() {
        let report = run();
        assert_eq!(
            report.status,
            OperationStatus::Passed,
            "{:?}",
            report.entries
        );
        assert!(!report.entries.is_empty());
        for entry in &report.entries {
            assert_eq!(
                entry.status,
                OperationStatus::Passed,
                "record {} failed: {:?}",
                entry.fixture_id,
                entry.findings
            );
            // Acceptance: every record carries engine_family=wolf, variant,
            // container, crypto/protection state, codec, surface, fixture id,
            // secret requirement ids, and diagnostics.
            assert_eq!(entry.engine_family, WOLF_ENGINE_FAMILY);
            assert_eq!(entry.container, ContainerTransform::WolfArchive);
            assert!(!entry.fixture_id.is_empty());
            assert!(!entry.variant.is_empty());
            assert_eq!(entry.source_node_id, "KAIFUU-120");
            // The detector never claims extract/patch/helper/runtime.
            assert!(entry.capability_tuple.is_detector_only());
        }
    }

    #[test]
    fn the_four_profiles_are_distinct() {
        let report = run();
        let plain = report.entry("wolf.plain").unwrap();
        let protected = report.entry("wolf.protected").unwrap();
        let helper = report.entry("wolf.helper-required").unwrap();
        let unknown = report.entry("wolf.unknown-variant").unwrap();

        assert_eq!(plain.profile, WolfProtectionProfile::Plain);
        assert_eq!(protected.profile, WolfProtectionProfile::Protected);
        assert_eq!(helper.profile, WolfProtectionProfile::HelperRequired);
        assert_eq!(unknown.profile, WolfProtectionProfile::Unknown);

        // plain!= protected!= helper_required!= unknown.
        let profiles = [
            plain.profile,
            protected.profile,
            helper.profile,
            unknown.profile,
        ];
        for i in 0..profiles.len() {
            for j in (i + 1)..profiles.len() {
                assert_ne!(profiles[i], profiles[j], "profiles must all be distinct");
            }
        }
    }

    #[test]
    fn each_profile_carries_the_correct_capability_tuple() {
        let report = run();
        // Only plain advertises inventory; every profile is identify-level and
        // never claims extract/patch/helper/runtime.
        let plain = report.entry("wolf.plain").unwrap();
        assert!(plain.capability_tuple.identify.is_supported());
        assert!(plain.capability_tuple.inventory.is_supported());

        let protected = report.entry("wolf.protected").unwrap();
        assert!(protected.capability_tuple.identify.is_supported());
        assert!(protected.capability_tuple.inventory.is_unsupported());

        let helper = report.entry("wolf.helper-required").unwrap();
        assert!(helper.capability_tuple.identify.is_supported());
        assert!(helper.capability_tuple.inventory.is_unsupported());

        let unknown = report.entry("wolf.unknown-variant").unwrap();
        assert!(unknown.capability_tuple.identify.is_partial());
        assert!(unknown.capability_tuple.inventory.is_unsupported());

        for entry in &report.entries {
            assert!(entry.capability_tuple.extract.is_unsupported());
            assert!(entry.capability_tuple.patch.is_unsupported());
            assert!(entry.capability_tuple.helper.is_unsupported());
            assert!(entry.capability_tuple.runtime.is_unsupported());
        }
    }

    #[test]
    fn each_profile_carries_the_correct_diagnostics() {
        let report = run();
        // Plain is a clean detection: no diagnostics.
        assert!(report.entry("wolf.plain").unwrap().diagnostics.is_empty());
        // Protected records an unsupported-layered-transform boundary (the key
        // is named, so NOT missing_capability.crypto).
        let protected = report.entry("wolf.protected").unwrap();
        assert_eq!(protected.diagnostics.len(), 1);
        assert_eq!(
            protected.diagnostics[0].semantic_code,
            "kaifuu.unsupported_layered_transform"
        );
        assert!(!protected.secret_requirement_ids.is_empty());
        // Helper-required reports helper_required.
        let helper = report.entry("wolf.helper-required").unwrap();
        assert_eq!(
            helper.diagnostics[0].semantic_code,
            "kaifuu.helper_required"
        );
    }

    // --- Acceptance 4: unknown reports unknown_variant OR
    // missing_capability.crypto (unless a concrete key requirement exists).

    #[test]
    fn unknown_unrecognized_reports_unknown_variant() {
        let report = run();
        let unknown = report.entry("wolf.unknown-variant").unwrap();
        assert_eq!(unknown.profile, WolfProtectionProfile::Unknown);
        assert_eq!(
            unknown.diagnostics[0].semantic_code,
            "kaifuu.unknown_engine_variant"
        );
    }

    #[test]
    fn key_gated_without_requirement_reports_missing_crypto_capability() {
        let report = run();
        let missing = report.entry("wolf.unknown-missing-crypto").unwrap();
        assert_eq!(missing.profile, WolfProtectionProfile::Unknown);
        assert_eq!(
            missing.diagnostics[0].semantic_code,
            "kaifuu.missing_capability.crypto"
        );
    }

    #[test]
    fn a_concrete_key_requirement_lifts_static_key_to_protected() {
        // Pure mechanical rule: static_key_protected is `protected` iff a
        // concrete key requirement exists, else `unknown`.
        assert_eq!(
            derive_wolf_protection_profile(WolfArchiveProtectionSignal::StaticKeyProtected, true),
            WolfProtectionProfile::Protected
        );
        assert_eq!(
            derive_wolf_protection_profile(WolfArchiveProtectionSignal::StaticKeyProtected, false),
            WolfProtectionProfile::Unknown
        );
    }

    #[test]
    fn classifier_is_total_over_all_signals() {
        assert_eq!(
            derive_wolf_protection_profile(WolfArchiveProtectionSignal::Unencrypted, false),
            WolfProtectionProfile::Plain
        );
        assert_eq!(
            derive_wolf_protection_profile(
                WolfArchiveProtectionSignal::DynamicKeyHelperGated,
                true
            ),
            WolfProtectionProfile::HelperRequired
        );
        assert_eq!(
            derive_wolf_protection_profile(
                WolfArchiveProtectionSignal::UnrecognizedProtection,
                false
            ),
            WolfProtectionProfile::Unknown
        );
    }

    #[test]
    fn declared_profile_mismatch_is_a_blocking_finding() {
        let mut fixture = load();
        let entry = fixture
            .entries
            .iter_mut()
            .find(|entry| entry.fixture_id == "wolf.plain")
            .unwrap();
        entry.expected_profile = WolfProtectionProfile::Protected;
        let report = run_wolf_protection_detector(&fixture);
        assert_eq!(report.status, OperationStatus::Failed);
        let plain = report.entry("wolf.plain").unwrap();
        assert_eq!(plain.status, OperationStatus::Failed);
        assert!(
            plain
                .findings
                .iter()
                .any(|f| f.code == "wolf.detector.profile_mismatch")
        );
        // The DERIVED profile still refuses the lie.
        assert_eq!(plain.profile, WolfProtectionProfile::Plain);
    }

    #[test]
    fn crypto_signal_mismatch_is_a_blocking_finding() {
        let mut fixture = load();
        let entry = fixture
            .entries
            .iter_mut()
            .find(|entry| entry.fixture_id == "wolf.protected")
            .unwrap();
        // Claim a plain crypto for a protected signal.
        entry.crypto = CryptoTransform::NullKey;
        let report = run_wolf_protection_detector(&fixture);
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(
            report
                .entry("wolf.protected")
                .unwrap()
                .findings
                .iter()
                .any(|f| f.code == "wolf.detector.crypto_signal_mismatch")
        );
    }

    #[test]
    fn diagnostic_matrix_covers_every_profile() {
        let matrix = wolf_protection_diagnostic_matrix();
        // Plain, Protected, HelperRequired, + two Unknown rows.
        assert_eq!(matrix.len(), 5);
        for profile in WolfProtectionProfile::all() {
            assert!(
                matrix.iter().any(|row| row.profile == profile),
                "matrix missing profile {}",
                profile.as_str()
            );
        }
        // Both acceptance-required unknown diagnostics are represented.
        let unknown_codes: Vec<&str> = matrix
            .iter()
            .filter(|row| row.profile == WolfProtectionProfile::Unknown)
            .flat_map(|row| row.diagnostics.iter().map(|d| d.semantic_code.as_str()))
            .collect();
        assert!(unknown_codes.contains(&"kaifuu.unknown_engine_variant"));
        assert!(unknown_codes.contains(&"kaifuu.missing_capability.crypto"));
        // Every matrix row is detector-only.
        for row in &matrix {
            assert!(row.capability_tuple.is_detector_only());
        }
    }

    #[test]
    fn report_redacts_paths_and_never_carries_raw_key_material() {
        let mut fixture = load();
        fixture.detector_set_id = "/home/trevor/private/wolf/leak.wolf".to_string();
        let report = run_wolf_protection_detector(&fixture);
        let json = report.stable_json().expect("stable json");
        assert!(json.contains("[REDACTED:"));
        assert!(!json.contains("/home/trevor/private/wolf/leak.wolf"));
        // Only requirement ids + local-scheme secret refs appear, never a raw
        // key. (The fixture carries none by construction; assert the scheme.)
        assert!(!json.contains("BEGIN"));
    }
}
