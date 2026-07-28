use super::*;

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
pub(super) struct VmKeyMaterial {
    bytes: Vec<u8>,
}

impl VmKeyMaterial {
    pub(super) fn from_resolved_bytes(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    pub(super) fn byte_len(&self) -> usize {
        self.bytes.len()
    }

    pub(super) fn commitment(&self) -> ProofHash {
        ProofHash::commit(&self.bytes)
    }

    /// Reject-on-secret probe: does the raw key appear as a contiguous window
    /// inside `haystack`? Returns only a boolean — never the bytes.
    pub(super) fn appears_in(&self, haystack: &[u8]) -> bool {
        if self.bytes.is_empty() || self.bytes.len() > haystack.len() {
            return false;
        }
        haystack
            .windows(self.bytes.len())
            .any(|window| window == self.bytes)
    }

    /// XOR the key over `bytes` in place (scramble == descramble). The key never
    /// leaves the holder; only the transformed buffer is returned to the caller.
    pub(super) fn apply_xor(&self, bytes: &mut [u8]) {
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
pub(super) fn canonical_trace_program() -> Vec<SiglusTraceOp> {
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
pub(super) fn encode_program(ops: &[SiglusTraceOp], keyed: bool) -> Vec<u8> {
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
pub(super) fn decode_program(
    profile_id: &str,
    bytes: &[u8],
) -> Result<Vec<SiglusTraceOp>, VmError> {
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
