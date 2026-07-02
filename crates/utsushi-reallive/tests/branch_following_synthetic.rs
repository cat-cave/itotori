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
    //   @0  gosub(32)      → push subroutine frame, jump to 32
    //   @12 farcall(2)     → push far-call frame, jump to scene 2 @0
    //   @28 goto(40)       → jump to bytecode_len (40) ⇒ EndOfScene
    //   @32 ret            → pop subroutine frame, return to @12
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
