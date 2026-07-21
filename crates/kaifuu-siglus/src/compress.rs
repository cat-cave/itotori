//! Siglus byte-oriented LZSS encoder.
//!
//! [`compress_siglus_lzss`] is the inverse of
//! [`crate::decompress::decompress_siglus_lzss`]: flag bits are consumed
//! least-significant-bit first, `1` denotes a literal, and a zero bit carries
//! a little-endian token whose high 12 bits are the backwards offset and whose
//! low four bits are `length - 2`.

use std::collections::{HashMap, VecDeque};

use thiserror::Error;

const MAX_OFFSET: usize = 0x0fff;
const MAX_MATCH_LEN: usize = 0x0f + 2;
const CANDIDATE_LIMIT: usize = 128;

/// Fatal errors raised by the Siglus LZSS compressor.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SiglusCompressError {
    /// An output token could not be represented by the 12-bit-distance,
    /// 4-bit-length Siglus LZSS form. This is defensive: the encoder bounds
    /// both values before serializing every token.
    #[error("kaifuu.siglus.compress.token_out_of_range: {message}")]
    TokenOutOfRange { message: String },
}

/// Compress a plaintext scene payload into the raw Siglus LZSS stream.
///
/// The outer `[u32 compressed_size][u32 decompressed_size]` header belongs to
/// the packed scene chunk and is written by patchback after this function
/// returns. The greedy matcher is deliberately bounded: byte-correct decode is
/// the format contract, not reproducing an original compiler's token choices.
pub fn compress_siglus_lzss(plaintext: &[u8]) -> Result<Vec<u8>, SiglusCompressError> {
    let mut output = Vec::with_capacity(plaintext.len() + plaintext.len() / 8 + 1);
    let mut candidates: HashMap<u16, VecDeque<usize>> = HashMap::new();
    let mut pos = 0usize;

    while pos < plaintext.len() {
        let flag_at = output.len();
        output.push(0);
        let mut flags = 0u8;

        for bit in 0..8 {
            if pos == plaintext.len() {
                break;
            }

            let (offset, match_len) = best_match(plaintext, pos, &mut candidates);
            let consumed = if match_len >= 2 {
                let token = ((offset << 4) | (match_len - 2)) as u16;
                output.extend_from_slice(&token.to_le_bytes());
                match_len
            } else {
                flags |= 1 << bit;
                output.push(plaintext[pos]);
                1
            };

            for index in pos..pos + consumed {
                insert_candidate(plaintext, index, &mut candidates);
            }
            pos += consumed;
        }
        output[flag_at] = flags;
    }

    Ok(output)
}

fn best_match(
    input: &[u8],
    pos: usize,
    candidates: &mut HashMap<u16, VecDeque<usize>>,
) -> (usize, usize) {
    let Some(key) = pair_at(input, pos) else {
        return (0, 0);
    };
    let Some(previous) = candidates.get_mut(&key) else {
        return (0, 0);
    };
    while previous
        .front()
        .is_some_and(|candidate| pos.saturating_sub(*candidate) > MAX_OFFSET)
    {
        previous.pop_front();
    }

    let mut best = (0usize, 0usize);
    for candidate in previous.iter().rev().take(CANDIDATE_LIMIT) {
        let offset = pos - candidate;
        let limit = (input.len() - pos).min(MAX_MATCH_LEN);
        let mut len = 0usize;
        while len < limit && input[pos + len] == input[pos - offset + len] {
            len += 1;
        }
        if len > best.1 {
            best = (offset, len);
            if len == limit {
                break;
            }
        }
    }
    best
}

fn insert_candidate(input: &[u8], pos: usize, candidates: &mut HashMap<u16, VecDeque<usize>>) {
    let Some(key) = pair_at(input, pos) else {
        return;
    };
    candidates.entry(key).or_default().push_back(pos);
}

fn pair_at(input: &[u8], pos: usize) -> Option<u16> {
    input
        .get(pos..pos.checked_add(2)?)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decompress::decompress_siglus_lzss;

    #[test]
    fn compression_round_trips_literals_and_overlapping_back_references() {
        let input = b"a short prefix then a short prefix then a short prefix";
        let compressed = compress_siglus_lzss(input).expect("compress");
        assert!(compressed.len() < input.len());
        assert_eq!(
            decompress_siglus_lzss(&compressed, input.len()).expect("decompress"),
            input
        );
    }

    #[test]
    fn compression_round_trips_every_partial_flag_group() {
        for len in 0..17 {
            let input = (0..len).map(|index| index as u8).collect::<Vec<_>>();
            let compressed = compress_siglus_lzss(&input).expect("compress");
            assert_eq!(
                decompress_siglus_lzss(&compressed, input.len()).expect("decompress"),
                input
            );
        }
    }
}
