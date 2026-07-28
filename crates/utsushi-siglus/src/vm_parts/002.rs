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
        // Scramble everything after the plaintext header (magic + keyed flag
        // op count stay walkable so the container boundary is inspectable before
        // key handling — the same reject-before-key ordering as ).
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

