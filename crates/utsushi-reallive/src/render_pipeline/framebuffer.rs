//! In-process RGBA framebuffer and paint helpers.

use crate::graphics_objects::{HitRect, WipeColour};

use super::{
    ChoiceOverlay, ChoiceWindow, ObjectButtonChoiceWindow, RGBA_BYTES_PER_PIXEL, TextLayer, font,
    ocr_readback::OcrLayout,
    pixel_gate::{self, PixelGateError},
};

/// In-process framebuffer. A `width × height` grid of RGBA bytes in row-major
/// order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Framebuffer {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pixels: Vec<u8>,
}

impl Framebuffer {
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
    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    /// Flatten the framebuffer over opaque black for screenshot encoding.
    /// Rasterisation itself retains alpha, but browser-facing PNGs must not
    /// depend on a viewer's transparency checkerboard.
    pub(crate) fn flatten_over_black(&mut self) {
        for pixel in self.pixels.chunks_exact_mut(RGBA_BYTES_PER_PIXEL) {
            if pixel[3] == 0 {
                pixel[..3].fill(0);
            }
            pixel[3] = 0xFF;
        }
    }
    pub(crate) fn in_bounds(&self, x: u32, y: u32) -> bool {
        x < self.width && y < self.height
    }

    /// Fill the framebuffer with `colour` in RGBA order.
    pub fn fill(&mut self, colour: WipeColour) {
        let pattern = [colour.red, colour.green, colour.blue, colour.alpha];
        for (index, byte) in self.pixels.iter_mut().enumerate() {
            *byte = pattern[index % RGBA_BYTES_PER_PIXEL];
        }
    }

    /// Copy `src` verbatim at `(dst_x, dst_y)`, clipping out-of-bounds pixels.
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

    /// Source-over composite one pixel, modulating source alpha by
    /// `object_alpha`. Out-of-bounds coordinates are a no-op.
    pub(crate) fn blend_pixel(
        &mut self,
        x: u32,
        y: u32,
        src: [u8; RGBA_BYTES_PER_PIXEL],
        object_alpha: u8,
    ) {
        if !self.in_bounds(x, y) {
            return;
        }
        let cover = ((src[3] as u32) * (object_alpha as u32)) / 255;
        if cover == 0 {
            return;
        }
        let offset = ((y as usize) * (self.width as usize) + x as usize) * RGBA_BYTES_PER_PIXEL;
        let inv = 255 - cover;
        for (channel, &source) in src.iter().take(3).enumerate() {
            let destination = self.pixels[offset + channel] as u32;
            self.pixels[offset + channel] =
                ((source as u32 * cover + destination * inv + 127) / 255) as u8;
        }
        let destination_alpha = self.pixels[offset + 3] as u32;
        self.pixels[offset + 3] = (cover + (destination_alpha * inv + 127) / 255).min(255) as u8;
    }

    pub fn fill_blended(&mut self, colour: WipeColour, object_alpha: u8) {
        let src = [colour.red, colour.green, colour.blue, colour.alpha];
        for y in 0..self.height {
            for x in 0..self.width {
                self.blend_pixel(x, y, src, object_alpha);
            }
        }
    }

    pub fn fill_rect_blended(&mut self, x: u32, y: u32, w: u32, h: u32, colour: WipeColour) {
        let src = [colour.red, colour.green, colour.blue, colour.alpha];
        for py in y..y.saturating_add(h) {
            for px in x..x.saturating_add(w) {
                self.blend_pixel(px, py, src, 0xFF);
            }
        }
    }

    /// Paint a [`TextLayer`] and return glyph-coverage pixels (not backdrop
    /// pixels).
    pub fn draw_text(&mut self, layer: &TextLayer) -> u64 {
        self.paint_text_backdrop(layer);
        let mut painted = font::draw_lines(self, layer);
        if let Some(name_box) = &layer.name_box {
            painted += self.draw_text(name_box);
        }
        painted
    }

    /// Paint just one layer's backing box. The emitted-frame OCR uses this as
    /// a pixel baseline before it reopens the completed public PNG; no text
    /// bytes are copied into that baseline. An attached name box is a later
    /// paint operation, just as it is in [`Self::draw_text`].
    pub(crate) fn paint_text_backdrop(&mut self, layer: &TextLayer) {
        if let Some(backdrop) = layer.backdrop {
            self.fill_rect_blended(
                backdrop.x,
                backdrop.y,
                backdrop.width,
                backdrop.height,
                backdrop.colour,
            );
        }
    }

    /// Paint text and validate the pixels that changed, not merely the input
    /// string. The regular `draw_text` remains available for diagnostics and
    /// layout probes; screenshot emission must use this checked boundary.
    pub(crate) fn draw_text_checked(&mut self, layer: &TextLayer) -> Result<u64, PixelGateError> {
        self.paint_text_backdrop(layer);
        self.draw_text_checked_without_backdrop(layer)
    }

    /// Checked text draw that additionally records source-free body geometry
    /// for later OCR of the persisted public frame. Attached speaker-name
    /// glyphs remain in the image but are intentionally not part of the body
    /// text readback.
    pub(crate) fn draw_text_checked_with_ocr(
        &mut self,
        layer: &TextLayer,
        layout: &mut OcrLayout,
    ) -> Result<u64, PixelGateError> {
        self.paint_text_backdrop(layer);
        let before = self.pixels.clone();
        let raster = font::rasterise_lines_with_ocr(self, layer, layout);
        pixel_gate::assert_visible(&raster, pixel_gate::PixelDelta::between(&before, self))?;
        let mut painted = raster.coverage_pixels;
        if let Some(name_box) = &layer.name_box {
            painted += self.draw_text_checked(name_box)?;
        }
        Ok(painted)
    }

    fn draw_text_checked_without_backdrop(
        &mut self,
        layer: &TextLayer,
    ) -> Result<u64, PixelGateError> {
        let before = self.pixels.clone();
        let raster = font::rasterise_lines(self, layer, font::RasterMode::Normal);
        pixel_gate::assert_visible(&raster, pixel_gate::PixelDelta::between(&before, self))?;
        let mut painted = raster.coverage_pixels;
        if let Some(name_box) = &layer.name_box {
            painted += self.draw_text_checked(name_box)?;
        }
        Ok(painted)
    }

    /// Paint whichever selection affordance the current choice gate calls
    /// for, returning the painted-pixel count so the caller can prove the
    /// overlay actually reached the framebuffer.
    pub fn draw_choice_overlay(&mut self, overlay: &ChoiceOverlay<'_>) -> u64 {
        match overlay {
            ChoiceOverlay::Text(choice) => self.draw_choice_window(choice),
            ChoiceOverlay::ObjectButtons(choice) => self.draw_object_button_choice_window(choice),
        }
    }

    /// Paint a configuration-driven text choice screen.
    pub fn draw_choice_window(&mut self, choice: &ChoiceWindow) -> u64 {
        if let Some(backdrop) = choice.backdrop {
            self.fill_rect_blended(
                backdrop.x,
                backdrop.y,
                backdrop.width,
                backdrop.height,
                backdrop.colour,
            );
        }
        let mut painted = 0;
        for (index, option) in choice.options.iter().enumerate() {
            let focused = index == choice.selected;
            // Each option is drawn at ITS OWN laid-out coordinates. Two
            // options must never resolve to one origin: that is the
            // stacked-at-origin failure a decode-side check cannot see.
            let row_x = choice.option_origin_x(index);
            let row_y = choice.option_origin_y(index);
            if focused {
                let (bar_x, bar_width) = match choice.backdrop {
                    Some(backdrop) => (backdrop.x, backdrop.width),
                    None => (
                        row_x,
                        font::line_width(
                            &format!("{}{option}", choice.prefix(index)),
                            choice.scale as f32,
                        )
                        .round()
                        .max(1.0) as u32,
                    ),
                };
                // Sized from the GLYPH height, not the row stride: a
                // stride-tall bar overprints the option below it whenever
                // the layout packs rows tighter than the message box does.
                self.fill_rect_blended(
                    bar_x,
                    row_y.saturating_sub(2),
                    bar_width,
                    choice.scale.saturating_add(4).min(choice.line_height),
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
            painted += self.draw_text(&TextLayer {
                lines: vec![format!("{}{option}", choice.prefix(index))],
                origin_x: row_x,
                origin_y: row_y,
                scale: choice.scale,
                colour,
                backdrop: None,
                name_box: None,
                line_height: Some(choice.line_height),
            });
        }
        painted
    }

    /// Draw the focus affordance for a decoded button-object prompt. The
    /// surrounding render pass has already composited the exact g00 art named
    /// by each option's `art` field. No placeholder art or inferred layout is
    /// produced here.
    pub fn draw_object_button_choice_window(&mut self, choice: &ObjectButtonChoiceWindow) -> u64 {
        let mut painted = 0;
        for (index, option) in choice.options.iter().enumerate() {
            let (colour, thickness) = if index == choice.selected {
                (WipeColour::opaque_rgb(0xFF, 0xE0, 0x66), 4)
            } else {
                (WipeColour::opaque_rgb(0x50, 0x54, 0x60), 2)
            };
            painted += self.stroke_hit_rect(option.bounds, thickness, colour);
        }
        painted
    }

    fn stroke_hit_rect(&mut self, rect: HitRect, thickness: u32, colour: WipeColour) -> u64 {
        let right = rect.x.saturating_add(rect.width);
        let bottom = rect.y.saturating_add(rect.height);
        let left = rect.x.max(0).min(self.width as i32) as u32;
        let top = rect.y.max(0).min(self.height as i32) as u32;
        let right = right.max(0).min(self.width as i32) as u32;
        let bottom = bottom.max(0).min(self.height as i32) as u32;
        if right <= left || bottom <= top {
            return 0;
        }
        let width = right - left;
        let height = bottom - top;
        self.stroke_rect(left, top, width, height, thickness, colour);
        let perimeter = width
            .saturating_mul(2)
            .saturating_add(height.saturating_mul(2));
        perimeter.saturating_mul(thickness.min(width).min(height).max(1)) as u64
    }

    fn stroke_rect(&mut self, x: u32, y: u32, w: u32, h: u32, thickness: u32, colour: WipeColour) {
        let t = thickness.min(w).min(h).max(1);
        self.fill_rect_blended(x, y, w, t, colour);
        self.fill_rect_blended(x, y.saturating_add(h).saturating_sub(t), w, t, colour);
        self.fill_rect_blended(x, y, t, h, colour);
        self.fill_rect_blended(x.saturating_add(w).saturating_sub(t), y, t, h, colour);
    }
}
