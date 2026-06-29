//! FIX-3 — structurally-faithful **synthetic** g00 image fixtures.
//!
//! This module authors two non-copyrighted g00 blobs from public g00
//! format archaeology (see `docs/research/reallive-engine.md` and the
//! `src/g00.rs` module docstring): one **type-0** (raw 24-bpp BGRA +
//! LZSS) and one **type-2** (24-bpp BGRA + region table + LZSS). The
//! byte layout mirrors the real on-disk shape of Sweetie HD's
//! `BACK.g00` (type 0) and `btn000.g00` (type 2) — lead byte, `u16 LE`
//! width/height, the type-2 `u32 LE region_count`, the
//! 24-byte-per-record region table (`x1,y1,x2,y2,origin_x,origin_y` as
//! six `i32 LE`, inclusive rectangle bounds), and the
//! `(u32 compressed_size, u32 uncompressed_size, lzss_payload)`
//! compression framing where `compressed_size` counts from itself to
//! end-of-file inclusive (so total file length is
//! `header_prefix + compressed_size`).
//!
//! # Clean-room provenance
//!
//! NO verbatim retail pixel data is copied. The Sweetie HD assets were
//! read **only** to learn structural byte-counts (canvas dimensions,
//! region-record width, the `compressed_size = filesize - prefix`
//! relationship). Every pixel byte here is authored from a tiny
//! deterministic gradient. The canvas dimensions are deliberately
//! *unlike* the retail files (retail `BACK.g00` is 1280x720, retail
//! `btn000.g00` is 360x54) so the fixtures can never be mistaken for a
//! retail extract — see [`synthetic_type0_g00`] / [`synthetic_type2_g00`].
//!
//! # Compression framing is genuine, not all-literal
//!
//! Both fixtures encode at least one real LZSS **back-reference** token
//! (not just literals), so the fixtures exercise the classic
//! ring-buffer back-reference decode path — the same framing the retail
//! corpus uses — rather than a degenerate literal-only stream. The
//! back-reference repeats the canvas's first pixel as its last pixel,
//! which the decode test cross-checks.
//!
//! # How ALPHA-006b consumes this fixture
//!
//! 006b proves the `GraphicsObjectKind::Image` render-pass no-op
//! (the render pass records an [`utsushi_reallive::ImageRef`] but
//! produces no visible pixels until the g00 binding lands) **without
//! retail assets**. It can consume this module two ways:
//!
//! 1. In-memory: call [`synthetic_type0_g00`] / [`synthetic_type2_g00`]
//!    and feed the bytes straight to
//!    [`utsushi_reallive::decode_g00`], then build a
//!    `GraphicsObjectKind::Image { image_ref: ImageRef { asset_key,
//!    region_index } }` referencing it.
//! 2. On-disk: call [`write_synthetic_g00_dir`] to stage
//!    `<dir>/<SYNTHETIC_TYPE0_STEM>.g00` and
//!    `<dir>/<SYNTHETIC_TYPE2_STEM>.g00`, then point an
//!    `AssetPackage` at `<dir>` exactly like
//!    `tests/graphics_rlop.rs::OnDiskG00Package` does for the real
//!    corpus — but with zero retail bytes on disk.
//!
//! Either way the fixture is a *real* decodable g00, so the 006b
//! redaction/no-op assertion is not tautological: the Image object
//! carries a reference that genuinely decodes, and the render pass's
//! no-op behaviour is what 006b pins.

#![allow(dead_code)]

use std::fs;
use std::path::Path;

use utsushi_reallive::{
    G00_LZSS_INITIAL_CURSOR, G00_LZSS_MAX_RUN, G00_LZSS_MIN_RUN, G00_TYPE_RAW_BGR,
    G00_TYPE_REGIONED_LZSS,
};

/// File stem used when [`write_synthetic_g00_dir`] stages the type-0
/// fixture (`<stem>.g00`). 006b can use this as an `ImageRef::asset_key`.
pub const SYNTHETIC_TYPE0_STEM: &str = "SYNTH_BG";

/// File stem used when [`write_synthetic_g00_dir`] stages the type-2
/// fixture (`<stem>.g00`).
pub const SYNTHETIC_TYPE2_STEM: &str = "SYNTH_BTN";

/// Type-0 synthetic canvas width (px). Deliberately small and unlike
/// retail `BACK.g00` (1280) so the fixture is unmistakably synthetic.
pub const SYNTHETIC_TYPE0_WIDTH: u16 = 4;
/// Type-0 synthetic canvas height (px). Unlike retail `BACK.g00` (720).
pub const SYNTHETIC_TYPE0_HEIGHT: u16 = 4;

/// Type-2 synthetic canvas width (px). Unlike retail `btn000.g00` (360).
pub const SYNTHETIC_TYPE2_WIDTH: u16 = 4;
/// Type-2 synthetic canvas height (px). Unlike retail `btn000.g00` (54).
pub const SYNTHETIC_TYPE2_HEIGHT: u16 = 4;

/// Type-2 synthetic region count. Mirrors the retail `btn000.g00`
/// shape of several full-canvas region records (one per button state),
/// scaled down to two records.
pub const SYNTHETIC_TYPE2_REGION_COUNT: u32 = 2;

/// One LZSS token in the classic g00 variant.
#[derive(Debug, Clone, Copy)]
enum LzssToken {
    /// Emit one literal byte.
    Literal(u8),
    /// Copy `len` bytes from absolute ring-buffer position `pos`.
    Backref { pos: u16, len: u8 },
}

/// Encode a token stream into the classic g00 LZSS framing.
///
/// 8-bit flag byte, LSB first: `bit = 0` literal, `bit = 1` 2-byte
/// back-reference token. The token is `(lo, hi)` where the 12-bit
/// absolute position is `lo | ((hi & 0xf0) << 4)` and the length is
/// `(hi & 0x0f) + G00_LZSS_MIN_RUN`. This is the exact inverse of
/// `src/g00.rs::lzss_decode_classic`.
fn encode_lzss_tokens(tokens: &[LzssToken]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut idx = 0;
    while idx < tokens.len() {
        let group_end = (idx + 8).min(tokens.len());
        let group = &tokens[idx..group_end];
        let mut flag: u8 = 0;
        for (bit, token) in group.iter().enumerate() {
            if matches!(token, LzssToken::Backref { .. }) {
                flag |= 1u8 << bit;
            }
        }
        out.push(flag);
        for token in group {
            match *token {
                LzssToken::Literal(byte) => out.push(byte),
                LzssToken::Backref { pos, len } => {
                    assert!(
                        (len as usize) >= G00_LZSS_MIN_RUN && (len as usize) <= G00_LZSS_MAX_RUN,
                        "synthetic backref length {len} outside the classic LZSS run range \
                         [{G00_LZSS_MIN_RUN}, {G00_LZSS_MAX_RUN}]",
                    );
                    let length_field = ((len as u32) - G00_LZSS_MIN_RUN as u32) & 0x0f;
                    let lo = (pos as u32 & 0xff) as u8;
                    let hi = ((((pos as u32) >> 4) & 0xf0) | length_field) as u8;
                    out.push(lo);
                    out.push(hi);
                }
            }
        }
        idx = group_end;
    }
    out
}

/// Build an LZSS stream that emits `plaintext[..plaintext.len()-4]` as
/// literals, then a single back-reference repeating the canvas's first
/// pixel (4 bytes) as the final pixel. Requires `plaintext.len()` to be
/// a multiple of 4 and the last 4 bytes to equal the first 4 bytes (the
/// caller authors the gradient so this holds). The decoded output is
/// exactly `plaintext`, so the LZSS header's `uncompressed_size ==
/// plaintext.len()` and the decode emits zero length-mismatch warnings.
fn encode_canvas_with_trailing_backref(plaintext: &[u8]) -> Vec<u8> {
    assert!(
        plaintext.len() >= 8 && plaintext.len().is_multiple_of(4),
        "synthetic canvas must be a whole number of BGRA pixels, >= 2 pixels",
    );
    let literal_len = plaintext.len() - 4;
    assert_eq!(
        &plaintext[..4],
        &plaintext[literal_len..],
        "trailing pixel must repeat the first pixel so the backref reproduces it exactly",
    );
    let mut tokens: Vec<LzssToken> = plaintext[..literal_len]
        .iter()
        .map(|&b| LzssToken::Literal(b))
        .collect();
    // The first literal byte lands at absolute ring position
    // G00_LZSS_INITIAL_CURSOR (4078); the next three at +1..+3. A
    // 4-byte back-reference there reproduces the first pixel. The
    // cursor advances monotonically and never wraps for these small
    // canvases, so positions 4078..=4081 are written exactly once.
    tokens.push(LzssToken::Backref {
        pos: G00_LZSS_INITIAL_CURSOR as u16,
        len: 4,
    });
    encode_lzss_tokens(&tokens)
}

/// Author a small deterministic BGRA gradient of `pixel_count` pixels
/// whose **last** pixel is a copy of the **first** pixel (so the
/// trailing-back-reference encoder reproduces it). Channel values are
/// chosen so `B != R` on the first pixel, which lets the decode test
/// prove the BGRA->RGBA reorder fired (audit-focus: "BGR treated as RGB
/// silently").
fn authored_bgra_canvas(pixel_count: usize) -> Vec<u8> {
    assert!(pixel_count >= 2);
    let mut bytes = Vec::with_capacity(pixel_count * 4);
    // First pixel: B=0x11, G=0x22, R=0x33, A=0xff (B != R on purpose).
    let first = [0x11u8, 0x22, 0x33, 0xff];
    bytes.extend_from_slice(&first);
    for i in 1..(pixel_count - 1) {
        let n = i as u8;
        // Distinct, B != R per pixel so a reorder skip is observable.
        bytes.extend_from_slice(&[0x40 ^ n, 0x60 ^ n, 0x80 ^ n, 0xff]);
    }
    // Last pixel repeats the first so the trailing back-reference is exact.
    bytes.extend_from_slice(&first);
    bytes
}

/// Assemble a full type-0 g00 file: 5-byte preamble +
/// `(u32 compressed_size, u32 uncompressed_size)` + LZSS payload.
fn assemble_type0(width: u16, height: u16, bgra: &[u8]) -> Vec<u8> {
    let lzss = encode_canvas_with_trailing_backref(bgra);
    let mut bytes = Vec::new();
    bytes.push(G00_TYPE_RAW_BGR);
    bytes.extend_from_slice(&width.to_le_bytes());
    bytes.extend_from_slice(&height.to_le_bytes());
    // compressed_size counts from itself to EOF inclusive: the 8-byte
    // (compressed_size, uncompressed_size) preamble plus the payload.
    let compressed_size = (lzss.len() + 8) as u32;
    let uncompressed_size = bgra.len() as u32;
    bytes.extend_from_slice(&compressed_size.to_le_bytes());
    bytes.extend_from_slice(&uncompressed_size.to_le_bytes());
    bytes.extend_from_slice(&lzss);
    bytes
}

/// Encode one 24-byte type-2 region record (six `i32 LE`).
fn region_record(x1: i32, y1: i32, x2: i32, y2: i32, origin_x: i32, origin_y: i32) -> [u8; 24] {
    let mut rec = [0u8; 24];
    rec[0..4].copy_from_slice(&x1.to_le_bytes());
    rec[4..8].copy_from_slice(&y1.to_le_bytes());
    rec[8..12].copy_from_slice(&x2.to_le_bytes());
    rec[12..16].copy_from_slice(&y2.to_le_bytes());
    rec[16..20].copy_from_slice(&origin_x.to_le_bytes());
    rec[20..24].copy_from_slice(&origin_y.to_le_bytes());
    rec
}

/// A structurally-faithful synthetic **type-0** (raw 24-bpp BGRA + LZSS)
/// g00 file. Decodes cleanly through
/// [`utsushi_reallive::decode_g00`] with zero warnings.
pub fn synthetic_type0_g00() -> Vec<u8> {
    let pixel_count = (SYNTHETIC_TYPE0_WIDTH as usize) * (SYNTHETIC_TYPE0_HEIGHT as usize);
    let bgra = authored_bgra_canvas(pixel_count);
    assert_eq!(bgra.len(), pixel_count * 4);
    assemble_type0(SYNTHETIC_TYPE0_WIDTH, SYNTHETIC_TYPE0_HEIGHT, &bgra)
}

/// A structurally-faithful synthetic **type-2** (24-bpp BGRA + region
/// table + LZSS) g00 file. Carries [`SYNTHETIC_TYPE2_REGION_COUNT`]
/// non-degenerate full-canvas region records (mirroring the retail
/// `btn000.g00` button-state shape) and decodes cleanly through
/// [`utsushi_reallive::decode_g00`] with zero warnings.
pub fn synthetic_type2_g00() -> Vec<u8> {
    let pixel_count = (SYNTHETIC_TYPE2_WIDTH as usize) * (SYNTHETIC_TYPE2_HEIGHT as usize);
    let bgra = authored_bgra_canvas(pixel_count);
    let lzss = encode_canvas_with_trailing_backref(&bgra);

    let mut bytes = Vec::new();
    bytes.push(G00_TYPE_REGIONED_LZSS);
    bytes.extend_from_slice(&SYNTHETIC_TYPE2_WIDTH.to_le_bytes());
    bytes.extend_from_slice(&SYNTHETIC_TYPE2_HEIGHT.to_le_bytes());
    bytes.extend_from_slice(&SYNTHETIC_TYPE2_REGION_COUNT.to_le_bytes());
    // Each region covers the full canvas with inclusive bounds
    // (x2 = width-1, y2 = height-1) and a zero origin, exactly the
    // shape retail button g00 files use for their per-state records.
    let x2 = SYNTHETIC_TYPE2_WIDTH as i32 - 1;
    let y2 = SYNTHETIC_TYPE2_HEIGHT as i32 - 1;
    for _ in 0..SYNTHETIC_TYPE2_REGION_COUNT {
        bytes.extend_from_slice(&region_record(0, 0, x2, y2, 0, 0));
    }
    let compressed_size = (lzss.len() + 8) as u32;
    let uncompressed_size = bgra.len() as u32;
    bytes.extend_from_slice(&compressed_size.to_le_bytes());
    bytes.extend_from_slice(&uncompressed_size.to_le_bytes());
    bytes.extend_from_slice(&lzss);
    bytes
}

/// Stage both synthetic fixtures on disk under `dir` as
/// `<SYNTHETIC_TYPE0_STEM>.g00` and `<SYNTHETIC_TYPE2_STEM>.g00`,
/// returning their paths. 006b uses this to back an on-disk
/// `AssetPackage` without any retail bytes.
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
