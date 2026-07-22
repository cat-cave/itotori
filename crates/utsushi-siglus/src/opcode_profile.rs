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
    /// Provenance node id stamped into generated reports.
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
    /// Provenance node id stamped on every opcode-profile conformance result.
    pub const SOURCE_NODE_ID: &'static str = "UTSUSHI-036";

    /// Serialize to stable, redaction-swept JSON. This is the committable
    /// conformance-result evidence.
    pub fn stable_json(&self) -> Result<String, String> {
        stable_redacted_json(self)
    }
}

#[path = "opcode_profile/runner.rs"]
mod runner;

pub use runner::run_opcode_conformance;

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
#[path = "opcode_profile/tests.rs"]
mod tests;
