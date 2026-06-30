//! KAIFUU-210 real-bytes integration test for the v0.2 BridgeBundle
//! producer, including the binary-vs-dialogue surface-selection split.
//!
//! Reads Sweetie HD from `ITOTORI_REAL_GAME_ROOT` and exercises two
//! scenes:
//!
//! - **Scene 1** is a system/boundary scene: every one of its Textout
//!   runs is embedded binary data (the catch-all decoder returns them as
//!   `Textout`, but they do not decode as Shift-JIS). The producer must
//!   surface ZERO translatable units and return `NoTextUnits` — surfacing
//!   any of them (e.g. the 214-byte op[72] data block) would let patchback
//!   overwrite the table and corrupt the scene.
//! - **Scene 1018** is a dialogue scene that decodes 100% clean under the
//!   reference-complete command catalogue (real `module_sel` select-block
//!   Choice units included). The producer must surface exactly the readable
//!   Shift-JIS Textout runs plus choice options as translatable units — no
//!   false negatives — with decoded text, a `reallive.kidoku` span, and
//!   NAMAE-resolved speakers. (The previously-used scene 2011 contains a
//!   second-level-XOR'd `module_sel` block — a `compiler_version=110002`
//!   `xor_2` segment, owned by the decompressor follow-up node — so it can
//!   no longer be decoded end-to-end and is not a valid clean fixture.)
//!
//! The test is env-gated; without `ITOTORI_REAL_GAME_ROOT` it
//! emits an explicit skip notice and returns (no silent pass).
//! Set `ITOTORI_REQUIRE_REAL_BYTES=1` to turn the absent corpus
//! into a hard failure instead of a skip.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;

use kaifuu_reallive::{
    BridgeOpts, BridgeProduceError, REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, RealLiveOpcode,
    SceneHeader, decompress_avg32, gameexe::parse_gameexe_inventory, is_translatable_textout,
    parse_archive, parse_real_bytecode, produce_bundle,
};

const SWEETIE_HD_GAME_ID: &str = "sweetie-hd";
const SWEETIE_HD_SOURCE_PROFILE_ID: &str = "kaifuu-reallive-sweetie-hd";
/// A known dialogue-bearing scene in Sweetie HD's `Seen.txt` that decodes
/// 100% clean (readable dialogue + binary catch-all runs + real
/// `module_sel` select-block Choice options + kidoku + NAMAE speakers).
const DIALOGUE_SCENE_ID: u16 = 1018;

fn real_seen_txt_path() -> Option<PathBuf> {
    real_corpus::seen_txt_path()
}

fn real_gameexe_ini_path() -> Option<PathBuf> {
    real_corpus::gameexe_ini_path()
}

/// Decompressed bytecode + parsed header for a scene id, plus the scene
/// blob slice (needed by `produce_bundle`).
struct SceneBytecode {
    scene_blob: Vec<u8>,
    decompressed: Vec<u8>,
    header: SceneHeader,
}

fn scene_bytecode(seen_bytes: &[u8], scene_id: u16) -> SceneBytecode {
    let index = parse_archive(seen_bytes).expect("real Seen.txt envelope must parse");
    let entry = index
        .entries
        .iter()
        .find(|entry| entry.scene_id == scene_id)
        .unwrap_or_else(|| panic!("scene {scene_id} must exist in the directory"));
    let blob_start = entry.byte_offset as usize;
    let blob_end = blob_start + entry.byte_len as usize;
    let scene_blob = seen_bytes[blob_start..blob_end].to_vec();
    let header = SceneHeader::parse(&scene_blob).expect("scene header must parse");
    let bytecode = &scene_blob[header.bytecode_offset as usize
        ..(header.bytecode_offset + header.bytecode_compressed_size) as usize];
    let decompressed = decompress_avg32(bytecode, header.bytecode_uncompressed_size as usize)
        .expect("AVG32 decompression must succeed");
    assert_eq!(
        decompressed.len(),
        header.bytecode_uncompressed_size as usize,
        "decompressor must produce exactly bytecode_uncompressed_size bytes"
    );
    SceneBytecode {
        scene_blob,
        decompressed,
        header,
    }
}

fn bridge_opts(scene_kidoku_count: u32) -> BridgeOpts<'static> {
    BridgeOpts {
        game_id: SWEETIE_HD_GAME_ID,
        game_version: "1.0.0",
        source_profile_id: SWEETIE_HD_SOURCE_PROFILE_ID,
        source_locale: "ja-JP",
        extractor_name: "kaifuu-reallive-bridge",
        extractor_version: "0.1.0",
        scene_kidoku_count,
    }
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn scene_1_all_textouts_are_binary_and_produce_no_translatable_units_real_bytes() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::skip_or_require_real_bytes(
            "scene_1_all_textouts_are_binary_and_produce_no_translatable_units_real_bytes",
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));
    assert!(
        seen_bytes.len() as u64 >= REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
        "Seen.txt must carry the 10,000-slot directory"
    );

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

    let scene = scene_bytecode(&seen_bytes, 1);
    let opcodes = parse_real_bytecode(&scene.decompressed).expect("bytecode must decode");

    // Every scene-1 Textout run is embedded binary data — none decode as
    // Shift-JIS, so all are excluded from translatable units.
    let textouts: Vec<&[u8]> = opcodes
        .iter()
        .filter_map(|op| match op {
            RealLiveOpcode::Textout { raw_bytes, .. } => Some(raw_bytes.as_slice()),
            _ => None,
        })
        .collect();
    assert!(
        !textouts.is_empty(),
        "scene 1 must contain at least one (binary) Textout run"
    );
    let translatable = textouts
        .iter()
        .filter(|raw| is_translatable_textout(raw))
        .count();
    eprintln!(
        "scene 1: {} Textout runs, {translatable} translatable",
        textouts.len()
    );
    assert_eq!(
        translatable, 0,
        "every scene-1 Textout run must be binary (non-translatable); got {translatable} readable"
    );

    // The 214-byte op[72] data block in particular must be non-translatable.
    let block_214 = textouts
        .iter()
        .find(|raw| raw.len() == 214)
        .expect("scene 1 must contain the 214-byte binary data block");
    assert!(
        !is_translatable_textout(block_214),
        "the 214-byte binary data block must be excluded from translatable units"
    );

    // The producer therefore refuses to emit an empty bundle: an all-binary
    // scene surfaces NoTextUnits rather than corrupting-data units.
    let gameexe_bytes = real_gameexe_ini_path()
        .and_then(|path| fs::read(path).ok())
        .unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);
    let opts = bridge_opts(scene.header.kidoku_count);
    let err = produce_bundle(
        1,
        &scene.scene_blob,
        &scene.decompressed,
        &gameexe_inventory,
        &opts,
    )
    .expect_err("an all-binary scene must not produce translatable units");
    assert!(
        matches!(err, BridgeProduceError::NoTextUnits { scene_id: 1, .. }),
        "expected NoTextUnits for all-binary scene 1; got {err:?}"
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn dialogue_scene_surfaces_readable_sjis_textouts_as_translatable_units_real_bytes() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::skip_or_require_real_bytes(
            "dialogue_scene_surfaces_readable_sjis_textouts_as_translatable_units_real_bytes",
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));

    let scene = scene_bytecode(&seen_bytes, DIALOGUE_SCENE_ID);

    let gameexe_bytes = real_gameexe_ini_path()
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

    let opts = bridge_opts(scene.header.kidoku_count);
    let produced = produce_bundle(
        DIALOGUE_SCENE_ID,
        &scene.scene_blob,
        &scene.decompressed,
        &gameexe_inventory,
        &opts,
    )
    .expect("v0.2 bundle must build from a dialogue scene");

    // ---- Acceptance: schemaVersion. ----
    assert_eq!(produced.bundle.schema_version, "0.2.0");

    // ---- Acceptance: units.len matches READABLE textout + choice count. ----
    // The surface-selection split means only Textout runs that decode as
    // Shift-JIS are surfaced; binary catch-all runs are excluded. The
    // no-false-negative guarantee is that EVERY readable run is surfaced.
    let opcodes = parse_real_bytecode(&scene.decompressed).expect("bytecode must decode");
    let readable_textout_count = opcodes
        .iter()
        .filter(|op| match op {
            RealLiveOpcode::Textout { raw_bytes, .. } => is_translatable_textout(raw_bytes),
            _ => false,
        })
        .count();
    let binary_textout_count = opcodes
        .iter()
        .filter(|op| match op {
            RealLiveOpcode::Textout { raw_bytes, .. } => !is_translatable_textout(raw_bytes),
            _ => false,
        })
        .count();
    let choice_unit_count: usize = opcodes
        .iter()
        .filter_map(|op| match op {
            RealLiveOpcode::Choice { choices } => Some(choices.len()),
            _ => None,
        })
        .sum();
    let expected_units = readable_textout_count + choice_unit_count;
    eprintln!(
        "scene {DIALOGUE_SCENE_ID} bridge units: produced={} expected={expected_units} \
         (readable_textout={readable_textout_count}, binary_textout={binary_textout_count}, \
         choice_options={choice_unit_count})",
        produced.bundle.units.len(),
    );
    assert!(
        readable_textout_count > 0,
        "a dialogue scene must surface at least one readable Shift-JIS dialogue run"
    );
    assert!(
        binary_textout_count > 0,
        "the dialogue scene also carries binary catch-all runs (the exclusion path must be exercised)"
    );
    assert_eq!(
        produced.bundle.units.len(),
        expected_units,
        "bridge unit count must equal READABLE Textout + Choice option count (no false negatives, \
         no surfaced binary)"
    );

    // ---- Acceptance: every surfaced dialogue unit decodes to non-empty text. ----
    // (No false-positive binary leaked into the translatable set.)
    for unit in &produced.bundle.units {
        if unit.surface_kind == "dialogue" {
            assert!(
                !unit.source_text.is_empty(),
                "a surfaced dialogue unit must carry decoded Shift-JIS text"
            );
        }
    }
    let first_unit = &produced.bundle.units[0];
    eprintln!(
        "first unit: sourceText (truncated)='{}' surfaceKind={}",
        first_unit.source_text.chars().take(40).collect::<String>(),
        first_unit.surface_kind,
    );

    // ---- Acceptance: at least one reallive.kidoku span. ----
    let units_array = produced.json["units"]
        .as_array()
        .expect("units must be an array");
    let mut kidoku_span_count = 0usize;
    let mut emitted_parsed_names: std::collections::BTreeSet<String> =
        std::collections::BTreeSet::new();

    // ---- Acceptance: at least one unit's speaker resolved via NAMAE. ----
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

    // ---- Acceptance: provenance byteRange is a decompressed-stream interval. ----
    let range = &produced.json["units"][0]["sourceLocation"]["range"];
    let start_byte = range["startByte"]
        .as_u64()
        .expect("range.startByte must be a u64");
    let end_byte = range["endByte"]
        .as_u64()
        .expect("range.endByte must be a u64");
    let decompressed_len = scene.decompressed.len() as u64;
    assert!(
        start_byte < decompressed_len,
        "byteRange.startByte must be a decompressed-stream offset (< {decompressed_len}); got {start_byte}"
    );
    assert!(
        end_byte > start_byte && end_byte <= decompressed_len,
        "byteRange must be a positive-width interval inside the decompressed bytecode; got {start_byte}..{end_byte}"
    );
    eprintln!(
        "first unit decompressed byte range: {start_byte}..{end_byte} (decompressed len {decompressed_len})"
    );
}
