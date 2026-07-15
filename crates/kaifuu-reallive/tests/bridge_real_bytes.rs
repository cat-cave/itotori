//! real-bytes integration test for the v0.2 BridgeBundle producer (the
//! binary-vs-dialogue surface split + the speaker-identity oracle). Reads
//! Sweetie HD from `ITOTORI_REAL_GAME_ROOT` and exercises two scenes:
//! - **Scene 1** — system/boundary: every Textout run is embedded binary
//!   data, so the producer must surface ZERO translatable units and return
//!   `NoTextUnits` (surfacing e.g. the 214-byte op[72] block would let
//!   patchback corrupt the scene).
//! - **Scene 1018** — a 100%-clean dialogue scene (real `module_sel` Choice
//!   options included): the producer must surface exactly the readable
//!   Shift-JIS Textout runs + choice options, with a `reallive.kidoku` span
//!   and NAMAE-resolved speakers whose identity is cross-checked against
//!   Gameexe. Env-gated + STRICT: an absent corpus is a HARD FAILURE. This
//!   `#[ignore]`-d suite runs only in the periodic oracle
//!   (`just real-bytes-oracle`), where the corpus is staged.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::PathBuf;

use kaifuu_core::RedactedContentSummary;
use kaifuu_reallive::{
    BridgeOpts, BridgeProduceError, REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, RealLiveOpcode,
    SceneHeader, decode_dialogue_textout, decompress_avg32, deterministic_speaker_id,
    gameexe::parse_gameexe_inventory, parse_archive, parse_real_bytecode, produce_bundle,
    scene_bundle_namespace,
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
        real_corpus::require_real_bytes(
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
        .filter(|raw| decode_dialogue_textout(raw).is_some())
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
        decode_dialogue_textout(block_214).is_none(),
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
        "expected NoTextUnits for all-binary scene 1"
    );
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var"]
fn dialogue_scene_surfaces_readable_sjis_textouts_as_translatable_units_real_bytes() {
    let Some(seen_path) = real_seen_txt_path() else {
        real_corpus::require_real_bytes(
            "dialogue_scene_surfaces_readable_sjis_textouts_as_translatable_units_real_bytes",
        );
        return;
    };
    let seen_bytes = fs::read(&seen_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", seen_path.display()));

    let scene = scene_bytecode(&seen_bytes, DIALOGUE_SCENE_ID);

    // A staged corpus MUST carry a readable Gameexe.ini. Silently defaulting
    // to an empty inventory here (the prior `unwrap_or_default`) let a
    // staged-but-unreadable corpus skip every speaker assertion behind
    // `if namae_entries > 0` — a green-on-broken hole. Read it or fail loud.
    let gameexe_path =
        real_gameexe_ini_path().expect("staged Sweetie HD corpus must carry a Gameexe.ini");
    let gameexe_bytes = fs::read(&gameexe_path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", gameexe_path.display()));
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
    // Sweetie HD's Gameexe.ini declares exactly 11 `#NAMAE` speaker rows
    // (including the `？？？／<name>` censored rows). Pin it so an empty /
    // truncated inventory can never masquerade as "no speakers to check".
    assert_eq!(
        namae_entries, 11,
        "Sweetie HD Gameexe.ini must expose its 11 real #NAMAE rows; got {namae_entries}"
    );

    let opts = bridge_opts(scene.header.kidoku_count);
    let produced = produce_bundle(
        DIALOGUE_SCENE_ID,
        &scene.scene_blob,
        &scene.decompressed,
        &gameexe_inventory,
        &opts,
    )
    .expect("v0.2 bundle must build from a dialogue scene");

    assert_eq!(produced.bundle.schema_version, "0.2.0");

    // The surface-selection split means only Textout runs that decode as
    // Shift-JIS are surfaced; binary catch-all runs are excluded. The
    // no-false-negative guarantee is that EVERY readable run is surfaced.
    let opcodes = parse_real_bytecode(&scene.decompressed).expect("bytecode must decode");
    let readable_textout_count = opcodes
        .iter()
        .filter(|op| match op {
            RealLiveOpcode::Textout { raw_bytes, .. } => {
                decode_dialogue_textout(raw_bytes).is_some()
            }
            _ => false,
        })
        .count();
    let binary_textout_count = opcodes
        .iter()
        .filter(|op| match op {
            RealLiveOpcode::Textout { raw_bytes, .. } => {
                decode_dialogue_textout(raw_bytes).is_none()
            }
            _ => false,
        })
        .count();
    let choice_unit_count: usize = opcodes
        .iter()
        .filter_map(|op| match op {
            // Only choice options that decode as readable Shift-JIS become
            // translatable units; non-dialogue options (empty slots, rlBabel
            // `###PRINT(<expr>)` interpolations) are excluded by the same gate.
            RealLiveOpcode::Choice { choices } => Some(
                choices
                    .iter()
                    .filter(|c| decode_dialogue_textout(&c.bytes).is_some())
                    .count(),
            ),
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
        "first unit: sourceText={} surfaceKind={}",
        RedactedContentSummary::from_text(&first_unit.source_text),
        first_unit.surface_kind,
    );

    let units_array = produced.json["units"]
        .as_array()
        .expect("units must be an array");
    let mut kidoku_span_count = 0usize;
    let mut emitted_parsed_names: std::collections::BTreeSet<String> =
        std::collections::BTreeSet::new();

    {
        let state_of = |unit: &serde_json::Value| {
            unit["speaker"]["knowledgeState"]
                .as_str()
                .unwrap_or("")
                .to_string()
        };
        let count_state = |state: &str| {
            units_array
                .iter()
                .filter(|unit| state_of(unit) == state)
                .count()
        };
        let known = count_state("known");
        let reader_unknown = count_state("reader_unknown");
        let parser_unknown = count_state("parser_unknown");
        let not_applicable = count_state("not_applicable");
        eprintln!(
            "speaker knowledge states on real bytes: known={known} reader_unknown={reader_unknown} parser_unknown={parser_unknown} not_applicable={not_applicable}"
        );

        // EXACT, honestly re-measured Sweetie HD scene 1018 outcome (the prior
        // "known=100" claim was inflated by the removed fabrication paths).
        // Pinning the vector makes a 1-true/103-false producer FAIL.
        assert_eq!(
            produced.bundle.units.len(),
            104,
            "scene 1018 must surface exactly 104 translatable units"
        );
        assert_eq!(
            known, 25,
            "scene 1018 must resolve exactly 25 `known` speakers"
        );
        assert_eq!(reader_unknown, 0, "scene 1018 has no censored speakers");
        assert_eq!(
            parser_unknown, 0,
            "no genuinely-unresolved speaker remains on scene 1018"
        );
        assert_eq!(
            known + reader_unknown + parser_unknown + not_applicable,
            104,
            "every unit must carry exactly one knowledge state"
        );

        // Independently re-resolve every Gameexe `#NAMAE` row (display key ->
        // box-shown name) WITHOUT the bridge's own resolver, so the oracle
        // checks each identity against the REAL row + DETERMINISTIC id.
        let namae_rows: std::collections::BTreeMap<String, String> = gameexe_inventory
            .entries
            .iter()
            .filter(|entry| {
                matches!(
                    entry.family,
                    kaifuu_reallive::gameexe::GameexeKeyFamily::Namae
                )
            })
            .filter_map(|entry| real_corpus::namae_display_and_box(&entry.value))
            .collect();
        let namespace = scene_bundle_namespace(
            SWEETIE_HD_GAME_ID,
            SWEETIE_HD_SOURCE_PROFILE_ID,
            DIALOGUE_SCENE_ID,
        );

        // Full-identity cross-check: EACH resolved identity must (a) come from
        // this line's OWN `【…】` token, (b) resolve to a REAL Gameexe row, (c)
        // carry that row's `displayName`/`readerLabel`, and (d) carry the
        // `speakerId` DERIVED from its canonical ref. Fabricated name / forged
        // id / substring / carry-forward each fail one of these.
        let mut cross_checked = 0usize;
        for unit in units_array {
            let state = state_of(unit);
            let source_text = unit["sourceText"].as_str().unwrap_or("");
            let inline_token = real_corpus::extract_inline_name_token(source_text);
            let speaker = &unit["speaker"];
            if state == "known" || state == "reader_unknown" {
                let token = inline_token.unwrap_or_else(|| {
                    panic!(
                        "a resolved speaker must carry its own inline 【…】 token; \
                         unit sourceText {} had none",
                        RedactedContentSummary::from_text(source_text)
                    )
                });
                // (b) token must be a REAL Gameexe display key.
                let box_name = namae_rows.get(&token).unwrap_or_else(|| {
                    panic!("resolved token {token:?} is not a real Gameexe #NAMAE display key")
                });
                // (a) canonical ref is this line's own display key.
                let canonical = speaker["canonicalNameRef"].as_str().unwrap_or("");
                assert_eq!(
                    canonical,
                    format!("reallive:namae:{token}"),
                    "resolved identity must equal this line's own inline display key"
                );
                // (c) displayName is the Gameexe display key, NOT a fabrication.
                assert_eq!(
                    speaker["displayName"].as_str(),
                    Some(token.as_str()),
                    "displayName must be the Gameexe display key, not a fabricated name; got {speaker}"
                );
                // (d) speakerId is the DETERMINISTIC id (same production helper).
                let expected_speaker_id = deterministic_speaker_id(&namespace, canonical);
                assert_eq!(
                    speaker["speakerId"].as_str(),
                    Some(expected_speaker_id.as_str()),
                    "speakerId must be the deterministic id derived from the canonical ref; got {speaker}"
                );
                // Reveal state must match the REAL row: revealed iff box == key.
                let reveal = speaker["revealState"].as_str();
                if *box_name == token {
                    assert_eq!(state, "known", "a revealed Gameexe row must be `known`");
                    assert_eq!(reveal, Some("revealed"));
                } else {
                    assert_eq!(
                        state, "reader_unknown",
                        "a censored Gameexe row (display != box) must be `reader_unknown`"
                    );
                    assert_eq!(reveal, Some("concealed"));
                    assert_eq!(
                        speaker["readerLabel"].as_str(),
                        Some(box_name.as_str()),
                        "readerLabel must be the Gameexe box-shown mask; got {speaker}"
                    );
                }
                cross_checked += 1;
            } else if state == "not_applicable" {
                assert!(
                    inline_token.is_none(),
                    "a not_applicable (narration) line must not carry an unresolved 【…】 token; \
                     sourceText {}",
                    RedactedContentSummary::from_text(source_text)
                );
                assert!(
                    speaker.get("displayName").is_none(),
                    "a not_applicable speaker must not fabricate a displayName"
                );
            }
        }
        assert_eq!(
            cross_checked,
            known + reader_unknown,
            "every resolved speaker must have been cross-checked against its inline token"
        );
    }

    for unit in units_array {
        for span in unit["spans"]
            .as_array()
            .map_or(&[][..], std::vec::Vec::as_slice)
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
