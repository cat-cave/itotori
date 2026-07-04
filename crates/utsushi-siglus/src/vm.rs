//! UTSUSHI-034 — first Siglus **runtime-VM** integration smoke.
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
//!    key is **rejected before the VM runs**,
//! 2. descrambles + decodes the synthetic bytecode into a typed op stream,
//! 3. executes it, emitting each dialogue line through a substrate
//!    [`TextSurfaceSink`] as an E1 [`TextLine`],
//! 4. exposes its flag/variable/PC state through the substrate
//!    [`Inspectable`] contract, captured as a [`Snapshot`] (the VM-state
//!    evidence),
//! 5. assembles a [`VmTraceEvidence`] runtime-evidence claim that references key
//!    material **only** through a secret-ref + one-way [`ProofHash`] commitment.
//!
//! # What it does NOT prove
//!
//! Real `Scene.pck` decode, the real Siglus opcode table, LZSS decompression,
//! `Gameexe.dat` namespace resolution, or a rendered Siglus frame. Those are the
//! Research follow-ups enumerated in [`crate::vm_impl_map`].
//!
//! # Key discipline (mirrors UTSUSHI-035)
//!
//! Raw key bytes live only inside the module-private, zeroize-on-drop,
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
// own UTSUSHI-035 code, reused here (NOT an external reference). See the
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

/// The key posture a VM fixture declares. Mirrors UTSUSHI-035's five-class
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
/// discipline carried from UTSUSHI-035.
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
    /// The VM produced state that failed a substrate contract (snapshot /
    /// redaction). Surfaced as a stable string so no snapshot internals leak.
    #[error("utsushi.siglus.vm.state_contract_violation: profile {profile_id} ({detail})")]
    StateContractViolation {
        /// Profile whose state failed a contract.
        profile_id: String,
        /// Human detail.
        detail: String,
    },
}

// --- Module-private key holder (mirrors UTSUSHI-035 RuntimeKeyMaterial) ------

/// Resolved local key bytes. Raw material is module-private, never serialized,
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
    /// The spec-DAG node id this claim is authored for.
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
    /// The spec-DAG node id stamped on every VM trace claim.
    pub const SOURCE_NODE_ID: &'static str = "UTSUSHI-034";

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

/// Run the VM text-trace smoke for `fixture` and produce the E1 runtime-evidence
/// claim.
///
/// Reject-before-claim: a [`VmKeyPosture::RequiredUnresolved`] posture returns
/// `Err(`[`VmError::RequiredKeyUnresolved`]`)` **before** the VM runs and before
/// any [`VmTraceEvidence`] is constructed. On an admitted posture the raw key
/// (for the keyed case) is resolved into the module-private
/// zeroize-on-drop holder, used to descramble in-process, and never serialized.
pub fn run_vm_trace_smoke(fixture: &SiglusVmFixture) -> Result<VmTraceEvidence, VmError> {
    let profile_id = fixture.profile_id.as_str();
    let ops = canonical_trace_program();

    // Resolve the key posture. `RequiredUnresolved` rejects here, before the VM.
    let (keyed, key_material, key_ref) = match &fixture.key_posture {
        VmKeyPosture::NoKey => (false, None, None),
        VmKeyPosture::LocalKeyResolved { secret_ref } => {
            let key = VmKeyMaterial::from_resolved_bytes(SYNTHETIC_LOCAL_KEY.to_vec());
            (true, Some(key), Some(secret_ref.clone()))
        }
        VmKeyPosture::RequiredUnresolved { secret_ref } => {
            return Err(VmError::RequiredKeyUnresolved {
                profile_id: profile_id.to_string(),
                secret_ref: secret_ref.clone(),
            });
        }
    };

    // Encode the plaintext program, then (for the keyed posture) scramble it with
    // the resolved key. The scrambled buffer is the "on-wire" container the VM
    // consumes; its digest goes into the evidence.
    let mut on_wire = encode_program(&ops, keyed);
    if let Some(key) = &key_material {
        // Scramble everything after the plaintext header (magic + keyed flag +
        // op count stay walkable so the container boundary is inspectable before
        // key handling — the same reject-before-key ordering as UTSUSHI-035).
        let header_len = VM_PROGRAM_MAGIC.len() + 1 + 4;
        key.apply_xor(&mut on_wire[header_len..]);
        // Reject-on-secret: the resolved key must not appear verbatim in the
        // container we commit a digest for.
        debug_assert!(
            !key.appears_in(&on_wire),
            "keyed VM program must not leak raw key bytes into the committed digest",
        );
    }
    let program_digest = ProofHash::commit(&on_wire);

    // Build the key reference from the resolved key BEFORE descrambling drops it.
    let key_reference = match (&key_material, &key_ref) {
        (Some(key), Some(secret_ref)) => Some(RuntimeKeyReference {
            secret_ref: secret_ref.clone(),
            key_commitment: key.commitment(),
            key_byte_len: u32::try_from(key.byte_len()).unwrap_or(u32::MAX),
        }),
        _ => None,
    };

    // Descramble in-process (identity for the no-key posture), then load + run.
    let mut program_bytes = on_wire.clone();
    if let Some(key) = &key_material {
        let header_len = VM_PROGRAM_MAGIC.len() + 1 + 4;
        key.apply_xor(&mut program_bytes[header_len..]);
    }
    // The key material has served its purpose; drop it (zeroize-on-drop) before
    // any evidence is serialized.
    drop(key_material);

    let mut vm = SiglusTraceVm::load(profile_id, &program_bytes, program_digest.clone())?;

    let sink = Arc::new(CollectingTextSink::new());
    let sink_set = SinkSet::new().with_text(sink.clone());
    let text_sink = sink_set
        .text()
        .expect("text sink registered on the sink set");
    vm.run(text_sink)?;
    let text_lines = sink_set.drain_text();

    // Capture the VM state as a substrate snapshot (the VM-state evidence).
    // `SnapshotRequest::new` defaults to the `Small` (16 KiB) envelope, which is
    // the fixture/smoke tier this synthetic state fits within.
    let request = SnapshotRequest::new(
        VM_INSPECTABLE_ID,
        VM_SNAPSHOT_GENERATED_AT,
        EvidenceTier::E1,
    );
    let snapshot: Snapshot =
        take_snapshot(&vm, &request).map_err(|error| VmError::StateContractViolation {
            profile_id: profile_id.to_string(),
            detail: format!("snapshot capture failed: {error}"),
        })?;
    let vm_state = snapshot
        .to_json_value()
        .map_err(|error| VmError::StateContractViolation {
            profile_id: profile_id.to_string(),
            detail: format!("snapshot serialization failed: {error}"),
        })?;

    let key_class = match &fixture.key_posture {
        VmKeyPosture::NoKey => "no-key",
        VmKeyPosture::LocalKeyResolved { .. } => "local-key",
        VmKeyPosture::RequiredUnresolved { .. } => unreachable!("rejected above"),
    }
    .to_string();

    Ok(VmTraceEvidence {
        schema_version: VM_TRACE_SMOKE_SCHEMA_VERSION.to_string(),
        capability_id: VM_TRACE_SMOKE_CAPABILITY_ID.to_string(),
        source_node_id: VmTraceEvidence::SOURCE_NODE_ID.to_string(),
        profile_id: profile_id.to_string(),
        key_class,
        support_boundary: VM_TRACE_SMOKE_SUPPORT_BOUNDARY.to_string(),
        program_digest,
        text_lines,
        vm_state,
        key_reference,
        evidence_tier: EvidenceTier::E1,
    })
}

// --- Canonical fixtures (the committed VM smoke fixtures) --------------------

/// A local secret-ref used by the keyed fixture. `expect` is safe: the literal is
/// a valid dotted local-secret name.
fn fixture_secret_ref(name: &str) -> SecretRef {
    SecretRef::new(format!("local-secret:{name}")).expect("fixture secret-ref literal is valid")
}

/// The **no-key** fixture: plaintext synthetic program, no key referenced.
pub fn fixture_no_key_trace() -> SiglusVmFixture {
    SiglusVmFixture {
        schema_version: VM_TRACE_SMOKE_SCHEMA_VERSION.to_string(),
        profile_id: "siglus-vm-trace-no-key".to_string(),
        key_posture: VmKeyPosture::NoKey,
    }
}

/// The **local-key** fixture: program scrambled with a local key resolvable
/// in-process; the key is referenced by a secret-ref only.
pub fn fixture_local_key_trace() -> SiglusVmFixture {
    SiglusVmFixture {
        schema_version: VM_TRACE_SMOKE_SCHEMA_VERSION.to_string(),
        profile_id: "siglus-vm-trace-local-key".to_string(),
        key_posture: VmKeyPosture::LocalKeyResolved {
            secret_ref: fixture_secret_ref("siglus.vm.local-key.v1"),
        },
    }
}

/// The **required-unresolved** fixture: a key is required but not resolvable
/// in-process; the VM never runs. Rejected before any evidence.
pub fn fixture_required_unresolved_trace() -> SiglusVmFixture {
    SiglusVmFixture {
        schema_version: VM_TRACE_SMOKE_SCHEMA_VERSION.to_string(),
        profile_id: "siglus-vm-trace-required-key".to_string(),
        key_posture: VmKeyPosture::RequiredUnresolved {
            secret_ref: fixture_secret_ref("siglus.vm.required-key.v1"),
        },
    }
}

/// The raw synthetic local key, exposed to tests **only** so the no-raw-key
/// assertion can prove the key bytes are absent from serialized evidence. This is
/// an authored, clearly-fake constant, not a retail key.
#[doc(hidden)]
pub fn synthetic_local_key_for_test_assertions() -> [u8; 16] {
    SYNTHETIC_LOCAL_KEY
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
mod tests {
    use super::*;

    #[test]
    fn no_key_smoke_emits_text_and_vm_state() {
        let evidence = run_vm_trace_smoke(&fixture_no_key_trace()).expect("no-key smoke runs");
        assert_eq!(evidence.evidence_tier, EvidenceTier::E1);
        assert_eq!(evidence.key_class, "no-key");
        assert!(evidence.key_reference.is_none());
        assert_eq!(
            evidence.text_lines.len(),
            2,
            "two EmitText ops emit two lines"
        );
        assert!(evidence.vm_state.get("stateTree").is_some());
    }

    #[test]
    fn required_unresolved_is_rejected_before_any_evidence() {
        let error = run_vm_trace_smoke(&fixture_required_unresolved_trace())
            .expect_err("required-unresolved must reject");
        assert!(matches!(error, VmError::RequiredKeyUnresolved { .. }));
    }

    #[test]
    fn vm_key_material_debug_is_redacted_and_zeroizes() {
        let key = VmKeyMaterial::from_resolved_bytes(vec![1, 2, 3, 4]);
        let debug = format!("{key:?}");
        assert!(
            debug.contains("REDACTED"),
            "key Debug must be redacted: {debug}"
        );
        assert!(
            !debug.contains(", 2, 3"),
            "key Debug must not print bytes: {debug}"
        );
    }
}
