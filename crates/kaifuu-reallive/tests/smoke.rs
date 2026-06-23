//! Falsifiable end-to-end tests for the KAIFUU-173 RealLive Scene/SEEN
//! parser-boundary smoke.
//!
//! The fixture set lives under `tests/fixtures/`. Bytes are produced by
//! the `synthetic` module here and asserted to match the on-disk
//! fixtures; this keeps the fixtures auditable while still letting CI
//! validate behavior against committed bytes.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use kaifuu_reallive::{
    DiagnosticSeverity, Instruction, InstructionKind, NamedOpcode, Operand, ParseDiagnostic,
    ParseDiagnosticCode, ParseStatus, SceneEntry, SceneIndex, StringSlot, StringSlotRole,
    parse_archive, parse_scene,
};

mod synthetic {
    //! Synthetic byte builders for the KAIFUU-173 fixtures.
    //!
    //! Every byte produced here is authored from public RealLive format
    //! archaeology plus the documented in-crate bytecode shape (see
    //! `crates/kaifuu-reallive/src/lib.rs`). No retail bytes, no opcode
    //! tables copied from rlvm or RLDEV.

    /// Build a SEEN.TXT archive envelope around a single scene payload.
    /// Layout: `u32 LE count = 1`, then `(u32 LE offset, u32 LE size)`
    /// entry, then `scene_bytes` at the declared offset.
    pub fn single_scene_archive(scene_bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(12 + scene_bytes.len());
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&12u32.to_le_bytes());
        out.extend_from_slice(&(scene_bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(scene_bytes);
        out
    }

    /// Build a SEEN.TXT envelope whose entry declares a payload longer
    /// than the archive bytes actually contain.
    pub fn truncated_scene_archive(declared_size: u32, actual_payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(12 + actual_payload.len());
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&12u32.to_le_bytes());
        out.extend_from_slice(&declared_size.to_le_bytes());
        out.extend_from_slice(actual_payload);
        out
    }

    /// Encode a `TextDisplay` instruction with a single string operand.
    pub fn text_display(text: &str) -> Vec<u8> {
        let operand = string_operand(text.as_bytes());
        instruction(0x01, &[operand.as_slice()])
    }

    /// Encode a `SetSpeaker` instruction with a single speaker-name operand.
    pub fn set_speaker(name: &str) -> Vec<u8> {
        let operand = string_operand(name.as_bytes());
        instruction(0x02, &[operand.as_slice()])
    }

    /// Encode a `Choice` instruction with N choice strings.
    pub fn choice(choices: &[&str]) -> Vec<u8> {
        let operands: Vec<Vec<u8>> = choices
            .iter()
            .map(|c| string_operand(c.as_bytes()))
            .collect();
        let refs: Vec<&[u8]> = operands.iter().map(|v| v.as_slice()).collect();
        instruction(0x03, &refs)
    }

    /// Encode a `Pause` instruction (no operands).
    pub fn pause() -> Vec<u8> {
        instruction(0x08, &[])
    }

    /// Generic instruction encoder. Layout per `lib.rs`: opener
    /// `0x23`, opcode byte, operand-count byte, then each operand verbatim.
    pub fn instruction(opcode: u8, operands: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(0x23);
        out.push(opcode);
        out.push(operands.len() as u8);
        for operand in operands {
            out.extend_from_slice(operand);
        }
        out
    }

    /// `s` tag + u16 LE length + raw bytes.
    pub fn string_operand(bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(3 + bytes.len());
        out.push(0x73);
        out.extend_from_slice(&(bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(bytes);
        out
    }

    /// Bytes for the `smoke-scene-001` scene blob.
    pub fn smoke_scene_001_blob() -> Vec<u8> {
        let mut blob = Vec::new();
        blob.extend_from_slice(&set_speaker("Aoi"));
        blob.extend_from_slice(&text_display("Hello!"));
        blob.extend_from_slice(&choice(&["Yes", "No"]));
        blob.extend_from_slice(&pause());
        blob
    }

    /// Bytes for the `unknown-opcode-001` scene blob.
    pub fn unknown_opcode_001_blob() -> Vec<u8> {
        let mut blob = Vec::new();
        blob.extend_from_slice(&text_display("Hi"));
        blob.push(0x55); // unrecognized opener byte — not 0x23
        blob.extend_from_slice(&text_display("Bye"));
        blob
    }
}

fn fixture_path(name: &str) -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("tests");
    path.push("fixtures");
    path.push(name);
    path.push("SEEN.TXT");
    path
}

fn read_fixture(name: &str) -> Vec<u8> {
    let path = fixture_path(name);
    fs::read(&path).unwrap_or_else(|err| panic!("fixture {name} read failure: {err} at {path:?}"))
}

fn assert_synthetic_matches_committed(name: &str, expected: &[u8]) {
    let on_disk = read_fixture(name);
    assert_eq!(
        on_disk, expected,
        "committed fixture bytes for {name} drifted from the synthetic builder; \
         regenerate the on-disk fixture or fix the builder."
    );
}

fn assert_archive_partition(index: &SceneIndex, archive_bytes: &[u8]) {
    let header_end = 4u64 + (index.entries.len() as u64) * 8;
    for entry in &index.entries {
        assert!(
            entry.byte_offset >= header_end,
            "scene entry {} offset {} overlaps archive header (end {header_end})",
            entry.scene_id.as_str(),
            entry.byte_offset
        );
        let end = entry.byte_offset + entry.byte_len;
        assert!(
            end <= archive_bytes.len() as u64,
            "scene entry {} declares end {} past archive length {}",
            entry.scene_id.as_str(),
            end,
            archive_bytes.len()
        );
    }
}

fn parse_first_scene(archive_bytes: &[u8]) -> (SceneIndex, SceneEntry, Vec<u8>) {
    let index = parse_archive(archive_bytes).expect("archive should parse");
    assert!(!index.entries.is_empty(), "archive should expose >=1 entry");
    let entry = index.entries[0].clone();
    let slice = archive_bytes
        [entry.byte_offset as usize..(entry.byte_offset + entry.byte_len) as usize]
        .to_vec();
    (index, entry, slice)
}

// ----- smoke-scene-001 -----------------------------------------------------

#[test]
fn parses_smoke_scene_001_into_structured_ast_with_named_opcodes() {
    let scene_blob = synthetic::smoke_scene_001_blob();
    let archive_bytes = synthetic::single_scene_archive(&scene_blob);
    assert_synthetic_matches_committed("smoke-scene-001", &archive_bytes);

    let (index, entry, blob) = parse_first_scene(&archive_bytes);
    assert_archive_partition(&index, &archive_bytes);
    assert_eq!(entry.scene_id.as_str(), "reallive:scene-0000");

    let outcome = parse_scene(&blob, entry.archive_index, entry.byte_offset);
    assert_eq!(
        outcome.status,
        ParseStatus::Ok,
        "diagnostics: {:?}",
        outcome.diagnostics
    );
    assert!(outcome.diagnostics.is_empty());
    let scene = outcome.scene.expect("scene must be present on Ok status");

    let named_opcodes: Vec<NamedOpcode> = scene
        .instructions
        .iter()
        .map(|i| match &i.kind {
            InstructionKind::Named { opcode } => *opcode,
            InstructionKind::Unrecognized { raw_opener_byte } => {
                panic!("unexpected unrecognized instruction 0x{raw_opener_byte:02X}")
            }
        })
        .collect();
    assert_eq!(
        named_opcodes,
        vec![
            NamedOpcode::SetSpeaker,
            NamedOpcode::TextDisplay,
            NamedOpcode::Choice,
            NamedOpcode::Pause,
        ]
    );

    // String slots: speaker "Aoi", dialogue "Hello!", choice "Yes", choice "No".
    let raw_texts: Vec<String> = scene.strings.iter().map(slot_text_lossy).collect();
    assert_eq!(raw_texts, vec!["Aoi", "Hello!", "Yes", "No"]);

    let roles: Vec<StringSlotRole> = scene.strings.iter().map(|s| s.semantic_role).collect();
    assert_eq!(
        roles,
        vec![
            StringSlotRole::SpeakerName,
            StringSlotRole::Dialogue,
            StringSlotRole::Choice,
            StringSlotRole::Choice,
        ]
    );

    // The Choice instruction must reference both string slots.
    let choice_instr = scene
        .instructions
        .iter()
        .find(|i| {
            matches!(
                i.kind,
                InstructionKind::Named {
                    opcode: NamedOpcode::Choice
                }
            )
        })
        .expect("choice instruction present");
    assert_eq!(choice_instr.string_slot_refs.len(), 2);
    assert_eq!(
        choice_instr
            .operands
            .iter()
            .filter(|op| matches!(op, Operand::String { .. }))
            .count(),
        2
    );

    // Schema version stamps must be present.
    assert_eq!(scene.schema_version, "0.1.0");
    assert_eq!(index.schema_version, "0.1.0");
}

#[test]
fn extracts_stable_string_slot_ids_derived_from_byte_offset() {
    let scene_blob = synthetic::smoke_scene_001_blob();
    let archive_bytes = synthetic::single_scene_archive(&scene_blob);
    let (_, entry, blob) = parse_first_scene(&archive_bytes);
    let outcome = parse_scene(&blob, entry.archive_index, entry.byte_offset);
    let scene = outcome.scene.expect("scene present");

    // The slot id MUST encode the within-scene byte offset and the
    // within-instruction slot index, derived only from byte position.
    for slot in &scene.strings {
        let expected = format!(
            "reallive:scene-{:04}:str-off-{:08x}-idx00",
            entry.archive_index, slot.byte_offset_within_scene
        );
        // Choices have two slots; the second is idx01.
        let expected_alt = format!(
            "reallive:scene-{:04}:str-off-{:08x}-idx01",
            entry.archive_index, slot.byte_offset_within_scene
        );
        assert!(
            slot.slot_id.as_str() == expected || slot.slot_id.as_str() == expected_alt,
            "slot id {:?} does not match the derived format ({} | {})",
            slot.slot_id.as_str(),
            expected,
            expected_alt
        );
    }

    // Ids must be unique across the scene.
    let id_set: HashSet<&str> = scene.strings.iter().map(|s| s.slot_id.as_str()).collect();
    assert_eq!(id_set.len(), scene.strings.len());
}

#[test]
fn string_slot_id_format_matches_documented_bridge_contract() {
    let scene_blob = synthetic::smoke_scene_001_blob();
    let archive_bytes = synthetic::single_scene_archive(&scene_blob);
    let (_, entry, blob) = parse_first_scene(&archive_bytes);
    let outcome = parse_scene(&blob, entry.archive_index, entry.byte_offset);
    let scene = outcome.scene.expect("scene present");

    // The first slot is the SetSpeaker "Aoi" payload at scene-blob offset
    // 6 (opener + opcode + opcount + s-tag + 2-byte length = 6 bytes).
    let first = &scene.strings[0];
    assert_eq!(
        first.slot_id.as_str(),
        "reallive:scene-0000:str-off-00000006-idx00"
    );
    assert_eq!(first.byte_offset_within_scene, 6);
    assert_eq!(first.byte_len, 3);
    assert_eq!(first.raw_bytes_hex, "416F69"); // 'A','o','i' uppercase hex
}

#[test]
fn ast_serializes_named_opcode_strings_not_opaque_byte_values() {
    let scene_blob = synthetic::smoke_scene_001_blob();
    let archive_bytes = synthetic::single_scene_archive(&scene_blob);
    let (_, entry, blob) = parse_first_scene(&archive_bytes);
    let outcome = parse_scene(&blob, entry.archive_index, entry.byte_offset);
    let scene = outcome.scene.expect("scene present");

    let json = serde_json::to_string(&scene).expect("serialize scene");
    for expected in [
        r#""opcode":"set_speaker""#,
        r#""opcode":"text_display""#,
        r#""opcode":"choice""#,
        r#""opcode":"pause""#,
    ] {
        assert!(
            json.contains(expected),
            "AST JSON missing named-opcode marker {expected}; got: {json}"
        );
    }
    // No raw byte values in the serialized AST.
    assert!(
        !json.contains("rawOpcodeByte"),
        "named instruction must not expose raw byte; got: {json}"
    );
}

// ----- truncated-scene-001 -------------------------------------------------

#[test]
fn rejects_truncated_scene_with_kaifuu_reallive_truncated_scene_diagnostic() {
    // Envelope claims size = 20 bytes but only 2 bytes of payload follow.
    let payload = vec![0x23u8, 0x01];
    let archive_bytes = synthetic::truncated_scene_archive(20, &payload);
    assert_synthetic_matches_committed("truncated-scene-001", &archive_bytes);

    let err = parse_archive(&archive_bytes).expect_err("envelope must reject");
    assert_eq!(err.code, ParseDiagnosticCode::TruncatedScene);
    assert_eq!(err.severity, DiagnosticSeverity::Fatal);
    assert!(err.message.contains("past archive length"));
    assert!(err.remediation.is_some());
}

#[test]
fn rejects_out_of_profile_input_with_kaifuu_reallive_out_of_profile_input() {
    let too_short: &[u8] = b"AB";
    let err = parse_archive(too_short).expect_err("too-short input must reject");
    assert_eq!(err.code, ParseDiagnosticCode::OutOfProfileInput);
    assert_eq!(err.severity, DiagnosticSeverity::Fatal);
}

// ----- unknown-opcode-001 --------------------------------------------------

#[test]
fn emits_kaifuu_reallive_unrecognized_instruction_warning_without_dropping_byte_range() {
    let scene_blob = synthetic::unknown_opcode_001_blob();
    let archive_bytes = synthetic::single_scene_archive(&scene_blob);
    assert_synthetic_matches_committed("unknown-opcode-001", &archive_bytes);

    let (_, entry, blob) = parse_first_scene(&archive_bytes);
    let outcome = parse_scene(&blob, entry.archive_index, entry.byte_offset);
    assert_eq!(
        outcome.status,
        ParseStatus::OkWithWarnings,
        "expected warnings-only status; got {:?} diagnostics={:?}",
        outcome.status,
        outcome.diagnostics
    );
    let scene = outcome
        .scene
        .expect("scene must be present on OkWithWarnings");

    // We expect three nodes: TextDisplay, Unrecognized(0x55), TextDisplay.
    assert_eq!(scene.instructions.len(), 3);
    let kinds: Vec<&str> = scene
        .instructions
        .iter()
        .map(|i| match &i.kind {
            InstructionKind::Named { opcode } => opcode.as_label(),
            InstructionKind::Unrecognized { .. } => "unrecognized",
        })
        .collect();
    assert_eq!(kinds, vec!["text_display", "unrecognized", "text_display"]);

    // The unrecognized node carries the raw opener and a byte_len of 1.
    let unrecognized = &scene.instructions[1];
    assert_eq!(unrecognized.byte_len, 1);
    match &unrecognized.kind {
        InstructionKind::Unrecognized { raw_opener_byte } => assert_eq!(*raw_opener_byte, 0x55),
        InstructionKind::Named { .. } => panic!("expected Unrecognized variant"),
    }

    // Exactly one warning diagnostic with the documented code, carrying
    // the byte_len = 1 span.
    let warnings: Vec<&ParseDiagnostic> = outcome
        .diagnostics
        .iter()
        .filter(|d| d.code == ParseDiagnosticCode::UnrecognizedInstruction)
        .collect();
    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0].severity, DiagnosticSeverity::Warning);
    assert_eq!(warnings[0].byte_offset, 8); // first text_display = 8 bytes
    assert_eq!(warnings[0].byte_len, Some(1));
}

#[test]
fn partitions_scene_bytes_completely_into_instructions_and_diagnostics() {
    let scene_blob = synthetic::unknown_opcode_001_blob();
    let archive_bytes = synthetic::single_scene_archive(&scene_blob);
    let (_, entry, blob) = parse_first_scene(&archive_bytes);
    let outcome = parse_scene(&blob, entry.archive_index, entry.byte_offset);
    let scene = outcome.scene.expect("scene present");

    // Every byte must be covered by exactly one instruction node OR by a
    // diagnostic byte-span. Instructions cover their declared
    // byte_offset..byte_offset+byte_len. Diagnostics cover byte_offset.. if
    // byte_len is set.
    let mut covered = vec![false; blob.len()];
    for instruction in &scene.instructions {
        let start = instruction.byte_offset as usize;
        let end = (instruction.byte_offset + instruction.byte_len) as usize;
        assert!(
            end <= blob.len(),
            "instruction span {start}..{end} runs past blob ({})",
            blob.len()
        );
        for byte in covered.iter_mut().take(end).skip(start) {
            assert!(
                !*byte,
                "overlapping instruction coverage at one of {start}..{end}"
            );
            *byte = true;
        }
    }
    for diagnostic in &outcome.diagnostics {
        if let Some(len) = diagnostic.byte_len {
            let start = diagnostic.byte_offset as usize;
            let end = (diagnostic.byte_offset + len) as usize;
            for byte in covered.iter_mut().take(end.min(blob.len())).skip(start) {
                *byte = true;
            }
        }
    }
    let uncovered: Vec<usize> = covered
        .iter()
        .enumerate()
        .filter(|(_, b)| !**b)
        .map(|(i, _)| i)
        .collect();
    assert!(
        uncovered.is_empty(),
        "uncovered bytes: {uncovered:?}; instructions = {}, diagnostics = {}",
        scene.instructions.len(),
        outcome.diagnostics.len()
    );
}

// ----- stability oracle ----------------------------------------------------

#[test]
fn parses_identical_bytes_to_identical_ast_across_runs() {
    let scene_blob = synthetic::smoke_scene_001_blob();
    let archive_bytes = synthetic::single_scene_archive(&scene_blob);

    let mut serialized = Vec::with_capacity(3);
    for _ in 0..3 {
        let (index, entry, blob) = parse_first_scene(&archive_bytes);
        let outcome = parse_scene(&blob, entry.archive_index, entry.byte_offset);
        let combined = serde_json::json!({
            "index": index,
            "outcome": outcome,
        });
        serialized.push(serde_json::to_string(&combined).expect("serialize stability snapshot"));
    }
    // Byte-identical JSON across three iterations.
    let first = &serialized[0];
    for (i, next) in serialized.iter().enumerate().skip(1) {
        assert_eq!(
            first, next,
            "stability oracle failed: iteration 0 and {i} differ"
        );
    }
}

// ----- helpers -------------------------------------------------------------

fn slot_text_lossy(slot: &StringSlot) -> String {
    let bytes = hex_decode(&slot.raw_bytes_hex);
    String::from_utf8_lossy(&bytes).into_owned()
}

fn hex_decode(input: &str) -> Vec<u8> {
    assert!(
        input.len().is_multiple_of(2),
        "hex string must be even-length"
    );
    let mut out = Vec::with_capacity(input.len() / 2);
    let bytes = input.as_bytes();
    for chunk in bytes.chunks(2) {
        let hi = decode_nibble(chunk[0]);
        let lo = decode_nibble(chunk[1]);
        out.push((hi << 4) | lo);
    }
    out
}

fn decode_nibble(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'A'..=b'F' => byte - b'A' + 10,
        b'a'..=b'f' => byte - b'a' + 10,
        _ => panic!("invalid hex nibble: {byte}"),
    }
}

// Compile-time guarantee that the unused `Instruction` import still
// resolves — keeps the test file honest if the public surface shrinks.
#[allow(dead_code)]
fn _unused(_i: Instruction) {}
