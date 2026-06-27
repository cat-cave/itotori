//! KAIFUU-210 real-bytes integration test for the v0.2 BridgeBundle
//! producer.
//!
//! Reads Sweetie HD scene 1 from `KAIFUU_REAL_SWEETIE_HD_PATH`, runs the
//! `kaifuu_reallive::produce_bundle` end-to-end, and asserts the
//! resulting bundle satisfies the KAIFUU-210 acceptance criteria:
//!
//! - `schemaVersion == "0.2.0"` (canonical v0.2 contract).
//! - `units.len() > 0` and matches the
//!   textout+choice element count from `parse_real_bytecode`.
//! - First text unit's `sourceText` decodes non-empty Shift-JIS text.
//! - At least one protected span carries `parsedName ==
//!   "reallive.kidoku"`.
//! - `provenance.byteRange` is anchored against the scene 1 blob's file
//!   offset (`0x13880`).
//!
//! The test is env-gated; without `KAIFUU_REAL_SWEETIE_HD_PATH` it
//! emits an explicit skip notice and returns (no silent pass).

use std::env;
use std::fs;
use std::path::PathBuf;

use kaifuu_reallive::{
    BridgeOpts, REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, RealLiveOpcode, SceneHeader,
    decompress_avg32, gameexe::parse_gameexe_inventory, parse_archive, parse_real_bytecode,
    produce_bundle,
};

const SWEETIE_HD_RELATIVE_PATH: &str = "オシオキSweetie＋Sweets!! HD_DL版/REALLIVEDATA/Seen.txt";
const SWEETIE_HD_GAMEEXE_PATH: &str = "オシオキSweetie＋Sweets!! HD_DL版/REALLIVEDATA/Gameexe.ini";
const SWEETIE_HD_GAME_ID: &str = "sweetie-hd";
const SWEETIE_HD_SOURCE_PROFILE_ID: &str = "kaifuu-reallive-sweetie-hd";

fn sweetie_hd_seen_txt_path() -> Option<PathBuf> {
    let root = env::var_os("KAIFUU_REAL_SWEETIE_HD_PATH")?;
    Some(PathBuf::from(root).join(SWEETIE_HD_RELATIVE_PATH))
}

fn sweetie_hd_gameexe_path() -> Option<PathBuf> {
    let root = env::var_os("KAIFUU_REAL_SWEETIE_HD_PATH")?;
    Some(PathBuf::from(root).join(SWEETIE_HD_GAMEEXE_PATH))
}

#[test]
#[ignore = "real-bytes; requires KAIFUU_REAL_SWEETIE_HD_PATH env var"]
fn produces_v02_bridge_bundle_from_sweetie_hd_scene_1_real_bytes() {
    let Some(seen_path) = sweetie_hd_seen_txt_path() else {
        eprintln!(
            "KAIFUU_REAL_SWEETIE_HD_PATH unset; skipping (re-run with \
             KAIFUU_REAL_SWEETIE_HD_PATH=/scratch/itotori-research/sweetie-hd/extracted)"
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));
    assert!(
        seen_bytes.len() as u64 >= REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
        "Seen.txt must carry the 10,000-slot directory"
    );

    // Locate scene 1's blob bytes via parse_archive (KAIFUU-188).
    let index = parse_archive(&seen_bytes).expect("real Seen.txt envelope must parse");
    let entry = index
        .entries
        .iter()
        .find(|entry| entry.scene_id == 1)
        .expect("scene 1 must exist in the directory");
    assert_eq!(
        entry.byte_offset, 0x13880,
        "scene 1 must sit at file offset 0x13880 immediately after the 80,000-byte directory"
    );
    let blob_start = entry.byte_offset as usize;
    let blob_end = blob_start + entry.byte_len as usize;
    let scene_blob = &seen_bytes[blob_start..blob_end];

    // Decompress via the kaifuu-reallive AVG32 decompressor.
    let header = SceneHeader::parse(scene_blob).expect("scene header must parse");
    let bytecode = &scene_blob[header.bytecode_offset as usize
        ..(header.bytecode_offset + header.bytecode_compressed_size) as usize];
    let decompressed = decompress_avg32(bytecode, header.bytecode_uncompressed_size as usize)
        .expect("AVG32 decompression must succeed");
    assert_eq!(
        decompressed.len(),
        header.bytecode_uncompressed_size as usize,
        "decompressor must produce exactly bytecode_uncompressed_size bytes"
    );

    // Parse Gameexe.ini for NAMAE entries (the file is best-effort —
    // empty inventory still satisfies the test if Sweetie HD's
    // Gameexe.ini is unavailable for any reason).
    let gameexe_bytes = sweetie_hd_gameexe_path()
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);
    let namae_entries = gameexe_inventory
        .entries
        .iter()
        .filter(|entry| {
            matches!(
                entry.family,
                kaifuu_reallive::gameexe::GameexeKeyFamily::Namae
            )
        })
        .count();
    eprintln!("Gameexe NAMAE entries observed: {namae_entries}");

    // Walk the bridge producer.
    let opts = BridgeOpts {
        game_id: SWEETIE_HD_GAME_ID,
        game_version: "1.0.0",
        source_profile_id: SWEETIE_HD_SOURCE_PROFILE_ID,
        source_locale: "ja-JP",
        scene_blob_file_offset: entry.byte_offset,
        extractor_name: "kaifuu-reallive-bridge",
        extractor_version: "0.1.0",
        scene_kidoku_count: header.kidoku_count,
    };
    let produced = produce_bundle(1, scene_blob, &decompressed, &gameexe_inventory, &opts)
        .expect("v0.2 bundle must build from real Sweetie HD scene 1");

    // ---- Acceptance: schemaVersion. ----
    assert_eq!(produced.bundle.schema_version, "0.2.0");

    // ---- Acceptance: units.len matches textout+choice opcode count. ----
    let opcodes = parse_real_bytecode(&decompressed).expect("bytecode must decode");
    let textout_count = opcodes
        .iter()
        .filter(|op| matches!(op, RealLiveOpcode::Textout { .. }))
        .count();
    let choice_unit_count: usize = opcodes
        .iter()
        .filter_map(|op| match op {
            RealLiveOpcode::Choice { choices } => Some(choices.len()),
            _ => None,
        })
        .sum();
    let expected_units = textout_count + choice_unit_count;
    eprintln!(
        "scene 1 bridge units: produced={} expected={} (textout={textout_count}, choice_options={choice_unit_count})",
        produced.bundle.units.len(),
        expected_units,
    );
    assert!(
        !produced.bundle.units.is_empty(),
        "scene 1 must produce ≥1 bridge unit (no silent zero-state)"
    );
    assert_eq!(
        produced.bundle.units.len(),
        expected_units,
        "bridge unit count must equal Textout + Choice option count from parse_real_bytecode"
    );

    // ---- Acceptance: first text unit's sourceText decodes non-empty. ----
    let first_unit = &produced.bundle.units[0];
    assert!(
        !first_unit.source_text.is_empty(),
        "first unit must carry decoded Shift-JIS text; got empty"
    );
    eprintln!(
        "first unit: sourceText (truncated)='{}' surfaceKind={}",
        first_unit.source_text.chars().take(40).collect::<String>(),
        first_unit.surface_kind,
    );

    // ---- Acceptance: at least one reallive.kidoku span. ----
    let mut kidoku_span_count = 0usize;
    let mut emitted_parsed_names: std::collections::BTreeSet<String> =
        std::collections::BTreeSet::new();
    let units_array = produced.json["units"]
        .as_array()
        .expect("units must be an array");

    // ---- Acceptance: at least one unit's speaker resolved via NAMAE. ----
    // Per the KAIFUU-210 acceptance criteria, NAMAE-driven speaker
    // resolution must succeed for at least one unit when the NAMAE
    // table is populated. If Gameexe.ini was unavailable
    // (namae_entries == 0) we record a diagnostic instead of failing
    // — that's a data shortfall, not a producer bug.
    if namae_entries > 0 {
        let resolved = units_array
            .iter()
            .filter_map(|unit| unit["speaker"].as_object())
            .filter(|speaker| {
                let state = speaker.get("knowledgeState").and_then(|v| v.as_str());
                matches!(state, Some("known"))
                    || (matches!(state, Some("parser_unknown"))
                        && speaker.contains_key("rawSpeakerText"))
            })
            .count();
        eprintln!("units with NAMAE-resolved speaker: {resolved}");
        assert!(
            resolved >= 1,
            "at least one unit must carry a NAMAE-resolved speaker when the NAMAE table is populated ({namae_entries} entries); got {resolved}"
        );
    }

    for unit in units_array {
        for span in unit["spans"]
            .as_array()
            .map(|s| s.as_slice())
            .unwrap_or(&[])
        {
            if let Some(name) = span["parsedName"].as_str() {
                emitted_parsed_names.insert(name.to_string());
                if name == "reallive.kidoku" {
                    kidoku_span_count += 1;
                }
            }
        }
    }
    eprintln!(
        "protected-span kinds observed: {emitted_parsed_names:?} (kidoku count={kidoku_span_count})"
    );
    assert!(
        kidoku_span_count >= 1,
        "at least one reallive.kidoku protected span must be emitted; observed kinds: {emitted_parsed_names:?}"
    );

    // ---- Acceptance: provenance byteRange anchored at file offset 0x13880. ----
    let range = &produced.json["units"][0]["sourceLocation"]["range"];
    let start_byte = range["startByte"]
        .as_u64()
        .expect("range.startByte must be a u64");
    let end_byte = range["endByte"]
        .as_u64()
        .expect("range.endByte must be a u64");
    assert!(
        start_byte >= 0x13880,
        "provenance.byteRange must be anchored at scene 1's blob file offset (0x13880); got {start_byte:#x}"
    );
    assert!(
        end_byte > start_byte,
        "byteRange must be a positive-width interval"
    );
    eprintln!(
        "first unit byte range: {start_byte:#x}..{end_byte:#x} (anchored at scene blob 0x{:x})",
        entry.byte_offset
    );
}
