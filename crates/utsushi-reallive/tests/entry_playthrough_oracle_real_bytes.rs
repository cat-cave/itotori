//! Byte-backed entry-path acceptance for the optional second real corpus.
//!
//! This is deliberately env-gated: the corpus is proprietary and is never a
//! repository fixture. When present, it proves every emitted Shift-JIS body
//! occurs in the decoded static byte stream in the same scene/byte order.

#[path = "support/real_corpus.rs"]
mod real_corpus;
#[path = "support/real_g00_package.rs"]
mod real_g00_package;

use std::fs;
use std::sync::Arc;

use kaifuu_reallive::{Xor2DecScene, recover_and_decrypt_archive};
use utsushi_core::substrate::AssetPackage;
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
    let g00_dir = real_corpus::g00_dir_for(real_corpus::SECONDARY)
        .expect("full second-corpus install must provide a g00 directory");
    let assets: Arc<dyn AssetPackage> = Arc::new(real_g00_package::RealG00Package::new(g00_dir));
    let branch_report = engine.branch_following_report_with_assets(
        entry,
        &ReplayOpts {
            step_budget: ENTRY_PATH_BUDGET,
            stop_at_first_pause: false,
        },
        HeadlessChoicePolicy::AlwaysFirst,
        Arc::clone(&assets),
    );
    let playthrough = engine.observe_playthrough_with_assets(
        entry,
        &ReplayOpts {
            step_budget: ENTRY_PATH_BUDGET,
            stop_at_first_pause: false,
        },
        ENTRY_PATH_SCENES,
        assets,
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
    let hydrated_objects: usize = playthrough
        .segments
        .iter()
        .flat_map(|segment| {
            (0..256).filter_map(move |slot| {
                segment
                    .observation
                    .scene
                    .graphics_stack
                    .get_layer(utsushi_reallive::GraphicsLayer::ForegroundObject, slot)
            })
        })
        .filter(|object| object.geometry.surface.is_some())
        .count();
    eprintln!(
        "entry-path oracle: scenes={scene_ids:?} observed_steps={observed_steps} emitted={} static={} overlap={overlap} fallback_lines={fallback_lines} hydrated_objects={hydrated_objects} branch_steps={} branch_text={} object_get_rectangle={:?} containment_rectangles={:?} print_directives={:?} modeled_events={} branch_terminus={:?} transfers={:?}",
        emitted.len(),
        static_lines.len(),
        branch_report.steps,
        branch_report.text_lines,
        branch_report.object_get_rectangle,
        branch_report.containment_rectangles,
        branch_report.print_directives,
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
    assert!(
        hydrated_objects > 0,
        "the detached replay must hydrate object geometry from the real g00 package"
    );
    assert!(
        branch_report
            .containment_rectangles
            .iter()
            .any(|rectangle| {
                rectangle[2].is_some_and(|width| width > 0)
                    && rectangle[3].is_some_and(|height| height > 0)
            }),
        "the real containment check must observe a positive intrinsic image rectangle"
    );
}
