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

/// A synthetic Siglus-shaped VM instruction. This is an **authored** opcode set
/// for the smoke — it is NOT the real Siglus opcode table. The real dispatch is a
/// Research follow-up (`siglus-opcode-dispatch`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SiglusTraceOp {
    /// Emit a dialogue line: optional speaker + text.
    EmitText {
        /// Optional speaker label (engine-observed, never a host identifier).
        speaker: Option<String>,
        /// The dialogue text.
        text: String,
    },
    /// Set a boolean flag in the VM's flag bank.
    SetFlag {
        /// Flag name. Must be a valid state-path segment (`[a-z0-9][a-z0-9_-]*`).
        name: String,
        /// Flag value.
        value: bool,
    },
    /// Set a signed integer variable in the VM's variable bank.
    SetInt {
        /// Variable name. Must be a valid state-path segment.
        name: String,
        /// Variable value.
        value: i64,
    },
    /// Halt execution.
    Halt,
}

/// The key posture a VM fixture declares. Mirrors the five-class
/// discipline in miniature: `NoKey` / `LocalKeyResolved` are admitted (the VM
/// runs); `RequiredUnresolved` is rejected before the VM runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "kind")]
pub enum VmKeyPosture {
    /// No key: the synthetic program is plaintext-in-profile. Admitted.
    NoKey,
    /// The program is scrambled with a local key that resolves in-process. The
    /// key is referenced by a [`SecretRef`]; the raw bytes never leave the
    /// module-private holder. Admitted.
    LocalKeyResolved {
        /// The local secret-ref the key is published under.
        secret_ref: SecretRef,
    },
    /// A key is required but no in-process material is available and no helper is
    /// declared. Rejected before the VM runs.
    RequiredUnresolved {
        /// The local secret-ref that could not be resolved.
        secret_ref: SecretRef,
    },
}

/// A VM text-trace smoke fixture. The synthetic program is authored in-process
/// (from module constants); only the key posture varies across fixtures.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiglusVmFixture {
    /// Schema version.
    pub schema_version: String,
    /// Stable per-fixture profile id.
    pub profile_id: String,
    /// The key posture driving key handling + admission.
    pub key_posture: VmKeyPosture,
}

/// Typed VM smoke error. A rejected key posture or a decode failure short-circuits
/// **before** any [`VmTraceEvidence`] is constructed — the reject-before-claim
/// discipline carried from.
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "code")]
pub enum VmError {
    /// The declared key is required but not resolvable in-process; the VM never
    /// runs. Carries the unresolved secret-ref (never key bytes).
    #[error(
        "utsushi.siglus.vm.required_key_unresolved: profile {profile_id} requires a key \
         ({secret_ref}) that is not resolvable in-process; no VM evidence emitted"
    )]
    RequiredKeyUnresolved {
        /// Profile whose key posture was rejected.
        profile_id: String,
        /// The unresolved secret-ref (never the key bytes).
        secret_ref: SecretRef,
    },
    /// The synthetic bytecode was malformed (bad magic / truncated / bad opcode).
    /// Kept distinct so a fixture-authoring bug is never mistaken for a rejected
    /// key posture.
    #[error(
        "utsushi.siglus.vm.malformed_program: profile {profile_id} program malformed ({detail})"
    )]
    MalformedProgram {
        /// Profile whose program was malformed.
        profile_id: String,
        /// Human detail.
        detail: String,
    },
    /// The VM produced state that failed a substrate contract (snapshot
    /// redaction). Surfaced as a stable string so no snapshot internals leak.
    #[error("utsushi.siglus.vm.state_contract_violation: profile {profile_id} ({detail})")]
    StateContractViolation {
        /// Profile whose state failed a contract.
        profile_id: String,
        /// Human detail.
        detail: String,
    },
}

// --- Module-private key holder (mirrors RuntimeKeyMaterial) ------

/// Resolved local key bytes. Raw material is module-private, never serialized
/// redacted in `Debug`, and zeroized on drop. The only outward surfaces are a
/// byte length and a one-way [`ProofHash`] commitment.
struct VmKeyMaterial {
    bytes: Vec<u8>,
}

impl VmKeyMaterial {
    fn from_resolved_bytes(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    fn byte_len(&self) -> usize {
        self.bytes.len()
    }

    fn commitment(&self) -> ProofHash {
        ProofHash::commit(&self.bytes)
    }

    /// Reject-on-secret probe: does the raw key appear as a contiguous window
    /// inside `haystack`? Returns only a boolean — never the bytes.
    fn appears_in(&self, haystack: &[u8]) -> bool {
        if self.bytes.is_empty() || self.bytes.len() > haystack.len() {
            return false;
        }
        haystack
            .windows(self.bytes.len())
            .any(|window| window == self.bytes)
    }

    /// XOR the key over `bytes` in place (scramble == descramble). The key never
    /// leaves the holder; only the transformed buffer is returned to the caller.
    fn apply_xor(&self, bytes: &mut [u8]) {
        if self.bytes.is_empty() {
            return;
        }
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte ^= self.bytes[index % self.bytes.len()];
        }
    }
}

impl Drop for VmKeyMaterial {
    fn drop(&mut self) {
        self.bytes.fill(0);
    }
}

impl std::fmt::Debug for VmKeyMaterial {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("VmKeyMaterial")
            .field("bytes", &"[REDACTED:utsushi.secret_redacted]")
            .field("byte_len", &self.bytes.len())
            .finish()
    }
}

// --- The synthetic program the smoke runs -----------------------------------

/// The canonical synthetic text-trace program. Clearly-fake dialogue authored
/// here; no retail text. Exercises every opcode: two dialogue emissions (one
/// speaker-less narration, one speaker line), a flag set, and an int set.
fn canonical_trace_program() -> Vec<SiglusTraceOp> {
    vec![
        SiglusTraceOp::SetFlag {
            name: "intro-seen".to_string(),
            value: true,
        },
        SiglusTraceOp::EmitText {
            speaker: None,
            text: "[synthetic-siglus-vm-narration-0]".to_string(),
        },
        SiglusTraceOp::SetInt {
            name: "affection".to_string(),
            value: 3,
        },
        SiglusTraceOp::EmitText {
            speaker: Some("[synthetic-speaker-a]".to_string()),
            text: "[synthetic-siglus-vm-line-1]".to_string(),
        },
        SiglusTraceOp::Halt,
    ]
}

/// Encode an op stream into the synthetic bytecode container.
fn encode_program(ops: &[SiglusTraceOp], keyed: bool) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(VM_PROGRAM_MAGIC);
    bytes.push(u8::from(keyed));
    push_u32(&mut bytes, u32::try_from(ops.len()).unwrap_or(u32::MAX));
    for op in ops {
        encode_op(&mut bytes, op);
    }
    bytes
}

fn encode_op(bytes: &mut Vec<u8>, op: &SiglusTraceOp) {
    match op {
        SiglusTraceOp::EmitText { speaker, text } => {
            bytes.push(OP_EMIT_TEXT);
            push_opt_string(bytes, speaker.as_deref());
            push_string(bytes, text);
        }
        SiglusTraceOp::SetFlag { name, value } => {
            bytes.push(OP_SET_FLAG);
            push_string(bytes, name);
            bytes.push(u8::from(*value));
        }
        SiglusTraceOp::SetInt { name, value } => {
            bytes.push(OP_SET_INT);
            push_string(bytes, name);
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        SiglusTraceOp::Halt => bytes.push(OP_HALT),
    }
}

fn push_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn push_string(bytes: &mut Vec<u8>, value: &str) {
    push_u32(bytes, u32::try_from(value.len()).unwrap_or(u32::MAX));
    bytes.extend_from_slice(value.as_bytes());
}

fn push_opt_string(bytes: &mut Vec<u8>, value: Option<&str>) {
    match value {
        Some(value) => {
            bytes.push(1);
            push_string(bytes, value);
        }
        None => bytes.push(0),
    }
}

/// Decode the synthetic bytecode container back into an op stream.
fn decode_program(profile_id: &str, bytes: &[u8]) -> Result<Vec<SiglusTraceOp>, VmError> {
    let malformed = |detail: String| VmError::MalformedProgram {
        profile_id: profile_id.to_string(),
        detail,
    };
    let mut reader = Reader::new(bytes);
    let magic = reader.take(VM_PROGRAM_MAGIC.len()).map_err(&malformed)?;
    if magic != VM_PROGRAM_MAGIC {
        return Err(malformed("program magic mismatch".to_string()));
    }
    // Keyed flag is informational for the decoder (the caller has already
    // descrambled); we read it to keep the cursor aligned.
    reader.u8().map_err(&malformed)?;
    let op_count = reader.u32().map_err(&malformed)?;
    let mut ops = Vec::with_capacity(op_count as usize);
    for _ in 0..op_count {
        ops.push(decode_op(&mut reader, &malformed)?);
    }
    Ok(ops)
}

fn decode_op(
    reader: &mut Reader<'_>,
    malformed: &dyn Fn(String) -> VmError,
) -> Result<SiglusTraceOp, VmError> {
    let opcode = reader.u8().map_err(malformed)?;
    match opcode {
        OP_EMIT_TEXT => {
            let speaker = reader.opt_string().map_err(malformed)?;
            let text = reader.string().map_err(malformed)?;
            Ok(SiglusTraceOp::EmitText { speaker, text })
        }
        OP_SET_FLAG => {
            let name = reader.string().map_err(malformed)?;
            let value = reader.u8().map_err(malformed)? != 0;
            Ok(SiglusTraceOp::SetFlag { name, value })
        }
        OP_SET_INT => {
            let name = reader.string().map_err(malformed)?;
            let value = reader.i64().map_err(malformed)?;
            Ok(SiglusTraceOp::SetInt { name, value })
        }
        OP_HALT => Ok(SiglusTraceOp::Halt),
        other => Err(malformed(format!("unknown opcode {other:#04x}"))),
    }
}

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


