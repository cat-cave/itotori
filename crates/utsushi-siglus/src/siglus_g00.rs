//! Siglus CG (`.g00`) container decode.
//!
//! The Siglus titles exercised by this port use the VisualArt's G00 family:
//! a five-byte image header, LZSS payload, and (for type 2) a layer table
//! whose decoded tiles are BGRA.  This module owns the container boundary;
//! [`crate::siglus_render`] owns policy-controlled raster output.

mod lzss;

use lzss::{LzssFlavor, decode_lzss};
use thiserror::Error;

const HEADER_LEN: usize = 5;
const LAYER_RECORD_LEN: usize = 24;
const TYPE2_BLOCK_HEADER_LEN: usize = 0x74;
const TYPE2_TILE_HEADER_LEN: usize = 0x5c;
const MAX_DECODED_BYTES: usize = 256 * 1024 * 1024;
const MAX_LAYER_COUNT: usize = 65_536;

/// A decoded Siglus G00 image format variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiglusG00Kind {
    /// Type 0: LZSS-compressed 24-bit BGR pixels.
    RawBgr,
    /// Type 2: LZSS-compressed table of layered BGRA tiles.
    LayeredBgra,
}

/// A layer rectangle preserved from a type-2 G00 header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SiglusG00Layer {
    /// Inclusive left pixel coordinate.
    pub x1: i32,
    /// Inclusive top pixel coordinate.
    pub y1: i32,
    /// Inclusive right pixel coordinate.
    pub x2: i32,
    /// Inclusive bottom pixel coordinate.
    pub y2: i32,
    /// Engine placement origin X, retained from the file header.
    pub origin_x: i32,
    /// Engine placement origin Y, retained from the file header.
    pub origin_y: i32,
}

impl SiglusG00Layer {
    fn width(self) -> i32 {
        self.x2.saturating_sub(self.x1).saturating_add(1)
    }

    fn height(self) -> i32 {
        self.y2.saturating_sub(self.y1).saturating_add(1)
    }
}

/// Fully reconstructed RGBA canvas produced by the real G00 decoder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiglusG00Image {
    /// Decoded container flavor.
    pub kind: SiglusG00Kind,
    /// Final canvas width in pixels.
    pub width: u32,
    /// Final canvas height in pixels. Identical type-2 layer records form
    /// vertically stacked bands, as required by the on-disk convention.
    pub height: u32,
    /// RGBA8 pixels in row-major order.
    pub pixels_rgba: Vec<u8>,
    /// Type-2 layer records; empty for type 0.
    pub layers: Vec<SiglusG00Layer>,
}

/// Typed G00 decode failures. No failure returns placeholder pixels.
#[derive(Debug, Error)]
pub enum SiglusG00Error {
    /// The common G00 preamble was incomplete.
    #[error("utsushi.siglus.g00.truncated_header: required={required} observed={observed}")]
    TruncatedHeader { required: usize, observed: usize },
    /// This port's audited profile does not cover the discriminator.
    #[error("utsushi.siglus.g00.unsupported_type: lead=0x{lead:02x}")]
    UnsupportedType { lead: u8 },
    /// A declared length is inconsistent with the surrounding container.
    #[error("utsushi.siglus.g00.invalid_section: {detail}")]
    InvalidSection { detail: &'static str },
    /// A declared decoded size exceeds the bounded decoder budget.
    #[error("utsushi.siglus.g00.decoded_size_exceeds_limit: declared={declared}")]
    DecodedSizeExceedsLimit { declared: usize },
    /// The LZSS stream was malformed or incomplete.
    #[error("utsushi.siglus.g00.lzss: {detail}")]
    Lzss { detail: &'static str },
    /// Type-2 payload data did not describe a complete tile stream.
    #[error("utsushi.siglus.g00.invalid_layer_payload: {detail}")]
    InvalidLayerPayload { detail: &'static str },
}

/// Decode a supported Siglus `.g00` container into an RGBA canvas.
///
/// This is the production decoder called by [`crate::UtsushiSiglusPort`].
/// It deliberately rejects the observed type-3 extension rather than
/// guessing a layout for it; types 0 and 2 are independently validated on
/// the two real Siglus corpora.
pub fn decode_siglus_g00(input: &[u8]) -> Result<SiglusG00Image, SiglusG00Error> {
    if input.len() < HEADER_LEN {
        return Err(SiglusG00Error::TruncatedHeader {
            required: HEADER_LEN,
            observed: input.len(),
        });
    }
    let width = read_u16(input, 1)? as u32;
    let height = read_u16(input, 3)? as u32;
    match input[0] {
        0 => decode_type0(input, width, height),
        2 => decode_type2(input, width, height),
        lead => Err(SiglusG00Error::UnsupportedType { lead }),
    }
}

fn decode_type0(input: &[u8], width: u32, height: u32) -> Result<SiglusG00Image, SiglusG00Error> {
    let pixel_count = checked_canvas_len(width, height, 3)?;
    let expected_rgba = checked_canvas_len(width, height, 4)?;
    if read_u32(input, HEADER_LEN + 4)? as usize != expected_rgba {
        return Err(SiglusG00Error::InvalidSection {
            detail: "type-0 decoded size does not match the RGBA canvas",
        });
    }
    let payload = lzss_section(input, HEADER_LEN)?;
    let bgr = decode_lzss(payload, pixel_count, LzssFlavor::BgrPixels).map_err(lzss_error)?;
    let mut pixels_rgba = Vec::with_capacity(expected_rgba);
    for pixel in bgr.chunks_exact(3) {
        pixels_rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], u8::MAX]);
    }
    Ok(SiglusG00Image {
        kind: SiglusG00Kind::RawBgr,
        width,
        height,
        pixels_rgba,
        layers: Vec::new(),
    })
}

fn decode_type2(input: &[u8], width: u32, height: u32) -> Result<SiglusG00Image, SiglusG00Error> {
    let layer_count = read_u32(input, HEADER_LEN)? as usize;
    if layer_count == 0 {
        return Err(SiglusG00Error::InvalidSection {
            detail: "type-2 layer count is zero",
        });
    }
    if layer_count > MAX_LAYER_COUNT {
        return Err(SiglusG00Error::InvalidSection {
            detail: "type-2 layer count exceeds decoder limit",
        });
    }
    let records_end = HEADER_LEN
        .checked_add(4)
        .and_then(|offset| offset.checked_add(layer_count.checked_mul(LAYER_RECORD_LEN)?))
        .ok_or(SiglusG00Error::InvalidSection {
            detail: "type-2 layer table overflows",
        })?;
    if input.len() < records_end {
        return Err(SiglusG00Error::TruncatedHeader {
            required: records_end,
            observed: input.len(),
        });
    }
    let mut layers = (0..layer_count)
        .map(|index| read_layer(input, HEADER_LEN + 4 + index * LAYER_RECORD_LEN))
        .collect::<Result<Vec<_>, _>>()?;
    let mut canvas_height = height as usize;
    stack_identical_layers(&mut layers, height, &mut canvas_height);
    let decoded = decode_lzss_section(input, records_end, LzssFlavor::Bytes)?;
    let canvas_height =
        u32::try_from(canvas_height).map_err(|_| SiglusG00Error::DecodedSizeExceedsLimit {
            declared: usize::MAX,
        })?;
    let canvas_bytes = checked_canvas_len(width, canvas_height, 4)?;
    let mut pixels_rgba = vec![0; canvas_bytes];
    let listed_layers = read_u32(&decoded, 0)? as usize;
    let table_end =
        4usize
            .checked_add(listed_layers.checked_mul(8).ok_or(
                SiglusG00Error::InvalidLayerPayload {
                    detail: "layer offset table overflows",
                },
            )?)
            .ok_or(SiglusG00Error::InvalidLayerPayload {
                detail: "layer offset table overflows",
            })?;
    if table_end > decoded.len() {
        return Err(SiglusG00Error::InvalidLayerPayload {
            detail: "layer offset table is truncated",
        });
    }
    for (index, layer) in layers.iter().enumerate().take(listed_layers) {
        let entry = 4 + index * 8;
        let start = read_u32(&decoded, entry)? as usize;
        let length = read_u32(&decoded, entry + 4)? as usize;
        blit_layer(
            &decoded,
            start,
            length,
            *layer,
            width as usize,
            canvas_height as usize,
            &mut pixels_rgba,
        )?;
    }
    Ok(SiglusG00Image {
        kind: SiglusG00Kind::LayeredBgra,
        width,
        height: canvas_height,
        pixels_rgba,
        layers,
    })
}

fn read_layer(input: &[u8], offset: usize) -> Result<SiglusG00Layer, SiglusG00Error> {
    Ok(SiglusG00Layer {
        x1: read_i32(input, offset)?,
        y1: read_i32(input, offset + 4)?,
        x2: read_i32(input, offset + 8)?,
        y2: read_i32(input, offset + 12)?,
        origin_x: read_i32(input, offset + 16)?,
        origin_y: read_i32(input, offset + 20)?,
    })
}

fn stack_identical_layers(layers: &mut [SiglusG00Layer], height: u32, canvas_height: &mut usize) {
    let Some(first) = layers.first().copied() else {
        return;
    };
    let identical = layers.len() > 1
        && first.width() > 0
        && first.height() > 0
        && layers.iter().all(|layer| {
            layer.x1 == first.x1
                && layer.y1 == first.y1
                && layer.x2 == first.x2
                && layer.y2 == first.y2
                && layer.origin_x == first.origin_x
        });
    if identical {
        for (index, layer) in layers.iter_mut().enumerate() {
            let y_offset = (index as i32).saturating_mul(height as i32);
            layer.y1 = layer.y1.saturating_add(y_offset);
            layer.y2 = layer.y2.saturating_add(y_offset);
        }
        *canvas_height = (height as usize).saturating_mul(layers.len());
    }
}

fn lzss_section(input: &[u8], offset: usize) -> Result<&[u8], SiglusG00Error> {
    let compressed_size = read_u32(input, offset)? as usize;
    if compressed_size < 8 {
        return Err(SiglusG00Error::InvalidSection {
            detail: "compressed section is shorter than its header",
        });
    }
    let end = offset
        .checked_add(compressed_size)
        .ok_or(SiglusG00Error::InvalidSection {
            detail: "compressed section overflows",
        })?;
    if end > input.len() {
        return Err(SiglusG00Error::TruncatedHeader {
            required: end,
            observed: input.len(),
        });
    }
    Ok(&input[offset + 8..end])
}

fn decode_lzss_section(
    input: &[u8],
    offset: usize,
    flavor: LzssFlavor,
) -> Result<Vec<u8>, SiglusG00Error> {
    let declared = read_u32(input, offset + 4)? as usize;
    if declared > MAX_DECODED_BYTES {
        return Err(SiglusG00Error::DecodedSizeExceedsLimit { declared });
    }
    decode_lzss(lzss_section(input, offset)?, declared, flavor).map_err(lzss_error)
}

fn lzss_error(error: lzss::LzssError) -> SiglusG00Error {
    let detail = match error {
        lzss::LzssError::Truncated => "stream ended before the declared output was complete",
        lzss::LzssError::InvalidBackReference => {
            "back-reference distance is outside decoded output"
        }
    };
    SiglusG00Error::Lzss { detail }
}

fn blit_layer(
    data: &[u8],
    start: usize,
    length: usize,
    layer: SiglusG00Layer,
    canvas_width: usize,
    canvas_height: usize,
    target: &mut [u8],
) -> Result<(), SiglusG00Error> {
    let end = start
        .checked_add(length)
        .ok_or(SiglusG00Error::InvalidLayerPayload {
            detail: "layer range overflows",
        })?;
    if end > data.len()
        || start
            .checked_add(TYPE2_BLOCK_HEADER_LEN)
            .is_none_or(|value| value > end)
    {
        return Err(SiglusG00Error::InvalidLayerPayload {
            detail: "layer block is truncated",
        });
    }
    let mut source = start + TYPE2_BLOCK_HEADER_LEN;
    while source < end {
        let header_end = source.checked_add(TYPE2_TILE_HEADER_LEN).ok_or(
            SiglusG00Error::InvalidLayerPayload {
                detail: "tile header overflows",
            },
        )?;
        if header_end > end {
            return Err(SiglusG00Error::InvalidLayerPayload {
                detail: "tile header is truncated",
            });
        }
        let x = read_u16(data, source)? as i32 + layer.x1;
        let y = read_u16(data, source + 2)? as i32 + layer.y1;
        let width = read_u16(data, source + 6)? as usize;
        let height = read_u16(data, source + 8)? as usize;
        let bytes = width
            .checked_mul(height)
            .and_then(|count| count.checked_mul(4))
            .ok_or(SiglusG00Error::InvalidLayerPayload {
                detail: "tile pixel size overflows",
            })?;
        let pixels_end =
            header_end
                .checked_add(bytes)
                .ok_or(SiglusG00Error::InvalidLayerPayload {
                    detail: "tile pixel range overflows",
                })?;
        if pixels_end > end {
            return Err(SiglusG00Error::InvalidLayerPayload {
                detail: "tile pixels are truncated",
            });
        }
        for row in 0..height {
            for column in 0..width {
                let destination_x = x.saturating_add(column as i32);
                let destination_y = y.saturating_add(row as i32);
                if destination_x < 0
                    || destination_y < 0
                    || destination_x as usize >= canvas_width
                    || destination_y as usize >= canvas_height
                {
                    continue;
                }
                let source_offset = header_end + (row * width + column) * 4;
                let destination_offset =
                    ((destination_y as usize * canvas_width) + destination_x as usize) * 4;
                source_over_bgra(
                    &data[source_offset..source_offset + 4],
                    &mut target[destination_offset..destination_offset + 4],
                );
            }
        }
        source = pixels_end;
    }
    Ok(())
}

fn source_over_bgra(source: &[u8], destination: &mut [u8]) {
    let alpha = source[3] as u32;
    if alpha == 0 {
        return;
    }
    if alpha == 255 {
        destination.copy_from_slice(&[source[2], source[1], source[0], 255]);
        return;
    }
    let destination_alpha = destination[3] as u32;
    let output_alpha = alpha + (destination_alpha * (255 - alpha) + 127) / 255;
    for (out, src) in destination[..3]
        .iter_mut()
        .zip([source[2], source[1], source[0]])
    {
        let numerator = src as u32 * alpha * 255 + *out as u32 * destination_alpha * (255 - alpha);
        *out = (numerator / (output_alpha * 255)).min(255) as u8;
    }
    destination[3] = output_alpha as u8;
}

fn checked_canvas_len(
    width: u32,
    height: u32,
    bytes_per_pixel: usize,
) -> Result<usize, SiglusG00Error> {
    let length = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(bytes_per_pixel))
        .ok_or(SiglusG00Error::DecodedSizeExceedsLimit {
            declared: usize::MAX,
        })?;
    if length > MAX_DECODED_BYTES {
        return Err(SiglusG00Error::DecodedSizeExceedsLimit { declared: length });
    }
    Ok(length)
}

fn read_u16(input: &[u8], offset: usize) -> Result<u16, SiglusG00Error> {
    input
        .get(offset..offset + 2)
        .and_then(|bytes| bytes.try_into().ok())
        .map(u16::from_le_bytes)
        .ok_or(SiglusG00Error::TruncatedHeader {
            required: offset + 2,
            observed: input.len(),
        })
}

fn read_u32(input: &[u8], offset: usize) -> Result<u32, SiglusG00Error> {
    input
        .get(offset..offset + 4)
        .and_then(|bytes| bytes.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or(SiglusG00Error::TruncatedHeader {
            required: offset + 4,
            observed: input.len(),
        })
}

fn read_i32(input: &[u8], offset: usize) -> Result<i32, SiglusG00Error> {
    input
        .get(offset..offset + 4)
        .and_then(|bytes| bytes.try_into().ok())
        .map(i32::from_le_bytes)
        .ok_or(SiglusG00Error::TruncatedHeader {
            required: offset + 4,
            observed: input.len(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn type0_bgr_lzss_decodes_to_rgba() {
        let mut bytes = vec![0, 1, 0, 1, 0];
        bytes.extend_from_slice(&12u32.to_le_bytes());
        bytes.extend_from_slice(&4u32.to_le_bytes());
        bytes.extend_from_slice(&[1, 3, 2, 1]);
        let image = decode_siglus_g00(&bytes).unwrap();
        assert_eq!(image.kind, SiglusG00Kind::RawBgr);
        assert_eq!(image.pixels_rgba, vec![1, 2, 3, 255]);
    }

    #[test]
    fn type2_layer_table_and_bgra_tile_reconstruct_a_canvas() {
        let mut unpacked = Vec::new();
        unpacked.extend_from_slice(&1u32.to_le_bytes());
        unpacked.extend_from_slice(&12u32.to_le_bytes());
        let block_len = TYPE2_BLOCK_HEADER_LEN + TYPE2_TILE_HEADER_LEN + 4;
        unpacked.extend_from_slice(&(block_len as u32).to_le_bytes());
        unpacked.extend_from_slice(&[0; TYPE2_BLOCK_HEADER_LEN]);
        let mut tile = [0u8; TYPE2_TILE_HEADER_LEN];
        tile[6..8].copy_from_slice(&1u16.to_le_bytes());
        tile[8..10].copy_from_slice(&1u16.to_le_bytes());
        unpacked.extend_from_slice(&tile);
        unpacked.extend_from_slice(&[3, 2, 1, 255]);
        let packed = all_literal_bytes(&unpacked);
        let mut bytes = vec![2, 1, 0, 1, 0];
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&[0; LAYER_RECORD_LEN]);
        bytes.extend_from_slice(&((8 + packed.len()) as u32).to_le_bytes());
        bytes.extend_from_slice(&(unpacked.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&packed);
        let image = decode_siglus_g00(&bytes).unwrap();
        assert_eq!(image.kind, SiglusG00Kind::LayeredBgra);
        assert_eq!(image.layers.len(), 1);
        assert_eq!(image.pixels_rgba, vec![1, 2, 3, 255]);
    }

    fn all_literal_bytes(input: &[u8]) -> Vec<u8> {
        let mut output = Vec::new();
        for chunk in input.chunks(8) {
            output.push(if chunk.len() == 8 {
                0xff
            } else {
                (1 << chunk.len()) - 1
            });
            output.extend_from_slice(chunk);
        }
        output
    }
}
