//! Byte-backed entry-path acceptance for the optional second real corpus.
//!
//! This is deliberately env-gated: the corpus is proprietary and is never a
//! repository fixture. When present, it proves every emitted Shift-JIS body
//! occurs in the decoded static byte stream in the same scene/byte order.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;

use kaifuu_reallive::{Xor2DecScene, recover_and_decrypt_archive};
use utsushi_reallive::{
    BytecodeElement, HeadlessChoicePolicy, PlayOrderSource, RealSceneIndex, ReplayEngine,
    ReplayOpts, TextoutEncoding, build_scene_store_from_decompressed, decode_bytecode_stream,
    decompress_all_scenes,
};

const ENTRY_PATH_SCENES: usize = 4;
const ENTRY_PATH_BUDGET: u32 = 200_000;

fn staged_engine_and_bytes(
    bytes: &[u8],
) -> (ReplayEngine, Vec<utsushi_reallive::DecompressedScene>) {
    let index_len = RealSceneIndex::parse(bytes)
        .expect("parse real scene index")
        .entries
        .len();
    let mut decompressed = decompress_all_scenes(bytes).expect("decompress real archive");
    let mut xor2: Vec<Xor2DecScene> = decompressed
        .iter()
        .map(|scene| Xor2DecScene {
            compiler_version: scene.compiler_version,
            bytecode: scene.bytecode.clone(),
        })
        .collect();
    let _ = recover_and_decrypt_archive(&mut xor2);
    for (scene, recovered) in decompressed.iter_mut().zip(xor2) {
        scene.bytecode = recovered.bytecode;
    }
    let (store, shift_jis, _stats) =
        build_scene_store_from_decompressed(&decompressed, index_len).expect("build scene store");
    (ReplayEngine::from_store(store, shift_jis), decompressed)
}

/// Flatten the source `Textout` elements for exactly the scenes the executed
/// entry path visits. This is an independent byte walk: it does not use the
/// VM's emitted lines or its text sink.
fn static_textout_sequence(
    decompressed: &[utsushi_reallive::DecompressedScene],
    scene_ids: &[u16],
) -> Vec<(u16, usize, Vec<u8>)> {
    scene_ids
        .iter()
        .flat_map(|scene_id| {
            let scene = decompressed
                .iter()
                .find(|scene| scene.scene_id == *scene_id)
                .unwrap_or_else(|| {
                    panic!("executed scene {scene_id} is absent from decoded archive")
                });
            decode_bytecode_stream(&scene.bytecode)
                .expect("decode executed scene bytecode")
                .into_iter()
                .filter_map(|element| match element {
                    BytecodeElement::Textout {
                        byte_offset,
                        encoding_hint: TextoutEncoding::ShiftJis,
                        raw_bytes,
                        ..
                    } => Some((*scene_id, byte_offset, raw_bytes)),
                    _ => None,
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

#[test]
#[ignore = "requires ITOTORI_REAL_GAME_ROOT_2 with the optional real corpus"]
fn entry_playthrough_emits_an_ordered_subset_of_static_text_bytes() {
    let Some(corpus) = real_corpus::corpus_2() else {
        eprintln!(
            "SKIP entry playthrough oracle: ITOTORI_REAL_GAME_ROOT_2 is unset or does not name a readable corpus."
        );
        return;
    };
    let entry = corpus
        .entry_scene()
        .expect("real corpus Gameexe.ini must declare #SEEN_START");
    let bytes = fs::read(&corpus.seen_txt).expect("read real Seen.txt");
    let (engine, decompressed) = staged_engine_and_bytes(&bytes);
    let branch_report = engine.branch_following_report(
        entry,
        &ReplayOpts {
            step_budget: ENTRY_PATH_BUDGET,
            stop_at_first_pause: false,
        },
        HeadlessChoicePolicy::AlwaysFirst,
    );
    let playthrough = engine.observe_playthrough(
        entry,
        &ReplayOpts {
            step_budget: ENTRY_PATH_BUDGET,
            stop_at_first_pause: false,
        },
        ENTRY_PATH_SCENES,
    );
    let scene_ids: Vec<u16> = playthrough
        .segments
        .iter()
        .map(|segment| segment.scene_id)
        .collect();
    let static_lines = static_textout_sequence(&decompressed, &scene_ids);
    let emitted: Vec<(u16, usize, Vec<u8>)> = playthrough
        .segments
        .iter()
        .flat_map(|segment| {
            segment
                .observation
                .play_order_lines
                .iter()
                .map(move |line| {
                    (
                        segment.scene_id,
                        line.byte_offset_in_scene
                            .expect("play-order text must retain its source byte offset")
                            as usize,
                        line.body_shift_jis
                            .clone()
                            .expect("play-order text must retain its source Shift-JIS bytes"),
                    )
                })
        })
        .collect();
    let mut static_cursor = 0usize;
    let mut overlap = 0usize;
    for line in &emitted {
        while static_cursor < static_lines.len() && static_lines[static_cursor] != *line {
            static_cursor += 1;
        }
        if static_cursor < static_lines.len() {
            overlap += 1;
            static_cursor += 1;
        }
    }
    let observed_steps: u32 = playthrough
        .segments
        .iter()
        .map(|segment| segment.observation.scene.steps)
        .sum();
    let fallback_lines: usize = playthrough
        .segments
        .iter()
        .filter(|segment| segment.observation.play_order_source == PlayOrderSource::LinearCatalogue)
        .map(|segment| segment.observation.play_order_lines.len())
        .sum();
    eprintln!(
        "entry-path oracle: scenes={scene_ids:?} observed_steps={observed_steps} emitted={} static={} overlap={overlap} fallback_lines={fallback_lines} branch_steps={} branch_text={} modeled_events={} branch_terminus={:?} transfers={:?}",
        emitted.len(),
        static_lines.len(),
        branch_report.steps,
        branch_report.text_lines,
        branch_report.modeled_events,
        branch_report.terminus,
        branch_report.transfers,
    );
    assert!(
        !emitted.is_empty(),
        "entry path must emit at least one text line"
    );
    assert_eq!(
        overlap,
        emitted.len(),
        "every emitted line must occur in static byte order"
    );
}
