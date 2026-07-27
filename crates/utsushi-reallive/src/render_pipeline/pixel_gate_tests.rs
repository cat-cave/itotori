//! Failure proofs for the localized-text pixel gate.
//!
//! The reference is a structural property of the actual glyph coverage
//! bitmaps: distinct source characters must remain distinct after
//! rasterisation, and their blended pixels must land in the pre-blit bounds.
//! It is independent of the decoded `TextLine` assertion that used to stand
//! in for rendering.

use super::super::{
    Framebuffer, GraphicsObjectStack, RenderPass, TextLayer, WipeColour, font, pixel_gate,
};

fn canvas() -> Framebuffer {
    let pass = RenderPass::with_dimensions(192, 96).expect("valid canvas");
    let mut stack = GraphicsObjectStack::new();
    stack
        .set(
            crate::graphics_objects::GraphicsPlane::Foreground,
            0,
            crate::graphics_objects::GraphicsObject::wipe(WipeColour::BLACK),
        )
        .expect("opaque black background");
    pass.rasterise(&stack)
}

fn gate_result(
    replacement_glyphs: bool,
    drop_pixels: bool,
    offset: (i32, i32),
) -> Result<(), pixel_gate::PixelGateError> {
    let mut framebuffer = canvas();
    let text = TextLayer::localized(vec!["Wim".to_string()]);
    let before = framebuffer.pixels().to_vec();
    let raster = font::rasterise_lines_for_test(
        &mut framebuffer,
        &text,
        replacement_glyphs,
        drop_pixels,
        offset,
    );
    pixel_gate::assert_visible(
        &raster,
        pixel_gate::PixelDelta::between(&before, &framebuffer),
    )
}

#[test]
fn pixel_gate_accepts_the_reference_raster() {
    gate_result(false, false, (0, 0)).expect("the normal glyph raster matches its pixel reference");
}

#[test]
fn pixel_gate_rejects_forced_replacement_glyph_raster() {
    let error = gate_result(true, false, (0, 0))
        .expect_err("forced font-resolution failure must not pass the pixel gate");
    assert!(
        matches!(error, pixel_gate::PixelGateError::ReplacementGlyphs { .. }),
        "expected replacement-glyph pixel failure, got {error}"
    );
}

#[test]
fn pixel_gate_rejects_a_text_draw_that_never_blends() {
    let error = gate_result(false, true, (0, 0))
        .expect_err("a dropped text layer must not pass the pixel gate");
    assert!(
        matches!(error, pixel_gate::PixelGateError::Invisible { .. }),
        "expected invisible-text pixel failure, got {error}"
    );
}

#[test]
fn pixel_gate_rejects_a_wrong_position_blit() {
    let error = gate_result(false, false, (80, 0))
        .expect_err("a shifted glyph blit must not pass the pixel gate");
    assert!(
        matches!(error, pixel_gate::PixelGateError::WrongPosition { .. }),
        "expected wrong-position pixel failure, got {error}"
    );
}
