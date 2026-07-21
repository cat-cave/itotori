use super::*;

#[test]
fn obj_setters_mutate_created_object() {
    let runtime = rt();
    ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
        .dispatch(&mut vm(), &[int(0), s(b"X")]);
    let set = |p: ObjSetProp, args: &[ExprValue]| {
        ObjSetOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground, p).dispatch(&mut vm(), args);
    };
    set(ObjSetProp::Move, &[int(0), int(7), int(9)]);
    set(ObjSetProp::Alpha, &[int(0), int(64)]);
    set(ObjSetProp::Show, &[int(0), int(0)]);
    set(ObjSetProp::Layer, &[int(0), int(4)]);
    set(ObjSetProp::PattNo, &[int(0), int(2)]);
    let snap = runtime.state_snapshot();
    let o = snap.stack.get(GraphicsPlane::Foreground, 0).unwrap();
    assert_eq!((o.position.x, o.position.y), (7, 9));
    assert_eq!(o.alpha.0, 64);
    assert!(!o.visible);
    assert_eq!(o.layer_order, OBJ_FG_LAYER_BASE + 4);
    if let Kind::Image { image_ref } = &o.kind {
        assert_eq!(image_ref.region_index, Some(2));
    }
}

#[test]
fn objbtn_state_routes_exact_direct_and_inclusive_range_shapes() {
    let runtime = rt();
    for slot in 0..5 {
        ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
            .dispatch(&mut vm(), &[int(slot), s(b"TOP")]);
    }
    ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Background)
        .dispatch(&mut vm(), &[int(0), s(b"BG")]);
    ParentCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
        .dispatch(&mut vm(), &[int(4), int(3)]);
    for child in 0..3 {
        ChildCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
            .dispatch(&mut vm(), &[int(4), int(child), s(b"CHILD")]);
    }
    let mut registry = RlopRegistry::new();
    register_render_rlops(&mut registry, Arc::clone(&runtime));
    let dispatch = |module_type, module_id, args: &[ExprValue]| {
        registry
            .get(RlopKey::new(module_type, module_id, 1066))
            .unwrap()
            .dispatch(&mut vm(), args);
    };
    dispatch(0, OBJ_FG_SETTER_ID, &[int(0), int(10)]);
    dispatch(2, OBJ_FG_SETTER_ID, &[int(4), int(0), int(11)]);
    dispatch(1, OBJ_FG_RANGE_ID, &[int(1), int(3), int(20)]);
    dispatch(2, OBJ_FG_RANGE_ID, &[int(4), int(0), int(1), int(30)]);

    let snapshot = runtime.state_snapshot();
    for (slot, state) in [(0, 10), (1, 20), (2, 20), (3, 20), (4, 0)] {
        let object = snapshot.stack.get(GraphicsPlane::Foreground, slot).unwrap();
        assert_eq!(object.button_state, state);
        assert!(object.button_options.is_none());
    }
    for (child, state) in [(0, 30), (1, 30), (2, 0)] {
        assert_eq!(
            snapshot
                .stack
                .target(GraphicsObjectTarget::Child {
                    plane: GraphicsPlane::Foreground,
                    parent: 4,
                    child,
                })
                .unwrap()
                .button_state,
            state
        );
    }
    assert_eq!(
        snapshot
            .stack
            .get_layer(GraphicsLayer::BackgroundObject, 0)
            .unwrap()
            .button_state,
        0
    );
    assert_eq!(
        snapshot
            .stack
            .get(GraphicsPlane::Foreground, 1)
            .unwrap()
            .clone()
            .button_state,
        20
    );
    assert!(runtime.foreground_button_candidates(20).is_empty());

    dispatch(0, OBJ_FG_SETTER_ID, &[int(0)]);
    dispatch(0, OBJ_FG_SETTER_ID, &[int(256), int(99)]);
    dispatch(1, OBJ_FG_RANGE_ID, &[int(3), int(1), int(99)]);
    dispatch(1, OBJ_FG_RANGE_ID, &[int(1), int(256), int(99)]);
    dispatch(2, OBJ_FG_RANGE_ID, &[int(4), int(1), int(0), int(99)]);
    dispatch(2, OBJ_FG_RANGE_ID, &[int(4), int(0), int(256), int(99)]);
    let unchanged = runtime.state_snapshot();
    assert_eq!(
        unchanged
            .stack
            .get(GraphicsPlane::Foreground, 0)
            .unwrap()
            .button_state,
        10
    );
    assert_eq!(
        unchanged
            .stack
            .get(GraphicsPlane::Foreground, 1)
            .unwrap()
            .button_state,
        20
    );
    assert_eq!(
        unchanged
            .stack
            .target(GraphicsObjectTarget::Child {
                plane: GraphicsPlane::Foreground,
                parent: 4,
                child: 0,
            })
            .unwrap()
            .button_state,
        30
    );
}

#[test]
fn geometry_setters_sync_render_scale_and_require_a_surface() {
    let runtime = rt();
    ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
        .dispatch(&mut vm(), &[int(4), s(b"X")]);
    let set = |prop, args: &[ExprValue]| {
        ObjSetOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground, prop)
            .dispatch(&mut vm(), args);
    };
    let defaults = runtime.state_snapshot();
    let object = defaults.stack.get(GraphicsPlane::Foreground, 4).unwrap();
    assert_eq!(
        (
            object.geometry.classic_percent.x_percent,
            object.geometry.classic_percent.y_percent,
            object.geometry.hq_thousandths.x_thousandths,
            object.geometry.hq_thousandths.y_thousandths,
        ),
        (100, 100, 1000, 1000)
    );
    set(ObjSetProp::Scale, &[int(4), int(150)]);
    set(ObjSetProp::HqScale, &[int(4), int(1200)]);
    let partial = runtime.state_snapshot();
    let object = partial.stack.get(GraphicsPlane::Foreground, 4).unwrap();
    assert_eq!(
        (
            object.geometry.classic_percent.x_percent,
            object.geometry.classic_percent.y_percent,
            object.geometry.hq_thousandths.x_thousandths,
            object.geometry.hq_thousandths.y_thousandths,
        ),
        (150, 100, 1200, 1000)
    );
    // The render scale tracks rlvm's combined GetWidthScaleFactor:
    // x = 150% * 1200/1000 -> 150*1200/100 = 1800; y = 100% * 1 -> 1000.
    assert_eq!(
        (object.scale.x_thousandths, object.scale.y_thousandths),
        (1800, 1000)
    );
    for slot in 0..8 {
        set(
            ObjSetProp::Adjust,
            &[int(4), int(slot), int(slot), int(-slot)],
        );
    }
    set(ObjSetProp::AdjustX, &[int(4), int(6), int(-9)]);
    set(ObjSetProp::AdjustY, &[int(4), int(7), int(8)]);
    set(ObjSetProp::Scale, &[int(4), int(150), int(80)]);
    set(ObjSetProp::Width, &[int(4), int(-50)]);
    set(ObjSetProp::Height, &[int(4), int(0)]);
    set(ObjSetProp::HqScale, &[int(4), int(1200), int(700)]);
    set(ObjSetProp::HqScaleX, &[int(4), int(0)]);
    set(ObjSetProp::HqScaleY, &[int(4), int(-300)]);
    set(ObjSetProp::Origin, &[int(4), int(12), int(-3)]);
    set(ObjSetProp::OriginX, &[int(4), int(-1)]);

    let first = runtime.state_snapshot();
    let object = first.stack.get(GraphicsPlane::Foreground, 4).unwrap();
    assert_eq!((object.position.x, object.position.y), (0, 0));
    // rlvm combined scale factor with classic=(-50,0) and hq=(0,-300):
    // x = -50% * 0/1000 -> -50*0/100 = 0; y = 0% * -300/1000 -> 0.
    // Every objScale/objWidth/objHeight/objHqScale... setter keeps the
    // render scale in lock-step, so a scaled object composites correctly.
    assert_eq!(
        (object.scale.x_thousandths, object.scale.y_thousandths),
        (0, 0)
    );
    assert_eq!(
        (
            object.geometry.classic_percent.x_percent,
            object.geometry.classic_percent.y_percent,
            object.geometry.hq_thousandths.x_thousandths,
            object.geometry.hq_thousandths.y_thousandths,
        ),
        (-50, 0, 0, -300)
    );
    for (slot, adjust) in object.geometry.adjust_slots.iter().enumerate() {
        assert_eq!(
            (adjust.x, adjust.y),
            (
                if slot == 6 { -9 } else { slot as i32 },
                if slot == 7 { 8 } else { -(slot as i32) },
            )
        );
    }
    assert_eq!(
        object.geometry.origin_override,
        Some(GraphicsPosition { x: -1, y: -3 })
    );
    assert!(matches!(object.hit_region(None), HitRegion::Unavailable(_)));

    runtime.with_stack_mut(|stack| {
        let object = stack.get_mut(GraphicsPlane::Foreground, 4).unwrap();
        object.geometry.surface = Some(SurfaceGeometry {
            width: 11,
            height: 7,
            origin: GraphicsPosition { x: 5, y: -4 },
        });
        object.geometry.origin_override = None;
    });
    set(ObjSetProp::OriginX, &[int(4), int(21)]);
    assert_eq!(
        runtime
            .state_snapshot()
            .stack
            .get(GraphicsPlane::Foreground, 4)
            .unwrap()
            .geometry
            .origin_override,
        Some(GraphicsPosition { x: 21, y: -4 })
    );
}

#[test]
fn type2_geometry_setters_mutate_only_the_addressed_child() {
    let runtime = rt();
    ParentCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
        .dispatch(&mut vm(), &[int(4), int(2)]);
    for child in 0..2 {
        ChildCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
            .dispatch(&mut vm(), &[int(4), int(child), s(b"CHILD")]);
    }
    ObjSetOp::new(
        Arc::clone(&runtime),
        GraphicsPlane::Foreground,
        ObjSetProp::Scale,
    )
    .dispatch(&mut vm(), &[int(4), int(150), int(80)]);
    ObjSetOp::new(
        Arc::clone(&runtime),
        GraphicsPlane::Foreground,
        ObjSetProp::Adjust,
    )
    .dispatch(&mut vm(), &[int(4), int(0), int(2), int(-1)]);
    let mut registry = RlopRegistry::new();
    register_render_rlops(&mut registry, Arc::clone(&runtime));
    let dispatch = |opcode, args: &[ExprValue]| {
        registry
            .get(RlopKey::new(2, OBJ_FG_SETTER_ID, opcode))
            .expect("type-2 child setter")
            .dispatch(&mut vm(), args);
    };
    dispatch(1006, &[int(4), int(1), int(3), int(-2)]);
    dispatch(1007, &[int(4), int(1), int(3), int(-6)]);
    dispatch(1008, &[int(4), int(1), int(3), int(9)]);
    dispatch(1046, &[int(4), int(1), int(-50), int(0)]);
    dispatch(1061, &[int(4), int(1), int(0), int(-300)]);
    dispatch(1053, &[int(4), int(1), int(8), int(-1)]);

    let snapshot = runtime.state_snapshot();
    let child = snapshot
        .stack
        .target(GraphicsObjectTarget::Child {
            plane: GraphicsPlane::Foreground,
            parent: 4,
            child: 1,
        })
        .unwrap();
    assert_eq!(
        (
            child.geometry.adjust_slots[3].x,
            child.geometry.adjust_slots[3].y
        ),
        (-6, 9)
    );
    assert_eq!(
        (
            child.geometry.classic_percent.x_percent,
            child.geometry.classic_percent.y_percent,
            child.geometry.hq_thousandths.x_thousandths,
            child.geometry.hq_thousandths.y_thousandths,
            child.geometry.origin_override,
        ),
        (-50, 0, 0, -300, Some(GraphicsPosition { x: 8, y: -1 }))
    );
    assert!(matches!(child.hit_region(None), HitRegion::Unavailable(_)));
    let parent = snapshot.stack.get(GraphicsPlane::Foreground, 4).unwrap();
    assert_eq!(
        (
            parent.geometry.classic_percent.x_percent,
            parent.geometry.classic_percent.y_percent,
            parent.geometry.adjust_slots[0],
        ),
        (150, 80, GraphicsPosition { x: 2, y: -1 })
    );
    assert_eq!(
        snapshot
            .stack
            .target(GraphicsObjectTarget::Child {
                plane: GraphicsPlane::Foreground,
                parent: 4,
                child: 0,
            })
            .unwrap()
            .geometry
            .origin_override,
        None
    );
}

#[test]
fn bg_object_setter_mutates_bg_namespace_only() {
    let runtime = rt();
    ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Background)
        .dispatch(&mut vm(), &[int(2), s(b"BG")]);
    ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
        .dispatch(&mut vm(), &[int(2), s(b"FG")]);

    ObjSetOp::new(
        Arc::clone(&runtime),
        GraphicsPlane::Background,
        ObjSetProp::Move,
    )
    .dispatch(&mut vm(), &[int(2), int(10), int(20)]);

    let snap = runtime.state_snapshot();
    let bg = snap
        .stack
        .get_layer(GraphicsLayer::BackgroundObject, 2)
        .expect("bg object");
    let fg = snap
        .stack
        .get_layer(GraphicsLayer::ForegroundObject, 2)
        .expect("fg object");
    assert_eq!((bg.position.x, bg.position.y), (10, 20));
    assert_eq!((fg.position.x, fg.position.y), (0, 0));
}

// rlvm objFree(buf) clears the buffer; objFreeAll clears the plane.
#[test]
fn obj_management_free_and_free_all() {
    let runtime = rt();
    for buf in [0, 1, 2] {
        ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
            .dispatch(&mut vm(), &[int(buf), s(b"X")]);
    }
    ObjMgmtRenderOp::new(Arc::clone(&runtime), ObjMgmtOp::Free).dispatch(&mut vm(), &[int(1)]);
    assert!(
        runtime
            .state_snapshot()
            .stack
            .get(GraphicsPlane::Foreground, 1)
            .is_none()
    );
    assert_eq!(
        runtime
            .state_snapshot()
            .stack
            .plane_len(GraphicsPlane::Foreground),
        2
    );
    ObjMgmtRenderOp::new(Arc::clone(&runtime), ObjMgmtOp::FreeAll).dispatch(&mut vm(), &[]);
    assert_eq!(
        runtime
            .state_snapshot()
            .stack
            .plane_len(GraphicsPlane::Foreground),
        0
    );
}

#[test]
fn obj_management_alloc_is_registered_and_materialises_empty_foreground_slot() {
    let runtime = rt();
    let mut registry = RlopRegistry::new();
    register_render_rlops(&mut registry, Arc::clone(&runtime));

    for module_type in [0, 1, 2] {
        registry
            .get(RlopKey::new(module_type, OBJ_MGMT_ID, 1))
            .expect("objAlloc must be registered on every lattice type")
            .dispatch(&mut vm(), &[int(7)]);
    }

    let snapshot = runtime.state_snapshot();
    let object = snapshot
        .stack
        .get(GraphicsPlane::Foreground, 7)
        .expect("objAlloc must materialise its foreground slot");
    let Kind::Image { image_ref } = &object.kind else {
        panic!("objAlloc must create an image-slot object");
    };
    assert_eq!(image_ref.asset_key, "");
}

#[test]
fn registration_routes_child_creation_and_type2_object_setters() {
    let mut registry = RlopRegistry::new();
    let n = register_render_rlops(&mut registry, rt());
    assert_eq!(registry.len(), n);
    assert!(
        registry
            .get(RlopKey::new(0, OBJ_FG_CREATION_ID, 1500))
            .is_some()
    );
    assert!(
        registry
            .get(RlopKey::new(1, OBJ_FG_CREATION_ID, 1500))
            .is_some()
    );
    assert!(
        registry
            .get(RlopKey::new(2, OBJ_FG_CREATION_ID, 1000))
            .is_some()
    );
    assert!(
        registry
            .get(RlopKey::new(2, OBJ_FG_CREATION_ID, 1500))
            .is_some()
    );
    for opcode in [
        1006, 1007, 1008, 1046, 1047, 1048, 1053, 1054, 1055, 1061, 1062, 1063,
    ] {
        for module_type in [0, 1, 2] {
            assert!(
                registry
                    .get(RlopKey::new(module_type, OBJ_FG_SETTER_ID, opcode))
                    .is_some()
            );
        }
    }
    assert!(
        registry
            .get(RlopKey::new(2, OBJ_FG_SETTER_ID, 1064))
            .is_some()
    );
    assert!(
        registry
            .get(RlopKey::new(2, OBJ_FG_RANGE_ID, 1063))
            .is_none()
    );
}

#[test]
fn render_gaps_are_documented_not_empty() {
    assert!(RENDER_GAPS.len() >= 6);
    for (family, why) in RENDER_GAPS {
        assert!(!family.is_empty() && !why.is_empty());
    }
    assert!(!RLVM_PIXEL_DIFF_TOLERANCE.is_empty());
}
