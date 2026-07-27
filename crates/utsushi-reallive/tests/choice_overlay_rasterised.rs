//! Acceptance: a choice gate's options reach the RASTERISED FRAME, each at
//! its own coordinates, across the full width of the surface.
//!
//! # Why this asserts on pixels
//!
//! Every check that reads the decoded option list, the emitted `TextLine`s,
//! or the laid-out `ChoiceWindow` fields passes while the frame a user
//! actually sees shows one option, N options stacked on one spot, or nothing
//! at all — the layout struct is correct and the compositor never draws it,
//! or draws every row through the same origin. Those are exactly the
//! failures reported from looking at real frames.
//!
//! So these tests read back the composited [`Framebuffer`] pixels:
//!
//! * `every_option_paints_its_own_rasterised_row` — count the framebuffer
//!   ROWS carrying option glyphs. N options must produce N disjoint painted
//!   bands. Collapse them onto one origin and the count drops to 1.
//! * `option_glyphs_reach_the_full_surface_width` — a centred option on a
//!   wide surface must paint pixels PAST the horizontal midpoint. A
//!   composition truncated at `width / 2` paints none.
//! * `emit_rejects_a_choice_overlay_that_paints_nothing` — an overlay with
//!   options that lands entirely off-surface is refused at the emit
//!   boundary instead of shipping a frame with no visible choices.

use std::path::PathBuf;

use utsushi_core::RuntimeArtifactRoot;
use utsushi_reallive::{
    ChoiceOverlay, ChoiceWindow, Framebuffer, GraphicsObjectStack, MessageWindowConfig,
    RENDER_PIPELINE_BLANK_CHOICE_OVERLAY_CODE, RecordingFrameArtifactSink, RenderEmitError,
    RenderPass, SceneEmit, SelectButtonLayout, TextLayer,
};

const SCREEN: (u32, u32) = (1280, 720);

/// The focused row's highlight bar leads its text origin by this many
/// pixels, so a painted band may start that much above its option's
/// origin — but never inside a NEIGHBOUR's row.
const FOCUS_BAR_LEAD: u32 = 2;

fn options() -> Vec<String> {
    vec![
        "first option".to_string(),
        "second option".to_string(),
        "third option".to_string(),
    ]
}

/// A `#SELBTN`-shaped layout: rows 60px apart, horizontally centred.
fn layout() -> SelectButtonLayout {
    SelectButtonLayout {
        base_pos: (0, 200),
        rep_pos: (0, 60),
        centering: (1, 0),
        moji_size: 24,
    }
}

fn window(selected: usize) -> ChoiceWindow {
    ChoiceWindow::from_select_buttons(
        &options(),
        selected,
        layout(),
        &MessageWindowConfig::default(),
        SCREEN,
        SCREEN,
    )
}

/// Rows of `framebuffer` that carry at least one non-black pixel.
fn painted_rows(framebuffer: &Framebuffer) -> Vec<u32> {
    let width = framebuffer.width() as usize;
    let pixels = framebuffer.pixels();
    (0..framebuffer.height())
        .filter(|y| {
            let start = (*y as usize) * width * 4;
            pixels[start..start + width * 4]
                .chunks_exact(4)
                .any(|px| px[0] > 0 || px[1] > 0 || px[2] > 0)
        })
        .collect()
}

/// Contiguous runs of painted rows — one band per drawn option row.
fn painted_bands(framebuffer: &Framebuffer) -> Vec<(u32, u32)> {
    let mut bands: Vec<(u32, u32)> = Vec::new();
    for row in painted_rows(framebuffer) {
        match bands.last_mut() {
            Some(band) if row == band.1 + 1 => band.1 = row,
            _ => bands.push((row, row)),
        }
    }
    bands
}

fn rasterise(choice: &ChoiceWindow) -> Framebuffer {
    let mut framebuffer = Framebuffer::new(SCREEN.0, SCREEN.1);
    let painted = framebuffer.draw_choice_overlay(&ChoiceOverlay::Text(choice));
    assert!(
        painted > 0,
        "the choice overlay painted zero pixels: the frame would show no options at all"
    );
    framebuffer
}

#[test]
fn every_option_paints_its_own_rasterised_row() {
    let framebuffer = rasterise(&window(0));
    let bands = painted_bands(&framebuffer);
    assert_eq!(
        bands.len(),
        options().len(),
        "expected one painted band per option, got {bands:?} — options that share a \
         band are stacked on one origin and the user can read only the topmost"
    );
    // The bands must land in the ROW the layout assigned each option, not
    // merely be distinct from one another.
    let choice = window(0);
    for (index, band) in bands.iter().enumerate() {
        let top = choice.option_origin_y(index).saturating_sub(FOCUS_BAR_LEAD);
        let bottom = choice.option_origin_y(index) + choice.line_height;
        assert!(
            band.0 >= top && band.1 < bottom,
            "option {index} painted rows {band:?}, outside its laid-out row [{top}, {bottom})"
        );
    }
}

#[test]
fn moving_the_cursor_moves_the_rasterised_highlight() {
    // The focus affordance must be a property of the PIXELS: if the
    // highlight never moves, every option looks equally selected.
    let first = rasterise(&window(0));
    let last = rasterise(&window(options().len() - 1));
    assert_ne!(
        first.pixels(),
        last.pixels(),
        "focusing a different option produced a byte-identical frame: the rendered \
         frame carries no visible selection state"
    );
}

#[test]
fn option_glyphs_reach_the_full_surface_width() {
    let framebuffer = rasterise(&window(0));
    let width = framebuffer.width() as usize;
    let pixels = framebuffer.pixels();
    let rightmost = (0..framebuffer.height())
        .flat_map(|y| {
            let start = (y as usize) * width * 4;
            pixels[start..start + width * 4]
                .chunks_exact(4)
                .enumerate()
                .filter(|(_, px)| px[0] > 0 || px[1] > 0 || px[2] > 0)
                .map(|(x, _)| x as u32)
                .next_back()
        })
        .max()
        .expect("the overlay painted at least one pixel");
    assert!(
        rightmost > SCREEN.0 / 2,
        "the rightmost painted pixel is x={rightmost} on a {}-wide surface; a \
         composition truncated at width/2 ({}) cannot paint past it",
        SCREEN.0,
        SCREEN.0 / 2
    );
}

#[test]
fn emit_rejects_a_choice_overlay_that_paints_nothing() {
    // Push the whole list below the surface: the layout still carries three
    // options, but not one pixel of them reaches the frame.
    let offscreen = ChoiceWindow::from_select_buttons(
        &options(),
        0,
        SelectButtonLayout {
            base_pos: (0, (SCREEN.1 + 100) as i32),
            ..layout()
        },
        &MessageWindowConfig::default(),
        SCREEN,
        SCREEN,
    );
    let temp = std::env::temp_dir().join("utsushi-choice-overlay-rasterised");
    let _ = std::fs::remove_dir_all(&temp);
    let root = RuntimeArtifactRoot::new(&temp);
    let sink = RecordingFrameArtifactSink::new();
    let private_dir: PathBuf = temp.with_extension("private");
    let mut pass = RenderPass::with_dimensions(SCREEN.0, SCREEN.1).expect("non-zero screen");
    let error = pass
        .emit_scene_screenshots(
            &GraphicsObjectStack::new(),
            &TextLayer::localized(vec!["visible dialogue".to_string()]),
            SceneEmit::frame(
                &root,
                "choice-overlay-rasterised",
                &sink,
                &private_dir,
                false,
            )
            .with_choice(ChoiceOverlay::Text(&offscreen)),
        )
        .expect_err("an all-off-surface choice overlay must not emit a frame");
    match error {
        RenderEmitError::BlankChoiceOverlay { code, option_count } => {
            assert_eq!(code, RENDER_PIPELINE_BLANK_CHOICE_OVERLAY_CODE);
            assert_eq!(option_count, options().len());
        }
        other => panic!("expected BlankChoiceOverlay, got {other:?}"),
    }
    assert!(
        sink.frames().is_empty(),
        "no frame may be announced when the choice overlay painted nothing"
    );
    let _ = std::fs::remove_dir_all(&temp);
}
