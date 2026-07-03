//! Playthrough-sequence diagnostic renderer
//! (`utsushi-render-per-message-playthrough-sequence`).
//!
//! Renders a short PLAYTHROUGH MONTAGE — the first few play-order messages
//! of a scene, EACH as its OWN frame, stacked vertically over the SAME
//! composited background — so the orchestrator can VISUALLY confirm the
//! game advances message-by-message (click-advance), not just that message
//! #0 renders once. This is the visual companion to the port change in
//! `engine_port::launch`, which now composites each leading play-order
//! message (up to `ITOTORI_PLAYTHROUGH_MAX`) into its own E2 frame.
//!
//! Each frame paints ONE message into the Gameexe-configured message-window
//! box (position/colour/alpha/font-size/insets + `NAME_MOD` name box), over
//! a shared background, with word-wrap — exactly the message-window port
//! render, one message per frame.
//!
//! The message CONTENT here is STAGED English (the product output: legible
//! English in the real box; an untranslated title's Japanese source renders
//! as the font's `.notdef` boxes). This mirrors how `msgwin_diag` /
//! `render_diag` stage their translated lines — only the CONTENT is staged;
//! the per-message-frame SEQUENCING is the real port behaviour. The
//! background is a neutral gradient (never fakes copyrighted game art);
//! point a real g00 background in via the port for real-art frames.
//!
//! Run (self-contained, no game corpus needed):
//!   cargo run -p utsushi-reallive --example playthrough_diag
//!
//! Writes `.private-render/diag/playthrough-seq.png` (gitignored).

use std::path::PathBuf;

use utsushi_reallive::{
    Framebuffer, MessageWindowConfig, TextLayer, WipeColour, encode_png_rgba_deterministic,
};

/// Native port canvas (RealLive Sweetie HD `#SCREENSIZE_MOD=999,1280,720`).
const FRAME_W: u32 = 1280;
const FRAME_H: u32 = 720;

/// Paint a shared neutral-gradient "scene" background into a fresh frame —
/// a vertical sky→ground wash plus a horizon band, so the message box reads
/// against something without republishing any game art.
fn background_frame() -> Framebuffer {
    let mut fb = Framebuffer::new(FRAME_W, FRAME_H);
    fb.fill(WipeColour::opaque_rgb(0x14, 0x18, 0x28));
    // Sky→ground gradient as stacked translucent bands.
    let bands = 24u32;
    for band in 0..bands {
        let t = band as f32 / bands as f32;
        let red = (0x22 as f32 + t * 0x40 as f32) as u8;
        let green = (0x26 as f32 + t * 0x30 as f32) as u8;
        let blue = (0x3a as f32 + t * 0x14 as f32) as u8;
        let y = band * (FRAME_H / bands);
        fb.fill_rect_blended(
            0,
            y,
            FRAME_W,
            FRAME_H / bands,
            WipeColour {
                red,
                green,
                blue,
                alpha: 0x60,
            },
        );
    }
    // A horizon band to give the scene depth.
    fb.fill_rect_blended(
        0,
        (FRAME_H as f32 * 0.62) as u32,
        FRAME_W,
        6,
        WipeColour {
            red: 0x8a,
            green: 0x7a,
            blue: 0x5a,
            alpha: 0xaa,
        },
    );
    fb
}

fn main() {
    // The staged-English play-order stream: narration + speaker lines,
    // exercising the `NAME_MOD` name box, in click-advance order.
    let messages: [(Option<&str>, &str); 4] = [
        (
            None,
            "The classroom was still and empty when I stepped inside, chalk dust hanging in the \
             morning light.",
        ),
        (
            Some("Sayuri"),
            "Good morning! You're here early today — I didn't expect to see anyone yet.",
        ),
        (
            Some("Makoto"),
            "I couldn't sleep. There was too much on my mind after everything yesterday.",
        ),
        (
            None,
            "We stood there a moment, the quiet morning stretching out between us.",
        ),
    ];

    // The real Gameexe box would come from a game's `#WINDOW.000`; this
    // self-contained diag uses the documented default box (bottom-anchored
    // full-width) with `NAME_MOD=1` so the speaker lines exercise the
    // separate name box. Rendered at the game's own virtual screen == frame.
    let config = MessageWindowConfig {
        name_mod: 1,
        ..MessageWindowConfig::default()
    };
    let screen = (FRAME_W, FRAME_H);
    let frame_size = (FRAME_W, FRAME_H);

    // Stack each per-message frame vertically into one montage sheet.
    let take = messages.len();
    let gap = 10u32;
    let mut sheet = Framebuffer::new(FRAME_W, FRAME_H * take as u32 + gap * (take as u32 - 1));
    sheet.fill(WipeColour::opaque_rgb(0x00, 0x00, 0x00));

    for (i, (speaker, text)) in messages.iter().enumerate() {
        let mut frame = background_frame();
        let layer = TextLayer::message_window(text, *speaker, &config, screen, frame_size);
        let painted = frame.draw_text(&layer);
        assert!(painted > 0, "message #{i} must paint glyphs");
        sheet.blit(&frame, 0, (FRAME_H + gap) * i as u32);
        println!(
            "frame {i}: speaker={:?} chars={} painted_px={painted}",
            speaker,
            text.chars().count(),
        );
    }

    let out_dir = PathBuf::from(".private-render/diag");
    std::fs::create_dir_all(&out_dir).expect("create diag dir");
    let out_path = out_dir.join("playthrough-seq.png");
    let bytes = encode_png_rgba_deterministic(&sheet);
    assert_eq!(
        &bytes[..8],
        &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
        "valid PNG magic",
    );
    std::fs::write(&out_path, &bytes).expect("write montage");
    println!(
        "wrote {} ({} bytes, {}x{}, {} stacked per-message frames)",
        out_path.display(),
        bytes.len(),
        sheet.width(),
        sheet.height(),
        take,
    );
}
