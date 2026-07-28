use super::*;

/// Parameters for the shared RealLive render-validate drive. Exposed to the
/// crate (not just this module) so the composed `patch-render` command can
/// reuse the exact same rasterizing render pipeline on the patched Seen.txt
/// without duplicating the observe/composite/layout/emit logic.
pub(crate) struct Params<'a> {
    pub(crate) seen_path: &'a Path,
    pub(crate) scene_id: u16,
    pub(crate) artifact_root: &'a Path,
    pub(crate) run_id: &'a str,
    pub(crate) expect_text_contains: Option<&'a str>,
    /// Zero-based play-order message index within the scene. When present
    /// selection is positional first; `expect_text_contains` then asserts that
    /// the selected message is the intended patched draft.
    pub(crate) message_index: Option<usize>,
    /// Framebuffer width override; `None` uses the Gameexe screen width.
    pub(crate) width: Option<u32>,
    /// Framebuffer height override; `None` uses the Gameexe screen height.
    pub(crate) height: Option<u32>,
    pub(crate) gameexe_path: &'a Path,
    pub(crate) game_dir: &'a Path,
    /// Pristine (pre-patch) source Seen.txt. Used to recover the REAL
    /// per-speaker #NAMAE colour when a dialogue-only translation rewrote
    /// the inline 【…】 name prefix into the target language (the Japanese
    /// #NAMAE key no longer matches on the patched line). `None` renders
    /// the translated name box without a recovered colour.
    pub(crate) source_seen: Option<&'a Path>,
    /// Real g00 background stem composited when the observed play-order
    /// scene set no graphics of its own (a headless dialogue-scene drive
    /// inherits its background from a prior scene, so its own terminal
    /// stack can be empty). The named stem's REAL decoded g00 art is
    /// cover-scaled into the frame so the composite is always real art.
    pub(crate) bg_asset: Option<&'a str>,
    pub(crate) private_artifact_root: Option<&'a Path>,
    pub(crate) public_redact: bool,
}
/// Drive the real RealLive render-validate pipeline for one scene and
/// return the deterministic JSON evidence report. Emits the redacted
/// public PNG (+ the gitignored private full-fidelity PNG) through the
/// substrate frame sink at E2 as a side effect; the report is redaction
/// aware but carries the artifact filesystem paths for the standalone CLI
/// (the composed `patch-render` command re-projects a path-free subset).
///
/// Returns the JSON evidence report PLUS the rendered scene's
/// [`DispatchReport`] opcode-coverage. The coverage is also folded into the
/// JSON report (`coverage.missingKeys[]`) so a rendered frame never silently
/// hides an unimplemented opcode; the caller applies the strict
/// `--require-semantic-reached-path` gate on the returned coverage.
pub(crate) fn drive(
    params: Params<'_>,
) -> Result<(serde_json::Value, DispatchReport), Box<dyn Error>> {
    // 1. Parse the real Gameexe.ini → the #WINDOW.000 message-box config
    //    the game's declared virtual screen size the config coordinates
    //    live in, and the #NAMAE → #COLOR_TABLE speaker/colour resolver.
    //    Nothing about the box is hardcoded.
    let gameexe_bytes = fs::read(params.gameexe_path).map_err(|err| {
        format!(
            "utsushi.cli.render_validate.gameexe_read: {}: {err}",
            params.gameexe_path.display()
        )
    })?;
    let gameexe = Gameexe::parse(&gameexe_bytes)
        .map_err(|err| format!("utsushi.cli.render_validate.gameexe_parse: {err}"))?;
    let config = gameexe.message_window(0);
    let screen_size = gameexe.screen_size_px();

    // 2. Stage a ReplayEngine (dev-only `use_xor_2` recovery for encrypted
    //    titles; no-op for plaintext), install the #NAMAE resolver, and
    //    observe the REAL branch-following PLAY-ORDER message stream for
    //    the scene — each message carries its NAME-register speaker and
    //    resolved dialogue colour. This is what the message window renders
    //    one-per-frame (NOT the doubled two-pass catalogue).
    let engine = staged_engine(params.seen_path)
        .map_err(|err| format!("utsushi.cli.render_validate.driver: {err}"))?
        .with_namae_resolver(gameexe.namae_resolver());
    let opts = ReplayOpts {
        step_budget: OBSERVE_BUDGET,
        stop_at_first_pause: false,
    };
    let observation = engine.observe_for_port(params.scene_id, &opts);
    let play_order = &observation.play_order_lines;
    let textline_count = play_order.len();
    if play_order.is_empty() {
        return Err(format!(
            "utsushi.cli.render_validate.no_text: scene={} produced no play-order message to \
             render",
            params.scene_id
        )
        .into());
    }

    // 3. Select the ONE message to render. A caller that needs per-unit proof
    //    supplies --message-index so duplicate/prefix-overlapping drafts select
    //    their own play-order line, then --expect-text-contains is asserted
    //    against that exact line. Without an index, substring selection remains
    //    available for one-off callers but rejects ambiguous multi-matches.
    let (chosen_index, chosen) = select_play_order_message(
        play_order,
        params.scene_id,
        params.expect_text_contains,
        params.message_index,
    )?;
    let contains_expected = params
        .expect_text_contains
        .map(|needle| chosen.text.contains(needle));

    // Speaker + colour + rendered body. When the engine already resolved a
    // #NAMAE speaker on the (patched) line, honour it. Otherwise, a
    // dialogue-only translation has rewritten the inline 【…】 name prefix
    // into the target language (e.g. 【菊次朗】→【Kazuto】), which no longer
    // matches the Japanese #NAMAE key — so split the translated inline name
    // into the NAME_MOD name box ourselves, and recover the REAL
    // per-speaker colour from the PRISTINE source Seen (the #NAMAE colour is
    // a property of the character, untouched by dialogue-only patchback).
    // The source play-order aligns 1:1 with the patched one (same scene
    // same structure), so the colour at the same index is this speaker's.
    let (rendered_text, speaker, resolved_color) = if chosen.speaker.is_some() {
        (chosen.text.clone(), chosen.speaker.clone(), chosen.color)
    } else {
        let (inline_name, body) = split_inline_name(&chosen.text);
        let source_color = params
            .source_seen
            .map(|source_seen| {
                source_speaker_color_at(
                    source_seen,
                    params.scene_id,
                    chosen_index,
                    &gameexe.namae_resolver(),
                )
            })
            .transpose()?
            .flatten();
        (body, inline_name, source_color)
    };
    let text_color = resolved_color.map(|[r, g, b]| WipeColour::opaque_rgb(r, g, b));

    // 4. Composite REAL decoded g00 art. Prefer the graphics stack the
    //    drive OBSERVED (the engine's real terminal state). A headless
    //    dialogue-scene drive can inherit its background from a prior scene
    //    and set no graphics of its own, leaving an empty terminal stack;
    //    in that case composite the named --bg-asset stem's REAL decoded
    //    g00 art (cover-scaled) so the frame is never a synthetic fill.
    let g00_dir = find_g00_dir(params.game_dir).ok_or_else(|| {
        format!(
            "utsushi.cli.render_validate.g00_dir_missing: no g00 directory found under {}",
            params.game_dir.display()
        )
    })?;

    // Render at the game's real screen size (so the config-driven box lines
    // up with the g00 art) unless an explicit override is given.
    let frame_width = params.width.unwrap_or(screen_size.0);
    let frame_height = params.height.unwrap_or(screen_size.1);
    let frame_size = (frame_width, frame_height);

    let observed_stack = &observation.scene.graphics_stack;
    let mut fallback_stack = GraphicsObjectStack::new();
    let composited_bg_asset = if observed_stack.is_empty() {
        let bg_stem = params.bg_asset.ok_or_else(|| {
            format!(
                "utsushi.cli.render_validate.no_graphics: scene {} observed no graphics and no \
                 --bg-asset was supplied to composite a real g00 background",
                params.scene_id
            )
        })?;
        // Decode the real g00 up front to size the cover scale (fail typed
        // if the named stem is missing/undecodable — never a fake fill).
        let raw = fs::read(g00_dir.join(format!("{bg_stem}.g00")))
            .map_err(|err| format!("utsushi.cli.render_validate.bg_read: {bg_stem}.g00: {err}"))?;
        let (img, _warns) = decode_g00(&raw).map_err(|err| {
            format!("utsushi.cli.render_validate.bg_decode: {bg_stem}.g00: {err}")
        })?;
        let scale = cover_scale(frame_size, img.width, img.height);
        fallback_stack
            .set(
                GraphicsPlane::Background,
                0,
                GraphicsObject::wipe(WipeColour::opaque_rgb(0x08, 0x08, 0x0c)),
            )
            .map_err(|err| format!("utsushi.cli.render_validate.stack: {err}"))?;
        let mut bg = GraphicsObject::image(bg_stem.to_string());
        bg.scale = GraphicsScale {
            x_thousandths: scale,
            y_thousandths: scale,
        };
        fallback_stack
            .set(GraphicsPlane::Background, 1, bg)
            .map_err(|err| format!("utsushi.cli.render_validate.stack: {err}"))?;
        Some(bg_stem.to_string())
    } else {
        None
    };
    let stack = if composited_bg_asset.is_some() {
        &fallback_stack
    } else {
        observed_stack
    };
    let assets: Arc<dyn AssetPackage> = Arc::new(OnDiskG00Package::new(g00_dir));

    // 5. Lay the ONE message into the real Gameexe message box: word-wrapped
    //    body in the speaker's colour + a NAME_MOD=1 speaker name box.
    let text = TextLayer::message_window_colored(
        &rendered_text,
        speaker.as_deref(),
        text_color,
        &config,
        screen_size,
        frame_size,
    );

    // 6. Emit the private full-fidelity PNG + the public (redacted by
    //    default) screenshot through the substrate frame sink at E2.
    let mut pass = RenderPass::with_dimensions(frame_size.0, frame_size.1)
        .map_err(|err| format!("utsushi.cli.render_validate.render_pass: {err}"))?
        .with_assets(assets);
    let root = RuntimeArtifactRoot::new(params.artifact_root);
    let sink = RecordingFrameArtifactSink::new();
    let private_dir = private_artifact_dir(params.private_artifact_root, params.run_id);
    let shots = pass
        .emit_scene_screenshots(
            stack,
            &text,
            SceneEmit::frame(
                &root,
                params.run_id,
                &sink,
                &private_dir,
                params.public_redact,
            ),
        )
        .map_err(|err| format!("utsushi.cli.render_validate.emit: {err}"))?;
    let artifact = &shots.public;

    if artifact.evidence_tier < EvidenceTier::E2 {
        return Err(format!(
            "utsushi.cli.render_validate.evidence_floor: emitted below E2 ({:?})",
            artifact.evidence_tier
        )
        .into());
    }
    let artifact_path = root
        .artifact_path(&artifact.artifact_ref.uri)
        .map_err(|err| format!("utsushi.cli.render_validate.artifact_path: {err}"))?;

    // Re-run the opcode/dispatch COVERAGE gate over the SAME branch-following
    // pass the play-order observation drove (same engine, same step budget)
    // so a scene that skipped an unimplemented opcode is surfaced rather than
    // hidden behind the emitted E2 frame. Folded into the report below and
    // gated on by the caller's `--require-semantic-reached-path`.
    let coverage = dispatch_report_from_engine(&engine, params.scene_id, &opts);

    // One real play-order message rendered per frame; the speaker + colour
    // presence is recorded (never the raw speaker/text) so the evidence
    // shows the message-window subsystem exercised the NAME box + colour.
    let has_speaker = speaker
        .as_deref()
        .map(str::trim)
        .is_some_and(|s| !s.is_empty());
    let report = json!({
        "schemaVersion": "0.1.0",
        "engine": SUPPORTED_ENGINE,
        "sceneId": params.scene_id,
        "evidenceTier": artifact.evidence_tier.as_str(),
        "artifactKind": artifact.artifact_ref.artifact_kind,
        "artifactId": artifact.artifact_ref.artifact_id,
        "artifactUri": artifact.artifact_ref.uri,
        "artifactPath": artifact_path.display().to_string(),
        "frameIndex": artifact.frame_index,
        "width": artifact.width,
        "height": artifact.height,
        "textlineCount": textline_count,
        "renderedLineCount": 1,
        "renderedMessageIndex": chosen_index,
        "renderedTextSha256": sha256_hex(rendered_text.as_bytes()),
        "expectTextContains": params.expect_text_contains,
        "pixelGate": render_validate_pixel_gate::passed(),
        "containsExpected": contains_expected,
        "framesAnnounced": sink.len(),
        "hasSpeakerNameBox": has_speaker && config.name_mod == 1,
        "hasSpeakerColor": text_color.is_some(),
        "graphicsObjectCount": stack.len(),
        "compositedBgAsset": composited_bg_asset,
        "bgSource": if composited_bg_asset.is_some() { "bg-asset" } else { "observed-stack" },
        "redaction": if shots.redaction == RedactionPolicy::Redact { "on" } else { "off" },
        "privateArtifactPath": shots.private_png_path.display().to_string(),
        "privateArtifactSha256": shots.private_png_sha256,
        "coverage": coverage.to_json(),
    });

    println!(
        "{RENDER_OK_CODE}: scene={} artifact_id={} uri={} evidence_tier={} \
         play_order_messages={} name_box={} color={} redaction={} private={} \
         coverage_terminus={} missing_opcodes={}",
        params.scene_id,
        artifact.artifact_ref.artifact_id,
        artifact.artifact_ref.uri,
        artifact.evidence_tier.as_str(),
        textline_count,
        has_speaker && config.name_mod == 1,
        text_color.is_some(),
        if shots.redaction == RedactionPolicy::Redact {
            "on"
        } else {
            "off"
        },
        shots.private_png_path.display(),
        coverage.terminus,
        coverage.missing_count,
    );
    Ok((report, coverage))
}
