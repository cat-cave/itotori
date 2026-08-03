//! Pixel-only OCR readback for emitted public screenshot evidence.
//!
//! The render path deliberately keeps decoded dialogue out of this module.
//! Recognition receives an already-written public PNG, a pixel baseline, and
//! glyph rectangles only. It derives the returned text by matching the PNG's
//! pixels against the bundled font's standard candidate alphabet; it never
//! copies the replay body or an expected assertion into OCR output.

use super::{
    Framebuffer, PNG_BIT_DEPTH, PNG_COLOUR_TYPE_RGBA, PNG_FILE_MAGIC, RGBA_BYTES_PER_PIXEL,
    TextLayer, adler32, font,
    pixel_gate::{PixelBounds, TextRaster},
    sha256_hex,
};

/// How the emitted-frame OCR readback resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RasterOcrStatus {
    /// Every visible glyph slot matched a candidate from the standard alphabet.
    Passed,
    /// At least one slot could not be read from the emitted frame pixels.
    Failed,
}

impl RasterOcrStatus {
    /// Stable JSON-safe spelling for the CLI evidence report.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
        }
    }
}

/// OCR evidence read back from a public PNG that the renderer already wrote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RasterOcrReadback {
    /// Text recognized from the public PNG pixels. Unknown glyphs are U+FFFD.
    pub text: String,
    /// `passed` only when every glyph slot matched the public-frame pixels.
    pub status: RasterOcrStatus,
    /// Number of glyph slots recognized from the emitted PNG.
    pub recognized_glyph_count: usize,
    /// Number of glyph slots that did not match a candidate.
    pub unrecognized_glyph_count: usize,
    /// SHA-256 of the exact PNG bytes that were decoded for this readback.
    pub frame_sha256: String,
}

/// A malformed or non-deterministic public artifact cannot be OCR evidence.
#[derive(Debug, thiserror::Error)]
pub enum RasterOcrReadbackError {
    #[error("public OCR input is not the deterministic RGBA PNG format: {reason}")]
    InvalidPng { reason: String },
    #[error(
        "public OCR frame dimensions differ from its render baseline: png={png_width}x{png_height} baseline={baseline_width}x{baseline_height}"
    )]
    DimensionMismatch {
        png_width: u32,
        png_height: u32,
        baseline_width: u32,
        baseline_height: u32,
    },
}

/// Source-free glyph geometry recorded while the renderer paints a body layer.
///
/// It intentionally stores no decoded character, expected output, replay line,
/// coverage signature, or glyph bitmap. The recognizer receives only these
/// rectangles plus the public pixels it reopens after artifact emission.
#[derive(Default)]
pub(crate) struct OcrLayout {
    scale: Option<u32>,
    colour: Option<[u8; RGBA_BYTES_PER_PIXEL]>,
    slots: Vec<OcrGlyphSlot>,
}

struct OcrGlyphSlot {
    line_index: usize,
    bounds: PixelBounds,
}

impl OcrLayout {
    pub(crate) fn record(&mut self, raster: &TextRaster, layer: &TextLayer) {
        self.scale = Some(layer.scale);
        self.colour = Some([
            layer.colour.red,
            layer.colour.green,
            layer.colour.blue,
            layer.colour.alpha,
        ]);
        self.slots
            .extend(raster.glyphs.iter().map(|glyph| OcrGlyphSlot {
                line_index: glyph.line_index,
                bounds: glyph.bounds,
            }));
    }
}

/// Read the exact public PNG bytes after the emitter persisted them and
/// independently recognize the body glyphs from their pixels.
pub(crate) fn recognize_emitted_png(
    png_bytes: &[u8],
    baseline: &Framebuffer,
    layout: &OcrLayout,
) -> Result<RasterOcrReadback, RasterOcrReadbackError> {
    let decoded = decode_deterministic_rgba_png(png_bytes)?;
    if decoded.width != baseline.width() || decoded.height != baseline.height() {
        return Err(RasterOcrReadbackError::DimensionMismatch {
            png_width: decoded.width,
            png_height: decoded.height,
            baseline_width: baseline.width(),
            baseline_height: baseline.height(),
        });
    }

    let Some(scale) = layout.scale else {
        return Ok(empty_readback(png_bytes, RasterOcrStatus::Failed));
    };
    let Some(colour) = layout.colour else {
        return Ok(empty_readback(png_bytes, RasterOcrStatus::Failed));
    };
    if layout.slots.is_empty() {
        return Ok(empty_readback(png_bytes, RasterOcrStatus::Failed));
    }

    let candidates = font::ocr_candidates(scale);
    let space_advance = font::ocr_space_advance(scale);
    let mut text = String::new();
    let mut recognized = 0usize;
    let mut unrecognized = 0usize;
    let mut previous: Option<(usize, PixelBounds, font::OcrGlyphCandidate)> = None;

    for slot in &layout.slots {
        let choice = choose_candidate(
            &decoded.pixels,
            baseline.pixels(),
            decoded.width,
            slot.bounds,
            colour,
            &candidates,
        );
        if let Some((line_index, _, _)) = &previous
            && *line_index != slot.line_index
        {
            text.push('\n');
        } else if let Some((_, prior_bounds, prior)) = &previous
            && needs_space(
                *prior_bounds,
                prior,
                slot.bounds,
                choice.as_ref(),
                space_advance,
            )
        {
            text.push(' ');
        }

        if let Some(candidate) = choice {
            text.push(candidate.character);
            recognized += 1;
            previous = Some((slot.line_index, slot.bounds, candidate));
        } else {
            text.push('\u{FFFD}');
            unrecognized += 1;
            previous = None;
        }
    }

    Ok(RasterOcrReadback {
        text,
        status: if unrecognized == 0 {
            RasterOcrStatus::Passed
        } else {
            RasterOcrStatus::Failed
        },
        recognized_glyph_count: recognized,
        unrecognized_glyph_count: unrecognized,
        frame_sha256: sha256_hex(png_bytes),
    })
}

fn empty_readback(png_bytes: &[u8], status: RasterOcrStatus) -> RasterOcrReadback {
    RasterOcrReadback {
        text: String::new(),
        status,
        recognized_glyph_count: 0,
        unrecognized_glyph_count: 0,
        frame_sha256: sha256_hex(png_bytes),
    }
}

fn choose_candidate(
    pixels: &[u8],
    baseline: &[u8],
    frame_width: u32,
    bounds: PixelBounds,
    colour: [u8; RGBA_BYTES_PER_PIXEL],
    candidates: &[font::OcrGlyphCandidate],
) -> Option<font::OcrGlyphCandidate> {
    let width = bounds.right.checked_sub(bounds.left)?.checked_add(1)?;
    let height = bounds.bottom.checked_sub(bounds.top)?.checked_add(1)?;
    candidates
        .iter()
        .filter(|candidate| candidate.width == width && candidate.height == height)
        .map(|candidate| {
            let score = glyph_score(pixels, baseline, frame_width, bounds, colour, candidate);
            (score, candidate)
        })
        .min_by_key(|(score, _)| *score)
        .and_then(|(score, candidate)| {
            // The public PNG uses lossless stored-deflate, so a correct match
            // is normally exact. Permit at most one channel level per sampled
            // component for the renderer's integer alpha-rounding boundary;
            // a different glyph's coverage shape is orders of magnitude
            // farther away and remains an OCR failure.
            let components = u64::from(width) * u64::from(height) * 3;
            (score <= components).then(|| candidate.clone())
        })
}

fn glyph_score(
    pixels: &[u8],
    baseline: &[u8],
    frame_width: u32,
    bounds: PixelBounds,
    colour: [u8; RGBA_BYTES_PER_PIXEL],
    candidate: &font::OcrGlyphCandidate,
) -> u64 {
    let mut score = 0u64;
    for y in 0..candidate.height {
        for x in 0..candidate.width {
            let pixel_index = ((bounds.top + y) as usize * frame_width as usize
                + (bounds.left + x) as usize)
                * RGBA_BYTES_PER_PIXEL;
            let coverage_index = (y * candidate.width + x) as usize;
            let expected = blend_reference(
                &baseline[pixel_index..pixel_index + RGBA_BYTES_PER_PIXEL],
                colour,
                candidate.coverage[coverage_index],
            );
            score += pixels[pixel_index..pixel_index + 3]
                .iter()
                .zip(expected[..3].iter())
                .map(|(actual, expected)| u64::from(actual.abs_diff(*expected)))
                .sum::<u64>();
        }
    }
    score
}

fn blend_reference(
    baseline: &[u8],
    colour: [u8; RGBA_BYTES_PER_PIXEL],
    coverage: u8,
) -> [u8; RGBA_BYTES_PER_PIXEL] {
    let cover = (u32::from(colour[3]) * u32::from(coverage)) / 255;
    let inverse = 255 - cover;
    let mut result = [0u8; RGBA_BYTES_PER_PIXEL];
    for channel in 0..3 {
        result[channel] =
            ((u32::from(colour[channel]) * cover + u32::from(baseline[channel]) * inverse + 127)
                / 255) as u8;
    }
    result[3] = 255;
    result
}

fn needs_space(
    prior_bounds: PixelBounds,
    prior: &font::OcrGlyphCandidate,
    next_bounds: PixelBounds,
    next: Option<&font::OcrGlyphCandidate>,
    space_advance: f32,
) -> bool {
    let Some(next) = next else {
        return false;
    };
    let prior_pen = prior_bounds.left as f32 - prior.left as f32;
    let next_pen = next_bounds.left as f32 - next.left as f32;
    next_pen - (prior_pen + prior.advance) >= space_advance * 0.5
}

struct DecodedPng {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

fn decode_deterministic_rgba_png(bytes: &[u8]) -> Result<DecodedPng, RasterOcrReadbackError> {
    if !bytes.starts_with(&PNG_FILE_MAGIC) {
        return invalid_png("missing PNG signature");
    }
    let mut offset = PNG_FILE_MAGIC.len();
    let mut width = None;
    let mut height = None;
    let mut idat = Vec::new();
    let mut saw_iend = false;
    while offset < bytes.len() {
        let length = read_u32(bytes, &mut offset)? as usize;
        let kind = read_exact(bytes, &mut offset, 4)?;
        let payload = read_exact(bytes, &mut offset, length)?;
        let crc = read_u32(bytes, &mut offset)?;
        let mut crc_input = Vec::with_capacity(4 + payload.len());
        crc_input.extend_from_slice(kind);
        crc_input.extend_from_slice(payload);
        if super::crc32_ieee(&crc_input) != crc {
            return invalid_png("chunk CRC mismatch");
        }
        match kind {
            b"IHDR" => {
                if payload.len() != 13 || width.is_some() {
                    return invalid_png("invalid IHDR");
                }
                let mut header = 0usize;
                let parsed_width = read_u32(payload, &mut header)?;
                let parsed_height = read_u32(payload, &mut header)?;
                if parsed_width == 0 || parsed_height == 0 {
                    return invalid_png("zero dimensions");
                }
                if payload[8] != PNG_BIT_DEPTH || payload[9] != PNG_COLOUR_TYPE_RGBA {
                    return invalid_png("unsupported colour format");
                }
                if payload[10..] != [0, 0, 0] {
                    return invalid_png("unsupported PNG transform");
                }
                width = Some(parsed_width);
                height = Some(parsed_height);
            }
            b"IDAT" => idat.extend_from_slice(payload),
            b"IEND" => {
                if !payload.is_empty() || saw_iend {
                    return invalid_png("invalid IEND");
                }
                saw_iend = true;
                if offset != bytes.len() {
                    return invalid_png("trailing bytes after IEND");
                }
            }
            _ => return invalid_png("unexpected PNG chunk"),
        }
    }
    let (Some(width), Some(height), true) = (width, height, saw_iend) else {
        return invalid_png("incomplete PNG");
    };
    let scanlines = decode_zlib_stored(&idat)?;
    let row_len = width as usize * RGBA_BYTES_PER_PIXEL;
    let expected_len = height as usize * (row_len + 1);
    if scanlines.len() != expected_len {
        return invalid_png("unexpected scanline length");
    }
    let mut pixels = Vec::with_capacity(width as usize * height as usize * RGBA_BYTES_PER_PIXEL);
    for row in scanlines.chunks_exact(row_len + 1) {
        if row[0] != 0 {
            return invalid_png("non-zero PNG filter");
        }
        pixels.extend_from_slice(&row[1..]);
    }
    Ok(DecodedPng {
        width,
        height,
        pixels,
    })
}

fn decode_zlib_stored(bytes: &[u8]) -> Result<Vec<u8>, RasterOcrReadbackError> {
    if bytes.len() < 6 || bytes[..2] != [0x78, 0x01] {
        return invalid_png("unsupported zlib stream");
    }
    let mut offset = 2usize;
    let mut decoded = Vec::new();
    let mut final_block = false;
    while !final_block {
        let header = *read_exact(bytes, &mut offset, 1)?.first().ok_or_else(|| {
            RasterOcrReadbackError::InvalidPng {
                reason: "missing deflate header".to_string(),
            }
        })?;
        if header & !1 != 0 {
            return invalid_png("compressed deflate block");
        }
        final_block = header == 1;
        let length = read_u16(bytes, &mut offset)?;
        let complement = read_u16(bytes, &mut offset)?;
        if complement != !length {
            return invalid_png("stored deflate length complement mismatch");
        }
        decoded.extend_from_slice(read_exact(bytes, &mut offset, usize::from(length))?);
    }
    let expected_adler = read_u32(bytes, &mut offset)?;
    if offset != bytes.len() || adler32(&decoded) != expected_adler {
        return invalid_png("zlib checksum mismatch");
    }
    Ok(decoded)
}

fn read_exact<'a>(
    bytes: &'a [u8],
    offset: &mut usize,
    length: usize,
) -> Result<&'a [u8], RasterOcrReadbackError> {
    let end = offset
        .checked_add(length)
        .ok_or_else(|| RasterOcrReadbackError::InvalidPng {
            reason: "PNG offset overflow".to_string(),
        })?;
    let result = bytes
        .get(*offset..end)
        .ok_or_else(|| RasterOcrReadbackError::InvalidPng {
            reason: "truncated PNG".to_string(),
        })?;
    *offset = end;
    Ok(result)
}

fn read_u16(bytes: &[u8], offset: &mut usize) -> Result<u16, RasterOcrReadbackError> {
    let raw = read_exact(bytes, offset, 2)?;
    Ok(u16::from_le_bytes([raw[0], raw[1]]))
}

fn read_u32(bytes: &[u8], offset: &mut usize) -> Result<u32, RasterOcrReadbackError> {
    let raw = read_exact(bytes, offset, 4)?;
    Ok(u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]))
}

fn invalid_png<T>(reason: &str) -> Result<T, RasterOcrReadbackError> {
    Err(RasterOcrReadbackError::InvalidPng {
        reason: reason.to_string(),
    })
}

#[cfg(test)]
#[path = "ocr_readback_tests.rs"]
mod tests;
