//! FIX-3 — decode proof + 006b-consumability for the structurally-faithful
//! synthetic g00 fixtures authored in `tests/support/g00_synthetic.rs`.
//!
//! These tests are **not** env-gated: they run in the default
//! `cargo test -p utsushi-reallive` pass (unlike the retail
//! `g00_real_bytes.rs` corpus tests). They prove the synthetic
//! fixtures decode through the real `decode_g00` type-0 and type-2
//! paths — with the real header/region structure and **zero**
//! structural-path warnings — so ALPHA-006b can pin the
//! `GraphicsObjectKind::Image` render no-op without any retail asset.
//!
//! The proof is non-tautological: it decodes through the production
//! `decode_g00` entry point (not a test-local re-implementation), and
//! it asserts the BGRA->RGBA reorder fired and the LZSS back-reference
//! reproduced the trailing pixel — so an unrealistic fixture (wrong
//! header shape, wrong framing) would fail here, not pass silently.

#[path = "support/g00_synthetic.rs"]
mod g00_synthetic;

use g00_synthetic::{
    SYNTHETIC_TYPE0_HEIGHT, SYNTHETIC_TYPE0_STEM, SYNTHETIC_TYPE0_WIDTH, SYNTHETIC_TYPE2_HEIGHT,
    SYNTHETIC_TYPE2_REGION_COUNT, SYNTHETIC_TYPE2_STEM, SYNTHETIC_TYPE2_WIDTH, synthetic_type0_g00,
    synthetic_type2_g00, write_synthetic_g00_dir,
};
use utsushi_reallive::{
    G00Type, G00Warning, GraphicsObject, GraphicsObjectKind, ImageRef, decode_g00,
};

/// Retail Sweetie HD canvas dimensions, pinned here purely so the
/// synthetic fixtures can assert they are NOT those dimensions. These
/// are public header byte-counts (not pixel data); referencing them
/// numerically is explicitly permitted by the FIX-3 non-copyright rule.
const RETAIL_BACK_WIDTH: u32 = 1280;
const RETAIL_BACK_HEIGHT: u32 = 720;
const RETAIL_BTN000_WIDTH: u32 = 360;
const RETAIL_BTN000_HEIGHT: u32 = 54;

/// The authored first pixel on disk is BGR = (0x11, 0x22, 0x33); after
/// the BGR->RGBA reorder the decoded pixel must be
/// (R=0x33, G=0x22, B=0x11, A=0xff).
const EXPECTED_FIRST_PIXEL_RGBA: [u8; 4] = [0x33, 0x22, 0x11, 0xff];

#[test]
fn synthetic_type0_decodes_with_real_structure_zero_warnings() {
    let bytes = synthetic_type0_g00();
    let (image, warnings) =
        decode_g00(&bytes).expect("synthetic type-0 fixture must decode through decode_g00");

    assert_eq!(image.g00_type, G00Type::RawBgr);
    assert_eq!(image.width, SYNTHETIC_TYPE0_WIDTH as u32);
    assert_eq!(image.height, SYNTHETIC_TYPE0_HEIGHT as u32);
    let expected_len = (SYNTHETIC_TYPE0_WIDTH as usize) * (SYNTHETIC_TYPE0_HEIGHT as usize) * 4;
    assert_eq!(
        image.pixels_rgba.len(),
        expected_len,
        "type-0 pixel buffer must be width*height*4",
    );
    assert!(
        image.regions.is_empty(),
        "type-0 image carries no region table",
    );

    // The core acceptance: zero structural-path warnings. A
    // PayloadLengthMismatch here would mean the LZSS framing or the
    // declared uncompressed_size is wrong.
    assert!(
        warnings.is_empty(),
        "synthetic type-0 must decode with zero warnings; got: {warnings:?}",
    );

    // BGRA->RGBA reorder fired (audit-focus: BGR-as-RGB).
    assert_eq!(
        &image.pixels_rgba[..4],
        &EXPECTED_FIRST_PIXEL_RGBA,
        "first decoded pixel must be RGBA-reordered, not raw BGRA",
    );
    // The trailing LZSS back-reference reproduced the first pixel as
    // the last pixel: proves genuine back-reference framing decoded.
    assert_eq!(
        &image.pixels_rgba[expected_len - 4..],
        &EXPECTED_FIRST_PIXEL_RGBA,
        "trailing pixel must equal the first pixel via the LZSS back-reference",
    );

    // Provenance guard: NOT the retail BACK.g00 dimensions.
    assert!(
        image.width != RETAIL_BACK_WIDTH || image.height != RETAIL_BACK_HEIGHT,
        "synthetic fixture must not share retail BACK.g00 dimensions",
    );
}

#[test]
fn synthetic_type2_decodes_with_real_regions_zero_warnings() {
    let bytes = synthetic_type2_g00();
    let (image, warnings) =
        decode_g00(&bytes).expect("synthetic type-2 fixture must decode through decode_g00");

    assert_eq!(image.g00_type, G00Type::RegionedLzss);
    assert_eq!(image.width, SYNTHETIC_TYPE2_WIDTH as u32);
    assert_eq!(image.height, SYNTHETIC_TYPE2_HEIGHT as u32);

    // Real region-table structure: region_count records, each a
    // non-degenerate inclusive rectangle with no on-disk name.
    assert_eq!(image.regions.len(), SYNTHETIC_TYPE2_REGION_COUNT as usize);
    for (i, region) in image.regions.iter().enumerate() {
        assert_eq!(
            region.rect.width(),
            SYNTHETIC_TYPE2_WIDTH as u32,
            "region {i} inclusive width must equal the canvas width",
        );
        assert_eq!(
            region.rect.height(),
            SYNTHETIC_TYPE2_HEIGHT as u32,
            "region {i} inclusive height must equal the canvas height",
        );
        assert!(region.rect.width() > 0 && region.rect.height() > 0);
        assert_eq!(region.origin_x, 0);
        assert_eq!(region.origin_y, 0);
        assert_eq!(
            region.name, None,
            "on-disk region record carries no name (names land at the opcode layer)",
        );
    }

    assert!(
        warnings.is_empty(),
        "synthetic type-2 must decode with zero warnings; got: {warnings:?}",
    );

    // BGRA->RGBA reorder fired on the type-2 atlas path too.
    assert_eq!(&image.pixels_rgba[..4], &EXPECTED_FIRST_PIXEL_RGBA);

    // Provenance guard: NOT the retail btn000.g00 dimensions.
    assert!(
        image.width != RETAIL_BTN000_WIDTH || image.height != RETAIL_BTN000_HEIGHT,
        "synthetic fixture must not share retail btn000.g00 dimensions",
    );
}

#[test]
fn malformed_short_type2_stream_pads_to_canvas_and_warns_not_silent() {
    // UTSUSHI-216 promoted finding 65c7433f: type-2 decode must pad or
    // truncate the LZSS-decoded payload to exactly `width * height * 4`,
    // symmetric with type-0 — a malformed/short stream must NOT yield a
    // silent wrong-size buffer. Author the malformed input from the
    // FIX-3 synthetic fixture (no retail pixels): take the well-formed
    // type-2 blob and lop off the tail of its LZSS payload so the stream
    // decodes short.
    let mut bytes = synthetic_type2_g00();

    // Header prefix up to and including the 8-byte LZSS preamble:
    // 5-byte g00 preamble + 4-byte region_count + region table
    // (24 bytes/record) + 8-byte (compressed_size, uncompressed_size).
    let header_prefix = 5 + 4 + (SYNTHETIC_TYPE2_REGION_COUNT as usize) * 24 + 8;
    // Keep the full header + only the first 2 payload bytes, dropping the
    // rest of the LZSS stream. The decoder will exhaust its input long
    // before reaching the declared uncompressed_size.
    assert!(
        bytes.len() > header_prefix + 2,
        "synthetic type-2 fixture must carry an LZSS payload to truncate",
    );
    bytes.truncate(header_prefix + 2);

    let (image, warnings) =
        decode_g00(&bytes).expect("malformed-short type-2 must still decode to a sized buffer");

    assert_eq!(image.g00_type, G00Type::RegionedLzss);
    let expected_len = (SYNTHETIC_TYPE2_WIDTH as usize) * (SYNTHETIC_TYPE2_HEIGHT as usize) * 4;
    assert_eq!(
        image.pixels_rgba.len(),
        expected_len,
        "a short type-2 stream must be padded to exactly width*height*4 \
         (deterministic), not left as a silent wrong-size buffer",
    );
    // The buffer is a whole number of RGBA pixels, so the BGRA->RGBA
    // reorder's chunks_exact_mut(4) leaves no unreordered tail.
    assert!(
        image.pixels_rgba.len().is_multiple_of(4),
        "padded buffer must be a whole number of RGBA pixels",
    );

    // The length adjustment is observable: a typed PayloadLengthMismatch
    // warning is surfaced for the truncated stream — not silent.
    assert!(
        warnings.iter().any(|w| matches!(
            w,
            G00Warning::PayloadLengthMismatch {
                g00_type: G00Type::RegionedLzss,
                ..
            }
        )),
        "short type-2 stream must surface a typed PayloadLengthMismatch warning; got: {warnings:?}",
    );
}

#[test]
fn synthetic_fixtures_carry_no_verbatim_retail_pixels() {
    // The fixtures are authored from a tiny deterministic gradient with
    // a trailing back-reference. Their total size is a handful of bytes
    // — orders of magnitude below any retail g00 (retail BACK.g00 is
    // ~690 KB, btn000.g00 ~55 KB) — so a verbatim retail pixel copy is
    // structurally impossible. Pin that explicitly.
    let t0 = synthetic_type0_g00();
    let t2 = synthetic_type2_g00();
    assert!(
        t0.len() < 256 && t2.len() < 1024,
        "synthetic fixtures must be tiny authored blobs, not retail extracts \
         (retail BACK.g00 is ~690 KB, btn000.g00 ~55 KB) \
         (type0={} type2={})",
        t0.len(),
        t2.len(),
    );
    // Lead bytes are the documented type discriminators, not arbitrary.
    assert_eq!(t0[0], 0, "type-0 lead byte");
    assert_eq!(t2[0], 2, "type-2 lead byte");
}

#[test]
fn fixture_is_consumable_as_graphics_object_image_ref() {
    // 006b shape, in-memory: an Image-kind graphics object referencing
    // the synthetic fixture by asset key. This proves the fixture is
    // wireable into the GraphicsObjectKind::Image no-op render path
    // without retail assets — the render pass records the ref, the
    // fixture genuinely decodes.
    let object = GraphicsObject::image(SYNTHETIC_TYPE0_STEM);
    match &object.kind {
        GraphicsObjectKind::Image { image_ref } => {
            assert_eq!(image_ref.asset_key, SYNTHETIC_TYPE0_STEM);
            assert_eq!(image_ref.region_index, None);
        }
        other @ GraphicsObjectKind::Wipe { .. } => {
            panic!("expected Image kind, got {other:?}")
        }
    }

    // A type-2-aware Image ref selecting region index 1 (valid: the
    // fixture carries SYNTHETIC_TYPE2_REGION_COUNT regions). 006b can
    // resolve this against the decoded region list.
    let region_index = SYNTHETIC_TYPE2_REGION_COUNT - 1;
    let ref2 = ImageRef {
        asset_key: SYNTHETIC_TYPE2_STEM.to_string(),
        region_index: Some(region_index),
    };
    let (image, _) = decode_g00(&synthetic_type2_g00()).expect("type-2 must decode");
    assert!(
        (ref2.region_index.unwrap() as usize) < image.regions.len(),
        "the synthetic region_index must address a real decoded region",
    );
}

#[test]
fn fixture_stages_on_disk_and_round_trips_without_retail_assets() {
    // 006b shape, on-disk: stage both fixtures into a temp dir (cargo
    // provides CARGO_TARGET_TMPDIR for integration tests) and decode
    // them back from disk, mirroring how an AssetPackage would resolve
    // g00/<NAME>.g00 — with zero retail bytes on disk.
    let base = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("fix3-synthetic-g00");
    let (type0_path, type2_path) =
        write_synthetic_g00_dir(&base).expect("staging synthetic g00 dir must succeed");

    let t0_disk = std::fs::read(&type0_path).expect("read staged type-0");
    let t2_disk = std::fs::read(&type2_path).expect("read staged type-2");
    assert_eq!(t0_disk, synthetic_type0_g00(), "on-disk type-0 bytes match");
    assert_eq!(t2_disk, synthetic_type2_g00(), "on-disk type-2 bytes match");

    let (img0, w0) = decode_g00(&t0_disk).expect("staged type-0 decodes");
    let (img2, w2) = decode_g00(&t2_disk).expect("staged type-2 decodes");
    assert_eq!(img0.g00_type, G00Type::RawBgr);
    assert_eq!(img2.g00_type, G00Type::RegionedLzss);
    assert!(w0.is_empty() && w2.is_empty(), "staged decodes warn-free");
}
