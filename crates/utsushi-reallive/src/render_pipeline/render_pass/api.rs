use super::*;

impl RenderPass {
    pub fn new(screen_size: ScreenSize) -> Result<Self, RenderPassBuildError> {
        Self::with_dimensions(screen_size.width, screen_size.height)
    }

    /// Construct a render pass with raw `(width, height)`. Used by
    /// tests that want to drive the encoder without a full Gameexe
    /// parse.
    pub fn with_dimensions(width: u32, height: u32) -> Result<Self, RenderPassBuildError> {
        if width == 0 || height == 0 {
            return Err(RenderPassBuildError::ZeroScreenSize {
                code: RENDER_PIPELINE_ZERO_SCREEN_SIZE_CODE.to_string(),
                width,
                height,
            });
        }
        Ok(Self {
            width,
            height,
            frame_index: 0,
            assets: None,
        })
    }

    /// Bind the [`AssetPackage`] the image-object compositor resolves
    /// `g00/<asset_key>.g00` assets through. Consumes and returns `self`
    /// so it chains off a constructor.
    pub fn with_assets(mut self, assets: Arc<dyn AssetPackage>) -> Self {
        self.assets = Some(assets);
        self
    }

    /// Whether an asset package is bound (image objects can be
    /// dereferenced).
    pub fn has_assets(&self) -> bool {
        self.assets.is_some()
    }

    /// Framebuffer pixel width.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Framebuffer pixel height.
    pub fn height(&self) -> u32 {
        self.height
    }

    /// The next `frame_index` the render pass will emit.
    pub fn next_frame_index(&self) -> u64 {
        self.frame_index
    }

    /// Rasterise `stack` into a fresh framebuffer under the default
    /// [`RedactionPolicy::Redact`] policy (no text layer). Image objects
    /// are rendered as a copyright-safe edge-outline; use
    /// [`Self::rasterise_with_policy`] with [`RedactionPolicy::Full`] to
    /// composite the real decoded g00 art.
    pub fn rasterise(&self, stack: &GraphicsObjectStack) -> Framebuffer {
        self.rasterise_with_policy(stack, RedactionPolicy::Redact)
    }

    /// Rasterise `stack` into a fresh framebuffer under `policy` (no text
    /// layer). The render order is `(layer: DCs, bg objects, fg objects)`
    /// then within each layer `(layer_order ascending, slot ascending)`.
    pub fn rasterise_with_policy(
        &self,
        stack: &GraphicsObjectStack,
        policy: RedactionPolicy,
    ) -> Framebuffer {
        self.rasterise_reporting(stack, policy).0
    }

    pub fn rasterise_object_button_choice(
        &self,
        stack: &GraphicsObjectStack,
        choice: &ObjectButtonChoiceWindow,
        policy: RedactionPolicy,
    ) -> Framebuffer {
        let mut framebuffer = self.rasterise_with_policy(stack, policy);
        framebuffer.draw_object_button_choice_window(choice);
        framebuffer
    }

    /// Rasterise `stack` under `policy` exactly like
    /// [`Self::rasterise_with_policy`], but ALSO return a [`RenderReport`]
    /// recording every object the compositor could not fully render
    /// (skipped objects with reasons + non-fatal decode warnings). This
    /// is the honest fail-soft surface: the framebuffer still composites
    /// whatever it can, and the report tells the caller whether anything
    /// was dropped (an empty report ⇒ a complete render of the stack).
    pub fn rasterise_reporting(
        &self,
        stack: &GraphicsObjectStack,
        policy: RedactionPolicy,
    ) -> (Framebuffer, RenderReport) {
        let mut framebuffer = Framebuffer::new(self.width, self.height);
        let mut report = RenderReport::default();
        let mut entries: Vec<(GraphicsLayer, i32, usize, &GraphicsObject)> = stack
            .iter_allocated_layers()
            .map(|(layer, slot, object)| (layer, object.layer_order, slot, object))
            .collect();
        entries.sort_by_key(|(layer, z, slot, _)| (layer.paint_order(), *z, *slot));
        for (layer, _, slot, object) in entries {
            if !object.visible {
                continue;
            }
            self.paint_object(
                &mut framebuffer,
                object,
                layer.diagnostic_plane(),
                slot,
                policy,
                &mut report,
            );
        }
        (framebuffer, report)
    }

    /// Rasterise `stack`, then paint the localized `text` layer on top.
    /// This is the frame the screenshot emission encodes. Returns the
    /// framebuffer **and** the count of localized-text pixels
    /// [`Framebuffer::draw_text`] painted, so the emission path can prove
    /// the localized layer actually drew something rather than discarding
    /// the count (a blank layer is a vacuous-evidence regression the
    /// caller must reject).
    pub fn rasterise_with_text(
        &self,
        stack: &GraphicsObjectStack,
        text: &TextLayer,
    ) -> (Framebuffer, u64) {
        self.rasterise_with_text_policy(stack, text, RedactionPolicy::Redact)
    }

    /// Rasterise `stack` under `policy`, then paint the localized `text`
    /// layer on top. Returns the framebuffer and the localized-text pixel
    /// count.
    pub fn rasterise_with_text_policy(
        &self,
        stack: &GraphicsObjectStack,
        text: &TextLayer,
        policy: RedactionPolicy,
    ) -> (Framebuffer, u64) {
        let mut framebuffer = self.rasterise_with_policy(stack, policy);
        let text_pixels = framebuffer.draw_text(text);
        (framebuffer, text_pixels)
    }

    /// Rasterise `stack` + the localized `text` layer under the default
    /// [`RedactionPolicy::Redact`] policy, encode the deterministic PNG
    /// persist it to `root` under a managed `screenshots/<artifact_id>.png`
    /// URI, and announce a [`FrameArtifact`] at [`EvidenceTier::E2`]
    /// through `sink`. This is the public, redacted single-frame emit: an
    /// image object contributes only a copyright-safe edge-outline (see
    /// [`redact_edge_map`]), so the emitted PNG publishes no source art.
    /// The full-fidelity path is [`Self::emit_scene_screenshots`].
    ///
    /// NON-VACUOUS LOCALIZATION PROOF: a non-empty `text` layer that
    /// paints ZERO framebuffer pixels (off-screen origin, all-whitespace
    /// or a glyph-less layer) is rejected with
    /// [`RenderEmitError::BlankLocalizedText`] **before** any PNG is
    /// written or any frame announced, so an E2 localized screenshot can
    /// never be emitted with zero localized-text pixels painted.
    pub fn emit_localized_screenshot(
        &mut self,
        stack: &GraphicsObjectStack,
        text: &TextLayer,
        root: &RuntimeArtifactRoot,
        run_id: &str,
        sink: &dyn FrameArtifactSink,
    ) -> Result<FrameArtifact, RenderEmitError> {
        let (framebuffer, text_pixels) = self.rasterise_with_text(stack, text);
        Self::reject_blank_localized(text, text_pixels)?;
        self.announce_framebuffer(&framebuffer, root, run_id, sink)
    }

    /// Emit the full-fidelity PRIVATE screenshot AND the public
    /// (policy-selected) screenshot for `stack` + `text`.
    ///
    /// 1. The full-fidelity framebuffer (real decoded g00 composited
    ///    [`RedactionPolicy::Full`]) is encoded and written to
    ///    `private_dir/<sha256>.png` — an uncommitted, hashable file on
    ///    disk. Its pixels are byte-derived from the decoded g00.
    /// 2. The public framebuffer is rendered under
    ///    [`RedactionPolicy::public_toggle`]`(emit.public_redact)`: with
    ///    `public_redact == true` (the default) image rects carry only a
    ///    copyright-safe edge-outline (see [`redact_edge_map`]); with
    ///    `false` the public buffer equals the full-fidelity buffer. It is
    ///    announced through `emit.sink` at E2.
    ///
    /// Redaction is thus a policy at THIS emit boundary — the render path
    /// itself always produces the full-fidelity buffer.
    pub fn emit_scene_screenshots(
        &mut self,
        stack: &GraphicsObjectStack,
        text: &TextLayer,
        emit: SceneEmit<'_>,
    ) -> Result<SceneScreenshots, RenderEmitError> {
        // Full-fidelity private buffer (always real g00 art). Collect the
        // render report so any DROPPED object (e.g. an un-decodable
        // BACK.g00 background) is surfaced on the result rather than
        // silently omitted from a frame that would otherwise look
        // complete.
        let (mut full_fb, report) = self.rasterise_reporting(stack, RedactionPolicy::Full);
        let full_text_pixels = full_fb.draw_text(text);
        Self::reject_blank_localized(text, full_text_pixels)?;

        let private_png = encode_png_rgba_deterministic(&full_fb);
        let private_sha = sha256_hex(&private_png);
        std::fs::create_dir_all(emit.private_dir).map_err(|error| {
            RenderEmitError::PrivateArtifactWrite(format!(
                "create private dir {}: {error}",
                emit.private_dir.display()
            ))
        })?;
        let private_png_path = emit.private_dir.join(format!("{private_sha}.png"));
        std::fs::write(&private_png_path, &private_png).map_err(|error| {
            RenderEmitError::PrivateArtifactWrite(format!(
                "write {}: {error}",
                private_png_path.display()
            ))
        })?;

        // Public buffer under the redaction toggle. When redaction is off
        // the public buffer IS the full-fidelity buffer.
        let policy = RedactionPolicy::public_toggle(emit.public_redact);
        let public_fb = match policy {
            RedactionPolicy::Full => full_fb,
            RedactionPolicy::Redact => {
                self.rasterise_with_text_policy(stack, text, RedactionPolicy::Redact)
                    .0
            }
        };
        let public = self.announce_framebuffer(&public_fb, emit.root, emit.run_id, emit.sink)?;

        Ok(SceneScreenshots {
            public,
            private_png_path,
            private_png_sha256: private_sha,
            redaction: policy,
            skipped_objects: report.skipped_objects,
            decode_warnings: report.warnings,
        })
    }

    /// Reject a non-empty localized text layer that painted zero pixels.
    fn reject_blank_localized(text: &TextLayer, text_pixels: u64) -> Result<(), RenderEmitError> {
        if text.char_count() > 0 && text_pixels == 0 {
            return Err(RenderEmitError::BlankLocalizedText {
                code: RENDER_PIPELINE_BLANK_LOCALIZED_TEXT_CODE.to_string(),
                char_count: text.char_count(),
                line_count: text.lines.len(),
            });
        }
        Ok(())
    }

    /// Encode `framebuffer`, persist it under a managed
    /// `screenshots/<artifact_id>.png` URI on `root`, and announce a
    /// [`FrameArtifact`] at [`EvidenceTier::E2`] through `sink`. Advances
    /// the per-pass frame index.
    fn announce_framebuffer(
        &mut self,
        framebuffer: &Framebuffer,
        root: &RuntimeArtifactRoot,
        run_id: &str,
        sink: &dyn FrameArtifactSink,
    ) -> Result<FrameArtifact, RenderEmitError> {
        let png_bytes = encode_png_rgba_deterministic(framebuffer);
        let artifact_id = sha256_hex(&png_bytes);

        root.prepare()
            .map_err(|error| RenderEmitError::ArtifactWrite(error.to_string()))?;
        let uri = runtime_artifact_uri(run_id, RuntimeArtifactKind::Screenshot, &artifact_id)
            .map_err(|error| RenderEmitError::UriBuild(error.to_string()))?;
        root.write_bytes(&uri, &png_bytes)
            .map_err(|error| RenderEmitError::ArtifactWrite(error.to_string()))?;

        let artifact = FrameArtifact {
            frame_id: artifact_id.clone(),
            evidence_tier: EvidenceTier::E2,
            artifact_ref: ObservationArtifactRef {
                artifact_id,
                artifact_kind: SCREENSHOT_ARTIFACT_KIND.to_string(),
                uri,
                media_type: Some("image/png".to_string()),
            },
            width: Some(self.width),
            height: Some(self.height),
            frame_index: self.frame_index,
            bridge_ref: None,
        };
        sink.emit_frame(artifact.clone())?;
        self.frame_index = self.frame_index.saturating_add(1);
        Ok(artifact)
    }
}
