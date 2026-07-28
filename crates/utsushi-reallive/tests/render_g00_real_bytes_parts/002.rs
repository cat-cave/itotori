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

/// STRICT-PROOF anti-silent-partial-render proof (adversarial audit
/// finding): a full-scene emit whose g00 asset FAILS to decode must NOT
/// return hashes as if the scene rendered completely. It must SURFACE the
/// dropped object on the result. This exercises the exact path the prior
/// suite hid by only ever picking cleanly-decodable sprites.
///
/// It renders a background wipe + localized text + one image object whose
/// asset is a SYNTHETIC malformed g00 (authored by [`malformed_type0_g00`]
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

/// Count DISTINCT RGBA pixel values inside the given rect (capped at a
/// small ceiling — we only need "more than one"). A single-colour solid
/// fill returns `1`; an edge-outline returns many.
fn distinct_rect_colours(
    fb: &utsushi_reallive::Framebuffer,
    x0: i32,
    y0: i32,
    w: u32,
    h: u32,
) -> usize {
    let mut seen: std::collections::HashSet<[u8; 4]> = std::collections::HashSet::new();
    for dy in 0..h {
        for dx in 0..w {
            let x = x0 + dx as i32;
            let y = y0 + dy as i32;
            if x < 0 || y < 0 || x >= fb.width() as i32 || y >= fb.height() as i32 {
                continue;
            }
            seen.insert(pixel_at(fb, x as u32, y as u32));
            if seen.len() >= 8 {
                return seen.len();
            }
        }
    }
    seen.len()
}


