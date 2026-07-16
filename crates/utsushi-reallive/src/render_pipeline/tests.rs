//! Render-pipeline unit tests, moved verbatim out of the root module's
//! inline `#[cfg(test)] mod tests` block (uniformly outdented one level).

use super::*;
use crate::graphics_objects::{GraphicsColourTone, GraphicsObject, WipeColour};
use std::sync::atomic::{AtomicU64, Ordering};

fn reallive_real_bytes_screen_size() -> ScreenSize {
    ScreenSize {
        mode: 999,
        width: 1280,
        height: 720,
    }
}

/// Unique managed artifact root under the process temp dir.
fn temp_artifact_root(tag: &str) -> RuntimeArtifactRoot {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "utsushi-render-pipeline-{tag}-{}-{nonce}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let root = RuntimeArtifactRoot::new(&dir);
    root.prepare().expect("prepare managed artifact root");
    root
}

fn wipe_stack(colour: WipeColour) -> GraphicsObjectStack {
    let mut stack = GraphicsObjectStack::new();
    stack
        .set(GraphicsPlane::Foreground, 0, GraphicsObject::wipe(colour))
        .expect("set wipe");
    stack
}

#[test]
fn adler32_known_vector() {
    assert_eq!(adler32(b"Wikipedia"), 0x11E60398);
}

#[test]
fn adler32_of_empty_is_one() {
    assert_eq!(adler32(&[]), 1);
}

#[test]
fn crc32_known_vector_matches_png_spec() {
    assert_eq!(crc32_ieee(b"123456789"), 0xCBF43926);
}

#[test]
fn crc32_of_empty_is_zero() {
    assert_eq!(crc32_ieee(&[]), 0);
}

#[test]
fn zlib_stored_round_trips_short_payload_through_known_header() {
    let wrapped = wrap_as_zlib_stored(b"hi");
    assert_eq!(wrapped[0], 0x78);
    assert_eq!(wrapped[1], 0x01);
    assert_eq!(wrapped[2], 0x01);
    assert_eq!(&wrapped[3..5], &2u16.to_le_bytes());
    assert_eq!(&wrapped[5..7], &(!2u16).to_le_bytes());
    assert_eq!(&wrapped[7..9], b"hi");
    assert_eq!(&wrapped[9..13], &adler32(b"hi").to_be_bytes());
}

#[test]
fn zlib_stored_splits_at_64k_boundary() {
    let payload = vec![0xAAu8; 65_535 + 10];
    let wrapped = wrap_as_zlib_stored(&payload);
    let expected_len = 2 + 5 + 65_535 + 5 + 10 + 4;
    assert_eq!(wrapped.len(), expected_len);
    assert_eq!(wrapped[2], 0x00);
    let second_block_header = 2 + 5 + 65_535;
    assert_eq!(wrapped[second_block_header], 0x01);
}

#[test]
fn render_pass_rejects_zero_screen_size() {
    let result = RenderPass::with_dimensions(0, 720);
    assert!(matches!(
        result,
        Err(RenderPassBuildError::ZeroScreenSize { width: 0, .. })
    ));
    let result = RenderPass::with_dimensions(1280, 0);
    assert!(matches!(
        result,
        Err(RenderPassBuildError::ZeroScreenSize { height: 0, .. })
    ));
}

#[test]
fn render_pass_honours_reallive_real_bytes_screen_size() {
    let pass = RenderPass::new(reallive_real_bytes_screen_size()).expect("non-zero screen");
    assert_eq!(pass.width(), 1280);
    assert_eq!(pass.height(), 720);
}

#[test]
fn deterministic_png_starts_with_magic_and_contains_expected_chunks() {
    let pass = RenderPass::with_dimensions(4, 2).expect("non-zero screen");
    let stack = wipe_stack(WipeColour::opaque_rgb(0x12, 0x34, 0x56));
    let bytes = encode_png_rgba_deterministic(&pass.rasterise(&stack));
    assert_eq!(&bytes[..8], &PNG_FILE_MAGIC);
    assert_eq!(&bytes[8..12], &13u32.to_be_bytes());
    assert_eq!(&bytes[12..16], b"IHDR");
    let tail = &bytes[bytes.len() - 12..];
    assert_eq!(&tail[0..4], &0u32.to_be_bytes());
    assert_eq!(&tail[4..8], b"IEND");
}

#[test]
fn wipe_smoke_fills_buffer_with_documented_colour_byte_order() {
    let pass = RenderPass::with_dimensions(2, 2).expect("non-zero screen");
    let stack = wipe_stack(WipeColour::opaque_rgb(0xFF, 0x00, 0x00));
    let fb = pass.rasterise(&stack);
    let pixels = fb.pixels();
    assert_eq!(pixels.len(), 16);
    for chunk in pixels.chunks(4) {
        assert_eq!(chunk, &[0xFF, 0x00, 0x00, 0xFF]);
    }
}

#[test]
fn emit_localized_screenshot_announces_e2_screenshot_through_substrate_sink() {
    let mut pass = RenderPass::with_dimensions(64, 32).expect("non-zero screen");
    let stack = wipe_stack(WipeColour::opaque_rgb(0x10, 0x20, 0x30));
    let text = TextLayer::localized(vec!["HELLO".to_string()]);
    let root = temp_artifact_root("emit-e2");
    let sink = RecordingFrameArtifactSink::new();

    let artifact = pass
        .emit_localized_screenshot(&stack, &text, &root, "render-validate-test", &sink)
        .expect("emit localized screenshot");

    // Announced through the substrate sink at E2.
    assert_eq!(artifact.evidence_tier, EvidenceTier::E2);
    assert_eq!(
        artifact.artifact_ref.artifact_kind,
        SCREENSHOT_ARTIFACT_KIND
    );
    assert_eq!(sink.len(), 1);
    assert_eq!(sink.frames()[0], artifact);

    // The PNG is a real hashable file on disk whose bytes hash to
    // the announced artifact_id.
    let path = root
        .artifact_path(&artifact.artifact_ref.uri)
        .expect("artifact path");
    let bytes = std::fs::read(&path).expect("png on disk");
    assert_eq!(&bytes[..8], &PNG_FILE_MAGIC);
    assert_eq!(sha256_hex(&bytes), artifact.artifact_ref.artifact_id);

    let _ = std::fs::remove_dir_all(root.path());
}

#[test]
fn emit_rejects_offscreen_origin_zero_text_screenshot() {
    // A non-empty localized layer whose origin is entirely
    // off-screen paints ZERO text pixels. The emit path MUST refuse
    // it rather than announce a vacuous E2 localization proof.
    let mut pass = RenderPass::with_dimensions(64, 32).expect("non-zero screen");
    let stack = wipe_stack(WipeColour::opaque_rgb(0x10, 0x20, 0x30));
    let mut text = TextLayer::localized(vec!["HELLO".to_string()]);
    text.origin_x = 10_000;
    text.origin_y = 10_000;
    let root = temp_artifact_root("emit-offscreen-zero-text");
    let sink = RecordingFrameArtifactSink::new();

    // Pre-condition: this layer genuinely paints nothing.
    let (_, painted) = pass.rasterise_with_text(&stack, &text);
    assert_eq!(painted, 0, "off-screen origin must paint zero pixels");

    let result = pass.emit_localized_screenshot(&stack, &text, &root, "zero-text", &sink);
    assert!(matches!(
        result,
        Err(RenderEmitError::BlankLocalizedText { char_count: 5, .. })
    ));
    // No frame announced and the frame index did not advance, so no
    // vacuous screenshot leaked into the substrate.
    assert!(sink.is_empty());
    assert_eq!(pass.next_frame_index(), 0);
    let _ = std::fs::remove_dir_all(root.path());
}

#[test]
fn emit_rejects_all_whitespace_zero_text_screenshot() {
    // An all-whitespace localized layer has chars but paints nothing
    // (space is the BLANK glyph); it must be rejected too.
    let mut pass = RenderPass::with_dimensions(128, 48).expect("non-zero screen");
    let stack = wipe_stack(WipeColour::BLACK);
    let text = TextLayer::localized(vec!["   ".to_string()]);
    let root = temp_artifact_root("emit-whitespace-zero-text");
    let sink = RecordingFrameArtifactSink::new();

    let (_, painted) = pass.rasterise_with_text(&stack, &text);
    assert_eq!(painted, 0, "all-whitespace must paint zero pixels");

    let result = pass.emit_localized_screenshot(&stack, &text, &root, "ws", &sink);
    assert!(matches!(
        result,
        Err(RenderEmitError::BlankLocalizedText { char_count: 3, .. })
    ));
    assert!(sink.is_empty());
    let _ = std::fs::remove_dir_all(root.path());
}

#[test]
fn emit_accepts_real_text_that_paints_pixels() {
    // Control case: the same guard lets a real localized layer
    // through, so the rejection above is not a blanket refusal.
    let mut pass = RenderPass::with_dimensions(128, 48).expect("non-zero screen");
    let stack = wipe_stack(WipeColour::BLACK);
    let text = TextLayer::localized(vec!["HELLO".to_string()]);
    let root = temp_artifact_root("emit-real-text");
    let sink = RecordingFrameArtifactSink::new();
    pass.emit_localized_screenshot(&stack, &text, &root, "real", &sink)
        .expect("real localized text emits");
    assert_eq!(sink.len(), 1);
    let _ = std::fs::remove_dir_all(root.path());
}

fn kanon_like_config() -> MessageWindowConfig {
    // Kanon-shaped: top-left origin, bottom box, full width (POS.x=0)
    // narration only (NAME_MOD=0).
    MessageWindowConfig {
        origin: 0,
        pos_x: 0,
        pos_y: 345,
        attr_rgba: (100, 100, 160, 200),
        moji_size: 25,
        moji_pad: (19, 0, 53, 0),
        moji_cnt: Some((22, 3)),
        moji_rep: (-1, 3),
        ruby_size: 0,
        name_mod: 0,
        message_mod: 0,
        name_moji_size: 25,
        name_pos: (0, 0),
    }
}

#[test]
fn message_window_renders_one_message_not_the_whole_scene() {
    // The message window carries exactly the ONE current message —
    // never a whole scene concatenated. This is the regression guard
    // for the "all messages in one box" defect: laying out three
    // messages must produce THREE single-line layers, not one
    // three-line box.
    let messages = ["First message.", "Second message.", "Third message."];
    let cfg = kanon_like_config();
    for text in messages {
        let layer = TextLayer::message_window(text, None, &cfg, (640, 480), (640, 480));
        assert_eq!(
            layer.lines,
            vec![text.to_string()],
            "each frame renders exactly one message"
        );
    }
    // A flatten-all layer (the OLD behaviour) is structurally distinct:
    // it would hold every message in one layer. Assert message_window
    // never does that.
    let one = TextLayer::message_window(messages[0], None, &cfg, (640, 480), (640, 480));
    assert_eq!(one.lines.len(), 1, "one message per frame, not flattened");
}

#[test]
fn message_window_box_is_driven_by_gameexe_values() {
    // Kanon POS=0:0,345 in 640x480 → a bottom, full-width box: top at
    // y=345, spanning the full width. Change the config and the box
    // moves — proving it is config-driven, not hardcoded.
    let cfg = kanon_like_config();
    let layer = TextLayer::message_window("narration", None, &cfg, (640, 480), (640, 480));
    let backdrop = layer.backdrop.expect("message box has a backdrop");
    assert_eq!(backdrop.x, 0, "POS.x=0 → box hugs the left edge");
    assert_eq!(backdrop.y, 345, "POS.y=345 → box top at the configured y");
    assert_eq!(backdrop.width, 640, "POS.x=0 → full-width box");
    assert_eq!(backdrop.height, 480 - 345, "box extends to the bottom edge");
    // Colour + alpha come straight from ATTR.
    assert_eq!(
        (
            backdrop.colour.red,
            backdrop.colour.green,
            backdrop.colour.blue,
            backdrop.colour.alpha
        ),
        (100, 100, 160, 200)
    );
    // Font size is MOJI_SIZE (scale 1.0 here).
    assert_eq!(layer.scale, 25);

    // Same config scaled 2x horizontally / 1.5x vertically to a
    // 1280x720 frame moves the box proportionally.
    let scaled = TextLayer::message_window("narration", None, &cfg, (640, 480), (1280, 720));
    let scaled_box = scaled.backdrop.expect("backdrop");
    assert_eq!(scaled_box.width, 1280, "full width scales to the frame");
    assert_eq!(scaled_box.y, (345.0 * 1.5_f32).round() as u32);
}

#[test]
fn message_window_moving_pos_moves_the_box() {
    // Independent proof the box is not hardcoded: a DIFFERENT POS
    // yields a DIFFERENT rect.
    let mut cfg = kanon_like_config();
    cfg.pos_x = 40;
    cfg.pos_y = 300;
    let layer = TextLayer::message_window("x", None, &cfg, (640, 480), (640, 480));
    let backdrop = layer.backdrop.expect("backdrop");
    assert_eq!(backdrop.x, 40);
    assert_eq!(backdrop.y, 300);
    assert_eq!(backdrop.width, 640 - 2 * 40, "symmetric horizontal inset");
}

#[test]
fn message_window_wraps_long_message_at_moji_cnt_within_the_box() {
    // A Sweetie-shaped window: 1280x720, MOJI_SIZE=36, MOJI_CNT=22,3
    // MOJI_REP=0,2, MOJI_POS=48,0,12,0, POS bottom-anchored inset 220.
    let cfg = MessageWindowConfig {
        origin: 2,
        pos_x: 220,
        pos_y: 0,
        attr_rgba: (10, 16, 24, 220),
        moji_size: 36,
        moji_pad: (48, 0, 12, 0),
        moji_cnt: Some((22, 3)),
        moji_rep: (0, 2),
        ruby_size: 0,
        name_mod: 1,
        message_mod: 0,
        name_moji_size: 25,
        name_pos: (18, 26),
    };
    let screen = (1280u32, 720u32);

    // A message far longer than one MOJI_CNT line.
    let long = "The rain kept falling long after the festival lanterns \
                had gone dark, and neither of us wanted to be the first \
                to say goodnight.";
    let layer = TextLayer::message_window(long, None, &cfg, screen, screen);

    // Non-vacuous #1: it actually wrapped to multiple lines.
    assert!(
        layer.lines.len() >= 2,
        "a long message must wrap to >=2 lines, got {:?}",
        layer.lines
    );

    // Non-vacuous #2: the WHOLE message on one line would overflow the
    // box inner width — so wrapping was genuinely required. Disabling
    // the wrap (a single-line layer) fails THIS assertion because the
    // one line's width exceeds the inner width.
    let backdrop = layer.backdrop.expect("message box backdrop");
    let (_, _, _pad_left, pad_right) = cfg.moji_pad;
    let inner_right = backdrop.x + backdrop.width - pad_right.max(0) as u32;
    let inner_width = (inner_right - layer.origin_x) as f32;
    assert!(
        font::line_width(long, layer.scale as f32) > inner_width,
        "the single-line message must be wider than the box (else the \
         wrap test is vacuous)"
    );

    // Every wrapped line stays within the box's right inset: no glyph
    // advances past the inner right edge.
    for line in &layer.lines {
        let w = font::line_width(line, layer.scale as f32);
        assert!(
            w <= inner_width,
            "wrapped line {line:?} width {w} exceeds box inner width {inner_width}"
        );
    }

    // A short message stays a single line (wrapping is body-only, not
    // an unconditional line split).
    let short = TextLayer::message_window("Yes.", None, &cfg, screen, screen);
    assert_eq!(short.lines, vec!["Yes.".to_string()]);
}

#[test]
fn message_window_name_box_present_only_with_speaker_and_name_mod() {
    let mut cfg = kanon_like_config();
    cfg.name_mod = 1;
    cfg.name_moji_size = 25;
    cfg.name_pos = (18, 26);

    // Speaker + NAME_MOD=1 → a separate name box layer.
    let with_speaker =
        TextLayer::message_window("Hello.", Some("Yuuichi"), &cfg, (640, 480), (640, 480));
    let name_box = with_speaker
        .name_box
        .as_ref()
        .expect("NAME_MOD=1 + speaker → name box");
    assert_eq!(name_box.lines, vec!["Yuuichi".to_string()]);
    assert!(name_box.backdrop.is_some(), "name box has its own backdrop");

    // Narration (no speaker) → NO name box, even with NAME_MOD=1.
    let narration = TextLayer::message_window("Hello.", None, &cfg, (640, 480), (640, 480));
    assert!(
        narration.name_box.is_none(),
        "narration renders no name box"
    );

    // NAME_MOD=0 → NO name box, even with a speaker.
    cfg.name_mod = 0;
    let mod_off =
        TextLayer::message_window("Hello.", Some("Yuuichi"), &cfg, (640, 480), (640, 480));
    assert!(mod_off.name_box.is_none(), "NAME_MOD=0 renders no name box");
}

#[test]
fn message_window_name_box_glyphs_paint() {
    // The name box actually draws: painting a message-window layer with
    // a name box paints MORE glyph pixels than the same message with no
    // speaker (the name glyphs are additive).
    let mut cfg = kanon_like_config();
    cfg.name_mod = 1;
    let pass = RenderPass::with_dimensions(640, 480).expect("non-zero screen");
    let stack = wipe_stack(WipeColour::BLACK);

    let narration = TextLayer::message_window("Hello there.", None, &cfg, (640, 480), (640, 480));
    let named =
        TextLayer::message_window("Hello there.", Some("Nayuki"), &cfg, (640, 480), (640, 480));
    let (_, narration_px) = pass.rasterise_with_text(&stack, &narration);
    let (_, named_px) = pass.rasterise_with_text(&stack, &named);
    assert!(narration_px > 0, "message glyphs paint");
    assert!(
        named_px > narration_px,
        "the name box adds glyph pixels ({named_px} vs {narration_px})"
    );
}

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
