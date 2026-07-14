//! Spatial route-select diagnostic renderer
//! (`utsushi-spatial-image-choice-love-interest`).
//!
//! Renders the frame the orchestrator visually verifies against the real
//! `character-select-one-highlighted-via-hover.png` screenshot: Sweetie HD's
//! SPATIAL route / love-interest pick — two character option panels
//! side-by-side, the HOVERED side in full colour with its name shown, the
//! other side desaturated to grayscale. A two-panel montage shows the same
//! spatial select with the LEFT side hovered, then the RIGHT side hovered, so
//! the colour highlight is seen moving between the two route options.
//!
//! The option ART (the character graphics) is a faithful PLACEHOLDER panel
//! (a per-side solid fill; full colour when hovered, grayscale when not) —
//! decoding the real g00 option art is a follow-up. The spatial LAYOUT, the
//! hover colour/grayscale state, and the name label are the real behaviour.
//! The ACT half (side K → route branch K, via `goto_on($store)` on the
//! `select_objbtn` opcode) is driven by the acceptance test.
//!
//! Run:
//!   cargo run -p utsushi-reallive --example route_select_diag -- <out.png>
//!   (defaults to.private-render/diag/route-select.png)

use std::path::PathBuf;

use utsushi_reallive::{
    Framebuffer, SpatialChoiceWindow, WipeColour, encode_png_rgba_deterministic,
};

const SCREEN: (u32, u32) = (1280, 720);

// Staged English route labels (the product output). The real love-interest
// names are the game's; these stand in so no copyrighted text is committed.
const OPTION_LEFT: &str = "Rin (spirited childhood friend)";
const OPTION_RIGHT: &str = "Mei (quiet honor student)";

fn spatial_frame(options: &[String], selected: usize) -> Framebuffer {
    let mut fb = Framebuffer::new(SCREEN.0, SCREEN.1);
    // A split checkered-ish neutral backdrop the panels sit on.
    fb.fill(WipeColour::opaque_rgb(0x18, 0x1a, 0x24));
    let sw = SpatialChoiceWindow::from_options(options, selected, SCREEN);
    let painted = fb.draw_spatial_choice_window(&sw);
    assert!(painted > 0, "the hovered option's name must paint");
    fb
}

fn main() {
    let out = std::env::args().nth(1).map_or_else(
        || PathBuf::from(".private-render/diag/route-select.png"),
        PathBuf::from,
    );
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }

    let options = vec![OPTION_LEFT.to_string(), OPTION_RIGHT.to_string()];

    // Two panels: LEFT side hovered (full colour + name), then RIGHT side
    // hovered — the colour highlight moves across the two route options.
    let panels = [spatial_frame(&options, 0), spatial_frame(&options, 1)];
    let gap = 12u32;
    let n = panels.len() as u32;
    let mut sheet = Framebuffer::new(SCREEN.0, SCREEN.1 * n + gap * (n - 1));
    sheet.fill(WipeColour::opaque_rgb(0x00, 0x00, 0x00));
    for (i, panel) in panels.iter().enumerate() {
        sheet.blit(panel, 0, (SCREEN.1 + gap) * i as u32);
    }

    let bytes = encode_png_rgba_deterministic(&sheet);
    assert_eq!(&bytes[..4], &[0x89, 0x50, 0x4E, 0x47], "valid PNG magic");
    std::fs::write(&out, &bytes).unwrap();
    println!(
        "wrote {} ({} bytes, {}x{}) — 2 panels: route-select LEFT hovered, RIGHT hovered",
        out.display(),
        bytes.len(),
        sheet.width(),
        sheet.height()
    );
}
