//! First Siglus **opcode-profile scaffold**.
//!
//! [`crate::vm`] () runs a synthetic Siglus-shaped bytecode program
//! through an in-process interpreter; [`crate::runtime_profile`] ()
//! gates the *container* boundary before any VM run. This module lands the
//! missing layer between them: an **opcode profile** that **DECLARES**, *before*
//! any opcode is dispatched, exactly which Siglus opcodes the runner covers
//! which it names-but-refuses, and what happens when it meets an opcode it never
//! declared. It is a **narrow scaffold** — the golden fixture is **one** covered
//! text-show opcode, not a broad VM opcode pack.
//!
//! # Why declare-before-run
//!
//! An engine port that discovers its opcode coverage *mid-run* can silently
//! skip a command it does not understand and still look like it "worked". The
//! substrate law is the opposite: **an unsupported opcode can never pass
//! silently.** This module makes coverage a *declared surface* fixed in an
//! [`OpcodeProfile`] manifest that exists before [`run_opcode_conformance`] is
//! ever called. The conformance result echoes that declared surface verbatim
//! (see [`OpcodeConformanceResult::declared_coverage`]) — it is *not* rebuilt
//! from whatever opcodes the program happened to contain.
//!
//! # The three dispatch outcomes (all VISIBLE)
//!
//! opcode vs. profile | outcome
//! -------------------------------------|--------------------------------------------
//! declared [`OpcodeSupport::Covered`] | dispatched; recorded in the golden trace
//! declared [`OpcodeSupport::DeclaredUnsupported`] | structured diagnostic; run halts
//! **not declared at all** | structured `NotInProfile` diagnostic; halt
//!
//! The last two are the "no silent skip" law. They are enforced at the *type*
//! level too: the only declared reaction to an unsupported opcode is
//! [`UnsupportedBehavior::SurfaceDiagnosticAndHalt`] — the enum has no
//! `SilentSkip` variant to pick, so a future edit cannot quietly opt into
//! silence without adding one (which the substrate audit would catch).
//!
//! # Honest scope
//!
//! The opcode bytes + mnemonics here are **authored synthetic stand-ins**, NOT
//! the real Siglus opcode table (that is the `siglus-opcode-dispatch` Research
//! subsystem in [`crate::vm_impl_map`]). Siglus real bytes are corpus-blocked
//! so this scaffold is synthetic-fixture-based per the synthetic-CI model. What
//! it proves is the *shape* a real Siglus opcode profile must take: a declared
//! coverage surface, a golden trace for a covered opcode, and a
//! cannot-pass-silently diagnostic for anything outside it.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use utsushi_core::substrate::{EvidenceTier, reject_unredacted_local_paths};

use crate::runtime_profile::ProofHash;

/// Schema version of the opcode-profile manifest + conformance-result pair.
pub const OPCODE_PROFILE_SCHEMA_VERSION: &str = "0.1.0";

/// Stable capability id every opcode-profile conformance result carries.
pub const OPCODE_PROFILE_CAPABILITY_ID: &str = "utsushi-siglus-opcode-profile";

/// The blunt support boundary surfaced in every conformance result. Explicit
/// that this is a declared *scaffold* coverage surface over a synthetic opcode
/// set, not a claim of real Siglus opcode-table coverage.
pub const OPCODE_PROFILE_SUPPORT_BOUNDARY: &str = "Utsushi Siglus opcode profile DECLARES — before any opcode is dispatched — which SYNTHETIC (authored, NOT the real Siglus opcode table) opcodes the scaffold runner covers, which it names-but-refuses (declared-unsupported), and that any opcode outside the declared surface surfaces a structured diagnostic and halts (never a silent skip). A covered opcode produces a deterministic golden trace at the E1 admission tier. It does NOT claim real Siglus opcode-table coverage, real Scene.pck decode, or a rendered frame; the real opcode table is the siglus-opcode-dispatch Research subsystem.";

/// The synthetic magic prefixing an opcode-profile fixture program. Authored
/// here; NOT a retail container signature.
const OPCODE_PROGRAM_MAGIC: &[u8; 12] = b"USIG-OPC-P01";

// --- Authored synthetic opcode bytes (NOT the real Siglus opcode table) -----

/// Covered: show a dialogue line. Carries a length-prefixed UTF-8 text payload.
const OPC_TEXT_SHOW: u8 = 0x01;
/// Declared-unsupported: load a graphics surface. Named in the profile so the
/// declared-unsupported diagnostic path is exercised, but the runner refuses it
/// (graphics dispatch is Research scope).
const OPC_GRP_LOAD: u8 = 0x40;

/// The clearly-synthetic dialogue text the golden text-show fixture emits.
const FIXTURE_TEXT_SHOW_PAYLOAD: &str = "[synthetic-siglus-opcode-text-0]";

// --- Opcode identity + declared support -------------------------------------

/// A single Siglus opcode identity: its on-wire byte. Ordered so a profile's
/// declared coverage can be surfaced in a stable order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OpcodeId(pub u8);

impl OpcodeId {
    /// The raw opcode byte.
    pub fn byte(self) -> u8 {
        self.0
    }
}

impl std::fmt::Display for OpcodeId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{:#04x}", self.0)
    }
}

/// The declared support status for one opcode, fixed in the profile manifest
/// **before** any run. `Covered` opcodes dispatch; `DeclaredUnsupported` opcodes
/// surface a diagnostic (they are named so an operator sees *why* the runner
/// refuses them, rather than the opcode vanishing into the unknown bucket).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "status")]
pub enum OpcodeSupport {
    /// The runner has a (synthetic-scaffold) handler for this opcode.
    Covered,
    /// The opcode is a known Siglus opcode the scaffold deliberately does not
    /// handle yet. Encountering it surfaces a declared-unsupported diagnostic —
    /// never a silent skip.
    DeclaredUnsupported {
        /// Why the scaffold refuses the opcode (e.g. "graphics dispatch is
        /// Research scope"). Surfaced in the diagnostic.
        reason: String,
    },
}

impl OpcodeSupport {
    /// Whether this declared status admits dispatch.
    pub fn is_covered(&self) -> bool {
        matches!(self, Self::Covered)
    }
}

/// One entry in the opcode-profile manifest: an opcode, its stable mnemonic, and
/// its declared support status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpcodeProfileEntry {
    /// The opcode byte.
    pub opcode: OpcodeId,
    /// Stable mnemonic (e.g. `text.show`). Authored, not extracted.
    pub mnemonic: String,
    /// The declared support status, fixed before any run.
    pub support: OpcodeSupport,
}

/// The declared reaction to an opcode outside the profile's coverage surface.
///
/// This enum intentionally has a **single** variant. The substrate law forbids
/// silently skipping an unsupported opcode, so there is deliberately no
/// `SilentSkip` alternative to select — a future edit that wanted silence would
/// have to *add* a variant, which is exactly the change the substrate audit is
/// there to catch. The declared behaviour is therefore fixed before the run and
/// cannot be a silent pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum UnsupportedBehavior {
    /// Emit a structured diagnostic and halt the run.
    SurfaceDiagnosticAndHalt,
}

/// The opcode-profile **manifest**: the declared coverage surface. Constructed
/// (declared) in full before [`run_opcode_conformance`] is called. The runner
/// only ever *reads* this — it never mutates it or adds discovered opcodes to
/// it, so the coverage surface is always the pre-run declaration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpcodeProfile {
    /// Schema version.
    pub schema_version: String,
    /// Stable per-profile id.
    pub profile_id: String,
    /// Capability id.
    pub capability_id: String,
    /// The blunt support boundary.
    pub support_boundary: String,
    /// The declared opcode entries. Order is the declared order (stable).
    pub entries: Vec<OpcodeProfileEntry>,
    /// The declared reaction to an opcode NOT present in `entries`.
    pub unknown_opcode_behavior: UnsupportedBehavior,
}

impl OpcodeProfile {
    /// Look up an opcode's declared entry, if the profile declares it.
    pub fn entry(&self, opcode: OpcodeId) -> Option<&OpcodeProfileEntry> {
        self.entries.iter().find(|entry| entry.opcode == opcode)
    }

    /// Serialize to stable, redaction-swept JSON. This is the committable
    /// *manifest* evidence (the declared coverage surface, before any run).
    pub fn stable_json(&self) -> Result<String, String> {
        stable_redacted_json(self)
    }
}

// --- The fixture program (the one narrow opcode stream the runner walks) -----

/// A synthetic opcode-profile fixture: a magic header + a flat list of opcodes
/// each optionally carrying a length-prefixed text payload. Authored in-process
/// from module constants — no retail bytes.
///
/// This is deliberately minimal: the golden fixture is a **single** text-show
/// opcode. The diagnostic fixtures are a single unsupported opcode each. There
/// is no branch/stack/expression machinery here — that is [`crate::vm`] and the
/// real Research subsystems.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpcodeProgram {
    ops: Vec<FixtureOp>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FixtureOp {
    opcode: OpcodeId,
    text: Option<String>,
}

impl OpcodeProgram {
    /// Encode the program to its synthetic on-wire bytes. The digest of these
    /// bytes is committed in the conformance result so the golden trace is
    /// pinned to an exact byte stream.
    fn encode(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(OPCODE_PROGRAM_MAGIC);
        bytes.extend_from_slice(
            &u32::try_from(self.ops.len())
                .unwrap_or(u32::MAX)
                .to_le_bytes(),
        );
        for op in &self.ops {
            bytes.push(op.opcode.byte());
            match &op.text {
                Some(text) => {
                    bytes.push(1);
                    let raw = text.as_bytes();
                    bytes.extend_from_slice(
                        &u32::try_from(raw.len()).unwrap_or(u32::MAX).to_le_bytes(),
                    );
                    bytes.extend_from_slice(raw);
                }
                None => bytes.push(0),
            }
        }
        bytes
    }
}

// --- Dispatch trace + diagnostics -------------------------------------------

/// What happened when the runner met one opcode. Every arm is VISIBLE in the
/// conformance result — an unsupported opcode is a distinct, recorded arm, never
/// an absent entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "outcome")]
pub enum DispatchKind {
    /// A `Covered` opcode dispatched. Carries the mnemonic and any emitted text
    /// (the golden observable for a text-show opcode).
    Dispatched {
        /// The declared mnemonic that dispatched.
        mnemonic: String,
        /// Text emitted by the opcode, if any.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        emitted_text: Option<String>,
    },
    /// A `DeclaredUnsupported` opcode: surfaced a diagnostic; did NOT pass.
    DeclaredUnsupported {
        /// The declared mnemonic that was refused.
        mnemonic: String,
    },
    /// An opcode not present in the profile at all: surfaced an unknown
    /// diagnostic; did NOT pass.
    NotInProfile,
}

/// One trace step: the opcode, its index, and the visible outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpcodeDispatch {
    /// Zero-based position of this opcode in the program.
    pub index: u32,
    /// The opcode byte.
    pub opcode: OpcodeId,
    /// The visible dispatch outcome.
    pub kind: DispatchKind,
}

/// A typed, structured unsupported-opcode diagnostic. Its existence in a
/// conformance result is proof that an unsupported opcode did NOT pass silently.
/// Both variants carry the opcode + program index so the operator can locate it.
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "code")]
pub enum UnsupportedOpcodeDiagnostic {
    /// The opcode is declared in the profile but marked
    /// [`OpcodeSupport::DeclaredUnsupported`].
    #[error(
        "utsushi.siglus.opcode_profile.declared_unsupported: profile {profile_id} declares opcode \
         {opcode} ({mnemonic}) as unsupported ({reason}); run halted at index {index}; no silent skip"
    )]
    DeclaredUnsupported {
        /// Profile whose coverage refused the opcode.
        profile_id: String,
        /// The refused opcode.
        opcode: OpcodeId,
        /// The declared mnemonic.
        mnemonic: String,
        /// Why the scaffold refuses it.
        reason: String,
        /// Program index the opcode was met at.
        index: u32,
    },
    /// The opcode is NOT in the profile's declared coverage surface at all. This
    /// is the pure "unknown opcode" case: it can never pass silently.
    #[error(
        "utsushi.siglus.opcode_profile.not_in_profile: profile {profile_id} does not declare \
         opcode {opcode}; run halted at index {index}; no silent skip"
    )]
    NotInProfile {
        /// Profile whose coverage did not declare the opcode.
        profile_id: String,
        /// The undeclared opcode.
        opcode: OpcodeId,
        /// Program index the opcode was met at.
        index: u32,
    },
}

impl UnsupportedOpcodeDiagnostic {
    /// The opcode this diagnostic rejects.
    pub fn opcode(&self) -> OpcodeId {
        match self {
            Self::DeclaredUnsupported { opcode, .. } | Self::NotInProfile { opcode, .. } => *opcode,
        }
    }
}

/// An opcode echoed into the conformance result's declared-coverage surface.
/// Sourced from the profile manifest, NOT from the program — so it reflects what
/// was declared before the run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredOpcode {
    /// The declared opcode.
    pub opcode: OpcodeId,
    /// Its declared mnemonic.
    pub mnemonic: String,
    /// Its declared support status.
    pub support: OpcodeSupport,
}

// --- The conformance result (the committable output) ------------------------

/// The opcode-profile **conformance result**. Shows the declared coverage
/// surface (echoed from the profile, pre-run) alongside the dispatch trace and
/// every unsupported opcode encountered. E1: deterministic, non-visual.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpcodeConformanceResult {
    /// Report schema version.
    pub schema_version: String,
    /// Capability id.
    pub capability_id: String,
    /// The spec-DAG node id this result is authored for.
    pub source_node_id: String,
    /// The profile id the run was conformance-checked against.
    pub profile_id: String,
    /// The blunt support boundary.
    pub support_boundary: String,
    /// The declared coverage surface, echoed from the profile manifest BEFORE
    /// the run. Never rebuilt from the program's opcodes.
    pub declared_coverage: Vec<DeclaredOpcode>,
    /// The dispatch trace: one visible entry per opcode the program presented
    /// in program order, up to (and including) the halting opcode.
    pub trace: Vec<OpcodeDispatch>,
    /// Every unsupported/unknown opcode encountered. Non-empty iff the run met
    /// an opcode outside its `Covered` surface. This is the field that makes an
    /// unsupported opcode VISIBLE — it can never be an empty success.
    pub unsupported_encountered: Vec<UnsupportedOpcodeDiagnostic>,
    /// One-way commitment to the synthetic program bytes the run consumed.
    pub program_digest: ProofHash,
    /// Whether the run halted early on an unsupported opcode.
    pub halted_on_unsupported: bool,
    /// The evidence tier this result is capped at.
    pub evidence_tier: EvidenceTier,
}

impl OpcodeConformanceResult {
    /// The spec-DAG node id stamped on every opcode-profile conformance result.
    pub const SOURCE_NODE_ID: &'static str = "UTSUSHI-036";

    /// Serialize to stable, redaction-swept JSON. This is the committable
    /// conformance-result evidence.
    pub fn stable_json(&self) -> Result<String, String> {
        stable_redacted_json(self)
    }
}

// --- The conformance runner (the profile gate) ------------------------------

/// Walk `program`'s opcode stream against the pre-declared `profile`, producing
/// a deterministic [`OpcodeConformanceResult`].
///
/// - A `Covered` opcode dispatches and appends a [`DispatchKind::Dispatched`]
///   trace step (with any emitted text).
/// - A `DeclaredUnsupported` opcode appends a
///   [`DispatchKind::DeclaredUnsupported`] step, pushes an
///   [`UnsupportedOpcodeDiagnostic::DeclaredUnsupported`], and **halts** —
///   honouring the profile's declared [`UnsupportedBehavior`].
/// - An opcode not declared at all appends a [`DispatchKind::NotInProfile`]
///   step, pushes an [`UnsupportedOpcodeDiagnostic::NotInProfile`], and halts.
///
/// The declared-coverage surface in the result is sourced from `profile` — the
/// runner never adds the program's opcodes to it, so coverage is always the
/// pre-run declaration.
/// Classify a single opcode against the pre-declared profile, returning its
/// visible dispatch step and — for a declared-unsupported or undeclared opcode —
/// the structured diagnostic that makes it impossible to pass silently.
fn classify_opcode(
    profile: &OpcodeProfile,
    op: &FixtureOp,
    index: u32,
) -> (OpcodeDispatch, Option<UnsupportedOpcodeDiagnostic>) {
    let step = |kind| OpcodeDispatch {
        index,
        opcode: op.opcode,
        kind,
    };
    match profile.entry(op.opcode) {
        Some(entry) => match &entry.support {
            OpcodeSupport::Covered => (
                step(DispatchKind::Dispatched {
                    mnemonic: entry.mnemonic.clone(),
                    emitted_text: op.text.clone(),
                }),
                None,
            ),
            OpcodeSupport::DeclaredUnsupported { reason } => (
                step(DispatchKind::DeclaredUnsupported {
                    mnemonic: entry.mnemonic.clone(),
                }),
                Some(UnsupportedOpcodeDiagnostic::DeclaredUnsupported {
                    profile_id: profile.profile_id.clone(),
                    opcode: op.opcode,
                    mnemonic: entry.mnemonic.clone(),
                    reason: reason.clone(),
                    index,
                }),
            ),
        },
        None => (
            step(DispatchKind::NotInProfile),
            Some(UnsupportedOpcodeDiagnostic::NotInProfile {
                profile_id: profile.profile_id.clone(),
                opcode: op.opcode,
                index,
            }),
        ),
    }
}

pub fn run_opcode_conformance(
    profile: &OpcodeProfile,
    program: &OpcodeProgram,
) -> OpcodeConformanceResult {
    let program_bytes = program.encode();
    let program_digest = ProofHash::commit(&program_bytes);

    // Echo the DECLARED coverage surface from the profile — before, and
    // independent of, walking the program.
    let declared_coverage = profile
        .entries
        .iter()
        .map(|entry| DeclaredOpcode {
            opcode: entry.opcode,
            mnemonic: entry.mnemonic.clone(),
            support: entry.support.clone(),
        })
        .collect();

    let mut trace = Vec::new();
    let mut unsupported_encountered = Vec::new();
    let mut halted_on_unsupported = false;

    for (index, op) in program.ops.iter().enumerate() {
        let index = u32::try_from(index).unwrap_or(u32::MAX);
        let (dispatch, diagnostic) = classify_opcode(profile, op, index);
        trace.push(dispatch);
        if let Some(diagnostic) = diagnostic {
            unsupported_encountered.push(diagnostic);
            // Honour the declared unsupported behaviour: halt. The enum has no
            // silent-skip variant, so this is the only reaction.
            let UnsupportedBehavior::SurfaceDiagnosticAndHalt = profile.unknown_opcode_behavior;
            halted_on_unsupported = true;
            break;
        }
    }

    OpcodeConformanceResult {
        schema_version: OPCODE_PROFILE_SCHEMA_VERSION.to_string(),
        capability_id: OPCODE_PROFILE_CAPABILITY_ID.to_string(),
        source_node_id: OpcodeConformanceResult::SOURCE_NODE_ID.to_string(),
        profile_id: profile.profile_id.clone(),
        support_boundary: OPCODE_PROFILE_SUPPORT_BOUNDARY.to_string(),
        declared_coverage,
        trace,
        unsupported_encountered,
        program_digest,
        halted_on_unsupported,
        evidence_tier: EvidenceTier::E1,
    }
}

// --- Redaction-swept serialization ------------------------------------------

fn stable_redacted_json<T: Serialize>(value: &T) -> Result<String, String> {
    let json_value = serde_json::to_value(value)
        .map_err(|error| format!("opcode-profile report serialization failed: {error}"))?;
    reject_unredacted_local_paths("", &json_value)
        .map_err(|error| format!("opcode-profile report failed redaction sweep: {error}"))?;
    serde_json::to_string(&json_value)
        .map_err(|error| format!("opcode-profile report re-serialization failed: {error}"))
}

// --- Canonical fixtures (the committed opcode-profile fixtures) --------------

/// The canonical Siglus opcode profile: declares ONE covered opcode
/// (`text.show`) and ONE named-but-refused opcode (`grp.load`). Narrow by
/// design — this is a scaffold, not a broad opcode pack. The declared coverage
/// surface is fixed here, before any run.
pub fn canonical_opcode_profile() -> OpcodeProfile {
    OpcodeProfile {
        schema_version: OPCODE_PROFILE_SCHEMA_VERSION.to_string(),
        profile_id: "siglus-opcode-profile-text-show-v1".to_string(),
        capability_id: OPCODE_PROFILE_CAPABILITY_ID.to_string(),
        support_boundary: OPCODE_PROFILE_SUPPORT_BOUNDARY.to_string(),
        entries: vec![
            OpcodeProfileEntry {
                opcode: OpcodeId(OPC_TEXT_SHOW),
                mnemonic: "text.show".to_string(),
                support: OpcodeSupport::Covered,
            },
            OpcodeProfileEntry {
                opcode: OpcodeId(OPC_GRP_LOAD),
                mnemonic: "grp.load".to_string(),
                support: OpcodeSupport::DeclaredUnsupported {
                    reason: "graphics-surface dispatch is Research scope (siglus-opcode-dispatch)"
                        .to_string(),
                },
            },
        ],
        unknown_opcode_behavior: UnsupportedBehavior::SurfaceDiagnosticAndHalt,
    }
}

/// The **golden** fixture: a single covered `text.show` opcode carrying one
/// synthetic dialogue line. Produces the golden dispatch trace asserted in the
/// tests + `tests/opcode_profile_conformance.rs`.
pub fn fixture_text_show_program() -> OpcodeProgram {
    OpcodeProgram {
        ops: vec![FixtureOp {
            opcode: OpcodeId(OPC_TEXT_SHOW),
            text: Some(FIXTURE_TEXT_SHOW_PAYLOAD.to_string()),
        }],
    }
}

/// A diagnostic fixture: a single `grp.load` opcode the profile declares as
/// unsupported. Proves the declared-unsupported opcode surfaces a diagnostic
/// (not a silent success).
pub fn fixture_declared_unsupported_program() -> OpcodeProgram {
    OpcodeProgram {
        ops: vec![FixtureOp {
            opcode: OpcodeId(OPC_GRP_LOAD),
            text: None,
        }],
    }
}

/// A diagnostic fixture: a single opcode `0xEE` the profile does NOT declare at
/// all. Proves an unknown opcode surfaces a `NotInProfile` diagnostic (not a
/// silent success). `0xEE` is chosen because it is absent from
/// [`canonical_opcode_profile`].
pub fn fixture_unknown_opcode_program() -> OpcodeProgram {
    OpcodeProgram {
        ops: vec![FixtureOp {
            opcode: OpcodeId(0xEE),
            text: None,
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_declares_coverage_before_any_run() {
        // The manifest is fully declared without running anything: two entries
        // one Covered, one DeclaredUnsupported, plus a non-silent unknown policy.
        let profile = canonical_opcode_profile();
        assert_eq!(profile.entries.len(), 2, "narrow scaffold: exactly two");
        assert!(
            profile
                .entry(OpcodeId(OPC_TEXT_SHOW))
                .unwrap()
                .support
                .is_covered(),
            "text.show is covered"
        );
        assert!(
            matches!(
                profile.entry(OpcodeId(OPC_GRP_LOAD)).unwrap().support,
                OpcodeSupport::DeclaredUnsupported { .. }
            ),
            "grp.load is declared-unsupported"
        );
        // The manifest serializes as committable evidence.
        assert!(profile.stable_json().is_ok());
    }

    #[test]
    fn golden_text_show_produces_the_golden_trace() {
        let profile = canonical_opcode_profile();
        let result = run_opcode_conformance(&profile, &fixture_text_show_program());

        assert_eq!(result.source_node_id, "UTSUSHI-036");
        assert_eq!(result.evidence_tier, EvidenceTier::E1);
        assert!(!result.halted_on_unsupported, "covered run does not halt");
        assert!(
            result.unsupported_encountered.is_empty(),
            "covered run has no unsupported diagnostics"
        );
        // The golden trace: exactly one dispatched text.show emitting the
        // synthetic line.
        assert_eq!(result.trace.len(), 1);
        assert_eq!(
            result.trace[0].kind,
            DispatchKind::Dispatched {
                mnemonic: "text.show".to_string(),
                emitted_text: Some(FIXTURE_TEXT_SHOW_PAYLOAD.to_string()),
            }
        );
        // Declared coverage is echoed from the profile (both entries), not
        // rebuilt from the one-opcode program.
        assert_eq!(
            result.declared_coverage.len(),
            2,
            "declared coverage is the pre-run profile surface, not the program"
        );
    }

    #[test]
    fn golden_trace_is_deterministic() {
        let profile = canonical_opcode_profile();
        let first = run_opcode_conformance(&profile, &fixture_text_show_program())
            .stable_json()
            .expect("golden serializes");
        let second = run_opcode_conformance(&profile, &fixture_text_show_program())
            .stable_json()
            .expect("golden serializes");
        assert_eq!(first, second, "golden conformance JSON is deterministic");
    }

    #[test]
    fn declared_unsupported_opcode_cannot_pass_silently() {
        let profile = canonical_opcode_profile();
        let result = run_opcode_conformance(&profile, &fixture_declared_unsupported_program());

        // NOT a silent success: the diagnostic is present and the run halted.
        assert!(result.halted_on_unsupported, "unsupported opcode halts");
        assert_eq!(result.unsupported_encountered.len(), 1);
        assert!(matches!(
            result.unsupported_encountered[0],
            UnsupportedOpcodeDiagnostic::DeclaredUnsupported { .. }
        ));
        // The trace records the refusal explicitly — the opcode is NOT absent.
        assert_eq!(
            result.trace[0].kind,
            DispatchKind::DeclaredUnsupported {
                mnemonic: "grp.load".to_string(),
            }
        );
    }

    #[test]
    fn unknown_opcode_cannot_pass_silently() {
        let profile = canonical_opcode_profile();
        let result = run_opcode_conformance(&profile, &fixture_unknown_opcode_program());

        // An opcode the profile never declared must surface a diagnostic, not a
        // silent success.
        assert!(result.halted_on_unsupported);
        assert_eq!(result.unsupported_encountered.len(), 1);
        match &result.unsupported_encountered[0] {
            UnsupportedOpcodeDiagnostic::NotInProfile { opcode, .. } => {
                assert_eq!(*opcode, OpcodeId(0xEE));
            }
            other @ UnsupportedOpcodeDiagnostic::DeclaredUnsupported { .. } => {
                panic!("expected NotInProfile diagnostic, got {other:?}")
            }
        }
        assert_eq!(result.trace[0].kind, DispatchKind::NotInProfile);
        // The undeclared opcode is NOT added to the declared coverage surface.
        assert!(
            !result
                .declared_coverage
                .iter()
                .any(|declared| declared.opcode == OpcodeId(0xEE)),
            "an undeclared opcode must never join the declared coverage surface"
        );
    }
}
