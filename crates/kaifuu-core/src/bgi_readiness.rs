//! BGI / Ethornell readiness proof.
//! This node COMBINES the two BGI/Ethornell evidence sources that already exist
//! as their own honest, synthetic-fixture-driven subsystems into ONE
//! per-capability-level readiness report — mirroring the Wolf
//! readiness proof:
//! 1. the BGI **archive/container detector**
//!    ([`crate::bgi_detector_fixture`]) — magic-byte-signature detector evidence
//!    that classifies a BGI-shaped container into a Buriko ARC20 / BSE / DSC /
//!    CompressedBG / no-header / unknown [`BgiDetectorProfile`] and advertises,
//!    with honest `missing_capability` diagnostics, which encrypted / compressed
//!    layered / unknown variants are NOT supported; and
//! 2. the BGI **scenario-bytecode parser**
//!    ([`crate::bgi_bytecode_fixture`]) — the header / no-header
//!    [`BgiBytecodeProfile`] parser that enumerates the Shift-JIS
//!    string-reference surfaces (character name / dialogue / backlog / ruby /
//!    file) inside an extensionless scenario file. Enumerating those surfaces is
//!    the honest `inventory` rung: the parser/profile capability boundary lists
//!    the translatable string surfaces but claims NO opcode execution, NO
//!    archive decryption/decompression, and NO patch-back.
//! # The honest capability-level ladder (never over-claimed)
//! The readiness report distinguishes FIVE achieved levels
//! ([`BgiReadinessLevel`]):
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
//!   The single source of truth is [`derive_bgi_readiness_level`]: a pure, total
//!   function of the detector-derived profile, whether a bytecode profile actually
//!   parsed a string-reference inventory, and the presence of explicit
//!   extract/patch fixture proofs. It can NEVER lift an encrypted / compressed /
//!   layered / unknown container above `unsupported`, and it NEVER claims
//!   `extract` or `patch` without an explicit synthetic fixture proof — the
//!   strict-proof honesty invariant (no aspirational "supported"). Real BGI
//!   archive decryption / decompression / extraction / patch-back is later adapter
//!   work; this readiness proof reports only what the detector + bytecode parser +
//!   explicit synthetic fixtures prove.
//! # Engine-general (BGI = data, no per-game branch)
//! Every case is pure DATA: an optional embedded detector record, an optional
//! embedded bytecode profile, and optional synthetic extract/patch proofs. The
//! resolver runs the REAL detector and REAL bytecode parser over the embedded
//! evidence and combines their derived outputs — there is no per-game branch and
//! no per-brand special case.
//! # Evidence is synthetic, redacted, ref-only
//! Cases carry NO retail bytes and NO raw key material: only synthetic ids, the
//! detector's structured profile signal, the bytecode parser's synthetic
//! Shift-JIS string surfaces, and sha256 proof hashes. Every emitted report is
//! funnelled through [`redact_for_log_or_report`] / [`stable_json`].

use serde::{Deserialize, Serialize};

use crate::bgi_bytecode_fixture::{BgiBytecodeEntryReport, BgiBytecodeFixtureEntry};
use crate::bgi_detector_fixture::{
    BgiDetectorEntryReport, BgiDetectorFixtureEntry, BgiDetectorProfile,
};
use crate::{
    KaifuuResult, OperationStatus, ProofHash, redact_for_log_or_report, sha256_hash_bytes,
    stable_json,
};

mod resolver;

pub use resolver::{read_bgi_readiness_fixture, run_bgi_readiness};

/// Schema version of the readiness fixture input.
pub const BGI_READINESS_SCHEMA_VERSION: &str = "0.1.0";
/// Schema version of the generated readiness report.
pub const BGI_READINESS_REPORT_SCHEMA_VERSION: &str = "0.1.0";

/// The provenance node the embedded detector evidence is validated under. The
/// detector's tuple proof hash binds the source node, so the embedded
/// detector record keeps its own provenance (this readiness node
/// CONSUMES that evidence, it does not re-mint it).
pub const BGI_READINESS_DETECTOR_PROVENANCE_NODE: &str = "KAIFUU-126";
/// The provenance node the embedded bytecode evidence is validated under.
pub const BGI_READINESS_BYTECODE_PROVENANCE_NODE: &str = "KAIFUU-127";

/// The support boundary surfaced in every BGI readiness report.
pub const BGI_READINESS_SUPPORT_BOUNDARY: &str = "The BGI/Ethornell readiness proof COMBINES the KAIFUU-126 archive/container detector evidence (identify + honest missing_capability boundaries for encrypted/compressed/layered/unknown variants) with the KAIFUU-127 scenario-bytecode parser evidence (inventory of Shift-JIS string-reference surfaces plus verified extract-to-patch round-trips) into ONE per-capability-level readiness report. It reports the ACHIEVED level (unsupported, identify, inventory, extract, or patch) mechanically per the fixture evidence and NEVER claims a level beyond it: an encrypted (BSE), compressed (DSC), layered (CompressedBG), header-less, or unrecognized container is unsupported; identify recognizes a Buriko ARC20 container; inventory enumerates the parser/profile string-reference surfaces; extract is claimed ONLY where an explicit synthetic fixture proves it; patch additionally requires a verified bytecode extract-to-patch round-trip (non-empty verified patch_reports) plus an explicit synthetic patch fixture (retail BGI archive decryption/decompression/extraction/patch-back is later adapter work and is never claimed here). Evidence is synthetic and redacted — synthetic ids and sha256 hashes only, never raw keys, paths, or retail bytes.";

// The achieved readiness level (the five-rung honest ladder)

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

// Explicit synthetic extract/patch fixture proofs (the honesty gate)

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

// The mechanical combiner (single source of truth)

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

// Fixture (input) schema

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
    /// The spec-DAG node id this fixture set is authored for (e.g. ``).
    pub source_node_id: String,
    pub engine_family: String,
    pub cases: Vec<BgiReadinessCase>,
}

// Report (generated) schema

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
