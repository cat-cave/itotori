use super::*;

pub(super) fn run_synthetic_skip_surface_proof() {
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
            SceneEmit::frame(&root, "render-g00-skip-surface", &sink, &private_dir, true),
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

/// A successful but short type-0 decode: the renderer receives real on-disk
/// bytes and paints the zero-extended canvas, so this exercises the warning
/// path rather than the hard-decode skip path above.
fn warning_type0_g00() -> Vec<u8> {
    let lzss = [0x01, 0x01, 0x02, 0x03];
    let mut bytes = Vec::new();
    bytes.push(0u8);
    bytes.extend_from_slice(&4u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&((lzss.len() + 8) as u32).to_le_bytes());
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&lzss);
    bytes
}

pub(super) fn run_synthetic_warning_surface_proof() {
    let title = "synthetic-warning";
    let stem = "SHORT_BACK";
    let warning_bytes = warning_type0_g00();
    let (_, warnings) = decode_g00(&warning_bytes)
        .expect("short type-0 bytes decode through the warning-tolerant path");
    assert_eq!(warnings.len(), 1, "fixture must carry one decode warning");

    let g00_dir = temp_g00_dir_with(stem, &warning_bytes);
    let assets: Arc<dyn AssetPackage> = Arc::new(OnDiskG00Package::new(g00_dir.clone()));
    let mut stack = GraphicsObjectStack::new();
    stack
        .set(
            GraphicsPlane::Background,
            0,
            GraphicsObject::wipe(WipeColour::opaque_rgb(0x24, 0x18, 0x30)),
        )
        .expect("set bg wipe");
    stack
        .set(GraphicsPlane::Foreground, 0, GraphicsObject::image(stem))
        .expect("set warning-bearing image object");
    let text = TextLayer::localized(vec!["WARNING SURFACE".to_string()]);
    let root = temp_artifact_root("warning-surface");
    let sink = RecordingFrameArtifactSink::new();
    let private_dir = private_render_dir(title);
    let mut pass = RenderPass::with_dimensions(320, 240)
        .expect("non-zero screen")
        .with_assets(assets);

    let shots = pass
        .emit_scene_screenshots(
            &stack,
            &text,
            SceneEmit::frame(
                &root,
                "render-g00-warning-surface",
                &sink,
                &private_dir,
                true,
            ),
        )
        .expect("warning-bearing real bytes still emit an inspectable frame");

    assert!(
        shots.skipped_objects.is_empty(),
        "the short payload is a warning-only decode, not a dropped object"
    );
    assert_eq!(shots.decode_warnings.len(), 1);
    assert!(
        shots.is_incomplete(),
        "a zero-extended g00 must be non-final evidence even when it emitted a frame"
    );
    assert_eq!(
        sink.len(),
        1,
        "the real-but-failed public frame is retained"
    );

    let _ = fs::remove_dir_all(&private_dir);
    let _ = fs::remove_dir_all(root.path());
    let _ = fs::remove_dir_all(&g00_dir);
}
