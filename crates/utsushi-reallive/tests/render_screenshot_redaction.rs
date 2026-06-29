//! ALPHA-006b — copyright-redaction proof for the screenshot
//! rasterizer, exercised entirely with the FIX-3 **synthetic** g00
//! fixtures (zero retail bytes).
//!
//! The render pass paints only our synthetic `Wipe` fills and the
//! localized `TextLayer`; `GraphicsObjectKind::Image` objects are
//! recorded but NEVER dereferenced into the framebuffer. These tests
//! pin that contract structurally:
//!
//! 1. `image_object_is_not_dereferenced_into_framebuffer` — a stack that
//!    carries an `Image` object backed by a *decodable* synthetic g00
//!    rasterises to zero painted pixels for that object.
//! 2. `emitted_png_embeds_zero_g00_bytes` — the deterministic PNG
//!    emitted through the substrate frame sink contains NONE of the
//!    decoded synthetic g00's pixel bytes, and none of the raw on-disk
//!    g00 file bytes either.
//!
//! Because the fixture is a *real* decodable g00 (it round-trips
//! through `decode_g00` with a genuine BGRA canvas), the no-op assertion
//! is not tautological: the bytes that WOULD leak if the Image branch
//! dereferenced the asset are concrete and checked for absence.

#[path = "support/g00_synthetic.rs"]
mod g00_synthetic;

use std::sync::atomic::{AtomicU64, Ordering};

use g00_synthetic::{
    SYNTHETIC_TYPE0_STEM, SYNTHETIC_TYPE2_STEM, synthetic_type0_g00, synthetic_type2_g00,
    write_synthetic_g00_dir,
};
use utsushi_core::RuntimeArtifactRoot;
use utsushi_core::substrate::EvidenceTier;
use utsushi_reallive::{
    G00Image, GraphicsObject, GraphicsObjectStack, GraphicsPlane, PNG_FILE_MAGIC,
    RecordingFrameArtifactSink, RenderPass, TextLayer, WipeColour, decode_g00,
};

fn temp_artifact_root(tag: &str) -> RuntimeArtifactRoot {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "utsushi-redaction-{tag}-{}-{nonce}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let root = RuntimeArtifactRoot::new(&dir);
    root.prepare().expect("prepare managed artifact root");
    root
}

/// Distinct, non-overlapping byte windows of length `needle.len()` —
/// returns true if `haystack` contains `needle` verbatim.
fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[test]
fn synthetic_fixture_actually_decodes_so_the_redaction_proof_is_not_vacuous() {
    // If the fixture did not decode, "the PNG embeds no g00 pixels"
    // would be vacuously true. Pin that the FIX-3 fixtures are genuine
    // decodable g00 with a non-empty BGRA->RGBA canvas.
    for bytes in [synthetic_type0_g00(), synthetic_type2_g00()] {
        let (image, warnings): (G00Image, _) = decode_g00(&bytes).expect("synthetic g00 decodes");
        assert!(warnings.is_empty(), "fixture decodes with zero warnings");
        assert!(
            !image.pixels_rgba.is_empty(),
            "decoded fixture must carry real pixels"
        );
    }
}

#[test]
fn image_object_is_not_dereferenced_into_framebuffer() {
    // Build a stack with ONLY an Image object backed by the synthetic
    // type-0 fixture's stem. The render pass must paint zero pixels for
    // it (the framebuffer stays at the transparent initial pattern).
    let pass = RenderPass::with_dimensions(8, 8).expect("non-zero screen");
    let mut stack = GraphicsObjectStack::new();
    stack
        .set(
            GraphicsPlane::Background,
            0,
            GraphicsObject::image(SYNTHETIC_TYPE0_STEM),
        )
        .expect("set image");
    let fb = pass.rasterise(&stack);
    assert!(
        fb.pixels().iter().all(|&byte| byte == 0),
        "Image object must NOT be dereferenced into the framebuffer"
    );
}

#[test]
fn emitted_png_embeds_zero_g00_bytes() {
    // Stage both synthetic fixtures on disk (as an AssetPackage would
    // see them), decode them in-memory, and build a render stack whose
    // background is a synthetic Wipe + an Image object referencing the
    // staged fixture. Emit the screenshot with a localized English text
    // layer and assert the PNG embeds NONE of the g00 bytes.
    let staging = temp_artifact_root("g00-staging-dir");
    let g00_dir = staging.path().join("g00");
    let (type0_path, type2_path) =
        write_synthetic_g00_dir(&g00_dir).expect("stage synthetic g00 fixtures");

    let type0_raw = synthetic_type0_g00();
    let type2_raw = synthetic_type2_g00();
    let (type0_decoded, _) = decode_g00(&type0_raw).expect("type0 decodes");
    let (type2_decoded, _) = decode_g00(&type2_raw).expect("type2 decodes");

    // Sanity: the staged on-disk bytes match what we decode in-memory.
    assert_eq!(std::fs::read(&type0_path).unwrap(), type0_raw);
    assert_eq!(std::fs::read(&type2_path).unwrap(), type2_raw);

    let mut stack = GraphicsObjectStack::new();
    stack
        .set(
            GraphicsPlane::Background,
            0,
            GraphicsObject::wipe(WipeColour::opaque_rgb(0x08, 0x10, 0x18)),
        )
        .expect("set wipe");
    // Two Image objects that genuinely reference the decodable
    // fixtures; the render pass must keep them no-ops.
    stack
        .set(
            GraphicsPlane::Foreground,
            0,
            GraphicsObject::image(SYNTHETIC_TYPE0_STEM),
        )
        .expect("set type0 image");
    stack
        .set(
            GraphicsPlane::Foreground,
            1,
            GraphicsObject::image(SYNTHETIC_TYPE2_STEM),
        )
        .expect("set type2 image");

    let text = TextLayer::localized(vec!["SCENE 1 EN-US".to_string()]);
    let mut pass = RenderPass::with_dimensions(128, 48).expect("non-zero screen");
    let root = temp_artifact_root("g00-redaction");
    let sink = RecordingFrameArtifactSink::new();
    let artifact = pass
        .emit_localized_screenshot(&stack, &text, &root, "redaction", &sink)
        .expect("emit screenshot");

    // Announced through the substrate frame sink at E2.
    assert_eq!(artifact.evidence_tier, EvidenceTier::E2);
    assert_eq!(sink.len(), 1);

    // Read the real hashable PNG file back from disk.
    let png = std::fs::read(
        root.artifact_path(&artifact.artifact_ref.uri)
            .expect("path"),
    )
    .expect("png on disk");
    assert_eq!(&png[..8], &PNG_FILE_MAGIC);

    // ---- ZERO-G00-BYTES REDACTION ASSERTION ----
    // None of the decoded g00 RGBA pixel bytes appear in the PNG.
    assert!(
        !contains_subslice(&png, &type0_decoded.pixels_rgba),
        "type-0 decoded g00 pixels MUST NOT appear in the emitted PNG"
    );
    assert!(
        !contains_subslice(&png, &type2_decoded.pixels_rgba),
        "type-2 decoded g00 pixels MUST NOT appear in the emitted PNG"
    );
    // Nor do the raw on-disk g00 file bytes (the LZSS-compressed form).
    assert!(
        !contains_subslice(&png, &type0_raw),
        "raw type-0 g00 file bytes MUST NOT appear in the emitted PNG"
    );
    assert!(
        !contains_subslice(&png, &type2_raw),
        "raw type-2 g00 file bytes MUST NOT appear in the emitted PNG"
    );

    let _ = std::fs::remove_dir_all(staging.path());
    let _ = std::fs::remove_dir_all(root.path());
}
