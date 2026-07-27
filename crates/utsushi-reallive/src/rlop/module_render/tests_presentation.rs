use super::*;
use crate::graphics_objects::WipeColour;
use crate::render_pipeline::{RenderPass, encode_png_rgba_deterministic, sha256_hex};

/// A scene background presentation is the boundary between render contexts:
/// menu foreground furniture is discarded, while background objects are
/// promoted exactly once.
#[test]
fn grp_open_screen_clears_menu_foreground_before_story_background() {
    let runtime = rt();
    ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
        .dispatch(&mut vm(), &[int(8), s(b"MENU_BUTTON")]);
    ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Background)
        .dispatch(&mut vm(), &[int(9), s(b"STORY_PERSISTENT")]);

    grp(&runtime, GrpOp::OpenScreen, &[s(b"STORY_BG"), int(0)]);

    let snapshot = runtime.state_snapshot();
    assert!(
        snapshot
            .stack
            .get_layer(GraphicsLayer::ForegroundObject, 8)
            .is_none(),
        "the old menu object must be removed when the story background presents"
    );
    assert!(
        snapshot
            .stack
            .get_layer(GraphicsLayer::BackgroundObject, 9)
            .is_none(),
        "background object plane must be emptied by presentation"
    );
    assert!(matches!(
        snapshot
            .stack
            .get_layer(GraphicsLayer::ForegroundObject, 9)
            .map(|object| &object.kind),
        Some(Kind::Image { image_ref }) if image_ref.asset_key == "STORY_PERSISTENT"
    ));
    assert!(matches!(
        snapshot.stack.get(GraphicsPlane::Background, SCREEN_DC_SLOT),
        Some(GraphicsObject { kind: Kind::Image { image_ref }, .. }) if image_ref.asset_key == "STORY_BG"
    ));
}

#[test]
fn grp_open_screen_sentinel_keeps_existing_object_planes() {
    let runtime = rt();
    ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Foreground)
        .dispatch(&mut vm(), &[int(8), s(b"MENU_BUTTON")]);
    ObjCreateOp::new(Arc::clone(&runtime), GraphicsPlane::Background)
        .dispatch(&mut vm(), &[int(9), s(b"STORY_PERSISTENT")]);

    grp(&runtime, GrpOp::OpenScreen, &[s(b"???"), int(0)]);

    let snapshot = runtime.state_snapshot();
    assert!(
        snapshot
            .stack
            .get_layer(GraphicsLayer::ForegroundObject, 8)
            .is_some(),
        "the sentinel does not present a new scene"
    );
    assert!(
        snapshot
            .stack
            .get_layer(GraphicsLayer::BackgroundObject, 9)
            .is_some(),
        "the sentinel does not promote the background object plane"
    );
}

fn story_scene_frame_hash(traverse_menu_first: bool) -> String {
    let runtime = rt();
    runtime.with_stack_mut(|stack| {
        if traverse_menu_first {
            stack
                .set_layer(
                    GraphicsLayer::ForegroundObject,
                    8,
                    GraphicsObject::wipe(WipeColour::opaque_rgb(0xAA, 0x00, 0x00)),
                )
                .expect("menu object fits in the graphics stack");
        }
        stack
            .set_layer(
                GraphicsLayer::BackgroundObject,
                9,
                GraphicsObject::wipe(WipeColour::opaque_rgb(0x00, 0x22, 0x66)),
            )
            .expect("story object fits in the graphics stack");
    });
    grp(&runtime, GrpOp::OpenScreen, &[s(b"STORY_BG"), int(0)]);

    let pass = RenderPass::with_dimensions(2, 2).expect("non-zero frame dimensions");
    let png = encode_png_rgba_deterministic(&pass.rasterise(&runtime.state_snapshot().stack));
    sha256_hex(&png)
}

/// A menu-traversed story scene and a direct story launch must produce the
/// same frame. Deleting `present_objects` makes this fail: the traversed
/// frame retains its red menu wipe above the blue story wipe.
#[test]
fn traversed_menu_transition_and_direct_story_launch_emit_the_same_frame_hash() {
    let traversed = story_scene_frame_hash(true);
    let directly_launched = story_scene_frame_hash(false);

    assert_eq!(traversed, directly_launched);
}
