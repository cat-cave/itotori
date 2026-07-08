//! KAIFUU-121 — Wolf RPG Editor key/protection helper BOUNDARY as a local-only
//! [`HelperResult`] (the KAIFUU-085 helper-result schema).
//!
//! The KAIFUU-120 Wolf protection detector
//! ([`crate::wolf_protection_detector`]) classifies a `.wolf`/DXArchive-family
//! container into a plain, protected, helper-required, or unknown protection
//! profile. Two of those profiles are **keyRef-bound** — they name a concrete
//! secret the archive is gated by:
//!
//! - [`WolfProtectionProfile::Protected`] — an encrypted DX archive gated by a
//!   known/static archive key that is imported LOCALLY (no untrusted code runs).
//! - [`WolfProtectionProfile::HelperRequired`] — a Wolf "Pro" per-game dynamic
//!   key that a LOCAL dynamic-key helper must recover before extraction.
//!
//! This node represents the **helper BOUNDARY** for those keyRef-bound profiles:
//! given a keyRef-bound Wolf protection profile, [`resolve_wolf_helper_boundary`]
//! produces a LOCAL-ONLY [`HelperResult`] that carries the secret **REFS**
//! ([`HelperResultSecretRef`] — requirement id + local-scheme [`SecretRef`],
//! never the key bytes), the proof hashes, and a redacted diagnostic. It NEVER
//! runs the helper and NEVER emits raw key material — the key is resolved by ref
//! locally, mirroring the KAIFUU-072 XP3 crypt secret-ref discipline.
//!
//! # The mechanical line (computed, never asserted)
//!
//! [`derive_wolf_helper_boundary_outcome`] is the single source of truth. The
//! outcome is a pure function of the boundary kind (static-key local import vs
//! dynamic-key local helper) and whether the secret is locally available:
//!
//! - `StaticKeyLocalImport` + available   → `KeyResolved`  (`success`)
//! - `StaticKeyLocalImport` + unavailable → `KeyMissing`   (`missing_key`)
//! - `DynamicKeyLocalHelper` + available  → `HelperRequired` (resolvable, unrun)
//! - `DynamicKeyLocalHelper` + unavailable → `HelperUnavailable`
//!
//! # Engine-general (Wolf = data, no per-game branch)
//!
//! A [`WolfHelperBoundaryProfile`] is pure DATA: a boundary kind, a keyRef
//! binding (requirement id + local-scheme secret ref + material kind), and a
//! local-availability flag. The resolver has no per-game branch; every Wolf
//! game is a data-driven profile.
//!
//! # Evidence is synthetic, redacted, ref-only
//!
//! Fixtures carry NO retail bytes and NO raw key material: only the local-scheme
//! secret refs, stable requirement ids, and sha256 proof hashes. Every emitted
//! [`HelperResult`] is funnelled through [`HelperResult::redacted_for_report`]
//! and validated against the KAIFUU-085 schema via
//! [`validate_helper_result_value`].

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::wolf_protection_detector::{WOLF_ENGINE_FAMILY, WolfProtectionProfile};
use crate::{
    HELPER_RESULT_SCHEMA_VERSION, HelperCapabilityLevel, HelperDiagnostic, HelperDiagnosticCode,
    HelperExecutionFilesystemAccess, HelperExecutionSummary, HelperKind, HelperProvenance,
    HelperRedaction, HelperRedactionStatus, HelperResult, HelperResultExecutionMode,
    HelperResultSecretRef, KaifuuResult, KeyMaterialKind, KeyValidationMethod, KeyValidationProof,
    OperationStatus, ProofHash, SecretRef, read_json, redact_for_log_or_report, sha256_hash_bytes,
    stable_json, validate_helper_result_value,
};

/// Schema version of the helper-boundary fixture input.
pub const WOLF_HELPER_BOUNDARY_SCHEMA_VERSION: &str = "0.1.0";
/// Schema version of the generated helper-boundary report.
pub const WOLF_HELPER_BOUNDARY_REPORT_SCHEMA_VERSION: &str = "0.1.0";

/// The support boundary surfaced in every Wolf helper-boundary report.
pub const WOLF_HELPER_BOUNDARY_SUPPORT_BOUNDARY: &str = "The Wolf key/protection helper boundary turns a keyRef-bound Wolf protection profile (protected static-key or helper-required Wolf \"Pro\" per-game dynamic-key) into a LOCAL-ONLY KAIFUU-085 helper result. It resolves the key BY REF locally — carrying the secret-requirement ids, local-scheme secret refs, sha256 proof hashes, and a redacted diagnostic — and NEVER runs the helper, launches untrusted code, or emits raw key material. Plain and unknown protection profiles are not keyRef-bound and have no helper boundary.";

// ---------------------------------------------------------------------------
// The boundary kind (which keyRef-bound Wolf protection profile)
// ---------------------------------------------------------------------------

/// Which keyRef-bound Wolf protection profile this helper boundary serves. Each
/// kind maps 1:1 to a KAIFUU-120 [`WolfProtectionProfile`] and fixes the
/// local-only KAIFUU-085 helper path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WolfHelperBoundaryKind {
    /// A [`WolfProtectionProfile::Protected`] archive gated by a known/static
    /// key imported locally (a [`HelperKind::KnownKeyDatabaseImport`] path).
    StaticKeyLocalImport,
    /// A [`WolfProtectionProfile::HelperRequired`] Wolf "Pro" per-game dynamic
    /// key recovered by a LOCAL dynamic-key helper (a
    /// [`HelperKind::WineLocalWindowsHelper`] path — never run at the boundary).
    DynamicKeyLocalHelper,
}

impl WolfHelperBoundaryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StaticKeyLocalImport => "static_key_local_import",
            Self::DynamicKeyLocalHelper => "dynamic_key_local_helper",
        }
    }

    /// The KAIFUU-120 Wolf protection profile this boundary serves.
    pub fn protection_profile(self) -> WolfProtectionProfile {
        match self {
            Self::StaticKeyLocalImport => WolfProtectionProfile::Protected,
            Self::DynamicKeyLocalHelper => WolfProtectionProfile::HelperRequired,
        }
    }

    /// The KAIFUU-085 helper kind for this local-only boundary path.
    pub fn helper_kind(self) -> HelperKind {
        match self {
            Self::StaticKeyLocalImport => HelperKind::KnownKeyDatabaseImport,
            Self::DynamicKeyLocalHelper => HelperKind::WineLocalWindowsHelper,
        }
    }

    /// The KAIFUU-085 capability level for this local-only boundary path.
    pub fn capability_level(self) -> HelperCapabilityLevel {
        match self {
            Self::StaticKeyLocalImport => HelperCapabilityLevel::LocalKeyImport,
            Self::DynamicKeyLocalHelper => HelperCapabilityLevel::WineLocal,
        }
    }

    /// The KAIFUU-085 execution mode. Neither path runs at the boundary: the
    /// static import is `not_executed`; the dynamic helper resolves the
    /// `platform_helper` plan with `durationMs: 0` (never launched).
    pub fn execution_mode(self) -> HelperResultExecutionMode {
        match self {
            Self::StaticKeyLocalImport => HelperResultExecutionMode::NotExecuted,
            Self::DynamicKeyLocalHelper => HelperResultExecutionMode::PlatformHelper,
        }
    }

    fn execution_platform(self) -> &'static str {
        match self {
            Self::StaticKeyLocalImport => "wolf-local-key-store",
            Self::DynamicKeyLocalHelper => "wolf-wine-local",
        }
    }

    fn filesystem_access(self) -> HelperExecutionFilesystemAccess {
        match self {
            // A local key-store import reads only its own key store.
            Self::StaticKeyLocalImport => HelperExecutionFilesystemAccess::ReadOnlyWorkspace,
            // A dynamic helper reads the local game copy read-only.
            Self::DynamicKeyLocalHelper => HelperExecutionFilesystemAccess::LocalGameReadOnly,
        }
    }

    fn timeout_ms(self) -> u32 {
        match self {
            Self::StaticKeyLocalImport => 1000,
            Self::DynamicKeyLocalHelper => 5000,
        }
    }
}

// ---------------------------------------------------------------------------
// The boundary outcome (the mechanical classification)
// ---------------------------------------------------------------------------

/// The mechanically-derived helper-boundary outcome — the four local-only
/// results this node distinguishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WolfHelperBoundaryOutcome {
    /// The static key resolved locally by ref: a `success` result carrying a
    /// validated secret ref + proof hash.
    KeyResolved,
    /// The static key is not available in the local store: a `missing_key`
    /// result naming the concrete requirement id.
    KeyMissing,
    /// The dynamic-key helper is resolvable locally but not run at the boundary:
    /// a `helper_required` result naming the pending requirement.
    HelperRequired,
    /// The local dynamic-key helper platform is unavailable: a
    /// `helper_unavailable` result naming the pending requirement.
    HelperUnavailable,
}

impl WolfHelperBoundaryOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::KeyResolved => "key_resolved",
            Self::KeyMissing => "key_missing",
            Self::HelperRequired => "helper_required",
            Self::HelperUnavailable => "helper_unavailable",
        }
    }

    /// The KAIFUU-085 diagnostic code for this outcome.
    pub fn diagnostic_code(self) -> HelperDiagnosticCode {
        match self {
            Self::KeyResolved => HelperDiagnosticCode::Success,
            Self::KeyMissing => HelperDiagnosticCode::MissingKey,
            Self::HelperRequired => HelperDiagnosticCode::HelperRequired,
            Self::HelperUnavailable => HelperDiagnosticCode::HelperUnavailable,
        }
    }

    /// True iff the outcome recovered validated key material (only `key_resolved`
    /// carries a validation proof).
    pub fn recovered_key(self) -> bool {
        matches!(self, Self::KeyResolved)
    }
}

/// Classify a Wolf helper boundary into its local-only outcome. Total, pure,
/// side-effect-free — the single source of truth exercised by the tests.
///
/// `locally_available` is interpreted per kind: for a static-key local import it
/// is whether the key material exists in the local store; for a dynamic-key
/// local helper it is whether the local helper platform is available.
pub fn derive_wolf_helper_boundary_outcome(
    kind: WolfHelperBoundaryKind,
    locally_available: bool,
) -> WolfHelperBoundaryOutcome {
    match (kind, locally_available) {
        (WolfHelperBoundaryKind::StaticKeyLocalImport, true) => {
            WolfHelperBoundaryOutcome::KeyResolved
        }
        (WolfHelperBoundaryKind::StaticKeyLocalImport, false) => {
            WolfHelperBoundaryOutcome::KeyMissing
        }
        (WolfHelperBoundaryKind::DynamicKeyLocalHelper, true) => {
            WolfHelperBoundaryOutcome::HelperRequired
        }
        (WolfHelperBoundaryKind::DynamicKeyLocalHelper, false) => {
            WolfHelperBoundaryOutcome::HelperUnavailable
        }
    }
}

// ---------------------------------------------------------------------------
// The keyRef binding + the boundary profile (fixture input)
// ---------------------------------------------------------------------------

/// The keyRef binding a keyRef-bound Wolf protection profile carries: the stable
/// requirement id, the local-scheme [`SecretRef`] the key is resolved by, and
/// the key material kind. NEVER the key bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfHelperKeyRequirement {
    /// Stable id of the key requirement (never raw key bytes).
    pub requirement_id: String,
    /// Local-scheme reference to the key material (never raw key bytes).
    pub key_ref: SecretRef,
    /// The material kind (e.g. archive password / fixed bytes).
    pub material_kind: KeyMaterialKind,
}

/// One synthetic keyRef-bound Wolf helper-boundary profile — pure data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfHelperBoundaryProfile {
    /// Stable public fixture id.
    pub fixture_id: String,
    /// Stable helper-boundary profile id (a single-token identifier).
    pub profile_id: String,
    /// Which keyRef-bound protection profile this boundary serves.
    pub boundary_kind: WolfHelperBoundaryKind,
    /// The keyRef binding (requirement id + local-scheme secret ref + kind).
    pub key_requirement: WolfHelperKeyRequirement,
    /// Whether the secret is locally available (key material present for a
    /// static import; helper platform present for a dynamic helper).
    pub locally_available: bool,
    /// The outcome this profile is authored to resolve to. The resolver
    /// recomputes it from evidence and raises a finding on a mismatch.
    pub expected_outcome: WolfHelperBoundaryOutcome,
}

/// A Wolf helper-boundary fixture set — a small manifest of synthetic profiles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfHelperBoundaryFixture {
    pub schema_version: String,
    /// Stable id for the fixture set (synthetic; no retail names/local paths).
    pub boundary_set_id: String,
    /// The spec-DAG node id this fixture set is authored for (e.g. `KAIFUU-121`).
    pub source_node_id: String,
    pub engine_family: String,
    pub profiles: Vec<WolfHelperBoundaryProfile>,
}

// ---------------------------------------------------------------------------
// The generated report (per-profile local-only helper result)
// ---------------------------------------------------------------------------

/// One structured finding raised by the resolver (declared-vs-derived mismatch).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfHelperBoundaryFinding {
    pub code: String,
    pub field: String,
    pub message: String,
}

impl WolfHelperBoundaryFinding {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

/// The generated per-profile helper-boundary report. Echoes the acceptance
/// fields (profile id, boundary kind, protection profile, secret requirement
/// ids, proof hashes) and carries the derived local-only KAIFUU-085
/// [`HelperResult`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfHelperBoundaryEntryReport {
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub profile_id: String,
    pub boundary_kind: WolfHelperBoundaryKind,
    pub protection_profile: WolfProtectionProfile,
    pub outcome: WolfHelperBoundaryOutcome,
    /// The secret requirement ids this profile names (redacted; never key bytes).
    pub secret_requirement_ids: Vec<String>,
    /// The sha256 validation proofs carried by the local-only helper result.
    pub proof_hashes: Vec<KeyValidationProof>,
    /// The local-only KAIFUU-085 helper result (refs + redacted diagnostics).
    pub helper_result: HelperResult,
    pub status: OperationStatus,
    pub findings: Vec<WolfHelperBoundaryFinding>,
}

impl WolfHelperBoundaryEntryReport {
    pub(crate) fn redacted_for_report(&self) -> Self {
        Self {
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            profile_id: redact_for_log_or_report(&self.profile_id),
            boundary_kind: self.boundary_kind,
            protection_profile: self.protection_profile,
            outcome: self.outcome,
            secret_requirement_ids: self
                .secret_requirement_ids
                .iter()
                .map(|id| redact_for_log_or_report(id))
                .collect(),
            proof_hashes: self.proof_hashes.clone(),
            helper_result: self.helper_result.redacted_for_report(),
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(WolfHelperBoundaryFinding::redacted_for_report)
                .collect(),
        }
    }
}

/// The aggregate helper-boundary report over a fixture set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfHelperBoundaryReport {
    pub schema_version: String,
    pub boundary_set_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub entries: Vec<WolfHelperBoundaryEntryReport>,
}

impl WolfHelperBoundaryReport {
    pub fn entry(&self, fixture_id: &str) -> Option<&WolfHelperBoundaryEntryReport> {
        self.entries
            .iter()
            .find(|entry| entry.fixture_id == fixture_id)
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            boundary_set_id: redact_for_log_or_report(&self.boundary_set_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            entries: self
                .entries
                .iter()
                .map(WolfHelperBoundaryEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

// ---------------------------------------------------------------------------
// The resolver (the local-only helper-boundary builder)
// ---------------------------------------------------------------------------

const WOLF_HELPER_BOUNDARY_REDACTED_LOG_HASH: &str =
    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

/// Build the local-only KAIFUU-085 [`HelperResult`] for a keyRef-bound Wolf
/// helper-boundary profile. The key is resolved BY REF: the returned result
/// carries the secret ref (requirement id + local-scheme ref) and — only when
/// the key resolved — a validation proof hash. It never runs the helper and
/// never emits raw key material.
pub fn resolve_wolf_helper_boundary(profile: &WolfHelperBoundaryProfile) -> HelperResult {
    let kind = profile.boundary_kind;
    let outcome = derive_wolf_helper_boundary_outcome(kind, profile.locally_available);

    // The validation proof is present ONLY when the key resolved locally. It is
    // a sha256 hash over a synthetic proof label — never key bytes.
    let validation = outcome.recovered_key().then(|| KeyValidationProof {
        method: KeyValidationMethod::ArchiveIndexProof,
        proof_hash: ProofHash::new(sha256_hash_bytes(
            format!(
                "wolf-helper-boundary/{}/{}/archive-index-proof",
                profile.profile_id, profile.key_requirement.requirement_id
            )
            .as_bytes(),
        ))
        .expect("sha256_hash_bytes yields a valid sha256 ref"),
    });

    // The secret is ALWAYS carried by ref — never the key bytes. A resolved key
    // additionally carries its validation proof.
    let secret_ref = HelperResultSecretRef {
        requirement_id: profile.key_requirement.requirement_id.clone(),
        secret_ref: profile.key_requirement.key_ref.clone(),
        material_kind: profile.key_requirement.material_kind,
        bytes: None,
        validation: validation.clone(),
    };

    let proof_hashes = validation.clone().into_iter().collect::<Vec<_>>();

    let message = match outcome {
        WolfHelperBoundaryOutcome::KeyResolved => format!(
            "static Wolf archive key resolved locally by ref for requirement {}; no untrusted code was launched",
            profile.key_requirement.requirement_id
        ),
        WolfHelperBoundaryOutcome::KeyMissing => format!(
            "{}: static Wolf archive key requirement {} is not present in the local key store",
            crate::SEMANTIC_MISSING_KEY_MATERIAL,
            profile.key_requirement.requirement_id
        ),
        WolfHelperBoundaryOutcome::HelperRequired => format!(
            "{}: the Wolf \"Pro\" per-game dynamic key for requirement {} must be recovered by the local dynamic-key helper; the boundary resolved the plan without launching",
            crate::SEMANTIC_HELPER_REQUIRED,
            profile.key_requirement.requirement_id
        ),
        WolfHelperBoundaryOutcome::HelperUnavailable => format!(
            "{}: the local Wolf dynamic-key helper platform is unavailable; requirement {} cannot be recovered on this runner",
            crate::SEMANTIC_HELPER_UNAVAILABLE,
            profile.key_requirement.requirement_id
        ),
    };

    HelperResult {
        schema_version: HELPER_RESULT_SCHEMA_VERSION.to_string(),
        fixture_id: profile.fixture_id.clone(),
        helper_result_id: format!("helper-result-{}", profile.profile_id),
        profile_id: profile.profile_id.clone(),
        helper: HelperProvenance {
            helper_id: format!("kaifuu.fixture.wolf-{}", kind.as_str().replace('_', "-")),
            helper_version: "0.1.0".to_string(),
            helper_kind: kind.helper_kind(),
        },
        capability_level: kind.capability_level(),
        execution: HelperExecutionSummary {
            mode: kind.execution_mode(),
            platform: kind.execution_platform().to_string(),
            bounded: true,
            timeout_ms: kind.timeout_ms(),
            // The boundary never runs the helper — durationMs 0 proves it.
            duration_ms: Some(0),
            network_access: false,
            filesystem_access: kind.filesystem_access(),
        },
        diagnostic: HelperDiagnostic {
            code: outcome.diagnostic_code(),
            message,
        },
        redaction: HelperRedaction {
            status: HelperRedactionStatus::Redacted,
            redacted_log_hash: ProofHash::new(WOLF_HELPER_BOUNDARY_REDACTED_LOG_HASH)
                .expect("fixture redacted-log hash is a valid sha256 ref"),
        },
        secret_refs: vec![secret_ref],
        proof_hashes,
    }
}

/// Resolve one profile into its full entry report, validating the derived
/// helper result against the KAIFUU-085 schema and the declared expectation.
fn resolve_entry(
    profile: &WolfHelperBoundaryProfile,
    source_node_id: &str,
    engine_family: &str,
) -> WolfHelperBoundaryEntryReport {
    let mut findings: Vec<WolfHelperBoundaryFinding> = Vec::new();

    if engine_family != WOLF_ENGINE_FAMILY {
        findings.push(WolfHelperBoundaryFinding {
            code: "wolf.helper_boundary.wrong_engine_family".to_string(),
            field: "engineFamily".to_string(),
            message: format!(
                "Wolf helper boundary requires engineFamily={WOLF_ENGINE_FAMILY}, got {engine_family}"
            ),
        });
    }
    if profile.key_requirement.requirement_id.trim().is_empty() {
        findings.push(WolfHelperBoundaryFinding {
            code: "wolf.helper_boundary.requirement_id_missing".to_string(),
            field: "keyRequirement.requirementId".to_string(),
            message: "keyRef-bound profile is missing a non-empty requirementId".to_string(),
        });
    }
    // The secret ref must be a LOCAL scheme — a keyRef-bound Wolf profile is
    // resolved from the local key store, never a remote/prompt scheme.
    if profile.key_requirement.key_ref.scheme() != crate::SecretRefScheme::LocalSecret {
        findings.push(WolfHelperBoundaryFinding {
            code: "wolf.helper_boundary.non_local_secret_ref".to_string(),
            field: "keyRequirement.keyRef".to_string(),
            message: "Wolf helper-boundary key refs must be resolved from the local key store"
                .to_string(),
        });
    }

    let outcome =
        derive_wolf_helper_boundary_outcome(profile.boundary_kind, profile.locally_available);
    if profile.expected_outcome != outcome {
        findings.push(WolfHelperBoundaryFinding {
            code: "wolf.helper_boundary.outcome_mismatch".to_string(),
            field: "expectedOutcome".to_string(),
            message: format!(
                "profile declared outcome {} but the boundary derived {}",
                profile.expected_outcome.as_str(),
                outcome.as_str()
            ),
        });
    }

    let helper_result = resolve_wolf_helper_boundary(profile);

    // THE conformance gate: the derived helper result must pass KAIFUU-085
    // schema validation.
    let helper_value =
        serde_json::to_value(&helper_result).expect("helper result serializes to JSON");
    let validation = validate_helper_result_value(&helper_value);
    if validation.status != OperationStatus::Passed {
        for failure in &validation.failures {
            findings.push(WolfHelperBoundaryFinding {
                code: format!("wolf.helper_boundary.kaifuu_085.{}", failure.code),
                field: failure.field.clone(),
                message: failure.message.clone(),
            });
        }
    }

    let status = if findings.is_empty() {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    WolfHelperBoundaryEntryReport {
        fixture_id: profile.fixture_id.clone(),
        source_node_id: source_node_id.to_string(),
        engine_family: engine_family.to_string(),
        profile_id: profile.profile_id.clone(),
        boundary_kind: profile.boundary_kind,
        protection_profile: profile.boundary_kind.protection_profile(),
        outcome,
        secret_requirement_ids: helper_result
            .secret_refs
            .iter()
            .map(|secret| secret.requirement_id.clone())
            .collect(),
        proof_hashes: helper_result.proof_hashes.clone(),
        helper_result,
        status,
        findings,
    }
}

/// Run the Wolf helper-boundary resolver over a fixture set. Every profile is
/// resolved into a local-only KAIFUU-085 helper result mechanically; the
/// declared expectation is used only to raise findings. Never panics.
pub fn run_wolf_helper_boundary(fixture: &WolfHelperBoundaryFixture) -> WolfHelperBoundaryReport {
    let mut entries = Vec::with_capacity(fixture.profiles.len());
    for profile in &fixture.profiles {
        entries.push(resolve_entry(
            profile,
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
    WolfHelperBoundaryReport {
        schema_version: WOLF_HELPER_BOUNDARY_REPORT_SCHEMA_VERSION.to_string(),
        boundary_set_id: fixture.boundary_set_id.clone(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        support_boundary: WOLF_HELPER_BOUNDARY_SUPPORT_BOUNDARY.to_string(),
        status,
        entries,
    }
}

/// Load a Wolf helper-boundary fixture set from disk.
pub fn read_wolf_helper_boundary_fixture(path: &Path) -> KaifuuResult<WolfHelperBoundaryFixture> {
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

    fn load() -> WolfHelperBoundaryFixture {
        read_wolf_helper_boundary_fixture(&fixtures_dir().join("helper-boundary.profiles.json"))
            .expect("Wolf helper-boundary fixture must parse")
    }

    fn run() -> WolfHelperBoundaryReport {
        run_wolf_helper_boundary(&load())
    }

    // --- The whole fixture set is green + records every acceptance field. ----

    #[test]
    fn boundary_fixture_set_passes_and_records_every_field() {
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
                "profile {} failed: {:?}",
                entry.profile_id,
                entry.findings
            );
            assert_eq!(entry.engine_family, WOLF_ENGINE_FAMILY);
            assert_eq!(entry.source_node_id, "KAIFUU-121");
            // Acceptance: profile id + secret requirement ids + proof hashes +
            // diagnostics are all present on the local-only helper result.
            assert!(!entry.profile_id.is_empty());
            assert!(!entry.helper_result.profile_id.is_empty());
            assert!(!entry.secret_requirement_ids.is_empty());
            assert!(!entry.helper_result.diagnostic.message.is_empty());
            // The boundary never runs the helper.
            assert_eq!(entry.helper_result.execution.duration_ms, Some(0));
            assert!(!entry.helper_result.execution.network_access);
        }
    }

    // --- THE crux: each derived helper result conforms to KAIFUU-085. --------

    #[test]
    fn every_helper_result_conforms_to_kaifuu_085() {
        let report = run();
        for entry in &report.entries {
            let value = serde_json::to_value(&entry.helper_result).unwrap();
            assert_eq!(
                validate_helper_result_value(&value).status,
                OperationStatus::Passed,
                "profile {} helper result failed KAIFUU-085 validation",
                entry.profile_id
            );
            // And the strongly-typed self-validation agrees.
            assert_eq!(
                entry.helper_result.validate().status,
                OperationStatus::Passed
            );
        }
    }

    // --- The four boundary outcomes are DISTINGUISHED. -----------------------

    #[test]
    fn the_four_outcomes_are_distinct_and_carry_the_right_shape() {
        let report = run();
        let resolved = report.entry("wolf.static-key.resolved").unwrap();
        let missing = report.entry("wolf.static-key.missing").unwrap();
        let helper = report.entry("wolf.dynamic-key.helper-required").unwrap();
        let unavailable = report.entry("wolf.dynamic-key.helper-unavailable").unwrap();

        assert_eq!(resolved.outcome, WolfHelperBoundaryOutcome::KeyResolved);
        assert_eq!(missing.outcome, WolfHelperBoundaryOutcome::KeyMissing);
        assert_eq!(helper.outcome, WolfHelperBoundaryOutcome::HelperRequired);
        assert_eq!(
            unavailable.outcome,
            WolfHelperBoundaryOutcome::HelperUnavailable
        );

        // Protected static-key boundary maps to the local key-import path.
        assert_eq!(
            resolved.protection_profile,
            WolfProtectionProfile::Protected
        );
        assert_eq!(
            resolved.helper_result.helper.helper_kind,
            HelperKind::KnownKeyDatabaseImport
        );
        assert_eq!(
            resolved.helper_result.capability_level,
            HelperCapabilityLevel::LocalKeyImport
        );
        assert_eq!(
            resolved.helper_result.diagnostic.code,
            HelperDiagnosticCode::Success
        );
        // A resolved key carries a validation proof hash; a missing one does not.
        assert!(!resolved.proof_hashes.is_empty());
        assert!(resolved.helper_result.secret_refs[0].validation.is_some());
        assert!(missing.proof_hashes.is_empty());
        assert!(missing.helper_result.secret_refs[0].validation.is_none());
        assert_eq!(
            missing.helper_result.diagnostic.code,
            HelperDiagnosticCode::MissingKey
        );

        // HelperRequired maps to the Wolf "Pro" dynamic-key local helper path.
        assert_eq!(
            helper.protection_profile,
            WolfProtectionProfile::HelperRequired
        );
        assert_eq!(
            helper.helper_result.helper.helper_kind,
            HelperKind::WineLocalWindowsHelper
        );
        assert_eq!(
            helper.helper_result.execution.mode,
            HelperResultExecutionMode::PlatformHelper
        );
        assert_eq!(
            helper.helper_result.diagnostic.code,
            HelperDiagnosticCode::HelperRequired
        );
        assert_eq!(
            unavailable.helper_result.diagnostic.code,
            HelperDiagnosticCode::HelperUnavailable
        );
    }

    // --- Keys are refs only — no raw key bytes ever emitted (KAIFUU-072). ----

    #[test]
    fn keys_are_refs_only_and_report_is_redaction_clean() {
        let report = run();
        let json = report.stable_json().expect("stable json");
        // Ref-only: local-scheme secret refs + sha256 proof hashes survive.
        assert!(json.contains("local-secret:"));
        assert!(json.contains("sha256:"));
        // No raw key material, no private paths, no PEM blocks, no retail bytes.
        assert!(!json.contains("BEGIN"));
        assert!(!json.contains("/home/"));
        assert!(!json.contains("deadbeef"));
        // Every secret ref is a local scheme naming a requirement id only.
        for entry in &report.entries {
            for secret in &entry.helper_result.secret_refs {
                assert_eq!(
                    secret.secret_ref.scheme(),
                    crate::SecretRefScheme::LocalSecret
                );
                assert!(!secret.requirement_id.is_empty());
                // The ref never carries decoded byte length / raw material.
                assert!(secret.bytes.is_none());
            }
        }
    }

    #[test]
    fn report_redacts_local_paths_and_never_carries_raw_key_material() {
        let mut fixture = load();
        fixture.boundary_set_id = "/home/trevor/private/wolf/leak.wolf".to_string();
        let report = run_wolf_helper_boundary(&fixture);
        let json = report.stable_json().expect("stable json");
        assert!(json.contains("[REDACTED:"));
        assert!(!json.contains("/home/trevor/private/wolf/leak.wolf"));
        assert!(!json.contains("BEGIN"));
    }

    // --- The mechanical classifier is total. --------------------------------

    #[test]
    fn classifier_is_total_over_kind_and_availability() {
        assert_eq!(
            derive_wolf_helper_boundary_outcome(WolfHelperBoundaryKind::StaticKeyLocalImport, true),
            WolfHelperBoundaryOutcome::KeyResolved
        );
        assert_eq!(
            derive_wolf_helper_boundary_outcome(
                WolfHelperBoundaryKind::StaticKeyLocalImport,
                false
            ),
            WolfHelperBoundaryOutcome::KeyMissing
        );
        assert_eq!(
            derive_wolf_helper_boundary_outcome(
                WolfHelperBoundaryKind::DynamicKeyLocalHelper,
                true
            ),
            WolfHelperBoundaryOutcome::HelperRequired
        );
        assert_eq!(
            derive_wolf_helper_boundary_outcome(
                WolfHelperBoundaryKind::DynamicKeyLocalHelper,
                false
            ),
            WolfHelperBoundaryOutcome::HelperUnavailable
        );
    }

    // --- The resolver catches a lying fixture. ------------------------------

    #[test]
    fn declared_outcome_mismatch_is_a_finding() {
        let mut fixture = load();
        let profile = fixture
            .profiles
            .iter_mut()
            .find(|p| p.fixture_id == "wolf.static-key.resolved")
            .unwrap();
        profile.expected_outcome = WolfHelperBoundaryOutcome::KeyMissing;
        let report = run_wolf_helper_boundary(&fixture);
        assert_eq!(report.status, OperationStatus::Failed);
        let entry = report.entry("wolf.static-key.resolved").unwrap();
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(
            entry
                .findings
                .iter()
                .any(|f| f.code == "wolf.helper_boundary.outcome_mismatch")
        );
        // The DERIVED outcome still refuses the lie.
        assert_eq!(entry.outcome, WolfHelperBoundaryOutcome::KeyResolved);
    }

    #[test]
    fn report_round_trips_through_json() {
        let report = run();
        let json = serde_json::to_string(&report.redacted_for_report()).expect("serialize");
        let round: WolfHelperBoundaryReport = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(round, report.redacted_for_report());
    }
}
