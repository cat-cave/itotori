use serde::{Deserialize, Serialize};

/// Type discriminator for raw 24-bpp BGRA (LZSS-compressed) images.
/// Lead byte is `0x00`.
pub const G00_TYPE_RAW_BGR: u8 = 0;
/// Type discriminator for 8-bpp paletted images with LZSS compression.
/// Lead byte is `0x01`.
pub const G00_TYPE_PALETTED_LZSS: u8 = 1;
/// Type discriminator for 24-bpp images with a region table and LZSS
/// compression. Lead byte is `0x02`.
pub const G00_TYPE_REGIONED_LZSS: u8 = 2;

/// Number of bytes consumed by the shared `(type, width, height)`
/// preamble. Every g00 type shares this 5-byte prefix.
pub const G00_HEADER_PREAMBLE_BYTE_LEN: usize = 5;

/// Number of bytes a single type-2 [`G00Region`] record occupies on
/// disk: six little-endian `i32` fields.
pub const G00_REGION_RECORD_BYTE_LEN: usize = 24;

/// Bytes per pixel in the type-0 LZSS output canvas (24-bpp BGR, one
/// literal token = one pixel). The decoded BGR canvas is
/// `width * height * G00_TYPE0_BGR_BYTES_PER_PIXEL` bytes, expanded to
/// 32-bpp RGBA at the decoder boundary.
pub const G00_TYPE0_BGR_BYTES_PER_PIXEL: usize = 3;

/// Strongly-typed enumeration of the three documented g00 sub-formats.
///
/// The discriminator is the value of byte 0 of the file. Any other
/// value is rejected by [`decode_g00`] as
/// [`G00DecodeError::UnknownType`] — there is no silent fallback to
/// "treat unknown as raw".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum G00Type {
    /// Type 0: 24-bpp BGRA pixel stream (LZSS-compressed). No region
    /// table.
    RawBgr,
    /// Type 1: 8-bpp paletted with LZSS compression. Decoded payload
    /// is 1024 bytes of palette (256 × BGRA entries) followed by
    /// `width * height` palette indices.
    PalettedLzss,
    /// Type 2: 24-bpp BGRA pixel stream with a region table and LZSS
    /// compression. Carries a `Vec<G00Region>` describing the
    /// sub-bitmaps inside the canvas.
    RegionedLzss,
}

impl G00Type {
    /// The on-disk byte value for this sub-format.
    pub const fn lead_byte(self) -> u8 {
        match self {
            G00Type::RawBgr => G00_TYPE_RAW_BGR,
            G00Type::PalettedLzss => G00_TYPE_PALETTED_LZSS,
            G00Type::RegionedLzss => G00_TYPE_REGIONED_LZSS,
        }
    }

    /// Recover the typed sub-format from a lead byte. Returns `None`
    /// for any value not in `{0, 1, 2}` so the caller can surface the
    /// out-of-profile byte through a typed error rather than a panic.
    pub const fn from_lead_byte(byte: u8) -> Option<Self> {
        match byte {
            G00_TYPE_RAW_BGR => Some(G00Type::RawBgr),
            G00_TYPE_PALETTED_LZSS => Some(G00Type::PalettedLzss),
            G00_TYPE_REGIONED_LZSS => Some(G00Type::RegionedLzss),
            _ => None,
        }
    }
}

/// Inclusive-bound axis-aligned rectangle, in pixel coordinates.
///
/// Matches the on-disk type-2 region record (`x1, y1, x2, y2`). The
/// rectangle's pixel width is `x2 - x1 + 1` and its pixel height is
/// `y2 - y1 + 1`. Negative coordinates are preserved verbatim so a
/// malformed record surfaces through downstream consumers rather than
/// being silently clamped here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct G00Rect {
    /// Inclusive-left X coordinate.
    pub x1: i32,
    /// Inclusive-top Y coordinate.
    pub y1: i32,
    /// Inclusive-right X coordinate.
    pub x2: i32,
    /// Inclusive-bottom Y coordinate.
    pub y2: i32,
}

impl G00Rect {
    /// Pixel width of this rectangle: `x2 - x1 + 1`. Returns `0` when
    /// the rectangle is inverted (`x2 < x1`) so a malformed record does
    /// not produce a negative dimension. Audit tooling looking for
    /// inverted rectangles should check the raw fields directly.
    pub fn width(&self) -> u32 {
        if self.x2 < self.x1 {
            0
        } else {
            (self.x2 - self.x1 + 1) as u32
        }
    }

    /// Pixel height of this rectangle: `y2 - y1 + 1`. Same inverted
    /// guard as [`Self::width`].
    pub fn height(&self) -> u32 {
        if self.y2 < self.y1 {
            0
        } else {
            (self.y2 - self.y1 + 1) as u32
        }
    }
}

/// One region of a type-2 g00 image.
///
/// Type 2 g00 files carry a region list immediately after the header.
/// Each region describes a sub-bitmap inside the file's canvas plus an
/// origin offset (`origin_x`, `origin_y`) used by the `objLoadRegion`
/// opcode in to anchor the sub-bitmap inside the parent
/// surface. The `name` field is `None` here: the on-disk region record
/// does **not** store a string; cross-referenced names land through
/// `Gameexe.ini` lookups handled at the opcode layer. The slot is
/// preserved on this struct so the caller does not have to wrap it in a
/// pair-type when it threads the region list through the opcode chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct G00Region {
    /// The rectangle this region covers inside the file's canvas.
    pub rect: G00Rect,
    /// Origin offset the region is anchored at when blitted onto a
    /// parent surface. Preserved as raw `i32` LE fields from the
    /// region record.
    pub origin_x: i32,
    /// Origin Y. See [`Self::origin_x`].
    pub origin_y: i32,
    /// Optional region name. Always `None` from the on-disk record;
    /// populated by the `objLoadRegion` cross-reference at the opcode
    /// layer ().
    pub name: Option<String>,
}

/// Successfully-decoded g00 image.
///
/// Carries the decoded RGBA pixel buffer (BGR reordered to RGBA at the
/// decoder boundary so downstream consumers can ignore the on-disk
/// byte order) plus the type-2 region table (empty for types 0 and 1).
/// A `Vec<G00Warning>` accompanies every successful decode through the
/// outer [`decode_g00`] return tuple — warnings are never silent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct G00Image {
    /// The decoded sub-format. Mirrors the lead byte for ergonomics
    /// (the lead byte is also reachable via [`G00Type::lead_byte`]).
    pub g00_type: G00Type,
    /// Width in pixels, from the `u16 LE` header field at offset 1.
    pub width: u32,
    /// Height in pixels, from the `u16 LE` header field at offset 3.
    pub height: u32,
    /// Decoded pixel buffer in RGBA8 byte order. For type 0 and type 1
    /// the length is exactly `width * height * 4` (one RGBA tuple per
    /// canvas pixel); for type 2 see the canvas-height caveat below.
    /// Types 0 and 1 zero-pad or truncate the LZSS-decoded payload to the
    /// declared canvas size at the decode boundary (a short LZSS payload
    /// is zero-padded to the canvas size *and* surfaces a typed
    /// [`G00Warning::PayloadLengthMismatch`], so the size is never a
    /// silent mismatch). Type-2 — see also
    /// [`G00Image::pixels_rgba_byte_len_full_canvas`] and
    /// [`G00Image::pixels_rgba_byte_len_type2_atlas`]: the buffer's
    /// length is `width * struct.height * 4`, where `struct.height` is
    /// the *expanded* canvas height the decoder wrote onto `self.height`
    /// (the on-disk `height` field, multiplied by `regions.len()` when
    /// every region is the same non-degenerate rectangle — the
    /// "overlaid image" stacking the reference decoder applies before
    /// reconstruction). Downstream consumers MUST read the canvas
    /// height off `self` rather than off the on-disk header; the
    /// on-disk `width × height` is the per-band size, not the final
    /// surface size, for stacked type-2 files.
    pub pixels_rgba: Vec<u8>,
    /// Region table from the on-disk type-2 record. Empty for types 0
    /// and 1.
    pub regions: Vec<G00Region>,
}

impl G00Image {
    /// Expected pixel-buffer byte length for the *final* decoded canvas:
    /// `width * height * 4`. This is the length `pixels_rgba` is sized
    /// to for type 0 and type 1, and for type 2 *as long as you read
    /// `height` off this struct* — `self.height` is the canvas height
    /// the decoder wrote out, which for type-2 stacked regions is the
    /// on-disk `height` * `regions.len()` (NOT the on-disk `height`
    /// the input bytes carried). For the per-band layout (sum of the
    /// original on-disk region rectangles), use
    /// [`Self::pixels_rgba_byte_len_type2_atlas`] instead.
    pub fn pixels_rgba_byte_len_full_canvas(&self) -> usize {
        (self.width as usize)
            .saturating_mul(self.height as usize)
            .saturating_mul(4)
    }

    /// Expected pixel-buffer byte length for a type-2 atlas by the
    /// per-band sum: `sum(region.width * region.height) * 4`. This
    /// matches the on-disk region rectangles *before* the
    /// "overlaid image" stack-multiplies the canvas height. Returns 0
    /// when the image has no regions (which is the well-formed case
    /// only for types 0/1; a type-2 image with zero regions is a
    /// malformed header surfaced by [`decode_g00`]).
    pub fn pixels_rgba_byte_len_type2_atlas(&self) -> usize {
        self.regions
            .iter()
            .map(|region| {
                (region.rect.width() as usize)
                    .saturating_mul(region.rect.height() as usize)
                    .saturating_mul(4)
            })
            .sum()
    }
}
