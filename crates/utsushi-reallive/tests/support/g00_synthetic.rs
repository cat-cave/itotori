//! FIX-3 — structurally-faithful **synthetic** g00 image fixtures.
//!
//! This module authors two non-copyrighted g00 blobs from the public
//! RealLive g00 format (see `src/g00.rs` module docstring and
//! `docs/research/g00-type0-decoder-findings.md`): one **type-0** (raw
//! 24-bpp BGR + relative-LZ77) and one **type-2** (region-container +
//! SCN2k LZSS). The byte layout mirrors the real on-disk shape — lead
//! byte, `u16 LE` width/height, the type-2 `u32 LE region_count`, the
//! 24-byte-per-record region table, the `(u32 compressed_size,
//! u32 uncompressed_size, lzss_payload)` framing, and (for type 2) the
//! region-container the SCN2k payload decodes to.
//!
//! # Clean-room provenance
//!
//! NO verbatim retail pixel data is copied. Every pixel byte here is
//! authored from a tiny deterministic gradient. The canvas dimensions
//! are deliberately *unlike* the retail files (retail `BACK.g00` is
//! 1280x720, `btn000.g00` is 360x54) so the fixtures can never be
//! mistaken for a retail extract.
//!
//! # Compression framing is genuine, not all-literal
//!
//! The type-0 fixture encodes a real relative-LZ77 **back-reference**
//! token (the canvas's last pixel is a back-reference to its first), so
//! the fixture exercises the back-reference decode path — the same
//! framing the retail corpus uses — rather than a degenerate
//! literal-only stream.

// reason: shared synthetic-g00 test-support builders; not every consumer test uses every helper.
#![allow(dead_code)]

use std::fs;
use std::path::Path;

use utsushi_reallive::{G00_TYPE_RAW_BGR, G00_TYPE_REGIONED_LZSS};

/// File stem used when [`write_synthetic_g00_dir`] stages the type-0
/// fixture (`<stem>.g00`).
pub const SYNTHETIC_TYPE0_STEM: &str = "SYNTH_BG";

/// File stem used when [`write_synthetic_g00_dir`] stages the type-2
/// fixture (`<stem>.g00`).
pub const SYNTHETIC_TYPE2_STEM: &str = "SYNTH_BTN";

/// Type-0 synthetic canvas width (px). Unlike retail `BACK.g00` (1280).
pub const SYNTHETIC_TYPE0_WIDTH: u16 = 4;
/// Type-0 synthetic canvas height (px). Unlike retail `BACK.g00` (720).
pub const SYNTHETIC_TYPE0_HEIGHT: u16 = 4;

/// Type-2 synthetic canvas width (px). Unlike retail `btn000.g00` (360).
pub const SYNTHETIC_TYPE2_WIDTH: u16 = 4;
/// Type-2 synthetic canvas height (px). Unlike retail `btn000.g00` (54).
pub const SYNTHETIC_TYPE2_HEIGHT: u16 = 4;

/// Type-2 synthetic region count. One full-canvas region record.
pub const SYNTHETIC_TYPE2_REGION_COUNT: u32 = 1;

/// The authored first pixel on disk is BGR = (0x11, 0x22, 0x33); after
/// the BGR->RGBA reorder the decoded pixel must be
/// (R=0x33, G=0x22, B=0x11, A=0xff).
pub const EXPECTED_FIRST_PIXEL_RGBA: [u8; 4] = [0x33, 0x22, 0x11, 0xff];

/// Encode a byte stream as an all-literal g00 LZSS stream (`bit = 1` →
/// literal), for the given per-literal `unit` (3 for type-0 BGR, 1 for
/// SCN2k). The decoder stops the instant the output target is reached,
/// so the trailing clear bits of a partial final flag group are never
/// interpreted as tokens.
fn encode_all_literals(bytes: &[u8], unit: usize) -> Vec<u8> {
    assert_eq!(bytes.len() % unit, 0, "literal payload must be whole units");
    let units: Vec<&[u8]> = bytes.chunks_exact(unit).collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < units.len() {
        let end = (i + 8).min(units.len());
        let count = end - i;
        let flag: u8 = if count == 8 { 0xff } else { (1u8 << count) - 1 };
        out.push(flag);
        for u in &units[i..end] {
            out.extend_from_slice(u);
        }
        i = end;
    }
    out
}

/// Author a deterministic BGR gradient of `pixel_count` pixels whose
/// last pixel copies the first (so the trailing back-reference
/// reproduces it). First pixel is BGR = (0x11, 0x22, 0x33) with B != R
/// so a skipped reorder is observable.
fn authored_bgr_canvas(pixel_count: usize) -> Vec<u8> {
    assert!(pixel_count >= 2);
    let mut bytes = Vec::with_capacity(pixel_count * 3);
    bytes.extend_from_slice(&[0x11, 0x22, 0x33]);
    for i in 1..(pixel_count - 1) {
        let n = i as u8;
        bytes.extend_from_slice(&[0x40 ^ n, 0x60 ^ n, 0x80 ^ n]);
    }
    bytes.extend_from_slice(&[0x11, 0x22, 0x33]);
    bytes
}

/// Build a type-0 LZSS stream: all pixels but the last as literals, then
/// one relative-LZ77 back-reference reproducing the first pixel as the
/// last pixel. The decoded output is exactly the BGR canvas.
fn encode_type0_with_trailing_backref(bgr: &[u8]) -> Vec<u8> {
    assert_eq!(bgr.len() % 3, 0);
    let pixels = bgr.len() / 3;
    assert!(pixels >= 2);
    assert_eq!(
        &bgr[..3],
        &bgr[bgr.len() - 3..],
        "last pixel must copy the first"
    );

    // Token stream: (pixels - 1) literals, then a back-reference of
    // length 1 pixel at distance (pixels - 1) pixels (points at pixel 0).
    let literal_pixels = pixels - 1;
    let mut out = Vec::new();
    let mut emitted = 0usize; // tokens emitted in current flag group
    let mut flag_pos = 0usize; // index in `out` of current flag byte
    let mut group_open = false;
    let push_token = |out: &mut Vec<u8>,
                      emitted: &mut usize,
                      flag_pos: &mut usize,
                      group_open: &mut bool,
                      is_literal: bool,
                      payload: &[u8]| {
        if !*group_open {
            *flag_pos = out.len();
            out.push(0u8);
            *emitted = 0;
            *group_open = true;
        }
        if is_literal {
            out[*flag_pos] |= 1u8 << *emitted;
        }
        out.extend_from_slice(payload);
        *emitted += 1;
        if *emitted == 8 {
            *group_open = false;
        }
    };

    for p in 0..literal_pixels {
        push_token(
            &mut out,
            &mut emitted,
            &mut flag_pos,
            &mut group_open,
            true,
            &bgr[p * 3..p * 3 + 3],
        );
    }
    // Back-reference token: distance = literal_pixels pixels,
    // length = 1 pixel. t = (distance)<<4 | (length_pixels - 1); the
    // length nibble is 0 (one pixel).
    let t: u16 = (literal_pixels as u16) << 4;
    push_token(
        &mut out,
        &mut emitted,
        &mut flag_pos,
        &mut group_open,
        false,
        &t.to_le_bytes(),
    );
    out
}

/// A structurally-faithful synthetic **type-0** (24-bpp BGR + LZSS) g00
/// file. Decodes cleanly through [`utsushi_reallive::decode_g00`] with
/// zero warnings.
pub fn synthetic_type0_g00() -> Vec<u8> {
    let pixel_count = (SYNTHETIC_TYPE0_WIDTH as usize) * (SYNTHETIC_TYPE0_HEIGHT as usize);
    let bgr = authored_bgr_canvas(pixel_count);
    let lzss = encode_type0_with_trailing_backref(&bgr);
    let mut bytes = vec![G00_TYPE_RAW_BGR];
    bytes.extend_from_slice(&SYNTHETIC_TYPE0_WIDTH.to_le_bytes());
    bytes.extend_from_slice(&SYNTHETIC_TYPE0_HEIGHT.to_le_bytes());
    let compressed_size = (lzss.len() + 8) as u32;
    // Header `uncompressed_size` is the final 32-bpp canvas size.
    let uncompressed_size = pixel_count as u32 * 4;
    bytes.extend_from_slice(&compressed_size.to_le_bytes());
    bytes.extend_from_slice(&uncompressed_size.to_le_bytes());
    bytes.extend_from_slice(&lzss);
    bytes
}

/// A structurally-faithful synthetic **type-2** (region-container +
/// SCN2k LZSS) g00 file with one full-canvas region. Decodes cleanly
/// through [`utsushi_reallive::decode_g00`] with zero warnings.
pub fn synthetic_type2_g00() -> Vec<u8> {
    let w = SYNTHETIC_TYPE2_WIDTH;
    let h = SYNTHETIC_TYPE2_HEIGHT;
    let wh4 = w as usize * h as usize * 4;

    // Region sub-bitmap pixels (BGRA); first pixel B=0x11,G=0x22,R=0x33.
    let mut bgra = Vec::with_capacity(wh4);
    bgra.extend_from_slice(&[0x11, 0x22, 0x33, 0xff]);
    for i in 1..(w as usize * h as usize) {
        let n = i as u8;
        bgra.extend_from_slice(&[0x40 ^ n, 0x60 ^ n, 0x80 ^ n, 0xff]);
    }

    // Container: [u32 region_deal2=1][u32 offset=12][u32 length]
    //            [0x74 block header][0x5c sub-header][w*h*4 pixels]
    let offset = 12usize;
    let length = 0x74 + 0x5c + wh4;
    let mut unc = Vec::new();
    unc.extend_from_slice(&1u32.to_le_bytes());
    unc.extend_from_slice(&(offset as u32).to_le_bytes());
    unc.extend_from_slice(&(length as u32).to_le_bytes());
    unc.extend_from_slice(&[0u8; 0x74]);
    let mut sub = vec![0u8; 0x5c];
    sub[6..8].copy_from_slice(&w.to_le_bytes());
    sub[8..10].copy_from_slice(&h.to_le_bytes());
    unc.extend_from_slice(&sub);
    unc.extend_from_slice(&bgra);
    let uncompressed_size = unc.len();

    let lzss = encode_all_literals(&unc, 1);
    let mut bytes = vec![G00_TYPE_REGIONED_LZSS];
    bytes.extend_from_slice(&w.to_le_bytes());
    bytes.extend_from_slice(&h.to_le_bytes());
    bytes.extend_from_slice(&SYNTHETIC_TYPE2_REGION_COUNT.to_le_bytes());
    // One full-canvas region record with inclusive bounds.
    bytes.extend_from_slice(&0i32.to_le_bytes());
    bytes.extend_from_slice(&0i32.to_le_bytes());
    bytes.extend_from_slice(&(w as i32 - 1).to_le_bytes());
    bytes.extend_from_slice(&(h as i32 - 1).to_le_bytes());
    bytes.extend_from_slice(&0i32.to_le_bytes());
    bytes.extend_from_slice(&0i32.to_le_bytes());
    bytes.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes());
    bytes.extend_from_slice(&(uncompressed_size as u32).to_le_bytes());
    bytes.extend_from_slice(&lzss);
    bytes
}

/// Stage both synthetic fixtures on disk under `dir`, returning their
/// paths.
pub fn write_synthetic_g00_dir(
    dir: &Path,
) -> std::io::Result<(std::path::PathBuf, std::path::PathBuf)> {
    fs::create_dir_all(dir)?;
    let type0 = dir.join(format!("{SYNTHETIC_TYPE0_STEM}.g00"));
    let type2 = dir.join(format!("{SYNTHETIC_TYPE2_STEM}.g00"));
    fs::write(&type0, synthetic_type0_g00())?;
    fs::write(&type2, synthetic_type2_g00())?;
    Ok((type0, type2))
}
