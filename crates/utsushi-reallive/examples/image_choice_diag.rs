//! Image-grid choice-render + choice-act diagnostic renderer
//! (`utsushi-graphical-image-choice-select`).
//!
//! Renders the frames the orchestrator visually verifies against the real
//! Sweetie HD clothing-box screenshots
//! (`dialogue-choice-with-clothing-boxes.png`
//! `clothing-box-choice-clicked.png`, `clothing-box-confirmation.png`):
//! the game's THIRD choice modality — the IMAGE-GRID costume pick.
//!
//!   * an IMAGE-GRID select with box 0 highlighted (the costume strip, box
//!     0 full-colour + bright frame, the others desaturated), then the same
//!     grid with box 2 highlighted (the highlight moved across the strip)
//!     then the follow-on dialogue-style CONFIRM screen (a two-option
//!     [`ChoiceWindow`], cursor on "keep") — a three-panel montage proving
//!     the "pick image -> confirm" flow.
//!
//! Both graphical modalities (the 2-way route pick and this N-icon grid)
//! ride the SAME `select_objbtn` opcode `(0,2,4)`; the image-grid
//! interpretation is keyed on the placed-button LAYOUT count (≥3 → grid)
//! tagged `choice:<idx>;imagegrid`. The costume ART (the real icon
//! graphics) is a faithful PLACEHOLDER box; the grid LAYOUT, the selected
//! colour/highlight state, the caption, and the follow-on confirm are the
//! real behaviour. The ACT half (box K -> branch K, then the confirm
//! resolves, via `goto_on($store)`) is driven by the acceptance test.
//!
//! Run:
//!   cargo run -p utsushi-reallive --example image_choice_diag -- <out.png>
//!   (defaults to.private-render/diag/image-choice.png)

use std::path::PathBuf;

use utsushi_reallive::{
    ChoiceWindow, Framebuffer, Gameexe, ImageGridChoiceWindow, WipeColour,
    encode_png_rgba_deterministic,
};

const SCREEN: (u32, u32) = (1280, 720);

// Staged English costume labels (the product output). The real costume
// names are the game's; these stand in so no copyrighted text is committed.
const COSTUME_A: &str = "Swimsuit high leg";
const COSTUME_B: &str = "Qipao dress";
const COSTUME_C: &str = "School uniform";

// The follow-on dialogue-style confirm options.
const CONFIRM_KEEP: &str = "Leave it as it is";
const CONFIRM_REDO: &str = "Think it over a little more";

fn grid_frame(options: &[String], selected: usize) -> Framebuffer {
    let mut fb = Framebuffer::new(SCREEN.0, SCREEN.1);
    fb.fill(WipeColour::opaque_rgb(0x18, 0x1a, 0x24));
    let grid = ImageGridChoiceWindow::from_options(options, selected, SCREEN);
    let painted = fb.draw_image_grid_choice_window(&grid);
    assert!(painted > 0, "the selected box's caption must paint");
    fb
}

fn confirm_frame(gameexe: &Gameexe, options: &[String], selected: usize) -> Framebuffer {
    let sel_config = gameexe.sel_window();
    let screen = gameexe.screen_size_px();
    let mut fb = Framebuffer::new(screen.0, screen.1);
    fb.fill(WipeColour::opaque_rgb(0x14, 0x18, 0x26));
    let cw = ChoiceWindow::from_config(options, selected, &sel_config, screen, screen);
    let painted = fb.draw_choice_window(&cw);
    assert!(painted > 0, "confirm choice glyphs must paint");
    fb
}

fn main() {
    let out = std::env::args().nth(1).map_or_else(
        || PathBuf::from(".private-render/diag/image-choice.png"),
        PathBuf::from,
    );
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }

    // Real-shaped Gameexe for the follow-on confirm (a standard dialogue
    // select window), fully config-driven.
    let ini = b"#SCREENSIZE_MOD=0,1280,720\r\n\
        #DEFAULT_SEL_WINDOW=031\r\n\
        #WINDOW.031.POS=0:120,200\r\n\
        #WINDOW.031.ATTR_MOD=1\r\n\
        #WINDOW.031.ATTR=24,36,66,225,0\r\n\
        #WINDOW.031.MOJI_SIZE=30\r\n\
        #WINDOW.031.MOJI_POS=22,12,32,32\r\n\
        #WINDOW.031.MOJI_CNT=28,6\r\n\
        #WINDOW.031.MOJI_REP=0,16\r\n";
    let gameexe = Gameexe::parse(ini).expect("parse gameexe");

    let costumes = vec![
        COSTUME_A.to_string(),
        COSTUME_B.to_string(),
        COSTUME_C.to_string(),
    ];
    let confirm = vec![CONFIRM_KEEP.to_string(), CONFIRM_REDO.to_string()];

    // Three-panel montage: image grid box 0 selected, image grid box 2
    // selected (highlight moved), then the follow-on confirm.
    let panels = [
        grid_frame(&costumes, 0),
        grid_frame(&costumes, 2),
        confirm_frame(&gameexe, &confirm, 0),
    ];
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
        "wrote {} ({} bytes, {}x{}) — 3 panels: image-grid box 0, image-grid box 2, follow-on confirm",
        out.display(),
        bytes.len(),
        sheet.width(),
        sheet.height()
    );
}
