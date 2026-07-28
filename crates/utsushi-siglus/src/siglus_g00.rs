//! Siglus CG (`.g00`) container decode.
//!
//! The Siglus titles exercised by this port use the VisualArt's G00 family:
//! a five-byte image header, LZSS payload, and (for type 2) a layer table
//! whose decoded tiles are BGRA.  This module owns the container boundary;
//! [`crate::siglus_render`] owns policy-controlled raster output.

mod lzss;
mod type2;

use lzss::{LzssFlavor, decode_lzss};
use thiserror::Error;

const HEADER_LEN: usize = 5;
const LAYER_RECORD_LEN: usize = 24;
const TYPE2_BLOCK_HEADER_LEN: usize = 0x74;
const TYPE2_TILE_HEADER_LEN: usize = 0x5c;
const MAX_DECODED_BYTES: usize = 256 * 1024 * 1024;
const MAX_LAYER_COUNT: usize = 65_536;
/// The fixed, cyclic byte key used by the observed Siglus type-3 JPEGs.
///
/// This is not a per-title or per-file secret: XORing bytes after the common
/// five-byte G00 header with this table restores the JPEG SOI (`ff d8 ff`).
/// The table is deliberately kept at this container boundary, where its
/// position-zero semantics are unambiguous.
const TYPE3_XOR_KEY: [u8; 256] = [
    0x45, 0x0c, 0x85, 0xc0, 0x75, 0x14, 0xe5, 0x5d, 0x8b, 0x55, 0xec, 0xc0, 0x5b, 0x8b, 0xc3, 0x8b,
    0x81, 0xff, 0x00, 0x00, 0x04, 0x00, 0x85, 0xff, 0x6a, 0x00, 0x76, 0xb0, 0x43, 0x00, 0x76, 0x49,
    0x00, 0x8b, 0x7d, 0xe8, 0x8b, 0x75, 0xa1, 0xe0, 0x0c, 0x85, 0xc0, 0xc0, 0x75, 0x78, 0x30, 0x44,
    0x00, 0x85, 0xff, 0x76, 0x37, 0x81, 0x1d, 0xd0, 0xff, 0x00, 0x00, 0x75, 0x44, 0x8b, 0xb0, 0x43,
    0x45, 0xf8, 0x8d, 0x55, 0xfc, 0x52, 0x00, 0x76, 0x68, 0x00, 0x00, 0x04, 0x00, 0x6a, 0x43, 0x8b,
    0xb1, 0x43, 0x00, 0x6a, 0x05, 0xff, 0x50, 0xff, 0xd3, 0xa1, 0xe0, 0x04, 0x00, 0x56, 0x15, 0x2c,
    0x44, 0x00, 0x85, 0xc0, 0x74, 0x09, 0xc3, 0xa1, 0x5f, 0x5e, 0x33, 0x8b, 0xe5, 0x5d, 0xe0, 0x30,
    0x04, 0x00, 0x81, 0xc6, 0x00, 0x00, 0x81, 0xef, 0x04, 0x00, 0x85, 0x30, 0x44, 0x00, 0x00, 0x00,
    0x5d, 0xc3, 0x8b, 0x55, 0xf8, 0x8d, 0x5e, 0x5b, 0x4d, 0xfc, 0x51, 0xc4, 0x04, 0x5f, 0x8b, 0xe5,
    0x43, 0x00, 0xeb, 0xd8, 0x8b, 0x45, 0xff, 0x15, 0xe8, 0x83, 0xc0, 0x57, 0x56, 0x52, 0x2c, 0xb1,
    0x01, 0x00, 0x8b, 0x7d, 0xe8, 0x89, 0x00, 0xe8, 0x45, 0xf4, 0x8b, 0x20, 0x50, 0x6a, 0x47, 0x28,
    0x00, 0x50, 0x53, 0xff, 0x15, 0x34, 0xe4, 0x6a, 0xb1, 0x43, 0x00, 0x0c, 0x8b, 0x45, 0x00, 0x6a,
    0x8b, 0x4d, 0xec, 0x89, 0x08, 0x8a, 0x85, 0xc0, 0x45, 0xf0, 0x84, 0x8b, 0x45, 0x10, 0x74, 0x05,
    0xf5, 0x28, 0x01, 0x00, 0x83, 0xc4, 0x52, 0x6a, 0x08, 0x89, 0x45, 0x83, 0xc2, 0x20, 0x00, 0xe8,
    0xe8, 0xf4, 0xfb, 0xff, 0xff, 0x8b, 0x8b, 0x5d, 0x45, 0x0c, 0x83, 0xc0, 0x74, 0xc5, 0xf8, 0x53,
    0xc4, 0x08, 0x85, 0xc0, 0x75, 0x56, 0x30, 0x44, 0x8b, 0x1d, 0xd0, 0xf0, 0xa1, 0xe0, 0x00, 0x83,
];

/// A decoded Siglus G00 image format variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiglusG00Kind {
    /// Type 0: LZSS-compressed 24-bit BGR pixels.
    RawBgr,
    /// Type 2: LZSS-compressed table of layered BGRA tiles.
    LayeredBgra,
    /// Type 3: a fixed-key XOR-wrapped JPEG following the common G00 header.
    Jpeg,
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
    /// The JPEG payload in a type-3 container was malformed.
    #[error("utsushi.siglus.g00.jpeg: {detail}")]
    Jpeg { detail: String },
    /// Type-2 payload data did not describe a complete tile stream.
    #[error("utsushi.siglus.g00.invalid_layer_payload: {detail}")]
    InvalidLayerPayload { detail: &'static str },
}

/// Decode a supported Siglus `.g00` container into an RGBA canvas.
///
/// This is the production decoder called by [`crate::UtsushiSiglusPort`].
/// Type 3 is a fixed-key XOR-wrapped JPEG payload beginning immediately after
/// the common G00 header. Types 0 and 2 retain their existing real-byte decoder
/// paths.
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
        3 => decode_type3(input, width, height),
        lead => Err(SiglusG00Error::UnsupportedType { lead }),
    }
}

fn decode_type3(input: &[u8], width: u32, height: u32) -> Result<SiglusG00Image, SiglusG00Error> {
    let expected_rgba = checked_canvas_len(width, height, 4)?;
    let mut jpeg = input[HEADER_LEN..].to_vec();
    xor_type3_jpeg_in_place(&mut jpeg);
    let decoded = image::load_from_memory_with_format(&jpeg, image::ImageFormat::Jpeg)
        .or_else(|_| image::load_from_memory(&jpeg))
        .map_err(|error| SiglusG00Error::Jpeg {
            detail: error.to_string(),
        })?
        .to_rgba8();
    if decoded.dimensions() != (width, height) {
        return Err(SiglusG00Error::InvalidSection {
            detail: "type-3 JPEG dimensions do not match the G00 header",
        });
    }
    let pixels_rgba = decoded.into_raw();
    if pixels_rgba.len() != expected_rgba {
        return Err(SiglusG00Error::InvalidSection {
            detail: "type-3 JPEG pixel count does not match the G00 canvas",
        });
    }
    Ok(SiglusG00Image {
        kind: SiglusG00Kind::Jpeg,
        width,
        height,
        pixels_rgba,
        layers: Vec::new(),
    })
}

fn xor_type3_jpeg_in_place(bytes: &mut [u8]) {
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte ^= TYPE3_XOR_KEY[index % TYPE3_XOR_KEY.len()];
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

use self::type2::{decode_type2, lzss_error, lzss_section};

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

    #[test]
    fn type3_xor_wrapped_jpeg_decodes_to_an_opaque_rgba_canvas() {
        let mut jpeg = Vec::new();
        let source = image::RgbImage::from_raw(2, 1, vec![250, 20, 10, 20, 200, 30])
            .expect("test RGB dimensions");
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 100)
            .encode_image(&source)
            .expect("encode test JPEG");
        let mut bytes = vec![3, 2, 0, 1, 0];
        xor_type3_jpeg_in_place(&mut jpeg);
        bytes.extend_from_slice(&jpeg);

        let image = decode_siglus_g00(&bytes).expect("decode type-3 JPEG G00");

        assert_eq!(image.kind, SiglusG00Kind::Jpeg);
        assert_eq!((image.width, image.height), (2, 1));
        assert_eq!(image.pixels_rgba.len(), 8);
        assert!(
            image
                .pixels_rgba
                .chunks_exact(4)
                .all(|pixel| pixel[3] == 255)
        );
        assert!(
            image
                .pixels_rgba
                .chunks_exact(4)
                .any(|pixel| pixel[..3] != [0; 3])
        );
    }

    #[test]
    fn type3_jpeg_dimension_mismatch_is_rejected() {
        let mut jpeg = Vec::new();
        let source =
            image::RgbImage::from_raw(2, 1, vec![1, 2, 3, 4, 5, 6]).expect("test RGB dimensions");
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 100)
            .encode_image(&source)
            .expect("encode test JPEG");
        let mut bytes = vec![3, 1, 0, 1, 0];
        xor_type3_jpeg_in_place(&mut jpeg);
        bytes.extend_from_slice(&jpeg);

        assert!(matches!(
            decode_siglus_g00(&bytes),
            Err(SiglusG00Error::InvalidSection {
                detail: "type-3 JPEG dimensions do not match the G00 header"
            })
        ));
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
