//! Control-markup (kidoku / name) protected-span round-trip, on REAL bytes.
//! Every real RealLive dialogue Textout carries a `<reallive.kidoku N>`
//! read-flag control marker (Sweetie HD scene 1017: 129/129 units) and often
//! an inline `【話者】` speaker name marker. The producer surfaces
//! the kidoku read-flag as a SYNTHETIC readable marker prepended to
//! `sourceText`, but that marker has NO byte run inside the Textout body — the
//! read-flag lives in a separate `MetaKidoku` opcode / the scene-header kidoku
//! table. The translation prompt reproduces every protected span inline, so a
//! unit's `target.text` carries the `<reallive.kidoku N>` literal. Before this
//! fix the patchback spliced that literal into the Textout body and the retail
//! lexer truncated the run at `<reallive.kidoku ` — no translated text was
//! ever observed.
//! This test proves the fix end-to-end on TWO independently-authored RealLive
//! corpora (Sweetie HD via `ITOTORI_REAL_GAME_ROOT`, Kanon via
//! `ITOTORI_REAL_GAME_ROOT_2`):
//! - a dialogue unit whose `target.text` carries the reproduced
//!   `<reallive.kidoku N>` marker (+ the `【話者】` name marker where the game
//!   uses one) round-trips: the translated English body is spliced and
//!   observed in the patched bytecode;
//! - the `<reallive.kidoku ` literal never reaches the patched bytecode;
//! - the kidoku control bytes (`MetaKidoku` opcode marks) are byte-identical
//!   between source and patched;
//! - the name marker's Shift-JIS bytes are byte-identical (re-emitted as the
//!   leading body bytes), where the game carries one;
//! - the patched scene re-decompiles with ZERO unknown opcodes.
//!   Env-gated + STRICT BY DEFAULT (see `support/real_corpus.rs`).

#[path = "support/real_corpus.rs"]
mod real_corpus;

/// A distinct English line spliced into the chosen unit, used to assert the
/// translated dialogue is observed in the patched bytecode.
const DISTINCT: &str = "[EN] kidoku roundtrip proof line";

use std::fs;

use kaifuu_core::RedactedContentSummary;
use kaifuu_reallive::{
    BridgeOpts, PatchbackOpts, REALLIVE_OUT_OF_BAND_MARKER_OPEN, RealLiveOpcode, SceneHeader,
    TranslatedBundleV02, TranslationScope, Xor2Cipher, Xor2DecScene, apply_translated_bundle,
    compiler_version_uses_xor2, decompress_avg32, encode_shift_jis_slot,
    gameexe::parse_gameexe_inventory, parse_archive, parse_real_bytecode,
    parse_real_bytecode_spans, produce_bundle, recover_archive_cipher,
};

/// Recover the validated per-game `xor_2` cipher across the whole archive.
/// `None` when the archive carries no `use_xor_2` scenes (e.g. Kanon).
fn recover_cipher(seen: &[u8]) -> Option<Xor2Cipher> {
    let index = parse_archive(seen).ok()?;
    let mut scenes: Vec<Xor2DecScene> = Vec::with_capacity(index.entries.len());
    for entry in &index.entries {
        let blob = &seen
            [entry.byte_offset as usize..(entry.byte_offset + u64::from(entry.byte_len)) as usize];
        let Ok(header) = SceneHeader::parse(blob) else {
            continue;
        };
        let (bo, bc, bu) = (
            header.bytecode_offset as usize,
            header.bytecode_compressed_size as usize,
            header.bytecode_uncompressed_size as usize,
        );
        if bo + bc > blob.len() {
            continue;
        }
        let Ok(d) = decompress_avg32(&blob[bo..bo + bc], bu) else {
            continue;
        };
        scenes.push(Xor2DecScene {
            compiler_version: header.compiler_version,
            bytecode: d,
        });
    }
    recover_archive_cipher(&scenes).ok()
}

/// `(scene_blob, decompressed_plaintext_bytecode, header)` for a scene id.
fn scene_plaintext(
    seen: &[u8],
    scene_id: u16,
    cipher: Option<&Xor2Cipher>,
) -> Option<(Vec<u8>, Vec<u8>, SceneHeader)> {
    let index = parse_archive(seen).ok()?;
    let entry = index.entries.iter().find(|e| e.scene_id == scene_id)?;
    let blob = seen
        [entry.byte_offset as usize..(entry.byte_offset + u64::from(entry.byte_len)) as usize]
        .to_vec();
    let header = SceneHeader::parse(&blob).ok()?;
    let (bo, bc, bu) = (
        header.bytecode_offset as usize,
        header.bytecode_compressed_size as usize,
        header.bytecode_uncompressed_size as usize,
    );
    if bo + bc > blob.len() {
        return None;
    }
    let mut d = decompress_avg32(&blob[bo..bo + bc], bu).ok()?;
    if compiler_version_uses_xor2(header.compiler_version) {
        cipher?.apply_segment(&mut d);
    }
    Some((blob, d, header))
}

/// The sequence of `MetaKidoku` marks in a decompressed bytecode stream — the
/// kidoku (read-flag) control bytes the patchback must carry byte-identical.
fn kidoku_marks(decompressed: &[u8]) -> Vec<u16> {
    parse_real_bytecode(decompressed)
        .map(|ops| {
            ops.iter()
                .filter_map(|op| match op {
                    RealLiveOpcode::MetaKidoku { mark } => Some(*mark),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn bridge_opts(scene_kidoku_count: u32) -> BridgeOpts<'static> {
    BridgeOpts {
        game_id: "kidoku-roundtrip-test",
        game_version: "1.0.0",
        source_profile_id: "kaifuu-reallive-kidoku-roundtrip-test",
        source_locale: "ja-JP",
        extractor_name: "kaifuu-reallive-bridge",
        extractor_version: "0.1.0",
        scene_kidoku_count,
    }
}

/// A chosen target: the scene + occurrence of a dialogue unit that carries a
/// kidoku span, its reproduced kidoku marker literal, and (where present) its
/// name-token marker literal.
struct ChosenUnit {
    scene_id: u16,
    occurrence: usize,
    kidoku_marker: String,
    name_marker: Option<String>,
}

/// Scan a corpus for a dialogue unit that carries a `reallive.kidoku` span,
/// preferring one that ALSO carries a `reallive.name_token` span. Tries the
/// preferred scene id first, then walks the archive in slot order.
fn choose_unit(
    seen: &[u8],
    gameexe_inventory: &kaifuu_reallive::gameexe::GameexeInventoryReport,
    cipher: Option<&Xor2Cipher>,
    preferred: u16,
) -> Option<ChosenUnit> {
    let index = parse_archive(seen).ok()?;
    let scene_ids: Vec<u16> = std::iter::once(preferred)
        .chain(index.entries.iter().map(|e| e.scene_id))
        .collect();
    // Two passes: first insist on a name-bearing unit, then accept kidoku-only.
    for require_name in [true, false] {
        for &sid in &scene_ids {
            let Some((blob, decompressed, header)) = scene_plaintext(seen, sid, cipher) else {
                continue;
            };
            let opts = bridge_opts(header.kidoku_count);
            let Ok(produced) = produce_bundle(sid, &blob, &decompressed, gameexe_inventory, &opts)
            else {
                continue;
            };
            for (occ, unit) in produced.json["units"].as_array()?.iter().enumerate() {
                if unit["surfaceKind"] != "dialogue" {
                    continue;
                }
                let spans = unit["spans"].as_array()?;
                let kidoku = spans
                    .iter()
                    .find(|s| s["parsedName"] == "reallive.kidoku")
                    .and_then(|s| s["raw"].as_str());
                let name = spans
                    .iter()
                    .find(|s| s["parsedName"] == "reallive.name_token")
                    .and_then(|s| s["raw"].as_str());
                let Some(kidoku) = kidoku else { continue };
                if require_name && name.is_none() {
                    continue;
                }
                return Some(ChosenUnit {
                    scene_id: sid,
                    occurrence: occ,
                    kidoku_marker: kidoku.to_string(),
                    name_marker: name.map(str::to_string),
                });
            }
        }
    }
    None
}

/// Run the control-markup round-trip on one corpus and assert the acceptance
/// criteria. `preferred_scene` is tried first (Sweetie HD 1017, Kanon 50).
fn run_corpus(corpus: &real_corpus::RealCorpus, preferred_scene: u16) {
    let seen = fs::read(&corpus.seen_txt)
        .unwrap_or_else(|e| panic!("[{}] read {}: {e}", corpus.label, corpus.seen_txt.display()));
    let gameexe_bytes = real_corpus_gameexe(corpus).unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);
    let cipher = recover_cipher(&seen);

    let chosen = choose_unit(&seen, &gameexe_inventory, cipher.as_ref(), preferred_scene)
        .unwrap_or_else(|| {
            panic!(
                "[{}] no dialogue unit with a reallive.kidoku span found",
                corpus.label
            )
        });
    let scene_id = chosen.scene_id;

    let (scene_blob, source_decompressed, header) =
        scene_plaintext(&seen, scene_id, cipher.as_ref())
            .unwrap_or_else(|| panic!("[{}] scene {scene_id} must resolve", corpus.label));
    let source_marks = kidoku_marks(&source_decompressed);
    assert!(
        !source_marks.is_empty(),
        "[{}] scene {scene_id} must carry MetaKidoku opcodes",
        corpus.label
    );

    let opts = bridge_opts(header.kidoku_count);
    let produced = produce_bundle(
        scene_id,
        &scene_blob,
        &source_decompressed,
        &gameexe_inventory,
        &opts,
    )
    .unwrap_or_else(|e| panic!("[{}] produce_bundle scene {scene_id}: {e}", corpus.label));

    // The translated body the (fixed) bridge hands the patchback: the model
    // reproduces the protected spans inline, so the target STILL carries the
    // synthetic `<reallive.kidoku N>` marker (+ the `【話者】` name marker where
    // present). The patchback must strip the out-of-band kidoku marker, keep
    // the in-body name marker, and splice the translated English.
    let name = chosen.name_marker.clone().unwrap_or_default();
    let target_for_unit = format!("{}{name}「{DISTINCT}」", chosen.kidoku_marker);
    // The exact Shift-JIS body the patchback must splice (name marker re-emitted
    // byte-identical as the leading bytes, then the bracket-wrapped English).
    let expected_body = format!("{name}「{DISTINCT}」");
    let expected_body_sjis =
        encode_shift_jis_slot(&expected_body).expect("expected body encodes as Shift-JIS");

    // Assign targets: a benign English sentinel everywhere (no kidoku, no name),
    // and the distinct control-markup-bearing target on the chosen unit.
    let mut translated_value = produced.json.clone();
    {
        let units = translated_value["units"]
            .as_array_mut()
            .expect("units array");
        for (occ, unit) in units.iter_mut().enumerate() {
            let text = if occ == chosen.occurrence {
                target_for_unit.clone()
            } else {
                "「[EN] filler」".to_string()
            };
            unit["target"] = serde_json::json!({"locale": "en-US", "text": text});
        }
    }
    let translated =
        TranslatedBundleV02::from_json(&translated_value).expect("translated bundle parses");

    let patched = apply_translated_bundle(
        &seen,
        &translated,
        &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
    )
    .unwrap_or_else(|e| {
        panic!(
            "[{}] apply_translated_bundle scene {scene_id}: {e}",
            corpus.label
        )
    });

    // Re-parse + decrypt the patched scene to the plaintext layer.
    let (_, patched_decompressed, patched_header) =
        scene_plaintext(&patched, scene_id, cipher.as_ref())
            .unwrap_or_else(|| panic!("[{}] patched scene {scene_id} must re-parse", corpus.label));
    assert_eq!(
        patched_header.compiler_version, header.compiler_version,
        "[{}] compiler version preserved",
        corpus.label
    );

    let patched_ops = parse_real_bytecode(&patched_decompressed)
        .unwrap_or_else(|e| panic!("[{}] patched scene must re-decompile: {e}", corpus.label));
    let unknown = patched_ops
        .iter()
        .filter(|o| matches!(o, RealLiveOpcode::Unknown { .. }))
        .count();
    assert_eq!(
        unknown, 0,
        "[{}] scene {scene_id}: patched decompile must be 0-unknown",
        corpus.label
    );
    parse_real_bytecode_spans(&patched_decompressed).unwrap_or_else(|e| {
        panic!(
            "[{}] patched framing must partition exactly: {e}",
            corpus.label
        )
    });

    let marker = REALLIVE_OUT_OF_BAND_MARKER_OPEN.as_bytes();
    assert!(
        !patched_decompressed
            .windows(marker.len())
            .any(|w| w == marker),
        "[{}] the out-of-band `<reallive.kidoku ` literal must NOT appear in patched bytecode",
        corpus.label
    );

    let patched_marks = kidoku_marks(&patched_decompressed);
    assert_eq!(
        patched_marks,
        source_marks,
        "[{}] scene {scene_id}: MetaKidoku read-flag marks must be byte-identical \
         ({} marks source vs {} patched)",
        corpus.label,
        source_marks.len(),
        patched_marks.len()
    );

    // as the leading body bytes, English prose after it). ----
    assert!(
        patched_decompressed
            .windows(expected_body_sjis.len())
            .any(|w| w == expected_body_sjis.as_slice()),
        "[{}] scene {scene_id}: the translated body (name marker + English) must be \
         spliced byte-identical into the patched bytecode",
        corpus.label
    );
    // And the English text itself is observed at the plaintext layer.
    let english_sjis = encode_shift_jis_slot(DISTINCT).expect("English encodes");
    assert!(
        patched_decompressed
            .windows(english_sjis.len())
            .any(|w| w == english_sjis.as_slice()),
        "[{}] the translated English line must be observed in the patched bytecode",
        corpus.label
    );

    // Where a name marker is present, assert its exact Shift-JIS bytes survive.
    if let Some(name_marker) = &chosen.name_marker {
        let name_sjis = encode_shift_jis_slot(name_marker).expect("name marker encodes");
        assert!(
            patched_decompressed
                .windows(name_sjis.len())
                .any(|w| w == name_sjis.as_slice()),
            "[{}] scene {scene_id}: name-token bytes {} must survive byte-identical",
            corpus.label,
            RedactedContentSummary::from_text(name_marker)
        );
    }

    let name_marker = chosen
        .name_marker
        .as_deref()
        .map(RedactedContentSummary::from_text)
        .map_or_else(|| "none".to_string(), |summary| summary.to_string());

    eprintln!(
        "[{}] scene {scene_id} occ {}: control-markup round-trip OK — {} MetaKidoku marks \
         byte-identical, name_marker={name_marker}, English observed, 0-unknown",
        corpus.label,
        chosen.occurrence,
        source_marks.len(),
    );
}

/// Locate a corpus's `Gameexe.ini` (modern `REALLIVEDATA/` layout or a
/// case-insensitive root-level file, for the flat Kanon layout).
fn real_corpus_gameexe(corpus: &real_corpus::RealCorpus) -> Option<Vec<u8>> {
    let candidates = [
        corpus.root.join("REALLIVEDATA").join("Gameexe.ini"),
        corpus.root.join("Gameexe.ini"),
        corpus.root.join("GAMEEXE.INI"),
    ];
    candidates.iter().find_map(|p| fs::read(p).ok())
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (Sweetie HD) + ITOTORI_REAL_GAME_ROOT_2 (Kanon)"]
fn kidoku_and_name_control_markup_round_trips_on_two_reallive_titles() {
    let corpora = real_corpus::corpora();
    if corpora.is_empty() {
        real_corpus::require_real_bytes(
            "kidoku_and_name_control_markup_round_trips_on_two_reallive_titles",
        );
        return;
    }
    // Multi-game law: the control-markup round-trip must validate against >=2
    // independently-authored RealLive corpora.
    assert!(
        corpora.len() >= 2,
        "control-markup round-trip requires >=2 RealLive corpora (set \
         ITOTORI_REAL_GAME_ROOT + ITOTORI_REAL_GAME_ROOT_2); got {}",
        corpora.len()
    );
    // Preferred documented scenes: Sweetie HD 1017 (kidoku + `【和人】` name),
    // Kanon 50 (kidoku, no inline name marker). `choose_unit` falls back to a
    // scan if a preferred scene does not qualify, so the test stays robust to a
    // differently-staged corpus pair.
    let preferred = [1017u16, 50u16];
    for (i, corpus) in corpora.iter().enumerate() {
        run_corpus(corpus, preferred.get(i).copied().unwrap_or(1));
    }
}
