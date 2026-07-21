use super::*;

fn runtime() -> Arc<GraphicsRuntime> {
    Arc::new(GraphicsRuntime::new())
}

fn vm() -> Vm {
    Vm::new(1, 0)
}

fn int(value: i32) -> ExprValue {
    ExprValue::Int(value)
}

#[test]
fn obj_button_opts_binds_exact_foreground_slot() {
    let runtime = runtime();
    runtime.with_stack_mut(|stack| {
        stack
            .set_layer(
                GraphicsLayer::ForegroundObject,
                2,
                GraphicsObject::image("button"),
            )
            .expect("slot");
    });
    let op = ObjButtonOptsOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground);
    let mut vm = vm();
    op.dispatch(&mut vm, &[int(2), int(10), int(11), int(7), int(3)]);
    let options = runtime
        .state_snapshot()
        .foreground_object_slot(2)
        .and_then(|object| object.button_options);
    assert_eq!(
        options,
        Some(ButtonOptions {
            action: 10,
            se: 11,
            group: 7,
            button_number: 3
        })
    );
    assert_eq!(
        runtime.foreground_button_group(7),
        vec![(2, options.unwrap())]
    );
}

#[test]
fn child_button_opts_binds_only_an_existing_child() {
    let runtime = runtime();
    runtime.with_stack_mut(|stack| {
        assert!(stack.create_parent(GraphicsPlane::Foreground, 4, 2, None, None));
        assert!(stack.set_child(
            GraphicsPlane::Foreground,
            4,
            1,
            GraphicsObject::image("child"),
        ));
        stack
            .set_layer(
                GraphicsLayer::ForegroundObject,
                1,
                GraphicsObject::image("top"),
            )
            .expect("slot");
    });
    let op = ObjButtonOptsOp::new_child(Arc::clone(&runtime), GraphicsPlane::Foreground);
    op.dispatch(
        &mut vm(),
        &[int(4), int(1), int(10), int(11), int(7), int(3)],
    );
    op.dispatch(&mut vm(), &[int(4), int(2), int(1), int(2), int(3), int(4)]);
    op.dispatch(&mut vm(), &[int(4), int(1), int(10)]);
    op.dispatch(
        &mut vm(),
        &[int(256), int(1), int(1), int(2), int(3), int(4)],
    );

    let snapshot = runtime.state_snapshot();
    assert_eq!(
        snapshot
            .stack
            .target(GraphicsObjectTarget::Child {
                plane: GraphicsPlane::Foreground,
                parent: 4,
                child: 1,
            })
            .and_then(|object| object.button_options),
        Some(ButtonOptions {
            action: 10,
            se: 11,
            group: 7,
            button_number: 3,
        })
    );
    assert!(
        snapshot
            .stack
            .target(GraphicsObjectTarget::Child {
                plane: GraphicsPlane::Foreground,
                parent: 4,
                child: 2,
            })
            .is_none()
    );
    assert!(
        snapshot
            .stack
            .get_layer(GraphicsLayer::ForegroundObject, 1)
            .and_then(|object| object.button_options)
            .is_none()
    );
}

#[test]
fn background_binding_is_preserved_but_excluded_from_foreground_query() {
    let runtime = runtime();
    runtime.with_stack_mut(|stack| {
        stack
            .set_layer(
                GraphicsLayer::BackgroundObject,
                4,
                GraphicsObject::image("button"),
            )
            .expect("slot");
    });
    ObjButtonOptsOp::new(Arc::clone(&runtime), GraphicsPlane::Background)
        .dispatch(&mut vm(), &[int(4), int(1), int(2), int(9), int(5)]);
    assert!(
        runtime
            .state_snapshot()
            .background_object_slot(4)
            .and_then(|object| object.button_options)
            .is_some()
    );
    assert!(runtime.foreground_button_group(9).is_empty());
}

#[test]
fn foreground_query_keeps_duplicate_and_reordered_button_records() {
    let runtime = runtime();
    runtime.with_stack_mut(|stack| {
        for slot in [1, 5, 7] {
            stack
                .set_layer(
                    GraphicsLayer::ForegroundObject,
                    slot,
                    GraphicsObject::image("b"),
                )
                .expect("slot");
        }
    });
    let op = ObjButtonOptsOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground);
    let mut vm = vm();
    op.dispatch(&mut vm, &[int(7), int(1), int(2), int(4), int(9)]);
    op.dispatch(&mut vm, &[int(1), int(3), int(4), int(4), int(9)]);
    op.dispatch(&mut vm, &[int(5), int(5), int(6), int(8), int(9)]);
    assert_eq!(
        runtime.foreground_button_group(4),
        vec![
            (
                1,
                ButtonOptions {
                    action: 3,
                    se: 4,
                    group: 4,
                    button_number: 9
                }
            ),
            (
                7,
                ButtonOptions {
                    action: 1,
                    se: 2,
                    group: 4,
                    button_number: 9
                }
            ),
        ]
    );
}

#[test]
fn malformed_or_unallocated_setters_do_not_bind() {
    let runtime = runtime();
    let op = ObjButtonOptsOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground);
    let mut vm = vm();
    for args in [
        vec![int(1), int(2)],
        vec![ExprValue::Bytes(vec![]), int(1), int(2), int(3), int(4)],
        vec![int(-1), int(1), int(2), int(3), int(4)],
        vec![int(999), int(1), int(2), int(3), int(4)],
        vec![int(1), int(1), int(2), int(3), int(4)],
    ] {
        op.dispatch(&mut vm, &args);
    }
    assert!(runtime.foreground_button_group(3).is_empty());
}

#[test]
fn candidates_are_slot_ordered_detached_and_keep_invisible_foreground_only() {
    let runtime = runtime();
    runtime.with_stack_mut(|stack| {
        for slot in [2, 5, 7] {
            stack
                .set_layer(
                    GraphicsLayer::ForegroundObject,
                    slot,
                    GraphicsObject::image("f"),
                )
                .unwrap();
        }
        stack
            .set_layer(
                GraphicsLayer::BackgroundObject,
                1,
                GraphicsObject::image("b"),
            )
            .unwrap();
        stack
            .get_layer_mut(GraphicsLayer::ForegroundObject, 7)
            .unwrap()
            .visible = false;
    });
    let mut vm = vm();
    for (plane, slot, group, number) in [
        (GraphicsPlane::Foreground, 7, 4, 70),
        (GraphicsPlane::Foreground, 5, 8, 50),
        (GraphicsPlane::Foreground, 2, 4, 20),
        (GraphicsPlane::Background, 1, 4, 10),
    ] {
        ObjButtonOptsOp::new(Arc::clone(&runtime), plane).dispatch(
            &mut vm,
            &[int(slot), int(1), int(2), int(group), int(number)],
        );
    }
    let candidates = runtime.foreground_button_candidates(4);
    assert_eq!(
        candidates
            .iter()
            .map(|candidate| candidate.slot)
            .collect::<Vec<_>>(),
        vec![2, 7]
    );
    assert_eq!(candidates[1].options.button_number, 70);
    assert!(!candidates[1].visible);
    runtime.with_stack_mut(|stack| {
        stack
            .get_layer_mut(GraphicsLayer::ForegroundObject, 2)
            .unwrap()
            .button_options = None;
    });
    assert_eq!(candidates[0].options.button_number, 20);
}

#[test]
fn fade_longop_round_trips_through_payload() {
    let long = FadeLongOp::new(LongOpId(1), 255, 0, 1000).into_longop();
    assert_eq!(long.private_state.len(), FadeLongOp::PAYLOAD_BYTE_LEN);
    assert_eq!(long.private_state[0], FADE_PRIVATE_STATE_MAGIC);
    let decoded = FadeLongOp::try_from_payload(long.id, &long.private_state).expect("decode");
    assert_eq!(decoded.starting_alpha(), 255);
    assert_eq!(decoded.target_alpha(), 0);
    assert_eq!(decoded.total_ticks(), 1000);
    assert_eq!(decoded.elapsed_ticks(), 0);
}

#[test]
fn fade_longop_current_alpha_interpolates_linearly() {
    let mut fade = FadeLongOp::new(LongOpId(1), 0, 200, 100);
    assert_eq!(fade.current_alpha(), 0);
    fade.advance(50);
    assert_eq!(fade.current_alpha(), 100);
    fade.advance(50);
    assert_eq!(fade.current_alpha(), 200);
    assert!(fade.is_complete());
}

#[test]
fn fade_longop_payload_decode_rejects_wrong_magic() {
    let mut payload = vec![0u8; FadeLongOp::PAYLOAD_BYTE_LEN];
    payload[0] = 0x00;
    let err = FadeLongOp::try_from_payload(LongOpId(1), &payload).expect_err("must reject");
    assert!(matches!(
        err,
        FadeLongOpDecodeError::MagicMismatch {
            observed: 0x00,
            expected: FADE_PRIVATE_STATE_MAGIC,
        }
    ));
}

#[test]
fn graphics_runtime_next_longop_id_is_strictly_monotonic() {
    let runtime = runtime();
    assert_eq!(runtime.next_longop_id(), LongOpId(1));
    assert_eq!(runtime.next_longop_id(), LongOpId(2));
    assert_eq!(runtime.next_longop_id(), LongOpId(3));
}

#[test]
fn graphics_runtime_fade_ticks_per_ms_defaults_then_overrides() {
    let runtime = runtime();
    assert_eq!(runtime.fade_ticks_per_ms(), DEFAULT_FADE_TICKS_PER_MS);
    runtime.set_fade_ticks_per_ms(8);
    assert_eq!(runtime.fade_ticks_per_ms(), 8);
}
