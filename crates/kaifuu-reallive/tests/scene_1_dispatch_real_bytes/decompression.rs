use super::*;

/// rlvm-shape LZSS+XOR decompressor restated in our own words from
/// `libreallive::compression::Decompress` (BSD 2006, Peter Jolly). Does
/// **not** apply the per-game second-level XOR — Sukara-branch titles
/// (Sweetie HD) do not need it (outcome A in
/// `docs/research/reallive-sweetie-hd-encryption-mechanism.md`).
///
/// The 256-byte XOR mask is the single shared
/// `kaifuu_reallive::decompressor::AVG32_XOR_MASK` constant — this
/// independent oracle reuses the crate's mask so encode/decode cannot
/// diverge by transcription error.
pub(super) fn decompress_avg32(src: &[u8], dst_len: usize) -> Result<Vec<u8>, String> {
    let mut dst: Vec<u8> = Vec::with_capacity(dst_len);
    let mut src_pos: usize = 8; // skip 8-byte preamble
    let mut mask_idx: u8 = 8;
    let mut bit: u32 = 1;

    if src_pos >= src.len() {
        return Err(format!("src exhausted at preamble: src_len={}", src.len()));
    }
    let mut flag = src[src_pos] ^ AVG32_XOR_MASK[mask_idx as usize];
    src_pos += 1;
    mask_idx = mask_idx.wrapping_add(1);

    while src_pos < src.len() && dst.len() < dst_len {
        if bit == 256 {
            bit = 1;
            if src_pos >= src.len() {
                break;
            }
            flag = src[src_pos] ^ AVG32_XOR_MASK[mask_idx as usize];
            src_pos += 1;
            mask_idx = mask_idx.wrapping_add(1);
        }
        if (flag as u32) & bit != 0 {
            // Literal byte.
            if src_pos >= src.len() {
                break;
            }
            let b = src[src_pos] ^ AVG32_XOR_MASK[mask_idx as usize];
            src_pos += 1;
            mask_idx = mask_idx.wrapping_add(1);
            dst.push(b);
        } else {
            // Back-reference: 2 bytes -> u16 LE.
            if src_pos + 1 >= src.len() {
                break;
            }
            let lo = src[src_pos] ^ AVG32_XOR_MASK[mask_idx as usize];
            src_pos += 1;
            mask_idx = mask_idx.wrapping_add(1);
            let hi = src[src_pos] ^ AVG32_XOR_MASK[mask_idx as usize];
            src_pos += 1;
            mask_idx = mask_idx.wrapping_add(1);
            let count = (lo as u32) | ((hi as u32) << 8);
            let back = (count >> 4) as usize;
            let run = ((count & 0x0f) as usize) + 2;
            if back == 0 || back > dst.len() {
                return Err(format!(
                    "back-ref out of range at src_pos={src_pos} dst.len()={} back={back} run={run}",
                    dst.len()
                ));
            }
            let start = dst.len() - back;
            for i in 0..run {
                if dst.len() >= dst_len {
                    break;
                }
                let byte = dst[start + i];
                dst.push(byte);
            }
        }
        bit <<= 1;
    }

    Ok(dst)
}
