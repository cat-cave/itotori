use super::*;

#[test]
fn dispatcher_reports_eight_kinds_for_reallive_real_bytes_shape() {
    // EXAFTERCALL_MOD=0 disables the exaftercall route, so 7
    // kinds present (not 8). Flip the mod to 1 to test the
    // full 8.
    let mut text = reallive_real_bytes_lines_14_28()
        .replace("#EXAFTERCALL_MOD=0\r\n", "#EXAFTERCALL_MOD=1\r\n");
    text.push_str("");
    let gx = parse_gameexe(&text);
    let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
    assert_eq!(dispatcher.route_count(), SYSCALL_KIND_COUNT);
    // § H shape: 6 named (cancel/save/load/system/loadcall/
    // exaftercall) + 1 mouse-action + 8 wbcall = 15 entries.
    assert_eq!(dispatcher.entry_count(), 15);
}

#[test]
fn dispatcher_resolves_documented_scene_entrypoint_pairs() {
    let mut text = reallive_real_bytes_lines_14_28()
        .replace("#EXAFTERCALL_MOD=0\r\n", "#EXAFTERCALL_MOD=1\r\n");
    text.push_str("");
    let gx = parse_gameexe(&text);
    let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
    let pairs: Vec<(&str, SceneId, u32)> = vec![
        ("cancel", 9999, 10),
        ("systemcall_save", 9999, 20),
        ("systemcall_load", 9999, 21),
        ("systemcall_system", 9999, 22),
        ("mouse_action[0]", 9999, 30),
        ("loadcall", 9999, 40),
        ("exaftercall", 9999, 50),
        ("wbcall[0]", 9999, 0),
        ("wbcall[7]", 9999, 7),
    ];
    for (label, want_scene, want_pc) in pairs {
        let route = match label {
            "cancel" => dispatcher.route_for_kind(SyscallRouteKind::Cancel),
            "systemcall_save" => dispatcher.route_for_kind(SyscallRouteKind::SystemcallSave),
            "systemcall_load" => dispatcher.route_for_kind(SyscallRouteKind::SystemcallLoad),
            "systemcall_system" => dispatcher.route_for_kind(SyscallRouteKind::SystemcallSystem),
            "mouse_action[0]" => {
                dispatcher.route_for_kind(SyscallRouteKind::MouseAction { index: 0 })
            }
            "loadcall" => dispatcher.route_for_kind(SyscallRouteKind::Loadcall),
            "exaftercall" => dispatcher.route_for_kind(SyscallRouteKind::Exaftercall),
            "wbcall[0]" => dispatcher.route_for_wbcall(0),
            "wbcall[7]" => dispatcher.route_for_wbcall(7),
            _ => unreachable!(),
        };
        let route = route.expect("route present");
        assert_eq!(route.scene_id, want_scene, "{label} scene");
        assert_eq!(route.entrypoint, want_pc, "{label} entrypoint");
    }
}

#[test]
fn mouseactioncall_scan_discovers_non_contiguous_indices() {
    // A sparse MOUSEACTIONCALL namespace: `000` and `002` are
    // present but `001` is absent. The scan must not stop at the
    // gap — both `000` and `002` have to be discovered, while the
    // missing `001` stays unrouted.
    let mut text = reallive_real_bytes_lines_14_28().to_string();
    text.push_str("#MOUSEACTIONCALL.002.MOD=1\r\n");
    text.push_str("#MOUSEACTIONCALL.002.SEEN=9999,32\r\n");
    text.push_str("#MOUSEACTIONCALL.002.AREA=10,20,30,40\r\n");
    let gx = parse_gameexe(&text);
    let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");

    let route0 = dispatcher
        .route_for_kind(SyscallRouteKind::MouseAction { index: 0 })
        .expect("index 000 must be discovered");
    assert_eq!(route0.entrypoint, 30, "index 000 entrypoint");

    let route2 = dispatcher
        .route_for_kind(SyscallRouteKind::MouseAction { index: 2 })
        .expect("index 002 must be discovered past the 001 gap");
    assert_eq!(route2.entrypoint, 32, "index 002 entrypoint");

    assert!(
        dispatcher
            .route_for_kind(SyscallRouteKind::MouseAction { index: 1 })
            .is_none(),
        "absent index 001 must stay unrouted",
    );
}

#[test]
fn cancelcall_mod_zero_disables_route_entirely() {
    let text =
        reallive_real_bytes_lines_14_28().replace("#CANCELCALL_MOD=1\r\n", "#CANCELCALL_MOD=0\r\n");
    let gx = parse_gameexe(&text);
    let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
    assert!(
        dispatcher
            .route_for_kind(SyscallRouteKind::Cancel)
            .is_none(),
        "CANCELCALL_MOD=0 must remove the cancel route"
    );
    // Other routes survive — disabling cancel does not affect
    // unrelated mods.
    assert!(
        dispatcher
            .route_for_kind(SyscallRouteKind::SystemcallSave)
            .is_some(),
    );
}

#[test]
fn exaftercall_mod_zero_in_real_bytes_disables_route() {
    // The § H fixture carries `EXAFTERCALL_MOD=0`, so by default the
    // dispatcher does NOT include `exaftercall`.
    let gx = parse_gameexe(reallive_real_bytes_lines_14_28());
    let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
    assert!(
        dispatcher
            .route_for_kind(SyscallRouteKind::Exaftercall)
            .is_none(),
        "EXAFTERCALL_MOD=0 — route must be absent"
    );
    // Seven kinds present (not 8).
    assert_eq!(dispatcher.route_count(), SYSCALL_KIND_COUNT - 1);
    // Pin the *entry* count too, not only the kind count. The full
    // EXAFTERCALL_MOD=1 shape has 15 entries (6 named scalar + 1
    // MOUSEACTIONCALL + 8 WBCALL); disabling EXAFTERCALL drops exactly
    // one named scalar route, so the real-bytes EXAFTERCALL_MOD=0 path
    // must carry 14. The kind-count assertion alone would not catch a
    // regression that double-adds a route in this MOD=0 case.
    assert_eq!(dispatcher.entry_count(), 14);
}

#[test]
fn mouseactioncall_hot_region_pixel_dispatches() {
    // AREA = 752,0,799,599. (780, 300) is inside.
    // (100, 100) is outside.
    let gx = parse_gameexe(reallive_real_bytes_lines_14_28());
    let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
    let inside = dispatcher
        .route_for_pointer_pixel(780, 300)
        .expect("inside hits mouse-action route");
    assert!(matches!(
        inside.kind,
        SyscallRouteKind::MouseAction { index: 0 }
    ));
    assert_eq!(inside.scene_id, 9999);
    assert_eq!(inside.entrypoint, 30);
    assert!(
        dispatcher.route_for_pointer_pixel(100, 100).is_none(),
        "(100, 100) must miss every hot region"
    );
}

#[test]
fn mouseactioncall_input_event_normalized_round_trips_to_pixel() {
    let gx = parse_gameexe(reallive_real_bytes_lines_14_28());
    let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
    // Normalized coords for the pixel-space (780, 300) point on the
    // fixture's declared 800x600 screen: divide by `dim - 1`.
    let event = InputEvent::Pointer {
        x: 780.0 / (SCREEN_W - 1) as f32,
        y: 300.0 / (SCREEN_H - 1) as f32,
        button: utsushi_core::substrate::PointerButton::Primary,
    };
    let route = dispatcher
        .route_for_input_event(&event)
        .expect("pointer dispatch must not error with a known screen size")
        .expect("normalized pointer event must hit the route");
    assert!(matches!(
        route.kind,
        SyscallRouteKind::MouseAction { index: 0 }
    ));
    // Off-region normalized event misses.
    let off = InputEvent::Pointer {
        x: 0.0,
        y: 0.5,
        button: utsushi_core::substrate::PointerButton::Primary,
    };
    assert!(
        dispatcher
            .route_for_input_event(&off)
            .expect("pointer dispatch must not error with a known screen size")
            .is_none()
    );
}

#[test]
fn pointer_event_without_screen_size_emits_missing_diagnostic() {
    // Drop SCREENSIZE_MOD but keep the MOUSEACTIONCALL hot region.
    // A pointer event can no longer be lowered to pixel space, so
    // the dispatcher must surface the typed missing-screen-size
    // diagnostic rather than silently returning `None`.
    let text = reallive_real_bytes_lines_14_28().replace(SCREENSIZE_LINE, "");
    let gx = parse_gameexe(&text);
    let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
    assert!(
        dispatcher.screen_size().is_none(),
        "SCREENSIZE_MOD was removed — screen size must be absent"
    );
    let event = InputEvent::Pointer {
        x: 0.5,
        y: 0.5,
        button: utsushi_core::substrate::PointerButton::Primary,
    };
    match dispatcher.route_for_input_event(&event) {
        Err(SyscallDispatchError::MissingScreenSize { code }) => {
            assert_eq!(code, SYSCALL_MISSING_SCREEN_SIZE_CODE);
        }
        other => panic!("expected MissingScreenSize diagnostic, got {other:?}"),
    }
}

#[test]
fn zero_dimension_screen_size_is_rejected_not_silently_zeroed() {
    // A present-but-degenerate `SCREENSIZE_MOD` (a zero width or a
    // zero height) cannot index a pixel grid: the old path parsed
    // it into `ScreenSize { width: 0,.. }`, bypassing the
    // `MissingScreenSize` guard while `pointer_to_pixel` collapsed
    // that axis to `0` — silently mis-routing every pointer
    // hot-region dispatch. The corrected `parse_screen_size`
    // rejects the degenerate shape so the typed diagnostic fires.
    for degenerate in ["#SCREENSIZE_MOD=1,0,600\r\n", "#SCREENSIZE_MOD=1,800,0\r\n"] {
        let text = reallive_real_bytes_lines_14_28().replace(SCREENSIZE_LINE, degenerate);
        let gx = parse_gameexe(&text);
        let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
        assert!(
            dispatcher.screen_size().is_none(),
            "degenerate SCREENSIZE_MOD {degenerate:?} must not parse into a usable screen size"
        );
        // A pointer event that previously vanished into the zeroed
        // axis must now surface the typed missing-screen-size
        // diagnostic instead of silently corrupting dispatch.
        let event = InputEvent::Pointer {
            x: 780.0 / (SCREEN_W - 1) as f32,
            y: 300.0 / (SCREEN_H - 1) as f32,
            button: utsushi_core::substrate::PointerButton::Primary,
        };
        match dispatcher.route_for_input_event(&event) {
            Err(SyscallDispatchError::MissingScreenSize { code }) => {
                assert_eq!(code, SYSCALL_MISSING_SCREEN_SIZE_CODE);
            }
            other => panic!(
                "degenerate SCREENSIZE_MOD {degenerate:?} must surface MissingScreenSize, got {other:?}"
            ),
        }
    }
}

#[test]
fn pointer_event_without_screen_size_or_hot_region_returns_none() {
    // No SCREENSIZE_MOD and no MOUSEACTIONCALL route: the missing
    // screen size disables no pointer dispatch, so the honest
    // answer is `Ok(None)` rather than a false-positive diagnostic.
    let mut text = reallive_real_bytes_lines_14_28()
        .replace(SCREENSIZE_LINE, "")
        .replace("#MOUSEACTIONCALL.000.MOD=1\r\n", "")
        .replace("#MOUSEACTIONCALL.000.SEEN=9999,30\r\n", "")
        .replace("#MOUSEACTIONCALL.000.AREA=752,0,799,599\r\n", "");
    text.push_str("");
    let gx = parse_gameexe(&text);
    let dispatcher = SyscallDispatcher::from_gameexe(&gx).expect("build");
    let event = InputEvent::Pointer {
        x: 0.5,
        y: 0.5,
        button: utsushi_core::substrate::PointerButton::Primary,
    };
    assert!(matches!(dispatcher.route_for_input_event(&event), Ok(None)));
}
