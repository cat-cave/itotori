//! Stored-deflate PNG codec for the asset-OCR prototype.
//!
//! Encode/decode of an uncompressed (stored-deflate) 8-bit grayscale PNG so the
//! whole path stays dependency-free. This is a deterministic in-process
//! prototype; it never decodes Huffman-compressed retail image bytes.

use crate::KaifuuResult;

use super::GrayImage;

const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

/// Encode an 8-bit grayscale image as an uncompressed (stored-deflate) PNG.
pub fn encode_grayscale_png(width: u32, height: u32, pixels: &[u8]) -> Vec<u8> {
    assert_eq!(
        pixels.len(),
        (width * height) as usize,
        "pixel buffer must be width*height"
    );
    // Raw scanlines: a leading filter byte (0 = None) per row.
    let mut raw = Vec::with_capacity((height * (width + 1)) as usize);
    for row in 0..height {
        raw.push(0);
        let start = (row * width) as usize;
        raw.extend_from_slice(&pixels[start..start + width as usize]);
    }

    let mut out = Vec::new();
    out.extend_from_slice(&PNG_SIGNATURE);
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 0, 0, 0, 0]); // depth=8, grayscale, deflate, filter0, no interlace
    write_chunk(&mut out, b"IHDR", &ihdr);
    write_chunk(&mut out, b"IDAT", &zlib_store(&raw));
    write_chunk(&mut out, b"IEND", &[]);
    out
}

fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

/// Wrap `data` in a zlib stream made only of stored (uncompressed) deflate
/// blocks.
fn zlib_store(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01]; // CMF/FLG, (0x7801 % 31 == 0)
    let mut offset = 0usize;
    if data.is_empty() {
        out.extend_from_slice(&[0x01, 0x00, 0x00, 0xff, 0xff]);
    }
    while offset < data.len() {
        let len = (data.len() - offset).min(0xffff);
        let final_block = offset + len >= data.len();
        out.push(u8::from(final_block));
        out.extend_from_slice(&(len as u16).to_le_bytes());
        out.extend_from_slice(&(!(len as u16)).to_le_bytes());
        out.extend_from_slice(&data[offset..offset + len]);
        offset += len;
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

/// Decode a stored-deflate 8-bit grayscale PNG. Returns `Err` for any other
/// PNG shape (this prototype does not decode compressed retail images).
pub fn decode_grayscale_png(bytes: &[u8]) -> KaifuuResult<GrayImage> {
    if bytes.len() < 8 || bytes[..8] != PNG_SIGNATURE {
        return Err("asset-ocr: not a PNG (bad signature)".into());
    }
    let mut cursor = 8usize;
    let mut width = 0u32;
    let mut height = 0u32;
    let mut idat = Vec::new();
    let mut saw_ihdr = false;
    while cursor + 8 <= bytes.len() {
        let length = u32::from_be_bytes(read4(bytes, cursor)?) as usize;
        let kind = &bytes[cursor + 4..cursor + 8];
        let data_start = cursor + 8;
        let data_end = data_start
            .checked_add(length)
            .filter(|end| *end + 4 <= bytes.len())
            .ok_or("asset-ocr: truncated PNG chunk")?;
        let data = &bytes[data_start..data_end];
        match kind {
            b"IHDR" => {
                if data.len() != 13 {
                    return Err("asset-ocr: malformed IHDR".into());
                }
                width = u32::from_be_bytes(read4(data, 0)?);
                height = u32::from_be_bytes(read4(data, 4)?);
                if data[8] != 8 || data[9] != 0 {
                    return Err("asset-ocr: only 8-bit grayscale PNG fixtures are supported".into());
                }
                saw_ihdr = true;
            }
            b"IDAT" => idat.extend_from_slice(data),
            b"IEND" => break,
            _ => {}
        }
        cursor = data_end + 4; // skip trailing CRC
    }
    if !saw_ihdr {
        return Err("asset-ocr: PNG missing IHDR".into());
    }
    let raw = zlib_inflate_stored(&idat)?;
    unfilter_grayscale(width, height, &raw)
}

fn zlib_inflate_stored(stream: &[u8]) -> KaifuuResult<Vec<u8>> {
    if stream.len() < 2 {
        return Err("asset-ocr: truncated zlib stream".into());
    }
    let mut cursor = 2usize; // skip CMF/FLG
    let mut out = Vec::new();
    loop {
        if cursor >= stream.len() {
            return Err("asset-ocr: truncated deflate stream".into());
        }
        let header = stream[cursor];
        cursor += 1;
        let final_block = header & 0x01 != 0;
        let btype = (header >> 1) & 0x03;
        if btype != 0 {
            return Err(
                "asset-ocr: only stored (uncompressed) deflate blocks are supported".into(),
            );
        }
        if cursor + 4 > stream.len() {
            return Err("asset-ocr: truncated stored-block header".into());
        }
        let len = u16::from_le_bytes([stream[cursor], stream[cursor + 1]]) as usize;
        cursor += 4; // LEN + NLEN
        if cursor + len > stream.len() {
            return Err("asset-ocr: stored block runs past end".into());
        }
        out.extend_from_slice(&stream[cursor..cursor + len]);
        cursor += len;
        if final_block {
            break;
        }
    }
    Ok(out)
}

fn unfilter_grayscale(width: u32, height: u32, raw: &[u8]) -> KaifuuResult<GrayImage> {
    let stride = width as usize + 1;
    if raw.len() != stride * height as usize {
        return Err("asset-ocr: decoded byte length does not match dimensions".into());
    }
    let w = width as usize;
    let mut pixels = vec![0u8; w * height as usize];
    for row in 0..height as usize {
        let filter = raw[row * stride];
        let filt = &raw[row * stride + 1..row * stride + 1 + w];
        for col in 0..w {
            let a = if col > 0 {
                pixels[row * w + col - 1]
            } else {
                0
            };
            let b = if row > 0 {
                pixels[(row - 1) * w + col]
            } else {
                0
            };
            let c = if row > 0 && col > 0 {
                pixels[(row - 1) * w + col - 1]
            } else {
                0
            };
            let value = match filter {
                0 => filt[col],
                1 => filt[col].wrapping_add(a),
                2 => filt[col].wrapping_add(b),
                3 => filt[col].wrapping_add(((u16::from(a) + u16::from(b)) / 2) as u8),
                4 => filt[col].wrapping_add(paeth(a, b, c)),
                other => return Err(format!("asset-ocr: unsupported PNG filter {other}").into()),
            };
            pixels[row * w + col] = value;
        }
    }
    Ok(GrayImage {
        width,
        height,
        pixels,
    })
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let p = i32::from(a) + i32::from(b) - i32::from(c);
    let pa = (p - i32::from(a)).abs();
    let pb = (p - i32::from(b)).abs();
    let pc = (p - i32::from(c)).abs();
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

fn read4(bytes: &[u8], offset: usize) -> KaifuuResult<[u8; 4]> {
    bytes
        .get(offset..offset + 4)
        .and_then(|slice| slice.try_into().ok())
        .ok_or_else(|| "asset-ocr: unexpected end of bytes".into())
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

fn adler32(data: &[u8]) -> u32 {
    let mut a = 1u32;
    let mut b = 0u32;
    for &byte in data {
        a = (a + u32::from(byte)) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}
