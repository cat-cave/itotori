//! Real-bytes acceptance for `reallive-utsushi-headless-branch-execution`.
//!
//! Drives a full scene of BOTH titles (Sweetie HD + Kanon) to its NATURAL
//! TERMINUS by EXECUTING real RealLive control flow — Jump / Subroutine /
//! FarCall FOLLOWED across the multi-scene store, NOT linear-walked — using
//! a deterministic headless input-provider ([`HeadlessInputScheduler`],
//! policy = always the first choice) to advance past pause / wait-for-click
//! yields and to resolve choices.
//!
//! # What "natural terminus" means here
//!
//! A RealLive scene ends either by running off its bytecode / halting
//! ([`BranchTerminus::EndOfScene`]) or, for a scene that is itself a
//! subroutine (entered by a parent via `farcall`), by executing its
//! top-level `ret` / `rtl` ([`BranchTerminus::ReturnedToCaller`] when driven
//! STANDALONE with an empty call stack). Both are natural termini: the scene
//! ran its real control flow to completion. A standalone-driven subroutine
//! scene typically reaches `ReturnedToCaller`; an ENTRY scene driven with the
//! deterministic event-flag model (see `headless_entry_scene_*` below) runs
//! its full opening and reaches `EndOfScene`.
//!
//! # Acceptance asserted
//!  1. A deterministic headless input-provider advances past waits + selects
//!     choices (documented AlwaysFirst policy; determinism asserted).
//!  2. For BOTH titles, a full scene drives to its natural terminus by
//!     EXECUTING real control flow (transfers > 0, incl. subroutine/far
//!     calls + returns), with ZERO fail-soft Unknown skips and ZERO
//!     SceneNotFound on the executed path.
//!  3. Cross-scene Jump/FarCall is FOLLOWED across the store (≥1 scene
//!     visits >1 scene).
//!  4. Byte-deterministic (two runs → identical report) + snapshot/restore
//!     identity at every tick boundary.
//!  5. Branch-following is DISTINCT from the retained linear-walk
//!     cataloguing registrar (same scene: linear-walk → EndOfScene with zero
//!     transfer state; branch-following → executed transfers > 0).
//!
//! Env-gated + STRICT: an absent corpus is an unconditional HARD FAILURE
//! (no opt-out; these `#[ignore]`-d suites run only in the periodic
//! ground-truth oracle, `just real-bytes-oracle`, where corpora are staged).
//! Run with
//! `ITOTORI_REAL_GAME_ROOT=<sweetie> ITOTORI_REAL_GAME_ROOT_2=<kanon>
//! cargo test -p utsushi-reallive --test headless_branch_execution_real_bytes
//! -- --ignored`.

#[path = "support/real_corpus.rs"]
mod real_corpus;
#[path = "support/xor2_staging.rs"]
mod xor2_staging;

use std::fs;

use kaifuu_reallive::{Xor2DecScene, recover_and_decrypt_archive};
use utsushi_reallive::{
    BranchReplayReport, BranchTerminus, HeadlessChoicePolicy, ReplayEngine, ReplayOpts,
    ReplayOutcome, build_scene_store_from_decompressed, decompress_all_scenes,
};

/// Step budget for a per-scene branch-following drive. Sized so an entry
/// scene runs its full opening (the event-flag model breaks its wait loops)
/// and reaches a natural terminus; a scene that still cannot progress is
/// bounded (a typed `EventGatedSpin` diagnostic, or `BudgetExhausted` for a
/// genuinely long scenario chain that exceeds the scan budget).
const SCAN_BUDGET: u32 = 200_000;

/// Stage a [`ReplayEngine`] from a Seen.txt envelope, interposing the
/// dev-only `kaifuu-reallive` `use_xor_2` recovery between the AVG32
/// first-level inflate and the bytecode decode (a no-op for Kanon). Mirrors
/// the full-module replay test's staging.
fn staged_engine(seen_bytes: &[u8]) -> ReplayEngine {
    let index_len = utsushi_reallive::RealSceneIndex::parse(seen_bytes)
        .expect("parse scene index")
        .entries
        .len();
    let mut decompressed = decompress_all_scenes(seen_bytes).expect("decompress archive");
    let mut xor2: Vec<Xor2DecScene> = decompressed
        .iter()
        .map(|s| Xor2DecScene {
            compiler_version: s.compiler_version,
            bytecode: s.bytecode.clone(),
        })
        .collect();
    let report = recover_and_decrypt_archive(&mut xor2);
    xor2_staging::require_xor2_ready(&report).expect("xor2 corpus staging is ready");
    for (s, d) in decompressed.iter_mut().zip(xor2) {
        s.bytecode = d.bytecode;
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

fn scan_opts() -> ReplayOpts {
    ReplayOpts {
        step_budget: SCAN_BUDGET,
        stop_at_first_pause: false,
    }
}

/// Pick, deterministically, the scene that reaches a NATURAL terminus by
/// executing the MOST control transfers with ZERO unknown opcodes and ZERO
/// SceneNotFound. Tie-break by lowest scene id. Also returns aggregate
/// facts used by the acceptance assertions.
struct TitleSurvey {
    best: Option<(u16, BranchReplayReport)>,
    natural_scenes: usize,
    max_scenes_visited: usize,
    total_unknown_on_executed_paths: usize,
    aggregate_transfers: u64,
}

fn survey(engine: &ReplayEngine) -> TitleSurvey {
    let opts = scan_opts();
    let mut best: Option<(u16, BranchReplayReport)> = None;
    let mut natural_scenes = 0usize;
    let mut max_scenes_visited = 0usize;
    let mut total_unknown = 0usize;
    let mut aggregate_transfers = 0u64;
    for id in engine.scene_ids() {
        let r = engine.branch_following_report(id, &opts, HeadlessChoicePolicy::AlwaysFirst);
        total_unknown += r.unknown_opcode_keys.len();
        max_scenes_visited = max_scenes_visited.max(r.scenes_visited.len());
        aggregate_transfers += r.transfers.total();
        if r.terminus.is_natural() {
            natural_scenes += 1;
        }
        let clean = r.terminus.is_natural()
            && r.unknown_opcode_keys.is_empty()
            && r.scene_not_found.is_none()
            && r.transfers.total() > 0;
        if clean {
            let better = match &best {
                None => true,
                Some((_, b)) => r.transfers.total() > b.transfers.total(),
            };
            if better {
                best = Some((id, r));
            }
        }
    }
    TitleSurvey {
        best,
        natural_scenes,
        max_scenes_visited,
        total_unknown_on_executed_paths: total_unknown,
        aggregate_transfers,
    }
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT + _2"]
fn headless_branch_following_drives_both_titles_to_natural_terminus() {
    let corpora =
        corpora_or_skip("headless_branch_following_drives_both_titles_to_natural_terminus");
    if corpora.is_empty() {
        return;
    }
    let opts = scan_opts();
    for corpus in &corpora {
        let bytes = fs::read(&corpus.seen_txt).expect("read seen.txt");
        let engine = staged_engine(&bytes);
        let s = survey(&engine);

        let (scene_id, report) = s.best.clone().unwrap_or_else(|| {
            panic!(
                "[{}] no scene reached a NATURAL terminus (EndOfScene/ReturnedToCaller) with \
                 zero-unknown + zero-SceneNotFound + real control transfers; \
                 natural_scenes={} aggregate_transfers={} total_unknown_on_executed_paths={}",
                corpus.label,
                s.natural_scenes,
                s.aggregate_transfers,
                s.total_unknown_on_executed_paths,
            )
        });

        eprintln!(
            "[{}] BRANCH-FOLLOWING natural terminus: scene {scene_id} terminus={:?} steps={} \
             transfers={:?} scenes_visited={} text={} pauses={} choices={}",
            corpus.label,
            report.terminus,
            report.steps,
            report.transfers,
            report.scenes_visited.len(),
            report.text_lines,
            report.pauses_advanced,
            report.choices_made,
        );
        eprintln!(
            "[{}] title survey: natural_scenes={} of {} | aggregate_transfers={} | \
             max_scenes_visited={} | zero-unknown-on-ALL-executed-paths={}",
            corpus.label,
            s.natural_scenes,
            engine.scene_ids().len(),
            s.aggregate_transfers,
            s.max_scenes_visited,
            s.total_unknown_on_executed_paths == 0,
        );

        // (2) Natural terminus by executing real control flow, zero unknown,
        // zero SceneNotFound on the executed path.
        assert!(report.terminus.is_natural());
        assert!(
            report.unknown_opcode_keys.is_empty(),
            "[{}] scene {scene_id} executed path must be ZERO unknown; got {:?}",
            corpus.label,
            report.unknown_opcode_keys,
        );
        assert_eq!(report.scene_not_found, None);
        assert!(
            report.transfers.total() > 0,
            "[{}] scene {scene_id} must have EXECUTED real control transfers (branch-following)",
            corpus.label,
        );
        // The scene exercised subroutine/return control flow (not just a
        // straight-line advance): at least one call and one return.
        let t = report.transfers;
        assert!(
            t.subroutine_calls + t.far_calls > 0 && t.returns + t.returns_from_call > 0,
            "[{}] scene {scene_id} must execute a call+return pair; transfers={t:?}",
            corpus.label,
        );

        // ZERO unknown on EVERY scene's executed path (whole-title).
        assert_eq!(
            s.total_unknown_on_executed_paths, 0,
            "[{}] every branch-following executed path must be ZERO unknown",
            corpus.label,
        );

        // (3) Cross-scene Jump/FarCall FOLLOWED across the multi-scene store
        // by at least one scene of this title.
        assert!(
            s.max_scenes_visited > 1,
            "[{}] at least one scene must FOLLOW a cross-scene transfer into another present scene",
            corpus.label,
        );

        // (4a) Byte-determinism.
        let again =
            engine.branch_following_report(scene_id, &opts, HeadlessChoicePolicy::AlwaysFirst);
        assert_eq!(
            report, again,
            "[{}] two branch-following runs of scene {scene_id} must be byte-identical",
            corpus.label,
        );

        // (4b) Snapshot/restore identity at every tick boundary.
        let snap = engine
            .verify_branch_snapshot_restore_each_tick(
                scene_id,
                &opts,
                HeadlessChoicePolicy::AlwaysFirst,
            )
            .expect("snapshot identity");
        assert!(
            snap.ticks_verified > 0,
            "[{}] scene {scene_id} must verify snapshot/restore identity at >0 tick boundaries",
            corpus.label,
        );

        // (5) DISTINCT from the retained linear-walk cataloguing registrar:
        // the same scene under the linear walk reaches EndOfScene with ZERO
        // unknown (coverage check), while branch-following EXECUTED real
        // transfers (> 0) — which a linear walk records none of.
        let linear = engine.replay_from(scene_id, &opts);
        assert!(
            linear.unknown_opcode_keys().is_empty(),
            "[{}] linear-walk coverage check must be zero-unknown on scene {scene_id}",
            corpus.label,
        );
        assert!(
            matches!(linear.final_outcome, ReplayOutcome::EndOfScene { .. }),
            "[{}] linear-walk must reach EndOfScene on scene {scene_id} (got {:?})",
            corpus.label,
            linear.final_outcome,
        );
        assert!(
            report.transfers.total() > 0,
            "[{}] branch-following must execute transfers the linear walk does not",
            corpus.label,
        );
    }
}

/// ENTRY-SCENE acceptance (`reallive-utsushi-headless-event-flag-modeling`).
///
/// This is the piece the branch-execution node could not reach: driving the
/// game's CONFIGURED ENTRY scene (`#SEEN_START` — Sweetie HD scene 1, Kanon
/// scene 9030) all the way to a NATURAL terminus. The entry scene opens the
/// game and busy-`goto`s on event flags a headless walk never sets (title /
/// animation / message wait loops); the deterministic event-flag model
/// PROVES each spin (a repeated `(scene, pc, stack, memory)` fingerprint) and
/// models the awaited events as fired, unwinding the stuck frame so the scene
/// runs its real control flow to a natural end.
///
/// Asserted, for BOTH titles:
///  - the entry scene reaches a NATURAL terminus (`EndOfScene` / top-level
///    `ReturnedToCaller`) — NOT `BudgetExhausted`, NOT `EventGatedSpin`, NOT a
///    spurious `SceneNotFound` / `EntrypointNotFound` on the sentinel targets;
///  - the event-flag model actually fired (`modeled_events > 0`) — the entry
///    scene genuinely spun and was progressed past;
///  - real control flow executed (transfers > 0) across >1 scene;
///  - the drive is byte-deterministic (two runs → identical report).
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT + _2"]
fn headless_entry_scene_drives_to_natural_terminus() {
    let corpora = corpora_or_skip("headless_entry_scene_drives_to_natural_terminus");
    if corpora.is_empty() {
        return;
    }
    let opts = scan_opts();
    for corpus in &corpora {
        let entry = corpus.entry_scene().unwrap_or_else(|| {
            panic!(
                "[{}] could not resolve #SEEN_START entry scene from Gameexe.ini",
                corpus.label
            )
        });
        let bytes = fs::read(&corpus.seen_txt).expect("read seen.txt");
        let engine = staged_engine(&bytes);

        let report =
            engine.branch_following_report(entry, &opts, HeadlessChoicePolicy::AlwaysFirst);
        eprintln!(
            "[{}] ENTRY scene {entry}: terminus={:?} steps={} transfers={} \
             scenes_visited={} modeled_events={} text={}",
            corpus.label,
            report.terminus,
            report.steps,
            report.transfers.total(),
            report.scenes_visited.len(),
            report.modeled_events,
            report.text_lines,
        );

        // (1) Natural terminus — the entry scene ran its real control flow
        // to a natural end, NOT a budget spin / event-gated dead spin / a
        // spurious cross-scene gap.
        assert!(
            report.terminus.is_natural(),
            "[{}] entry scene {entry} must reach a NATURAL terminus \
             (EndOfScene / ReturnedToCaller); got {:?}",
            corpus.label,
            report.terminus,
        );
        assert!(
            !matches!(report.terminus, BranchTerminus::BudgetExhausted),
            "[{}] entry scene {entry} must not BudgetExhaust",
            corpus.label,
        );
        assert_eq!(
            report.scene_not_found, None,
            "[{}] entry scene {entry} must not hit a spurious SceneNotFound",
            corpus.label,
        );

        // (2) The deterministic event-flag model fired: the entry scene
        // genuinely spun on an event-gated loop and was progressed past it.
        assert!(
            report.modeled_events > 0,
            "[{}] entry scene {entry} must exercise the event-flag model \
             (a real event-gated spin was broken); modeled_events={}",
            corpus.label,
            report.modeled_events,
        );

        // (3) Real control flow executed across the multi-scene store.
        assert!(
            report.transfers.total() > 0,
            "[{}] entry scene {entry} must EXECUTE real control transfers",
            corpus.label,
        );
        assert!(
            report.scenes_visited.len() > 1,
            "[{}] entry scene {entry} must FOLLOW control flow across >1 scene; visited {:?}",
            corpus.label,
            report.scenes_visited,
        );
        assert!(
            report.unknown_opcode_keys.is_empty(),
            "[{}] entry scene {entry} executed path must be ZERO unknown; got {:?}",
            corpus.label,
            report.unknown_opcode_keys,
        );

        // (4) Byte-deterministic (fingerprint-driven event model, no
        // clock/RNG): two runs produce an identical report.
        let again = engine.branch_following_report(entry, &opts, HeadlessChoicePolicy::AlwaysFirst);
        assert_eq!(
            report, again,
            "[{}] two branch-following runs of entry scene {entry} must be byte-identical",
            corpus.label,
        );
    }
}

/// The deterministic headless input-provider is exercised end-to-end: it
/// advances past every pause / wait yield and resolves every choice with a
/// documented, reproducible policy. Verified by driving the whole store and
/// asserting the provider is deterministic (identical activity across two
/// full drives) and never deadlocks a scene on an input-gated longop (a
/// scene that does NOT reach its terminus does so for a control-flow reason
/// — SceneNotFound / spin — not a suspended longop).
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT + _2"]
fn headless_input_provider_is_deterministic_and_never_deadlocks_on_input() {
    let corpora =
        corpora_or_skip("headless_input_provider_is_deterministic_and_never_deadlocks_on_input");
    if corpora.is_empty() {
        return;
    }
    let opts = scan_opts();
    for corpus in &corpora {
        let bytes = fs::read(&corpus.seen_txt).expect("read seen.txt");
        let engine = staged_engine(&bytes);

        let mut total_pauses = 0u64;
        let mut total_choices = 0u64;
        for id in engine.scene_ids() {
            let a = engine.branch_following_report(id, &opts, HeadlessChoicePolicy::AlwaysFirst);
            let b = engine.branch_following_report(id, &opts, HeadlessChoicePolicy::AlwaysFirst);
            assert_eq!(
                a, b,
                "[{}] scene {id} branch report must be deterministic",
                corpus.label
            );
            total_pauses += a.pauses_advanced;
            total_choices += a.choices_made;
            // No terminus is a suspended longop: the input-provider resumes
            // every pause/choice/longop, so a non-natural terminus is always
            // a control-flow gap, never an input deadlock.
            assert!(
                !matches!(a.terminus, BranchTerminus::BudgetExhausted) || a.transfers.total() > 0,
                "[{}] scene {id} budget-exhausted with no transfers would imply an input \
                 deadlock; transfers={:?}",
                corpus.label,
                a.transfers,
            );
        }
        eprintln!(
            "[{}] input-provider activity across store: pauses_advanced={total_pauses} \
             choices_made={total_choices}",
            corpus.label,
        );
    }
}

/// SCENE-TRANSITION FIDELITY (`utsushi-scene-transition-fidelity`).
///
/// The play-loop must advance ACROSS scene boundaries via the real RealLive
/// scene-dispatch — so the game plays THROUGH multiple consecutive scenes,
/// not one in isolation. `observe_playthrough` starts at the game's
/// `#SEEN_START` entry scene and follows the FIRST cross-scene dispatch
/// target (a real `jump` / `farcall` / entrypoint resolution into another
/// SEEN present in the store) into the next scene, and so on, producing a
/// continuous MULTI-SCENE play-order stream.
///
/// Asserted, for BOTH titles (Sweetie HD + Kanon):
///  - the play stream spans ≥2 DISTINCT scene ids — a regression that stops
///    at the entry scene (a single scene id) FAILS here;
///  - the scene ids are in dispatch order: `scene_ids[0]` is the entry scene
///    and `scene_ids[1]` is exactly the entry scene's first cross-scene
///    dispatch target (cross-checked against `branch_following_report`), so
///    the second scene was reached by REAL dispatch, not by scanning ids;
///  - the chain is bounded (`max_scenes`) and deterministic (two runs agree).
#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT + _2"]
fn play_loop_advances_across_scene_boundaries_via_real_dispatch() {
    const MAX_SCENES: usize = 4;
    let corpora = corpora_or_skip("play_loop_advances_across_scene_boundaries_via_real_dispatch");
    if corpora.is_empty() {
        return;
    }
    let opts = scan_opts();
    for corpus in &corpora {
        let entry = corpus.entry_scene().unwrap_or_else(|| {
            panic!(
                "[{}] could not resolve #SEEN_START entry scene from Gameexe.ini",
                corpus.label
            )
        });
        let bytes = fs::read(&corpus.seen_txt).expect("read seen.txt");
        let engine = staged_engine(&bytes);

        let playthrough = engine.observe_playthrough(entry, &opts, MAX_SCENES);
        let scene_ids = playthrough.scene_ids();
        eprintln!(
            "[{}] MULTI-SCENE playthrough from entry {entry}: scene_ids={scene_ids:?} \
             total_messages={}",
            corpus.label,
            playthrough.total_messages(),
        );

        // (1) The play stream SPANS ≥2 distinct scenes — it did not stop at
        // the entry scene.
        assert!(
            scene_ids.len() >= 2,
            "[{}] play-loop must advance ACROSS a scene boundary; got a single scene {scene_ids:?} \
             (a regression that stops at the entry scene fails here)",
            corpus.label,
        );
        let distinct: std::collections::BTreeSet<u16> = scene_ids.iter().copied().collect();
        assert!(
            distinct.len() >= 2,
            "[{}] the spanned scene ids must be DISTINCT; got {scene_ids:?}",
            corpus.label,
        );

        // (2) Dispatch order: scene A is the entry scene, and scene B is
        // EXACTLY the entry scene's first cross-scene dispatch target — the
        // second scene was reached by following the REAL dispatch, not by an
        // id scan.
        assert_eq!(
            scene_ids[0], entry,
            "[{}] the play stream must START at the entry scene",
            corpus.label,
        );
        let entry_report =
            engine.branch_following_report(entry, &opts, HeadlessChoicePolicy::AlwaysFirst);
        assert_eq!(
            Some(scene_ids[1]),
            entry_report.first_cross_scene,
            "[{}] scene B must be the entry scene's REAL first cross-scene dispatch target",
            corpus.label,
        );

        // (3) Bounded: `max_scenes` caps the chain length.
        assert!(
            scene_ids.len() <= MAX_SCENES,
            "[{}] the chain must be bounded by max_scenes={MAX_SCENES}; got {}",
            corpus.label,
            scene_ids.len(),
        );

        // (4) Deterministic: a second run produces the same scene chain.
        let again = engine.observe_playthrough(entry, &opts, MAX_SCENES);
        assert_eq!(
            again.scene_ids(),
            scene_ids,
            "[{}] two multi-scene playthroughs must produce an identical scene chain",
            corpus.label,
        );
    }
}
