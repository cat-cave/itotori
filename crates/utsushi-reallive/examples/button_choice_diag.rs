//! Decoded button-object choice diagnostic renderer.
//!
//! The coordinates below stand in for a prompt snapshot supplied by a real
//! replay. The example intentionally feeds explicit object bounds and image
//! references; it never derives a screen layout from the option count.

use std::path::PathBuf;

use utsushi_reallive::{
    Framebuffer, HitRect, ImageRef, ObjectButtonChoiceOption, ObjectButtonChoiceWindow, WipeColour,
    encode_png_rgba_deterministic,
};

const SCREEN: (u32, u32) = (1280, 720);

fn option(index: u16, bounds: HitRect) -> ObjectButtonChoiceOption {
    ObjectButtonChoiceOption {
        display_index: index,
        button_number: i32::from(index),
        fg_slot: usize::from(index),
        bounds,
        art: ImageRef {
            asset_key: format!("button-{index}"),
            region_index: None,
        },
    }
}

fn frame(selected: usize) -> Framebuffer {
    let choice = ObjectButtonChoiceWindow::from_metadata(
        vec![
            option(
                0,
                HitRect {
                    x: 92,
                    y: 71,
                    width: 374,
                    height: 508,
                },
            ),
            option(
                1,
                HitRect {
                    x: 691,
                    y: 128,
                    width: 318,
                    height: 424,
                },
            ),
        ],
        selected,
    );
    let mut framebuffer = Framebuffer::new(SCREEN.0, SCREEN.1);
    framebuffer.fill(WipeColour::opaque_rgb(0x18, 0x1A, 0x24));
    assert!(framebuffer.draw_object_button_choice_window(&choice) > 0);
    framebuffer
}

fn main() {
    let output = std::env::args().nth(1).map_or_else(
        || PathBuf::from(".private-render/diag/button-choice.png"),
        PathBuf::from,
    );
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).expect("create output directory");
    }
    let panels = [frame(0), frame(1)];
    let gap = 12;
    let mut sheet = Framebuffer::new(SCREEN.0, SCREEN.1 * 2 + gap);
    sheet.fill(WipeColour::BLACK);
    for (index, panel) in panels.iter().enumerate() {
        sheet.blit(panel, 0, (SCREEN.1 + gap) * index as u32);
    }
    let png = encode_png_rgba_deterministic(&sheet);
    std::fs::write(&output, png).expect("write diagnostic png");
}
