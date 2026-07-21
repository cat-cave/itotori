//! Button-object choice rendering uses decoded object metadata, not a layout
//! selected from the number of options.

use utsushi_reallive::{
    Framebuffer, HitRect, ImageRef, ObjectButtonChoiceOption, ObjectButtonChoiceWindow, WipeColour,
};

fn option(index: u16, bounds: HitRect) -> ObjectButtonChoiceOption {
    ObjectButtonChoiceOption {
        display_index: index,
        button_number: i32::from(index),
        fg_slot: usize::from(index) + 10,
        bounds,
        art: ImageRef {
            asset_key: format!("button-{index}"),
            region_index: Some(u32::from(index)),
        },
    }
}

#[test]
fn button_choice_draws_focus_at_decoded_rectangles_without_replacing_art() {
    let options = vec![
        option(
            0,
            HitRect {
                x: 6,
                y: 12,
                width: 25,
                height: 17,
            },
        ),
        option(
            1,
            HitRect {
                x: 64,
                y: 3,
                width: 18,
                height: 38,
            },
        ),
        option(
            2,
            HitRect {
                x: -8,
                y: 50,
                width: 30,
                height: 14,
            },
        ),
    ];
    let choice = ObjectButtonChoiceWindow::from_metadata(options.clone(), 1);
    let mut framebuffer = Framebuffer::new(96, 72);
    let background = WipeColour::opaque_rgb(0x14, 0x18, 0x26);
    framebuffer.fill(background);

    assert!(framebuffer.draw_object_button_choice_window(&choice) > 0);
    assert_eq!(
        choice.options, options,
        "decoded metadata is preserved verbatim"
    );
    assert_eq!(choice.selected, 1);

    // The midpoint carries no generated placeholder fill: actual g00 art is
    // composited by RenderPass before this focus overlay.
    let midpoint = ((20usize * 96 + 18) * 4)..((20usize * 96 + 18) * 4 + 4);
    assert_eq!(&framebuffer.pixels()[midpoint], &[0x14, 0x18, 0x26, 0xFF]);
    // The selected rectangle's exact decoded top-left coordinate is focused.
    let selected_top_left = ((3usize * 96 + 64) * 4)..((3usize * 96 + 64) * 4 + 4);
    assert_eq!(
        &framebuffer.pixels()[selected_top_left],
        &[0xFF, 0xE0, 0x66, 0xFF]
    );
}

#[test]
fn button_choice_clamps_focus_but_never_repositions_metadata() {
    let bounds = HitRect {
        x: 41,
        y: 27,
        width: 19,
        height: 11,
    };
    let choice = ObjectButtonChoiceWindow::from_metadata(vec![option(7, bounds)], 999);
    assert_eq!(choice.selected, 0);
    assert_eq!(choice.options[0].bounds, bounds);
    assert_eq!(choice.options[0].art.asset_key, "button-7");
}
