//! `utsushi-reallive-interactive-input-bridge` — real-bytes capture → replay
//! identity proof.
//!
//! Drives a REAL RealLive entry scene through the runtime with a
//! [`BridgeScheduler`] and proves the three acceptance seams on real bytes:
//!
//! 1. **User / headless input drives the runtime.** A [`BridgeScheduler`]
//!    backed by a [`HeadlessSource`] (auto policy) and by a
//!    [`UserInputSource`] (a browser / dashboard event queue) both drive the
//!    entry scene's advance / choice yields — the runtime consumes the bridge
//!    input in place of the built-in headless auto scheduler.
//! 2. **Deterministic capture.** Every input event the bridge consumes is
//!    recorded to a [`ReplayLog`](utsushi_reallive::ReplayLog) at a strictly
//!    monotonic tick; capturing the same drive twice yields byte-identical
//!    logs.
//! 3. **Replay reproduces the identical playthrough.** Feeding the captured
//!    log into a [`ReplaySource`]-backed [`BridgeScheduler`] reproduces the
//!    IDENTICAL play-order text-line stream and cross-scene dispatch target.
//!
//! Engine-general: nothing here hard-codes a scene id or a game. The entry
//! scene is read from the game's own `#SEEN_START`, and the same drive runs
//! against every staged corpus.
//!
//! Env-gated + STRICT: an absent corpus is an unconditional HARD FAILURE.
//! These `#[ignore]`-d suites run only in the periodic ground-truth oracle
//! (`ITOTORI_REAL_GAME_ROOT=<sweetie> ITOTORI_REAL_GAME_ROOT_2=<kanon>`).

use std::fs;

use utsushi_core::input::InputEvent;
use utsushi_reallive::vm::SceneId;
use utsushi_reallive::{
    BridgeScheduler, HeadlessChoicePolicy, ReplayEngine, ReplayOpts, UserInputQueue,
};

#[path = "support/real_corpus.rs"]
mod real_corpus;

fn opts() -> ReplayOpts {
    ReplayOpts {
        step_budget: 200_000,
        stop_at_first_pause: false,
    }
}

fn corpora_or_skip(test_name: &str) -> Vec<real_corpus::RealCorpus> {
    let corpora = real_corpus::corpora();
    if corpora.is_empty() {
        real_corpus::require_real_bytes(test_name);
    }
    corpora
}

/// The captured commit stream as plain `InputEvent`s (drops the ticks).
fn captured_events(sched: &BridgeScheduler) -> Vec<InputEvent> {
    sched
        .captured_events()
        .iter()
        .map(|(_, event)| event.clone())
        .collect()
}

/// Discover — GAME-AGNOSTICALLY, from the decode — the first scene whose
/// branch-following execution actually gates on real input (a `msg.pause` or a
/// `select` / choice prompt). No scene id is hard-coded; the entry scene is
/// tried first (via `#SEEN_START`), then every scene in id order.
fn first_gating_scene(engine: &ReplayEngine, entry: Option<SceneId>) -> Option<SceneId> {
    let ids: Vec<SceneId> = entry
        .into_iter()
        .chain(
            engine
                .scene_ids()
                .into_iter()
                .filter(|id| Some(*id) != entry),
        )
        .collect();
    for id in ids {
        let mut probe = BridgeScheduler::headless(HeadlessChoicePolicy::AlwaysFirst);
        let _ = engine.branch_following_observation_with_scheduler(id, &opts(), &mut probe);
        if probe.pauses_advanced() + probe.choices_made() > 0 {
            return Some(id);
        }
    }
    None
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT and/or _2"]
fn capture_then_replay_reproduces_identical_real_scene_playthrough() {
    let corpora =
        corpora_or_skip("capture_then_replay_reproduces_identical_real_scene_playthrough");

    // At least one staged corpus must exercise a real input-gated scene, or the
    // proof is vacuous. (A corpus whose decoded subtree reaches no gate under
    // standalone branch-following — e.g. subroutine-only scenes — is skipped.)
    let mut proven = 0usize;

    for corpus in &corpora {
        let bytes = fs::read(&corpus.seen_txt).expect("read seen.txt");
        let engine = ReplayEngine::from_seen_bytes(&bytes).expect("decode seen.txt");

        let Some(scene) = first_gating_scene(&engine, corpus.entry_scene()) else {
            eprintln!(
                "{}: no branch-following-reachable input gate in decoded subset; skipping",
                corpus.label,
            );
            continue;
        };

        // (1) CAPTURE: a headless-backed bridge drives the gating scene; every
        // pause / choice decision is captured deterministically.
        let mut capture = BridgeScheduler::headless(HeadlessChoicePolicy::AlwaysFirst);
        let observed_capture =
            engine.branch_following_observation_with_scheduler(scene, &opts(), &mut capture);
        let log = capture
            .build_log(format!("{}-scene-{scene}", corpus.label))
            .expect("captured log builds");

        // Real input-gating was exercised.
        assert!(
            !log.events().is_empty(),
            "{}: scene {scene} must capture real input-gated yields",
            corpus.label,
        );
        assert!(
            capture.pauses_advanced() + capture.choices_made() > 0,
            "{}: scene {scene} must record at least one pause/choice commit",
            corpus.label,
        );

        // (2) DETERMINISM: capturing the same drive again yields a byte-
        // identical serialized input log.
        let mut capture2 = BridgeScheduler::headless(HeadlessChoicePolicy::AlwaysFirst);
        let _ = engine.branch_following_observation_with_scheduler(scene, &opts(), &mut capture2);
        let log2 = capture2
            .build_log(format!("{}-scene-{scene}", corpus.label))
            .expect("second captured log builds");
        assert_eq!(
            log.to_json_value().expect("log1 json"),
            log2.to_json_value().expect("log2 json"),
            "{}: capturing the same drive twice must yield an identical input log",
            corpus.label,
        );

        // (3) REPLAY: feed the captured log into a replay-backed bridge; the
        // reproduced playthrough is IDENTICAL (same text-line stream + same
        // cross-scene dispatch target).
        let mut replay = BridgeScheduler::replay(&log);
        let observed_replay =
            engine.branch_following_observation_with_scheduler(scene, &opts(), &mut replay);
        assert_eq!(
            observed_capture.lines, observed_replay.lines,
            "{}: replaying the captured input log must reproduce the identical text stream",
            corpus.label,
        );
        assert_eq!(
            observed_capture.first_cross_scene, observed_replay.first_cross_scene,
            "{}: replay must follow the identical cross-scene dispatch",
            corpus.label,
        );

        // (4) USER PATH: the SAME committing events, fed through a browser
        // dashboard event queue, drive the runtime to the identical
        // playthrough — proving the live user-input source reaches the runtime.
        let queue = UserInputQueue::new();
        for event in captured_events(&capture) {
            queue.push(event);
        }
        let mut user = BridgeScheduler::user(queue);
        let observed_user =
            engine.branch_following_observation_with_scheduler(scene, &opts(), &mut user);
        assert_eq!(
            observed_capture.lines, observed_user.lines,
            "{}: a user-input drive with the same events reproduces the identical playthrough",
            corpus.label,
        );

        proven += 1;
    }

    assert!(
        proven > 0,
        "no staged corpus exercised a real input-gated scene; the capture→replay proof was vacuous",
    );
}
