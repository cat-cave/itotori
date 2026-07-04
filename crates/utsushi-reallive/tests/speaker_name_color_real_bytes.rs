//! Real-bytes acceptance for the Sweetie HD speaker name-box + per-speaker
//! text-colour decode fix
//! (`investigate-sweetie-name-box-speaker-decode-gap`).
//!
//! The defect: Sweetie HD shows speaker name boxes + per-speaker dialogue
//! text colours in-game, but the decode extracted ZERO speakers — the
//! `Textout` → `TextLine` path never parsed the inline full-width
//! lenticular `【…】` name prefix (the `#NAMAE` lookup key), and the
//! `#NAMAE` middle field was mislabelled as a voice slot rather than a
//! `#COLOR_TABLE` row index.
//!
//! This test drives the REAL Sweetie HD scenes with the `#NAMAE` +
//! `#COLOR_TABLE` resolver installed and asserts:
//!
//!   * NAMED lines now resolve a non-empty `TextLine.speaker` (count > 0,
//!     was 0), with the resolved `TextLine.color`.
//!   * The two documented speakers resolve to the right colour
//!     (`和人` → pale `(204,204,255)`, `真理子` → pink `(255,153,204)`).
//!   * A resolved line's `【…】` prefix is STRIPPED from the emitted body.
//!   * Narration (no leading `【`) gets NO speaker.
//!   * 0 unknown opcodes are PRESERVED: replaying a scene WITH vs WITHOUT
//!     the resolver yields an identical unknown-opcode count (the `【…】`
//!     parse operates on an already-decoded `Textout` body and cannot
//!     perturb opcode recognition).
//!
//! Env-gated + STRICT-BY-DEFAULT. Run with
//! `ITOTORI_REAL_GAME_ROOT=<sweetie-hd>
//! cargo test -p utsushi-reallive --test speaker_name_color_real_bytes -- --ignored`.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;

use kaifuu_reallive::{Xor2DecScene, recover_and_decrypt_archive};
use utsushi_reallive::{
    Gameexe, RealSceneIndex, ReplayEngine, ReplayOpts, build_scene_store_from_decompressed,
    decompress_all_scenes,
};

const SCAN_BUDGET: u32 = 20_000;
/// Cap on scenes scanned so the test stays well under the CI-only slow
/// branch-following budget while still crossing many named lines.
const MAX_SCENES: usize = 120;

/// Build a [`ReplayEngine`] over the staged (xor2-recovered) store.
fn staged_store(seen_bytes: &[u8]) -> (ReplayEngine, ReplayEngine) {
    let index_len = RealSceneIndex::parse(seen_bytes)
        .expect("parse scene index")
        .entries
        .len();
    let mut decompressed = decompress_all_scenes(seen_bytes).expect("decompress archive");
    let mut xor2: Vec<Xor2DecScene> = decompressed
        .iter()
        .map(|scene| Xor2DecScene {
            compiler_version: scene.compiler_version,
            bytecode: scene.bytecode.clone(),
        })
        .collect();
    let _ = recover_and_decrypt_archive(&mut xor2);
    for (scene, dec) in decompressed.iter_mut().zip(xor2) {
        scene.bytecode = dec.bytecode;
    }
    let (store, shift_jis, _) =
        build_scene_store_from_decompressed(&decompressed, index_len).expect("build store");
    // Two independent engines over the same store: one plain, one with the
    // resolver, so the 0-unknown-preserved comparison is clean.
    let (store2, shift_jis2, _) =
        build_scene_store_from_decompressed(&decompressed, index_len).expect("build store");
    (
        ReplayEngine::from_store(store, shift_jis),
        ReplayEngine::from_store(store2, shift_jis2),
    )
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var (Sweetie HD)"]
fn sweetie_named_lines_resolve_speaker_and_color_narration_none_zero_unknown_preserved() {
    let Some(corpus) = real_corpus::corpus_1() else {
        real_corpus::require_real_bytes(
            "utsushi-reallive sweetie_named_lines_resolve_speaker_and_color",
        );
        return;
    };
    let gameexe: Gameexe = corpus
        .gameexe()
        .expect("Sweetie HD Gameexe.ini must parse for #NAMAE + #COLOR_TABLE");
    let resolver = gameexe.namae_resolver();
    assert!(
        !resolver.is_empty(),
        "Sweetie HD #NAMAE table resolved zero speakers — resolver build regression"
    );
    // Spot-assert the two documented mappings straight off the resolver.
    assert_eq!(
        resolver.resolve("和人").map(|s| s.color),
        Some([204, 204, 255]),
        "和人 → #NAMAE (1,016,-1) → #COLOR_TABLE.016 = (204,204,255) pale"
    );
    assert_eq!(
        resolver.resolve("真理子").map(|s| s.color),
        Some([255, 153, 204]),
        "真理子 → #NAMAE (1,014,-1) → #COLOR_TABLE.014 = (255,153,204) pink"
    );

    let seen_bytes = fs::read(&corpus.seen_txt).expect("read Seen.txt");
    let (plain_engine, engine) = staged_store(&seen_bytes);
    let engine = engine.with_namae_resolver(resolver);

    let opts = ReplayOpts {
        step_budget: SCAN_BUDGET,
        stop_at_first_pause: false,
    };

    let mut named_lines = 0usize;
    let mut narration_lines = 0usize;
    let mut prefix_leak = 0usize;
    let mut saw_kazuto_pale = false;
    let mut saw_mariko_pink = false;
    let mut speaker_bearing_scene: Option<u16> = None;

    for scene in engine.scene_ids().into_iter().take(MAX_SCENES) {
        let observation = engine.observe_for_port(scene, &opts);
        for line in &observation.play_order_lines {
            if let Some(name) = &line.speaker {
                named_lines += 1;
                if speaker_bearing_scene.is_none() {
                    speaker_bearing_scene = Some(scene);
                }
                // A resolved speaker means the 【…】 prefix was consumed —
                // the emitted body must not still open with the lenticular
                // bracket.
                if line.text.starts_with('【') {
                    prefix_leak += 1;
                }
                if name == "和人" && line.color == Some([204, 204, 255]) {
                    saw_kazuto_pale = true;
                }
                if name == "真理子" && line.color == Some([255, 153, 204]) {
                    saw_mariko_pink = true;
                }
            } else {
                narration_lines += 1;
                // Narration must not carry a colour either.
                assert_eq!(
                    line.color, None,
                    "a speaker-less narration line must have no text colour"
                );
            }
        }
    }

    eprintln!(
        "[speaker-fix real-bytes] named_lines={named_lines} narration_lines={narration_lines} \
         prefix_leak={prefix_leak} kazuto_pale={saw_kazuto_pale} mariko_pink={saw_mariko_pink} \
         scanned_scenes<= {MAX_SCENES}"
    );

    assert!(
        named_lines > 0,
        "decode must now extract a non-zero speaker count (was 0)"
    );
    assert_eq!(
        prefix_leak, 0,
        "every resolved line must have its 【…】 prefix stripped from the body"
    );
    assert!(
        saw_kazuto_pale || saw_mariko_pink,
        "at least one documented speaker (和人 pale / 真理子 pink) must appear with its colour"
    );

    // 0 unknown opcodes PRESERVED: WITH vs WITHOUT the resolver, a
    // speaker-bearing scene replays to the identical unknown-opcode count
    // (and no fatal). The 【…】 parse is on already-decoded Textout bytes,
    // so it cannot change opcode recognition.
    let probe_scene = speaker_bearing_scene.expect("a speaker-bearing scene was observed");
    let with = engine.replay_from(probe_scene, &opts);
    let without = plain_engine.replay_from(probe_scene, &opts);
    eprintln!(
        "[speaker-fix real-bytes] scene {probe_scene}: unknown_with={} unknown_without={} \
         text_with={} text_without={}",
        with.unknown_opcode_count(),
        without.unknown_opcode_count(),
        with.text_line_count(),
        without.text_line_count(),
    );
    assert_eq!(
        with.unknown_opcode_count(),
        without.unknown_opcode_count(),
        "installing the speaker resolver must PRESERVE the unknown-opcode count"
    );
}
