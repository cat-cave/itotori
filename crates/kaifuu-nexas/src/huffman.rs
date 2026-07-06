//! Canonical-tree Huffman decoder used by the NeXAS `PAC\0` container.
//!
//! Two places need it: the tail-stored directory index (`Compression`-agnostic;
//! the index is *always* Huffman-packed in the "new" layout) and per-entry
//! payloads whose archive-wide `pack_type` is [`crate::Compression::Huffman`].
//!
//! # Clean-room provenance
//!
//! The bit-exact algorithm is ported from GARbro's
//! `ArcFormats/HuffmanCompression.cs` (`HuffmanDecompressor` + `MsbBitStream`),
//! MIT-licensed, Copyright (C) 2014-2018 by morkt. This is an independent Rust
//! reimplementation of that documented format — no GARbro binary is bundled or
//! invoked. See the crate root for the full attribution note.
//!
//! # Format
//!
//! Bits are consumed **MSB-first**. The stream opens with a serialized binary
//! tree written in pre-order: a `1` bit introduces an internal node (its left
//! then right subtrees follow recursively); a `0` bit introduces a leaf whose
//! 8-bit symbol follows. Decoding then walks the tree from the root per output
//! byte — `0` descends left, `1` descends right — emitting the leaf symbol,
//! until `unpacked_size` bytes have been produced.

use thiserror::Error;

/// Grep-pinnable namespace marker every [`HuffmanError`] display carries.
pub const NEXAS_HUFFMAN_ERROR_MARKER: &str = "kaifuu.nexas.huffman";

/// GARbro's `TreeSize`: the node arrays are fixed at 512 entries (256 leaf
/// symbol slots plus up to 256 internal nodes numbered from 256 upward).
const TREE_SIZE: usize = 512;

/// Fatal errors raised while decoding a Huffman stream. Never panics on
/// malformed input; every path returns a typed error instead.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum HuffmanError {
    /// The bit stream ended before the tree or the requested output was fully
    /// decoded.
    #[error(
        "kaifuu.nexas.huffman.unexpected_eof: bit stream exhausted after {bits_read} bits while \
         {context}"
    )]
    UnexpectedEof {
        bits_read: usize,
        context: &'static str,
    },
    /// The serialized tree declared more internal nodes than the fixed
    /// [`TREE_SIZE`] arrays can hold — a malformed / non-NeXAS stream.
    #[error(
        "kaifuu.nexas.huffman.tree_overflow: internal node index {token} reached the {TREE_SIZE}-entry \
         tree bound"
    )]
    TreeOverflow { token: usize },
}

/// MSB-first bit reader over an in-memory byte slice.
struct MsbBitReader<'a> {
    bytes: &'a [u8],
    /// Absolute bit cursor from the start of `bytes`.
    bit_pos: usize,
}

impl<'a> MsbBitReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, bit_pos: 0 }
    }

    /// Read a single bit (MSB-first within each byte). `None` at end of input.
    fn get_bit(&mut self) -> Option<u32> {
        let byte_index = self.bit_pos >> 3;
        let byte = *self.bytes.get(byte_index)?;
        let shift = 7 - (self.bit_pos & 7);
        self.bit_pos += 1;
        Some(((byte >> shift) & 1) as u32)
    }

    /// Read `count` bits (`count <= 32`), MSB-first. `None` if the stream ends
    /// before `count` bits are available.
    fn get_bits(&mut self, count: u32) -> Option<u32> {
        let mut value = 0u32;
        for _ in 0..count {
            value = (value << 1) | self.get_bit()?;
        }
        Some(value)
    }
}

struct TreeDecoder<'a> {
    input: MsbBitReader<'a>,
    lhs: [u16; TREE_SIZE],
    rhs: [u16; TREE_SIZE],
    token: u16,
}

impl<'a> TreeDecoder<'a> {
    fn new(packed: &'a [u8]) -> Self {
        Self {
            input: MsbBitReader::new(packed),
            lhs: [0u16; TREE_SIZE],
            rhs: [0u16; TREE_SIZE],
            token: 256,
        }
    }

    /// Recursively rebuild the serialized pre-order tree, returning the node id
    /// of the subtree just read.
    fn create_tree(&mut self) -> Result<u16, HuffmanError> {
        let bit = self.input.get_bit().ok_or(HuffmanError::UnexpectedEof {
            bits_read: self.input.bit_pos,
            context: "reading a tree-shape bit",
        })?;
        if bit != 0 {
            let node = self.token;
            let node_index = node as usize;
            if node_index >= TREE_SIZE {
                return Err(HuffmanError::TreeOverflow { token: node_index });
            }
            self.token += 1;
            let left = self.create_tree()?;
            let right = self.create_tree()?;
            self.lhs[node_index] = left;
            self.rhs[node_index] = right;
            Ok(node)
        } else {
            let symbol = self.input.get_bits(8).ok_or(HuffmanError::UnexpectedEof {
                bits_read: self.input.bit_pos,
                context: "reading an 8-bit leaf symbol",
            })?;
            Ok(symbol as u16)
        }
    }
}

/// Decode `packed` into exactly `unpacked_size` bytes.
///
/// # Errors
///
/// [`HuffmanError::UnexpectedEof`] if the stream is exhausted before the tree or
/// the full output is decoded; [`HuffmanError::TreeOverflow`] if the serialized
/// tree exceeds the fixed node bound (a sign the input is not a NeXAS Huffman
/// stream).
pub fn decode(packed: &[u8], unpacked_size: usize) -> Result<Vec<u8>, HuffmanError> {
    let mut decoder = TreeDecoder::new(packed);
    let root = decoder.create_tree()?;
    let mut out = Vec::with_capacity(unpacked_size);
    while out.len() < unpacked_size {
        let mut symbol = root;
        while symbol >= 0x100 {
            let bit = decoder.input.get_bit().ok_or(HuffmanError::UnexpectedEof {
                bits_read: decoder.input.bit_pos,
                context: "descending the Huffman tree",
            })?;
            symbol = if bit != 0 {
                decoder.rhs[symbol as usize]
            } else {
                decoder.lhs[symbol as usize]
            };
        }
        out.push(symbol as u8);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal MSB-first bit writer mirroring the reader, so a test can encode a
    /// tree + payload deterministically and prove the decoder round-trips.
    struct BitWriter {
        bytes: Vec<u8>,
        bit_pos: usize,
    }

    impl BitWriter {
        fn new() -> Self {
            Self {
                bytes: Vec::new(),
                bit_pos: 0,
            }
        }

        fn put_bit(&mut self, bit: u32) {
            if self.bit_pos.is_multiple_of(8) {
                self.bytes.push(0);
            }
            if bit & 1 != 0 {
                let byte = self.bytes.len() - 1;
                let shift = 7 - (self.bit_pos & 7);
                self.bytes[byte] |= 1 << shift;
            }
            self.bit_pos += 1;
        }

        fn put_bits(&mut self, value: u32, count: u32) {
            for i in (0..count).rev() {
                self.put_bit((value >> i) & 1);
            }
        }
    }

    // Encode a fixed two-symbol tree: root is internal, left leaf = 'A',
    // right leaf = 'B'. Then emit a bit per output symbol.
    fn encode(symbols: &[u8], left: u8, right: u8) -> Vec<u8> {
        let mut w = BitWriter::new();
        // Tree: 1 (internal) then 0 leaf(left) then 0 leaf(right).
        w.put_bit(1);
        w.put_bit(0);
        w.put_bits(left as u32, 8);
        w.put_bit(0);
        w.put_bits(right as u32, 8);
        for &s in symbols {
            if s == left {
                w.put_bit(0);
            } else {
                w.put_bit(1);
            }
        }
        w.bytes
    }

    #[test]
    fn round_trips_a_two_symbol_tree() {
        let payload = b"ABBAABBB";
        let packed = encode(payload, b'A', b'B');
        let out = decode(&packed, payload.len()).expect("decode");
        assert_eq!(out, payload);
    }

    #[test]
    fn single_leaf_root_repeats_symbol() {
        // Root is a bare leaf: every output byte is that symbol, zero descent
        // bits consumed.
        let mut w = BitWriter::new();
        w.put_bit(0);
        w.put_bits(b'Z' as u32, 8);
        let out = decode(&w.bytes, 5).expect("decode");
        assert_eq!(out, b"ZZZZZ");
    }

    #[test]
    fn truncated_stream_is_typed_error() {
        let err = decode(&[], 1).expect_err("empty input");
        assert!(matches!(err, HuffmanError::UnexpectedEof { .. }));
        assert!(err.to_string().starts_with(NEXAS_HUFFMAN_ERROR_MARKER));
    }

    #[test]
    fn running_out_of_payload_bits_is_typed_error() {
        // Valid tree, but ask for more output than the stream encodes.
        let packed = encode(b"AB", b'A', b'B');
        let err = decode(&packed, 100).expect_err("not enough payload bits");
        assert!(matches!(err, HuffmanError::UnexpectedEof { .. }));
    }
}
