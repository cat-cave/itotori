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
    // A configured 1280x720 window: MOJI_SIZE=36, MOJI_CNT=22,3.
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

#[path = "compositor_tests.rs"]
mod compositor_tests;
