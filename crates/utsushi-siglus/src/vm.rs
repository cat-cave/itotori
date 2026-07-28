//! First Siglus **runtime-VM** integration smoke.
//!
//! This module is the first Siglus VM *adapter skeleton*. It runs a **synthetic**
//! Siglus-shaped text-trace program through a tiny in-process interpreter and
//! emits **text** + **VM-state** evidence through the Utsushi runtime-evidence
//! contracts at the **E1** admission tier. It is deliberately *not* a Siglus VM:
//! the opcode set, container framing, and key scramble are authored synthetic
//! stand-ins. See `docs/utsushi-siglus-vm-provenance.md` for the clean-room
//! boundary this file was written under (recorded BEFORE this code).
//!
//! # What the smoke proves (honest scope)
//!
//! Given a synthetic Siglus-shaped text-trace program — optionally scrambled
//! with a **local** key referenced only by a [`SecretRef`] — the VM:
//!
//! 1. resolves the key **in-process** (never shelling out, never serializing raw
//!    key bytes); a posture that would need an external helper or an unavailable
//!    key is **rejected before the VM runs**
//! 2. descrambles + decodes the synthetic bytecode into a typed op stream
//! 3. executes it, emitting each dialogue line through a substrate
//!    [`TextSurfaceSink`] as an E1 [`TextLine`]
//! 4. exposes its flag/variable/PC state through the substrate
//!    [`Inspectable`] contract, captured as a [`Snapshot`] (the VM-state
//!    evidence)
//! 5. assembles a [`VmTraceEvidence`] runtime-evidence claim that references key
//!    material **only** through a secret-ref + one-way [`ProofHash`] commitment.
//!
//! # What it does NOT prove
//!
//! Real `Scene.pck` decode, the real Siglus opcode table, LZSS decompression
//! `Gameexe.dat` namespace resolution, or a rendered Siglus frame. Those are the
//! Research follow-ups enumerated in [`crate::vm_impl_map`].
//!
//! # Key discipline (mirrors )
//!
//! Raw key bytes live only inside the module-private, zeroize-on-drop
//! `Debug`-redacting [`VmKeyMaterial`] holder and never cross a serialization
//! boundary. The committed evidence carries a [`RuntimeKeyReference`]
//! (secret-ref + one-way commitment + byte length) — never the key.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use utsushi_core::substrate::{
    EvidenceTier, Inspectable, SinkCapability, SinkResult, SinkSet, Snapshot, SnapshotError,
    SnapshotRequest, StatePath, StateTree, StateValue, TextLine, TextSurfaceSink,
    reject_unredacted_local_paths, take_snapshot,
};

// The secret-ref / one-way-commitment / key-reference discipline is itotori's
// own code, reused here (NOT an external reference). See the
// provenance doc §2.
use crate::runtime_profile::{ProofHash, RuntimeKeyReference, SecretRef};

/// Schema version of the VM text-trace smoke fixture + evidence pair.
pub const VM_TRACE_SMOKE_SCHEMA_VERSION: &str = "0.1.0";

/// Stable capability id every VM text-trace evidence claim carries.
pub const VM_TRACE_SMOKE_CAPABILITY_ID: &str = "utsushi-siglus-vm-text-trace-smoke";

/// Stable inspectable id for the VM's snapshot surface. Distinct from the
/// engine-port scaffold id so two snapshots cannot be accidentally diffed.
pub const VM_INSPECTABLE_ID: &str = "utsushi-siglus-vm";

/// The blunt support boundary surfaced in every VM evidence claim. Explicit that
/// this is a synthetic text-trace smoke, not a Siglus VM.
pub const VM_TRACE_SMOKE_SUPPORT_BOUNDARY: &str = "Utsushi Siglus VM text-trace smoke runs a SYNTHETIC Siglus-shaped bytecode program (authored opcode set, NOT the real Siglus opcode table) through an in-process interpreter and emits text + VM-state evidence through the Utsushi runtime-evidence contracts at the E1 admission tier. It proves the VM consumed a locally-resolvable key WITHOUT serializing raw key material and emitted a deterministic text trace + inspectable VM state; it does NOT prove real Scene.pck decode, the real Siglus opcode table, LZSS decompression, Gameexe.dat namespace resolution, or a rendered Siglus frame. Key material is referenced only through a local secret-ref + one-way proof hash; raw key bytes are never logged, serialized, or written.";

/// Deterministic RFC3339 instant stamped on the VM-state snapshot. The substrate
/// never calls `SystemTime::now()`; the smoke supplies a fixed instant so the
/// evidence is reproducible.
const VM_SNAPSHOT_GENERATED_AT: &str = "2026-01-01T00:00:00Z";

// --- Synthetic bytecode container (NO retail bytes) -------------------------
//
//   <12B magic><u8 keyed-flag><u32 opCount>
//   opCount * { <u8 opcode><op-specific length-prefixed fields> }

const VM_PROGRAM_MAGIC: &[u8; 12] = b"USIG-VM-TR01";

const OP_EMIT_TEXT: u8 = 0x01;
const OP_SET_FLAG: u8 = 0x02;
const OP_SET_INT: u8 = 0x03;
const OP_HALT: u8 = 0x04;

/// Clearly-synthetic, authored local key. XOR-descrambling with it is the smoke's
/// stand-in for "the VM consumed a locally-resolvable key". This is the one place
/// raw "key" bytes exist; they never leave [`VmKeyMaterial`]. Non-zero on purpose
/// so the no-raw-key-serialized assertion is meaningful (a zero key would leave
/// the scramble an identity and make the assertion vacuous).
const SYNTHETIC_LOCAL_KEY: [u8; 16] = [
    0x5f, 0x1c, 0xa3, 0x77, 0x0b, 0xe4, 0x29, 0x96, 0xd0, 0x4a, 0x81, 0x3e, 0x62, 0xb5, 0x17, 0xcc,
];

mod fixtures;
mod model;
mod run;

pub use fixtures::*;
pub use model::*;
pub use run::*;

// --- The VM -----------------------------------------------------------------

/// The synthetic Siglus text-trace VM. Holds a decoded op stream and, after
/// [`SiglusTraceVm::run`], the resulting flag/variable banks + program counter.
/// Implements [`Inspectable`] so its state can be captured as a substrate
/// [`Snapshot`] (the VM-state evidence).
#[derive(Debug)]
pub struct SiglusTraceVm {
    ops: Vec<SiglusTraceOp>,
    program_digest: ProofHash,
    flags: BTreeMap<String, bool>,
    ints: BTreeMap<String, i64>,
    program_counter: u32,
    halted: bool,
    emitted_lines: u32,
}

impl SiglusTraceVm {
    /// Decode `program_bytes` (already descrambled) into a runnable VM.
    /// `program_digest` commits to the on-wire (scrambled) container bytes.
    fn load(
        profile_id: &str,
        program_bytes: &[u8],
        program_digest: ProofHash,
    ) -> Result<Self, VmError> {
        let ops = decode_program(profile_id, program_bytes)?;
        Ok(Self {
            ops,
            program_digest,
            flags: BTreeMap::new(),
            ints: BTreeMap::new(),
            program_counter: 0,
            halted: false,
            emitted_lines: 0,
        })
    }

    /// Execute the op stream, emitting each dialogue line into `text_sink` as an
    /// E1 [`TextLine`]. Stops at `Halt` (or end of program).
    fn run(&mut self, text_sink: &dyn TextSurfaceSink) -> Result<(), VmError> {
        for op in &self.ops {
            self.program_counter += 1;
            match op {
                SiglusTraceOp::EmitText { speaker, text } => {
                    let line = TextLine {
                        line_id: format!("{VM_INSPECTABLE_ID}/line/{}", self.emitted_lines),
                        evidence_tier: EvidenceTier::E1,
                        text: text.clone(),
                        speaker: speaker.clone(),
                        color: None,
                        text_surface: Some("adv".to_string()),
                        bridge_ref: None,
                        source_asset: None,
                        byte_offset_in_scene: None,
                        body_shift_jis: None,
                    };
                    text_sink
                        .emit_line(line)
                        .map_err(|error| VmError::StateContractViolation {
                            profile_id: VM_INSPECTABLE_ID.to_string(),
                            detail: format!("text sink rejected emission: {error}"),
                        })?;
                    self.emitted_lines += 1;
                }
                SiglusTraceOp::SetFlag { name, value } => {
                    self.flags.insert(name.clone(), *value);
                }
                SiglusTraceOp::SetInt { name, value } => {
                    self.ints.insert(name.clone(), *value);
                }
                SiglusTraceOp::Halt => {
                    self.halted = true;
                    break;
                }
            }
        }
        Ok(())
    }
}

impl Inspectable for SiglusTraceVm {
    fn inspectable_id(&self) -> &'static str {
        VM_INSPECTABLE_ID
    }

    fn inspect_state(&self) -> Result<StateTree, SnapshotError> {
        let mut tree = StateTree::new();
        tree.insert(
            StatePath::parse("port.halted")?,
            StateValue::Bool { value: self.halted },
        )?;
        tree.insert(
            StatePath::parse("port.program-counter")?,
            StateValue::Uint {
                value: u64::from(self.program_counter),
            },
        )?;
        tree.insert(
            StatePath::parse("port.emitted-line-count")?,
            StateValue::Uint {
                value: u64::from(self.emitted_lines),
            },
        )?;
        tree.insert(
            StatePath::parse("port.program-digest")?,
            StateValue::String {
                value: self.program_digest.as_str().to_string(),
            },
        )?;
        for (name, value) in &self.flags {
            tree.insert(
                StatePath::parse(&format!("port.flag.{name}"))?,
                StateValue::Bool { value: *value },
            )?;
        }
        for (name, value) in &self.ints {
            tree.insert(
                StatePath::parse(&format!("port.int.{name}"))?,
                StateValue::Int { value: *value },
            )?;
        }
        Ok(tree)
    }
}

// --- The runtime-evidence claim (E1) ----------------------------------------

/// The VM text-trace runtime-evidence claim. Emitted **after** the VM runs. It
/// carries the emitted text lines (the text evidence), the captured VM-state
/// snapshot (the VM-state evidence), and — only for a keyed posture — a
/// [`RuntimeKeyReference`] (secret-ref + one-way commitment + byte length, never
/// the key). E1: deterministic, non-visual.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VmTraceEvidence {
    /// Report schema version.
    pub schema_version: String,
    /// Capability id.
    pub capability_id: String,
    /// Provenance node id stamped into generated reports.
    pub source_node_id: String,
    /// The profile id.
    pub profile_id: String,
    /// The key posture that was admitted (`no-key` / `local-key`).
    pub key_class: String,
    /// The blunt support boundary.
    pub support_boundary: String,
    /// One-way commitment to the on-wire (scrambled) synthetic program bytes.
    pub program_digest: ProofHash,
    /// The text lines the VM emitted through the substrate text sink.
    pub text_lines: Vec<TextLine>,
    /// The captured VM-state snapshot (flag/variable banks + PC), serialized
    /// through the substrate snapshot contract.
    pub vm_state: serde_json::Value,
    /// The key reference, present only for a keyed posture. Carries the
    /// secret-ref + one-way key commitment + byte length — never the key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_reference: Option<RuntimeKeyReference>,
    /// The evidence tier this claim is capped at.
    pub evidence_tier: EvidenceTier,
}

impl VmTraceEvidence {
    /// Provenance node id stamped on every VM trace claim.
    pub const SOURCE_NODE_ID: &'static str = "synthetic-fixture";

    /// Serialize to stable, redaction-swept JSON (secret-refs only, no key
    /// bytes, no local paths). This is the committable evidence.
    pub fn stable_json(&self) -> Result<String, String> {
        let json_value = serde_json::to_value(self)
            .map_err(|error| format!("VM trace evidence serialization failed: {error}"))?;
        reject_unredacted_local_paths("", &json_value)
            .map_err(|error| format!("VM trace evidence failed redaction sweep: {error}"))?;
        serde_json::to_string(&json_value)
            .map_err(|error| format!("VM trace evidence re-serialization failed: {error}"))
    }
}

// --- The smoke driver -------------------------------------------------------

/// A text-surface sink that collects emitted lines (E1 ceiling). The VM emits
/// through this substrate contract; the driver drains it into the evidence.
struct CollectingTextSink {
    lines: Mutex<Vec<TextLine>>,
}

impl CollectingTextSink {
    fn new() -> Self {
        Self {
            lines: Mutex::new(Vec::new()),
        }
    }
}

impl TextSurfaceSink for CollectingTextSink {
    fn capability(&self) -> SinkCapability {
        SinkCapability::Supported {
            evidence_tier_ceiling: EvidenceTier::E1,
        }
    }

    fn emit_line(&self, line: TextLine) -> SinkResult<()> {
        line.validate()?;
        self.lines
            .lock()
            .expect("text sink mutex not poisoned")
            .push(line);
        Ok(())
    }

    fn drain_lines(&self) -> Vec<TextLine> {
        let mut guard = self.lines.lock().expect("text sink mutex not poisoned");
        std::mem::take(&mut *guard)
    }
}

// --- Canonical fixtures (the committed VM smoke fixtures) --------------------

/// A local secret-ref used by the keyed fixture. `expect` is safe: the literal is
/// a valid dotted local-secret name.
fn fixture_secret_ref(name: &str) -> SecretRef {
    SecretRef::new(format!("local-secret:{name}")).expect("fixture secret-ref literal is valid")
}

// --- Byte reader ------------------------------------------------------------

struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .position
            .checked_add(count)
            .ok_or_else(|| format!("length overflow at byte {}", self.position))?;
        let slice = self
            .bytes
            .get(self.position..end)
            .ok_or_else(|| format!("truncated at byte {} (needed {count} more)", self.position))?;
        self.position = end;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, String> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn i64(&mut self) -> Result<i64, String> {
        let bytes = self.take(8)?;
        Ok(i64::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ]))
    }

    fn string(&mut self) -> Result<String, String> {
        let len = self.u32()? as usize;
        let raw = self.take(len)?;
        String::from_utf8(raw.to_vec()).map_err(|error| format!("invalid utf-8 string: {error}"))
    }

    fn opt_string(&mut self) -> Result<Option<String>, String> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(self.string()?)),
            other => Err(format!("invalid optional-string tag {other}")),
        }
    }
}

#[cfg(test)]
mod tests;
