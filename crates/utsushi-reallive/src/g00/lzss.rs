use super::LzssVariant;

/// Read a little-endian `u16` at `off`, or `0` if it runs past the end.
pub(super) fn rd_u16(buf: &[u8], off: usize) -> usize {
    if off + 2 <= buf.len() {
        (buf[off] as usize) | ((buf[off + 1] as usize) << 8)
    } else {
        0
    }
}

/// Read a little-endian `u32` at `off`, or `0` if it runs past the end.
pub(super) fn rd_u32(buf: &[u8], off: usize) -> usize {
    if off + 4 <= buf.len() {
        (buf[off] as usize)
            | ((buf[off + 1] as usize) << 8)
            | ((buf[off + 2] as usize) << 16)
            | ((buf[off + 3] as usize) << 24)
    } else {
        0
    }
}

/// Decode a RealLive/AVG32 g00 LZSS stream into `out_size` bytes.
///
/// The control structure is an 8-bit flag byte read LSB-first: a set
/// bit emits a literal (`variant.literal_unit()` bytes copied straight
/// from the input); a clear bit consumes a 2-byte little-endian token
/// that copies `length` bytes from `distance` bytes back in the output
/// produced so far (overlapping copies are byte-by-byte, so a short
/// distance is a run-fill). There is no ring buffer — the history is the
/// output itself, initially empty.
///
/// The decoder stops the instant `out_size` is reached, so it never
/// overruns; when the input is exhausted first (or a token references an
/// impossible distance) it returns the partial output. Callers compare
/// `out.len()` against their expected size and surface a typed
/// [`G00Warning::PayloadLengthMismatch`] on a shortfall — the length
/// adjustment is never silent.
pub(super) fn lzss_decode(input: &[u8], out_size: usize, variant: LzssVariant) -> Vec<u8> {
    // Cap the preallocation: `out_size` is derived from attacker-controlled
    // header fields, but each input byte expands to a bounded number of
    // output bytes, so bound the reservation by the input length. The vector
    // still grows incrementally, so this never changes the decoded result.
    let per_byte = match variant {
        LzssVariant::Type0Bgr => 45, // max token length (((0x0f)+1)*3) per 2 input bytes ≈ 24; be generous
        LzssVariant::Scn2k => 17,
    };
    let initial_capacity = out_size.min(input.len().saturating_mul(per_byte));
    let mut dst: Vec<u8> = Vec::with_capacity(initial_capacity);
    let unit = variant.literal_unit();
    let mut src = 0usize;

    'outer: while dst.len() < out_size && src < input.len() {
        let flag = input[src];
        src += 1;
        for bit in 0..8 {
            if dst.len() >= out_size {
                break 'outer;
            }
            if src >= input.len() {
                break 'outer;
            }
            if (flag >> bit) & 1 == 1 {
                // Literal: copy `unit` bytes straight through.
                for _ in 0..unit {
                    if src >= input.len() || dst.len() >= out_size {
                        break;
                    }
                    dst.push(input[src]);
                    src += 1;
                }
            } else {
                if src + 2 > input.len() {
                    break 'outer;
                }
                let token = (input[src] as usize) | ((input[src + 1] as usize) << 8);
                src += 2;
                let (distance, length) = variant.split_token(token);
                if distance == 0 || distance > dst.len() {
                    // Impossible back-reference (empty or over-long history):
                    // stop rather than fabricate bytes. Surfaces as a
                    // PayloadLengthMismatch at the caller.
                    break 'outer;
                }
                let start = dst.len() - distance;
                for k in 0..length {
                    if dst.len() >= out_size {
                        break;
                    }
                    let byte = dst[start + k];
                    dst.push(byte);
                }
            }
        }
    }

    dst
}
