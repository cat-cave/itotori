use super::*;

/// Synthesise a 44-byte NWA header with the given field values.
/// Used by the unit tests that pin the field-offset / typed-error
/// surface without needing real bytes on disk. The 11-arg arity
/// matches the on-disk field count one-for-one; a struct wrapper
/// would add a layer of indirection the tests would have to read
/// past.
// reason: test-only synthetic NWA header builder; each argument is a distinct header field the tests set explicitly.
#[allow(clippy::too_many_arguments)]
fn synth_header(
    channels: u16,
    bps: u16,
    sample_rate: u32,
    compression_mode: i32,
    use_runlength: u32,
    block_count: u32,
    uncompressed_byte_size: u32,
    compressed_data_size: u32,
    total_sample_count: u32,
    samples_per_block: u32,
    last_block_sample_count: u32,
) -> Vec<u8> {
    let mut bytes = vec![0u8; NWA_HEADER_BYTE_LEN];
    bytes[0x00..0x02].copy_from_slice(&channels.to_le_bytes());
    bytes[0x02..0x04].copy_from_slice(&bps.to_le_bytes());
    bytes[0x04..0x08].copy_from_slice(&sample_rate.to_le_bytes());
    bytes[0x08..0x0c].copy_from_slice(&compression_mode.to_le_bytes());
    bytes[0x0c..0x10].copy_from_slice(&use_runlength.to_le_bytes());
    bytes[0x10..0x14].copy_from_slice(&block_count.to_le_bytes());
    bytes[0x14..0x18].copy_from_slice(&uncompressed_byte_size.to_le_bytes());
    bytes[0x18..0x1c].copy_from_slice(&compressed_data_size.to_le_bytes());
    bytes[0x1c..0x20].copy_from_slice(&total_sample_count.to_le_bytes());
    bytes[0x20..0x24].copy_from_slice(&samples_per_block.to_le_bytes());
    bytes[0x24..0x28].copy_from_slice(&last_block_sample_count.to_le_bytes());
    bytes
}

#[test]
fn header_truncated_returns_typed_error() {
    let bytes = vec![0u8; NWA_HEADER_BYTE_LEN - 1];
    let err = decode_nwa_header(&bytes).expect_err("short input rejected");
    match err {
        NwaDecodeError::HeaderTruncated {
            code,
            needed,
            actual,
        } => {
            assert_eq!(code, NWA_HEADER_TRUNCATED_CODE);
            assert_eq!(needed, NWA_HEADER_BYTE_LEN);
            assert_eq!(actual, NWA_HEADER_BYTE_LEN - 1);
        }
        other => panic!("expected HeaderTruncated, got {other:?}"),
    }
}

#[test]
fn zero_channels_returns_typed_error() {
    let bytes = synth_header(0, 16, 44_100, -1, 0, 0, 0, 0, 0, 0, 0);
    let err = decode_nwa_header(&bytes).expect_err("zero channels rejected");
    assert!(matches!(
        err,
        NwaDecodeError::UnsupportedChannels { channels: 0, .. }
    ));
}

#[test]
fn unsupported_bps_returns_typed_error() {
    let bytes = synth_header(2, 24, 44_100, -1, 0, 0, 0, 0, 0, 0, 0);
    let err = decode_nwa_header(&bytes).expect_err("24-bit rejected");
    assert!(matches!(
        err,
        NwaDecodeError::UnsupportedBitsPerSample { bps: 24, .. }
    ));
}

#[test]
fn out_of_profile_compression_returns_typed_error() {
    let bytes = synth_header(2, 16, 44_100, 99, 0, 0, 0, 0, 0, 0, 0);
    let err = decode_nwa_header(&bytes).expect_err("mode 99 rejected");
    assert!(matches!(
        err,
        NwaDecodeError::OutOfProfileCompression { mode: 99, .. }
    ));
}

#[test]
fn raw_pcm_round_trips_typed_fields() {
    let bytes = synth_header(2, 16, 44_100, -1, 0, 0, 1024, 1024, 512, 0, 0);
    let header = decode_nwa_header(&bytes).expect("decode");
    assert_eq!(header.channels, 2);
    assert_eq!(header.bits_per_sample, 16);
    assert_eq!(header.sample_rate, 44_100);
    assert_eq!(header.compression_mode, NwaCompressionMode::RawPcm);
    assert_eq!(header.total_sample_count, 512);
}

#[test]
fn compressed_level0_round_trips_typed_fields() {
    let bytes = synth_header(2, 16, 44_100, 0, 0, 4, 65_536, 4_096, 16_384, 4_096, 4_096);
    let header = decode_nwa_header(&bytes).expect("decode");
    assert_eq!(
        header.compression_mode,
        NwaCompressionMode::Compressed { level: 0 }
    );
    assert_eq!(header.block_count, 4);
}

#[test]
fn compression_mode_to_wire_round_trips() {
    for mode in [
        NwaCompressionMode::RawPcm,
        NwaCompressionMode::Compressed { level: 0 },
        NwaCompressionMode::Compressed { level: 5 },
    ] {
        let wire = mode.to_wire();
        let round = NwaCompressionMode::from_wire(wire).expect("round trip");
        assert_eq!(round, mode);
    }
}

#[test]
fn decode_nwa_raw_pcm_has_empty_block_table_and_payload_starts_after_header() {
    let mut bytes = synth_header(2, 16, 44_100, -1, 0, 0, 8, 8, 4, 0, 0);
    bytes.extend_from_slice(&[0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
    let file = decode_nwa(&bytes).expect("decode");
    assert!(file.block_offsets.is_empty());
    assert_eq!(file.payload_start(), NWA_HEADER_BYTE_LEN);
    assert_eq!(
        file.payload(),
        &[0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]
    );
}

#[test]
fn decode_nwa_compressed_decodes_block_table() {
    let mut bytes = synth_header(2, 16, 44_100, 0, 0, 3, 6_144, 4_096, 1_536, 512, 512);
    // Per-block offsets: 0x40, 0x80, 0xC0.
    bytes.extend_from_slice(&0x40u32.to_le_bytes());
    bytes.extend_from_slice(&0x80u32.to_le_bytes());
    bytes.extend_from_slice(&0xC0u32.to_le_bytes());
    bytes.extend_from_slice(&[0xAA, 0xBB, 0xCC]); // pretend payload
    let file = decode_nwa(&bytes).expect("decode");
    assert_eq!(file.block_offsets, vec![0x40, 0x80, 0xC0]);
    assert_eq!(file.payload_start(), NWA_HEADER_BYTE_LEN + 3 * 4);
    assert_eq!(file.payload(), &[0xAA, 0xBB, 0xCC]);
}

#[test]
fn decode_nwa_compressed_with_truncated_block_table_returns_typed_error() {
    let mut bytes = synth_header(2, 16, 44_100, 0, 0, 4, 0, 0, 0, 0, 0);
    // Only 8 bytes of the 16-byte table.
    bytes.extend_from_slice(&[0u8; 8]);
    let err = decode_nwa(&bytes).expect_err("truncated table rejected");
    assert!(matches!(err, NwaDecodeError::HeaderTruncated { .. }));
}

#[test]
fn frames_per_channel_uses_bytes_per_sample_and_channels() {
    let bytes = synth_header(2, 16, 44_100, -1, 0, 0, 16, 16, 8, 0, 0);
    let header = decode_nwa_header(&bytes).expect("decode");
    // 16 uncompressed_byte_size / (2 bytes/sample * 2 channels) = 4
    // frames per channel.
    assert_eq!(header.frames_per_channel(), 4);
}

#[test]
fn audit_focus_raw_pcm_path_does_not_skip_offset_table_when_compression_active() {
    // Audit-focus pin : "Treating NWA as raw
    // bytes (i.e. skipping the offset table)". When the compression
    // mode is `Compressed`, the decoder MUST read the per-block
    // table. We pin the surface by checking the payload-start
    // accessor advances past the table.
    let mut bytes = synth_header(2, 16, 44_100, 0, 0, 2, 0, 0, 0, 0, 0);
    bytes.extend_from_slice(&0x40u32.to_le_bytes());
    bytes.extend_from_slice(&0x80u32.to_le_bytes());
    let file = decode_nwa(&bytes).expect("decode");
    assert_eq!(
        file.payload_start(),
        NWA_HEADER_BYTE_LEN + 2 * std::mem::size_of::<u32>(),
        "compressed mode MUST advance the payload-start cursor past the per-block table",
    );
}
