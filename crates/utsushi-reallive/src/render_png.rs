//! Deterministic PNG encoder and checksum helpers for the headless
//! render pipeline.
//!
//! Extracted from [`crate::render_pipeline`] so the encoder's pure
//! byte-stable PNG / zlib / CRC surface lives in its own module. Public
//! items are re-exported from [`crate::render_pipeline`] to keep the
//! crate API unchanged.

use sha2::{Digest, Sha256};

use crate::render_pipeline::{Framebuffer, RGBA_BYTES_PER_PIXEL};

/// PNG file-magic. Pinned so the deterministic-encoder test can assert
/// the prefix without inlining the magic in the test itself.
pub const PNG_FILE_MAGIC: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// PNG colour type for RGBA: per the spec, value `6`.
pub const PNG_COLOUR_TYPE_RGBA: u8 = 6;

/// Bit depth this encoder writes (`8` bits per channel).
pub const PNG_BIT_DEPTH: u8 = 8;

/// Framebuffer header carried in the IDAT scanlines: every PNG scanline
/// is prefixed with a one-byte filter code. The encoder uses `0` (no
/// filter) so the scanline contents stay byte-identical to the raw
/// framebuffer row.
const PNG_FILTER_NONE: u8 = 0;

/// Deterministic SHA-256 hex digest. Sourced through the workspace
/// `sha2` crate (already a transitive dependency); pinned here as a
/// thin helper so the artifact-id derivation has a single home.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Encode `framebuffer` as a deterministic 8-bit RGBA PNG. See the
/// module docstring for the determinism contract.
pub fn encode_png_rgba_deterministic(framebuffer: &Framebuffer) -> Vec<u8> {
    let mut out = Vec::with_capacity(PNG_FILE_MAGIC.len() + framebuffer.pixels().len() + 256);
    out.extend_from_slice(&PNG_FILE_MAGIC);
    write_ihdr_chunk(&mut out, framebuffer.width(), framebuffer.height());
    write_idat_chunk(
        &mut out,
        framebuffer.width(),
        framebuffer.height(),
        framebuffer.pixels(),
    );
    write_iend_chunk(&mut out);
    out
}

fn write_chunk(out: &mut Vec<u8>, chunk_type: [u8; 4], payload: &[u8]) {
    let length = payload.len() as u32;
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(&chunk_type);
    out.extend_from_slice(payload);
    let mut crc_input = Vec::with_capacity(4 + payload.len());
    crc_input.extend_from_slice(&chunk_type);
    crc_input.extend_from_slice(payload);
    let crc = crc32_ieee(&crc_input);
    out.extend_from_slice(&crc.to_be_bytes());
}

fn write_ihdr_chunk(out: &mut Vec<u8>, width: u32, height: u32) {
    let mut payload = Vec::with_capacity(13);
    payload.extend_from_slice(&width.to_be_bytes());
    payload.extend_from_slice(&height.to_be_bytes());
    payload.push(PNG_BIT_DEPTH);
    payload.push(PNG_COLOUR_TYPE_RGBA);
    payload.push(0); // compression method 0 (deflate)
    payload.push(0); // filter method 0
    payload.push(0); // interlace method 0 (none)
    write_chunk(out, *b"IHDR", &payload);
}

fn write_idat_chunk(out: &mut Vec<u8>, width: u32, height: u32, pixels: &[u8]) {
    // Build the PNG scanline stream: one filter byte (0 = None) per row
    // followed by the row's RGBA bytes.
    let row_stride = (width as usize) * RGBA_BYTES_PER_PIXEL;
    let mut scanlines = Vec::with_capacity((height as usize) * (1 + row_stride));
    for row in 0..(height as usize) {
        scanlines.push(PNG_FILTER_NONE);
        let row_start = row * row_stride;
        scanlines.extend_from_slice(&pixels[row_start..row_start + row_stride]);
    }
    let payload = wrap_as_zlib_stored(&scanlines);
    write_chunk(out, *b"IDAT", &payload);
}

fn write_iend_chunk(out: &mut Vec<u8>) {
    write_chunk(out, *b"IEND", &[]);
}

/// Wrap `data` as a zlib stream consisting of one-or-more uncompressed
/// deflate stored blocks (`BTYPE=00`). RFC 1951 caps a stored block at
/// `65_535` bytes; longer payloads are split into multiple blocks. The
/// final block sets the `BFINAL` bit. The zlib header is the
/// well-known `0x78 0x01` (deflate, no compression, no dictionary
/// `FCHECK` chosen so `(CMF*256 + FLG) % 31 == 0`).
pub(crate) fn wrap_as_zlib_stored(data: &[u8]) -> Vec<u8> {
    // CMF: deflate, 32K window. FLG: FCHECK chosen so the RFC 1950
    // header-check invariant `(CMF*256 + FLG) % 31 == 0` holds.
    const ZLIB_CMF: u8 = 0x78;
    const ZLIB_FLG: u8 = 0x01;
    // Compile-time pin of the invariant; a future tweak to either
    // byte that breaks the header check fails to compile rather than
    // shipping a stream rejected by strict zlib decoders.
    const _: () = assert!(
        ((ZLIB_CMF as u16) * 256 + ZLIB_FLG as u16).is_multiple_of(31),
        "zlib header (CMF, FLG) pair must satisfy (CMF*256 + FLG) % 31 == 0",
    );
    const MAX_STORED_BLOCK_LEN: usize = 65_535;

    let mut out = Vec::with_capacity(data.len() + 16);
    out.push(ZLIB_CMF);
    out.push(ZLIB_FLG);

    if data.is_empty() {
        // Emit a single empty final stored block.
        out.push(0x01); // BFINAL=1, BTYPE=00
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(!0u16).to_le_bytes());
    } else {
        let mut offset = 0usize;
        while offset < data.len() {
            let remaining = data.len() - offset;
            let take = remaining.min(MAX_STORED_BLOCK_LEN);
            let is_final = offset + take == data.len();
            let header = u8::from(is_final);
            out.push(header);
            let len = take as u16;
            let nlen = !len;
            out.extend_from_slice(&len.to_le_bytes());
            out.extend_from_slice(&nlen.to_le_bytes());
            out.extend_from_slice(&data[offset..offset + take]);
            offset += take;
        }
    }

    let adler = adler32(data);
    out.extend_from_slice(&adler.to_be_bytes());
    out
}

/// Adler-32 checksum (RFC 1950 / zlib).
pub fn adler32(data: &[u8]) -> u32 {
    const MOD_ADLER: u32 = 65_521;
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for &byte in data {
        a = (a + byte as u32) % MOD_ADLER;
        b = (b + a) % MOD_ADLER;
    }
    (b << 16) | a
}

/// CRC-32 (IEEE-802.3 polynomial, used by PNG and zlib).
pub fn crc32_ieee(data: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (i, slot) in t.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            *slot = c;
        }
        t
    });
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in data {
        let index = ((crc ^ byte as u32) & 0xFF) as usize;
        crc = table[index] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}
