//! In-process RGBA framebuffer and paint helpers.

use crate::graphics_objects::{HitRect, WipeColour};

use super::{ChoiceWindow, ObjectButtonChoiceWindow, RGBA_BYTES_PER_PIXEL, TextLayer, font};

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
        if let Some(name_box) = &layer.name_box {
            painted += self.draw_text(name_box);
        }
        painted
    }

    /// Paint a configuration-driven text choice screen.
    pub fn draw_choice_window(&mut self, choice: &ChoiceWindow) -> u64 {
        let backdrop = choice.backdrop;
        self.fill_rect_blended(
            backdrop.x,
            backdrop.y,
            backdrop.width,
            backdrop.height,
            backdrop.colour,
        );
        let mut painted = 0;
        for (index, option) in choice.options.iter().enumerate() {
            let focused = index == choice.selected;
            let row_y = choice
                .origin_y
                .saturating_add((index as u32).saturating_mul(choice.line_height));
            if focused {
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
            painted += self.draw_text(&TextLayer {
                lines: vec![format!("{}{option}", choice.prefix(index))],
                origin_x: choice.origin_x,
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
