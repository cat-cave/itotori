use super::*;

#[test]
fn select_objbtn_uses_slot_ordered_foreground_values_without_text() {
    use crate::graphics_objects::{
        ButtonOptions, GraphicsAlpha, GraphicsColourTone, GraphicsLayer, GraphicsObject,
        GraphicsObjectKind, GraphicsPosition, GraphicsScale, HitRect, HitRegion,
        HitRegionUnavailable, ImageRef, SurfaceGeometry, WipeColour,
    };

    let sink = Arc::new(CollectingSink::new());
    let graphics = Arc::new(GraphicsRuntime::new());
    let mut image_button = GraphicsObject::image("missing-g00");
    image_button.kind = GraphicsObjectKind::Image {
        image_ref: ImageRef {
            asset_key: "missing-g00".to_string(),
            region_index: Some(12),
        },
    };
    image_button.position = GraphicsPosition { x: 31, y: -9 };
    image_button.scale = GraphicsScale {
        x_thousandths: 750,
        y_thousandths: 1250,
    };
    image_button.alpha = GraphicsAlpha(137);
    image_button.colour_tone = GraphicsColourTone {
        red_thousandths: 100,
        green_thousandths: -200,
        blue_thousandths: 300,
    };
    image_button.layer_order = 41;
    image_button.visible = false;
    image_button.geometry.surface = Some(SurfaceGeometry {
        width: 40,
        height: 30,
        origin: GraphicsPosition { x: 5, y: 7 },
    });
    image_button.button_options = Some(ButtonOptions {
        action: 0,
        se: 0,
        group: 5,
        button_number: 7,
    });
    let expected_image = image_button.clone();

    let mut wipe_button = GraphicsObject::wipe(WipeColour {
        red: 1,
        green: 2,
        blue: 3,
        alpha: 4,
    });
    wipe_button.button_options = Some(ButtonOptions {
        action: 0,
        se: 0,
        group: 5,
        button_number: 2,
    });
    let expected_wipe = wipe_button.clone();
    graphics.with_stack_mut(|stack| {
        stack
            .set_layer(GraphicsLayer::ForegroundObject, 3, image_button)
            .expect("slot");
        stack
            .set_layer(GraphicsLayer::ForegroundObject, 11, wipe_button)
            .expect("slot");
    });
    let runtime = Arc::new(SelRuntime::with_graphics(
        Arc::clone(&sink) as Arc<dyn TextSurfaceSink>,
        Arc::clone(&graphics),
    ));
    let outcome = SelectObjbtnOp::new(Arc::clone(&runtime))
        .dispatch(&mut Vm::new(1, 0), &[ExprValue::Int(5)]);
    let DispatchOutcome::Yield {
        longop_id,
        private_state,
    } = outcome
    else {
        panic!("object group must yield");
    };
    let carrier = ObjectSelectLongOp::try_from_longop(&LongOp::new(longop_id, private_state))
        .expect("object carrier");
    assert_eq!(carrier.return_values(), &[7, 2]);
    assert!(sink.lines.lock().expect("lock").is_empty());
    // Reusing or mutating slots after the yield must not alter the
    // prompt-time snapshots detached from the graphics mutex scan.
    graphics.with_stack_mut(|stack| {
        stack
            .set_layer(
                GraphicsLayer::ForegroundObject,
                3,
                GraphicsObject::image("reused-after-yield"),
            )
            .expect("slot");
        stack
            .get_layer_mut(GraphicsLayer::ForegroundObject, 11)
            .expect("slot")
            .visible = false;
    });
    let prompts = runtime.take_prompts();
    assert_eq!(prompts.len(), 1);
    let prompt = &prompts[0];
    assert_eq!(prompt.longop_id, longop_id);
    assert!(!prompt.cancelable);
    assert!(prompt.option_line_ids.is_empty());
    let SelectionPromptKind::ObjectButtons { group, options } = &prompt.kind else {
        panic!("object selection must produce object-button prompt");
    };
    assert_eq!(*group, 5);
    assert_eq!(options.len(), 2);
    assert_eq!(options[0].display_index, 0);
    assert_eq!(options[0].button_number, 7);
    assert_eq!(options[0].fg_slot, 3);
    assert_eq!(options[0].visual_snapshot, expected_image);
    assert_eq!(options[1].display_index, 1);
    assert_eq!(options[1].button_number, 2);
    assert_eq!(options[1].fg_slot, 11);
    assert_eq!(options[1].visual_snapshot, expected_wipe);
    assert_eq!(
        options[0].hit_region,
        HitRegion::Known(HitRect {
            x: 26,
            y: -16,
            width: 40,
            height: 30,
        }),
        "the prompt must snapshot the decoded object geometry"
    );
    assert_eq!(
        options[1].hit_region,
        HitRegion::Unavailable(HitRegionUnavailable::AssetPatternGeometryUnavailable)
    );
    assert!(options.iter().all(|option| {
        option.candidate_scope == ObjectButtonCandidateScope::TopLevelForegroundOnly
    }));
    assert!(matches!(
        &options[0].visual_snapshot.kind,
        GraphicsObjectKind::Image { image_ref }
            if image_ref.asset_key == "missing-g00" && image_ref.region_index == Some(12)
    ));
    let render_option = options[0]
        .render_choice_option()
        .expect("decoded image button must produce renderer metadata");
    assert_eq!(render_option.fg_slot, 3);
    assert_eq!(render_option.bounds.x, 26);
    assert_eq!(render_option.bounds.y, -16);
    assert_eq!(render_option.art.asset_key, "missing-g00");
    assert!(matches!(
        options[1].render_choice_option(),
        Err(ObjectButtonChoiceWindowBuildError::GeometryUnavailable { .. })
    ));
    assert!(matches!(
        options[1].visual_snapshot.kind,
        GraphicsObjectKind::Wipe { .. }
    ));
    assert!(matches!(
        SelectObjbtnOp::new(Arc::clone(&runtime))
            .dispatch(&mut Vm::new(1, 0), &[ExprValue::Int(8)]),
        DispatchOutcome::Advance
    ));
    assert_eq!(
        runtime.take_warnings(),
        vec![SelRuntimeWarning::ObjectButtonCandidatesEmpty { group: 8 }]
    );
}

#[test]
fn select_objbtn_cancel_overloads_ignore_select_se_and_set_cancelable() {
    use crate::graphics_objects::{ButtonOptions, GraphicsLayer, GraphicsObject};

    let sink = Arc::new(CollectingSink::new());
    let graphics = Arc::new(GraphicsRuntime::new());
    graphics.with_stack_mut(|stack| {
        for (slot, number) in [(11, 2), (3, 7)] {
            let mut object = GraphicsObject::image("test");
            object.button_options = Some(ButtonOptions {
                action: 0,
                se: 0,
                group: 5,
                button_number: number,
            });
            stack
                .set_layer(GraphicsLayer::ForegroundObject, slot, object)
                .expect("slot");
        }
    });
    let runtime = Arc::new(SelRuntime::with_graphics(
        Arc::clone(&sink) as Arc<dyn TextSurfaceSink>,
        graphics,
    ));
    for args in [
        &[ExprValue::Int(5)][..],
        &[ExprValue::Int(5), ExprValue::Int(99)][..],
    ] {
        let DispatchOutcome::Yield {
            longop_id,
            private_state,
        } = SelectObjbtnCancelOp::new(Arc::clone(&runtime)).dispatch(&mut Vm::new(1, 0), args)
        else {
            panic!("cancel object group must yield");
        };
        let carrier = ObjectSelectLongOp::try_from_longop(&LongOp::new(longop_id, private_state))
            .expect("object carrier");
        assert_eq!(carrier.return_values(), &[7, 2]);
        assert!(carrier.is_cancelable());
    }
    assert!(sink.lines.lock().expect("lock").is_empty());
    let prompts = runtime.take_prompts();
    assert_eq!(prompts.len(), 2);
    assert!(prompts.iter().all(|prompt| {
        prompt.cancelable
            && prompt.option_line_ids.is_empty()
            && matches!(
                &prompt.kind,
                SelectionPromptKind::ObjectButtons { group: 5, options }
                    if options.iter().map(|option| (
                        option.display_index,
                        option.button_number,
                        option.fg_slot,
                    )).collect::<Vec<_>>() == vec![(0, 7, 3), (1, 2, 11)]
            )
    }));
    assert!(matches!(
        SelectObjbtnCancelOp::new(Arc::clone(&runtime))
            .dispatch(&mut Vm::new(1, 0), &[ExprValue::Int(8)]),
        DispatchOutcome::Advance
    ));
    assert_eq!(
        runtime.take_warnings(),
        vec![SelRuntimeWarning::ObjectButtonCandidatesEmpty { group: 8 }]
    );
}
