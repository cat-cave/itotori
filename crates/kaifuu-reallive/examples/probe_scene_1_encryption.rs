//! Scene-1 encryption-mechanism probe for Sweetie HD.
//!
//! Reads `Seen.txt` at `$KAIFUU_REAL_SWEETIE_HD_PATH` (or falls back to the
//! canonical `/scratch/itotori-research/...` mount), isolates scene #0001's
//! compressed bytecode payload, applies the rlvm-documented AVG32 LZSS+XOR
//! decompression (no second-level XOR), and reports:
//!
//! - first 32 bytes of raw compressed payload (for traceability),
//! - first 64 bytes of decompressed output,
//! - whether byte 0 matches the BytecodeElement opener set,
//! - Shannon entropy + byte-frequency histogram of the decompressed output,
//! - known-plaintext XOR-mask candidates for the first opener.
//!
//! Read-only on the input bytes. Algorithm restated in our own words from
//! `rlvm/src/libreallive/compression.cc::Decompress` and
//! `rlvm/src/libreallive/scenario.cc::Header` (fetched via gh api,
//! BSD-licensed, no source vendored).

use std::env;
use std::fs;

/// AVG32 256-byte XOR mask used on the LZSS compressed stream itself.
/// Constant; restated in our own words from rlvm `compression.cc`'s
/// `xor_mask[256]` (BSD-licensed, Peter Jolly, 2006).
const AVG32_XOR_MASK: [u8; 256] = [
    0x8b, 0xe5, 0x5d, 0xc3, 0xa1, 0xe0, 0x30, 0x44, 0x00, 0x85, 0xc0, 0x74, 0x09, 0x5f, 0x5e, 0x33,
    0xc0, 0x5b, 0x8b, 0xe5, 0x5d, 0xc3, 0x8b, 0x45, 0x0c, 0x85, 0xc0, 0x75, 0x14, 0x8b, 0x55, 0xec,
    0x83, 0xc2, 0x20, 0x52, 0x6a, 0x00, 0xe8, 0xf5, 0x28, 0x01, 0x00, 0x83, 0xc4, 0x08, 0x89, 0x45,
    0x0c, 0x8b, 0x45, 0xe4, 0x6a, 0x00, 0x6a, 0x00, 0x50, 0x53, 0xff, 0x15, 0x34, 0xb1, 0x43, 0x00,
    0x8b, 0x45, 0x10, 0x85, 0xc0, 0x74, 0x05, 0x8b, 0x4d, 0xec, 0x89, 0x08, 0x8a, 0x45, 0xf0, 0x84,
    0xc0, 0x75, 0x78, 0xa1, 0xe0, 0x30, 0x44, 0x00, 0x8b, 0x7d, 0xe8, 0x8b, 0x75, 0x0c, 0x85, 0xc0,
    0x75, 0x44, 0x8b, 0x1d, 0xd0, 0xb0, 0x43, 0x00, 0x85, 0xff, 0x76, 0x37, 0x81, 0xff, 0x00, 0x00,
    0x04, 0x00, 0x6a, 0x00, 0x76, 0x43, 0x8b, 0x45, 0xf8, 0x8d, 0x55, 0xfc, 0x52, 0x68, 0x00, 0x00,
    0x04, 0x00, 0x56, 0x50, 0xff, 0x15, 0x2c, 0xb1, 0x43, 0x00, 0x6a, 0x05, 0xff, 0xd3, 0xa1, 0xe0,
    0x30, 0x44, 0x00, 0x81, 0xef, 0x00, 0x00, 0x04, 0x00, 0x81, 0xc6, 0x00, 0x00, 0x04, 0x00, 0x85,
    0xc0, 0x74, 0xc5, 0x8b, 0x5d, 0xf8, 0x53, 0xe8, 0xf4, 0xfb, 0xff, 0xff, 0x8b, 0x45, 0x0c, 0x83,
    0xc4, 0x04, 0x5f, 0x5e, 0x5b, 0x8b, 0xe5, 0x5d, 0xc3, 0x8b, 0x55, 0xf8, 0x8d, 0x4d, 0xfc, 0x51,
    0x57, 0x56, 0x52, 0xff, 0x15, 0x2c, 0xb1, 0x43, 0x00, 0xeb, 0xd8, 0x8b, 0x45, 0xe8, 0x83, 0xc0,
    0x20, 0x50, 0x6a, 0x00, 0xe8, 0x47, 0x28, 0x01, 0x00, 0x8b, 0x7d, 0xe8, 0x89, 0x45, 0xf4, 0x8b,
    0xf0, 0xa1, 0xe0, 0x30, 0x44, 0x00, 0x83, 0xc4, 0x08, 0x85, 0xc0, 0x75, 0x56, 0x8b, 0x1d, 0xd0,
    0xb0, 0x43, 0x00, 0x85, 0xff, 0x76, 0x49, 0x81, 0xff, 0x00, 0x00, 0x04, 0x00, 0x6a, 0x00, 0x76,
];

/// Documented BytecodeElement opener bytes (rlvm `bytecode.cc`).
fn is_opener_byte(b: u8) -> bool {
    matches!(b, 0x00 | 0x0A | 0x21 | 0x23 | 0x24 | 0x2C | 0x40)
        || (0x81..=0x9F).contains(&b)
        || (0xE0..=0xFC).contains(&b)
}

fn opener_name(b: u8) -> &'static str {
    match b {
        0x00 => "NUL (Comma)",
        0x0A => "LF (MetaLine)",
        0x21 => "! (MetaEntrypoint)",
        0x23 => "# (Command)",
        0x24 => "$ (Expression)",
        0x2C => ", (Comma)",
        0x40 => "@ (MetaKidoku)",
        b if (0x81..=0x9F).contains(&b) || (0xE0..=0xFC).contains(&b) => "SJIS-lead (Textout)",
        _ => "<not an opener>",
    }
}

/// rlvm-shape LZSS+XOR decompressor restated in our own words.
///
/// Mirrors `libreallive::compression::Decompress` (Peter Jolly, BSD 2006).
/// Does NOT apply the per-game second-level XOR — caller decides.
fn decompress_avg32(src: &[u8], dst_len: usize) -> Result<Vec<u8>, String> {
    let mut dst: Vec<u8> = Vec::with_capacity(dst_len);
    let mut src_pos: usize = 8; // skip 8-byte preamble (header inside compressed blob)
    let mut mask_idx: u8 = 8;
    let mut bit: u32 = 1;

    // Initial flag byte.
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
            // repeat = dst - ((count >> 4) - 1) - 1
            //        = dst - (count >> 4)
            // (rlvm code: `dst - ((count >> 4) - 1) - 1`)
            let back = (count >> 4) as usize;
            let run = ((count & 0x0f) as usize) + 2;
            if back == 0 || back > dst.len() {
                return Err(format!(
                    "back-ref out of range at src_pos={} dst.len()={} back={} run={}",
                    src_pos,
                    dst.len(),
                    back,
                    run
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

fn shannon_entropy(bytes: &[u8]) -> f64 {
    if bytes.is_empty() {
        return 0.0;
    }
    let mut hist = [0u64; 256];
    for &b in bytes {
        hist[b as usize] += 1;
    }
    let n = bytes.len() as f64;
    let mut h = 0.0f64;
    for c in hist.iter() {
        if *c == 0 {
            continue;
        }
        let p = (*c as f64) / n;
        h -= p * p.log2();
    }
    h
}

fn top_bytes(bytes: &[u8], k: usize) -> Vec<(u8, u64)> {
    let mut hist = [0u64; 256];
    for &b in bytes {
        hist[b as usize] += 1;
    }
    let mut indexed: Vec<(u8, u64)> = hist
        .iter()
        .enumerate()
        .map(|(i, &c)| (i as u8, c))
        .collect();
    indexed.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    indexed.into_iter().take(k).collect()
}

fn hex_row(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = env::var("KAIFUU_REAL_SWEETIE_HD_PATH").unwrap_or_else(|_| {
        "/scratch/itotori-research/sweetie-hd/extracted/\
         オシオキSweetie＋Sweets!! HD_DL版/REALLIVEDATA/Seen.txt"
            .to_string()
    });
    println!("=== Sweetie HD scene #0001 encryption-mechanism probe ===");
    println!("seen_path: {path}");
    let bytes = fs::read(&path)?;
    println!("file_bytes: {}", bytes.len());

    // Directory: 10,000 slots of (offset_u32_le, size_u32_le) at file offset 0.
    // Scene 1 is slot 1, file offset 8..16.
    let slot1_offset = u32::from_le_bytes(bytes[8..12].try_into()?) as usize;
    let slot1_size = u32::from_le_bytes(bytes[12..16].try_into()?) as usize;
    println!(
        "slot[1]: file_offset=0x{slot1_offset:x} ({slot1_offset}) size=0x{slot1_size:x} ({slot1_size})",
    );
    assert_eq!(slot1_offset, 0x13880, "scene-1 should be at 0x13880");
    let blob = &bytes[slot1_offset..slot1_offset + slot1_size];
    println!("blob_len: {}", blob.len());

    // Scene header (first 0x1d0 bytes are unencrypted plaintext per scenario.cc).
    let header_size = u32::from_le_bytes(blob[0..4].try_into()?);
    let compiler_ver = u32::from_le_bytes(blob[4..8].try_into()?);
    let kidoku_offset = u32::from_le_bytes(blob[8..12].try_into()?);
    let bytecode_offset = u32::from_le_bytes(blob[0x20..0x24].try_into()?);
    let bytecode_uncompressed = u32::from_le_bytes(blob[0x24..0x28].try_into()?) as usize;
    let bytecode_compressed = u32::from_le_bytes(blob[0x28..0x2c].try_into()?) as usize;
    println!("header_size: 0x{header_size:x}");
    println!("compiler_version: {compiler_ver}");
    println!("kidoku_offset: 0x{kidoku_offset:x}");
    println!("bytecode_offset: 0x{bytecode_offset:x}");
    println!("bytecode_uncompressed_size: {bytecode_uncompressed}");
    println!("bytecode_compressed_size: {bytecode_compressed}");
    assert_eq!(
        compiler_ver, 110002,
        "compiler must be 110002 for Sweetie HD"
    );

    // Compressed payload bytes.
    let cstart = bytecode_offset as usize;
    let cend = cstart + bytecode_compressed;
    let compressed = &blob[cstart..cend];
    println!("compressed_payload_blob_offsets: 0x{cstart:x}..0x{cend:x}");
    println!(
        "compressed_payload_file_offsets: 0x{:x}..0x{:x}",
        slot1_offset + cstart,
        slot1_offset + cend
    );
    println!("compressed[0..32] (raw): {}", hex_row(&compressed[..32]));

    // First 8 bytes of the compressed stream are a preamble (`src += 8` in rlvm).
    // After the preamble: byte_pos = 8 in mask cycle for the first XOR.
    // Show the first 8 raw bytes (preamble) and what they XOR to with mask[0..8].
    let preamble: Vec<u8> = compressed[..8]
        .iter()
        .enumerate()
        .map(|(i, &b)| b ^ AVG32_XOR_MASK[i])
        .collect();
    println!(
        "compressed_preamble[0..8] raw: {}",
        hex_row(&compressed[..8])
    );
    println!(
        "compressed_preamble[0..8] ^ mask[0..8]: {}",
        hex_row(&preamble)
    );
    // The XOR'd preamble in rlvm carries the uncompressed size as little-endian u32 at offset 4?
    // Some titles encode (compressed_size, uncompressed_size) here. Just print both u32 LE for record.
    let pre_lo = u32::from_le_bytes(preamble[0..4].try_into()?);
    let pre_hi = u32::from_le_bytes(preamble[4..8].try_into()?);
    println!("preamble_u32_le_pair: lo=0x{pre_lo:x} ({pre_lo}) hi=0x{pre_hi:x} ({pre_hi})");

    // Decompress (LZSS + first-level XOR; NO second-level XOR yet).
    match decompress_avg32(compressed, bytecode_uncompressed) {
        Ok(dst) => {
            println!("decompress: OK, dst.len()={}", dst.len());
            println!("dst[0..64]: {}", hex_row(&dst[..dst.len().min(64)]));
            let first = dst[0];
            println!(
                "dst[0] = 0x{:02x} -> opener_match={} ({})",
                first,
                is_opener_byte(first),
                opener_name(first)
            );

            // Header byte stats on the WHOLE decompressed stream.
            let h_whole = shannon_entropy(&dst);
            let h_head = shannon_entropy(&dst[..dst.len().min(256)]);
            println!("entropy(dst): {:.3} bits/byte", h_whole);
            println!("entropy(dst[..256]): {:.3} bits/byte", h_head);
            let top = top_bytes(&dst, 16);
            println!("top 16 byte frequencies (whole dst):");
            for (b, c) in &top {
                println!(
                    "  0x{:02x} ({:>3}): {:>5} ({:.2}%)",
                    b,
                    if (0x20..0x7e).contains(b) {
                        *b as char
                    } else {
                        '.'
                    },
                    c,
                    100.0 * (*c as f64) / (dst.len() as f64)
                );
            }

            // Count of opener-byte appearances in dst (every BytecodeElement starts with one).
            let mut opener_hits = 0usize;
            for &b in &dst {
                if is_opener_byte(b) {
                    opener_hits += 1;
                }
            }
            println!(
                "opener-byte appearances (whole dst): {} of {} ({:.1}%)",
                opener_hits,
                dst.len(),
                100.0 * (opener_hits as f64) / (dst.len() as f64)
            );

            // Known-plaintext XOR window: assume dst[0] *should* be one of the
            // opener bytes; compute candidate single-byte XOR masks if outcome
            // is not A.
            if !is_opener_byte(first) {
                println!("--- known-plaintext XOR-mask candidates for dst[0] ---");
                for plain in [0x00u8, 0x0A, 0x21, 0x23, 0x24, 0x2C, 0x40] {
                    println!(
                        "  if plaintext[0]=0x{:02x}: mask_byte=0x{:02x}",
                        plain,
                        first ^ plain
                    );
                }
                // Check whether dst looks like a periodic-XOR'd plaintext by
                // testing common period candidates (16, 32, 256, etc.). For
                // each candidate plaintext opener, see if mask is periodic.
                println!(
                    "--- mask-period probe: assume plaintext[0]=0x23 (Command), period in {{16,32,256}} ---"
                );
                let plain0 = 0x23u8;
                let _mask0 = first ^ plain0;
                // Recover a candidate mask by XORing dst[..256] with a guessed
                // pattern of opener bytes; just emit dst[..16] and dst[..32]
                // for the user to eyeball.
                println!("dst[0..16] raw: {}", hex_row(&dst[..dst.len().min(16)]));
                println!("dst[16..32] raw: {}", hex_row(&dst[16..dst.len().min(32)]));
            } else {
                // Outcome A confirmed: emit a longer dump for traceability.
                println!("--- outcome A confirmed: emit first 128 bytes of dst ---");
                let n = dst.len().min(128);
                for chunk_start in (0..n).step_by(16) {
                    let end = (chunk_start + 16).min(n);
                    println!(
                        "  @0x{:04x}: {}",
                        chunk_start,
                        hex_row(&dst[chunk_start..end])
                    );
                }
                // Walk the first few elements naively and report what they look like.
                println!("--- naive element walk (first 16 elements) ---");
                let mut pos = 0usize;
                let mut elem_idx = 0usize;
                while pos < dst.len() && elem_idx < 16 {
                    let b = dst[pos];
                    if b == 0x0A && pos + 3 <= dst.len() {
                        let val = u16::from_le_bytes(dst[pos + 1..pos + 3].try_into()?);
                        println!("  [{elem_idx:>2}] @0x{pos:04x} MetaLine line={val}");
                        pos += 3;
                    } else if b == 0x40 && pos + 3 <= dst.len() {
                        let val = u16::from_le_bytes(dst[pos + 1..pos + 3].try_into()?);
                        println!("  [{elem_idx:>2}] @0x{pos:04x} MetaKidoku idx={val}");
                        pos += 3;
                    } else if b == 0x21 && pos + 3 <= dst.len() {
                        let val = u16::from_le_bytes(dst[pos + 1..pos + 3].try_into()?);
                        println!("  [{elem_idx:>2}] @0x{pos:04x} MetaEntrypoint idx={val}");
                        pos += 3;
                    } else if b == 0x23 && pos + 8 <= dst.len() {
                        let module_type = dst[pos + 1];
                        let module_id = dst[pos + 2];
                        let opcode = u16::from_le_bytes(dst[pos + 3..pos + 5].try_into()?);
                        let argc = dst[pos + 5];
                        let overload = dst[pos + 6];
                        println!(
                            "  [{elem_idx:>2}] @0x{pos:04x} Command type={module_type} id={module_id} opcode={opcode} argc={argc} overload={overload}"
                        );
                        // Skip just the 8-byte header; we don't parse args here.
                        pos += 8;
                    } else if b == 0x00 || b == 0x2C {
                        println!("  [{elem_idx:>2}] @0x{pos:04x} Comma (0x{b:02x})");
                        pos += 1;
                    } else {
                        println!(
                            "  [{elem_idx:>2}] @0x{pos:04x} byte=0x{b:02x} (textout / unknown)"
                        );
                        pos += 1;
                    }
                    elem_idx += 1;
                }
            }
        }
        Err(e) => {
            println!("decompress: FAILED: {e}");
        }
    }

    Ok(())
}
