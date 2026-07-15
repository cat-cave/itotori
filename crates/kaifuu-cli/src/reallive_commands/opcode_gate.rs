use std::collections::BTreeMap;

/// ALPHA-006a — `extract --engine reallive --scene <N> --bundle-output <PATH>`.
/// Sources the RealLive corpus either BY-ID through the read-only vault
/// (`--vault-canonical-id <ID>`, the alpha production route) or from a raw
/// game tree (`--game-root <PATH>` / `ITOTORI_REAL_GAME_ROOT`, the env-gated
/// test helper). It then loads the resolved `REALLIVEDATA/Seen.txt` envelope,
/// resolves scene `N` via the 10,000-slot directory, decompresses its
/// AVG32 LZSS payload using kaifuu-reallive's `decompress_avg32`, walks
/// the decompressed bytecode into the v0.2 BridgeBundle via
/// `kaifuu_reallive::produce_bundle`, and writes the JSON bundle to
/// `--bundle-output`.
/// Verdict of the `kaifuu extract` 100%-decode honesty gate.
#[derive(Debug)]
pub(crate) enum UnknownOpcodeGate {
    /// Every opcode decoded to a recognised semantic family (0 unknown).
    Clean,
    /// Un-recognised opcodes are present but the caller opted into exploratory
    /// decode (`--allow-unknown-opcodes` / `--exploratory`): a prominent
    /// warning is surfaced but the command still succeeds.
    Warn(String),
    /// Un-recognised opcodes are present and the caller did NOT opt in: the
    /// command must fail loud (non-zero exit) with the tuple list.
    Fail(String),
}

/// Decide the decode-honesty gate for a completed `--whole-seen` extract.
/// `unknown_opcodes` is the authoritative `!is_recognized` occurrence count;
/// `signatures` is the `(module_type, module_id, opcode) -> count` tuple
/// histogram. When the count is non-zero the SEEN did NOT fully decode: by
/// default this is a hard failure (the caller returns the `Fail` message as an
/// error → non-zero process exit); with `allow_unknown` it downgrades to a
/// `Warn`. Both non-clean verdicts embed the full tuple list under a clearly
/// flagged `INCOMPLETE DECODE: N unknown opcode tuples` header so a caller can
/// triage the exact un-catalogued commands rather than a bare aggregate count.
pub(crate) fn evaluate_unknown_opcode_gate(
    unknown_opcodes: usize,
    signatures: &BTreeMap<(u8, u8, u16), usize>,
    allow_unknown: bool,
) -> UnknownOpcodeGate {
    if unknown_opcodes == 0 {
        return UnknownOpcodeGate::Clean;
    }
    let mut message = format!(
        "INCOMPLETE DECODE: {} unknown opcode tuples ({} occurrences) — the SEEN did not \
         decode to zero unknown opcodes.\n(module_type, module_id, opcode) -> count:",
        signatures.len(),
        unknown_opcodes,
    );
    for ((module_type, module_id, opcode), count) in signatures {
        use std::fmt::Write as _;
        let _ = write!(
            message,
            "\n    ({module_type:>3}, {module_id:>3}, {opcode:>5}): {count}"
        );
    }
    if allow_unknown {
        message.push_str(
            "\nWARNING: continuing despite incomplete decode (--allow-unknown-opcodes / \
             --exploratory); this bundle does NOT meet the 100%-decode bar and must not be \
             treated as a faithful decode.",
        );
        UnknownOpcodeGate::Warn(message)
    } else {
        message.push_str(
            "\nkaifuu.reallive.incomplete_decode: refusing to emit a green result — pass \
             --allow-unknown-opcodes (or --exploratory) to continue for exploratory decode.",
        );
        UnknownOpcodeGate::Fail(message)
    }
}

/// Render the un-recognised-opcode signature histogram as the JSON array
/// (`[{ moduleType, moduleId, opcode, count }]`) embedded in the decompile
/// report under `unknownOpcodeTuples`.
pub(crate) fn unknown_opcode_tuples_json(
    signatures: &BTreeMap<(u8, u8, u16), usize>,
) -> serde_json::Value {
    serde_json::Value::Array(
        signatures
            .iter()
            .map(|((module_type, module_id, opcode), count)| {
                serde_json::json!({
                    "moduleType": module_type,
                    "moduleId": module_id,
                    "opcode": opcode,
                    "count": count,
                })
            })
            .collect(),
    )
}
