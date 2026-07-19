//! G00's two LZSS token layouts.

use thiserror::Error;

/// Compression token interpretation selected by the container type.
#[derive(Debug, Clone, Copy)]
pub(super) enum LzssFlavor {
    /// Type 0 stores whole three-byte BGR literals.
    BgrPixels,
    /// Type 2 stores individual bytes.
    Bytes,
}

/// LZSS errors that retain framing semantics instead of manufacturing data.
#[derive(Debug, Error)]
pub(super) enum LzssError {
    /// A literal or reference ended before its required bytes existed.
    #[error("stream ended before the declared output was complete")]
    Truncated,
    /// A reference points outside previously decoded output.
    #[error("back-reference distance is outside decoded output")]
    InvalidBackReference,
}

/// Decode the LSB-first G00 LZSS stream to its exact declared output size.
pub(super) fn decode_lzss(
    input: &[u8],
    output_len: usize,
    flavor: LzssFlavor,
) -> Result<Vec<u8>, LzssError> {
    let mut output = Vec::with_capacity(output_len);
    let mut cursor = 0;
    while output.len() < output_len {
        let flags = *input.get(cursor).ok_or(LzssError::Truncated)?;
        cursor += 1;
        for bit in 0..8 {
            if output.len() == output_len {
                break;
            }
            if flags & (1 << bit) != 0 {
                let unit = match flavor {
                    LzssFlavor::BgrPixels => 3,
                    LzssFlavor::Bytes => 1,
                };
                let end = cursor.checked_add(unit).ok_or(LzssError::Truncated)?;
                let literal = input.get(cursor..end).ok_or(LzssError::Truncated)?;
                if output.len() + literal.len() > output_len {
                    return Err(LzssError::Truncated);
                }
                output.extend_from_slice(literal);
                cursor = end;
            } else {
                let token = input.get(cursor..cursor + 2).ok_or(LzssError::Truncated)?;
                cursor += 2;
                let token = u16::from_le_bytes([token[0], token[1]]) as usize;
                let (distance, length) = match flavor {
                    LzssFlavor::BgrPixels => ((token >> 4) * 3, ((token & 0x0f) + 1) * 3),
                    LzssFlavor::Bytes => (token >> 4, (token & 0x0f) + 2),
                };
                if distance == 0 || distance > output.len() {
                    return Err(LzssError::InvalidBackReference);
                }
                let source = output.len() - distance;
                for index in 0..length {
                    if output.len() == output_len {
                        break;
                    }
                    let value = output[source + index];
                    output.push(value);
                }
            }
        }
    }
    Ok(output)
}
