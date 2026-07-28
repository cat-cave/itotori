/// SCENE-TRANSITION FIDELITY (`utsushi-scene-transition-fidelity`).
///
/// The play-loop must advance ACROSS scene boundaries via the real RealLive
/// scene-dispatch — so the game plays THROUGH multiple consecutive scenes
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

