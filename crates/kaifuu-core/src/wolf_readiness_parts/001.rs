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
pub const WOLF_READINESS_SUPPORT_BOUNDARY: &str = "The Wolf RPG Editor readiness proof COMBINES the  protection-detector evidence (identify/inventory) with the  key/protection helper-boundary reporting (key_resolved/key_missing/helper_required/helper_unavailable) into ONE per-capability-level readiness report. It reports the ACHIEVED level (identify, inventory, helper-required, extract, patch, or unsupported) mechanically per the fixture evidence and NEVER claims a level beyond it: an unrecognized protection variant is unsupported; extract and patch are claimed ONLY where an explicit synthetic fixture proves them (retail Wolf extraction/patch-back is a later adapter node, , and is never claimed here). Evidence is synthetic and redacted — secret refs and sha256 hashes only, never raw keys, paths, or retail bytes.";

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
    /// Provenance node id stamped into generated reports.
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


