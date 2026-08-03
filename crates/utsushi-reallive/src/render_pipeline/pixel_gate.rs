//! Pixel-space guard for localized message text.
//!
//! The decoder's `TextLine` is deliberately NOT evidence that the line made
//! it into a frame. This gate consumes the glyph coverage masks the rasterizer
//! produced and the framebuffer bytes changed by their blend. It rejects
//! invisible text, text blitted outside its intended raster region, and a
//! diverse input that collapsed into repeated replacement-glyph masks.

use std::collections::BTreeSet;

use super::Framebuffer;

/// Inclusive bounds in framebuffer pixel coordinates.
#[derive(Clone, Copy, Debug)]
pub struct PixelBounds {
    pub left: u32,
    pub top: u32,
    pub right: u32,
    pub bottom: u32,
}

impl PixelBounds {
    pub(crate) fn include(&mut self, other: Self) {
        self.left = self.left.min(other.left);
        self.top = self.top.min(other.top);
        self.right = self.right.max(other.right);
        self.bottom = self.bottom.max(other.bottom);
    }

    fn overlaps(self, other: Self) -> bool {
        self.left <= other.right
            && other.left <= self.right
            && self.top <= other.bottom
            && other.top <= self.bottom
    }
}

/// One actual glyph coverage bitmap, before it is source-over blended.
pub(crate) struct GlyphRaster {
    pub(crate) source: char,
    pub(crate) coverage_signature: String,
    /// Source-free line grouping for emitted-frame OCR geometry. The OCR
    /// readback receives this index and bounds, never [`Self::source`].
    pub(crate) line_index: usize,
    pub(crate) bounds: PixelBounds,
}

/// Raster evidence produced while painting one [`TextLayer`](super::TextLayer).
#[derive(Default)]
pub(crate) struct TextRaster {
    pub(crate) coverage_pixels: u64,
    pub(crate) glyphs: Vec<GlyphRaster>,
}

impl TextRaster {
    pub(crate) fn expected_bounds(&self) -> Option<PixelBounds> {
        self.glyphs
            .iter()
            .map(|glyph| glyph.bounds)
            .reduce(|mut all, next| {
                all.include(next);
                all
            })
    }
}

/// The pixels a text draw actually changed after blending.
pub(crate) struct PixelDelta {
    bounds: Option<PixelBounds>,
}

impl PixelDelta {
    pub(crate) fn between(before: &[u8], after: &Framebuffer) -> Self {
        let mut bounds: Option<PixelBounds> = None;
        let width = after.width() as usize;
        for (index, (old, new)) in before
            .chunks_exact(4)
            .zip(after.pixels().chunks_exact(4))
            .enumerate()
        {
            if old == new {
                continue;
            }
            let pixel = PixelBounds {
                left: (index % width) as u32,
                top: (index / width) as u32,
                right: (index % width) as u32,
                bottom: (index / width) as u32,
            };
            match &mut bounds {
                Some(existing) => existing.include(pixel),
                None => bounds = Some(pixel),
            }
        }
        Self { bounds }
    }
}

/// A localized text layer failed to produce the pixels its input requires.
#[derive(Debug, thiserror::Error)]
pub enum PixelGateError {
    #[error(
        "localized glyph raster changed zero framebuffer pixels despite {coverage_pixels} coverage pixels ({code})"
    )]
    Invisible {
        code: &'static str,
        coverage_pixels: u64,
    },
    #[error(
        "localized glyph raster landed outside its expected pixel region: expected={expected:?} actual={actual:?} ({code})"
    )]
    WrongPosition {
        code: &'static str,
        expected: PixelBounds,
        actual: PixelBounds,
    },
    #[error(
        "localized glyph raster collapsed {source_shapes} distinct input glyphs into {actual_shapes} coverage masks ({code})"
    )]
    ReplacementGlyphs {
        code: &'static str,
        source_shapes: usize,
        actual_shapes: usize,
    },
}

/// Stable diagnostic codes emitted by the pixel-space message gate.
pub const RENDER_PIPELINE_INVISIBLE_TEXT_CODE: &str =
    "utsushi.reallive.render_pipeline.invisible_text_pixels";
pub const RENDER_PIPELINE_WRONG_TEXT_POSITION_CODE: &str =
    "utsushi.reallive.render_pipeline.wrong_text_pixel_position";
pub const RENDER_PIPELINE_REPLACEMENT_GLYPH_CODE: &str =
    "utsushi.reallive.render_pipeline.replacement_glyph_pixels";

/// Assert the raster output, never the decoded input alone.
pub(crate) fn assert_visible(raster: &TextRaster, delta: PixelDelta) -> Result<(), PixelGateError> {
    let Some(expected) = raster.expected_bounds() else {
        // Whitespace has no glyph bitmap. The established blank-layer gate
        // owns that case and reports its useful char/line counts.
        return Ok(());
    };
    let Some(actual) = delta.bounds else {
        return Err(PixelGateError::Invisible {
            code: RENDER_PIPELINE_INVISIBLE_TEXT_CODE,
            coverage_pixels: raster.coverage_pixels,
        });
    };
    if !expected.overlaps(actual) {
        return Err(PixelGateError::WrongPosition {
            code: RENDER_PIPELINE_WRONG_TEXT_POSITION_CODE,
            expected,
            actual,
        });
    }

    // The reference is the structural property of the raster, not the
    // decoder: distinct visible input characters must produce distinct
    // coverage bitmaps. A font-resolution failure maps every character to
    // .notdef, yielding one repeated replacement-box mask.
    let source_shapes: BTreeSet<char> = raster.glyphs.iter().map(|glyph| glyph.source).collect();
    if source_shapes.len() < 2 {
        return Ok(());
    }
    let actual_shapes: BTreeSet<&str> = raster
        .glyphs
        .iter()
        .map(|glyph| glyph.coverage_signature.as_str())
        .collect();
    if actual_shapes.len() < source_shapes.len().min(3) {
        return Err(PixelGateError::ReplacementGlyphs {
            code: RENDER_PIPELINE_REPLACEMENT_GLYPH_CODE,
            source_shapes: source_shapes.len(),
            actual_shapes: actual_shapes.len(),
        });
    }
    Ok(())
}
