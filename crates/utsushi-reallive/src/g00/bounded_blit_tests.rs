use super::g00_test_support::encode_all_literals;
use super::*;

#[test]
fn truncated_type2_sub_bitmap_only_visits_available_pixels() {
    let offset = 12usize;
    let block_len = 0x74 + 0x5c + 4;
    let mut decoded = Vec::new();
    decoded.extend_from_slice(&1u32.to_le_bytes());
    decoded.extend_from_slice(&(offset as u32).to_le_bytes());
    decoded.extend_from_slice(&(block_len as u32).to_le_bytes());
    decoded.extend_from_slice(&[0; 0x74]);
    let mut sub_header = [0u8; 0x5c];
    sub_header[6..8].copy_from_slice(&u16::MAX.to_le_bytes());
    sub_header[8..10].copy_from_slice(&u16::MAX.to_le_bytes());
    decoded.extend_from_slice(&sub_header);
    decoded.extend_from_slice(&[0x11, 0x22, 0x33, 0xff]);

    let lzss = encode_all_literals(&decoded, LzssVariant::Scn2k);
    let mut input = vec![G00_TYPE_REGIONED_LZSS, 1, 0, 1, 0];
    input.extend_from_slice(&1u32.to_le_bytes());
    input.extend_from_slice(&0i32.to_le_bytes());
    input.extend_from_slice(&0i32.to_le_bytes());
    input.extend_from_slice(&0i32.to_le_bytes());
    input.extend_from_slice(&0i32.to_le_bytes());
    input.extend_from_slice(&0i32.to_le_bytes());
    input.extend_from_slice(&0i32.to_le_bytes());
    input.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes());
    input.extend_from_slice(&(decoded.len() as u32).to_le_bytes());
    input.extend_from_slice(&lzss);

    let (image, warnings) = decode_g00(&input).expect("type-2 container decodes");
    assert!(warnings.is_empty());
    assert_eq!(image.pixels_rgba, [0x33, 0x22, 0x11, 0xff]);
}
