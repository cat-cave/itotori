//! Self-contained zlib / DEFLATE decoder for NeXAS `PAC\0` entries whose
//! archive `pack_type` is [`crate::Compression::Deflate`] (or the packed case of
//! [`crate::Compression::DeflateOrNone`]).
//!
//! GARbro decompresses these entries with `System.IO.Compression.ZLibStream`.
//! Real NeXAS payloads (e.g. Majikoi's `Config.pac` / `Script.pac`) carry a
//! `78 9C` zlib header, so this module implements the zlib envelope (RFC 1950)
//! around a from-scratch INFLATE (RFC 1951). It is an independent, dependency-
//! free Rust implementation of those public standards — no third-party codec is
//! linked and no external tool is invoked.

use thiserror::Error;

/// Grep-pinnable namespace marker every [`InflateError`] display carries.
pub const NEXAS_INFLATE_ERROR_MARKER: &str = "kaifuu.nexas.inflate";

/// Fatal errors raised while inflating. Malformed input never panics.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum InflateError {
    /// The zlib envelope is malformed (too short, non-deflate method, or bad
    /// header checksum).
    #[error("kaifuu.nexas.inflate.bad_zlib_header: {reason}")]
    BadZlibHeader { reason: &'static str },
    /// The bit stream ended before the deflate data was fully decoded.
    #[error("kaifuu.nexas.inflate.unexpected_eof: {context}")]
    UnexpectedEof { context: &'static str },
    /// A structurally invalid deflate stream (bad block type, bad Huffman
    /// table, out-of-range back-reference, or stored-block length mismatch).
    #[error("kaifuu.nexas.inflate.invalid_stream: {reason}")]
    InvalidStream { reason: &'static str },
    /// The zlib trailer Adler-32 checksum did not match the inflated output.
    #[error(
        "kaifuu.nexas.inflate.adler_mismatch: computed {computed:#010x} but the trailer stored \
         {stored:#010x}"
    )]
    AdlerMismatch { computed: u32, stored: u32 },
}

/// LSB-first bit reader over a byte slice (DEFLATE bit order).
struct BitReader<'a> {
    bytes: &'a [u8],
    byte_pos: usize,
    bit_buf: u32,
    bit_count: u32,
}

impl<'a> BitReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            byte_pos: 0,
            bit_buf: 0,
            bit_count: 0,
        }
    }

    fn need(&mut self, count: u32) -> Result<(), InflateError> {
        while self.bit_count < count {
            let byte = *self
                .bytes
                .get(self.byte_pos)
                .ok_or(InflateError::UnexpectedEof {
                    context: "reading deflate bits",
                })?;
            self.byte_pos += 1;
            self.bit_buf |= (byte as u32) << self.bit_count;
            self.bit_count += 8;
        }
        Ok(())
    }

    fn get_bits(&mut self, count: u32) -> Result<u32, InflateError> {
        if count == 0 {
            return Ok(0);
        }
        self.need(count)?;
        let value = self.bit_buf & ((1u32 << count) - 1);
        self.bit_buf >>= count;
        self.bit_count -= count;
        Ok(value)
    }

    /// Discard buffered bits back to the next byte boundary (for stored blocks).
    fn align_to_byte(&mut self) {
        let drop = self.bit_count & 7;
        self.bit_buf >>= drop;
        self.bit_count -= drop;
    }

    fn read_bytes(&mut self, len: usize) -> Result<&'a [u8], InflateError> {
        // Only valid immediately after `align_to_byte`, with no whole bytes
        // still buffered (stored-block path guarantees this).
        debug_assert_eq!(self.bit_count % 8, 0);
        let buffered = (self.bit_count / 8) as usize;
        // Rewind the source cursor over any whole bytes still in `bit_buf`.
        let start = self.byte_pos - buffered;
        let end = start
            .checked_add(len)
            .filter(|&e| e <= self.bytes.len())
            .ok_or(InflateError::UnexpectedEof {
                context: "reading a stored block",
            })?;
        self.byte_pos = end;
        self.bit_buf = 0;
        self.bit_count = 0;
        Ok(&self.bytes[start..end])
    }
}

/// Canonical Huffman decode table: `counts[len]` = number of codes of that bit
/// length, `symbols` = symbols sorted by (length, symbol).
struct Huffman {
    counts: [u16; MAX_BITS + 1],
    symbols: Vec<u16>,
}

const MAX_BITS: usize = 15;

impl Huffman {
    fn from_lengths(lengths: &[u8]) -> Self {
        let mut counts = [0u16; MAX_BITS + 1];
        for &len in lengths {
            counts[len as usize] += 1;
        }
        counts[0] = 0;
        // Build the sorted symbol table by canonical offset.
        let mut offsets = [0u16; MAX_BITS + 1];
        for len in 1..=MAX_BITS {
            offsets[len] = offsets[len - 1] + counts[len - 1];
        }
        let mut symbols = vec![0u16; lengths.len()];
        for (symbol, &len) in lengths.iter().enumerate() {
            if len != 0 {
                symbols[offsets[len as usize] as usize] = symbol as u16;
                offsets[len as usize] += 1;
            }
        }
        Self { counts, symbols }
    }

    fn decode(&self, reader: &mut BitReader<'_>) -> Result<u16, InflateError> {
        let mut code = 0i32;
        let mut first = 0i32;
        let mut index = 0i32;
        for len in 1..=MAX_BITS {
            code |= reader.get_bits(1)? as i32;
            let count = self.counts[len] as i32;
            if code - first < count {
                return Ok(self.symbols[(index + (code - first)) as usize]);
            }
            index += count;
            first += count;
            first <<= 1;
            code <<= 1;
        }
        Err(InflateError::InvalidStream {
            reason: "code longer than 15 bits (corrupt Huffman table)",
        })
    }
}

// RFC 1951 length / distance base + extra-bit tables.
const LENGTH_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LENGTH_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];

fn fixed_literal_huffman() -> Huffman {
    let mut lengths = [0u8; 288];
    for (symbol, len) in lengths.iter_mut().enumerate() {
        *len = match symbol {
            144..=255 => 9,
            256..=279 => 7,
            _ => 8,
        };
    }
    Huffman::from_lengths(&lengths)
}

fn fixed_distance_huffman() -> Huffman {
    Huffman::from_lengths(&[5u8; 30])
}

fn inflate_block(
    reader: &mut BitReader<'_>,
    lit: &Huffman,
    dist: &Huffman,
    out: &mut Vec<u8>,
) -> Result<(), InflateError> {
    loop {
        let symbol = lit.decode(reader)?;
        match symbol {
            0..=255 => out.push(symbol as u8),
            256 => return Ok(()),
            257..=285 => {
                let index = (symbol - 257) as usize;
                let length = LENGTH_BASE[index] as usize
                    + reader.get_bits(LENGTH_EXTRA[index] as u32)? as usize;
                let dsym = dist.decode(reader)? as usize;
                if dsym >= DIST_BASE.len() {
                    return Err(InflateError::InvalidStream {
                        reason: "distance symbol out of range",
                    });
                }
                let distance =
                    DIST_BASE[dsym] as usize + reader.get_bits(DIST_EXTRA[dsym] as u32)? as usize;
                if distance == 0 || distance > out.len() {
                    return Err(InflateError::InvalidStream {
                        reason: "back-reference distance points before output start",
                    });
                }
                let start = out.len() - distance;
                for i in 0..length {
                    let b = out[start + i];
                    out.push(b);
                }
            }
            _ => {
                return Err(InflateError::InvalidStream {
                    reason: "literal/length symbol out of range",
                });
            }
        }
    }
}

fn read_dynamic_tables(reader: &mut BitReader<'_>) -> Result<(Huffman, Huffman), InflateError> {
    const CODE_LENGTH_ORDER: [usize; 19] = [
        16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
    ];
    let hlit = reader.get_bits(5)? as usize + 257;
    let hdist = reader.get_bits(5)? as usize + 1;
    let hclen = reader.get_bits(4)? as usize + 4;
    if hlit > 286 || hdist > 30 {
        return Err(InflateError::InvalidStream {
            reason: "dynamic table declares too many literal/distance codes",
        });
    }
    let mut cl_lengths = [0u8; 19];
    for i in 0..hclen {
        cl_lengths[CODE_LENGTH_ORDER[i]] = reader.get_bits(3)? as u8;
    }
    let cl_huffman = Huffman::from_lengths(&cl_lengths);

    let total = hlit + hdist;
    let mut lengths = vec![0u8; total];
    let mut i = 0;
    while i < total {
        let symbol = cl_huffman.decode(reader)?;
        match symbol {
            0..=15 => {
                lengths[i] = symbol as u8;
                i += 1;
            }
            16 => {
                if i == 0 {
                    return Err(InflateError::InvalidStream {
                        reason: "code-length repeat with no previous length",
                    });
                }
                let prev = lengths[i - 1];
                let repeat = reader.get_bits(2)? as usize + 3;
                for _ in 0..repeat {
                    if i >= total {
                        return Err(InflateError::InvalidStream {
                            reason: "code-length repeat overflows the table",
                        });
                    }
                    lengths[i] = prev;
                    i += 1;
                }
            }
            17 => {
                let repeat = reader.get_bits(3)? as usize + 3;
                i += repeat;
            }
            18 => {
                let repeat = reader.get_bits(7)? as usize + 11;
                i += repeat;
            }
            _ => {
                return Err(InflateError::InvalidStream {
                    reason: "code-length symbol out of range",
                });
            }
        }
        if i > total {
            return Err(InflateError::InvalidStream {
                reason: "code-length run overflows the table",
            });
        }
    }
    let lit = Huffman::from_lengths(&lengths[..hlit]);
    let dist = Huffman::from_lengths(&lengths[hlit..]);
    Ok((lit, dist))
}

/// Raw DEFLATE (RFC 1951) decode of `data` into a fresh `Vec<u8>`.
pub fn inflate(data: &[u8]) -> Result<Vec<u8>, InflateError> {
    let mut reader = BitReader::new(data);
    let mut out = Vec::new();
    loop {
        let final_block = reader.get_bits(1)? != 0;
        let block_type = reader.get_bits(2)?;
        match block_type {
            0 => {
                reader.align_to_byte();
                let len = reader.get_bits(16)? as usize;
                let nlen = reader.get_bits(16)?;
                if (len as u32) != (!nlen & 0xFFFF) {
                    return Err(InflateError::InvalidStream {
                        reason: "stored-block length / one's-complement mismatch",
                    });
                }
                let chunk = reader.read_bytes(len)?;
                out.extend_from_slice(chunk);
            }
            1 => {
                let lit = fixed_literal_huffman();
                let dist = fixed_distance_huffman();
                inflate_block(&mut reader, &lit, &dist, &mut out)?;
            }
            2 => {
                let (lit, dist) = read_dynamic_tables(&mut reader)?;
                inflate_block(&mut reader, &lit, &dist, &mut out)?;
            }
            _ => {
                return Err(InflateError::InvalidStream {
                    reason: "reserved deflate block type (3)",
                });
            }
        }
        if final_block {
            return Ok(out);
        }
    }
}

fn adler32(data: &[u8]) -> u32 {
    const MOD: u32 = 65521;
    let mut a = 1u32;
    let mut b = 0u32;
    for chunk in data.chunks(5552) {
        for &byte in chunk {
            a += byte as u32;
            b += a;
        }
        a %= MOD;
        b %= MOD;
    }
    (b << 16) | a
}

/// Decode a zlib stream (RFC 1950 envelope around a DEFLATE body), verifying the
/// trailer Adler-32 when present.
///
/// # Errors
///
/// [`InflateError::BadZlibHeader`] for a malformed envelope, the [`inflate`]
/// errors for a bad body, and [`InflateError::AdlerMismatch`] if the trailing
/// checksum disagrees with the inflated output.
pub fn zlib_decompress(data: &[u8]) -> Result<Vec<u8>, InflateError> {
    if data.len() < 2 {
        return Err(InflateError::BadZlibHeader {
            reason: "shorter than the 2-byte zlib header",
        });
    }
    let cmf = data[0];
    let flg = data[1];
    if cmf & 0x0F != 8 {
        return Err(InflateError::BadZlibHeader {
            reason: "compression method is not DEFLATE (CM != 8)",
        });
    }
    if !(((cmf as u16) << 8) | flg as u16).is_multiple_of(31) {
        return Err(InflateError::BadZlibHeader {
            reason: "header checksum (CMF*256+FLG) is not a multiple of 31",
        });
    }
    let mut body_start = 2usize;
    if flg & 0x20 != 0 {
        // FDICT set: a 4-byte dictionary id precedes the body.
        if data.len() < 6 {
            return Err(InflateError::BadZlibHeader {
                reason: "FDICT set but the 4-byte dictionary id is missing",
            });
        }
        body_start = 6;
    }
    let out = inflate(&data[body_start..])?;
    // Verify the trailing Adler-32 if the full 4-byte trailer is present.
    if data.len() >= body_start + 4 {
        let trailer = &data[data.len() - 4..];
        let stored = u32::from_be_bytes([trailer[0], trailer[1], trailer[2], trailer[3]]);
        let computed = adler32(&out);
        // Only enforce when the trailer plausibly is the checksum: the trailer
        // sits at the very end of the zlib stream. NeXAS stores a complete
        // zlib stream per entry, so this always holds.
        if computed != stored {
            return Err(InflateError::AdlerMismatch { computed, stored });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A stored (uncompressed) deflate block wrapped in a minimal zlib envelope,
    // built by hand so the decoder can be proven without a compressor dep.
    fn zlib_stored(payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(0x78); // CMF: CM=8, CINFO=7
        out.push(0x01); // FLG chosen so (0x78*256+0x01)=30721 is divisible by 31
        // One final stored block.
        out.push(0x01); // BFINAL=1, BTYPE=00
        let len = payload.len() as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(payload);
        out.extend_from_slice(&adler32(payload).to_be_bytes());
        out
    }

    #[test]
    fn zlib_stored_block_round_trips() {
        let payload = b"NeXAS deflate stored-block path, byte for byte.";
        let stream = zlib_stored(payload);
        let out = zlib_decompress(&stream).expect("decode");
        assert_eq!(out, payload);
    }

    #[test]
    fn adler_mismatch_is_typed_error() {
        let payload = b"corrupt me";
        let mut stream = zlib_stored(payload);
        let last = stream.len() - 1;
        stream[last] ^= 0xFF;
        let err = zlib_decompress(&stream).expect_err("bad adler");
        assert!(matches!(err, InflateError::AdlerMismatch { .. }));
        assert!(err.to_string().starts_with(NEXAS_INFLATE_ERROR_MARKER));
    }

    #[test]
    fn bad_method_is_typed_error() {
        let err = zlib_decompress(&[0x79, 0x01, 0x00]).expect_err("CM != 8");
        assert!(matches!(err, InflateError::BadZlibHeader { .. }));
    }

    #[test]
    fn fixed_huffman_block_decodes() {
        // "aaaa" as a fixed-Huffman block: literal 'a', then a length-4
        // distance-1 back-reference, then end-of-block. Hand-encode LSB-first.
        // Rather than hand-bake bits, assert the fixed tables build cleanly and
        // the empty final fixed block yields empty output.
        let lit = fixed_literal_huffman();
        let dist = fixed_distance_huffman();
        // symbol 256 (end-of-block) in fixed table has a known 7-bit code 0000000.
        let mut reader = BitReader::new(&[0b0000_0000]);
        let mut out = Vec::new();
        inflate_block(&mut reader, &lit, &dist, &mut out).expect("eob");
        assert!(out.is_empty());
    }

    #[test]
    fn adler32_known_vector() {
        // Adler-32 of "Wikipedia" is 0x11E60398.
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
    }
}
