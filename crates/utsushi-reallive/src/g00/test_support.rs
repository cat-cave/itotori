use super::*;

/// Encode a byte stream as an all-literal g00 LZSS stream for the
/// given variant (`bit = 1` → literal). Because the decoder stops the
/// instant `out_size` is reached, the trailing (clear) bits of a
/// partial final flag group are never interpreted as tokens, so this
/// round-trips for any length.
pub(super) fn encode_all_literals(bytes: &[u8], variant: LzssVariant) -> Vec<u8> {
    let unit = variant.literal_unit();
    assert_eq!(bytes.len() % unit, 0, "literal payload must be whole units");
    let units: Vec<&[u8]> = bytes.chunks_exact(unit).collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < units.len() {
        let end = (i + 8).min(units.len());
        let count = end - i;
        let flag: u8 = if count == 8 { 0xff } else { (1u8 << count) - 1 };
        out.push(flag);
        for u in &units[i..end] {
            out.extend_from_slice(u);
        }
        i = end;
    }
    out
}

pub(super) fn type0_with(payload: &[u8], declared_output: u32) -> Vec<u8> {
    let mut bytes = vec![G00_TYPE_RAW_BGR, 1, 0, 1, 0];
    bytes.extend_from_slice(&((payload.len() + 8) as u32).to_le_bytes());
    bytes.extend_from_slice(&declared_output.to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

pub(super) fn assert_content_validator_rejects_strict_framing_and_token_failures() {
    let err = |bytes: &[u8]| validate_g00_lzss_content(bytes).unwrap_err();
    assert!(matches!(
        err(&[0; 4]),
        G00ContentValidationError::TruncatedPreamble
    ));
    assert!(matches!(
        err(&[3; 5]),
        G00ContentValidationError::UnknownType
    ));
    assert!(matches!(
        err(&[0; 5]),
        G00ContentValidationError::HeaderBounds { .. }
    ));
    let mut type2 = vec![G00_TYPE_REGIONED_LZSS, 0, 0, 0, 0];
    type2.extend_from_slice(&1u32.to_le_bytes());
    assert!(matches!(
        err(&type2),
        G00ContentValidationError::HeaderBounds { .. }
    ));
    let mut malformed = type0_with(&[7, 1, 2, 3], 4);
    malformed[5..9].copy_from_slice(&4u32.to_le_bytes());
    assert!(matches!(
        err(&malformed),
        G00ContentValidationError::InvalidCompressedSize
    ));
    let mut outer = type0_with(&[7, 1, 2, 3], 4);
    outer[5..9].copy_from_slice(&13u32.to_le_bytes());
    assert!(matches!(
        err(&outer),
        G00ContentValidationError::OuterLengthMismatch { .. }
    ));
    assert!(matches!(
        err(&type0_with(&[7, 1, 2, 3], 3)),
        G00ContentValidationError::DeclaredOutputMismatch { .. }
    ));
    assert!(matches!(
        err(&type0_with(&[1], 4)),
        G00ContentValidationError::TruncatedLiteral { .. }
    ));
    assert!(matches!(
        err(&type0_with(&[0, 0], 4)),
        G00ContentValidationError::TruncatedBackreference { .. }
    ));
    assert!(matches!(
        err(&type0_with(&[0, 0, 0], 4)),
        G00ContentValidationError::InvalidDistance { .. }
    ));
    let mut type1 = vec![G00_TYPE_PALETTED_LZSS, 0, 0, 0, 0];
    type1.extend_from_slice(&12u32.to_le_bytes());
    type1.extend_from_slice(&1u32.to_le_bytes());
    type1.extend_from_slice(&[1, 0xaa, 0x10, 0]);
    assert!(matches!(
        err(&type1),
        G00ContentValidationError::OutputOverrun { .. }
    ));
    assert!(matches!(
        err(&type0_with(&[], 4)),
        G00ContentValidationError::OutputUnderrun { .. }
    ));
    let mut trailing = type0_with(&[1, 1, 2, 3], 4);
    trailing.push(0);
    let compressed_size = (trailing.len() - 5) as u32;
    trailing[5..9].copy_from_slice(&compressed_size.to_le_bytes());
    assert!(matches!(
        err(&trailing),
        G00ContentValidationError::UnconsumedPayload { .. }
    ));
}

/// Build a minimal but format-faithful type-2 container + file for a
/// `w`×`h` canvas with one full-canvas region whose sub-bitmap pixels
/// are `bgra`.
pub(super) fn synth_type2(w: u16, h: u16, bgra: &[u8]) -> Vec<u8> {
    let wh4 = w as usize * h as usize * 4;
    assert_eq!(bgra.len(), wh4);
    // Container: [u32 region_deal2=1][u32 offset=12][u32 length]
    //            [0x74 header][0x5c subheader][w*h*4 pixels]
    let offset = 12usize;
    let block_len = 0x74 + 0x5c + wh4;
    let length = block_len;
    let mut unc = Vec::new();
    unc.extend_from_slice(&1u32.to_le_bytes()); // region_deal2
    unc.extend_from_slice(&(offset as u32).to_le_bytes()); // offset@4
    unc.extend_from_slice(&(length as u32).to_le_bytes()); // length@8
    assert_eq!(unc.len(), offset);
    unc.extend_from_slice(&[0u8; 0x74]); // region block header
    let mut sub = vec![0u8; 0x5c];
    sub[0..2].copy_from_slice(&0u16.to_le_bytes()); // x
    sub[2..4].copy_from_slice(&0u16.to_le_bytes()); // y
    sub[6..8].copy_from_slice(&w.to_le_bytes()); // w
    sub[8..10].copy_from_slice(&h.to_le_bytes()); // h
    unc.extend_from_slice(&sub);
    unc.extend_from_slice(bgra);
    let uncompressed_size = unc.len();

    let lzss = encode_all_literals(&unc, LzssVariant::Scn2k);
    let mut bytes = vec![G00_TYPE_REGIONED_LZSS];
    bytes.extend_from_slice(&w.to_le_bytes());
    bytes.extend_from_slice(&h.to_le_bytes());
    bytes.extend_from_slice(&1u32.to_le_bytes()); // region_count
    // region record: x1,y1,x2,y2,origin_x,origin_y
    bytes.extend_from_slice(&0i32.to_le_bytes());
    bytes.extend_from_slice(&0i32.to_le_bytes());
    bytes.extend_from_slice(&((w as i32) - 1).to_le_bytes());
    bytes.extend_from_slice(&((h as i32) - 1).to_le_bytes());
    bytes.extend_from_slice(&0i32.to_le_bytes());
    bytes.extend_from_slice(&0i32.to_le_bytes());
    bytes.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes());
    bytes.extend_from_slice(&(uncompressed_size as u32).to_le_bytes());
    bytes.extend_from_slice(&lzss);
    bytes
}

/// Like [`synth_type2`] but with a caller-chosen region rectangle and
/// sub-bitmap top-left, so a test can drive out-of-range coordinates
/// through the region-blit arithmetic (`dst = sub_xy + region.rect`).
pub(super) fn synth_type2_region(
    w: u16,
    h: u16,
    bgra: &[u8],
    rect: (i32, i32, i32, i32),
    sub_xy: (u16, u16),
) -> Vec<u8> {
    let wh4 = w as usize * h as usize * 4;
    assert_eq!(bgra.len(), wh4);
    let offset = 12usize;
    let block_len = 0x74 + 0x5c + wh4;
    let length = block_len;
    let mut unc = Vec::new();
    unc.extend_from_slice(&1u32.to_le_bytes()); // region_deal2
    unc.extend_from_slice(&(offset as u32).to_le_bytes()); // offset@4
    unc.extend_from_slice(&(length as u32).to_le_bytes()); // length@8
    unc.extend_from_slice(&[0u8; 0x74]); // region block header
    let mut sub = vec![0u8; 0x5c];
    sub[0..2].copy_from_slice(&sub_xy.0.to_le_bytes()); // sub x (bx)
    sub[2..4].copy_from_slice(&sub_xy.1.to_le_bytes()); // sub y (by)
    sub[6..8].copy_from_slice(&w.to_le_bytes()); // w
    sub[8..10].copy_from_slice(&h.to_le_bytes()); // h
    unc.extend_from_slice(&sub);
    unc.extend_from_slice(bgra);
    let uncompressed_size = unc.len();

    let lzss = encode_all_literals(&unc, LzssVariant::Scn2k);
    let mut bytes = vec![G00_TYPE_REGIONED_LZSS];
    bytes.extend_from_slice(&w.to_le_bytes());
    bytes.extend_from_slice(&h.to_le_bytes());
    bytes.extend_from_slice(&1u32.to_le_bytes()); // region_count
    bytes.extend_from_slice(&rect.0.to_le_bytes()); // x1
    bytes.extend_from_slice(&rect.1.to_le_bytes()); // y1
    bytes.extend_from_slice(&rect.2.to_le_bytes()); // x2
    bytes.extend_from_slice(&rect.3.to_le_bytes()); // y2
    bytes.extend_from_slice(&0i32.to_le_bytes()); // origin_x
    bytes.extend_from_slice(&0i32.to_le_bytes()); // origin_y
    bytes.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes());
    bytes.extend_from_slice(&(uncompressed_size as u32).to_le_bytes());
    bytes.extend_from_slice(&lzss);
    bytes
}

/// Build a type-2 container carrying TWO identical full-canvas region
/// records whose rect `y1 == y2 == region_y`, exercising the
/// "overlaid image" band-offset accumulation (`region.rect.y1 += dy`).
pub(super) fn synth_type2_two_identical_regions(w: u16, h: u16, region_y: i32) -> Vec<u8> {
    let wh4 = w as usize * h as usize * 4;
    let bgra = vec![0u8; wh4]; // transparent sub-bitmaps
    let block = || {
        let mut b = Vec::new();
        b.extend_from_slice(&[0u8; 0x74]); // block header
        let mut sub = vec![0u8; 0x5c];
        sub[6..8].copy_from_slice(&w.to_le_bytes());
        sub[8..10].copy_from_slice(&h.to_le_bytes());
        b.extend_from_slice(&sub);
        b.extend_from_slice(&bgra);
        b
    };
    let b0 = block();
    let b1 = block();
    let table_len = 4 + 8 * 2; // region_deal2 + two (offset,length) pairs
    let off0 = table_len;
    let off1 = off0 + b0.len();
    let mut unc = Vec::new();
    unc.extend_from_slice(&2u32.to_le_bytes()); // region_deal2
    unc.extend_from_slice(&(off0 as u32).to_le_bytes());
    unc.extend_from_slice(&(b0.len() as u32).to_le_bytes());
    unc.extend_from_slice(&(off1 as u32).to_le_bytes());
    unc.extend_from_slice(&(b1.len() as u32).to_le_bytes());
    unc.extend_from_slice(&b0);
    unc.extend_from_slice(&b1);
    let uncompressed_size = unc.len();

    let lzss = encode_all_literals(&unc, LzssVariant::Scn2k);
    let mut bytes = vec![G00_TYPE_REGIONED_LZSS];
    bytes.extend_from_slice(&w.to_le_bytes());
    bytes.extend_from_slice(&h.to_le_bytes());
    bytes.extend_from_slice(&2u32.to_le_bytes()); // region_count
    for _ in 0..2 {
        bytes.extend_from_slice(&0i32.to_le_bytes()); // x1
        bytes.extend_from_slice(&region_y.to_le_bytes()); // y1
        bytes.extend_from_slice(&((w as i32) - 1).to_le_bytes()); // x2
        bytes.extend_from_slice(&region_y.to_le_bytes()); // y2 == y1 (height 1)
        bytes.extend_from_slice(&0i32.to_le_bytes()); // origin_x
        bytes.extend_from_slice(&0i32.to_le_bytes()); // origin_y
    }
    bytes.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes());
    bytes.extend_from_slice(&(uncompressed_size as u32).to_le_bytes());
    bytes.extend_from_slice(&lzss);
    bytes
}
