//! Real-bytes acceptance for `utsushi-reallive-jump-resume`.
//!
//! Proves the RealLive runtime jumps / resumes to a decode-resolved
//! `(scene, frame)` target DETERMINISTICALLY on REAL game bytes, so a reviewer
//! can jump to a spot and annotate it reproducibly:
//!
//!  1. **Target from the decode, not hardcoded.** The jump target's scene is
//!     discovered from the store (the game's own `#SEEN_START` entry scene, or
//!     the first decode scene that renders messages), and the frame index is
//!     derived from that scene's OWN deterministic play-order stream — no
//!     literal scene/line/frame ref appears in this test.
//!  2. **Lands on the expected frame.** `jump_to(Frame{scene, k})` lands with
//!     `landed_line == observe_for_port(scene).play_order_lines[k]` — the exact
//!     message the deterministic play-order stream renders at that frame.
//!  3. **Deterministic across runs.** Two jumps to the same target return
//!     byte-identical landings (scene, pc, control fingerprint, line).
//!  4. **Engine-general.** The SAME code exercises Sweetie HD (compiler
//!     `110002`, `use_xor_2`) and Kanon (compiler `1.2.6`, plaintext) — no
//!     per-game branch. Kanon's headless-gated title flow may render no
//!     reachable frame; the test documents that and still proves the SAME
//!     jump/resume code lands deterministically on Kanon's entry scene.
//!
//! Env-gated + STRICT: an absent corpus is an unconditional HARD FAILURE (no
//! opt-out; runs only in the periodic ground-truth oracle,
//! `just real-bytes-oracle`). Run with
//! `ITOTORI_REAL_GAME_ROOT=<sweetie> ITOTORI_REAL_GAME_ROOT_2=<kanon>
//! cargo test -p utsushi-reallive --test jump_resume_real_bytes -- --ignored`.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;

use kaifuu_reallive::{Xor2DecScene, recover_and_decrypt_archive};
use utsushi_reallive::{
    JumpError, JumpTarget, ReplayEngine, ReplayOpts, build_scene_store_from_decompressed,
    decompress_all_scenes,
};

const FULL_BUDGET: u32 = 500_000;
/// Cheaper budget for SELECTING a renderable scene (only needs to observe that
/// a scene reaches >= 2 play-order frames). The chosen scene's authoritative
/// reference is then recomputed at [`FULL_BUDGET`].
const PROBE_BUDGET: u32 = 60_000;

/// Build a [`ReplayEngine`] from a Seen.txt envelope, staging the dev-only
/// `use_xor_2` recovery (no-op for plaintext titles such as Kanon). Mirrors the
/// `full_module_replay_real_bytes` staging so the jump/resume path exercises
/// the SAME real multi-scene store the rest of the suite proves.
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

/// Discover the scene the jump target roots at (never a literal): probe the
/// game's `#SEEN_START` entry scene first, then every scene id, at the cheap
/// [`PROBE_BUDGET`], and return the FIRST that renders >= 2 play-order frames.
/// The play-order is `observe_for_port` (branch-following, else linear
/// catalogue) — the SAME stream the jump's frame drive resolves against.
fn discover_renderable_scene(engine: &ReplayEngine, entry_scene: Option<u16>) -> Option<u16> {
    let probe = ReplayOpts {
        step_budget: PROBE_BUDGET,
        stop_at_first_pause: false,
    };
    entry_scene
        .into_iter()
        .chain(engine.scene_ids())
        .find(|scene| {
            engine
                .observe_for_port(*scene, &probe)
                .play_order_lines
                .len()
                >= 2
        })
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT + _2"]
fn jump_resume_lands_on_expected_frame_deterministically() {
    let corpora = real_corpus::corpora();
    if corpora.len() < 2 {
        real_corpus::require_real_bytes("jump_resume_lands_on_expected_frame_deterministically");
        return;
    }
    let opts = ReplayOpts {
        step_budget: FULL_BUDGET,
        stop_at_first_pause: false,
    };

    // At least ONE corpus must prove a real frame landing (the crux). Kanon's
    // headless-gated title flow may render no reachable frame; that is
    // documented, not a pass by omission.
    let mut corpora_with_frame_landing = 0usize;

    for corpus in &corpora {
        let bytes = fs::read(&corpus.seen_txt).expect("read seen.txt");
        let engine = staged_engine(&bytes);
        let entry = corpus.entry_scene();

        let Some(scene) = discover_renderable_scene(&engine, entry) else {
            // Documented: no headless-reachable frame target on this title.
            // Still prove the SAME jump/resume code lands DETERMINISTICALLY on
            // this title's entry scene (a positional seek), so engine-generality
            // is exercised on the real bytes, not skipped.
            let seed = entry.or_else(|| engine.scene_ids().first().copied());
            if let Some(scene) = seed {
                let target = JumpTarget::Scene { scene };
                let a = engine.jump_to(&target, &opts).expect("scene jump lands");
                let b = engine.jump_to(&target, &opts).expect("scene jump lands");
                assert_eq!(a, b, "[{}] scene jump is deterministic", corpus.label);
                assert_eq!(a.pc, 0);
            }
            eprintln!(
                "[{}] documented: no headless-reachable play-order frame (entry {entry:?}); \
                 engine-general jump/resume still lands deterministically on the entry scene",
                corpus.label,
            );
            continue;
        };

        // Authoritative reference at the full budget: the scene's OWN
        // deterministic play-order stream.
        let play_order = engine.observe_for_port(scene, &opts).play_order_lines;
        assert!(
            play_order.len() >= 2,
            "[{}] discovered scene renders >= 2 frames at full budget",
            corpus.label
        );

        // Target the LAST frame — a decode-derived index, never a hardcoded ref.
        let frame_index = play_order.len() - 1;
        let expected = play_order[frame_index].clone();
        let target = JumpTarget::Frame { scene, frame_index };

        // (2) Lands on the EXPECTED frame.
        let landing = engine
            .jump_to(&target, &opts)
            .expect("frame jump lands on real bytes");
        assert_eq!(
            landing.frame_index,
            Some(frame_index),
            "[{}] landed on the requested frame index",
            corpus.label
        );
        assert_eq!(
            landing.landed_line.as_ref(),
            Some(&expected),
            "[{}] jump landed on the expected message (frame {frame_index} of scene {scene})",
            corpus.label
        );

        // (3) Deterministic across runs: a second jump to the same target
        // returns a byte-identical landing (scene, pc, fingerprint, line).
        let again = engine.jump_to(&target, &opts).expect("re-jump lands");
        assert_eq!(
            landing, again,
            "[{}] jumping to the same target lands identically",
            corpus.label
        );

        // A mid-stream frame also lands on its own expected message, proving
        // the frame index (not just the terminus) is honoured.
        let mid = frame_index / 2;
        let mid_landing = engine
            .jump_to(
                &JumpTarget::Frame {
                    scene,
                    frame_index: mid,
                },
                &opts,
            )
            .expect("mid-frame jump lands");
        assert_eq!(mid_landing.landed_line.as_ref(), Some(&play_order[mid]));

        // (Reviewer seam) the annotation address round-trips back to the same
        // landing.
        let address = landing.target.address();
        let reparsed = JumpTarget::from_address(&address).expect("address parses");
        let relanding = engine
            .jump_to(&reparsed, &opts)
            .expect("re-land via address");
        assert_eq!(
            landing, relanding,
            "[{}] address re-land is identical",
            corpus.label
        );

        corpora_with_frame_landing += 1;
        eprintln!(
            "[{}] jump/resume OK: scene {scene}, {} play-order frames, landed frame {frame_index} \
             at (scene {}, pc {}) fp={:016x}; anchor={}",
            corpus.label,
            play_order.len(),
            landing.scene,
            landing.pc,
            landing.control_fingerprint,
            landing.anchor(),
        );
    }

    assert!(
        corpora_with_frame_landing >= 1,
        "at least one real corpus must prove a deterministic frame landing"
    );
}

/// A frame index past the end of the deterministic play-order stream surfaces
/// the typed `FrameNotReached` (naming how far the stream reached), never a
/// silent land-at-zero. Runs on whichever corpus has a renderable scene.
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT + _2"]
fn jump_past_stream_end_surfaces_typed_miss() {
    let corpora = real_corpus::corpora();
    if corpora.len() < 2 {
        real_corpus::require_real_bytes("jump_past_stream_end_surfaces_typed_miss");
        return;
    }
    let opts = ReplayOpts {
        step_budget: FULL_BUDGET,
        stop_at_first_pause: false,
    };
    let mut exercised = 0usize;
    for corpus in &corpora {
        let bytes = fs::read(&corpus.seen_txt).expect("read seen.txt");
        let engine = staged_engine(&bytes);
        let Some(scene) = discover_renderable_scene(&engine, corpus.entry_scene()) else {
            continue;
        };
        let play_order = engine.observe_for_port(scene, &opts).play_order_lines;
        let beyond = play_order.len() + 1_000;
        let err = engine
            .jump_to(
                &JumpTarget::Frame {
                    scene,
                    frame_index: beyond,
                },
                &opts,
            )
            .expect_err("a frame past the stream end must be a typed miss");
        match err {
            JumpError::FrameNotReached {
                scene: s,
                requested,
                available,
            } => {
                assert_eq!(s, scene);
                assert_eq!(requested, beyond);
                assert!(
                    available <= play_order.len(),
                    "[{}] reported available frames within stream length",
                    corpus.label
                );
            }
            other => panic!("[{}] expected FrameNotReached, got {other:?}", corpus.label),
        }
        exercised += 1;
    }
    assert!(
        exercised >= 1,
        "at least one corpus must exercise the past-end typed miss"
    );
}
