//! Synthetic acceptance for the real branch-FOLLOWING control-flow
//! execution (`reallive-utsushi-headless-branch-execution`).
//!
//! Builds a hand-laid two-scene store and drives it through
//! [`ReplayEngine::branch_following_report`], asserting the VM EXECUTES
//! real control flow — intra-scene `goto`, `gosub`/`ret`, and a
//! cross-scene `farcall`/`rtl` (with entrypoint resolution) — rather than
//! linear-walking. The counterpart real-bytes proof lives in
//! `headless_branch_execution_real_bytes.rs`.

use std::collections::HashSet;

use utsushi_reallive::bytecode_element::BytecodeElement;
use utsushi_reallive::vm::{InMemorySceneStore, Scene};
use utsushi_reallive::{BranchTerminus, HeadlessChoicePolicy, ReplayEngine, ReplayOpts};

/// Build a header-only jmp `Command` carrying `goto_targets` (used for
/// `goto` / `gosub`, whose targets are trailing `i32` pointers, not a
/// `(...)` arglist). `byte_len` includes the 4-byte pointers so the VM's
/// post-command pc arithmetic matches a real element.
fn jmp_targeted(offset: usize, opcode: u16, targets: Vec<u32>) -> BytecodeElement {
    let header = vec![0x23, 0, 1, opcode as u8, (opcode >> 8) as u8, 0, 0, 0];
    let byte_len = 8 + targets.len() * 4;
    BytecodeElement::Command {
        module_type: 0,
        module_id: 1,
        opcode,
        arg_count: targets.len() as u16,
        overload: 0,
        goto_targets: targets,
        goto_case_exprs: Vec::new(),
        raw_bytes: header,
        byte_offset: offset,
        byte_len,
    }
}

/// Build a jmp `Command` carrying a single integer `(...)` arg (used for
/// `farcall(scene)`), mirroring the real `$\xff<i32 LE>` literal framing.
fn jmp_scene_arg(offset: usize, opcode: u16, scene: i32) -> BytecodeElement {
    let mut raw = vec![0x23, 0, 1, opcode as u8, (opcode >> 8) as u8, 1, 0, 0];
    raw.push(b'(');
    raw.push(0x24);
    raw.push(0xff);
    raw.extend_from_slice(&scene.to_le_bytes());
    raw.push(b')');
    let byte_len = raw.len();
    BytecodeElement::Command {
        module_type: 0,
        module_id: 1,
        opcode,
        arg_count: 1,
        overload: 0,
        goto_targets: Vec::new(),
        goto_case_exprs: Vec::new(),
        raw_bytes: raw,
        byte_offset: offset,
        byte_len,
    }
}

/// Header-only jmp `Command` (used for `ret` / `rtl`, which take no args).
fn jmp_bare(offset: usize, opcode: u16) -> BytecodeElement {
    jmp_targeted(offset, opcode, Vec::new())
}

/// Two-scene store exercising every branch-following transfer kind.
fn two_scene_engine() -> ReplayEngine {
    // Scene 1 (opcodes: 5=gosub, 12=farcall, 0=goto, 10=ret):
    //   @0 gosub(32) → push subroutine frame, jump to 32
    //   @12 farcall(2) → push far-call frame, jump to scene 2 @0
    //   @28 goto(40) → jump to bytecode_len (40) ⇒ EndOfScene
    //   @32 ret → pop subroutine frame, return to @12
    let scene1 = Scene::new(
        1,
        vec![
            jmp_targeted(0, 5, vec![32]),
            jmp_scene_arg(12, 12, 2),
            jmp_targeted(28, 0, vec![40]),
            jmp_bare(32, 10),
        ],
    )
    .expect("scene1");

    // Scene 2 (13=rtl): @0 rtl → pop far-call frame, return to scene 1 @28.
    let scene2 = Scene::new(2, vec![jmp_bare(0, 13)]).expect("scene2");

    let mut store = InMemorySceneStore::new();
    store.insert(scene1);
    store.insert(scene2);
    ReplayEngine::from_store(store, HashSet::new())
}

#[test]
fn branch_following_executes_every_transfer_kind_to_natural_terminus() {
    let engine = two_scene_engine();
    let opts = ReplayOpts {
        step_budget: 1_000,
        stop_at_first_pause: false,
    };
    let report = engine.branch_following_report(1, &opts, HeadlessChoicePolicy::AlwaysFirst);

    // Natural terminus: the scene ran off its end after the goto.
    assert_eq!(report.terminus, BranchTerminus::EndOfScene);
    assert!(report.terminus.is_natural());
    // ZERO unknown opcodes on the executed path; no missing scene.
    assert!(report.unknown_opcode_keys.is_empty());
    assert_eq!(report.scene_not_found, None);

    // Real branch-following: every transfer kind executed exactly once.
    let t = report.transfers;
    assert_eq!(t.subroutine_calls, 1, "gosub");
    assert_eq!(t.returns, 1, "ret");
    assert_eq!(t.far_calls, 1, "farcall");
    assert_eq!(t.returns_from_call, 1, "rtl");
    assert_eq!(t.intra_scene_jumps, 1, "goto");
    assert!(t.total() >= 5);

    // The far-call was FOLLOWED across the store into scene 2.
    assert!(
        report.scenes_visited.contains(&2),
        "followed farcall into scene 2"
    );
    assert_eq!(report.scenes_visited.len(), 2);
    // The first cross-scene dispatch boundary, in dispatch order, was scene 2
    // (the farcall target) — the "next scene" the play-loop continues into.
    assert_eq!(
        report.first_cross_scene,
        Some(2),
        "first cross-scene dispatch target must be the farcall's scene 2",
    );
}

/// `branch_following_observation` reports the SAME first cross-scene dispatch
/// target the report exposes — the signal the itotori work-scope carve reads
/// off a `select` option to root a per-WORK narrative structure. For the
/// archive's opening game-select each option's `first_cross_scene` is the root
/// of the work that option selects; here the followed farcall roots into
/// scene 2.
#[test]
fn branch_following_observation_reports_branch_entry_scene() {
    let engine = two_scene_engine();
    let opts = ReplayOpts {
        step_budget: 1_000,
        stop_at_first_pause: false,
    };
    let obs = engine.branch_following_observation(1, &opts, HeadlessChoicePolicy::AlwaysFirst);
    // The branch dispatched across the store into scene 2 — the "branch entry
    // scene" a work-scope carve roots the selected work at.
    assert_eq!(
        obs.first_cross_scene,
        Some(2),
        "branch_following_observation must expose the option's dispatch target",
    );
    // The lines it returns match `branch_following_lines` (same drive).
    assert_eq!(
        obs.lines,
        engine.branch_following_lines(1, &opts, HeadlessChoicePolicy::AlwaysFirst),
        "observation lines must equal branch_following_lines",
    );
}

/// The multi-scene play-loop follows the real scene-dispatch ACROSS the
/// boundary: `observe_playthrough` from scene 1 chains into scene 2 (the
/// farcall target), producing a 2-scene play stream in dispatch order. A
/// regression that stopped at scene 1 would yield a single scene id.
#[test]
fn observe_playthrough_crosses_scene_boundary_in_dispatch_order() {
    let engine = two_scene_engine();
    let opts = ReplayOpts {
        step_budget: 1_000,
        stop_at_first_pause: false,
    };
    let playthrough = engine.observe_playthrough(1, &opts, 4);

    // The play-loop crossed ≥1 boundary: scene 1 then scene 2, in the order
    // the real dispatch (farcall) transferred.
    assert_eq!(
        playthrough.scene_ids(),
        vec![1, 2],
        "play stream must span scene 1 then scene 2 in dispatch order",
    );
    assert!(
        playthrough.scene_ids().len() >= 2,
        "a regression that stops at scene 1 must FAIL this",
    );
    // The chain is bounded: `max_scenes = 1` observes only the entry scene.
    let bounded = engine.observe_playthrough(1, &opts, 1);
    assert_eq!(bounded.scene_ids(), vec![1], "max_scenes bounds the chain");
}

/// Build a `goto_case` (`module_jmp` opcode 4) `Command` at `offset` with a
/// discriminant literal, per-case match-value literals + their absolute
/// jump targets. The case whose value equals `discriminant` (or the default
/// `()` case, encoded as `None`) selects the target.
fn goto_case(offset: usize, discriminant: i32, cases: &[(Option<i32>, u32)]) -> BytecodeElement {
    // `$ 0xFF <i32 LE>` literal encoding shared by the discriminant and the
    // non-default case match expressions.
    let lit = |value: i32| {
        let mut v = vec![0x24u8, 0xff];
        v.extend_from_slice(&value.to_le_bytes());
        v
    };
    let argc = cases.len() as u16;
    let mut raw = vec![0x23, 0, 1, 4, 0, argc as u8, (argc >> 8) as u8, 0];
    // Discriminant `(disc)` argument list.
    raw.push(b'(');
    raw.extend_from_slice(&lit(discriminant));
    raw.push(b')');
    // `{` (case0)(target0) … `}` — the decoder length-walks this; here it
    // only needs to contribute to `byte_len`, since the VM drives the
    // per-case selection off `goto_case_exprs` / `goto_targets`.
    raw.push(0x7b);
    let mut goto_targets = Vec::new();
    let mut goto_case_exprs = Vec::new();
    for (match_value, target) in cases {
        raw.push(b'(');
        let expr = match match_value {
            Some(v) => lit(*v),
            None => Vec::new(), // default `()` case
        };
        raw.extend_from_slice(&expr);
        raw.push(b')');
        raw.extend_from_slice(&target.to_le_bytes());
        goto_targets.push(*target);
        goto_case_exprs.push(expr);
    }
    raw.push(0x7d);
    let byte_len = raw.len();
    BytecodeElement::Command {
        module_type: 0,
        module_id: 1,
        opcode: 4,
        arg_count: argc,
        overload: 0,
        goto_targets,
        goto_case_exprs,
        raw_bytes: raw,
        byte_offset: offset,
        byte_len,
    }
}

/// A `goto_case` selects the target of the case whose match EXPRESSION
/// equals the discriminant — NOT the discriminant-as-index approximation.
/// The discriminant `7` matches case index 0 (value `7`), whose target
/// leads to `EndOfScene`; the index approximation (`table[7]` → out of range
/// → last target) would instead take case index 1 into an infinite spin.
#[test]
fn goto_case_selects_target_by_matched_case_expression() {
    // @0 goto_case(7) { (7)->@100; (5)->@200 }
    // @100 goto(300) → 300 >= bytecode_len (212) ⇒ EndOfScene (matched)
    // @200 goto(200) → self-loop ⇒ BudgetExhausted (index sink)
    let scene = Scene::new(
        1,
        vec![
            goto_case(0, 7, &[(Some(7), 100), (Some(5), 200)]),
            jmp_targeted(100, 0, vec![300]),
            jmp_targeted(200, 0, vec![200]),
        ],
    )
    .expect("goto_case scene");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let engine = ReplayEngine::from_store(store, HashSet::new());
    let opts = ReplayOpts {
        step_budget: 10_000,
        stop_at_first_pause: false,
    };
    let report = engine.branch_following_report(1, &opts, HeadlessChoicePolicy::AlwaysFirst);
    assert_eq!(
        report.terminus,
        BranchTerminus::EndOfScene,
        "matched case (value 7 == discriminant) must jump to @100 → EndOfScene, \
         not the index-approximation sink @200",
    );
    assert!(report.unknown_opcode_keys.is_empty());
    assert_eq!(
        report.transfers.intra_scene_jumps, 2,
        "goto_case + goto(300)"
    );
}

/// The default `()` case matches any discriminant that no explicit case
/// equals, and a `goto_case` with neither a matching case nor a default
/// falls through (Advance) rather than jumping to a spurious sink.
#[test]
fn goto_case_default_matches_and_no_match_falls_through() {
    // Default present: discriminant 42 matches no explicit case, so the
    // trailing default `()` selects @100 → EndOfScene.
    let with_default = Scene::new(
        1,
        vec![
            goto_case(0, 42, &[(Some(1), 200), (None, 100)]),
            jmp_targeted(100, 0, vec![300]),
            jmp_targeted(200, 0, vec![200]),
        ],
    )
    .expect("default scene");
    let mut store = InMemorySceneStore::new();
    store.insert(with_default);
    let engine = ReplayEngine::from_store(store, HashSet::new());
    let opts = ReplayOpts {
        step_budget: 10_000,
        stop_at_first_pause: false,
    };
    let report = engine.branch_following_report(1, &opts, HeadlessChoicePolicy::AlwaysFirst);
    assert_eq!(
        report.terminus,
        BranchTerminus::EndOfScene,
        "default `()` case must match discriminant 42 → @100 → EndOfScene",
    );

    // No match and no default: control falls through past the goto_case to
    // the next element (a `goto` to EndOfScene), never a spurious jump.
    let gc = goto_case(0, 42, &[(Some(1), 200), (Some(2), 200)]);
    let fall_through_pc = gc.byte_len();
    let no_match = Scene::new(
        1,
        vec![
            gc,
            // Fall-through element sits at the goto_case's post-pc.
            jmp_targeted(fall_through_pc, 0, vec![300]),
            jmp_targeted(200, 0, vec![200]),
        ],
    )
    .expect("no-match scene");
    let mut store2 = InMemorySceneStore::new();
    store2.insert(no_match);
    let engine2 = ReplayEngine::from_store(store2, HashSet::new());
    let report2 = engine2.branch_following_report(1, &opts, HeadlessChoicePolicy::AlwaysFirst);
    assert_eq!(
        report2.terminus,
        BranchTerminus::EndOfScene,
        "no matching case + no default must FALL THROUGH to the next element, \
         not jump to a spurious sink",
    );
}

#[test]
fn branch_following_is_deterministic() {
    let engine = two_scene_engine();
    let opts = ReplayOpts {
        step_budget: 1_000,
        stop_at_first_pause: false,
    };
    let a = engine.branch_following_report(1, &opts, HeadlessChoicePolicy::AlwaysFirst);
    let b = engine.branch_following_report(1, &opts, HeadlessChoicePolicy::AlwaysFirst);
    assert_eq!(a, b, "two branch-following runs must be byte-identical");
}

#[test]
fn branch_following_snapshot_restore_identity_each_tick() {
    let engine = two_scene_engine();
    let opts = ReplayOpts {
        step_budget: 1_000,
        stop_at_first_pause: false,
    };
    let report = engine
        .verify_branch_snapshot_restore_each_tick(1, &opts, HeadlessChoicePolicy::AlwaysFirst)
        .expect("snapshot identity holds at every tick");
    assert!(report.ticks_verified > 0);
}

#[test]
fn cross_scene_farcall_to_missing_scene_is_typed_scene_not_found() {
    // Scene 1 farcalls a scene absent from the store → the branch-following
    // driver classifies it as a typed SceneNotFound terminus (never a
    // fail-soft advance): a genuine cross-scene gap is never masked.
    let scene1 = Scene::new(1, vec![jmp_scene_arg(0, 12, 999), jmp_bare(16, 13)]).expect("scene1");
    let mut store = InMemorySceneStore::new();
    store.insert(scene1);
    let engine = ReplayEngine::from_store(store, HashSet::new());
    let opts = ReplayOpts {
        step_budget: 100,
        stop_at_first_pause: false,
    };
    let report = engine.branch_following_report(1, &opts, HeadlessChoicePolicy::AlwaysFirst);
    assert_eq!(report.terminus, BranchTerminus::SceneNotFound(999));
    assert_eq!(report.scene_not_found, Some(999));
    assert!(!report.terminus.is_natural());
}

#[test]
fn event_gated_self_loop_is_broken_by_deterministic_event_model() {
    // A bare `goto(0)` self-loop is an event-gated spin a headless walk
    // cannot otherwise exit. The deterministic event-flag model PROVES the
    // spin (the `(scene, pc, stack, memory)` fingerprint repeats) and
    // models the awaited event as fired, suppressing the loop-closing
    // transfer to a fall-through — so the scene runs off its end to a
    // NATURAL terminus instead of BudgetExhausting.
    let scene = Scene::new(1, vec![jmp_targeted(0, 0, vec![0])]).expect("scene1");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let engine = ReplayEngine::from_store(store, HashSet::new());
    let opts = ReplayOpts {
        step_budget: 10_000,
        stop_at_first_pause: false,
    };
    let report = engine.branch_following_report(1, &opts, HeadlessChoicePolicy::AlwaysFirst);
    assert_eq!(report.terminus, BranchTerminus::EndOfScene);
    assert!(report.terminus.is_natural());
    assert!(
        report.modeled_events >= 1,
        "the event-flag model must have fired at least once: {report:?}",
    );
    // Determinism: fingerprint-driven, no clock/RNG.
    let again = engine.branch_following_report(1, &opts, HeadlessChoicePolicy::AlwaysFirst);
    assert_eq!(report, again);
}

#[test]
fn nested_event_gated_spin_unwinds_to_caller_via_depth_scoped_break() {
    // A spin INSIDE a far-called scene: the model must unwind the stuck
    // frame (suppress its transfers until it `rtl`s) and RESUME normal
    // branch-following in the caller, which then reaches EndOfScene.
    //   scene1: @0 farcall(2) → scene2; @16 goto(28) → EndOfScene
    //   scene2: @0 goto(0) self-loop; @12 rtl → return to scene1 @16
    let scene1 = Scene::new(
        1,
        vec![jmp_scene_arg(0, 12, 2), jmp_targeted(16, 0, vec![28])],
    )
    .expect("scene1");
    let scene2 =
        Scene::new(2, vec![jmp_targeted(0, 0, vec![0]), jmp_bare(12, 13)]).expect("scene2");
    let mut store = InMemorySceneStore::new();
    store.insert(scene1);
    store.insert(scene2);
    let engine = ReplayEngine::from_store(store, HashSet::new());
    let opts = ReplayOpts {
        step_budget: 10_000,
        stop_at_first_pause: false,
    };
    let report = engine.branch_following_report(1, &opts, HeadlessChoicePolicy::AlwaysFirst);
    assert_eq!(report.terminus, BranchTerminus::EndOfScene);
    assert!(report.modeled_events >= 1);
    // The far-call was followed into scene 2 and its `rtl` returned.
    assert!(report.scenes_visited.contains(&2));
    assert_eq!(report.transfers.far_calls, 1);
    assert_eq!(report.transfers.returns_from_call, 1);
}

#[test]
fn null_scene_sentinel_farcall_falls_through_deterministically() {
    // A `farcall(0)` targets the null-scene sentinel — the game's guarded
    // "nothing to call" path. It must fall through (no transfer, no
    // SceneNotFound), letting the scene run to its natural end. This is the
    // "absent-but-guarded" case, DISTINCT from the event-model spin break:
    // no fingerprint spin is involved (modeled_events stays 0).
    //   scene1: @0 farcall(0) → fall through; @16 goto(28) → EndOfScene
    let scene = Scene::new(
        1,
        vec![jmp_scene_arg(0, 12, 0), jmp_targeted(16, 0, vec![28])],
    )
    .expect("scene1");
    let mut store = InMemorySceneStore::new();
    store.insert(scene);
    let engine = ReplayEngine::from_store(store, HashSet::new());
    let opts = ReplayOpts {
        step_budget: 100,
        stop_at_first_pause: false,
    };
    let report = engine.branch_following_report(1, &opts, HeadlessChoicePolicy::AlwaysFirst);
    assert_eq!(report.terminus, BranchTerminus::EndOfScene);
    assert_eq!(report.scene_not_found, None);
    // The sentinel farcall was NOT counted as a transfer and did NOT invoke
    // the spin-break model.
    assert_eq!(report.transfers.far_calls, 0);
    assert_eq!(report.modeled_events, 0);
    assert_eq!(report.scenes_visited.len(), 1);
}
