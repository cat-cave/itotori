use super::*;

fn kernel_input() -> DstRectKernelInput {
    DstRectKernelInput {
        surface: [11.0, 7.0],
        child_position: [100.0, 50.0],
        child_adjust: [18.0, 7.0],
        origin: [0.0, 5.0],
        child_factor: [1.3, 0.7],
        parent: None,
    }
}

#[test]
fn dst_rect_kernel_pins_oracle_order_and_truncation() {
    // rlvm `DstRect` hand-trace (no parent), src=(11,7):
    //   center_x = trunc(100 + 18 - 0 + 11/2=5.5) = trunc(123.5) = 123
    //   half_x = trunc(11 * 1 * 1.3 / 2 = 7.15) = 7
    //   x = 123 - 7 = 116; width = 2*7 = 14
    //   center_y = trunc(50 + 7 - 5 + 7/2=3.5) = trunc(55.5) = 55
    //   half_y = trunc(7 * 1 * 0.7 / 2 = 2.45) = 2
    //   y = 55 - 2 = 53; height = 2*2 = 4
    assert_eq!(
        derive_dst_rect(kernel_input()),
        Ok(HitRect {
            x: 116,
            y: 53,
            width: 14,
            height: 4,
        })
    );
    // rlvm `DstRect` hand-trace WITH a parent — the y axis is the
    // discriminating case for the separate `center` truncation:
    //   center_y_core = -10 + 2 - (-2) + 7/2=3.5 = -2.5; trunc(-2.5) = -2
    //   center_y = -2 + parent.y(50) + parent.adj(8) = 56
    //   half_y = trunc(7 * (2.0*0.75=1.5) * (0.8*0.5=0.4) / 2 = 2.1) = 2
    //   y = 56 - 2 = 54 (folding parent into the pre-trunc sum would give
    //   trunc(-2.5 + 58 - 2.1) = trunc(53.4) = 53, which is WRONG).
    //   center_x_core = 20 + 6 - 3 + 5.5 = 28.5; trunc = 28
    //   center_x = 28 + 100 + (-5) = 123; half_x = trunc(11*0.75*1.8/2=7.425)=7
    //   x = 123 - 7 = 116; width = 2*7 = 14; height = 2*2 = 4
    assert_eq!(
        derive_dst_rect(DstRectKernelInput {
            surface: [11.0, 7.0],
            child_position: [20.0, -10.0],
            child_adjust: [6.0, 2.0],
            origin: [3.0, -2.0],
            child_factor: [1.5 * 1.2, 0.8 * 0.5],
            parent: Some(DstRectKernelParent {
                position: [100.0, 50.0],
                adjust: [-5.0, 8.0],
                factor: [0.5 * 1.5, 2.0 * 0.75],
            }),
        }),
        Ok(HitRect {
            x: 116,
            y: 54,
            width: 14,
            height: 4,
        })
    );
    // Discriminates rlvm's SEPARATE center/half truncation from a single
    // `trunc(center - half)`. src=(10,10), scale 0.3, no parent:
    //   center = trunc(0 + 0 - 0 + 10/2=5.0) = 5
    //   half = trunc(10 * 1 * 0.3 / 2 = 1.5) = 1
    //   x = y = 5 - 1 = 4; width = height = 2*1 = 2
    // A single-truncation kernel yields trunc(5.0 - 1.5)=trunc(3.5)=3 (WRONG).
    assert_eq!(
        derive_dst_rect(DstRectKernelInput {
            surface: [10.0, 10.0],
            child_position: [0.0, 0.0],
            child_adjust: [0.0, 0.0],
            origin: [0.0, 0.0],
            child_factor: [0.3, 0.3],
            parent: None,
        }),
        Ok(HitRect {
            x: 4,
            y: 4,
            width: 2,
            height: 2,
        })
    );
    let mut negative = kernel_input();
    negative.child_factor = [-0.5, 0.5];
    let rect = derive_dst_rect(negative).expect("finite signed rectangle");
    assert_eq!((rect.width, rect.height), (-4, 2));
    let mut nonfinite = kernel_input();
    nonfinite.surface[0] = f32::NAN;
    assert_eq!(
        derive_dst_rect(nonfinite),
        Err(HitRegionUnavailable::NonFiniteTransform)
    );
    let mut out_of_range = kernel_input();
    out_of_range.child_factor[0] = 1_000_000_000.0;
    assert_eq!(
        derive_dst_rect(out_of_range),
        Err(HitRegionUnavailable::OutOfRangeTransform)
    );
}

#[test]
fn object_geometry_uses_explicit_child_surface_only() {
    let mut child = GraphicsObject::image("child");
    child.position = GraphicsPosition { x: 100, y: 50 };
    child.geometry.surface = Some(SurfaceGeometry {
        width: 20,
        height: 10,
        origin: GraphicsPosition { x: 4, y: 2 },
    });
    child.geometry.adjust_slots[0] = GraphicsPosition { x: 17, y: 2 };
    child.geometry.hq_thousandths = GraphicsScale {
        x_thousandths: 700,
        y_thousandths: 400,
    };
    assert_eq!(
        child.hit_region(None),
        HitRegion::Known(HitRect {
            x: 116,
            y: 53,
            width: 14,
            height: 4,
        })
    );
    let snapshot = child.clone();
    for adjust in &mut child.geometry.adjust_slots {
        adjust.x += 1;
        adjust.y += 1;
    }
    assert_eq!(
        child.hit_region(None),
        HitRegion::Known(HitRect {
            x: 124,
            y: 61,
            width: 14,
            height: 4,
        })
    );
    child.geometry.origin_override = Some(GraphicsPosition::ORIGIN);
    assert_ne!(child.hit_region(None), snapshot.hit_region(None));
    assert_eq!(snapshot.geometry.origin_override, None);

    let mut parent = GraphicsObject::image("parent");
    parent.position = GraphicsPosition { x: 3, y: -2 };
    parent.geometry.adjust_slots[7] = GraphicsPosition { x: 1, y: 2 };
    assert_ne!(
        snapshot.hit_region(None),
        snapshot.hit_region(Some(&parent))
    );
    let unknown = GraphicsObject::image("asset-only");
    assert_eq!(
        unknown.hit_region(Some(&parent)),
        HitRegion::Unavailable(HitRegionUnavailable::AssetPatternGeometryUnavailable)
    );
    assert_eq!(
        GraphicsObject::image("text").geometry.unavailable,
        HitRegionUnavailable::AssetPatternGeometryUnavailable
    );
}

#[test]
fn new_stack_is_empty() {
    let stack = GraphicsObjectStack::new();
    assert_eq!(stack.len(), 0);
    assert!(stack.is_empty());
    assert_eq!(stack.plane_len(GraphicsPlane::Background), 0);
    assert_eq!(stack.plane_len(GraphicsPlane::Foreground), 0);
}

#[test]
fn slot_at_capacity_is_rejected() {
    let mut stack = GraphicsObjectStack::new();
    let result = stack.set(
        GraphicsPlane::Foreground,
        GRAPHICS_OBJECT_SLOT_COUNT,
        GraphicsObject::wipe(WipeColour::BLACK),
    );
    assert_eq!(
        result,
        Err(GraphicsStackError::SlotOutOfRange {
            plane: GraphicsPlane::Foreground,
            slot: GRAPHICS_OBJECT_SLOT_COUNT,
        })
    );
    assert_eq!(stack.len(), 0);
}

#[test]
fn fills_full_plane_then_rejects_next() {
    let mut stack = GraphicsObjectStack::new();
    for slot in 0..GRAPHICS_OBJECT_SLOT_COUNT {
        stack
            .set(
                GraphicsPlane::Foreground,
                slot,
                GraphicsObject::image(format!("asset-{slot}")),
            )
            .expect("in-range slot accepted");
    }
    assert_eq!(stack.plane_len(GraphicsPlane::Foreground), 256);
    assert_eq!(stack.plane_len(GraphicsPlane::Background), 0);
    let result = stack.set(
        GraphicsPlane::Foreground,
        GRAPHICS_OBJECT_SLOT_COUNT,
        GraphicsObject::image("overflow"),
    );
    assert!(matches!(
        result,
        Err(GraphicsStackError::SlotOutOfRange { .. })
    ));
}

#[test]
fn iter_allocated_visits_background_before_foreground() {
    let mut stack = GraphicsObjectStack::new();
    stack
        .set(GraphicsPlane::Foreground, 5, GraphicsObject::image("fg5"))
        .expect("set fg");
    stack
        .set(GraphicsPlane::Background, 9, GraphicsObject::image("bg9"))
        .expect("set bg");
    let visited: Vec<(GraphicsPlane, usize)> = stack
        .iter_allocated()
        .map(|(plane, slot, _)| (plane, slot))
        .collect();
    assert_eq!(
        visited,
        vec![
            (GraphicsPlane::Background, 9),
            (GraphicsPlane::Foreground, 5),
        ]
    );
}

#[test]
fn bg_and_fg_object_layers_can_share_slot_number() {
    let mut stack = GraphicsObjectStack::new();
    stack
        .set_layer(
            GraphicsLayer::BackgroundObject,
            7,
            GraphicsObject::image("bg-object"),
        )
        .expect("set bg object");
    stack
        .set_layer(
            GraphicsLayer::ForegroundObject,
            7,
            GraphicsObject::image("fg-object"),
        )
        .expect("set fg object");

    assert_eq!(stack.len(), 2);
    assert_eq!(stack.layer_len(GraphicsLayer::BackgroundObject), 1);
    assert_eq!(stack.layer_len(GraphicsLayer::ForegroundObject), 1);
    assert_eq!(
        stack
            .get_layer(GraphicsLayer::BackgroundObject, 7)
            .and_then(|object| match &object.kind {
                GraphicsObjectKind::Image { image_ref } => Some(image_ref.asset_key.as_str()),
                GraphicsObjectKind::Wipe { .. } => None,
            }),
        Some("bg-object")
    );
    assert_eq!(
        stack
            .get_layer(GraphicsLayer::ForegroundObject, 7)
            .and_then(|object| match &object.kind {
                GraphicsObjectKind::Image { image_ref } => Some(image_ref.asset_key.as_str()),
                GraphicsObjectKind::Wipe { .. } => None,
            }),
        Some("fg-object")
    );
}

#[test]
fn clear_frees_a_slot() {
    let mut stack = GraphicsObjectStack::new();
    stack
        .set(GraphicsPlane::Foreground, 7, GraphicsObject::image("a"))
        .expect("set");
    assert_eq!(stack.plane_len(GraphicsPlane::Foreground), 1);
    stack
        .clear(GraphicsPlane::Foreground, 7)
        .expect("clear in range");
    assert_eq!(stack.plane_len(GraphicsPlane::Foreground), 0);
    assert!(stack.get(GraphicsPlane::Foreground, 7).is_none());
}

#[test]
fn slot_total_constant_matches_three_render_layers() {
    assert_eq!(GRAPHICS_OBJECT_TOTAL_SLOTS, GRAPHICS_OBJECT_SLOT_COUNT * 3);
}
