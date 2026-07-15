//! Wolf RPG Editor readiness proof.
//! This node COMBINES the two Wolf evidence sources that already exist as their
//! own honest, synthetic-fixture-driven subsystems into ONE per-capability-level
//! readiness report:
//! 1. the Wolf **protection detector**
//!    ([`crate::wolf_protection_detector`]) — magic-byte-signature detector
//!    evidence that classifies a `.wolf`/DXArchive-family container into a
//!    plain / protected / helper-required / unknown [`WolfProtectionProfile`]
//!    and advertises the `identify` (and, for a plain archive, `inventory`)
//!    rungs it may claim; and
//! 2. the Wolf **key/protection helper boundary**
//!    ([`crate::wolf_helper_boundary`]) — the local-only
//!    [`crate::HelperResult`] for a keyRef-bound profile, whose
//!    [`WolfHelperBoundaryOutcome`] (`key_resolved` / `key_missing` /
//!    `helper_required` / `helper_unavailable`) reports whether the key/helper
//!    gate is cleared.
//! # The honest capability-level ladder (never over-claimed)
//! The readiness report distinguishes SIX achieved levels
//! ([`WolfReadinessLevel`]):
//! - `identify` — the detector recognized the Wolf-shaped container.
//! - `inventory` — the detector can list the file table (plain archive).
//! - `helper_required` — the archive is gated behind the key/helper subsystem;
//!   the boundary characterized the exact requirement (or resolved the key
//!   locally by ref) but no extraction parser fixture backs a higher claim.
//! - `extract` — an explicit synthetic EXTRACT fixture proves extraction
//!   AND every lower gate is cleared.
//! - `patch` — an explicit synthetic PATCH fixture proves patch-back
//!   AND extraction is proven AND every lower gate is cleared.
//! - `unsupported` — the protection variant is unrecognized; nothing beyond
//!   a partial identify is proven.
//!   The single source of truth is [`derive_wolf_readiness_level`]: a pure,
//!   total function of the detector-derived profile, the helper-boundary outcome,
//!   and the presence of explicit extract/patch fixture proofs. It can NEVER lift
//!   an `unknown` profile above `unsupported`, and it NEVER claims `extract` or
//!   `patch` without an explicit synthetic fixture proof — the strict-proof
//!   honesty invariant (no aspirational "supported"). Real Wolf archive
//!   extraction / patch-back is a later adapter node; this readiness
//!   proof reports only what the detector + helper-boundary + explicit synthetic
//!   fixtures prove.
//! # Engine-general (Wolf = data, no per-game branch)
//! Every case is pure DATA: an embedded detector record, an optional embedded
//! helper-boundary profile, and optional synthetic extract/patch proofs. The
//! resolver runs the REAL detector and REAL helper-boundary subsystems over the
//! embedded evidence and combines their derived outputs — there is no per-game
//! branch.
//! # Evidence is synthetic, redacted, ref-only
//! Cases carry NO retail bytes and NO raw key material: only synthetic ids,
//! the detector's structured protection signal, the helper boundary's
//! local-scheme secret refs, and sha256 proof hashes. Every emitted report is
//! funnelled through [`redact_for_log_or_report`] / [`stable_json`].

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::wolf_extract_patch_verify_smoke::{
    WolfExtractPatchVerifySmokeReport, WolfSmokeArtifactKind, run_wolf_extract_patch_verify_smoke,
};
use crate::wolf_helper_boundary::{
    WolfHelperBoundaryEntryReport, WolfHelperBoundaryFixture, WolfHelperBoundaryOutcome,
    WolfHelperBoundaryProfile, run_wolf_helper_boundary,
};
use crate::wolf_protection_detector::{
    WOLF_ENGINE_FAMILY, WolfProtectionDetectorEntryReport, WolfProtectionDetectorFixture,
    WolfProtectionDetectorFixtureEntry, WolfProtectionProfile, run_wolf_protection_detector,
};
use crate::{
    KaifuuResult, OperationStatus, ProofHash, read_json, redact_for_log_or_report, stable_json,
};

/// Schema version of the readiness fixture input.
pub const WOLF_READINESS_SCHEMA_VERSION: &str = "0.1.0";
/// Schema version of the generated readiness report.
pub const WOLF_READINESS_REPORT_SCHEMA_VERSION: &str = "0.1.0";

/// The support boundary surfaced in every Wolf readiness report.
pub const WOLF_READINESS_SUPPORT_BOUNDARY: &str = "The Wolf RPG Editor readiness proof COMBINES the KAIFUU-120 protection-detector evidence (identify/inventory) with the KAIFUU-121 key/protection helper-boundary reporting (key_resolved/key_missing/helper_required/helper_unavailable) into ONE per-capability-level readiness report. It reports the ACHIEVED level (identify, inventory, helper-required, extract, patch, or unsupported) mechanically per the fixture evidence and NEVER claims a level beyond it: an unrecognized protection variant is unsupported; extract and patch are claimed ONLY where an explicit synthetic fixture proves them (retail Wolf extraction/patch-back is a later adapter node, KAIFUU-131, and is never claimed here). Evidence is synthetic and redacted — secret refs and sha256 hashes only, never raw keys, paths, or retail bytes.";

// The achieved readiness level (the six-rung honest ladder)

/// The capability level a Wolf archive achieves, combining detector evidence
/// with helper-boundary reporting. Ordered from least to most capability, with
/// `Unsupported` as the honest floor for an unrecognized protection variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WolfReadinessLevel {
    /// Unrecognized protection variant — nothing beyond a partial identify is
    /// proven. The honest floor; below `identify` on purpose.
    Unsupported,
    /// The detector recognized the Wolf-shaped container.
    Identify,
    /// The detector can list the (plain, unencrypted) file table.
    Inventory,
    /// The archive is gated behind the key/helper subsystem; the boundary
    /// characterized the requirement (or resolved the key locally by ref) but
    /// no extraction fixture backs a higher claim.
    HelperRequired,
    /// An explicit synthetic extract fixture proves extraction, every lower
    /// gate cleared.
    Extract,
    /// An explicit synthetic patch fixture proves patch-back, extraction
    /// proven, every lower gate cleared.
    Patch,
}

impl WolfReadinessLevel {
    /// Stable canonical string used in ids, records, and findings.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unsupported => "unsupported",
            Self::Identify => "identify",
            Self::Inventory => "inventory",
            Self::HelperRequired => "helper_required",
            Self::Extract => "extract",
            Self::Patch => "patch",
        }
    }

    /// True iff this level claims a resolved extraction (`extract` or `patch`).
    /// The strict-proof honesty invariant: this is only ever reachable with an
    /// explicit synthetic fixture proof.
    pub fn claims_extraction(self) -> bool {
        matches!(self, Self::Extract | Self::Patch)
    }
}

// Explicit synthetic extract/patch fixture proofs (the honesty gate)

/// Which synthetic archive-operation artifact a proof backs. The extract and
/// patch rungs are claimed ONLY when the matching proof is present and valid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WolfReadinessArtifactKind {
    /// A synthetic proof that a Wolf archive was extracted (unlocks `extract`).
    SyntheticExtractFixture,
    /// A synthetic proof that a Wolf archive was patched back (unlocks `patch`).
    SyntheticPatchFixture,
}

impl WolfReadinessArtifactKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SyntheticExtractFixture => "synthetic_extract_fixture",
            Self::SyntheticPatchFixture => "synthetic_patch_fixture",
        }
    }
}

/// The provenance of a readiness artifact proof. Strict-proof: only public
/// synthetic evidence is ever admitted here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WolfReadinessProvenance {
    /// A public, non-copyrighted synthetic fixture (never retail bytes).
    PublicSynthetic,
}

/// An explicit synthetic proof that a Wolf archive operation (extract / patch)
/// succeeded on synthetic bytes. Carries a stable artifact id + a sha256 proof
/// hash.
/// # — the proof hash BINDS to a genuinely-run smoke
/// The proof hash is NO LONGER a sha256 over a static label (that was the
/// anti-pattern: anyone who knew the artifact id could mint it, so
/// the rung was a CLAIM). The resolver now recomputes the honored value from a
/// genuinely-run extract-patch-verify smoke
/// ([`run_wolf_extract_patch_verify_smoke`]) — the honored hash is the SMOKE's
/// per-variant proof hash for the matching kind, derived from the ACTUAL
/// round-trip output. A fixture whose declared hash is a label (or otherwise
/// not backed by a passing smoke) is refused, so `extract`/`patch` are
/// unreachable without a verified round-trip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfReadinessArtifactProof {
    pub kind: WolfReadinessArtifactKind,
    /// Stable synthetic artifact id (never a retail name / local path).
    pub artifact_id: String,
    /// sha256 proof hash — must equal the SMOKE-BOUND canonical value.
    pub proof_hash: ProofHash,
    pub provenance: WolfReadinessProvenance,
}

impl WolfReadinessArtifactKind {
    fn smoke_kind(self) -> WolfSmokeArtifactKind {
        match self {
            Self::SyntheticExtractFixture => WolfSmokeArtifactKind::Extract,
            Self::SyntheticPatchFixture => WolfSmokeArtifactKind::Patch,
        }
    }
}

/// The canonical SMOKE-BOUND proof hash for a readiness artifact of `kind`,
/// taken from a genuinely-run extract-patch-verify smoke report.
/// Returns `None` if the smoke produced no round-tripped variant (then no
/// extract/patch proof can ever be honored — the honest floor holds).
/// The value depends on the smoke's ACTUAL round-trip output (archive hashes +
/// per-member deltas + round-trip proof), so it cannot be reproduced by a bare
/// label/boolean — this is exactly what binds the readiness `extract`/`patch`
/// rungs to a VERIFIED smoke (the mirror).
pub fn canonical_wolf_readiness_artifact_hash_from_smoke(
    smoke: &WolfExtractPatchVerifySmokeReport,
    kind: WolfReadinessArtifactKind,
) -> Option<ProofHash> {
    let outcome = smoke.outcomes.first()?;
    Some(match kind.smoke_kind() {
        WolfSmokeArtifactKind::Extract => outcome.extract_smoke_proof_hash.clone(),
        WolfSmokeArtifactKind::Patch => outcome.patch_smoke_proof_hash.clone(),
    })
}

impl WolfReadinessArtifactProof {
    /// True iff the proof is of the expected kind and its declared hash equals
    /// the SMOKE-BOUND canonical value from `smoke`. A label-only or fabricated
    /// hash (not backed by the genuinely-run round-trip) is refused.
    fn is_valid_for(
        &self,
        expected: WolfReadinessArtifactKind,
        smoke: &WolfExtractPatchVerifySmokeReport,
    ) -> bool {
        self.kind == expected
            && canonical_wolf_readiness_artifact_hash_from_smoke(smoke, self.kind)
                .is_some_and(|canonical| self.proof_hash == canonical)
    }
}

// The mechanical combiner (single source of truth)

/// The combined readiness evidence: the detector-derived protection profile,
/// the helper-boundary outcome (present only for a keyRef-bound profile), and
/// whether valid explicit synthetic extract/patch proofs back the top rungs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WolfReadinessEvidence {
    pub protection_profile: WolfProtectionProfile,
    pub helper_outcome: Option<WolfHelperBoundaryOutcome>,
    pub extract_proven: bool,
    pub patch_proven: bool,
}

/// Combine detector evidence + helper-boundary reporting into the achieved
/// readiness level. Total, pure, side-effect-free — the single source of truth.
/// The honesty invariants are structural:
/// - an `unknown` protection profile is always `unsupported` (no proof can lift
///   it); and
/// - `extract` / `patch` are unreachable without the matching explicit proof
///   AND a cleared key/helper gate.
pub fn derive_wolf_readiness_level(evidence: &WolfReadinessEvidence) -> WolfReadinessLevel {
    use WolfHelperBoundaryOutcome as O;
    use WolfProtectionProfile as P;
    use WolfReadinessLevel as L;

    match evidence.protection_profile {
        // Unrecognized protection: nothing beyond a partial identify is proven.
        P::Unknown => L::Unsupported,

        // Plain unencrypted archive: the detector lists the file table, so
        // `inventory` is the detector-proven floor. Extract/patch are claimed
        // ONLY with the matching explicit synthetic fixture proof.
        P::Plain => extract_patch_ceiling(evidence, L::Inventory),

        // Key-gated archives (static-key protected or dynamic-key helper): the
        // helper-boundary outcome decides whether the gate is cleared.
        P::Protected | P::HelperRequired => match evidence.helper_outcome {
            // No boundary evidence for a key-gated profile: identified, but the
            // gate is uncharacterized — identify only.
            None => L::Identify,
            // The gate is still closed (key missing, helper unrun locally, or
            // helper platform unavailable): we know the exact requirement, so
            // the honest achieved level is `helper_required`. Extract/patch are
            // unreachable while the gate is closed — even a supplied proof is
            // NOT honored.
            Some(O::KeyMissing | O::HelperRequired | O::HelperUnavailable) => L::HelperRequired,
            // The key resolved locally by ref: the gate is cleared. Extract/patch
            // are still claimed ONLY with the matching explicit fixture proof;
            // without one, a cleared gate proves no more than `helper_required`.
            Some(O::KeyResolved) => extract_patch_ceiling(evidence, L::HelperRequired),
        },
    }
}

/// Lift `floor` toward extract/patch only as far as the explicit proofs allow.
/// `patch` additionally requires that extraction is proven (you cannot patch
/// back what you cannot extract).
fn extract_patch_ceiling(
    evidence: &WolfReadinessEvidence,
    floor: WolfReadinessLevel,
) -> WolfReadinessLevel {
    if evidence.patch_proven && evidence.extract_proven {
        WolfReadinessLevel::Patch
    } else if evidence.extract_proven {
        WolfReadinessLevel::Extract
    } else {
        floor
    }
}

// Fixture (input) schema

/// One synthetic readiness case: the embedded detector record + optional
/// embedded helper-boundary profile + optional synthetic extract/patch proofs,
/// plus the level the case is authored to achieve.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfReadinessCase {
    /// Stable per-case fixture id.
    pub fixture_id: String,
    /// Stable readiness case id (a single-token identifier).
    pub case_id: String,
    /// The detector record this case's identify/inventory evidence comes from.
    pub detector: WolfProtectionDetectorFixtureEntry,
    /// The helper-boundary profile this case's key/helper evidence comes from.
    /// Present only for keyRef-bound protected / helper-required cases.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_boundary: Option<WolfHelperBoundaryProfile>,
    /// Optional explicit synthetic proof that extraction succeeded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extract_proof: Option<WolfReadinessArtifactProof>,
    /// Optional explicit synthetic proof that patch-back succeeded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch_proof: Option<WolfReadinessArtifactProof>,
    /// The level this case is authored to achieve. The resolver recomputes it
    /// from evidence and raises a finding on a mismatch.
    pub expected_level: WolfReadinessLevel,
}

/// A Wolf readiness fixture set — a small manifest of synthetic cases.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WolfReadinessFixture {
    pub schema_version: String,
    /// Stable id for the fixture set (synthetic; no retail names/local paths).
    pub readiness_set_id: String,
    /// The spec-DAG node id this fixture set is authored for (e.g. ``).
    pub source_node_id: String,
    pub engine_family: String,
    pub cases: Vec<WolfReadinessCase>,
}

// Report (generated) schema

/// One structured finding raised by the resolver.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfReadinessFinding {
    pub code: String,
    pub field: String,
    pub message: String,
}

impl WolfReadinessFinding {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

/// The generated per-case readiness report. Echoes the acceptance fields (case
/// id, detector profile, helper outcome, the derived level, secret requirement
/// ids, proof hashes) and carries the embedded detector + helper-boundary
/// sub-reports so the combination is auditable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfReadinessEntryReport {
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub case_id: String,
    /// The detector-derived protection profile (identify/inventory evidence).
    pub protection_profile: WolfProtectionProfile,
    /// The helper-boundary outcome (key/helper evidence), if a boundary applied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_outcome: Option<WolfHelperBoundaryOutcome>,
    /// The mechanically-derived achieved readiness level (single source of truth).
    pub readiness_level: WolfReadinessLevel,
    /// A short human-readable explanation of WHY this level was achieved — which
    /// evidence combined to it. Redacted like every other string.
    pub claim_basis: String,
    /// The secret requirement ids named by the helper result (redacted; never
    /// key bytes). Empty when no key/helper gate applied.
    pub secret_requirement_ids: Vec<String>,
    /// The sha256 proof hashes backing this case (helper key proofs + honored
    /// extract/patch artifact proofs).
    pub proof_hashes: Vec<ProofHash>,
    /// The embedded detector sub-report entry (detector evidence half).
    pub detector: WolfProtectionDetectorEntryReport,
    /// The embedded helper-boundary sub-report entry (helper evidence half).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_boundary: Option<WolfHelperBoundaryEntryReport>,
    pub status: OperationStatus,
    pub findings: Vec<WolfReadinessFinding>,
}

impl WolfReadinessEntryReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            case_id: redact_for_log_or_report(&self.case_id),
            protection_profile: self.protection_profile,
            helper_outcome: self.helper_outcome,
            readiness_level: self.readiness_level,
            claim_basis: redact_for_log_or_report(&self.claim_basis),
            secret_requirement_ids: self
                .secret_requirement_ids
                .iter()
                .map(|id| redact_for_log_or_report(id))
                .collect(),
            proof_hashes: self.proof_hashes.clone(),
            detector: self.detector.redacted_for_report(),
            helper_boundary: self
                .helper_boundary
                .as_ref()
                .map(WolfHelperBoundaryEntryReport::redacted_for_report),
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(WolfReadinessFinding::redacted_for_report)
                .collect(),
        }
    }
}

/// The aggregate readiness report over a fixture set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfReadinessReport {
    pub schema_version: String,
    pub readiness_set_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub entries: Vec<WolfReadinessEntryReport>,
}

impl WolfReadinessReport {
    pub fn entry(&self, fixture_id: &str) -> Option<&WolfReadinessEntryReport> {
        self.entries
            .iter()
            .find(|entry| entry.fixture_id == fixture_id)
    }

    /// The achieved level for a case, or `None` if the case is absent.
    pub fn level(&self, fixture_id: &str) -> Option<WolfReadinessLevel> {
        self.entry(fixture_id).map(|entry| entry.readiness_level)
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            readiness_set_id: redact_for_log_or_report(&self.readiness_set_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            entries: self
                .entries
                .iter()
                .map(WolfReadinessEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

// The resolver (the combiner)

/// Run the Wolf readiness combiner over a fixture set. Each case runs the REAL
/// detector and REAL helper-boundary subsystems over its embedded evidence and
/// combines their derived outputs into the achieved level mechanically; the
/// declared expectation is used only to raise findings. Never panics.
pub fn run_wolf_readiness(fixture: &WolfReadinessFixture) -> WolfReadinessReport {
    // Genuinely run the extract-patch-verify smoke ONCE. Its
    // per-variant round-trip output is the source of truth the `extract`/`patch`
    // rungs bind to. If the smoke does not pass (e.g. a broken profiled fixture),
    // NO case can honor an extract/patch proof and the top rungs stay unreached —
    // readiness never claims `patch-proven` without a verified smoke.
    let smoke = run_wolf_extract_patch_verify_smoke(&fixture.source_node_id).ok();
    let mut entries = Vec::with_capacity(fixture.cases.len());
    for case in &fixture.cases {
        entries.push(resolve_case(
            case,
            &fixture.source_node_id,
            &fixture.engine_family,
            smoke.as_ref(),
        ));
    }
    let status = aggregate_status(&entries);
    WolfReadinessReport {
        schema_version: WOLF_READINESS_REPORT_SCHEMA_VERSION.to_string(),
        readiness_set_id: fixture.readiness_set_id.clone(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        support_boundary: WOLF_READINESS_SUPPORT_BOUNDARY.to_string(),
        status,
        entries,
    }
}

fn aggregate_status(entries: &[WolfReadinessEntryReport]) -> OperationStatus {
    if entries
        .iter()
        .all(|entry| matches!(entry.status, OperationStatus::Passed))
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    }
}

fn resolve_case(
    case: &WolfReadinessCase,
    source_node_id: &str,
    engine_family: &str,
    smoke: Option<&WolfExtractPatchVerifySmokeReport>,
) -> WolfReadinessEntryReport {
    let mut findings: Vec<WolfReadinessFinding> = Vec::new();

    if engine_family != WOLF_ENGINE_FAMILY {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.wrong_engine_family".to_string(),
            field: "engineFamily".to_string(),
            message: format!(
                "Wolf readiness requires engineFamily={WOLF_ENGINE_FAMILY}, got {engine_family}"
            ),
        });
    }

    let detector_report = run_wolf_protection_detector(&WolfProtectionDetectorFixture {
        schema_version: crate::wolf_protection_detector::WOLF_PROTECTION_DETECTOR_SCHEMA_VERSION
            .to_string(),
        detector_set_id: format!("wolf-readiness/{}/detector", case.case_id),
        source_node_id: source_node_id.to_string(),
        engine_family: engine_family.to_string(),
        entries: vec![case.detector.clone()],
    });
    let detector_entry = detector_report
        .entries
        .into_iter()
        .next()
        .expect("single-entry detector fixture yields exactly one entry");
    if detector_entry.status != OperationStatus::Passed {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.detector_evidence_failed".to_string(),
            field: "detector".to_string(),
            message: "the embedded detector record failed its own validation".to_string(),
        });
    }
    let protection_profile = detector_entry.profile;

    let helper_entry: Option<WolfHelperBoundaryEntryReport> = case.helper_boundary.as_ref().map(
        |profile: &WolfHelperBoundaryProfile| {
            let report = run_wolf_helper_boundary(&WolfHelperBoundaryFixture {
                schema_version: crate::wolf_helper_boundary::WOLF_HELPER_BOUNDARY_SCHEMA_VERSION
                    .to_string(),
                boundary_set_id: format!("wolf-readiness/{}/helper-boundary", case.case_id),
                source_node_id: source_node_id.to_string(),
                engine_family: engine_family.to_string(),
                profiles: vec![profile.clone()],
            });
            report
                .entries
                .into_iter()
                .next()
                .expect("single-profile helper-boundary fixture yields exactly one entry")
        },
    );
    if let Some(entry) = &helper_entry
        && entry.status != OperationStatus::Passed
    {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.helper_boundary_evidence_failed".to_string(),
            field: "helperBoundary".to_string(),
            message: "the embedded helper-boundary profile failed its own validation".to_string(),
        });
    }
    let helper_outcome = helper_entry.as_ref().map(|entry| entry.outcome);

    // A keyRef-bound profile (protected / helper-required) whose case supplied a
    // helper boundary must serve the MATCHING protection profile — otherwise the
    // two evidence halves disagree about what archive we are looking at.
    if let Some(entry) = &helper_entry
        && entry.protection_profile != protection_profile
    {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.evidence_profile_mismatch".to_string(),
            field: "helperBoundary.boundaryKind".to_string(),
            message: format!(
                "detector classified {} but the helper boundary serves {}",
                protection_profile.as_str(),
                entry.protection_profile.as_str()
            ),
        });
    }

    // A proof is honored ONLY when its declared hash matches the SMOKE-BOUND
    // canonical value from a genuinely-run round-trip. If the smoke
    // itself did not pass, no proof is honored and a declared proof is a loud
    // finding — the readiness `patch` rung cannot be reached without a verified
    // smoke.
    let extract_proven = honor_proof(
        case.extract_proof.as_ref(),
        WolfReadinessArtifactKind::SyntheticExtractFixture,
        "extractProof",
        smoke,
        &mut findings,
    );
    let mut patch_proven = honor_proof(
        case.patch_proof.as_ref(),
        WolfReadinessArtifactKind::SyntheticPatchFixture,
        "patchProof",
        smoke,
        &mut findings,
    );
    // Patch-back cannot be proven without extraction.
    if patch_proven && !extract_proven {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.patch_without_extract".to_string(),
            field: "patchProof".to_string(),
            message: "a patch proof requires a matching extract proof (cannot patch back what cannot be extracted)".to_string(),
        });
        patch_proven = false;
    }

    let evidence = WolfReadinessEvidence {
        protection_profile,
        helper_outcome,
        extract_proven,
        patch_proven,
    };
    let readiness_level = derive_wolf_readiness_level(&evidence);

    // Honesty guard (defensive; structurally impossible): the extract/patch
    // rungs must be backed by an honored proof.
    if readiness_level.claims_extraction() && !extract_proven {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.overclaimed_extraction".to_string(),
            field: "readinessLevel".to_string(),
            message: format!(
                "level {} claims extraction without an honored synthetic extract proof",
                readiness_level.as_str()
            ),
        });
    }

    // Declared-vs-derived expectation.
    if case.expected_level != readiness_level {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.level_mismatch".to_string(),
            field: "expectedLevel".to_string(),
            message: format!(
                "case declared level {} but the combiner derived {}",
                case.expected_level.as_str(),
                readiness_level.as_str()
            ),
        });
    }

    // Assemble the auditable proof hashes + secret requirement ids.
    let mut proof_hashes: Vec<ProofHash> = Vec::new();
    let mut secret_requirement_ids: Vec<String> = Vec::new();
    if let Some(entry) = &helper_entry {
        proof_hashes.extend(
            entry
                .proof_hashes
                .iter()
                .map(|proof| proof.proof_hash.clone()),
        );
        secret_requirement_ids.extend(entry.secret_requirement_ids.iter().cloned());
    }
    if extract_proven && let Some(proof) = &case.extract_proof {
        proof_hashes.push(proof.proof_hash.clone());
    }
    if patch_proven && let Some(proof) = &case.patch_proof {
        proof_hashes.push(proof.proof_hash.clone());
    }

    let claim_basis = build_claim_basis(&evidence, readiness_level);

    let status = if findings.is_empty() {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    WolfReadinessEntryReport {
        fixture_id: case.fixture_id.clone(),
        source_node_id: source_node_id.to_string(),
        engine_family: engine_family.to_string(),
        case_id: case.case_id.clone(),
        protection_profile,
        helper_outcome,
        readiness_level,
        claim_basis,
        secret_requirement_ids,
        proof_hashes,
        detector: detector_entry,
        helper_boundary: helper_entry,
        status,
        findings,
    }
}

/// Validate an optional artifact proof and return whether it is HONORED (present
/// AND valid). An invalid (fabricated-hash / wrong-kind) proof is a finding and
/// is NOT honored — the rung it would unlock stays unclaimed.
fn honor_proof(
    proof: Option<&WolfReadinessArtifactProof>,
    expected: WolfReadinessArtifactKind,
    field: &str,
    smoke: Option<&WolfExtractPatchVerifySmokeReport>,
    findings: &mut Vec<WolfReadinessFinding>,
) -> bool {
    let Some(proof) = proof else {
        return false;
    };
    if proof.artifact_id.trim().is_empty() {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.artifact_id_missing".to_string(),
            field: field.to_string(),
            message: "an extract/patch proof is missing a non-empty artifactId".to_string(),
        });
        return false;
    }
    // The extract/patch rungs GATE on a genuinely-run smoke. If the smoke did
    // not pass, a declared proof cannot be honored — fail loud, never silent.
    let Some(smoke) = smoke else {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.smoke_not_proven".to_string(),
            field: field.to_string(),
            message: format!(
                "the {} rung requires a passing KAIFUU-145 extract-patch-verify smoke, but the smoke did not pass",
                expected.as_str()
            ),
        });
        return false;
    };
    if !proof.is_valid_for(expected, smoke) {
        findings.push(WolfReadinessFinding {
            code: "wolf.readiness.artifact_proof_invalid".to_string(),
            field: field.to_string(),
            message: format!(
                "the {} proof hash does not match the smoke-bound canonical value (label-only/fabricated/wrong-kind proof, not backed by a genuinely-run round-trip)",
                expected.as_str()
            ),
        });
        return false;
    }
    true
}

fn build_claim_basis(evidence: &WolfReadinessEvidence, level: WolfReadinessLevel) -> String {
    let detector = format!(
        "detector classified {}",
        evidence.protection_profile.as_str()
    );
    let helper = match evidence.helper_outcome {
        Some(outcome) => format!("; helper boundary reported {}", outcome.as_str()),
        None => String::new(),
    };
    let proofs = match (evidence.extract_proven, evidence.patch_proven) {
        (true, true) => "; synthetic extract + patch fixtures proven",
        (true, false) => "; synthetic extract fixture proven",
        _ => "",
    };
    format!(
        "achieved {}: {}{}{}",
        level.as_str(),
        detector,
        helper,
        proofs
    )
}

/// Load a Wolf readiness fixture set from disk.
pub fn read_wolf_readiness_fixture(path: &Path) -> KaifuuResult<WolfReadinessFixture> {
    read_json(path)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::wolf_helper_boundary::WolfHelperBoundaryOutcome;

    fn fixtures_dir() -> PathBuf {
        crate::test_manifest_dir()
            .join("../..")
            .join("fixtures/kaifuu/wolf")
    }

    fn load() -> WolfReadinessFixture {
        read_wolf_readiness_fixture(&fixtures_dir().join("readiness.cases.json"))
            .expect("Wolf readiness fixture must parse")
    }

    fn run() -> WolfReadinessReport {
        run_wolf_readiness(&load())
    }

    #[test]
    fn readiness_fixture_set_passes_and_records_every_field() {
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
                "case {} failed: {:?}",
                entry.case_id,
                entry.findings
            );
            assert_eq!(entry.engine_family, WOLF_ENGINE_FAMILY);
            assert_eq!(entry.source_node_id, "KAIFUU-040");
            assert!(!entry.case_id.is_empty());
            assert!(!entry.claim_basis.is_empty());
        }
    }

    #[test]
    fn the_six_levels_are_distinguished_by_fixture_evidence() {
        let report = run();
        assert_eq!(
            report.level("wolf.readiness.unsupported"),
            Some(WolfReadinessLevel::Unsupported)
        );
        assert_eq!(
            report.level("wolf.readiness.identify"),
            Some(WolfReadinessLevel::Identify)
        );
        assert_eq!(
            report.level("wolf.readiness.inventory"),
            Some(WolfReadinessLevel::Inventory)
        );
        assert_eq!(
            report.level("wolf.readiness.helper-required"),
            Some(WolfReadinessLevel::HelperRequired)
        );
        assert_eq!(
            report.level("wolf.readiness.extract"),
            Some(WolfReadinessLevel::Extract)
        );
        assert_eq!(
            report.level("wolf.readiness.patch"),
            Some(WolfReadinessLevel::Patch)
        );
    }

    #[test]
    fn each_case_combines_detector_and_helper_boundary_evidence() {
        let report = run();
        // A plain inventory case carries detector evidence, no helper boundary.
        let inventory = report.entry("wolf.readiness.inventory").unwrap();
        assert_eq!(inventory.protection_profile, WolfProtectionProfile::Plain);
        assert!(inventory.helper_outcome.is_none());
        assert!(inventory.helper_boundary.is_none());

        // A helper-required case carries BOTH the detector profile AND the
        // helper-boundary outcome.
        let helper = report.entry("wolf.readiness.helper-required").unwrap();
        assert!(matches!(
            helper.protection_profile,
            WolfProtectionProfile::Protected | WolfProtectionProfile::HelperRequired
        ));
        assert!(helper.helper_outcome.is_some());
        assert!(helper.helper_boundary.is_some());
        assert!(!helper.secret_requirement_ids.is_empty());

        // The extract case cleared the key gate (key resolved) AND carries a
        // synthetic extract proof.
        let extract = report.entry("wolf.readiness.extract").unwrap();
        assert_eq!(
            extract.helper_outcome,
            Some(WolfHelperBoundaryOutcome::KeyResolved)
        );
        assert!(!extract.proof_hashes.is_empty());
    }

    // --- Honesty: extract/patch are NEVER claimed without an explicit proof. --

    #[test]
    fn extract_and_patch_require_an_explicit_fixture_proof() {
        // Same key-resolved evidence, but no extract proof → capped at
        // helper_required (the cleared gate proves no extraction).
        let no_proof = WolfReadinessEvidence {
            protection_profile: WolfProtectionProfile::Protected,
            helper_outcome: Some(WolfHelperBoundaryOutcome::KeyResolved),
            extract_proven: false,
            patch_proven: false,
        };
        assert_eq!(
            derive_wolf_readiness_level(&no_proof),
            WolfReadinessLevel::HelperRequired
        );

        // With the extract proof honored → extract.
        let extract = WolfReadinessEvidence {
            extract_proven: true,
            ..no_proof
        };
        assert_eq!(
            derive_wolf_readiness_level(&extract),
            WolfReadinessLevel::Extract
        );

        // With both → patch.
        let patch = WolfReadinessEvidence {
            extract_proven: true,
            patch_proven: true,
            ..no_proof
        };
        assert_eq!(
            derive_wolf_readiness_level(&patch),
            WolfReadinessLevel::Patch
        );
    }

    #[test]
    fn unknown_profile_is_never_lifted_by_a_proof() {
        for (extract_proven, patch_proven) in [(false, false), (true, false), (true, true)] {
            let evidence = WolfReadinessEvidence {
                protection_profile: WolfProtectionProfile::Unknown,
                helper_outcome: None,
                extract_proven,
                patch_proven,
            };
            assert_eq!(
                derive_wolf_readiness_level(&evidence),
                WolfReadinessLevel::Unsupported
            );
        }
    }

    #[test]
    fn closed_gate_refuses_extraction_even_with_a_proof() {
        for outcome in [
            WolfHelperBoundaryOutcome::KeyMissing,
            WolfHelperBoundaryOutcome::HelperRequired,
            WolfHelperBoundaryOutcome::HelperUnavailable,
        ] {
            let evidence = WolfReadinessEvidence {
                protection_profile: WolfProtectionProfile::Protected,
                helper_outcome: Some(outcome),
                extract_proven: true,
                patch_proven: true,
            };
            assert_eq!(
                derive_wolf_readiness_level(&evidence),
                WolfReadinessLevel::HelperRequired,
                "outcome {outcome:?} must not reach extract",
            );
        }
    }

    #[test]
    fn fabricated_extract_proof_is_refused() {
        let mut fixture = load();
        let case = fixture
            .cases
            .iter_mut()
            .find(|c| c.fixture_id == "wolf.readiness.extract")
            .unwrap();
        // Corrupt the extract proof hash: a fabricated proof must not be honored.
        case.extract_proof.as_mut().unwrap().proof_hash =
            ProofHash::new(format!("sha256:{}", "a".repeat(64))).unwrap();
        let report = run_wolf_readiness(&fixture);
        let entry = report.entry("wolf.readiness.extract").unwrap();
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(
            entry
                .findings
                .iter()
                .any(|f| f.code == "wolf.readiness.artifact_proof_invalid")
        );
        // And the DERIVED level fell back below extract (the fabricated proof
        // was refused, so the cleared gate proves only helper_required).
        assert_eq!(entry.readiness_level, WolfReadinessLevel::HelperRequired);
    }

    #[test]
    fn readiness_patch_hash_equals_the_smoke_bound_value() {
        // The fixture's honored patch proof hash is exactly the SMOKE-BOUND
        // canonical value from a genuinely-run round-trip — not a
        let smoke = crate::wolf_extract_patch_verify_smoke::run_wolf_extract_patch_verify_smoke(
            "KAIFUU-040",
        )
        .expect("smoke runs");
        let canonical_patch = canonical_wolf_readiness_artifact_hash_from_smoke(
            &smoke,
            WolfReadinessArtifactKind::SyntheticPatchFixture,
        )
        .expect("smoke yields a patch proof");
        let fixture = load();
        let patch_case = fixture
            .cases
            .iter()
            .find(|c| c.fixture_id == "wolf.readiness.patch")
            .unwrap();
        assert_eq!(
            patch_case.patch_proof.as_ref().unwrap().proof_hash,
            canonical_patch,
            "the fixture patch proof must equal the smoke-bound value",
        );
        // And with that binding, the case genuinely reaches `patch`.
        let report = run_wolf_readiness(&fixture);
        assert_eq!(
            report.level("wolf.readiness.patch"),
            Some(WolfReadinessLevel::Patch)
        );
    }

    #[test]
    fn a_label_only_patch_proof_does_not_reach_patch_proven() {
        // Reproduce the OLD label hash (sha256 over a static label).
        // Because it is NOT the smoke-bound value, the patch rung is refused —
        // a fixture without a passing smoke behind it cannot reach patch-proven.
        let label_hash = ProofHash::new(crate::sha256_hash_bytes(
            b"wolf-readiness-artifact/synthetic_patch_fixture/wolf.synthetic.patch",
        ))
        .unwrap();
        let mut fixture = load();
        let case = fixture
            .cases
            .iter_mut()
            .find(|c| c.fixture_id == "wolf.readiness.patch")
            .unwrap();
        case.patch_proof.as_mut().unwrap().proof_hash = label_hash;
        let report = run_wolf_readiness(&fixture);
        let entry = report.entry("wolf.readiness.patch").unwrap();
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(
            entry
                .findings
                .iter()
                .any(|f| f.code == "wolf.readiness.artifact_proof_invalid"),
            "label-only proof must raise the invalid-proof finding: {:?}",
            entry.findings
        );
        // The DERIVED level fell BELOW patch: the label-only proof was refused,
        // so the case does NOT reach patch-proven.
        assert_ne!(entry.readiness_level, WolfReadinessLevel::Patch);
        assert!(entry.readiness_level < WolfReadinessLevel::Patch);
    }

    #[test]
    fn declared_level_mismatch_is_a_finding() {
        let mut fixture = load();
        let case = fixture
            .cases
            .iter_mut()
            .find(|c| c.fixture_id == "wolf.readiness.inventory")
            .unwrap();
        case.expected_level = WolfReadinessLevel::Patch;
        let report = run_wolf_readiness(&fixture);
        assert_eq!(report.status, OperationStatus::Failed);
        let entry = report.entry("wolf.readiness.inventory").unwrap();
        assert!(
            entry
                .findings
                .iter()
                .any(|f| f.code == "wolf.readiness.level_mismatch")
        );
        // The DERIVED level still refuses the lie.
        assert_eq!(entry.readiness_level, WolfReadinessLevel::Inventory);
    }

    #[test]
    fn report_is_redaction_clean() {
        let report = run();
        let json = report.stable_json().expect("stable json");
        // Ref-only: local-scheme secret refs + sha256 proof hashes survive.
        assert!(json.contains("local-secret:"));
        assert!(json.contains("sha256:"));
        // No raw key material, no private paths, no PEM blocks, no retail bytes.
        assert!(!json.contains("BEGIN"));
        assert!(!json.contains("/home/"));
        assert!(!json.contains("deadbeef"));
    }

    #[test]
    fn report_redacts_local_paths_and_never_carries_raw_key_material() {
        let mut fixture = load();
        fixture.readiness_set_id = "/home/trevor/private/wolf/leak.wolf".to_string();
        let report = run_wolf_readiness(&fixture);
        let json = report.stable_json().expect("stable json");
        assert!(json.contains("[REDACTED:"));
        assert!(!json.contains("/home/trevor/private/wolf/leak.wolf"));
        assert!(!json.contains("BEGIN"));
    }

    #[test]
    fn report_round_trips_through_json() {
        let report = run();
        let json = serde_json::to_string(&report.redacted_for_report()).expect("serialize");
        let round: WolfReadinessReport = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(round, report.redacted_for_report());
    }

    #[test]
    fn level_ordering_places_unsupported_at_the_floor() {
        assert!(WolfReadinessLevel::Unsupported < WolfReadinessLevel::Identify);
        assert!(WolfReadinessLevel::Identify < WolfReadinessLevel::Inventory);
        assert!(WolfReadinessLevel::Inventory < WolfReadinessLevel::HelperRequired);
        assert!(WolfReadinessLevel::HelperRequired < WolfReadinessLevel::Extract);
        assert!(WolfReadinessLevel::Extract < WolfReadinessLevel::Patch);
    }
}
