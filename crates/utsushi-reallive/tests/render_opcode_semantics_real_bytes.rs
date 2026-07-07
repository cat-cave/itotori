//! Real-bytes acceptance for `utsushi-reallive-render-opcode-semantics`.
//!
//! Proves that the REAL-numbered render family
//! ([`utsushi_reallive::register_render_rlops`]) fires on real game bytes
//! and MUTATES render state — where the pre-existing synthetic-numbered
//! `module_grp`/`module_obj` tables never matched a real opcode, so the
//! background/sprite ops fell through to the catalog `Advance` stub and the
//! terminal graphics stack was EMPTY.
//!
//! Two titles (Sweetie HD + Kanon). Env-gated + STRICT (an absent corpus is
//! a HARD failure); these `#[ignore]`-d suites run in the periodic
//! ground-truth oracle. Run with:
//! `ITOTORI_REAL_GAME_ROOT=<sweetie> ITOTORI_REAL_GAME_ROOT_2=<kanon>
//!  cargo test -p utsushi-reallive --test render_opcode_semantics_real_bytes -- --ignored --nocapture`.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;

use kaifuu_reallive::{Xor2DecScene, recover_and_decrypt_archive};
use utsushi_reallive::{
    GraphicsPlane, ReplayEngine, ReplayOpts, build_scene_store_from_decompressed,
    decompress_all_scenes,
};

const BUDGET: u32 = 500_000;

/// Build a [`ReplayEngine`] from a Seen.txt envelope, staging the dev-only
/// `kaifuu-reallive` `use_xor_2` segment-cipher recovery (a no-op for
/// non-`use_xor_2` titles such as Kanon).
fn staged_engine(seen_bytes: &[u8]) -> ReplayEngine {
    let index_len = utsushi_reallive::RealSceneIndex::parse(seen_bytes)
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
    let (store, shift_jis, _stats) =
        build_scene_store_from_decompressed(&decompressed, index_len).expect("build store");
    ReplayEngine::from_store(store, shift_jis)
}

fn corpora_or_skip(test_name: &str) -> Vec<real_corpus::RealCorpus> {
    let corpora = real_corpus::corpora();
    if corpora.len() < 2 {
        real_corpus::require_real_bytes(test_name);
        return Vec::new();
    }
    corpora
}

/// Pick the scene whose drive leaves the largest graphics-object stack —
/// a real background/sprite scene, as opposed to the all-binary bootstrap.
fn richest_graphics_scene(engine: &ReplayEngine) -> (u16, usize) {
    let opts = ReplayOpts {
        step_budget: BUDGET,
        stop_at_first_pause: false,
    };
    let mut best = (0u16, 0usize);
    for scene_id in engine.scene_ids() {
        let obs = engine.observe_for_port(scene_id, &opts);
        let n = obs.scene.graphics_stack.len();
        if n > best.1 {
            best = (scene_id, n);
        }
    }
    best
}

/// The core proof: on real bytes, the render opcodes now MUTATE render
/// state — the terminal graphics-object stack is non-empty and carries
/// real backgrounds/sprites. (Under the old synthetic numbering every
/// background/sprite op fell through to the catalog `Advance` stub and the
/// stack stayed empty.)
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT + _2"]
fn render_ops_populate_graphics_stack_on_real_bytes() {
    let corpora = corpora_or_skip("render_ops_populate_graphics_stack_on_real_bytes");
    if corpora.is_empty() {
        return;
    }
    for corpus in &corpora {
        let bytes = fs::read(&corpus.seen_txt).expect("read seen.txt");
        let engine = staged_engine(&bytes);
        let (scene, count) = richest_graphics_scene(&engine);
        eprintln!(
            "[{}] richest graphics scene = {scene} with {count} composited objects",
            corpus.label,
        );
        assert!(
            count > 0,
            "[{}] the render family must MUTATE render state on real bytes: every scene left an \
             EMPTY graphics stack (render opcodes not firing / not mutating)",
            corpus.label,
        );

        // Inspect the composited stack: it must carry at least one real
        // background (a DC-plane image on the Background plane) OR a sprite
        // (a Foreground object), each with a non-empty asset key — proof the
        // real load/openBg/objOfFile opcodes ran with real args.
        let opts = ReplayOpts {
            step_budget: BUDGET,
            stop_at_first_pause: false,
        };
        let obs = engine.observe_for_port(scene, &opts);
        let stack = &obs.scene.graphics_stack;
        let has_bg = (0..256)
            .filter_map(|s| stack.get(GraphicsPlane::Background, s))
            .any(|o| matches!(&o.kind, utsushi_reallive::GraphicsObjectKind::Image { image_ref } if !image_ref.asset_key.is_empty()));
        let has_sprite = (0..256)
            .filter_map(|s| stack.get(GraphicsPlane::Foreground, s))
            .count()
            > 0;
        eprintln!(
            "[{}] scene {scene}: background-image={has_bg} foreground-objects={}",
            corpus.label,
            stack.plane_len(GraphicsPlane::Foreground),
        );
        assert!(
            has_bg || has_sprite,
            "[{}] scene {scene}: composited stack carries neither a background image nor a sprite \
             object — render opcodes did not load real assets",
            corpus.label,
        );
    }
}

/// The richest render scene of each title replays with ZERO unknown
/// opcodes (the render family + catalog together cover every real tuple).
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT + _2"]
fn render_scene_replays_with_zero_unknown_opcodes() {
    let corpora = corpora_or_skip("render_scene_replays_with_zero_unknown_opcodes");
    if corpora.is_empty() {
        return;
    }
    let opts = ReplayOpts {
        step_budget: BUDGET,
        stop_at_first_pause: false,
    };
    for corpus in &corpora {
        let bytes = fs::read(&corpus.seen_txt).expect("read seen.txt");
        let engine = staged_engine(&bytes);
        let (scene, _) = richest_graphics_scene(&engine);
        let log = engine.replay_from(scene, &opts);
        let unknown = log.unknown_opcode_keys();
        assert!(
            unknown.is_empty(),
            "[{}] scene {scene} left {} unknown opcodes: {unknown:?}",
            corpus.label,
            unknown.len(),
        );
    }
}
