//! UTSUSHI-214 — sanity check that our deterministic PNG encoder
//! produces a stream a known PNG/zlib reader can parse. The Rust-only
//! tests in `tests/graphics_object_stack.rs` and the in-module
//! `crate::render_pipeline::tests` cover the determinism contract; this
//! file cross-checks against the standard PNG layout by walking the
//! chunks and re-deriving CRC32s without trusting the encoder.

use utsushi_reallive::{
    Framebuffer, PNG_FILE_MAGIC, RGBA_BYTES_PER_PIXEL, WipeColour, adler32, crc32_ieee,
    encode_png_rgba_deterministic,
};

#[test]
fn deterministic_png_structure_round_trips_through_an_independent_parser() {
    let mut fb = Framebuffer::new(3, 2);
    fb.fill(WipeColour::opaque_rgb(0x12, 0x34, 0x56));
    let bytes = encode_png_rgba_deterministic(&fb);

    // Magic.
    assert_eq!(&bytes[..8], &PNG_FILE_MAGIC);

    let mut cursor = 8usize;
    let mut seen_chunks: Vec<String> = Vec::new();
    let mut idat_payload: Vec<u8> = Vec::new();
    let mut ihdr_payload: Vec<u8> = Vec::new();
    while cursor < bytes.len() {
        assert!(
            cursor + 8 <= bytes.len(),
            "incomplete chunk header at offset {cursor}"
        );
        let length = u32::from_be_bytes(bytes[cursor..cursor + 4].try_into().unwrap()) as usize;
        let chunk_type: [u8; 4] = bytes[cursor + 4..cursor + 8].try_into().unwrap();
        let payload = &bytes[cursor + 8..cursor + 8 + length];
        let declared_crc = u32::from_be_bytes(
            bytes[cursor + 8 + length..cursor + 12 + length]
                .try_into()
                .unwrap(),
        );

        // Independently re-derive CRC over (chunk_type || payload).
        let mut crc_input = Vec::with_capacity(4 + payload.len());
        crc_input.extend_from_slice(&chunk_type);
        crc_input.extend_from_slice(payload);
        assert_eq!(
            declared_crc,
            crc32_ieee(&crc_input),
            "chunk CRC mismatch for {}",
            String::from_utf8_lossy(&chunk_type)
        );
        let name = String::from_utf8_lossy(&chunk_type).to_string();
        if name == "IHDR" {
            ihdr_payload = payload.to_vec();
        }
        if name == "IDAT" {
            idat_payload.extend_from_slice(payload);
        }
        seen_chunks.push(name);
        cursor += 12 + length;
    }
    assert_eq!(cursor, bytes.len(), "trailing bytes after last chunk");
    assert_eq!(
        seen_chunks,
        vec!["IHDR".to_string(), "IDAT".to_string(), "IEND".to_string()]
    );

    // IHDR independent decode.
    assert_eq!(ihdr_payload.len(), 13);
    let width = u32::from_be_bytes(ihdr_payload[0..4].try_into().unwrap());
    let height = u32::from_be_bytes(ihdr_payload[4..8].try_into().unwrap());
    assert_eq!(width, 3);
    assert_eq!(height, 2);
    assert_eq!(ihdr_payload[8], 8); // bit depth
    assert_eq!(ihdr_payload[9], 6); // colour type RGBA
    assert_eq!(ihdr_payload[10], 0); // compression
    assert_eq!(ihdr_payload[11], 0); // filter
    assert_eq!(ihdr_payload[12], 0); // interlace

    // IDAT zlib stream: 2 byte header + N stored blocks + 4 byte adler32.
    assert_eq!(idat_payload[0], 0x78);
    assert_eq!(idat_payload[1], 0x01);

    // Walk stored blocks and re-derive scanlines.
    let mut scanlines = Vec::new();
    let mut p = 2usize;
    loop {
        let header = idat_payload[p];
        p += 1;
        let len = u16::from_le_bytes(idat_payload[p..p + 2].try_into().unwrap()) as usize;
        let nlen = u16::from_le_bytes(idat_payload[p + 2..p + 4].try_into().unwrap());
        assert_eq!(
            nlen,
            !(len as u16),
            "stored block NLEN is not bitwise-complement of LEN"
        );
        p += 4;
        scanlines.extend_from_slice(&idat_payload[p..p + len]);
        p += len;
        if header & 0x01 == 0x01 {
            break;
        }
    }
    let declared_adler = u32::from_be_bytes(idat_payload[p..p + 4].try_into().unwrap());
    assert_eq!(declared_adler, adler32(&scanlines));

    // Independently reconstruct the scanlines.
    let row_stride = (width as usize) * RGBA_BYTES_PER_PIXEL;
    assert_eq!(scanlines.len(), (height as usize) * (1 + row_stride));
    for row in 0..(height as usize) {
        let row_start = row * (1 + row_stride);
        assert_eq!(scanlines[row_start], 0); // filter byte
        let row_bytes = &scanlines[row_start + 1..row_start + 1 + row_stride];
        for chunk in row_bytes.chunks(4) {
            assert_eq!(chunk, &[0x12, 0x34, 0x56, 0xFF]);
        }
    }
}
