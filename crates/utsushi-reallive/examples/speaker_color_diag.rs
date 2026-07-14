//! Speaker name-box + per-speaker text-colour diagnostic renderer
//! (`investigate-sweetie-name-box-speaker-decode-gap` fix).
//!
//! Proves the decode fix END-TO-END on a real Sweetie HD `Gameexe.ini`:
//! the `#NAMAE` middle field is a `#COLOR_TABLE` row index (the speaker's
//! dialogue TEXT COLOUR), NOT a voice slot. Two staged translated lines —
//! keyed by REAL `#NAMAE` display keys — are rendered into the real
//! `#WINDOW.000`-configured message box, each showing:
//!
//!   * the `NAME_MOD=1` speaker name box with the resolved display name, and
//!   * the dialogue text in that speaker's resolved `#COLOR_TABLE` colour.
//!
//! `和人` (Kazuto) → `#NAMAE (1,016,-1)` → `#COLOR_TABLE.016 = 204,204,255`
//! (pale); `真理子` (Mariko) → `#NAMAE (1,014,-1)` →
//! `#COLOR_TABLE.014 = 255,153,204` (pink). The two colours are RESOLVED
//! from the game's real tables (asserted below), never hardcoded into the
//! render.
//!
//! The box geometry is real; only the message CONTENT is staged (legible
//! English so the orchestrator can visually verify the name + colour
//! against the in-game screenshots). The frame is a PRIVATE full-fidelity
//! render written to the gitignored `.private-render/diag/` — never
//! committed.
//!
//! Run:
//!   cargo run -p utsushi-reallive --example speaker_color_diag -- \
//!     <gameexe.ini> <out.png> [KEY::text...]

use std::path::PathBuf;

use utsushi_reallive::{
    Framebuffer, Gameexe, TextLayer, WipeColour, encode_png_rgba_deterministic,
};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!(
            "usage: speaker_color_diag <gameexe.ini> <out.png> [KEY::text ...]\n\
             e.g. Gameexe.ini .private-render/diag/speaker-color-01.png"
        );
        std::process::exit(2);
    }
    let gameexe_path = PathBuf::from(&args[1]);
    let out_path = PathBuf::from(&args[2]);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }

    let gameexe_bytes = std::fs::read(&gameexe_path).expect("read Gameexe.ini");
    let gameexe = Gameexe::parse(&gameexe_bytes).expect("parse Gameexe.ini");
    let config = gameexe.message_window(0);
    let screen_size = gameexe.screen_size_px();
    let resolver = gameexe.namae_resolver();
    assert!(
        !resolver.is_empty(),
        "the game's #NAMAE table resolved zero speakers"
    );

    // Staged (KEY, English) pairs — default to the two screenshot speakers.
    let staged: Vec<(String, String)> = if args.len() > 3 {
        args[3..]
            .iter()
            .filter_map(|arg| {
                arg.split_once("::")
                    .map(|(k, t)| (k.trim().to_string(), t.to_string()))
            })
            .collect()
    } else {
        vec![
            (
                "和人".to_string(),
                "Kazuto: So this is where you've been hiding.".to_string(),
            ),
            (
                "真理子".to_string(),
                "Mariko: D-don't just barge in like that!".to_string(),
            ),
        ]
    };

    // Resolve each staged speaker's display name + colour from the REAL
    // #NAMAE + #COLOR_TABLE tables (asserted, never hardcoded).
    let frame_size = screen_size;
    let take = staged.len();
    let gap = 8u32;
    let mut sheet = Framebuffer::new(
        frame_size.0,
        frame_size.1 * take as u32 + gap * (take.saturating_sub(1)) as u32,
    );
    sheet.fill(WipeColour::opaque_rgb(0x00, 0x00, 0x00));

    for (i, (key, text)) in staged.iter().enumerate() {
        let resolved = resolver
            .resolve(key)
            .unwrap_or_else(|| panic!("#NAMAE key {key:?} did not resolve to a speaker"));
        println!(
            "speaker key={key:?} -> display={:?} color={:?}",
            resolved.display_name, resolved.color
        );
        let [r, g, b] = resolved.color;
        let mut frame = Framebuffer::new(frame_size.0, frame_size.1);
        // Neutral backdrop (honest: not faked game art) so the box + the
        // coloured glyphs read clearly for visual verification.
        frame.fill(WipeColour::opaque_rgb(0x1a, 0x1e, 0x2c));
        let layer = TextLayer::message_window_colored(
            text,
            Some(resolved.display_name.as_str()),
            Some(WipeColour::opaque_rgb(r, g, b)),
            &config,
            screen_size,
            frame_size,
        );
        let painted = frame.draw_text(&layer);
        assert!(painted > 0, "message glyphs must paint for {key:?}");
        assert!(
            layer.name_box.is_some(),
            "NAME_MOD=1 + speaker must attach a name box for {key:?}"
        );
        sheet.blit(&frame, 0, (frame_size.1 + gap) * i as u32);
    }

    // Spot-assert the two documented mappings when defaults are used.
    if args.len() <= 3 {
        assert_eq!(
            resolver.resolve("和人").map(|s| s.color),
            Some([204, 204, 255]),
            "和人 → COLOR_TABLE.016 = (204,204,255) pale"
        );
        assert_eq!(
            resolver.resolve("真理子").map(|s| s.color),
            Some([255, 153, 204]),
            "真理子 → COLOR_TABLE.014 = (255,153,204) pink"
        );
    }

    let bytes = encode_png_rgba_deterministic(&sheet);
    assert_eq!(
        &bytes[..8],
        &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
        "output must be a valid PNG"
    );
    std::fs::write(&out_path, &bytes).unwrap();
    println!(
        "wrote {} ({} bytes, {}x{}, {} speaker frames)",
        out_path.display(),
        bytes.len(),
        sheet.width(),
        sheet.height(),
        take,
    );
}
