use super::*;

#[test]
fn alpha_transparent_wipe_contributes_no_pixels() {
    // Object-level alpha IS applied by paint_object: a Wipe whose
    // object alpha is TRANSPARENT contributes NOTHING (it leaves the
    // destination unchanged), rather than fully filling.
    use crate::graphics_objects::GraphicsAlpha;
    let pass = RenderPass::with_dimensions(2, 2).expect("non-zero screen");
    let mut stack = GraphicsObjectStack::new();
    // Opaque white background, then a transparent-alpha black wipe on
    // top: the transparent wipe must leave the white background intact.
    let mut background = GraphicsObject::wipe(WipeColour::WHITE);
    background.layer_order = 0;
    let mut transparent = GraphicsObject::wipe(WipeColour::opaque_rgb(0x11, 0x22, 0x33));
    transparent.layer_order = 1;
    transparent.alpha = GraphicsAlpha::TRANSPARENT;
    stack
        .set(GraphicsPlane::Foreground, 0, background)
        .expect("set background");
    stack
        .set(GraphicsPlane::Foreground, 1, transparent)
        .expect("set transparent");
    let fb = pass.rasterise(&stack);
    for chunk in fb.pixels().chunks(RGBA_BYTES_PER_PIXEL) {
        assert_eq!(
            chunk,
            &[0xFF, 0xFF, 0xFF, 0xFF],
            "a transparent-alpha wipe must contribute no pixels (object alpha IS applied)"
        );
    }
}

#[test]
fn alpha_half_wipe_blends_toward_background() {
    // A half-alpha wipe blends halfway between its colour and the
    // background: proof object-level alpha reaches the compositor.
    use crate::graphics_objects::GraphicsAlpha;
    let pass = RenderPass::with_dimensions(1, 1).expect("non-zero screen");
    let mut stack = GraphicsObjectStack::new();
    let mut background = GraphicsObject::wipe(WipeColour::BLACK);
    background.layer_order = 0;
    let mut half = GraphicsObject::wipe(WipeColour::WHITE);
    half.layer_order = 1;
    half.alpha = GraphicsAlpha(128);
    stack
        .set(GraphicsPlane::Foreground, 0, background)
        .expect("bg");
    stack.set(GraphicsPlane::Foreground, 1, half).expect("half");
    let fb = pass.rasterise(&stack);
    let pixel = &fb.pixels()[..4];
    // 255*128/255 rounded ~= 128 over black.
    assert!(
        (120..=136).contains(&(pixel[0] as u32)),
        "half-alpha white over black must be ~mid-grey, got {pixel:?}"
    );
    assert_eq!(pixel[0], pixel[1]);
    assert_eq!(pixel[1], pixel[2]);
}

#[test]
fn two_emissions_with_same_state_produce_byte_identical_pngs() {
    let mut pass_a = RenderPass::with_dimensions(48, 24).expect("non-zero screen");
    let mut pass_b = RenderPass::with_dimensions(48, 24).expect("non-zero screen");
    let stack = wipe_stack(WipeColour::WHITE);
    let text = TextLayer::localized(vec!["ABC".to_string()]);
    let root_a = temp_artifact_root("det-a");
    let root_b = temp_artifact_root("det-b");
    let sink_a = RecordingFrameArtifactSink::new();
    let sink_b = RecordingFrameArtifactSink::new();

    let a = pass_a
        .emit_localized_screenshot(&stack, &text, &root_a, "det", &sink_a)
        .expect("emit a");
    let b = pass_b
        .emit_localized_screenshot(&stack, &text, &root_b, "det", &sink_b)
        .expect("emit b");
    assert_eq!(a.artifact_ref.artifact_id, b.artifact_ref.artifact_id);
    let bytes_a = std::fs::read(root_a.artifact_path(&a.artifact_ref.uri).unwrap()).unwrap();
    let bytes_b = std::fs::read(root_b.artifact_path(&b.artifact_ref.uri).unwrap()).unwrap();
    assert_eq!(bytes_a, bytes_b);

    let _ = std::fs::remove_dir_all(root_a.path());
    let _ = std::fs::remove_dir_all(root_b.path());
}

#[test]
fn frame_index_advances_per_emission() {
    // Framebuffer must be large enough for the default text origin
    // (16, 16) + scale-4 glyph to actually paint, otherwise the
    // non-vacuous-localization guard (correctly) rejects the emit.
    let mut pass = RenderPass::with_dimensions(64, 64).expect("non-zero screen");
    let stack = wipe_stack(WipeColour::BLACK);
    let text = TextLayer::localized(vec!["X".to_string()]);
    let root = temp_artifact_root("frame-index");
    let sink = RecordingFrameArtifactSink::new();
    let first = pass
        .emit_localized_screenshot(&stack, &text, &root, "fi", &sink)
        .expect("emit 0");
    assert_eq!(first.frame_index, 0);
    let second = pass
        .emit_localized_screenshot(&stack, &text, &root, "fi", &sink)
        .expect("emit 1");
    assert_eq!(second.frame_index, 1);
    let _ = std::fs::remove_dir_all(root.path());
}

#[test]
fn draw_text_sets_pixels_for_ascii_and_differs_from_blank() {
    let pass = RenderPass::with_dimensions(128, 32).expect("non-zero screen");
    let stack = wipe_stack(WipeColour::BLACK);
    let text = TextLayer::localized(vec!["STELLA".to_string()]);
    let mut fb = pass.rasterise(&stack);
    let set = fb.draw_text(&text);
    assert!(set > 0, "ASCII text must set framebuffer pixels");

    // The same framebuffer without text is byte-different.
    let blank = pass.rasterise(&stack);
    assert_ne!(fb.pixels(), blank.pixels());
}

#[test]
fn english_layer_differs_from_japanese_source_layer() {
    // Localized English renders as legible glyphs; the Japanese
    // source (outside DejaVu Sans' coverage) renders as `.notdef`
    // boxes — provably different pixels, so the screenshot reflects
    // the localized layer rather than the source.
    let pass = RenderPass::with_dimensions(320, 64).expect("non-zero screen");
    let stack = wipe_stack(WipeColour::BLACK);
    let english = TextLayer::localized(vec!["Stella-EN".to_string()]);
    let japanese = TextLayer::localized(vec!["ステラ".to_string()]);
    let mut fb_en = pass.rasterise(&stack);
    let mut fb_ja = pass.rasterise(&stack);
    fb_en.draw_text(&english);
    fb_ja.draw_text(&japanese);
    assert_ne!(
        fb_en.pixels(),
        fb_ja.pixels(),
        "English and Japanese text layers must produce different pixels"
    );
}

/// Render a single glyph on a black canvas and return (painted-pixel
/// count, count of DISTINCT non-black RGBA values). Legible
/// anti-aliased glyphs have MANY distinct edge shades; a flat solid
/// tofu box has ~one.
fn glyph_shape(character: char) -> (u64, usize) {
    let pass = RenderPass::with_dimensions(96, 96).expect("non-zero screen");
    let mut fb = pass.rasterise(&wipe_stack(WipeColour::BLACK));
    let mut layer = TextLayer::localized(vec![character.to_string()]);
    layer.origin_x = 8;
    layer.origin_y = 8;
    layer.scale = 64;
    let painted = fb.draw_text(&layer);
    let mut distinct: std::collections::BTreeSet<[u8; 4]> = std::collections::BTreeSet::new();
    for chunk in fb.pixels().chunks(RGBA_BYTES_PER_PIXEL) {
        if chunk != [0x00, 0x00, 0x00, 0xFF] {
            distinct.insert([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
    }
    (painted, distinct.len())
}

#[test]
fn font_renders_legible_antialiased_glyphs_not_tofu() {
    // A real font produces PROPORTIONAL glyphs with ANTI-ALIASED
    // edges: a wide 'W' paints many more pixels than a narrow 'i', and
    // each glyph carries multiple distinct coverage shades (not one
    // flat block). A tofu/solid-box font would make these equal and
    // single-shade.
    let (w_painted, w_shades) = glyph_shape('W');
    let (i_painted, i_shades) = glyph_shape('i');
    assert!(
        w_painted > i_painted * 3 / 2,
        "proportional font: 'W' ({w_painted}px) must be much wider than 'i' ({i_painted}px)"
    );
    assert!(
        w_shades >= 4 && i_shades >= 4,
        "anti-aliased glyphs must carry multiple edge shades (not a flat tofu box): \
         W={w_shades} i={i_shades}"
    );
}

#[test]
fn font_distinguishes_mixed_case() {
    // The old 3x5 bitmap folded lowercase to uppercase; the real font
    // must render 'a' and 'A' as genuinely different shapes.
    let pass = RenderPass::with_dimensions(64, 64).expect("non-zero screen");
    let mut lower = pass.rasterise(&wipe_stack(WipeColour::BLACK));
    let mut upper = pass.rasterise(&wipe_stack(WipeColour::BLACK));
    let mut la = TextLayer::localized(vec!["a".to_string()]);
    la.scale = 48;
    let mut ua = la.clone();
    ua.lines = vec!["A".to_string()];
    lower.draw_text(&la);
    upper.draw_text(&ua);
    assert_ne!(
        lower.pixels(),
        upper.pixels(),
        "lowercase 'a' and uppercase 'A' must render as distinct glyphs (mixed case)"
    );
}

#[test]
fn redact_edge_map_shows_structure_and_is_not_solid() {
    // An image with a real vertical edge (left black | right white)
    // must redact to a structure-bearing edge-outline: MULTIPLE
    // distinct colours (base + edge), not a single solid fill.
    let (w, h) = (8u32, 4u32);
    let mut pixels = vec![0u8; (w * h) as usize * RGBA_BYTES_PER_PIXEL];
    for y in 0..h {
        for x in 0..w {
            let idx = ((y * w + x) as usize) * RGBA_BYTES_PER_PIXEL;
            let v = if x >= w / 2 { 0xFF } else { 0x00 };
            pixels[idx] = v;
            pixels[idx + 1] = v;
            pixels[idx + 2] = v;
            pixels[idx + 3] = 0xFF;
        }
    }
    let edges = redact_edge_map(&pixels, w, h);
    assert_eq!(edges.len(), pixels.len());
    let distinct: std::collections::BTreeSet<[u8; 4]> = edges
        .chunks(RGBA_BYTES_PER_PIXEL)
        .map(|c| [c[0], c[1], c[2], c[3]])
        .collect();
    assert!(
        distinct.len() >= 2,
        "edge-outline of a structured image must NOT be a single solid colour; \
         got {} distinct colours",
        distinct.len()
    );
    // Alpha is preserved (silhouette survives).
    assert!(edges.chunks(RGBA_BYTES_PER_PIXEL).all(|c| c[3] == 0xFF));
    // The edge-outline is NOT the source art.
    assert_ne!(edges, pixels, "redaction must transform, not copy, the art");
}

#[test]
fn redact_edge_map_of_flat_image_is_solid_base() {
    // A featureless (edgeless) image has no structure to outline, so
    // it redacts to the solid dark base — confirming the edges in the
    // test above genuinely came from image structure.
    let (w, h) = (6u32, 6u32);
    let pixels = vec![0x40u8; (w * h) as usize * RGBA_BYTES_PER_PIXEL];
    let edges = redact_edge_map(&pixels, w, h);
    let distinct: std::collections::BTreeSet<[u8; 3]> = edges
        .chunks(RGBA_BYTES_PER_PIXEL)
        .map(|c| [c[0], c[1], c[2]])
        .collect();
    assert_eq!(
        distinct.len(),
        1,
        "a flat image has no edges, so it redacts to a single base colour"
    );
}

#[test]
fn layer_order_paints_higher_value_last_within_a_plane() {
    let pass = RenderPass::with_dimensions(1, 1).expect("non-zero screen");
    let mut stack = GraphicsObjectStack::new();
    let mut lower = GraphicsObject::wipe(WipeColour::BLACK);
    lower.layer_order = 0;
    let mut higher = GraphicsObject::wipe(WipeColour::WHITE);
    higher.layer_order = 1;
    stack
        .set(GraphicsPlane::Foreground, 0, lower)
        .expect("set lower");
    stack
        .set(GraphicsPlane::Foreground, 1, higher)
        .expect("set higher");
    let fb = pass.rasterise(&stack);
    assert_eq!(fb.pixels(), &[0xFF, 0xFF, 0xFF, 0xFF]);
}

#[test]
fn foreground_plane_paints_after_background_regardless_of_layer_order() {
    let pass = RenderPass::with_dimensions(1, 1).expect("non-zero screen");
    let mut stack = GraphicsObjectStack::new();
    let mut bg = GraphicsObject::wipe(WipeColour::WHITE);
    bg.layer_order = 999;
    let mut fg = GraphicsObject::wipe(WipeColour::BLACK);
    fg.layer_order = 0;
    stack.set(GraphicsPlane::Background, 0, bg).expect("set bg");
    stack.set(GraphicsPlane::Foreground, 0, fg).expect("set fg");
    let fb = pass.rasterise(&stack);
    assert_eq!(fb.pixels(), &[0x00, 0x00, 0x00, 0xFF]);
}

#[test]
fn foreground_object_layer_paints_after_background_object_layer() {
    let pass = RenderPass::with_dimensions(1, 1).expect("non-zero screen");
    let mut stack = GraphicsObjectStack::new();
    let mut bg_object = GraphicsObject::wipe(WipeColour::WHITE);
    bg_object.layer_order = 999;
    let mut fg_object = GraphicsObject::wipe(WipeColour::BLACK);
    fg_object.layer_order = -999;
    stack
        .set_layer(GraphicsLayer::BackgroundObject, 0, bg_object)
        .expect("set bg object");
    stack
        .set_layer(GraphicsLayer::ForegroundObject, 0, fg_object)
        .expect("set fg object");
    let fb = pass.rasterise(&stack);
    assert_eq!(fb.pixels(), &[0x00, 0x00, 0x00, 0xFF]);
}

#[test]
fn invisible_objects_are_skipped() {
    let pass = RenderPass::with_dimensions(1, 1).expect("non-zero screen");
    let mut stack = GraphicsObjectStack::new();
    let mut hidden = GraphicsObject::wipe(WipeColour::WHITE);
    hidden.visible = false;
    stack
        .set(GraphicsPlane::Foreground, 0, hidden)
        .expect("set hidden");
    let fb = pass.rasterise(&stack);
    assert_eq!(fb.pixels(), &[0x00, 0x00, 0x00, 0x00]);
}

#[test]
fn image_object_without_asset_package_contributes_nothing() {
    // With no AssetPackage bound there is nothing to dereference, so
    // an Image-only stack rasterises to the initial transparent
    // pattern under EITHER policy (the g00 binding is what produces
    // pixels — see the real-bytes suite for the composited case).
    let pass = RenderPass::with_dimensions(4, 4).expect("non-zero screen");
    let mut stack = GraphicsObjectStack::new();
    stack
        .set(
            GraphicsPlane::Background,
            0,
            GraphicsObject::image("SYNTH_BG"),
        )
        .expect("set image");
    assert!(!pass.has_assets());
    for policy in [RedactionPolicy::Full, RedactionPolicy::Redact] {
        let fb = pass.rasterise_with_policy(&stack, policy);
        assert!(
            fb.pixels().iter().all(|&byte| byte == 0),
            "an image object with no asset package contributes zero pixels ({policy:?})"
        );
    }
}

#[test]
fn public_toggle_maps_redact_flag() {
    assert_eq!(
        RedactionPolicy::public_toggle(true),
        RedactionPolicy::Redact
    );
    assert_eq!(RedactionPolicy::public_toggle(false), RedactionPolicy::Full);
}

#[test]
fn apply_tone_neutral_is_identity_and_positive_lightens() {
    let base = [0x40u8, 0x40, 0x40, 0xFF];
    assert_eq!(
        apply_tone_rgba(base, GraphicsColourTone::NEUTRAL),
        base,
        "neutral tone is identity"
    );
    let lightened = apply_tone_rgba(
        base,
        GraphicsColourTone {
            red_thousandths: 1000,
            green_thousandths: 0,
            blue_thousandths: 0,
        },
    );
    assert_eq!(lightened[0], 0xFF, "+1000 red drives channel to white");
    assert_eq!(lightened[1], 0x40, "other channels untouched");
    assert_eq!(lightened[3], 0xFF, "alpha untouched by tone");
}

#[test]
fn scale_dimension_rounds_and_floors_nonpositive() {
    assert_eq!(scale_dimension(100, 1000), 100, "identity");
    assert_eq!(scale_dimension(100, 500), 50, "half");
    assert_eq!(scale_dimension(100, 2000), 200, "double");
    assert_eq!(scale_dimension(100, 0), 0, "zero scale => no extent");
    assert_eq!(scale_dimension(100, -500), 0, "negative scale => no extent");
}
