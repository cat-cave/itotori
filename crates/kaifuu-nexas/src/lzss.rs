//! LZSS decoder for NeXAS `PAC\0` entries whose archive `pack_type` is
//! [`crate::Compression::Lzss`].
//!
//! # Clean-room provenance
//!
//! Ported from GARbro's `ArcFormats/LzssStream.cs` (`LzssReader`), MIT-licensed,
//! Copyright (C) 2014-2015 by morkt. Independent Rust reimplementation of the
//! documented LZSS variant — no GARbro binary is bundled or invoked.
//!
//! # Format
//!
//! A classic ring-buffer LZSS: a `0x1000`-byte sliding window pre-filled with
//! zeroes, write cursor starting at `0xFEE`. Each control byte carries eight
//! flags consumed **LSB-first**; a set flag copies one literal byte, a clear
//! flag reads a two-byte back-reference `(lo, hi)` decoding to window offset
//! `((hi & 0xF0) << 4) | lo` and copy length `3 + (hi & 0x0F)`. Output stops at
//! `unpacked_size` bytes or when the input is exhausted.

/// Sliding-window size (bytes). Power of two so `& (SIZE-1)` masks the cursor.
const FRAME_SIZE: usize = 0x1000;
/// Initial write position within the window, per the NeXAS/GARbro variant.
const FRAME_INIT_POS: usize = 0xFEE;

/// Decode `packed` into at most `unpacked_size` bytes.
///
/// Matches GARbro's `LzssReader.Unpack`, which stops emitting once the output
/// buffer (`unpacked_size` long) is full even if input remains. Never panics:
/// a truncated back-reference simply ends decoding.
pub fn decode(packed: &[u8], unpacked_size: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(unpacked_size);
    let mut frame = [0u8; FRAME_SIZE];
    let mut frame_pos = FRAME_INIT_POS;
    let frame_mask = FRAME_SIZE - 1;
    let mut src = 0usize;

    while src < packed.len() {
        let ctl = packed[src];
        src += 1;
        for bit in 0..8u32 {
            if out.len() >= unpacked_size {
                return out;
            }
            if (ctl >> bit) & 1 != 0 {
                // Literal byte.
                let Some(&b) = packed.get(src) else {
                    return out;
                };
                src += 1;
                frame[frame_pos] = b;
                frame_pos = (frame_pos + 1) & frame_mask;
                out.push(b);
            } else {
                // Back-reference: (lo, hi).
                let (Some(&lo), Some(&hi)) = (packed.get(src), packed.get(src + 1)) else {
                    return out;
                };
                src += 2;
                let mut offset = ((hi as usize & 0xF0) << 4) | lo as usize;
                let count = 3 + (hi as usize & 0x0F);
                let mut copied = 0;
                while copied < count {
                    if out.len() >= unpacked_size {
                        return out;
                    }
                    let v = frame[offset & frame_mask];
                    offset += 1;
                    frame[frame_pos] = v;
                    frame_pos = (frame_pos + 1) & frame_mask;
                    out.push(v);
                    copied += 1;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal LZSS encoder emitting literals only (all control bits set),
    /// enough to prove the literal path of the decoder round-trips.
    fn encode_all_literals(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for chunk in data.chunks(8) {
            let ctl = if chunk.len() == 8 {
                0xFF
            } else {
                (1u16 << chunk.len()) as u8 - 1
            };
            out.push(ctl);
            out.extend_from_slice(chunk);
        }
        out
    }

    #[test]
    fn round_trips_literal_run() {
        let data = b"NeXAS PAC LZSS literal path exercised end to end.";
        let packed = encode_all_literals(data);
        let out = decode(&packed, data.len());
        assert_eq!(out, data);
    }

    #[test]
    fn back_reference_repeats_window_bytes() {
        // Emit 'a' as a literal, then a back-reference pointing at the byte we
        // just wrote (window offset = FRAME_INIT_POS) with count 3 => "aaa"
        // appended after the literal, total "aaaa".
        let mut packed = Vec::new();
        // control byte: bit0 = literal, bit1 = back-ref, remaining bits unused.
        packed.push(0b0000_0001);
        packed.push(b'a');
        let off = FRAME_INIT_POS; // offset of the literal just written
        let lo = (off & 0xFF) as u8;
        let hi = ((off >> 4) & 0xF0) as u8; // count nibble 0 => length 3
        packed.push(lo);
        packed.push(hi);
        let out = decode(&packed, 4);
        assert_eq!(out, b"aaaa");
    }

    #[test]
    fn output_capped_at_unpacked_size() {
        let data = b"abcdefgh";
        let packed = encode_all_literals(data);
        let out = decode(&packed, 3);
        assert_eq!(out, b"abc");
    }

    #[test]
    fn truncated_input_stops_cleanly() {
        // Control byte says "literal" but no literal byte follows.
        let out = decode(&[0x01], 4);
        assert!(out.is_empty());
    }
}
