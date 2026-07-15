use super::*;
use crate::graphics_objects::{
    GraphicsObjectKind as Kind, GraphicsObjectTarget, GraphicsPosition, HitRegion, SurfaceGeometry,
};

fn rt() -> Arc<GraphicsRuntime> {
    Arc::new(GraphicsRuntime::new())
}

fn vm() -> Vm {
    Vm::new(1, 0)
}

fn int(v: i32) -> ExprValue {
    ExprValue::Int(v)
}

fn s(v: &[u8]) -> ExprValue {
    ExprValue::Bytes(v.to_vec())
}

fn grp(runtime: &Arc<GraphicsRuntime>, op: GrpOp, args: &[ExprValue]) -> DispatchOutcome {
    GrpRenderOp::new(Arc::clone(runtime), op).dispatch(&mut vm(), args)
}

// rlvm `allocDC(dc, width, height)` — a blank DC + recorded size.
#[test]
fn grp_alloc_dc_records_allocation_and_bg_slot() {
    let runtime = rt();
    grp(&runtime, GrpOp::AllocDc, &[int(1), int(640), int(480)]);
    let snap = runtime.state_snapshot();
    let dc = snap.dc_allocation(1).expect("dc1 allocated");
    assert_eq!((dc.width, dc.height), (640, 480));
    assert!(snap.stack.get(GraphicsPlane::Background, 1).is_some());
}

// rlvm `wipe(dc, r, g, b)` — dc filled with an opaque RGB triplet.
#[test]
fn grp_wipe_fills_dc_with_opaque_rgb() {
    let runtime = rt();
    grp(
        &runtime,
        GrpOp::Wipe,
        &[int(0), int(0x10), int(0x20), int(0x30)],
    );
    let snap = runtime.state_snapshot();
    match &snap.stack.get(GraphicsPlane::Background, 0).unwrap().kind {
        Kind::Wipe { colour } => {
            assert_eq!(
                (colour.red, colour.green, colour.blue, colour.alpha),
                (0x10, 0x20, 0x30, 0xFF)
            );
        }
        Kind::Image { .. } => panic!("expected Wipe"),
    }
}

// rlvm grpBuffer loads to an OFF-SCREEN dc (filename FIRST, then dc).
#[test]
fn grp_buffer_loads_offscreen_then_display_promotes_to_dc0() {
    let runtime = rt();
    grp(&runtime, GrpOp::Buffer, &[s(b"EV"), int(3)]);
    let snap = runtime.state_snapshot();
    let buf = snap.stack.get(GraphicsPlane::Background, 3).unwrap();
    assert!(!buf.visible);
    assert!(
        snap.stack
            .get(GraphicsPlane::Background, SCREEN_DC_SLOT)
            .is_none()
    );
    grp(&runtime, GrpOp::Display, &[int(3), int(0)]);
    let snap = runtime.state_snapshot();
    let screen = snap
        .stack
        .get(GraphicsPlane::Background, SCREEN_DC_SLOT)
        .unwrap();
    assert!(screen.visible);
    match &screen.kind {
        Kind::Image { image_ref } => assert_eq!(image_ref.asset_key, "EV"),
        Kind::Wipe { .. } => panic!("expected Image"),
    }
}

// rlvm grpOpenBg loads straight to DC0 (the screen), filename FIRST.
#[test]
fn grp_open_screen_loads_dc0_visible() {
    let runtime = rt();
    grp(&runtime, GrpOp::OpenScreen, &[s(b"BG10"), int(0)]);
    let snap = runtime.state_snapshot();
    let screen = snap
        .stack
        .get(GraphicsPlane::Background, SCREEN_DC_SLOT)
        .unwrap();
    assert!(screen.visible);
    match &screen.kind {
        Kind::Image { image_ref } => assert_eq!(image_ref.asset_key, "BG10"),
        Kind::Wipe { .. } => panic!("expected Image"),
    }
    assert_eq!(snap.bg_canvas.unwrap().asset_key, "BG10");
}

// rlvm "???" sentinel filename means "keep current" — no load.
#[test]
fn grp_open_screen_skips_triple_question_sentinel() {
    let runtime = rt();
    grp(&runtime, GrpOp::OpenScreen, &[s(b"???"), int(0)]);
    assert!(
        runtime
            .state_snapshot()
            .stack
            .get(GraphicsPlane::Background, 0)
            .is_none()
    );
}

// rlvm grpCopy(src, dst): copy DC src → DC dst.
#[test]
fn grp_copy_clones_src_dc_to_dst() {
    let runtime = rt();
    grp(&runtime, GrpOp::Buffer, &[s(b"A"), int(1)]);
    grp(&runtime, GrpOp::Copy, &[int(1), int(2)]);
    let snap = runtime.state_snapshot();
    match &snap.stack.get(GraphicsPlane::Background, 2).unwrap().kind {
        Kind::Image { image_ref } => assert_eq!(image_ref.asset_key, "A"),
        Kind::Wipe { .. } => panic!("expected Image"),
    }
}

// rlvm objOfFile(buf, filename[, visible, x, y, pattern]).
#[test]
fn obj_of_file_creates_image_with_trailing_placement() {
    let runtime = rt();
    ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground).dispatch(
        &mut vm(),
        &[int(5), s(b"CHAR"), int(1), int(10), int(20), int(3)],
    );
    let snap = runtime.state_snapshot();
    let o = snap.stack.get(GraphicsPlane::Foreground, 5).unwrap();
    match &o.kind {
        Kind::Image { image_ref } => {
            assert_eq!(image_ref.asset_key, "CHAR");
            assert_eq!(image_ref.region_index, Some(3));
        }
        Kind::Wipe { .. } => panic!("expected Image"),
    }
    assert!(o.visible);
    assert_eq!((o.position.x, o.position.y), (10, 20));
    assert_eq!(o.layer_order, OBJ_FG_LAYER_BASE + 5);
}

#[test]
fn only_direct_file_creation_forms_are_file_backed() {
    let runtime = rt();
    let mut registry = RlopRegistry::new();
    register_render_rlops(&mut registry, Arc::clone(&runtime));
    let dispatch = |module_type, opcode, args: &[ExprValue]| {
        registry
            .get(RlopKey::new(module_type, OBJ_FG_CREATION_ID, opcode))
            .unwrap()
            .dispatch(&mut vm(), args);
    };
    for (module_type, opcode, slot) in [(0, 1000, 0), (1, 1001, 1)] {
        dispatch(module_type, opcode, &[int(slot), s(b"SAME")]);
        let snapshot = runtime.state_snapshot();
        let object = snapshot
            .stack
            .get(GraphicsPlane::Foreground, slot as usize)
            .unwrap();
        assert_eq!(object.image_provenance, ImageProvenance::FileBacked);
        assert_eq!(object.clone().image_provenance, ImageProvenance::FileBacked);
        assert!(matches!(&object.kind, Kind::Image { image_ref } if image_ref.asset_key == "SAME"));
    }
    ParentCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
        .dispatch(&mut vm(), &[int(4), int(2)]);
    for (opcode, child) in [(1000, 0), (1001, 1)] {
        dispatch(2, opcode, &[int(4), int(child), s(b"SAME")]);
        assert_eq!(
            runtime
                .state_snapshot()
                .stack
                .target(GraphicsObjectTarget::Child {
                    plane: GraphicsPlane::Foreground,
                    parent: 4,
                    child: child as usize,
                })
                .unwrap()
                .image_provenance,
            ImageProvenance::FileBacked
        );
    }
    for (index, opcode) in [1003, 1005, 1100, 1101, 1200, 1300, 1400, 1500]
        .into_iter()
        .enumerate()
    {
        let slot = index + 10;
        dispatch(0, opcode, &[int(slot as i32), s(b"SAME")]);
        assert_eq!(
            runtime
                .state_snapshot()
                .stack
                .get(GraphicsPlane::Foreground, slot)
                .unwrap()
                .image_provenance,
            ImageProvenance::Placeholder
        );
    }
    dispatch(2, 1003, &[int(4), int(0), s(b"SAME")]);
    let snapshot = runtime.state_snapshot();
    let placeholder = snapshot
        .stack
        .target(GraphicsObjectTarget::Child {
            plane: GraphicsPlane::Foreground,
            parent: 4,
            child: 0,
        })
        .unwrap();
    assert_eq!(placeholder.image_provenance, ImageProvenance::Placeholder);
    assert_eq!(
        placeholder.clone().image_provenance,
        ImageProvenance::Placeholder
    );
}

#[test]
fn bg_and_fg_object_creation_same_buf_do_not_overwrite() {
    let runtime = rt();
    ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Background)
        .dispatch(&mut vm(), &[int(5), s(b"BG_OBJ")]);
    ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
        .dispatch(&mut vm(), &[int(5), s(b"FG_OBJ")]);

    let snap = runtime.state_snapshot();
    let bg = snap
        .stack
        .get_layer(GraphicsLayer::BackgroundObject, 5)
        .expect("bg object remains");
    let fg = snap
        .stack
        .get_layer(GraphicsLayer::ForegroundObject, 5)
        .expect("fg object remains");
    match &bg.kind {
        Kind::Image { image_ref } => assert_eq!(image_ref.asset_key, "BG_OBJ"),
        Kind::Wipe { .. } => panic!("expected bg image"),
    }
    match &fg.kind {
        Kind::Image { image_ref } => assert_eq!(image_ref.asset_key, "FG_OBJ"),
        Kind::Wipe { .. } => panic!("expected fg image"),
    }
    assert_eq!(bg.layer_order, OBJ_BG_LAYER_BASE + 5);
    assert_eq!(fg.layer_order, OBJ_FG_LAYER_BASE + 5);
}

#[test]
fn parent_and_child_creation_route_only_to_sparse_children() {
    let runtime = rt();
    ParentCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
        .dispatch(&mut vm(), &[int(4), int(2), int(0), int(30), int(40)]);
    ObjSetOp::new(
        Arc::clone(&runtime),
        GraphicsPlane::Foreground,
        ObjSetProp::Move,
    )
    .dispatch(&mut vm(), &[int(4), int(31), int(41)]);
    ChildCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground).dispatch(
        &mut vm(),
        &[int(4), int(1), s(b"CHILD"), int(0), int(7), int(9), int(3)],
    );
    let child = GraphicsObjectTarget::Child {
        plane: GraphicsPlane::Foreground,
        parent: 4,
        child: 1,
    };
    let snapshot = runtime.state_snapshot();
    let object = snapshot.stack.target(child).expect("child object");
    assert_eq!((object.position.x, object.position.y), (7, 9));
    assert!(matches!(
        &object.kind,
        Kind::Image { image_ref }
            if image_ref.asset_key == "CHILD" && image_ref.region_index == Some(3)
    ));
    assert!(
        snapshot
            .stack
            .get_layer(GraphicsLayer::ForegroundObject, 1)
            .is_none()
    );
    let parent_object = snapshot
        .stack
        .get_layer(GraphicsLayer::ForegroundObject, 4)
        .expect("materialized parent object");
    assert!(!parent_object.visible);
    assert_eq!(
        (parent_object.position.x, parent_object.position.y),
        (31, 41)
    );
    assert_eq!(
        snapshot
            .stack
            .parent(GraphicsPlane::Foreground, 4)
            .unwrap()
            .declared_capacity,
        2
    );

    // Out-of-range and malformed child routes neither create a child nor
    // lazily materialise a parent.
    ChildCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
        .dispatch(&mut vm(), &[int(4), int(2), s(b"NO")]);
    ChildCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
        .dispatch(&mut vm(), &[int(6), s(b"MALFORMED")]);
    assert!(
        runtime
            .state_snapshot()
            .stack
            .parent(GraphicsPlane::Foreground, 6)
            .is_none()
    );

    // An absent parent becomes sparse at the default 256 capacity only
    // for an in-range child, and snapshots remain deeply detached.
    ChildCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
        .dispatch(&mut vm(), &[int(5), int(255), s(b"LAZY")]);
    let before_replace = runtime.state_snapshot();
    assert_eq!(
        before_replace
            .stack
            .parent(GraphicsPlane::Foreground, 5)
            .unwrap()
            .declared_capacity,
        256
    );
    let lazy_parent = before_replace
        .stack
        .get_layer(GraphicsLayer::ForegroundObject, 5)
        .expect("default lazy parent object");
    assert!(lazy_parent.visible);
    assert_eq!((lazy_parent.position.x, lazy_parent.position.y), (0, 0));
    ChildCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
        .dispatch(&mut vm(), &[int(5), int(256), s(b"OUT")]);
    ParentCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
        .dispatch(&mut vm(), &[int(4), int(1)]);
    let replaced = runtime.state_snapshot();
    assert!(replaced.stack.target(child).is_none());
    let parent_object = replaced
        .stack
        .get_layer(GraphicsLayer::ForegroundObject, 4)
        .expect("retained parent object");
    assert!(!parent_object.visible);
    assert_eq!(
        (parent_object.position.x, parent_object.position.y),
        (31, 41)
    );
    assert!(before_replace.stack.target(child).is_some());
}

#[test]
fn child_setters_mutate_only_the_exact_foreground_child() {
    let runtime = rt();
    for plane in [GraphicsPlane::Foreground, GraphicsPlane::Background] {
        ParentCreateOp::new(Arc::clone(&runtime), plane).dispatch(&mut vm(), &[int(4), int(2)]);
        ChildCreateOp::new(Arc::clone(&runtime), plane)
            .dispatch(&mut vm(), &[int(4), int(1), s(b"CHILD")]);
    }
    ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
        .dispatch(&mut vm(), &[int(1), s(b"TOP")]);
    let set = |prop, args: &[ExprValue]| {
        ObjSetOp::new_child(Arc::clone(&runtime), GraphicsPlane::Foreground, prop)
            .dispatch(&mut vm(), args);
    };
    set(ObjSetProp::Move, &[int(4), int(1), int(7), int(9)]);
    set(ObjSetProp::Scale, &[int(4), int(1), int(700), int(1300)]);
    set(ObjSetProp::Show, &[int(4), int(1), int(0)]);
    set(ObjSetProp::PattNo, &[int(4), int(1), int(5)]);
    set(ObjSetProp::Move, &[int(4), int(2), int(99), int(99)]);
    set(ObjSetProp::Move, &[int(4)]);
    set(ObjSetProp::Move, &[int(256), int(1), int(99), int(99)]);

    let snap = runtime.state_snapshot();
    let fg_child = snap
        .stack
        .target(GraphicsObjectTarget::Child {
            plane: GraphicsPlane::Foreground,
            parent: 4,
            child: 1,
        })
        .expect("fg child");
    assert_eq!((fg_child.position.x, fg_child.position.y), (7, 9));
    // rlvm combined scale factor with classic=(700,1300), hq=(1000,1000):
    // x = 700% * 1 -> 700*1000/100 = 7000; y = 1300% * 1 -> 13000.
    assert_eq!(
        (fg_child.scale.x_thousandths, fg_child.scale.y_thousandths),
        (7000, 13000)
    );
    assert_eq!(
        (
            fg_child.geometry.classic_percent.x_percent,
            fg_child.geometry.classic_percent.y_percent,
        ),
        (700, 1300)
    );
    assert!(!fg_child.visible);
    assert!(matches!(
        &fg_child.kind,
        Kind::Image { image_ref } if image_ref.region_index == Some(5)
    ));
    assert_eq!(
        snap.stack
            .get_layer(GraphicsLayer::ForegroundObject, 1)
            .and_then(|object| match &object.kind {
                Kind::Image { image_ref } => Some(image_ref.asset_key.as_str()),
                Kind::Wipe { .. } => None,
            }),
        Some("TOP")
    );
    let bg_child = snap
        .stack
        .target(GraphicsObjectTarget::Child {
            plane: GraphicsPlane::Background,
            parent: 4,
            child: 1,
        })
        .expect("bg child");
    assert_eq!((bg_child.position.x, bg_child.position.y), (0, 0));
    assert!(
        snap.stack
            .target(GraphicsObjectTarget::Child {
                plane: GraphicsPlane::Foreground,
                parent: 4,
                child: 2,
            })
            .is_none()
    );
}

// rlvm object setters: Move / Alpha / Show / Layer / PattNo (buf FIRST).

#[path = "tests_more.rs"]
mod more;
