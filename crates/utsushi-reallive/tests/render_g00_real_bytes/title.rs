use super::geometry::{distinct_rect_colours, rect_differs, rect_has_non_colour_pixel};
use super::*;

/// The whole per-title assertion battery (Node 1 + Node 2). Runs against
/// one real corpus's g00 directory.
pub(super) fn run_title_render_proof(g00_dir: PathBuf, title: &str) {
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

    // Three full-fidelity renders of the SAME sprite geometry:
    //  - ignore: neutral tone, opaque alpha (state-ignored baseline)
    //  - opaque: applied tone, opaque alpha
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
            // redaction ON
            SceneEmit::frame(&root_on, "render-g00-real", &sink_on, &private_dir_on, true),
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

    // The redacted public frame shows the scene's STRUCTURE (a
    // copyright-safe edge-outline), NOT the old solid marker and NOT the
    // full-fidelity art. Two proofs over the object rect:
    //
    //  1. it is NOT a single solid colour — the edge-outline carries
    //     structure, so a human sees the scene's layout rather than a
    //     blank block (the exact failure the old solid marker had);
    //  2. it differs from the full-fidelity rect — the redaction transform
    //     genuinely ran and did not just re-blit the decoded art.
    let distinct =
        distinct_rect_colours(&redacted_public.0, pos_x, pos_y, dst_w as u32, dst_h as u32);
    assert!(
        distinct >= 2,
        "{title}: redacted public frame must show structure (>=2 distinct colours in the \
         object rect), not a single solid fill; got {distinct}"
    );
    assert!(
        rect_differs(
            &redacted_public.0,
            &full_fidelity.0,
            pos_x,
            pos_y,
            dst_w as u32,
            dst_h as u32,
        ),
        "{title}: redacted object rect must differ from the full-fidelity rect (transform ran)"
    );

    // Clean up the private artifacts (they are uncommitted anyway).
    let _ = fs::remove_dir_all(&private_dir_on);
    let _ = fs::remove_dir_all(root_on.path());
}
