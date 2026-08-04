use super::*;

#[test]
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
        let (scene_id, report) = s.best.clone().unwrap_or_else(|| panic!(
            "[{}] no scene reached a NATURAL terminus (EndOfScene/ReturnedToCaller) with zero-unknown + zero-SceneNotFound + real control transfers; natural_scenes={} aggregate_transfers={} total_unknown_on_executed_paths={}",
            corpus.label, s.natural_scenes, s.aggregate_transfers, s.total_unknown_on_executed_paths,
        ));
        eprintln!(
            "[{}] BRANCH-FOLLOWING natural terminus: scene {scene_id} terminus={:?} steps={} transfers={:?} scenes_visited={} text={} pauses={} choices={}",
            corpus.label,
            report.terminus,
            report.steps,
            report.transfers,
            report.scenes_visited.len(),
            report.text_lines,
            report.pauses_advanced,
            report.choices_made
        );
        eprintln!(
            "[{}] title survey: natural_scenes={} of {} | aggregate_transfers={} | max_scenes_visited={} | zero-unknown-on-ALL-executed-paths={}",
            corpus.label,
            s.natural_scenes,
            engine.scene_ids().len(),
            s.aggregate_transfers,
            s.max_scenes_visited,
            s.total_unknown_on_executed_paths == 0
        );
        // (2) Natural terminus by executing real control flow, zero unknown
        // zero SceneNotFound on the executed path.
        assert!(report.terminus.is_natural());
        assert!(
            report.unknown_opcode_keys.is_empty(),
            "[{}] scene {scene_id} executed path must be ZERO unknown; got {:?}",
            corpus.label,
            report.unknown_opcode_keys
        );
        assert_eq!(report.scene_not_found, None);
        assert!(
            report.transfers.total() > 0,
            "[{}] scene {scene_id} must have EXECUTED real control transfers (branch-following)",
            corpus.label
        );
        // The scene exercised subroutine/return control flow (not just a
        // straight-line advance): at least one call and one return.
        let t = report.transfers;
        assert!(
            t.subroutine_calls + t.far_calls > 0 && t.returns + t.returns_from_call > 0,
            "[{}] scene {scene_id} must execute a call+return pair; transfers={t:?}",
            corpus.label
        );
        // ZERO unknown on EVERY scene's executed path (whole-title).
        assert_eq!(
            s.total_unknown_on_executed_paths, 0,
            "[{}] every branch-following executed path must be ZERO unknown",
            corpus.label
        );
        // (3) Cross-scene Jump/FarCall FOLLOWED across the multi-scene store
        // by at least one scene of this title.
        assert!(
            s.max_scenes_visited > 1,
            "[{}] at least one scene must FOLLOW a cross-scene transfer into another present scene",
            corpus.label
        );
        // (4a) Byte-determinism.
        let again =
            engine.branch_following_report(scene_id, &opts, HeadlessChoicePolicy::AlwaysFirst);
        assert_eq!(
            report, again,
            "[{}] two branch-following runs of scene {scene_id} must be byte-identical",
            corpus.label
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
            corpus.label
        );
        // (5) DISTINCT from the retained linear-walk cataloguing registrar:
        // the same scene under the linear walk reaches EndOfScene with ZERO
        // unknown (coverage check), while branch-following EXECUTED real
        // transfers (> 0) — which a linear walk records none of.
        let linear = engine.replay_from(scene_id, &opts);
        assert!(
            linear.unknown_opcode_keys().is_empty(),
            "[{}] linear-walk coverage check must be zero-unknown on scene {scene_id}",
            corpus.label
        );
        assert!(
            matches!(linear.final_outcome, ReplayOutcome::EndOfScene { .. }),
            "[{}] linear-walk must reach EndOfScene on scene {scene_id} (got {:?})",
            corpus.label,
            linear.final_outcome
        );
        assert!(
            report.transfers.total() > 0,
            "[{}] branch-following must execute transfers the linear walk does not",
            corpus.label
        );
    }
}
