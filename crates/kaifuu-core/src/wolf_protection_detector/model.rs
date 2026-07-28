use serde::{Deserialize, Serialize};

use crate::{
    CapabilityLevelStatus, CryptoTransform, PartialDiagnosticSeverity, SemanticErrorCode,
    redact_for_log_or_report,
};

/// Schema version of the detector-profile fixture input.
pub const WOLF_PROTECTION_DETECTOR_SCHEMA_VERSION: &str = "0.1.0";
/// Schema version of the generated detector report.
pub const WOLF_PROTECTION_DETECTOR_REPORT_SCHEMA_VERSION: &str = "0.1.0";
/// The engine family every Wolf detector fixture records.
pub const WOLF_ENGINE_FAMILY: &str = "wolf";

/// The support boundary surfaced in every Wolf detector report.
pub const WOLF_PROTECTION_DETECTOR_SUPPORT_BOUNDARY: &str = "Wolf RPG Editor protection detector classifies a `.wolf`/DXArchive-family container into a plain, protected, helper-required, or unknown protection profile at identify level. It advertises identify (and, for a plain unencrypted archive, inventory) support only; extract, patch, dynamic-key helper, and runtime support are later Wolf nodes (// and the  helper boundary) and are never claimed. Unknown protection reports unknown_engine_variant or missing_capability.crypto unless a concrete key requirement exists.";

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
pub(super) enum WolfUnknownReason {
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
pub(super) fn unknown_reason(
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
    "Wolf archive extraction is a later adapter node (), not this detector";
const PATCH_BOUNDARY: &str =
    "Wolf archive patch-back/repack is a later adapter node (), not this detector";
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
            "the dynamic-key helper boundary is /, not this detector",
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
    pub(super) fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code.clone(),
        }
    }
}

pub(super) fn diagnostic(
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
pub(super) fn derive_wolf_protection_diagnostics(
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
            "Wolf \"Pro\" per-game key must be recovered by the dynamic-key helper (/) before extraction",
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
