use super::*;

#[test]
fn malformed_route_pair_surfaces_typed_error() {
    let mut text = reallive_real_bytes_lines_14_28().to_string();
    text = text.replace("#CANCELCALL=9999,10\r\n", "#CANCELCALL=oops\r\n");
    let gx = parse_gameexe(&text);
    match SyscallDispatcher::from_gameexe(&gx) {
        Err(SyscallDispatchBuildError::MalformedRoutePair { code, route_key }) => {
            assert_eq!(code, SYSCALL_ROUTE_MALFORMED_PAIR_CODE);
            assert_eq!(route_key, "CANCELCALL");
        }
        other => panic!("expected MalformedRoutePair, got {other:?}"),
    }
}

#[test]
fn missing_mouse_area_surfaces_typed_error() {
    let mut text = reallive_real_bytes_lines_14_28().to_string();
    text = text.replace("#MOUSEACTIONCALL.000.AREA=752,0,799,599\r\n", "");
    let gx = parse_gameexe(&text);
    match SyscallDispatcher::from_gameexe(&gx) {
        Err(SyscallDispatchBuildError::MouseAreaMissing { code, route_key }) => {
            assert_eq!(code, SYSCALL_MOUSE_AREA_MALFORMED_CODE);
            assert_eq!(route_key, "MOUSEACTIONCALL.000");
        }
        other => panic!("expected MouseAreaMissing, got {other:?}"),
    }
}

#[test]
fn invoke_routes_through_farcall_op_pushes_far_call_frame() {
    let gx = parse_gameexe(reallive_real_bytes_lines_14_28());
    let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
    let route = dispatcher
        .route_for_kind(SyscallRouteKind::Cancel)
        .expect("cancel route");
    let mut vm = Vm::new(7, 100);
    dispatcher
        .invoke(&mut vm, route, 7, 200)
        .expect("invoke succeeds");
    // Pushed a single FarCall frame.
    assert_eq!(vm.stack().len(), 1);
    assert_eq!(vm.stack()[0].return_scene, Some(7));
    assert_eq!(vm.stack()[0].return_pc, 200);
    // Landed at (9999, 10).
    assert_eq!(vm.scene(), 9999);
    assert_eq!(vm.pc(), 10);
}

#[test]
fn wbcall_namespace_is_enumerated_not_capped_at_a_fixed_count() {
    // The dispatcher must register EVERY declared WBCALL slot, not a
    // hardcoded window: appending a 9th and 10th window-button slot
    // beyond the § H fixture's eight must extend the table, never
    // trip an artificial cap. This proves a RealLive game with a
    // different WBCALL count works.
    let mut text = reallive_real_bytes_lines_14_28().to_string();
    text.push_str("#WBCALL.008=9999,8\r\n");
    text.push_str("#WBCALL.009=9999,9\r\n");
    let gx = parse_gameexe(&text);
    let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
    for index in 0u8..=9 {
        let route = dispatcher
            .route_for_wbcall(index)
            .unwrap_or_else(|| panic!("WBCALL.{index:03} must be registered"));
        assert_eq!(
            route.entrypoint, index as u32,
            "WBCALL.{index:03} entrypoint"
        );
    }
    // Exactly ten WBCALL entries — no phantom slots, none dropped.
    let wbcall_count = dispatcher
        .routes()
        .iter()
        .filter(|route| matches!(route.kind, SyscallRouteKind::Wbcall { .. }))
        .count();
    assert_eq!(wbcall_count, 10, "every declared WBCALL slot is registered");
}

#[test]
fn wbcall_sparse_namespace_registers_only_declared_slots() {
    // A non-contiguous WBCALL namespace (declare 000, 002, 005; leave
    // 001/003/004 absent) must register exactly the declared slots —
    // enumeration follows the Gameexe, it neither fills gaps nor
    // stops at the first hole.
    let mut text: String = reallive_real_bytes_lines_14_28()
        .lines()
        .filter(|line| !line.starts_with("#WBCALL."))
        .collect::<Vec<_>>()
        .join("\r\n");
    text.push_str("\r\n#WBCALL.000=9999,100\r\n");
    text.push_str("#WBCALL.002=9999,102\r\n");
    text.push_str("#WBCALL.005=9999,105\r\n");
    let gx = parse_gameexe(&text);
    let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
    let mut declared: Vec<u8> = dispatcher
        .routes()
        .iter()
        .filter_map(|route| match route.kind {
            SyscallRouteKind::Wbcall { index } => Some(index),
            _ => None,
        })
        .collect();
    declared.sort_unstable();
    assert_eq!(
        declared,
        vec![0, 2, 5],
        "only declared WBCALL slots register"
    );
}

#[test]
fn wbcall_malformed_pair_surfaces_typed_error_not_silent_drop() {
    // A declared WBCALL slot whose value is not a `(scene, entrypoint)`
    // pair must surface a typed diagnostic, never be silently dropped.
    let mut text = reallive_real_bytes_lines_14_28().to_string();
    text.push_str("#WBCALL.008=garbage\r\n");
    let gx = parse_gameexe(&text);
    match SyscallDispatcher::from_gameexe(&gx) {
        Err(SyscallDispatchBuildError::MalformedRoutePair { code, route_key }) => {
            assert_eq!(code, SYSCALL_ROUTE_MALFORMED_PAIR_CODE);
            assert_eq!(route_key, "WBCALL.008");
        }
        other => panic!("expected MalformedRoutePair, got: {other:?}"),
    }
}

#[test]
fn require_far_call_outcome_rejects_non_far_call() {
    // The invoke() fallback must surface a typed error in *all*
    // build profiles (not a debug-only assert that silently advances
    // in release). Feed the pure helper a synthetic non-FarCall
    // outcome and assert the typed VmError.
    let advance = DispatchOutcome::Advance;
    match require_far_call_outcome(&advance, 9999, 200) {
        Err(VmError::UnexpectedDispatchOutcome {
            scene,
            pc,
            expected,
            found,
        }) => {
            assert_eq!(scene, 9999);
            assert_eq!(pc, 200);
            assert_eq!(expected, "far_call");
            assert_eq!(found, "advance");
        }
        other => panic!("expected UnexpectedDispatchOutcome, got: {other:?}"),
    }
    // A genuine FarCall outcome passes through unchanged.
    let far_call = DispatchOutcome::FarCall {
        return_scene: 1,
        return_pc: 2,
        target_scene: 3,
        target_pc: 4,
    };
    let passed = require_far_call_outcome(&far_call, 3, 2).expect("FarCall must pass through");
    assert!(matches!(passed, DispatchOutcome::FarCall { .. }));
}

#[test]
fn invoke_through_rtl_resumes_at_post_command_byte() {
    // Drive a roundtrip: invoke a route, then dispatch `rtl`
    // and assert the VM lands back at the supplied return
    // (scene, pc).
    let gx = parse_gameexe(reallive_real_bytes_lines_14_28());
    let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
    let route = dispatcher
        .route_for_kind(SyscallRouteKind::SystemcallSave)
        .expect("save route");
    let mut vm = Vm::new(5, 60);
    dispatcher
        .invoke(&mut vm, route, 5, 80)
        .expect("invoke succeeds");
    assert_eq!(vm.scene(), 9999);
    assert_eq!(vm.pc(), 20);
    let pop = crate::rlop::module_ctrl::RtlOp.dispatch(&mut vm, &[]);
    vm.apply_dispatch_outcome(&pop, 9999).expect("rtl resumes");
    assert_eq!(vm.scene(), 5);
    assert_eq!(vm.pc(), 80);
    // Ensure the scheduler reference is touched so the import is
    // not dead-stripped (substrate seam for the VM step loop).
    let _ = AlwaysReadyScheduler;
}

#[test]
fn input_event_save_load_routes_to_named_kinds() {
    let mut text = reallive_real_bytes_lines_14_28()
        .replace("#EXAFTERCALL_MOD=0\r\n", "#EXAFTERCALL_MOD=1\r\n");
    text.push_str("");
    let gx = parse_gameexe(&text);
    let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
    let save = InputEvent::Save { slot: 0 };
    let load = InputEvent::Load { slot: 0 };
    assert_eq!(
        dispatcher
            .route_for_input_event(&save)
            .expect("save dispatch must not error")
            .map(|route| route.kind),
        Some(SyscallRouteKind::SystemcallSave),
    );
    assert_eq!(
        dispatcher
            .route_for_input_event(&load)
            .expect("load dispatch must not error")
            .map(|route| route.kind),
        Some(SyscallRouteKind::SystemcallLoad),
    );
}

#[test]
fn route_kind_discriminants_are_distinct() {
    let kinds = [
        SyscallRouteKind::Cancel,
        SyscallRouteKind::SystemcallSave,
        SyscallRouteKind::SystemcallLoad,
        SyscallRouteKind::SystemcallSystem,
        SyscallRouteKind::MouseAction { index: 0 },
        SyscallRouteKind::Loadcall,
        SyscallRouteKind::Exaftercall,
        SyscallRouteKind::Wbcall { index: 0 },
    ];
    assert_eq!(kinds.len(), SYSCALL_KIND_COUNT);
    let mut discriminants: Vec<u8> = kinds.iter().map(|kind| kind.discriminant()).collect();
    discriminants.sort_unstable();
    discriminants.dedup();
    assert_eq!(discriminants.len(), SYSCALL_KIND_COUNT);
}
