//! Copyright-redaction proof for the screenshot
//! rasterizer, exercised entirely with the FIX-3 **synthetic** g00
//! fixtures (zero retail bytes).
//!
//! The public (`Redact`) frame is PROOF-PRESERVING: an
//! `GraphicsObjectKind::Image` object is composited as a copyright-safe
//! EDGE-OUTLINE of the decoded g00 — the scene's structure/layout stays
//! visible while the art's colour/tone/texture, and every VERBATIM byte
//! run of the decoded pixels, are gone. These tests pin that contract:
//!
//! 1. `redacted_image_is_transformed_structure_not_solid` — a stack that
//!    carries an `Image` object backed by a *decodable* synthetic g00
//!    rasterises, under `Redact`, to a NON-SOLID edge-outline that
//!    DIFFERS from the full-fidelity (`Full`) composite.
//! 2. `emitted_png_embeds_zero_g00_bytes` — the deterministic PNG
//!    emitted through the substrate frame sink contains NONE of the
//!    decoded synthetic g00's pixel bytes, and none of the raw on-disk
//!    g00 file bytes either — so the transformed public frame still
//!    republishes no source art.
//!
//! Because the fixture is a *real* decodable g00 (it round-trips
//! through `decode_g00` with a genuine BGRA canvas), the assertions are
//! not tautological: the bytes that WOULD leak if the redaction re-blit
//! the art are concrete and checked for absence.

#[path = "support/g00_synthetic.rs"]
mod g00_synthetic;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use g00_synthetic::{
    SYNTHETIC_TYPE0_STEM, SYNTHETIC_TYPE2_STEM, synthetic_type0_g00, synthetic_type2_g00,
};
use utsushi_core::RuntimeArtifactRoot;
use utsushi_core::substrate::{
    AssetBytes, AssetId, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule, EvidenceTier,
    PackageDescriptor, PackageKind, PackageSource, VfsError, VfsResult,
};
use utsushi_reallive::{
    G00Image, GraphicsObject, GraphicsObjectStack, GraphicsPlane, PNG_FILE_MAGIC,
    RecordingFrameArtifactSink, RedactionPolicy, RenderPass, TextLayer, WipeColour, decode_g00,
};

/// Minimal in-memory [`AssetPackage`] that serves the synthetic g00
/// fixtures by stem (`g00/<STEM>.g00`) from bytes held in memory — no
/// disk staging needed for the redaction-transform proof.
#[derive(Debug)]
struct InMemoryG00Package {
    entries: Vec<(String, Vec<u8>)>,
}

impl InMemoryG00Package {
    fn stem_of<'a>(&self, id: &'a AssetId) -> &'a str {
        let logical = id.path();
        let stem = logical.strip_prefix("g00/").unwrap_or(logical);
        stem.strip_suffix(".g00").unwrap_or(stem)
    }
    fn bytes_for(&self, stem: &str) -> Option<&[u8]> {
        self.entries
            .iter()
            .find(|(name, _)| name == stem)
            .map(|(_, bytes)| bytes.as_slice())
    }
}

impl AssetPackage for InMemoryG00Package {
    fn id(&self) -> &'static str {
        "redaction-in-memory-g00"
    }
    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: self.id().to_string(),
            kind: PackageKind::Plaintext,
            case_rule: CaseRule::Sensitive,
            source: PackageSource::PublicName(self.id().to_string()),
            revision: None,
        }
    }
    fn case_rule(&self) -> CaseRule {
        CaseRule::Sensitive
    }
    fn resolve(&self, logical: &str) -> VfsResult<AssetId> {
        AssetId::from_parts(self.id(), logical)
    }
    fn exists(&self, id: &AssetId) -> VfsResult<bool> {
        Ok(self.bytes_for(self.stem_of(id)).is_some())
    }
    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        let len = self
            .bytes_for(self.stem_of(id))
            .ok_or_else(|| VfsError::AssetMissing { id: id.clone() })?
            .len();
        Ok(AssetMetadata {
            id: id.clone(),
            kind: AssetKind::File,
            size: AssetSize::Bytes(len as u64),
            revision: None,
        })
    }
    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        let bytes = self
            .bytes_for(self.stem_of(id))
            .ok_or_else(|| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetBytes::from(bytes.to_vec()))
    }
    fn list(&self, _prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        Ok(Vec::new())
    }
}

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
fn redacted_image_is_transformed_structure_not_solid() {
    // Stage the decodable synthetic type-0 fixture and build a stack with
    // ONLY that Image object. Rasterise it under BOTH policies. The
    // `Redact` frame must be a proof-preserving edge-outline: it carries
    // structure (NOT a single solid colour), and it DIFFERS from the
    // `Full` composite (the redaction transform genuinely ran instead of
    // re-blitting the art).
    let assets: Arc<dyn AssetPackage> = Arc::new(InMemoryG00Package {
        entries: vec![(SYNTHETIC_TYPE0_STEM.to_string(), synthetic_type0_g00())],
    });
    let pass = RenderPass::with_dimensions(8, 8)
        .expect("non-zero screen")
        .with_assets(assets);
    let mut stack = GraphicsObjectStack::new();
    stack
        .set(
            GraphicsPlane::Background,
            0,
            GraphicsObject::image(SYNTHETIC_TYPE0_STEM),
        )
        .expect("set image");

    let redacted = pass.rasterise_with_policy(&stack, RedactionPolicy::Redact);
    let full = pass.rasterise_with_policy(&stack, RedactionPolicy::Full);

    // Something was painted (the object WAS dereferenced and redacted).
    assert!(
        redacted.pixels().iter().any(|&b| b != 0),
        "redacted image object must paint its edge-outline (not stay blank)"
    );
    // Not a single solid colour — the edge-outline carries structure.
    let distinct: std::collections::BTreeSet<[u8; 4]> = redacted
        .pixels()
        .chunks(4)
        .map(|c| [c[0], c[1], c[2], c[3]])
        .collect();
    assert!(
        distinct.len() >= 2,
        "redacted frame must not be a single solid colour; got {} distinct",
        distinct.len()
    );
    // The redaction is a TRANSFORM, not a copy of the art.
    assert_ne!(
        redacted.pixels(),
        full.pixels(),
        "redacted frame must differ from the full-fidelity composite"
    );
}

#[test]
fn object_position_coordinate_overflow_is_skipped_not_panicking() {
    // genaudit3 blit-coordinate-overflow hardening: `object.position`
    // comes from VM state and can be arbitrary. Two image objects are
    // placed at near-`i32::MAX` positions — one overflowing the X axis
    // (`object.position.x + dx`), one the Y axis (`object.position.y
    // dy`). Under the OLD unchecked adds these OVERFLOW i32 (a panic under
    // debug `overflow-checks`, a wraparound into a wrong/out-of-bounds
    // pixel under release). Saturating arithmetic clamps the destination
    // outside the framebuffer, so the corrupt objects contribute NOTHING
    // and an in-range object still renders EXACTLY as it would alone.
    let assets: Arc<dyn AssetPackage> = Arc::new(InMemoryG00Package {
        entries: vec![(SYNTHETIC_TYPE0_STEM.to_string(), synthetic_type0_g00())],
    });
    let pass = RenderPass::with_dimensions(16, 16)
        .expect("non-zero screen")
        .with_assets(assets);

    // Baseline: ONLY the in-range object at the origin.
    let mut baseline = GraphicsObjectStack::new();
    baseline
        .set(
            GraphicsPlane::Background,
            0,
            GraphicsObject::image(SYNTHETIC_TYPE0_STEM),
        )
        .expect("set in-range image");
    let baseline_frame = pass.rasterise_with_policy(&baseline, RedactionPolicy::Full);
    assert!(
        baseline_frame.pixels().iter().any(|&b| b != 0),
        "in-range object must paint (otherwise the test is vacuous)"
    );

    // Same in-range object PLUS two objects whose VM positions overflow.
    let mut stack = GraphicsObjectStack::new();
    stack
        .set(
            GraphicsPlane::Background,
            0,
            GraphicsObject::image(SYNTHETIC_TYPE0_STEM),
        )
        .expect("set in-range image");
    let mut overflow_x = GraphicsObject::image(SYNTHETIC_TYPE0_STEM);
    overflow_x.position.x = i32::MAX; // `position.x + dx` overflows
    overflow_x.position.y = 0; // row stays in-bounds so the X loop runs
    stack
        .set(GraphicsPlane::Foreground, 0, overflow_x)
        .expect("set x-overflow image");
    let mut overflow_y = GraphicsObject::image(SYNTHETIC_TYPE0_STEM);
    overflow_y.position.x = 0;
    overflow_y.position.y = i32::MAX; // `position.y + dy` overflows
    stack
        .set(GraphicsPlane::Foreground, 1, overflow_y)
        .expect("set y-overflow image");

    // Must NOT panic, and the out-of-range objects contribute nothing:
    // the frame is byte-identical to the in-range-only baseline.
    let frame = pass.rasterise_with_policy(&stack, RedactionPolicy::Full);
    assert_eq!(
        frame.pixels(),
        baseline_frame.pixels(),
        "out-of-range object positions must be skipped, not alter the render"
    );
}

#[test]
fn emitted_png_embeds_zero_g00_bytes() {
    // Bind an AssetPackage that serves both decodable fixtures, build a
    // render stack whose background is a synthetic Wipe + Image objects
    // referencing them, and emit the DEFAULT (redacted) screenshot with a
    // localized English text layer. The redaction now GENUINELY reads and
    // transforms the g00 (an edge-outline) — so the copyright proof is
    // stronger than the old no-deref no-op: the emitted PNG must embed
    // NONE of the decoded g00 pixel bytes even though the pass dereferenced
    // and processed them.
    let type0_raw = synthetic_type0_g00();
    let type2_raw = synthetic_type2_g00();
    let (type0_decoded, _) = decode_g00(&type0_raw).expect("type0 decodes");
    let (type2_decoded, _) = decode_g00(&type2_raw).expect("type2 decodes");

    let assets: Arc<dyn AssetPackage> = Arc::new(InMemoryG00Package {
        entries: vec![
            (SYNTHETIC_TYPE0_STEM.to_string(), type0_raw.clone()),
            (SYNTHETIC_TYPE2_STEM.to_string(), type2_raw.clone()),
        ],
    });

    let mut stack = GraphicsObjectStack::new();
    stack
        .set(
            GraphicsPlane::Background,
            0,
            GraphicsObject::wipe(WipeColour::opaque_rgb(0x08, 0x10, 0x18)),
        )
        .expect("set wipe");
    // Two Image objects that genuinely reference the decodable fixtures;
    // the redaction dereferences and edge-outlines them.
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

    let text = TextLayer::localized(vec!["Scene 1 EN-US".to_string()]);
    let mut pass = RenderPass::with_dimensions(128, 48)
        .expect("non-zero screen")
        .with_assets(assets);
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

    let _ = std::fs::remove_dir_all(root.path());
}
