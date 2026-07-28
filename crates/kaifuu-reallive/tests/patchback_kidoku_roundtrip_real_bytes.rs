//! Control-markup (kidoku / name) round-trip on two real corpora.
//! A read flag lives in `MetaKidoku`, outside a Textout body, while a name
//! token lives in a body when authored. A writable dialogue carrier therefore
//! proves marker stripping plus name/body preservation; a prose-free corpus
//! proves its genuine control carrier survives a byte-identical no-op patch.

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

struct ChosenUnit {
    scene_id: u16,
    occurrence: usize,
    kidoku_marker: String,
    name_marker: Option<String>,
}

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

/// Find a genuine `MetaKidoku` carrier when no writable text carrier exists.
fn choose_control_scene(seen: &[u8], cipher: Option<&Xor2Cipher>, preferred: u16) -> Option<u16> {
    let index = parse_archive(seen).ok()?;
    std::iter::once(preferred)
        .chain(index.entries.iter().map(|entry| entry.scene_id))
        .find(|&scene_id| {
            scene_plaintext(seen, scene_id, cipher)
                .is_some_and(|(_, bytecode, _)| !kidoku_marks(&bytecode).is_empty())
        })
}

/// Run one corpus. A previous writable bundle supplies a schema-valid empty
/// translation to the no-prose branch; with no targets, patchback must carry
/// this corpus's archive and its control carrier byte-identically.
fn run_corpus(
    corpus: &real_corpus::RealCorpus,
    preferred_scene: u16,
    no_op_template: Option<&serde_json::Value>,
) -> Option<serde_json::Value> {
    let seen = fs::read(&corpus.seen_txt)
        .unwrap_or_else(|e| panic!("[{}] read {}: {e}", corpus.label, corpus.seen_txt.display()));
    let gameexe_bytes = real_corpus_gameexe(corpus).unwrap_or_default();
    let gameexe_inventory = parse_gameexe_inventory(&gameexe_bytes);
    let cipher = recover_cipher(&seen);

    let chosen = choose_unit(&seen, &gameexe_inventory, cipher.as_ref(), preferred_scene);
    let scene_id = chosen.as_ref().map_or_else(
        || {
            choose_control_scene(&seen, cipher.as_ref(), preferred_scene)
                .unwrap_or_else(|| panic!("[{}] no MetaKidoku control carrier found", corpus.label))
        },
        |unit| unit.scene_id,
    );

    let (scene_blob, source_decompressed, header) =
        scene_plaintext(&seen, scene_id, cipher.as_ref())
            .unwrap_or_else(|| panic!("[{}] scene {scene_id} must resolve", corpus.label));
    let source_marks = kidoku_marks(&source_decompressed);
    assert!(
        !source_marks.is_empty(),
        "[{}] scene {scene_id} must carry MetaKidoku opcodes",
        corpus.label
    );

    let translated_value = if let Some(chosen) = &chosen {
        let produced = produce_bundle(
            scene_id,
            &scene_blob,
            &source_decompressed,
            &gameexe_inventory,
            &bridge_opts(header.kidoku_count),
        )
        .unwrap_or_else(|e| panic!("[{}] produce_bundle scene {scene_id}: {e}", corpus.label));
        let mut value = produced.json;
        for (occ, unit) in value["units"]
            .as_array_mut()
            .expect("units array")
            .iter_mut()
            .enumerate()
        {
            let name = chosen.name_marker.clone().unwrap_or_default();
            let text = if occ == chosen.occurrence {
                format!("{}{name}「{DISTINCT}」", chosen.kidoku_marker)
            } else {
                "「[EN] filler」".to_string()
            };
            unit["target"] = serde_json::json!({"locale": "en-US", "text": text});
        }
        value
    } else {
        let mut value = no_op_template.cloned().unwrap_or_else(|| {
            panic!(
                "[{}] no writable carrier available for empty translation",
                corpus.label
            )
        });
        value["units"] = serde_json::json!([]);
        value
    };
    let returned_template = chosen.as_ref().map(|_| translated_value.clone());
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

    if let Some(chosen) = chosen {
        let name = chosen.name_marker.clone().unwrap_or_default();
        let expected_body = encode_shift_jis_slot(&format!("{name}「{DISTINCT}」"))
            .expect("expected body encodes as Shift-JIS");
        assert!(
            patched_decompressed
                .windows(expected_body.len())
                .any(|w| w == expected_body.as_slice()),
            "[{}] scene {scene_id}: translated body must be spliced byte-identical",
            corpus.label,
        );
        let english = encode_shift_jis_slot(DISTINCT).expect("English encodes");
        assert!(
            patched_decompressed
                .windows(english.len())
                .any(|w| w == english.as_slice()),
            "[{}] translated English must be observed in patched bytecode",
            corpus.label
        );
        if let Some(name_marker) = &chosen.name_marker {
            let name = encode_shift_jis_slot(name_marker).expect("name marker encodes");
            assert!(
                patched_decompressed
                    .windows(name.len())
                    .any(|w| w == name.as_slice()),
                "[{}] scene {scene_id}: name-token bytes {} must survive byte-identical",
                corpus.label,
                RedactedContentSummary::from_text(name_marker)
            );
        }
        eprintln!(
            "[{}] scene {scene_id} occ {}: text carrier OK — {} MetaKidoku marks byte-identical, English observed, 0-unknown",
            corpus.label,
            chosen.occurrence,
            source_marks.len(),
        );
    } else {
        assert_eq!(
            patched, seen,
            "[{}] no writable prose carrier: no-op patch must retain every archive byte",
            corpus.label
        );
        eprintln!(
            "[{}] scene {scene_id}: control carrier OK — {} MetaKidoku marks and archive byte-identical, 0-unknown",
            corpus.label,
            source_marks.len(),
        );
    }
    returned_template
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
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (primary_corpus HD) + ITOTORI_REAL_GAME_ROOT_2 (Kanon)"]
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
    let preferred = [1017u16, 50u16];
    let mut no_op_template = None;
    for (i, corpus) in corpora.iter().enumerate() {
        if let Some(template) = run_corpus(
            corpus,
            preferred.get(i).copied().unwrap_or(1),
            no_op_template.as_ref(),
        ) {
            no_op_template = Some(template);
        }
    }
}
