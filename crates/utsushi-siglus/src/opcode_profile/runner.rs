use super::*;

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
