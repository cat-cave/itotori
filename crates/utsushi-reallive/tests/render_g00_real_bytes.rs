//! Real-bytes proof for the RealLive render pass: graphics-object-state
//! application (Node `utsushi-graphics-object-state-applied`) and real
//! g00 rasterisation + emit-boundary redaction (Node
//! `reallive-render-rasterize-g00-real`).
//!
//! These tests decode REAL g00 art from a staged RealLive corpus and
//! composite it through [`RenderPass`], then assert PIXEL-CATEGORY
//! INVARIANTS only — never an embedded/committed real-art pixel value.
//! They are `#[ignore]`-gated and env-driven, following the crate's
//! real-bytes convention:
//!
//! - `ITOTORI_REAL_GAME_ROOT`   — title 1 (Sweetie HD).
//! - `ITOTORI_REAL_GAME_ROOT_2` — title 2 (Kanon).
//!
//! The full-fidelity (real-art) frame is written ONLY to a private,
//! uncommitted path under the repo's gitignored `/.private-render/`
//! directory (which lives under `/scratch`); the public frame is
//! redacted by default. No test embeds or asserts a real-art pixel
//! value.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use utsushi_core::RuntimeArtifactRoot;
use utsushi_core::substrate::{
    AssetBytes, AssetId, AssetKind, AssetMetadata, AssetPackage, AssetSize, CaseRule,
    PackageDescriptor, PackageKind, PackageSource, VfsError, VfsResult,
};
use utsushi_reallive::{
    G00Image, G00Type, GraphicsAlpha, GraphicsColourTone, GraphicsObject, GraphicsObjectStack,
    GraphicsPlane, GraphicsScale, PNG_FILE_MAGIC, RecordingFrameArtifactSink, RedactionPolicy,
    RenderPass, SceneEmit, SkipReason, TextLayer, WipeColour, decode_g00, sha256_hex,
};

// ---- on-disk g00 asset package --------------------------------------

/// Minimal [`AssetPackage`] that resolves `g00/<NAME>.g00` against a
/// real on-disk g00 directory (no whole-tree indexing). Case-sensitive:
/// the caller supplies the on-disk stem verbatim.
#[derive(Debug)]
struct OnDiskG00Package {
    g00_dir: PathBuf,
}

impl OnDiskG00Package {
    fn new(g00_dir: PathBuf) -> Self {
        Self { g00_dir }
    }
}

impl AssetPackage for OnDiskG00Package {
    fn id(&self) -> &'static str {
        "render-g00-on-disk"
    }

    fn descriptor(&self) -> PackageDescriptor {
        PackageDescriptor {
            id: "render-g00-on-disk".to_string(),
            kind: PackageKind::Plaintext,
            case_rule: CaseRule::Sensitive,
            source: PackageSource::PublicName("render-g00-on-disk".to_string()),
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
        Ok(self.g00_dir.join(strip_g00_prefix(id.path())).exists())
    }

    fn stat(&self, id: &AssetId) -> VfsResult<AssetMetadata> {
        let path = self.g00_dir.join(strip_g00_prefix(id.path()));
        let meta = fs::metadata(&path).map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetMetadata {
            id: id.clone(),
            kind: AssetKind::File,
            size: AssetSize::Bytes(meta.len()),
            revision: None,
        })
    }

    fn open(&self, id: &AssetId) -> VfsResult<AssetBytes> {
        let path = self.g00_dir.join(strip_g00_prefix(id.path()));
        let bytes = fs::read(&path).map_err(|_| VfsError::AssetMissing { id: id.clone() })?;
        Ok(AssetBytes::from(bytes))
    }

    fn list(&self, _prefix: &AssetId) -> VfsResult<Vec<AssetId>> {
        Ok(Vec::new())
    }
}

fn strip_g00_prefix(logical: &str) -> &str {
    logical.strip_prefix("g00/").unwrap_or(logical)
}

// ---- corpus helpers -------------------------------------------------

/// Scan `g00_dir` for the first type-0 (`RawBgr`) g00 file whose bytes
/// decode cleanly into a canvas with genuine pixel variance (so the
/// downstream "not all fill" / "differs" invariants are non-vacuous).
/// Returns `(on-disk stem without extension, decoded image)`.
fn pick_varied_type0_g00(g00_dir: &Path) -> Option<(String, G00Image)> {
    let mut entries: Vec<PathBuf> = fs::read_dir(g00_dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|x| x.to_str())
                .is_some_and(|x| x.eq_ignore_ascii_case("g00"))
        })
        .collect();
    entries.sort();

    for path in entries.iter().take(400) {
        let Ok(bytes) = fs::read(path) else {
            continue;
        };
        if bytes.first().copied() != Some(0) {
            continue; // fast-path: only probe type-0 lead bytes.
        }
        let Ok((image, _warnings)) = decode_g00(&bytes) else {
            continue;
        };
        if image.g00_type != G00Type::RawBgr || image.width == 0 || image.height == 0 {
            continue;
        }
        if !has_pixel_variance(&image.pixels_rgba) {
            continue;
        }
        let stem = path.file_stem().and_then(|s| s.to_str())?.to_string();
        return Some((stem, image));
    }
    None
}

/// A deliberately-malformed, SYNTHETIC type-0 g00 byte buffer that
/// [`decode_g00`] hard-rejects with
/// [`G00DecodeError::MalformedCompressedSize`]. It carries a plausible
/// header — a valid type-0 lead byte and non-zero `width`/`height` — but
/// its LZSS section declares a `compressed_size` of `0`, which is below
/// the mandatory 8-byte section preamble the field is defined to include,
/// so the decoder rejects it as internally inconsistent (rather than
/// clamping to an empty payload and surfacing only a downstream warning).
///
/// No real art is embedded: every byte is authored here. This lets the
/// skip-surface proof exercise the `DecodeFailed` fail-soft path
/// deterministically, decoupled from whether any real corpus g00 happens
/// to be broken.
fn malformed_type0_g00() -> Vec<u8> {
    // 5-byte preamble: type byte 0 (RawBgr) + width=4, height=4 (u16 LE).
    let mut bytes = vec![0u8, 4, 0, 4, 0];
    // LZSS section header: compressed_size (u32 LE) = 0 (< 8, the mandatory
    // preamble length) → MalformedCompressedSize. uncompressed_size = 64
    // (4*4*4) so ONLY the compressed_size field is the offending value.
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&64u32.to_le_bytes());
    // A few trailing bytes so the buffer plausibly carries a payload region.
    bytes.extend_from_slice(&[0xAA, 0xBB, 0xCC, 0xDD]);
    bytes
}

/// Write `bytes` to `<temp>/g00/<stem>.g00` under a unique managed temp
/// directory and return the g00 directory an [`OnDiskG00Package`] resolves
/// against. Used to inject a synthetic malformed g00 into the render seam.
fn temp_g00_dir_with(stem: &str, bytes: &[u8]) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "utsushi-render-g00-synthetic-{}-{nonce}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create synthetic g00 dir");
    fs::write(dir.join(format!("{stem}.g00")), bytes).expect("write malformed synthetic g00");
    dir
}

/// True if the RGBA buffer is not a single uniform colour (some pixel
/// differs from the first).
fn has_pixel_variance(pixels: &[u8]) -> bool {
    if pixels.len() < 8 {
        return false;
    }
    let head = &pixels[..4];
    pixels.chunks_exact(4).any(|px| px != head)
}

/// Private (uncommitted, gitignored) render root under the workspace's
/// `/.private-render/` directory — which lives under `/scratch`.
fn private_render_dir(tag: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
    let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("workspace root two levels above crate manifest");
    workspace_root
        .join(".private-render")
        .join(format!("{tag}-{}-{nonce}", std::process::id()))
}

fn temp_artifact_root(tag: &str) -> RuntimeArtifactRoot {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "utsushi-render-g00-{tag}-{}-{nonce}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    let root = RuntimeArtifactRoot::new(&dir);
    root.prepare().expect("prepare managed artifact root");
    root
}

/// Bounds a source dimension so the scaled sprite fits inside `budget`
/// framebuffer pixels; returns a scale in thousandths (`<= 1000`).
fn fit_scale(src_w: u32, src_h: u32, budget_w: u32, budget_h: u32) -> i32 {
    let sx = (budget_w as u64 * 1000) / src_w.max(1) as u64;
    let sy = (budget_h as u64 * 1000) / src_h.max(1) as u64;
    sx.min(sy).clamp(1, 1000) as i32
}

/// The whole per-title assertion battery (Node 1 + Node 2). Runs against
/// one real corpus's g00 directory.
fn run_title_render_proof(g00_dir: PathBuf, title: &str) {
    let (stem, image) = pick_varied_type0_g00(&g00_dir).unwrap_or_else(|| {
        panic!(
            "no decodable, pixel-varied type-0 g00 found under {} for title {title}; \
             the 2-title acceptance is corpus-limited here (surface to orchestrator, do not fake)",
            g00_dir.display()
        )
    });

    let assets: Arc<dyn AssetPackage> = Arc::new(OnDiskG00Package::new(g00_dir.clone()));

    // Frame + placement: fit the sprite well inside the framebuffer so the
    // scaled rect is fully on-screen and the invariants are exact.
    let fb_w = 320u32;
    let fb_h = 240u32;
    let pos_x = 8i32;
    let pos_y = 8i32;
    let scale = fit_scale(image.width, image.height, 240, 176);
    let scale_state = GraphicsScale {
        x_thousandths: scale,
        y_thousandths: scale,
    };
    let dst_w = ((image.width as u64 * scale as u64) / 1000) as i32;
    let dst_h = ((image.height as u64 * scale as u64) / 1000) as i32;
    assert!(
        dst_w > 0 && dst_h > 0,
        "{title}: scaled sprite must be non-empty"
    );

    // A distinctive opaque background so image pixels are distinguishable
    // from the fill.
    let bg_colour = WipeColour::opaque_rgb(0x24, 0x18, 0x30);
    let tone = GraphicsColourTone {
        red_thousandths: 400,
        green_thousandths: -200,
        blue_thousandths: 0,
    };

    // Helper: build a stack with a background wipe + one image object.
    let build_stack = |alpha: GraphicsAlpha, colour_tone: GraphicsColourTone, sc: GraphicsScale| {
        let mut stack = GraphicsObjectStack::new();
        stack
            .set(
                GraphicsPlane::Background,
                0,
                GraphicsObject::wipe(bg_colour),
            )
            .expect("set bg wipe");
        let mut obj = GraphicsObject::image(stem.clone());
        obj.position.x = pos_x;
        obj.position.y = pos_y;
        obj.scale = sc;
        obj.colour_tone = colour_tone;
        obj.alpha = alpha;
        stack
            .set(GraphicsPlane::Foreground, 0, obj)
            .expect("set image object");
        stack
    };

    let pass = RenderPass::with_dimensions(fb_w, fb_h)
        .expect("non-zero screen")
        .with_assets(Arc::clone(&assets));
    assert!(pass.has_assets(), "{title}: asset package must be bound");

    // Reference: a pure-background render (no image composited at all).
    let mut bg_only = GraphicsObjectStack::new();
    bg_only
        .set(
            GraphicsPlane::Background,
            0,
            GraphicsObject::wipe(bg_colour),
        )
        .expect("bg only");
    let bg_frame = pass.rasterise_with_policy(&bg_only, RedactionPolicy::Full);

    // ---- NODE 1: graphics-object state IS applied --------------------
    // Three full-fidelity renders of the SAME sprite geometry:
    //  - ignore:  neutral tone, opaque alpha (state-ignored baseline)
    //  - opaque:  applied tone, opaque alpha
    //  - blended: applied tone, half alpha
    let ignore_frame = pass.rasterise_with_policy(
        &build_stack(
            GraphicsAlpha::OPAQUE,
            GraphicsColourTone::NEUTRAL,
            scale_state,
        ),
        RedactionPolicy::Full,
    );
    let opaque_frame = pass.rasterise_with_policy(
        &build_stack(GraphicsAlpha::OPAQUE, tone, scale_state),
        RedactionPolicy::Full,
    );
    let blended_frame = pass.rasterise_with_policy(
        &build_stack(GraphicsAlpha(128), tone, scale_state),
        RedactionPolicy::Full,
    );

    // The image is genuinely composited (image_ref dereferenced): the
    // ignore-state render differs from the background-only render.
    assert_ne!(
        ignore_frame.pixels(),
        bg_frame.pixels(),
        "{title}: image_ref must be dereferenced and composited (differs from bg-only)"
    );

    // Alpha IS applied: blended != opaque.
    assert_ne!(
        blended_frame.pixels(),
        opaque_frame.pixels(),
        "{title}: alpha-blended object must differ from the opaque composite (alpha applied)"
    );
    // Tone IS applied: opaque(tone) != ignore(neutral tone).
    assert_ne!(
        opaque_frame.pixels(),
        ignore_frame.pixels(),
        "{title}: colour-tone must change composited pixels (tone applied)"
    );
    // Combined: blended differs from the ignore-state baseline too.
    assert_ne!(
        blended_frame.pixels(),
        ignore_frame.pixels(),
        "{title}: alpha-blended object must differ from the ignore-state baseline"
    );

    // Scale IS applied: a half-scale render differs (smaller rect).
    let half_scale = GraphicsScale {
        x_thousandths: (scale / 2).max(1),
        y_thousandths: (scale / 2).max(1),
    };
    let half_frame = pass.rasterise_with_policy(
        &build_stack(GraphicsAlpha::OPAQUE, tone, half_scale),
        RedactionPolicy::Full,
    );
    assert_ne!(
        half_frame.pixels(),
        opaque_frame.pixels(),
        "{title}: object scale must resample the sprite (scale applied)"
    );

    // ---- NODE 2: real g00 rasterised into the framebuffer -----------
    // The full-fidelity opaque frame's object rect is NOT all background
    // fill — it carries decoded-g00-derived pixels.
    let bg_rgba = [
        bg_colour.red,
        bg_colour.green,
        bg_colour.blue,
        bg_colour.alpha,
    ];
    let nonfill_in_rect = rect_has_non_colour_pixel(
        &opaque_frame,
        pos_x,
        pos_y,
        dst_w as u32,
        dst_h as u32,
        bg_rgba,
    );
    assert!(
        nonfill_in_rect,
        "{title}: private full-fidelity frame must contain decoded-g00 pixels \
         (not all synthetic fill) in the object rect"
    );

    // ---- NODE 2: emit private full-fidelity + public redacted --------
    let text = TextLayer::localized(vec![format!("{title} SCENE-1 EN").to_uppercase()]);

    // Redaction ON (default): public frame is redacted; private is full.
    let root_on = temp_artifact_root("redact-on");
    let sink_on = RecordingFrameArtifactSink::new();
    let private_dir_on = private_render_dir(title);
    let mut pass_on = RenderPass::with_dimensions(fb_w, fb_h)
        .expect("non-zero screen")
        .with_assets(Arc::clone(&assets));
    let stack_on = build_stack(GraphicsAlpha::OPAQUE, tone, scale_state);
    let shots = pass_on
        .emit_scene_screenshots(
            &stack_on,
            &text,
            SceneEmit {
                root: &root_on,
                run_id: "render-g00-real",
                sink: &sink_on,
                private_dir: &private_dir_on,
                public_redact: true, // redaction ON
            },
        )
        .expect("emit scene screenshots (redaction on)");

    assert_eq!(shots.redaction, RedactionPolicy::Redact);
    assert_eq!(sink_on.len(), 1, "{title}: one public frame announced");

    // The private full-fidelity PNG is a real hashable file on disk whose
    // bytes hash to the reported sha256.
    let private_bytes = fs::read(&shots.private_png_path).unwrap_or_else(|err| {
        panic!(
            "{title}: private PNG must be readable at {}: {err}",
            shots.private_png_path.display()
        )
    });
    assert_eq!(
        &private_bytes[..8],
        &PNG_FILE_MAGIC,
        "{title}: private is a PNG"
    );
    assert_eq!(
        sha256_hex(&private_bytes),
        shots.private_png_sha256,
        "{title}: private PNG hash matches reported digest"
    );
    // The private PNG lives under the gitignored /.private-render/ tree.
    assert!(
        shots
            .private_png_path
            .components()
            .any(|c| c.as_os_str() == ".private-render"),
        "{title}: private PNG must be written under /.private-render/ (uncommitted): {}",
        shots.private_png_path.display()
    );

    // Redaction toggle semantics: the public (redacted) buffer differs
    // from the full-fidelity buffer; with redaction OFF it equals it.
    let full_public =
        pass_on.rasterise_with_text_policy(&stack_on, &text, RedactionPolicy::public_toggle(false));
    let redacted_public =
        pass_on.rasterise_with_text_policy(&stack_on, &text, RedactionPolicy::public_toggle(true));
    let full_fidelity = pass_on.rasterise_with_text_policy(&stack_on, &text, RedactionPolicy::Full);
    assert_eq!(
        full_public.0.pixels(),
        full_fidelity.0.pixels(),
        "{title}: with redaction OFF the public frame equals the full-fidelity buffer"
    );
    assert_ne!(
        redacted_public.0.pixels(),
        full_fidelity.0.pixels(),
        "{title}: with redaction ON the public frame differs from the full-fidelity buffer"
    );

    // The redacted public frame carries the synthetic marker (not art) in
    // the object rect — proof the public frame publishes no source pixels.
    let marker_rgba = [
        utsushi_reallive::REDACTION_MARKER.red,
        utsushi_reallive::REDACTION_MARKER.green,
        utsushi_reallive::REDACTION_MARKER.blue,
        utsushi_reallive::REDACTION_MARKER.alpha,
    ];
    // Sample a pixel near the rect centre (avoids the text layer at the
    // top-left origin).
    let sample_x = (pos_x + dst_w / 2) as u32;
    let sample_y = (pos_y + dst_h * 3 / 4) as u32;
    assert_eq!(
        pixel_at(&redacted_public.0, sample_x, sample_y),
        marker_rgba,
        "{title}: redacted public frame must show the synthetic marker in the object rect"
    );

    // Clean up the private artifacts (they are uncommitted anyway).
    let _ = fs::remove_dir_all(&private_dir_on);
    let _ = fs::remove_dir_all(root_on.path());
}

/// STRICT-PROOF anti-silent-partial-render proof (adversarial audit
/// finding): a full-scene emit whose g00 asset FAILS to decode must NOT
/// return hashes as if the scene rendered completely. It must SURFACE the
/// dropped object on the result. This exercises the exact path the prior
/// suite hid by only ever picking cleanly-decodable sprites.
///
/// It renders a background wipe + localized text + one image object whose
/// asset is a SYNTHETIC malformed g00 (authored by [`malformed_type0_g00`],
/// which [`decode_g00`] hard-rejects with
/// [`G00DecodeError::MalformedCompressedSize`]), and asserts the emit
/// result REPORTS the skip (`is_incomplete() == true`, `skipped_objects`
/// names the asset with a [`SkipReason::DecodeFailed`]) rather than
/// silently succeeding.
///
/// The malformed g00 is fully synthetic (no real art) and injected through
/// the ordinary on-disk asset seam, so this proof is DETERMINISTIC and
/// runs without a real corpus — it is enforced continuously in `just ci`.
fn run_synthetic_skip_surface_proof() {
    let title = "synthetic";
    let stem = "MALFORMED_BACK";
    let malformed = malformed_type0_g00();
    // Confirm the authored bytes are exactly what the render seam will hit:
    // a hard decoder rejection (not a warning-tolerated decode).
    let decode_err = decode_g00(&malformed)
        .expect_err("synthetic g00 must hard-fail decode_g00")
        .to_string();
    assert!(
        decode_err.contains("malformed_compressed_size"),
        "synthetic g00 must trip MalformedCompressedSize, got: {decode_err}"
    );
    eprintln!(
        "{title}: exercising silent-skip path with synthetic malformed g00 stem={stem} \
         (decode error: {decode_err})"
    );

    let g00_dir = temp_g00_dir_with(stem, &malformed);
    let assets: Arc<dyn AssetPackage> = Arc::new(OnDiskG00Package::new(g00_dir.clone()));
    let stem = stem.to_string();
    let fb_w = 320u32;
    let fb_h = 240u32;

    // A stack that CAN render everything except the image: an opaque
    // background wipe + a real localized text layer, plus the image object
    // whose g00 fails to decode. The wipe + text keep the emit non-vacuous
    // so we reach (and inspect) the result rather than being rejected for a
    // blank frame.
    let mut stack = GraphicsObjectStack::new();
    stack
        .set(
            GraphicsPlane::Background,
            0,
            GraphicsObject::wipe(WipeColour::opaque_rgb(0x24, 0x18, 0x30)),
        )
        .expect("set bg wipe");
    let mut image = GraphicsObject::image(stem.clone());
    image.position.x = 8;
    image.position.y = 8;
    stack
        .set(GraphicsPlane::Foreground, 0, image)
        .expect("set undecodable image object");

    let text = TextLayer::localized(vec![format!("{title} INCOMPLETE EN").to_uppercase()]);

    let root = temp_artifact_root("skip-surface");
    let sink = RecordingFrameArtifactSink::new();
    let private_dir = private_render_dir(&format!("{title}-skip"));
    let mut pass = RenderPass::with_dimensions(fb_w, fb_h)
        .expect("non-zero screen")
        .with_assets(Arc::clone(&assets));

    let shots = pass
        .emit_scene_screenshots(
            &stack,
            &text,
            SceneEmit {
                root: &root,
                run_id: "render-g00-skip-surface",
                sink: &sink,
                private_dir: &private_dir,
                public_redact: true,
            },
        )
        .expect("emit still succeeds fail-soft, but must report the skip");

    // The emit did NOT silently succeed: it reports the frame as
    // incomplete and names the dropped object with a DecodeFailed reason.
    assert!(
        shots.is_incomplete(),
        "{title}: an emit that dropped an undecodable g00 must report is_incomplete()==true, \
         not return hashes as if the scene rendered completely"
    );
    assert!(
        !shots.skipped_objects.is_empty(),
        "{title}: the dropped object must appear in skipped_objects"
    );
    let dropped = shots
        .skipped_objects
        .iter()
        .find(|s| s.asset_key.eq_ignore_ascii_case(&stem))
        .unwrap_or_else(|| {
            panic!(
                "{title}: skipped_objects must name the undecodable asset {stem}; got {:?}",
                shots.skipped_objects
            )
        });
    match &dropped.reason {
        SkipReason::DecodeFailed { error } => {
            assert!(
                !error.is_empty(),
                "{title}: DecodeFailed must carry the underlying decode error text"
            );
        }
        other => panic!(
            "{title}: the undecodable {stem} must be reported as DecodeFailed, got {other:?}"
        ),
    }
    assert_eq!(
        dropped.plane,
        GraphicsPlane::Foreground,
        "{title}: the skip must record the object's plane"
    );

    // The frame the emit DID produce is still a real hashable PNG (the
    // fail-soft rendered the wipe + text) — but it is now HONEST about
    // being partial.
    let private_bytes = fs::read(&shots.private_png_path).expect("private PNG readable");
    assert_eq!(&private_bytes[..8], &PNG_FILE_MAGIC, "{title}: private PNG");
    assert_eq!(sha256_hex(&private_bytes), shots.private_png_sha256);
    assert_eq!(sink.len(), 1, "{title}: public frame still announced");

    let _ = fs::remove_dir_all(&private_dir);
    let _ = fs::remove_dir_all(root.path());
    let _ = fs::remove_dir_all(&g00_dir);
}

fn pixel_at(fb: &utsushi_reallive::Framebuffer, x: u32, y: u32) -> [u8; 4] {
    let stride = fb.width() as usize * 4;
    let off = (y as usize) * stride + (x as usize) * 4;
    let p = fb.pixels();
    [p[off], p[off + 1], p[off + 2], p[off + 3]]
}

/// True if any pixel inside the given rect differs from `colour`.
fn rect_has_non_colour_pixel(
    fb: &utsushi_reallive::Framebuffer,
    x0: i32,
    y0: i32,
    w: u32,
    h: u32,
    colour: [u8; 4],
) -> bool {
    for dy in 0..h {
        for dx in 0..w {
            let x = x0 + dx as i32;
            let y = y0 + dy as i32;
            if x < 0 || y < 0 || x >= fb.width() as i32 || y >= fb.height() as i32 {
                continue;
            }
            if pixel_at(fb, x as u32, y as u32) != colour {
                return true;
            }
        }
    }
    false
}

// ---- gated entry points (one per title) -----------------------------

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT env var (title 1)"]
fn render_pass_applies_state_and_rasterises_g00_title1_real_bytes() {
    let Some(g00_dir) = real_corpus::g00_dir_for_env(real_corpus::REAL_GAME_ROOT_ENV) else {
        real_corpus::skip_or_require_real_bytes(
            "utsushi-reallive render_pass_applies_state_and_rasterises_g00_title1_real_bytes",
        );
        return;
    };
    run_title_render_proof(g00_dir, "title1");
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT_2 env var (title 2)"]
fn render_pass_applies_state_and_rasterises_g00_title2_real_bytes() {
    let Some(g00_dir) = real_corpus::g00_dir_for_env(real_corpus::REAL_GAME_ROOT_2_ENV) else {
        real_corpus::skip_or_require_real_bytes(
            "utsushi-reallive render_pass_applies_state_and_rasterises_g00_title2_real_bytes (title 2 / ITOTORI_REAL_GAME_ROOT_2)",
        );
        return;
    };
    run_title_render_proof(g00_dir, "title2");
}

/// Honest-fail-soft proof, enforced continuously in `just ci`.
///
/// This is deliberately NOT `#[ignore]`-gated and needs no real corpus:
/// the undecodable asset is a SYNTHETIC malformed g00 (see
/// [`malformed_type0_g00`]) injected through the ordinary on-disk asset
/// seam. Keeping it in the default test set means the "an emit that
/// dropped an undecodable object must report the skip, not fake success"
/// invariant can never silently regress behind an `--ignored` gate again
/// (the original real-corpus variant went RED — and unnoticed — the moment
/// the g00 decoder was fixed and every corpus g00 started decoding).
#[test]
fn emit_scene_reports_skip_for_undecodable_synthetic_g00() {
    run_synthetic_skip_surface_proof();
}
