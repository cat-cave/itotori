//! KAIFUU-041 — BGI / Ethornell readiness proof.
//!
//! This node COMBINES the two BGI/Ethornell evidence sources that already exist
//! as their own honest, synthetic-fixture-driven subsystems into ONE
//! per-capability-level readiness report — mirroring the KAIFUU-040 Wolf
//! readiness proof:
//!
//! 1. the KAIFUU-126 BGI **archive/container detector**
//!    ([`crate::bgi_detector_fixture`]) — magic-byte-signature detector evidence
//!    that classifies a BGI-shaped container into a Buriko ARC20 / BSE / DSC /
//!    CompressedBG / no-header / unknown [`BgiDetectorProfile`] and advertises,
//!    with honest `missing_capability` diagnostics, which encrypted / compressed
//!    / layered / unknown variants are NOT supported; and
//! 2. the KAIFUU-127 BGI **scenario-bytecode parser**
//!    ([`crate::bgi_bytecode_fixture`]) — the header / no-header
//!    [`BgiBytecodeProfile`] parser that enumerates the Shift-JIS
//!    string-reference surfaces (character name / dialogue / backlog / ruby /
//!    file) inside an extensionless scenario file. Enumerating those surfaces is
//!    the honest `inventory` rung: the parser/profile capability boundary lists
//!    the translatable string surfaces but claims NO opcode execution, NO
//!    archive decryption/decompression, and NO patch-back.
//!
//! # The honest capability-level ladder (never over-claimed)
//!
//! The readiness report distinguishes FIVE achieved levels
//! ([`BgiReadinessLevel`]):
//!
//! - `unsupported` — the outer container variant is encrypted (BSE), compressed
//!   (DSC), layered (CompressedBG), header-less, or unrecognized: the detector
//!   reports the honest `missing_capability` boundary and the inner content is
//!   unreachable. The honest floor; below `identify` on purpose. No proof lifts
//!   it.
//! - `identify` — the detector recognized the Buriko ARC20 container, but no
//!   bytecode inventory backs a higher claim.
//! - `inventory` — the scenario-bytecode parser enumerated the string-reference
//!   surfaces (the parser/profile boundary): identify + list the translatable
//!   string surfaces, nothing more.
//! - `extract` — an explicit synthetic EXTRACT fixture proves member extraction
//!   AND the outer container gate is open.
//! - `patch` — an explicit synthetic PATCH fixture proves patch-back AND
//!   extraction is proven AND the outer container gate is open AND the embedded
//!   bytecode profile carries a verified extract-to-patch round-trip
//!   (`patch_reports` non-empty and verified).
//!
//! The single source of truth is [`derive_bgi_readiness_level`]: a pure, total
//! function of the detector-derived profile, whether a bytecode profile actually
//! parsed a string-reference inventory, and the presence of explicit
//! extract/patch fixture proofs. It can NEVER lift an encrypted / compressed /
//! layered / unknown container above `unsupported`, and it NEVER claims
//! `extract` or `patch` without an explicit synthetic fixture proof — the
//! strict-proof honesty invariant (no aspirational "supported"). Real BGI
//! archive decryption / decompression / extraction / patch-back is later adapter
//! work; this readiness proof reports only what the detector + bytecode parser +
//! explicit synthetic fixtures prove.
//!
//! # Engine-general (BGI = data, no per-game branch)
//!
//! Every case is pure DATA: an optional embedded detector record, an optional
//! embedded bytecode profile, and optional synthetic extract/patch proofs. The
//! resolver runs the REAL detector and REAL bytecode parser over the embedded
//! evidence and combines their derived outputs — there is no per-game branch and
//! no per-brand special case.
//!
//! # Evidence is synthetic, redacted, ref-only
//!
//! Cases carry NO retail bytes and NO raw key material: only synthetic ids, the
//! detector's structured profile signal, the bytecode parser's synthetic
//! Shift-JIS string surfaces, and sha256 proof hashes. Every emitted report is
//! funnelled through [`redact_for_log_or_report`] / [`stable_json`].

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::bgi_bytecode_fixture::{
    BGI_BYTECODE_FIXTURE_SCHEMA_VERSION, BgiBytecodeEntryReport, BgiBytecodeFixture,
    BgiBytecodeFixtureEntry, run_bgi_bytecode_fixture,
};
use crate::bgi_detector_fixture::{
    BGI_DETECTOR_FIXTURE_SCHEMA_VERSION, BGI_ENGINE_FAMILY, BgiDetectorEntryReport,
    BgiDetectorFixture, BgiDetectorFixtureEntry, BgiDetectorProfile, run_bgi_detector_fixture,
};
use crate::{
    KaifuuResult, OperationStatus, ProofHash, read_json, redact_for_log_or_report,
    sha256_hash_bytes, stable_json,
};

/// Schema version of the readiness fixture input.
pub const BGI_READINESS_SCHEMA_VERSION: &str = "0.1.0";
/// Schema version of the generated readiness report.
pub const BGI_READINESS_REPORT_SCHEMA_VERSION: &str = "0.1.0";

/// The provenance node the embedded detector evidence is validated under. The
/// KAIFUU-126 detector's tuple proof hash binds the source node, so the embedded
/// detector record keeps its own KAIFUU-126 provenance (this readiness node
/// CONSUMES that evidence, it does not re-mint it).
pub const BGI_READINESS_DETECTOR_PROVENANCE_NODE: &str = "KAIFUU-126";
/// The provenance node the embedded bytecode evidence is validated under.
pub const BGI_READINESS_BYTECODE_PROVENANCE_NODE: &str = "KAIFUU-127";

/// The support boundary surfaced in every BGI readiness report.
pub const BGI_READINESS_SUPPORT_BOUNDARY: &str = "The BGI/Ethornell readiness proof COMBINES the KAIFUU-126 archive/container detector evidence (identify + honest missing_capability boundaries for encrypted/compressed/layered/unknown variants) with the KAIFUU-127 scenario-bytecode parser evidence (inventory of Shift-JIS string-reference surfaces plus verified extract-to-patch round-trips) into ONE per-capability-level readiness report. It reports the ACHIEVED level (unsupported, identify, inventory, extract, or patch) mechanically per the fixture evidence and NEVER claims a level beyond it: an encrypted (BSE), compressed (DSC), layered (CompressedBG), header-less, or unrecognized container is unsupported; identify recognizes a Buriko ARC20 container; inventory enumerates the parser/profile string-reference surfaces; extract is claimed ONLY where an explicit synthetic fixture proves it; patch additionally requires a verified bytecode extract-to-patch round-trip (non-empty verified patch_reports) plus an explicit synthetic patch fixture (retail BGI archive decryption/decompression/extraction/patch-back is later adapter work and is never claimed here). Evidence is synthetic and redacted — synthetic ids and sha256 hashes only, never raw keys, paths, or retail bytes.";

// ---------------------------------------------------------------------------
// The achieved readiness level (the five-rung honest ladder)
// ---------------------------------------------------------------------------

/// The capability level a BGI/Ethornell input achieves, combining detector
/// evidence with bytecode-parser evidence. Ordered from least to most
/// capability, with `Unsupported` as the honest floor for an
/// encrypted/compressed/layered/unknown container.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BgiReadinessLevel {
    /// Encrypted / compressed / layered / header-less / unrecognized container —
    /// the detector reports the honest `missing_capability` boundary and nothing
    /// beyond it is proven. The honest floor; below `identify` on purpose.
    Unsupported,
    /// The detector recognized the Buriko ARC20 container.
    Identify,
    /// The scenario-bytecode parser enumerated the string-reference surfaces (the
    /// parser/profile boundary) but no extraction fixture backs a higher claim.
    Inventory,
    /// An explicit synthetic extract fixture proves member extraction, the outer
    /// container gate is open.
    Extract,
    /// An explicit synthetic patch fixture proves patch-back, extraction proven,
    /// the outer container gate is open, and the embedded bytecode profile
    /// verified an extract-to-patch round-trip.
    Patch,
}

impl BgiReadinessLevel {
    /// Stable canonical string used in ids, records, and findings.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unsupported => "unsupported",
            Self::Identify => "identify",
            Self::Inventory => "inventory",
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

// ---------------------------------------------------------------------------
// Explicit synthetic extract/patch fixture proofs (the honesty gate)
// ---------------------------------------------------------------------------

/// Which synthetic archive-operation artifact a proof backs. The extract and
/// patch rungs are claimed ONLY when the matching proof is present and valid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BgiReadinessArtifactKind {
    /// A synthetic proof that a BGI archive member was extracted (unlocks `extract`).
    SyntheticExtractFixture,
    /// A synthetic proof that a BGI archive was patched back (unlocks `patch`).
    SyntheticPatchFixture,
}

impl BgiReadinessArtifactKind {
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
pub enum BgiReadinessProvenance {
    /// A public, non-copyrighted synthetic fixture (never retail bytes).
    PublicSynthetic,
}

/// An explicit synthetic proof that a BGI archive operation (extract / patch)
/// succeeded on synthetic bytes. Carries a stable artifact id + a sha256 proof
/// hash the resolver RECOMPUTES from the artifact id — a fabricated hash is
/// refused, so the extract/patch rungs can never be claimed by a bare boolean.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BgiReadinessArtifactProof {
    pub kind: BgiReadinessArtifactKind,
    /// Stable synthetic artifact id (never a retail name / local path).
    pub artifact_id: String,
    /// sha256 proof hash over the synthetic artifact — recomputed + checked.
    pub proof_hash: ProofHash,
    pub provenance: BgiReadinessProvenance,
}

/// The canonical proof hash for a readiness artifact — a sha256 over a synthetic
/// label bound to the kind + artifact id. The resolver recomputes this and
/// rejects any proof whose declared hash disagrees.
pub fn canonical_bgi_readiness_artifact_hash(
    kind: BgiReadinessArtifactKind,
    artifact_id: &str,
) -> ProofHash {
    ProofHash::new(sha256_hash_bytes(
        format!("bgi-readiness-artifact/{}/{}", kind.as_str(), artifact_id).as_bytes(),
    ))
    .expect("sha256_hash_bytes yields a valid sha256 ref")
}

impl BgiReadinessArtifactProof {
    /// True iff the proof is of the expected kind and its declared hash matches
    /// the canonical recomputation.
    fn is_valid_for(&self, expected: BgiReadinessArtifactKind) -> bool {
        self.kind == expected
            && self.proof_hash
                == canonical_bgi_readiness_artifact_hash(self.kind, &self.artifact_id)
    }
}

// ---------------------------------------------------------------------------
// The mechanical combiner (single source of truth)
// ---------------------------------------------------------------------------

/// The combined readiness evidence: the detector-derived container profile
/// (present only when a container detector record applied), whether a bytecode
/// profile actually parsed a string-reference inventory, and whether valid
/// explicit synthetic extract/patch proofs back the top rungs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BgiReadinessEvidence {
    /// The detector-classified outer container, if a container record applied.
    /// `None` means a pure extensionless scenario-bytecode artifact (already out
    /// of any archive), so there is no outer container gate.
    pub container_profile: Option<BgiDetectorProfile>,
    /// True iff the scenario-bytecode parser enumerated at least one
    /// string-reference surface (the honest `inventory` evidence).
    pub inventory_proven: bool,
    pub extract_proven: bool,
    pub patch_proven: bool,
}

impl BgiReadinessEvidence {
    /// The outer-container gate: only a recognized Buriko ARC20 container, or the
    /// ABSENCE of a container (a pure scenario-bytecode artifact), leaves the
    /// inner-content gate open. An encrypted (BSE) / compressed (DSC) / layered
    /// (CompressedBG) / header-less / unknown container closes it — the inner
    /// content is unreachable, so nothing beyond `unsupported` can ever be
    /// claimed for that artifact.
    fn container_gate_open(&self) -> bool {
        match self.container_profile {
            // No container record (pure scenario-bytecode artifact) or a recognized
            // Buriko ARC20 container leaves the inner-content gate open.
            None | Some(BgiDetectorProfile::BurikoArc20Container) => true,
            // Encrypted / compressed / layered / header-less / unknown closes it.
            Some(_) => false,
        }
    }
}

/// Combine detector evidence + bytecode-parser evidence into the achieved
/// readiness level. Total, pure, side-effect-free — the single source of truth.
///
/// The honesty invariants are structural:
/// - an encrypted / compressed / layered / header-less / unknown container is
///   always `unsupported` (no proof lifts it); and
/// - `extract` / `patch` are unreachable without the matching explicit proof AND
///   an open outer-container gate.
pub fn derive_bgi_readiness_level(evidence: &BgiReadinessEvidence) -> BgiReadinessLevel {
    use BgiDetectorProfile as P;
    use BgiReadinessLevel as L;

    // A closed outer-container gate (encrypted/compressed/layered/unknown) is the
    // honest floor no matter what inner or synthetic proof is supplied.
    if !evidence.container_gate_open() {
        return L::Unsupported;
    }

    if evidence.inventory_proven {
        // A parsed bytecode profile enumerated the translatable string surfaces.
        extract_patch_ceiling(evidence, L::Inventory)
    } else if matches!(evidence.container_profile, Some(P::BurikoArc20Container)) {
        // Recognized container, but no bytecode inventory backs a higher claim.
        L::Identify
    } else {
        // No container record AND no bytecode inventory: nothing is proven.
        L::Unsupported
    }
}

/// Lift `floor` toward extract/patch only as far as the explicit proofs allow.
/// `patch` additionally requires that extraction is proven (you cannot patch
/// back what you cannot extract).
fn extract_patch_ceiling(
    evidence: &BgiReadinessEvidence,
    floor: BgiReadinessLevel,
) -> BgiReadinessLevel {
    if evidence.patch_proven && evidence.extract_proven {
        BgiReadinessLevel::Patch
    } else if evidence.extract_proven {
        BgiReadinessLevel::Extract
    } else {
        floor
    }
}

// ---------------------------------------------------------------------------
// Fixture (input) schema
// ---------------------------------------------------------------------------

/// One synthetic readiness case: the OPTIONAL embedded detector record
/// (container identify evidence) + the OPTIONAL embedded bytecode profile
/// (parser/profile inventory evidence) + optional synthetic extract/patch
/// proofs, plus the level the case is authored to achieve.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BgiReadinessCase {
    /// Stable per-case fixture id.
    pub fixture_id: String,
    /// Stable readiness case id (a single-token identifier).
    pub case_id: String,
    /// The detector record this case's identify evidence comes from. Present for
    /// container-level cases (identify / unsupported / extract / patch).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detector: Option<BgiDetectorFixtureEntry>,
    /// The bytecode profile this case's inventory evidence comes from. Present
    /// for cases that expose the parser/profile string-reference surfaces.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytecode: Option<BgiBytecodeFixtureEntry>,
    /// Optional explicit synthetic proof that extraction succeeded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extract_proof: Option<BgiReadinessArtifactProof>,
    /// Optional explicit synthetic proof that patch-back succeeded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch_proof: Option<BgiReadinessArtifactProof>,
    /// The level this case is authored to achieve. The resolver recomputes it
    /// from evidence and raises a finding on a mismatch.
    pub expected_level: BgiReadinessLevel,
}

/// A BGI readiness fixture set — a small manifest of synthetic cases.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BgiReadinessFixture {
    pub schema_version: String,
    /// Stable id for the fixture set (synthetic; no retail names/local paths).
    pub readiness_set_id: String,
    /// The spec-DAG node id this fixture set is authored for (e.g. `KAIFUU-041`).
    pub source_node_id: String,
    pub engine_family: String,
    pub cases: Vec<BgiReadinessCase>,
}

// ---------------------------------------------------------------------------
// Report (generated) schema
// ---------------------------------------------------------------------------

/// One structured finding raised by the resolver.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgiReadinessFinding {
    pub code: String,
    pub field: String,
    pub message: String,
}

impl BgiReadinessFinding {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

/// The generated per-case readiness report. Echoes the acceptance fields (case
/// id, container profile, inventory surface count, the derived level, proof
/// hashes) and carries the embedded detector + bytecode sub-reports so the
/// combination is auditable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgiReadinessEntryReport {
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub case_id: String,
    /// The detector-derived container profile (identify evidence), if a container
    /// record applied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_profile: Option<BgiDetectorProfile>,
    /// The count of string-reference surfaces the bytecode parser enumerated (the
    /// inventory evidence). Zero when no bytecode profile applied.
    pub inventory_surface_count: usize,
    /// The mechanically-derived achieved readiness level (single source of truth).
    pub readiness_level: BgiReadinessLevel,
    /// A short human-readable explanation of WHY this level was achieved — which
    /// evidence combined to it. Redacted like every other string.
    pub claim_basis: String,
    /// The sha256 proof hashes backing this case (detector/bytecode source proofs
    /// + honored extract/patch artifact proofs).
    pub proof_hashes: Vec<ProofHash>,
    /// The embedded detector sub-report entry (container evidence half).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detector: Option<BgiDetectorEntryReport>,
    /// The embedded bytecode sub-report entry (inventory evidence half).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytecode: Option<BgiBytecodeEntryReport>,
    pub status: OperationStatus,
    pub findings: Vec<BgiReadinessFinding>,
}

impl BgiReadinessEntryReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            case_id: redact_for_log_or_report(&self.case_id),
            container_profile: self.container_profile,
            inventory_surface_count: self.inventory_surface_count,
            readiness_level: self.readiness_level,
            claim_basis: redact_for_log_or_report(&self.claim_basis),
            proof_hashes: self.proof_hashes.clone(),
            detector: self
                .detector
                .as_ref()
                .map(BgiDetectorEntryReport::redacted_for_report),
            bytecode: self
                .bytecode
                .as_ref()
                .map(BgiBytecodeEntryReport::redacted_for_report),
            status: self.status.clone(),
            findings: self
                .findings
                .iter()
                .map(BgiReadinessFinding::redacted_for_report)
                .collect(),
        }
    }
}

/// The aggregate readiness report over a fixture set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgiReadinessReport {
    pub schema_version: String,
    pub readiness_set_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub entries: Vec<BgiReadinessEntryReport>,
}

impl BgiReadinessReport {
    pub fn entry(&self, fixture_id: &str) -> Option<&BgiReadinessEntryReport> {
        self.entries
            .iter()
            .find(|entry| entry.fixture_id == fixture_id)
    }

    /// The achieved level for a case, or `None` if the case is absent.
    pub fn level(&self, fixture_id: &str) -> Option<BgiReadinessLevel> {
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
                .map(BgiReadinessEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

// ---------------------------------------------------------------------------
// The resolver (the combiner)
// ---------------------------------------------------------------------------

/// Run the BGI readiness combiner over a fixture set. Each case runs the REAL
/// detector and REAL bytecode parser over its embedded evidence and combines
/// their derived outputs into the achieved level mechanically; the declared
/// expectation is used only to raise findings. Never panics.
pub fn run_bgi_readiness(fixture: &BgiReadinessFixture) -> BgiReadinessReport {
    let mut entries = Vec::with_capacity(fixture.cases.len());
    for case in &fixture.cases {
        entries.push(resolve_case(
            case,
            &fixture.source_node_id,
            &fixture.engine_family,
        ));
    }
    let status = aggregate_status(&entries);
    BgiReadinessReport {
        schema_version: BGI_READINESS_REPORT_SCHEMA_VERSION.to_string(),
        readiness_set_id: fixture.readiness_set_id.clone(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        support_boundary: BGI_READINESS_SUPPORT_BOUNDARY.to_string(),
        status,
        entries,
    }
}

fn aggregate_status(entries: &[BgiReadinessEntryReport]) -> OperationStatus {
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
    case: &BgiReadinessCase,
    source_node_id: &str,
    engine_family: &str,
) -> BgiReadinessEntryReport {
    let mut findings: Vec<BgiReadinessFinding> = Vec::new();

    if engine_family != BGI_ENGINE_FAMILY {
        findings.push(BgiReadinessFinding {
            code: "bgi.readiness.wrong_engine_family".to_string(),
            field: "engineFamily".to_string(),
            message: format!(
                "BGI readiness requires engineFamily={BGI_ENGINE_FAMILY}, got {engine_family}"
            ),
        });
    }

    // --- Run the REAL detector over the embedded record (evidence half 1). ---
    // The embedded record keeps its KAIFUU-126 provenance node (its tuple proof
    // hash binds the source node); this readiness node CONSUMES that evidence.
    let detector_entry: Option<BgiDetectorEntryReport> = case.detector.as_ref().map(|entry| {
        let report = run_bgi_detector_fixture(&BgiDetectorFixture {
            schema_version: BGI_DETECTOR_FIXTURE_SCHEMA_VERSION.to_string(),
            detector_set_id: format!("bgi-readiness/{}/detector", case.case_id),
            source_node_id: BGI_READINESS_DETECTOR_PROVENANCE_NODE.to_string(),
            engine_family: engine_family.to_string(),
            entries: vec![entry.clone()],
        });
        report
            .entries
            .into_iter()
            .next()
            .expect("single-entry detector fixture yields exactly one entry")
    });
    if let Some(entry) = &detector_entry
        && entry.status != OperationStatus::Passed
    {
        findings.push(BgiReadinessFinding {
            code: "bgi.readiness.detector_evidence_failed".to_string(),
            field: "detector".to_string(),
            message: "the embedded detector record failed its own validation".to_string(),
        });
    }
    let container_profile = detector_entry.as_ref().map(|entry| entry.profile);

    // --- Run the REAL bytecode parser over the embedded profile (half 2). ----
    let bytecode_entry: Option<BgiBytecodeEntryReport> = case.bytecode.as_ref().map(|entry| {
        let report = run_bgi_bytecode_fixture(&BgiBytecodeFixture {
            schema_version: BGI_BYTECODE_FIXTURE_SCHEMA_VERSION.to_string(),
            profile_set_id: format!("bgi-readiness/{}/bytecode", case.case_id),
            source_node_id: BGI_READINESS_BYTECODE_PROVENANCE_NODE.to_string(),
            engine_family: engine_family.to_string(),
            entries: vec![entry.clone()],
        });
        report
            .entries
            .into_iter()
            .next()
            .expect("single-entry bytecode fixture yields exactly one entry")
    });
    if let Some(entry) = &bytecode_entry
        && entry.status != OperationStatus::Passed
    {
        findings.push(BgiReadinessFinding {
            code: "bgi.readiness.bytecode_evidence_failed".to_string(),
            field: "bytecode".to_string(),
            message: "the embedded bytecode profile failed its own validation".to_string(),
        });
    }
    // Inventory is proven ONLY when the parser passed AND actually enumerated at
    // least one string-reference surface — a failed or empty parse proves nothing.
    let inventory_surface_count = bytecode_entry
        .as_ref()
        .filter(|entry| entry.status == OperationStatus::Passed)
        .map_or(0, |entry| entry.string_references.len());
    let inventory_proven = inventory_surface_count > 0;

    // --- Validate + honor the explicit synthetic extract/patch proofs. -------
    let extract_proven = honor_proof(
        case.extract_proof.as_ref(),
        BgiReadinessArtifactKind::SyntheticExtractFixture,
        "extractProof",
        &mut findings,
    );
    let mut patch_proven = honor_proof(
        case.patch_proof.as_ref(),
        BgiReadinessArtifactKind::SyntheticPatchFixture,
        "patchProof",
        &mut findings,
    );
    // Patch-back cannot be proven without extraction.
    if patch_proven && !extract_proven {
        findings.push(BgiReadinessFinding {
            code: "bgi.readiness.patch_without_extract".to_string(),
            field: "patchProof".to_string(),
            message: "a patch proof requires a matching extract proof (cannot patch back what cannot be extracted)".to_string(),
        });
        patch_proven = false;
    }
    // Patch readiness also requires a VERIFIED bytecode extract-to-patch
    // round-trip: non-empty patch_reports whose patched text + untouched bytes
    // actually verified. A bare synthetic patchProof hash alone is not enough.
    let bytecode_patch_verified = bytecode_entry.as_ref().is_some_and(|entry| {
        entry.status == OperationStatus::Passed
            && !entry.patch_reports.is_empty()
            && entry
                .patch_reports
                .iter()
                .all(|report| report.patched_text_verified && report.untouched_bytes_identical)
    });
    if patch_proven && !bytecode_patch_verified {
        findings.push(BgiReadinessFinding {
            code: "bgi.readiness.bytecode_patch_proof_missing".to_string(),
            field: "bytecode.patchCases".to_string(),
            message: "a patch readiness level requires a verified bytecode extract-to-patch round-trip (non-empty verified patch_reports from the embedded bytecode profile)".to_string(),
        });
        patch_proven = false;
    }

    // --- Combine the evidence into the achieved level (source of truth). -----
    let evidence = BgiReadinessEvidence {
        container_profile,
        inventory_proven,
        extract_proven,
        patch_proven,
    };
    let readiness_level = derive_bgi_readiness_level(&evidence);

    // Honesty guard (defensive; structurally impossible): the extract/patch rungs
    // must be backed by an honored proof.
    if readiness_level.claims_extraction() && !extract_proven {
        findings.push(BgiReadinessFinding {
            code: "bgi.readiness.overclaimed_extraction".to_string(),
            field: "readinessLevel".to_string(),
            message: format!(
                "level {} claims extraction without an honored synthetic extract proof",
                readiness_level.as_str()
            ),
        });
    }

    // Declared-vs-derived expectation.
    if case.expected_level != readiness_level {
        findings.push(BgiReadinessFinding {
            code: "bgi.readiness.level_mismatch".to_string(),
            field: "expectedLevel".to_string(),
            message: format!(
                "case declared level {} but the combiner derived {}",
                case.expected_level.as_str(),
                readiness_level.as_str()
            ),
        });
    }

    // Assemble the auditable proof hashes.
    let mut proof_hashes: Vec<ProofHash> = Vec::new();
    if let Some(entry) = &detector_entry {
        proof_hashes.extend(entry.proof_hashes.iter().cloned());
    }
    if let Some(entry) = &bytecode_entry {
        proof_hashes.extend(entry.proof_hashes.iter().cloned());
    }
    if extract_proven && let Some(proof) = &case.extract_proof {
        proof_hashes.push(proof.proof_hash.clone());
    }
    if patch_proven && let Some(proof) = &case.patch_proof {
        proof_hashes.push(proof.proof_hash.clone());
    }

    let claim_basis = build_claim_basis(&evidence, inventory_surface_count, readiness_level);

    let status = if findings.is_empty() {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    BgiReadinessEntryReport {
        fixture_id: case.fixture_id.clone(),
        source_node_id: source_node_id.to_string(),
        engine_family: engine_family.to_string(),
        case_id: case.case_id.clone(),
        container_profile,
        inventory_surface_count,
        readiness_level,
        claim_basis,
        proof_hashes,
        detector: detector_entry,
        bytecode: bytecode_entry,
        status,
        findings,
    }
}

/// Validate an optional artifact proof and return whether it is HONORED (present
/// AND valid). An invalid (fabricated-hash / wrong-kind) proof is a finding and
/// is NOT honored — the rung it would unlock stays unclaimed.
fn honor_proof(
    proof: Option<&BgiReadinessArtifactProof>,
    expected: BgiReadinessArtifactKind,
    field: &str,
    findings: &mut Vec<BgiReadinessFinding>,
) -> bool {
    let Some(proof) = proof else {
        return false;
    };
    if proof.artifact_id.trim().is_empty() {
        findings.push(BgiReadinessFinding {
            code: "bgi.readiness.artifact_id_missing".to_string(),
            field: field.to_string(),
            message: "an extract/patch proof is missing a non-empty artifactId".to_string(),
        });
        return false;
    }
    if !proof.is_valid_for(expected) {
        findings.push(BgiReadinessFinding {
            code: "bgi.readiness.artifact_proof_invalid".to_string(),
            field: field.to_string(),
            message: format!(
                "the {} proof hash does not match the canonical recomputation (or wrong kind)",
                expected.as_str()
            ),
        });
        return false;
    }
    true
}

fn build_claim_basis(
    evidence: &BgiReadinessEvidence,
    inventory_surface_count: usize,
    level: BgiReadinessLevel,
) -> String {
    let detector = match evidence.container_profile {
        Some(profile) => format!("detector classified {}", profile.as_str()),
        None => "no container record (pure scenario-bytecode artifact)".to_string(),
    };
    let inventory = if evidence.inventory_proven {
        format!(
            "; bytecode parser enumerated {inventory_surface_count} string-reference surface(s)"
        )
    } else {
        String::new()
    };
    let proofs = match (evidence.extract_proven, evidence.patch_proven) {
        (true, true) => {
            "; synthetic extract + patch fixtures proven with verified bytecode extract-to-patch"
        }
        (true, false) => "; synthetic extract fixture proven",
        _ => "",
    };
    format!(
        "achieved {}: {}{}{}",
        level.as_str(),
        detector,
        inventory,
        proofs
    )
}

/// Load a BGI readiness fixture set from disk.
pub fn read_bgi_readiness_fixture(path: &Path) -> KaifuuResult<BgiReadinessFixture> {
    read_json(path)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn fixtures_dir() -> PathBuf {
        crate::test_manifest_dir()
            .join("../..")
            .join("fixtures/kaifuu/bgi")
    }

    fn load() -> BgiReadinessFixture {
        read_bgi_readiness_fixture(&fixtures_dir().join("readiness.cases.json"))
            .expect("BGI readiness fixture must parse")
    }

    fn run() -> BgiReadinessReport {
        run_bgi_readiness(&load())
    }

    // --- The whole fixture set is green + records every acceptance field. -----

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
        assert_eq!(report.engine_family, BGI_ENGINE_FAMILY);
        assert_eq!(report.source_node_id, "KAIFUU-041");
        for entry in &report.entries {
            assert_eq!(
                entry.status,
                OperationStatus::Passed,
                "case {} failed: {:?}",
                entry.case_id,
                entry.findings
            );
            assert_eq!(entry.engine_family, BGI_ENGINE_FAMILY);
            assert_eq!(entry.source_node_id, "KAIFUU-041");
            assert!(!entry.case_id.is_empty());
            assert!(!entry.claim_basis.is_empty());
        }
    }

    // --- THE crux: the five capability levels are DISTINGUISHED per fixture. --

    #[test]
    fn the_five_levels_are_distinguished_by_fixture_evidence() {
        let report = run();
        assert_eq!(
            report.level("bgi.readiness.unsupported-encrypted"),
            Some(BgiReadinessLevel::Unsupported)
        );
        assert_eq!(
            report.level("bgi.readiness.unsupported-compressed"),
            Some(BgiReadinessLevel::Unsupported)
        );
        assert_eq!(
            report.level("bgi.readiness.unsupported-unknown"),
            Some(BgiReadinessLevel::Unsupported)
        );
        assert_eq!(
            report.level("bgi.readiness.identify"),
            Some(BgiReadinessLevel::Identify)
        );
        assert_eq!(
            report.level("bgi.readiness.inventory-header"),
            Some(BgiReadinessLevel::Inventory)
        );
        assert_eq!(
            report.level("bgi.readiness.inventory-no-header"),
            Some(BgiReadinessLevel::Inventory)
        );
        assert_eq!(
            report.level("bgi.readiness.extract"),
            Some(BgiReadinessLevel::Extract)
        );
        assert_eq!(
            report.level("bgi.readiness.patch"),
            Some(BgiReadinessLevel::Patch)
        );
    }

    // --- The combination is REAL: identify vs inventory use different halves. -

    #[test]
    fn each_case_combines_detector_and_bytecode_evidence() {
        let report = run();

        // An identify case carries a recognized container detector, NO bytecode.
        let identify = report.entry("bgi.readiness.identify").unwrap();
        assert_eq!(
            identify.container_profile,
            Some(BgiDetectorProfile::BurikoArc20Container)
        );
        assert!(identify.detector.is_some());
        assert!(identify.bytecode.is_none());
        assert_eq!(identify.inventory_surface_count, 0);

        // An inventory case carries the bytecode parser surface, and enumerated
        // at least one string-reference surface.
        let inventory = report.entry("bgi.readiness.inventory-header").unwrap();
        assert!(inventory.bytecode.is_some());
        assert!(inventory.inventory_surface_count > 0);

        // The extract case cleared the container gate (recognized container) AND
        // carries a synthetic extract proof, so it holds more proof hashes than
        // the inventory case.
        let extract = report.entry("bgi.readiness.extract").unwrap();
        assert_eq!(
            extract.container_profile,
            Some(BgiDetectorProfile::BurikoArc20Container)
        );
        assert!(extract.inventory_surface_count > 0);
        assert!(!extract.proof_hashes.is_empty());
    }

    // --- Honesty: the unsupported cases surface the missing_capability boundary.

    #[test]
    fn unsupported_cases_report_the_honest_missing_capability_boundary() {
        let report = run();
        let encrypted = report.entry("bgi.readiness.unsupported-encrypted").unwrap();
        assert_eq!(
            encrypted.container_profile,
            Some(BgiDetectorProfile::BseEncryptedContainer)
        );
        let detector = encrypted.detector.as_ref().unwrap();
        // The detector's own honest diagnostics carry the encrypted / missing
        // crypto boundary — the readiness proof does NOT invent a key requirement.
        assert!(detector.secret_requirement_ids.is_empty());
        assert!(
            detector.diagnostics.iter().any(|d| {
                d.semantic_code == crate::SemanticErrorCode::UnsupportedVariantEncrypted
            })
        );
        assert!(
            detector
                .diagnostics
                .iter()
                .any(|d| { d.semantic_code == crate::SemanticErrorCode::MissingCryptoCapability })
        );

        let compressed = report
            .entry("bgi.readiness.unsupported-compressed")
            .unwrap();
        let compressed_detector = compressed.detector.as_ref().unwrap();
        assert!(
            compressed_detector
                .diagnostics
                .iter()
                .any(|d| { d.semantic_code == crate::SemanticErrorCode::MissingCodecCapability })
        );
    }

    // --- Honesty: extract/patch are NEVER claimed without an explicit proof. --

    #[test]
    fn extract_and_patch_require_an_explicit_fixture_proof() {
        // Recognized container + bytecode inventory, but no extract proof → capped
        // at inventory (the inventory proves no extraction).
        let no_proof = BgiReadinessEvidence {
            container_profile: Some(BgiDetectorProfile::BurikoArc20Container),
            inventory_proven: true,
            extract_proven: false,
            patch_proven: false,
        };
        assert_eq!(
            derive_bgi_readiness_level(&no_proof),
            BgiReadinessLevel::Inventory
        );

        // With the extract proof honored → extract.
        let extract = BgiReadinessEvidence {
            extract_proven: true,
            ..no_proof
        };
        assert_eq!(
            derive_bgi_readiness_level(&extract),
            BgiReadinessLevel::Extract
        );

        // With both → patch.
        let patch = BgiReadinessEvidence {
            extract_proven: true,
            patch_proven: true,
            ..no_proof
        };
        assert_eq!(derive_bgi_readiness_level(&patch), BgiReadinessLevel::Patch);
    }

    // --- Honesty: an encrypted/compressed container is never lifted by a proof.

    #[test]
    fn closed_container_is_never_lifted_by_a_proof() {
        for profile in [
            BgiDetectorProfile::BseEncryptedContainer,
            BgiDetectorProfile::DscCompressedContainer,
            BgiDetectorProfile::CompressedBgLayeredTransform,
            BgiDetectorProfile::NoHeaderArc,
            BgiDetectorProfile::UnknownContainer,
        ] {
            for (inventory_proven, extract_proven, patch_proven) in [
                (false, false, false),
                (true, false, false),
                (true, true, false),
                (true, true, true),
            ] {
                let evidence = BgiReadinessEvidence {
                    container_profile: Some(profile),
                    inventory_proven,
                    extract_proven,
                    patch_proven,
                };
                assert_eq!(
                    derive_bgi_readiness_level(&evidence),
                    BgiReadinessLevel::Unsupported,
                    "profile {profile:?} must not be lifted above unsupported",
                );
            }
        }
    }

    // --- Patch level requires a verified bytecode extract-to-patch proof. -----

    #[test]
    fn patch_level_requires_verified_bytecode_patch_report() {
        let mut fixture = load();
        let case = fixture
            .cases
            .iter_mut()
            .find(|c| c.fixture_id == "bgi.readiness.patch")
            .unwrap();
        // Keep the synthetic patchProof hash, but strip the real bytecode
        // extract-to-patch cases so the round-trip never ran.
        let bytecode = case.bytecode.as_mut().unwrap();
        bytecode.claims_patch_support = false;
        bytecode.patch_cases.clear();

        let report = run_bgi_readiness(&fixture);
        let entry = report.entry("bgi.readiness.patch").unwrap();
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(
            entry
                .findings
                .iter()
                .any(|f| f.code == "bgi.readiness.bytecode_patch_proof_missing"),
            "missing bytecode patch proof must be a finding: {:?}",
            entry.findings
        );
        // Does NOT reach Patch — falls back to Extract (extract proof still honored).
        assert_eq!(entry.readiness_level, BgiReadinessLevel::Extract);
        assert!(
            entry
                .bytecode
                .as_ref()
                .is_some_and(|bc| bc.patch_reports.is_empty())
        );
    }

    #[test]
    fn committed_patch_case_composes_bytecode_extract_to_patch_proof() {
        let report = run();
        let entry = report.entry("bgi.readiness.patch").unwrap();
        assert_eq!(
            entry.status,
            OperationStatus::Passed,
            "{:?}",
            entry.findings
        );
        assert_eq!(entry.readiness_level, BgiReadinessLevel::Patch);
        let bytecode = entry.bytecode.as_ref().expect("patch case embeds bytecode");
        assert!(
            !bytecode.patch_reports.is_empty(),
            "committed patch readiness case must embed a real bytecode patch proof"
        );
        assert!(
            bytecode
                .patch_reports
                .iter()
                .all(|report| { report.patched_text_verified && report.untouched_bytes_identical })
        );
    }

    // --- A fabricated extract proof (wrong hash) is refused. ------------------

    #[test]
    fn fabricated_extract_proof_is_refused() {
        let mut fixture = load();
        let case = fixture
            .cases
            .iter_mut()
            .find(|c| c.fixture_id == "bgi.readiness.extract")
            .unwrap();
        // Corrupt the extract proof hash: a fabricated proof must not be honored.
        case.extract_proof.as_mut().unwrap().proof_hash =
            ProofHash::new(format!("sha256:{}", "a".repeat(64))).unwrap();
        let report = run_bgi_readiness(&fixture);
        let entry = report.entry("bgi.readiness.extract").unwrap();
        assert_eq!(entry.status, OperationStatus::Failed);
        assert!(
            entry
                .findings
                .iter()
                .any(|f| f.code == "bgi.readiness.artifact_proof_invalid")
        );
        // And the DERIVED level fell back below extract (the fabricated proof was
        // refused, so the bytecode inventory proves only inventory).
        assert_eq!(entry.readiness_level, BgiReadinessLevel::Inventory);
    }

    // --- The resolver catches a lying declared level. ------------------------

    #[test]
    fn declared_level_mismatch_is_a_finding() {
        let mut fixture = load();
        let case = fixture
            .cases
            .iter_mut()
            .find(|c| c.fixture_id == "bgi.readiness.inventory-header")
            .unwrap();
        case.expected_level = BgiReadinessLevel::Patch;
        let report = run_bgi_readiness(&fixture);
        assert_eq!(report.status, OperationStatus::Failed);
        let entry = report.entry("bgi.readiness.inventory-header").unwrap();
        assert!(
            entry
                .findings
                .iter()
                .any(|f| f.code == "bgi.readiness.level_mismatch")
        );
        // The DERIVED level still refuses the lie.
        assert_eq!(entry.readiness_level, BgiReadinessLevel::Inventory);
    }

    // --- Redaction-clean: synthetic ids + hashes only, no keys/paths/bytes. ---

    #[test]
    fn report_is_redaction_clean() {
        let report = run();
        let json = report.stable_json().expect("stable json");
        // Ref-only: sha256 proof hashes survive.
        assert!(json.contains("sha256:"));
        // No raw key material, no private paths, no PEM blocks, no secret refs.
        assert!(!json.contains("BEGIN"));
        assert!(!json.contains("/home/"));
        assert!(!json.contains("local-secret:"));
    }

    #[test]
    fn report_redacts_local_paths_and_never_carries_raw_key_material() {
        let mut fixture = load();
        fixture.readiness_set_id = "/home/trevor/private/bgi/leak.arc".to_string();
        let report = run_bgi_readiness(&fixture);
        let json = report.stable_json().expect("stable json");
        assert!(json.contains("[REDACTED:"));
        assert!(!json.contains("/home/trevor/private/bgi/leak.arc"));
        assert!(!json.contains("BEGIN"));
    }

    #[test]
    fn report_round_trips_through_json() {
        let report = run();
        let json = serde_json::to_string(&report.redacted_for_report()).expect("serialize");
        let round: BgiReadinessReport = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(round, report.redacted_for_report());
    }

    // --- The combiner is total over the level ladder. ------------------------

    #[test]
    fn level_ordering_places_unsupported_at_the_floor() {
        assert!(BgiReadinessLevel::Unsupported < BgiReadinessLevel::Identify);
        assert!(BgiReadinessLevel::Identify < BgiReadinessLevel::Inventory);
        assert!(BgiReadinessLevel::Inventory < BgiReadinessLevel::Extract);
        assert!(BgiReadinessLevel::Extract < BgiReadinessLevel::Patch);
    }
}
