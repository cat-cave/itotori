//! In-process RGBA framebuffer and its paint helpers.
//!
//! Extracted from the parent [`crate::render_pipeline`] module so the
//! raster buffer surface (fill / blend / text / choice painting) lives
//! in its own ≤500-line child. Public items are re-exported from the
//! parent to keep the crate API path unchanged.

use crate::graphics_objects::WipeColour;

use super::{
    ChoiceWindow, ImageGridChoiceWindow, RGBA_BYTES_PER_PIXEL, SpatialChoiceWindow, TextBackdrop,
    TextLayer, font,
};

/// In-process framebuffer. A `width × height` grid of RGBA bytes in
/// row-major order. The render pass writes into the buffer directly;
/// the encoder consumes it byte-for-byte.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Framebuffer {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pixels: Vec<u8>,
}

impl Framebuffer {
    /// Construct a `width × height` framebuffer, initialised to the
    /// fully-transparent (`r=g=b=a=0`) pattern.
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![0u8; (width as usize) * (height as usize) * RGBA_BYTES_PER_PIXEL],
        }
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// Borrow the raw RGBA bytes in row-major order.
    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    /// Fill the entire framebuffer with `colour`, **in RGBA order**.
    /// The wipe-object renderer routes through this method.
    pub fn fill(&mut self, colour: WipeColour) {
        let pattern = [colour.red, colour.green, colour.blue, colour.alpha];
        for (index, byte) in self.pixels.iter_mut().enumerate() {
            *byte = pattern[index % RGBA_BYTES_PER_PIXEL];
        }
    }

    /// Copy every pixel of `src` into this framebuffer with its top-left
    /// at `(dst_x, dst_y)` (verbatim overwrite, no blending). Portions
    /// that fall outside this framebuffer are clipped. Used to stack
    /// several rendered message frames into one contact-sheet image for
    /// the message-window diagnostics.
    pub fn blit(&mut self, src: &Framebuffer, dst_x: u32, dst_y: u32) {
        for sy in 0..src.height {
            let py = dst_y + sy;
            if py >= self.height {
                break;
            }
            for sx in 0..src.width {
                let px = dst_x + sx;
                if px >= self.width {
                    break;
                }
                let src_off =
                    ((sy as usize) * (src.width as usize) + sx as usize) * RGBA_BYTES_PER_PIXEL;
                let dst_off =
                    ((py as usize) * (self.width as usize) + px as usize) * RGBA_BYTES_PER_PIXEL;
                self.pixels[dst_off..dst_off + RGBA_BYTES_PER_PIXEL]
                    .copy_from_slice(&src.pixels[src_off..src_off + RGBA_BYTES_PER_PIXEL]);
            }
        }
    }

    /// Whether `(x, y)` addresses a real pixel in this framebuffer.
    pub(crate) fn in_bounds(&self, x: u32, y: u32) -> bool {
        x < self.width && y < self.height
    }

    /// Source-over composite one RGBA `src` pixel at `(x, y)`, modulating
    /// the source alpha by `object_alpha` (`0..=255`). The effective
    /// source coverage is `src.a * object_alpha / 255`; the result is the
    /// standard non-premultiplied source-over of `src` onto the current
    /// destination pixel. `object_alpha == 255` with an opaque `src`
    /// (`src[3] == 255`) writes `src` verbatim. Out-of-bounds coordinates
    /// are clipped (no-op).
    pub(crate) fn blend_pixel(
        &mut self,
        x: u32,
        y: u32,
        src: [u8; RGBA_BYTES_PER_PIXEL],
        object_alpha: u8,
    ) {
        if x >= self.width || y >= self.height {
            return;
        }
        // Effective coverage in 0..=255.
        let cover = ((src[3] as u32) * (object_alpha as u32)) / 255;
        if cover == 0 {
            return;
        }
        let offset = ((y as usize) * (self.width as usize) + (x as usize)) * RGBA_BYTES_PER_PIXEL;
        let inv = 255 - cover;
        for (channel, &s) in src.iter().take(3).enumerate() {
            let d = self.pixels[offset + channel] as u32;
            // Rounded source-over: (s*cover + d*inv) / 255.
            self.pixels[offset + channel] = ((s as u32 * cover + d * inv + 127) / 255) as u8;
        }
        let da = self.pixels[offset + 3] as u32;
        // out_a = cover + da*(1 - cover); non-premultiplied alpha.
        self.pixels[offset + 3] = (cover + (da * inv + 127) / 255).min(255) as u8;
    }

    /// Blend `colour` across the entire framebuffer, modulating the
    /// fill by `object_alpha`. A wipe object routes through this method so
    /// its recorded object-level alpha (and its own `colour.alpha`) are
    /// applied: an opaque wipe fills verbatim, a fully-transparent-alpha
    /// wipe contributes nothing.
    pub fn fill_blended(&mut self, colour: WipeColour, object_alpha: u8) {
        let src = [colour.red, colour.green, colour.blue, colour.alpha];
        for y in 0..self.height {
            for x in 0..self.width {
                self.blend_pixel(x, y, src, object_alpha);
            }
        }
    }

    /// Source-over blend a filled rectangle of `colour` (its own
    /// `colour.alpha` is honoured) at `(x, y)` with extent `w × h`.
    /// Out-of-bounds portions are clipped. Used to paint the translucent
    /// dialogue-box backdrop behind the localized text so mixed-case
    /// glyphs stay legible over an arbitrary composited background.
    pub fn fill_rect_blended(&mut self, x: u32, y: u32, w: u32, h: u32, colour: WipeColour) {
        let src = [colour.red, colour.green, colour.blue, colour.alpha];
        for py in y..y.saturating_add(h) {
            for px in x..x.saturating_add(w) {
                self.blend_pixel(px, py, src, 0xFF);
            }
        }
    }

    /// Paint a [`TextLayer`] over the framebuffer.
    ///
    /// If the layer carries a [`TextBackdrop`], the translucent box is
    /// blended first so the glyphs read against a controlled backing (the
    /// dialogue-box look). The lines are then rasterised through the
    /// bundled TrueType [`font`] (DejaVu Sans) at `layer.scale`-derived
    /// pixel height, with real horizontal advances + kerning and
    /// anti-aliased coverage. Returns the number of GLYPH-coverage pixels
    /// painted (the backdrop fill is NOT counted), so the non-vacuous
    /// guard in the emit path still rejects a layer whose text drew
    /// nothing.
    pub fn draw_text(&mut self, layer: &TextLayer) -> u64 {
        if let Some(backdrop) = layer.backdrop {
            self.fill_rect_blended(
                backdrop.x,
                backdrop.y,
                backdrop.width,
                backdrop.height,
                backdrop.colour,
            );
        }
        let mut painted = font::draw_lines(self, layer);
        // Paint the separate speaker name box (RealLive NAME_MOD=1) on
        // top, so its backdrop + glyphs land after the message box.
        if let Some(name_box) = &layer.name_box {
            painted += self.draw_text(name_box);
        }
        painted
    }

    /// Paint a [`ChoiceWindow`] selection screen: the config-driven box
    /// backdrop, a highlight strip behind the focused option row, and each
    /// option label as its own cursor-prefixed line (the focused option in
    /// bright white, the rest dimmed). Returns the number of GLYPH-coverage
    /// pixels painted, so the non-vacuous emit guard still rejects a choice
    /// window whose options drew nothing.
    ///
    /// The stronger per-row highlight (vs. the flat [`ChoiceWindow::to_text_layer`])
    /// makes the focused option unambiguous in a diagnostic frame — the
    /// visual proof that selecting option K focuses option K.
    pub fn draw_choice_window(&mut self, choice: &ChoiceWindow) -> u64 {
        // Config-driven box backdrop.
        let backdrop = choice.backdrop;
        self.fill_rect_blended(
            backdrop.x,
            backdrop.y,
            backdrop.width,
            backdrop.height,
            backdrop.colour,
        );
        let mut painted = 0u64;
        for (index, option) in choice.options.iter().enumerate() {
            let focused = index == choice.selected;
            let row_y = choice
                .origin_y
                .saturating_add((index as u32).saturating_mul(choice.line_height));
            if focused {
                // Highlight strip behind the focused option row (a
                // translucent accent so the underlying box still reads).
                self.fill_rect_blended(
                    backdrop.x,
                    row_y.saturating_sub(2),
                    backdrop.width,
                    choice.line_height.saturating_add(4),
                    WipeColour {
                        red: 52,
                        green: 88,
                        blue: 148,
                        alpha: 160,
                    },
                );
            }
            let colour = if focused {
                WipeColour::WHITE
            } else {
                WipeColour {
                    red: 176,
                    green: 182,
                    blue: 200,
                    alpha: 255,
                }
            };
            let row = TextLayer {
                lines: vec![format!("{}{option}", choice.prefix(index))],
                origin_x: choice.origin_x,
                origin_y: row_y,
                scale: choice.scale,
                colour,
                backdrop: None,
                name_box: None,
                line_height: Some(choice.line_height),
            };
            painted += self.draw_text(&row);
        }
        painted
    }

    /// Paint a [`SpatialChoiceWindow`] — the SIDE-BY-SIDE graphical select
    /// (Sweetie HD's route / love-interest pick, driven by
    /// `sel.select_objbtn`). Each option is a panel laid out horizontally;
    /// the focused / hovered option is painted in FULL COLOUR with a bright
    /// border and its name/label below, every other option is DIMMED to
    /// grayscale with a dim border (the real screen greys the un-hovered
    /// characters and colours only the hovered one). Returns the number of
    /// GLYPH-coverage pixels painted (the selected option's name), so the
    /// non-vacuous emit guard still rejects a spatial window that drew no
    /// label.
    ///
    /// The option ART (the character option graphics) is not decoded on
    /// this path, so each panel is a faithful PLACEHOLDER: a per-option
    /// solid fill (full-colour when focused, desaturated + dimmed when not)
    /// standing in for the option's g00 art. Decoding the real option art
    /// is a follow-up; the spatial LAYOUT, the hover colour/grayscale
    /// state, and the name label are the real behaviour.
    pub fn draw_spatial_choice_window(&mut self, choice: &SpatialChoiceWindow) -> u64 {
        let mut painted = 0u64;
        for (index, option) in choice.options.iter().enumerate() {
            let focused = index == choice.selected;
            // Placeholder option-art panel: full colour when focused, a
            // desaturated + dimmed grayscale when not (the real screen
            // renders the un-hovered character grayscale).
            let panel_colour = if focused {
                option.art_colour
            } else {
                desaturate_dim(option.art_colour)
            };
            self.fill_rect_blended(option.x, option.y, option.w, option.h, panel_colour);

            // Border: a bright accent frame around the focused option, a
            // dim frame around the rest — a second, shape-level cue that
            // the selection is unambiguous.
            let (border_colour, border_thickness) = if focused {
                (WipeColour::opaque_rgb(0xFF, 0xE0, 0x66), 5u32)
            } else {
                (WipeColour::opaque_rgb(0x50, 0x54, 0x60), 2u32)
            };
            self.stroke_rect(
                option.x,
                option.y,
                option.w,
                option.h,
                border_thickness,
                border_colour,
            );

            // The focused option's NAME / label in a bottom-centre panel
            // (the real screen shows the hovered character's name + profile
            // at bottom-centre). Only the focused option is labelled, to
            // match the hover behaviour.
            if focused {
                let label_h = choice.label_height.max(1);
                let label_y = option
                    .y
                    .saturating_add(option.h)
                    .saturating_sub(label_h)
                    .max(option.y);
                let backdrop = TextBackdrop {
                    x: option.x,
                    y: label_y,
                    width: option.w,
                    height: label_h,
                    colour: WipeColour {
                        red: 16,
                        green: 20,
                        blue: 34,
                        alpha: 210,
                    },
                };
                let layer = TextLayer {
                    lines: vec![option.label.clone()],
                    origin_x: option.x.saturating_add(choice.label_scale / 2),
                    origin_y: label_y.saturating_add(label_h / 4),
                    scale: choice.label_scale,
                    colour: WipeColour::WHITE,
                    backdrop: Some(backdrop),
                    name_box: None,
                    line_height: Some(label_h),
                };
                painted += self.draw_text(&layer);
            }
        }
        painted
    }

    /// Paint an [`ImageGridChoiceWindow`] — the IMAGE-GRID graphical select
    /// (Sweetie HD's clothing / costume pick), a horizontal STRIP of small
    /// icon boxes near the top of the frame. The SELECTED box is painted in
    /// FULL COLOUR with a bright highlight border; every other box is DIMMED
    /// to grayscale with a dim border (the real screen highlights only the
    /// clicked costume box). The selected option's name is shown in a
    /// caption band below the strip — that caption is the glyph coverage the
    /// return value counts, so a not-rendered / no-caption regression still
    /// trips the non-vacuous emit guard.
    ///
    /// Like [`Self::draw_spatial_choice_window`], the option ART (the real
    /// costume icon graphics) is not decoded here: each box is a faithful
    /// per-option placeholder fill. The grid LAYOUT, the selected
    /// colour/highlight state, and the caption are the real behaviour; this
    /// select is followed by a standard dialogue-style CONFIRM (a
    /// [`ChoiceWindow`]) — the "pick image → confirm" flow.
    pub fn draw_image_grid_choice_window(&mut self, choice: &ImageGridChoiceWindow) -> u64 {
        let mut painted = 0u64;
        for (index, cell) in choice.cells.iter().enumerate() {
            let selected = index == choice.selected;
            // Placeholder icon fill: full colour when selected, desaturated
            // grayscale when not.
            let fill = if selected {
                cell.art_colour
            } else {
                desaturate_dim(cell.art_colour)
            };
            self.fill_rect_blended(cell.x, cell.y, cell.w, cell.h, fill);
            // Bright highlight frame around the selected box, a dim frame
            // around the rest — a shape-level cue on top of the colour cue.
            let (border_colour, border_thickness) = if selected {
                (WipeColour::opaque_rgb(0xFF, 0xE0, 0x66), 4u32)
            } else {
                (WipeColour::opaque_rgb(0x50, 0x54, 0x60), 2u32)
            };
            self.stroke_rect(
                cell.x,
                cell.y,
                cell.w,
                cell.h,
                border_thickness,
                border_colour,
            );
        }
        // Caption band below the strip: the SELECTED option's name, centred
        // under the grid (the costume the player has highlighted).
        if let Some(cell) = choice.cells.get(choice.selected) {
            let strip_bottom = choice
                .cells
                .iter()
                .map(|c| c.y.saturating_add(c.h))
                .max()
                .unwrap_or(cell.y.saturating_add(cell.h));
            let caption_h = choice.caption_height.max(1);
            let caption_y = strip_bottom.saturating_add(choice.caption_gap);
            let backdrop = TextBackdrop {
                x: choice.caption_x,
                y: caption_y,
                width: choice.caption_width,
                height: caption_h,
                colour: WipeColour {
                    red: 16,
                    green: 20,
                    blue: 34,
                    alpha: 210,
                },
            };
            let layer = TextLayer {
                lines: vec![cell.label.clone()],
                origin_x: choice.caption_x.saturating_add(choice.caption_scale / 2),
                origin_y: caption_y.saturating_add(caption_h / 4),
                scale: choice.caption_scale,
                colour: WipeColour::WHITE,
                backdrop: Some(backdrop),
                name_box: None,
                line_height: Some(caption_h),
            };
            painted += self.draw_text(&layer);
        }
        painted
    }

    /// Paint a hollow rectangle border of `colour`, `thickness` px wide
    /// along the inside edge of the `(x, y, w, h)` rect. Used to frame a
    /// [`SpatialChoiceWindow`] option panel.
    fn stroke_rect(&mut self, x: u32, y: u32, w: u32, h: u32, thickness: u32, colour: WipeColour) {
        let t = thickness.min(w).min(h).max(1);
        // Top + bottom edges.
        self.fill_rect_blended(x, y, w, t, colour);
        self.fill_rect_blended(x, y.saturating_add(h).saturating_sub(t), w, t, colour);
        // Left + right edges.
        self.fill_rect_blended(x, y, t, h, colour);
        self.fill_rect_blended(x.saturating_add(w).saturating_sub(t), y, t, h, colour);
    }
}

/// Desaturate a colour to its Rec.601 luminance and dim it — the
/// grayscale look the spatial select paints on an UN-hovered option
/// panel. Alpha is preserved.
pub(crate) fn desaturate_dim(colour: WipeColour) -> WipeColour {
    // Rec.601 luma in 0..=255 (integer-weighted: 0.299, 0.587, 0.114).
    let luma = ((colour.red as u32 * 299 + colour.green as u32 * 587 + colour.blue as u32 * 114)
        / 1000) as u8;
    // Dim toward black so the un-hovered panel reads as recessed.
    let dimmed = ((luma as u32) * 60 / 100) as u8;
    WipeColour {
        red: dimmed,
        green: dimmed,
        blue: dimmed,
        alpha: colour.alpha,
    }
}
