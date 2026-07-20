//! Faithful G00 raster output and copyright-safe PNG emission.
//!
//! The full renderer composites the decoded RGBA canvas into an Utsushi
//! raster surface.  The default export is an edge-only derivative: layout
//! remains inspectable while colour, texture, and the source pixels never
//! leave the process in a default capture artifact.

use crate::siglus_g00::SiglusG00Image;
use thiserror::Error;

/// Public artifact policy for a rendered Siglus CG.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SiglusCgRedaction {
    /// Emit only the alpha-mask edge map. This is the safe default.
    #[default]
    EdgeOutline,
    /// Keep the fully faithful RGBA render in memory for a locally authorized
    /// caller. The production port does not persist this mode by default.
    Full,
}

/// Rasterized RGBA frame ready for deterministic PNG encoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiglusCgFrame {
    /// Frame width in pixels.
    pub width: u32,
    /// Frame height in pixels.
    pub height: u32,
    /// Row-major RGBA8 pixels.
    pub pixels_rgba: Vec<u8>,
}

/// Render or PNG-encode failure.
#[derive(Debug, Error)]
pub enum SiglusRenderError {
    /// The decoded canvas dimensions and buffer length disagreed.
    #[error("utsushi.siglus.render.invalid_canvas")]
    InvalidCanvas,
    /// PNG's 32-bit dimension field cannot carry the requested size.
    #[error("utsushi.siglus.render.png_dimension_overflow")]
    PngDimensionOverflow,
}

/// Rasterize a decoded G00 image through the Utsushi Siglus compositor.
pub fn render_siglus_cg(
    image: &SiglusG00Image,
    policy: SiglusCgRedaction,
) -> Result<SiglusCgFrame, SiglusRenderError> {
    let expected = (image.width as usize)
        .checked_mul(image.height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or(SiglusRenderError::InvalidCanvas)?;
    if expected != image.pixels_rgba.len() {
        return Err(SiglusRenderError::InvalidCanvas);
    }
    let mut surface = vec![0; expected];
    composite_source_over(&image.pixels_rgba, &mut surface);
    if policy == SiglusCgRedaction::EdgeOutline {
        surface = redact_edge_outline(&surface, image.width as usize, image.height as usize);
    }
    Ok(SiglusCgFrame {
        width: image.width,
        height: image.height,
        pixels_rgba: surface,
    })
}

/// Encode a rasterized frame as a deterministic RGBA PNG.
pub fn encode_siglus_png(frame: &SiglusCgFrame) -> Result<Vec<u8>, SiglusRenderError> {
    let width =
        usize::try_from(frame.width).map_err(|_| SiglusRenderError::PngDimensionOverflow)?;
    let height =
        usize::try_from(frame.height).map_err(|_| SiglusRenderError::PngDimensionOverflow)?;
    let row_len = width
        .checked_mul(4)
        .ok_or(SiglusRenderError::InvalidCanvas)?;
    if row_len.checked_mul(height) != Some(frame.pixels_rgba.len()) {
        return Err(SiglusRenderError::InvalidCanvas);
    }
    let mut scanlines = Vec::with_capacity(frame.pixels_rgba.len() + height);
    for row in frame.pixels_rgba.chunks_exact(row_len) {
        scanlines.push(0);
        scanlines.extend_from_slice(row);
    }
    let mut png = Vec::with_capacity(scanlines.len() + 128);
    png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&frame.width.to_be_bytes());
    ihdr.extend_from_slice(&frame.height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    push_chunk(&mut png, *b"IHDR", &ihdr);
    push_chunk(&mut png, *b"IDAT", &zlib_stored(&scanlines));
    push_chunk(&mut png, *b"IEND", &[]);
    Ok(png)
}

fn composite_source_over(source: &[u8], destination: &mut [u8]) {
    for (source, destination) in source.chunks_exact(4).zip(destination.chunks_exact_mut(4)) {
        let alpha = source[3] as u32;
        if alpha == 0 {
            continue;
        }
        let destination_alpha = destination[3] as u32;
        let output_alpha = alpha + (destination_alpha * (255 - alpha) + 127) / 255;
        if output_alpha == 0 {
            continue;
        }
        for channel in 0..3 {
            let numerator = source[channel] as u32 * alpha * 255
                + destination[channel] as u32 * destination_alpha * (255 - alpha);
            destination[channel] = (numerator / (output_alpha * 255)).min(255) as u8;
        }
        destination[3] = output_alpha as u8;
    }
}

fn redact_edge_outline(source: &[u8], width: usize, height: usize) -> Vec<u8> {
    let mut redacted = vec![0; source.len()];
    for y in 0..height {
        for x in 0..width {
            let index = (y * width + x) * 4;
            if source[index + 3] == 0 || !is_alpha_edge(source, width, height, x, y) {
                continue;
            }
            redacted[index..index + 4].copy_from_slice(&[224, 224, 224, 255]);
        }
    }
    redacted
}

fn is_alpha_edge(source: &[u8], width: usize, height: usize, x: usize, y: usize) -> bool {
    [
        (x.checked_sub(1), Some(y)),
        (x.checked_add(1), Some(y)),
        (Some(x), y.checked_sub(1)),
        (Some(x), y.checked_add(1)),
    ]
    .iter()
    .any(|(neighbor_x, neighbor_y)| match (neighbor_x, neighbor_y) {
        (Some(nx), Some(ny)) if *nx < width && *ny < height => {
            source[(*ny * width + *nx) * 4 + 3] == 0
        }
        _ => true,
    })
}

fn zlib_stored(input: &[u8]) -> Vec<u8> {
    let mut output = vec![0x78, 0x01];
    for (index, chunk) in input.chunks(65_535).enumerate() {
        output.push(u8::from((index + 1) * 65_535 >= input.len()));
        let length = chunk.len() as u16;
        output.extend_from_slice(&length.to_le_bytes());
        output.extend_from_slice(&(!length).to_le_bytes());
        output.extend_from_slice(chunk);
    }
    output.extend_from_slice(&adler32(input).to_be_bytes());
    output
}

fn push_chunk(output: &mut Vec<u8>, kind: [u8; 4], data: &[u8]) {
    output.extend_from_slice(&(data.len() as u32).to_be_bytes());
    output.extend_from_slice(&kind);
    output.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(kind.len() + data.len());
    crc_input.extend_from_slice(&kind);
    crc_input.extend_from_slice(data);
    output.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

fn adler32(input: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for byte in input {
        a = (a + *byte as u32) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}

fn crc32(input: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in input {
        crc ^= *byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::siglus_g00::{SiglusG00Image, SiglusG00Kind};

    #[test]
    fn default_render_discards_source_colours_but_retains_canvas_edge() {
        let image = SiglusG00Image {
            kind: SiglusG00Kind::RawBgr,
            width: 2,
            height: 1,
            pixels_rgba: vec![1, 2, 3, 255, 10, 20, 30, 255],
            layers: Vec::new(),
        };
        let redacted = render_siglus_cg(&image, SiglusCgRedaction::default()).unwrap();
        assert_eq!(
            redacted.pixels_rgba,
            vec![224, 224, 224, 255, 224, 224, 224, 255]
        );
        assert_ne!(redacted.pixels_rgba, image.pixels_rgba);
    }

    #[test]
    fn png_output_is_deterministic_and_has_png_magic() {
        let frame = SiglusCgFrame {
            width: 1,
            height: 1,
            pixels_rgba: vec![0, 0, 0, 0],
        };
        assert_eq!(
            encode_siglus_png(&frame).unwrap(),
            encode_siglus_png(&frame).unwrap()
        );
        assert_eq!(
            &encode_siglus_png(&frame).unwrap()[..8],
            b"\x89PNG\r\n\x1a\n"
        );
    }
}
