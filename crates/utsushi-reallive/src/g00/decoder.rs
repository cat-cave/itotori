use super::{
    LzssVariant,
    errors::{G00DecodeError, G00Warning},
    lzss::{lzss_decode, rd_u16, rd_u32},
    model::{
        G00_HEADER_PREAMBLE_BYTE_LEN, G00_REGION_RECORD_BYTE_LEN, G00_TYPE0_BGR_BYTES_PER_PIXEL,
        G00Image, G00Rect, G00Region, G00Type,
    },
    parse_lzss_section,
};

/// Decode a g00 file into a typed [`G00Image`] + warnings tuple.
///
/// Dispatches on the lead byte at offset 0 to one of the three
/// type-specific decoders. Returns `Err(G00DecodeError::UnknownType)`
/// for any lead byte outside `{0, 1, 2}` — there is no silent
/// "treat unknown as type 0" fallback.
pub fn decode_g00(input: &[u8]) -> Result<(G00Image, Vec<G00Warning>), G00DecodeError> {
    if input.len() < G00_HEADER_PREAMBLE_BYTE_LEN {
        return Err(G00DecodeError::TruncatedPreamble {
            observed_len: input.len(),
            required_len: G00_HEADER_PREAMBLE_BYTE_LEN,
        });
    }
    let lead = input[0];
    let g00_type =
        G00Type::from_lead_byte(lead).ok_or(G00DecodeError::UnknownType { observed: lead })?;
    let width = u16::from_le_bytes([input[1], input[2]]) as u32;
    let height = u16::from_le_bytes([input[3], input[4]]) as u32;

    match g00_type {
        G00Type::RawBgr => decode_type0(input, width, height),
        G00Type::PalettedLzss => decode_type1(input, width, height),
        G00Type::RegionedLzss => decode_type2(input, width, height),
    }
}

/// Decode a type-0 (24-bpp BGRA, LZSS) g00 file.
///
/// Header: 5-byte preamble + `(u32 compressed_size, u32 uncompressed_size)`
/// LZSS payload. Decoded payload is `width * height * 4` bytes of BGRA pixels
/// reordered to RGBA at the decoder boundary.
fn decode_type0(
    input: &[u8],
    width: u32,
    height: u32,
) -> Result<(G00Image, Vec<G00Warning>), G00DecodeError> {
    let section = parse_lzss_section(input, G00_HEADER_PREAMBLE_BYTE_LEN, G00Type::RawBgr)?;
    let pixel_count = (width as usize).saturating_mul(height as usize);
    // The LZSS output is a flat 24-bpp BGR canvas (`width * height * 3`).
    // The header's `uncompressed_size` field is the *final* 32-bpp size
    // (`width * height * 4`) and is used only for the shortfall warning.
    let bgr_target = pixel_count.saturating_mul(G00_TYPE0_BGR_BYTES_PER_PIXEL);
    let rgba_target = pixel_count.saturating_mul(4);

    let bgr = lzss_decode(section.payload, bgr_target, LzssVariant::Type0Bgr);

    // Expand each decoded BGR triple to RGBA `(R, G, B, 0xff)`.
    let mut pixels_rgba = Vec::with_capacity(rgba_target);
    for triple in bgr.chunks_exact(G00_TYPE0_BGR_BYTES_PER_PIXEL) {
        pixels_rgba.push(triple[2]); // R
        pixels_rgba.push(triple[1]); // G
        pixels_rgba.push(triple[0]); // B
        pixels_rgba.push(0xff); // opaque alpha
    }

    let mut warnings = Vec::new();
    if pixels_rgba.len() != rgba_target {
        // Short LZSS stream: zero-fill to the full canvas and surface a
        // typed warning (never a silent wrong-size buffer).
        warnings.push(G00Warning::PayloadLengthMismatch {
            g00_type: G00Type::RawBgr,
            declared_uncompressed_size: rgba_target as u64,
            observed_payload_size: pixels_rgba.len() as u64,
        });
        pixels_rgba.resize(rgba_target, 0);
    }

    Ok((
        G00Image {
            g00_type: G00Type::RawBgr,
            width,
            height,
            pixels_rgba,
            regions: Vec::new(),
        },
        warnings,
    ))
}

/// Decode a type-1 (8-bpp paletted + LZSS) g00 file.
///
/// Header layout: 5-byte preamble, `u32 LE compressed_size`
/// `u32 LE uncompressed_size`. The LZSS payload decodes to a 1024-byte
/// BGRA palette followed by `width * height` palette indices.
fn decode_type1(
    input: &[u8],
    width: u32,
    height: u32,
) -> Result<(G00Image, Vec<G00Warning>), G00DecodeError> {
    let section = parse_lzss_section(input, G00_HEADER_PREAMBLE_BYTE_LEN, G00Type::PalettedLzss)?;
    let pixel_count = (width as usize).saturating_mul(height as usize);

    // Type-1 LZSS uses the SCN2k token. Its output is a colour table
    // (`u16 LE count`, then `count` × 4-byte BGRA entries) followed by
    // one palette index per pixel. The header target is the declared
    // uncompressed size + 1 (the AVG2000 decoder over-allocates by one).
    let decoded = lzss_decode(
        section.payload,
        section.uncompressed_size.saturating_add(1),
        LzssVariant::Scn2k,
    );

    if decoded.len() < 2 {
        return Err(G00DecodeError::DecodedBufferTooShort {
            g00_type: G00Type::PalettedLzss,
            required_len: 2,
            observed_len: decoded.len(),
        });
    }
    let colortable_len = u16::from_le_bytes([decoded[0], decoded[1]]) as usize;
    let clamped_len = colortable_len.min(256);
    // Palette entries are 4-byte BGRA values; index stream starts after
    // the (raw, unclamped) colour table.
    let indices_start = 2usize.saturating_add(colortable_len.saturating_mul(4));

    let mut pixels_rgba = Vec::with_capacity(pixel_count.saturating_mul(4));
    let mut observed_pixels = 0usize;
    if indices_start <= decoded.len() {
        for &index in &decoded[indices_start..] {
            if observed_pixels >= pixel_count {
                break;
            }
            let idx = index as usize;
            let (r, g, b, a) = if idx < clamped_len {
                let off = 2 + idx * 4;
                // On-disk palette entry byte order is B, G, R, A.
                (
                    decoded[off + 2],
                    decoded[off + 1],
                    decoded[off],
                    decoded[off + 3],
                )
            } else {
                (0, 0, 0, 0)
            };
            pixels_rgba.push(r);
            pixels_rgba.push(g);
            pixels_rgba.push(b);
            pixels_rgba.push(a);
            observed_pixels += 1;
        }
    }

    let mut warnings = Vec::new();
    let rgba_target = pixel_count.saturating_mul(4);
    if pixels_rgba.len() != rgba_target {
        warnings.push(G00Warning::PayloadLengthMismatch {
            g00_type: G00Type::PalettedLzss,
            declared_uncompressed_size: rgba_target as u64,
            observed_payload_size: pixels_rgba.len() as u64,
        });
        pixels_rgba.resize(rgba_target, 0);
    }

    Ok((
        G00Image {
            g00_type: G00Type::PalettedLzss,
            width,
            height,
            pixels_rgba,
            regions: Vec::new(),
        },
        warnings,
    ))
}

/// Decode a type-2 (24-bpp + regions + LZSS) g00 file.
///
/// Header layout: 5-byte preamble, `u32 LE region_count`
/// `region_count` × 24-byte region records, then the LZSS preamble
/// (`u32 LE compressed_size`, `u32 LE uncompressed_size`) and stream.
fn decode_type2(
    input: &[u8],
    width: u32,
    height: u32,
) -> Result<(G00Image, Vec<G00Warning>), G00DecodeError> {
    let post_count_off = G00_HEADER_PREAMBLE_BYTE_LEN + 4;
    if input.len() < post_count_off {
        return Err(G00DecodeError::TruncatedHeader {
            g00_type: G00Type::RegionedLzss,
            required_len: post_count_off,
            observed_len: input.len(),
        });
    }
    let region_count = u32::from_le_bytes([input[5], input[6], input[7], input[8]]) as usize;
    if region_count == 0 {
        return Err(G00DecodeError::Type2ZeroRegions);
    }
    let region_bytes_total = region_count.saturating_mul(G00_REGION_RECORD_BYTE_LEN);
    let lzss_preamble_off = post_count_off.saturating_add(region_bytes_total);
    if input.len() < lzss_preamble_off + 8 {
        return Err(G00DecodeError::TruncatedHeader {
            g00_type: G00Type::RegionedLzss,
            required_len: lzss_preamble_off + 8,
            observed_len: input.len(),
        });
    }

    let mut regions = Vec::with_capacity(region_count);
    for region_idx in 0..region_count {
        let off = post_count_off + region_idx * G00_REGION_RECORD_BYTE_LEN;
        let x1 = i32::from_le_bytes([input[off], input[off + 1], input[off + 2], input[off + 3]]);
        let y1 = i32::from_le_bytes([
            input[off + 4],
            input[off + 5],
            input[off + 6],
            input[off + 7],
        ]);
        let x2 = i32::from_le_bytes([
            input[off + 8],
            input[off + 9],
            input[off + 10],
            input[off + 11],
        ]);
        let y2 = i32::from_le_bytes([
            input[off + 12],
            input[off + 13],
            input[off + 14],
            input[off + 15],
        ]);
        let origin_x = i32::from_le_bytes([
            input[off + 16],
            input[off + 17],
            input[off + 18],
            input[off + 19],
        ]);
        let origin_y = i32::from_le_bytes([
            input[off + 20],
            input[off + 21],
            input[off + 22],
            input[off + 23],
        ]);
        regions.push(G00Region {
            rect: G00Rect { x1, y1, x2, y2 },
            origin_x,
            origin_y,
            name: None,
        });
    }

    // "Overlaid image" munge: some newer type-2 files carry N identical
    // full-size region records stacked on top of each other. When every
    // region is the same non-degenerate rectangle, each is given its own
    // vertical band and the canvas height is multiplied, exactly as the
    // reference decoder does before reconstruction.
    let first = &regions[0].rect;
    let all_identical = region_count > 1
        && first.width() > 0
        && first.height() > 0
        && regions
            .iter()
            .all(|r| r.rect == *first && r.origin_x == regions[0].origin_x);
    let mut canvas_height = height as usize;
    if all_identical {
        for (i, region) in regions.iter_mut().enumerate() {
            // `i` and `height` both originate from disk bytes; the band
            // offset (and its accumulation into the region rect) is computed
            // with saturating ops so a hostile region count / height can only
            // push the rect out of the canvas — never overflow i32. A
            // saturated coordinate lands outside `canvas_height` and is
            // skipped by the per-pixel bounds check below.
            let dy = (i as i32).saturating_mul(height as i32);
            region.rect.y1 = region.rect.y1.saturating_add(dy);
            region.rect.y2 = region.rect.y2.saturating_add(dy);
        }
        canvas_height = (height as usize).saturating_mul(region_count);
    }

    let section = parse_lzss_section(input, lzss_preamble_off, G00Type::RegionedLzss)?;
    let decoded = lzss_decode(
        section.payload,
        section.uncompressed_size,
        LzssVariant::Scn2k,
    );

    let mut warnings = Vec::new();
    if decoded.len() != section.uncompressed_size {
        warnings.push(G00Warning::PayloadLengthMismatch {
            g00_type: G00Type::RegionedLzss,
            declared_uncompressed_size: section.uncompressed_size as u64,
            observed_payload_size: decoded.len() as u64,
        });
    }

    // Reconstruct the transparent canvas by blitting each region's
    // tagged 32-bpp sub-bitmaps. The SCN2k output is a container: a
    // per-region `(offset, length)` table (8-byte stride starting at
    // byte 4) followed by region blocks; each block is a `0x74`-byte
    // header then repeated `(0x5c`-byte sub-header + `w*h*4` BGRA
    // pixels`)` records.
    let canvas_w = width as usize;
    let mut pixels_rgba = vec![0u8; canvas_w.saturating_mul(canvas_height).saturating_mul(4)];
    let region_deal2 = rd_u32(&decoded, 0);
    let region_deal = region_count.min(region_deal2);
    for (i, region) in regions.iter().enumerate().take(region_deal) {
        let offset = rd_u32(&decoded, 4 + i * 8);
        let length = rd_u32(&decoded, 8 + i * 8);
        let block_start = offset.saturating_add(0x74);
        let block_end = offset.saturating_add(length).min(decoded.len());
        let mut src = block_start;
        while src.saturating_add(0x5c) <= block_end {
            let bx = rd_u16(&decoded, src) as i32;
            let by = rd_u16(&decoded, src + 2) as i32;
            let sw = rd_u16(&decoded, src + 6);
            let sh = rd_u16(&decoded, src + 8);
            src += 0x5c;
            // `bx`/`by` (sub-bitmap offsets) and `region.rect.{x1,y1}` are
            // all read verbatim from disk; sum with saturating ops so a
            // corrupt/out-of-range region can only saturate to i32::MIN/MAX
            // (skipped by the bounds check), never wrap into a wrong pixel.
            let dst_x = bx.saturating_add(region.rect.x1);
            let dst_y = by.saturating_add(region.rect.y1);
            let sub_pixels = sw.saturating_mul(sh);
            for row in 0..sh {
                for col in 0..sw {
                    let s = src + (row * sw + col) * 4;
                    if s + 4 > decoded.len() {
                        continue;
                    }
                    let px = dst_x.saturating_add(col as i32);
                    let py = dst_y.saturating_add(row as i32);
                    if px < 0 || py < 0 || px as usize >= canvas_w || py as usize >= canvas_height {
                        continue;
                    }
                    let d = ((py as usize) * canvas_w + px as usize) * 4;
                    // Sub-bitmap pixel byte order is B, G, R, A.
                    pixels_rgba[d] = decoded[s + 2];
                    pixels_rgba[d + 1] = decoded[s + 1];
                    pixels_rgba[d + 2] = decoded[s];
                    pixels_rgba[d + 3] = decoded[s + 3];
                }
            }
            src = src.saturating_add(sub_pixels.saturating_mul(4));
        }
    }

    Ok((
        G00Image {
            g00_type: G00Type::RegionedLzss,
            width,
            height: canvas_height as u32,
            pixels_rgba,
            regions,
        },
        warnings,
    ))
}
