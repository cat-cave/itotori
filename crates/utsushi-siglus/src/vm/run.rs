use super::*;

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
