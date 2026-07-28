use super::*;

fn reject_incomplete_frame(skipped_object_count: usize) -> Result<(), String> {
    if skipped_object_count == 0 {
        return Ok(());
    }
    Err(format!(
        "incomplete frame: {skipped_object_count} object(s) dropped during render"
    ))
}

fn deterministic_json_after_successful_replay(log: ReplayLog) -> Result<String, String> {
    if !matches!(
        log.final_outcome,
        crate::replay::ReplayOutcome::EndOfScene { .. }
    ) {
        return Err(format!(
            "deterministic replay did not complete successfully: {:?}",
            log.final_outcome
        ));
    }
    log.to_deterministic_json()
        .map_err(|error| format!("deterministic replay serialise failed: {error}"))
}

impl UtsushiReallivePort {
    /// Render the terminal graphics stack into BOTH a full-fidelity
    /// PRIVATE frame and the publish-redacted public E2 frame through the
    /// real g00 rasteriser, compositing ONE real engine-decoded `message`
    /// (with its speaker) into the Gameexe-configured message box over the
    /// composite.
    ///
    /// ONE message per frame — the current message, NOT the whole scene
    /// concatenated. The box position/colour/alpha/font-size/insets come
    /// from `self.window_config` (`#WINDOW.000`), laid out in the game's
    /// own `self.screen_size` coordinate space (the render pass is built
    /// at that size). A speaker + `NAME_MOD=1` yields a separate name box;
    /// narration renders none.
    ///
    /// - The PRIVATE frame (real decoded g00 + dialogue) is written
    ///   uncommitted and hashable, beside (never beneath) `<root>`.
    /// - The PUBLIC frame composites a copyright-safe edge-outline of the
    ///   g00 (scene structure/layout, no source pixels) with the SAME
    ///   message box on top, and is announced through the substrate frame
    ///   sink at E2. Redaction is ON by default.
    ///
    /// The decoded dialogue text IS the localization proof; the public
    /// frame republishes no copyrighted-source pixels.
    fn render_frame(
        &self,
        observation: &SceneObservation,
        message: &TextLine,
        root: &RuntimeArtifactRoot,
        run_id: &str,
    ) -> Result<FrameArtifact, String> {
        // Render at the game's OWN declared framebuffer size, so a
        // 640x480, 800x600, or HD title each composites in its native
        // coordinate space and its real object rects land on-screen.
        let (frame_width, frame_height) = self.screen_size;
        let mut pass = RenderPass::with_dimensions(frame_width, frame_height)
            .map_err(|error| format!("render pass build failed: {error}"))?
            .with_assets(Arc::clone(&self.assets));
        let text = TextLayer::message_window(
            &message.text,
            message.speaker.as_deref(),
            &self.window_config,
            self.screen_size,
            self.screen_size,
        );
        // Full-fidelity frames must not be reachable from the managed public
        // root. The sibling location has no public artifact URI; an
        // authorized server route is required to read it.
        let private_dir = root.path().with_extension("private-full");
        let throwaway = RecordingFrameArtifactSink::new();
        let shots = pass
            .emit_scene_screenshots(
                &observation.graphics_stack,
                &text,
                // Redaction ON: the announced public frame is the
                // proof-preserving edge-outline, not the real art.
                SceneEmit::frame(root, run_id, &throwaway, &private_dir, true),
            )
            .map_err(|error| format!("frame emit failed: {error}"))?;
        reject_incomplete_frame(shots.skipped_objects.len())?;
        Ok(shots.public)
    }

    fn lifecycle_error(stage: LifecycleStage, message: String) -> EnginePortError {
        EnginePortError::Lifecycle {
            stage,
            message,
            source: None,
        }
    }
}

impl EnginePort for UtsushiReallivePort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Launch)?;
        if self.launched {
            return Ok(());
        }

        // --- 1. ONE real MULTI-SCENE replay observation: follow the real
        //         RealLive scene-dispatch ACROSS scene boundaries (jump
        //         farcall / return into another SEEN present in the store) to
        //         recover a bounded, continuous play-order stream that spans
        //         ≥1 scene boundary — the play-loop a player walks THROUGH the
        //         game, not one scene in isolation. Each segment carries its
        //         OWN single-pass play-order messages + its OWN composited
        //         background (so scene B renders with B's background).
        let observe_opts = ReplayOpts {
            step_budget: OBSERVE_STEP_BUDGET,
            stop_at_first_pause: false,
        };
        let playthrough = self.engine.observe_playthrough_with_assets(
            self.entry_scene,
            &observe_opts,
            if request.operation == RuntimeOperation::ReplayReview {
                // Replay-review preserves the historical single-scene
                // evidence contract. Normal trace/capture lifecycles retain
                // the bounded multi-scene playthrough.
                1
            } else {
                PLAYTHROUGH_MAX_SCENES
            },
            Arc::clone(&self.assets),
        );

        if request.operation == RuntimeOperation::ReplayReview {
            // This is the port-owned equivalent of the old CLI replay log.
            // `ReplayEngine::replay_from` is an instance method over the
            // already-staged store, so no free-function driver bypasses the
            // EnginePort/Runner lifecycle.
            self.replay_log = Some(
                self.engine
                    .replay_from(self.entry_scene, &ReplayOpts::default()),
            );
        }

        // Entry-scene drive diagnostics (the capability the manifest advertises
        // is the entry scene's; step total is aggregated across the chain).
        let entry_observation = playthrough
            .segments
            .first()
            .map(|segment| &segment.observation.scene);
        self.observation_steps = playthrough
            .segments
            .iter()
            .map(|segment| segment.observation.scene.steps)
            .sum();
        self.reached_natural_terminus =
            entry_observation.is_some_and(|scene| scene.reached_natural_terminus);

        // Audio across every observed scene, in dispatch order.
        let audio: Vec<AudioEvent> = playthrough
            .segments
            .iter()
            .flat_map(|segment| segment.observation.scene.audio_events.iter())
            .map(to_substrate_audio)
            .collect();

        // The whole multi-scene play-order stream (all segments flattened in
        // dispatch order) — the exact `TextLine`s that flow, single pass, to
        // the substrate text sink. `frame_text_lines` is this full stream; the
        // rendered playthrough sequence (below) is a bounded through-line
        // drawn from it.
        let text_lines: Vec<TextLine> = playthrough
            .segments
            .iter()
            .flat_map(|segment| segment.observation.play_order_lines.iter().cloned())
            .collect();
        let overlay_lines: Vec<String> = text_lines.iter().map(|line| line.text.clone()).collect();

        // --- 2. Frame: a bounded MULTI-SCENE PLAYTHROUGH SEQUENCE. Render a
        //         through-line that CROSSES the scene boundary: leading
        //         messages of scene A over A's background, then leading
        //         messages of scene B over B's OWN background, in dispatch
        //         order — each message to its OWN E2 frame (its speaker
        //         name-box + word-wrap). Per-scene capping guarantees a long
        //         scene A cannot consume the whole budget before scene B
        //         appears (so the render actually crosses the boundary); the
        //         total is capped at `resolved_playthrough_max()`. For a
        //         SINGLE-scene playthrough the per-scene cap is the whole
        //         budget, so this reduces to the leading-prefix render.
        let playthrough_max = self.resolved_playthrough_max();
        let segment_count = playthrough.segments.len();
        let per_scene_cap = if segment_count <= 1 {
            playthrough_max
        } else {
            (playthrough_max / segment_count).max(1)
        };
        let mut frames: Vec<FrameArtifact> = Vec::new();
        let mut rendered_messages: Vec<String> = Vec::new();
        let mut rendered_scene_ids: Vec<SceneId> = Vec::new();
        if let Some(root) = request.artifact_root {
            'segments: for segment in &playthrough.segments {
                for message in segment
                    .observation
                    .play_order_lines
                    .iter()
                    .take(per_scene_cap)
                {
                    if rendered_messages.len() >= playthrough_max {
                        break 'segments;
                    }
                    request.cancellation.check(LifecycleStage::Launch)?;
                    let frame = self
                        .render_frame(&segment.observation.scene, message, root, request.run_id)
                        .map_err(|error| Self::lifecycle_error(LifecycleStage::Launch, error))?;
                    frames.push(frame);
                    rendered_messages.push(message.text.clone());
                    rendered_scene_ids.push(segment.scene_id);
                }
            }
        }

        // --- 3. Drive the `Snapshot` capability: snapshot/restore identity
        //         at every tick boundary of the entry scene.
        let snapshot_opts = ReplayOpts {
            step_budget: SNAPSHOT_PROOF_STEP_BUDGET,
            stop_at_first_pause: false,
        };
        let snapshot_report = self
            .engine
            .verify_branch_snapshot_restore_each_tick(
                self.entry_scene,
                &snapshot_opts,
                HeadlessChoicePolicy::AlwaysFirst,
            )
            .map_err(|error| {
                Self::lifecycle_error(
                    LifecycleStage::Launch,
                    format!("snapshot/restore identity verification failed: {error}"),
                )
            })?;
        self.snapshot_ticks_verified = snapshot_report.ticks_verified;

        // --- 4. Drive the `DeterministicReplay` capability: two replays of
        //         the entry scene must serialise byte-identically.
        let determinism_opts = ReplayOpts {
            step_budget: DETERMINISM_PROOF_STEP_BUDGET,
            stop_at_first_pause: false,
        };
        let first = deterministic_json_after_successful_replay(
            self.engine.replay_from(self.entry_scene, &determinism_opts),
        )
        .map_err(|error| Self::lifecycle_error(LifecycleStage::Launch, error))?;
        let second_log = self.engine.replay_from(self.entry_scene, &determinism_opts);
        let second = deterministic_json_after_successful_replay(second_log)
            .map_err(|error| Self::lifecycle_error(LifecycleStage::Launch, error))?;
        self.deterministic_replay_verified = first == second;
        if !self.deterministic_replay_verified {
            return Err(Self::lifecycle_error(
                LifecycleStage::Launch,
                "deterministic replay diverged: two replays of the entry scene produced \
                 non-identical JSON"
                    .to_string(),
            ));
        }

        self.frame_text_lines = overlay_lines;
        self.playthrough_frame_messages = rendered_messages;
        self.playthrough_frame_scene_ids = rendered_scene_ids;
        self.buffered_text = text_lines;
        self.buffered_frames = frames;
        self.buffered_audio = audio;
        self.launched = true;
        Ok(())
    }

    fn observe(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Observe)?;
        if self.emitted {
            return Ok(());
        }
        for line in std::mem::take(&mut self.buffered_text) {
            self.text_sink.emit_line(line).map_err(|error| {
                Self::lifecycle_error(LifecycleStage::Observe, error.to_string())
            })?;
        }
        for frame in std::mem::take(&mut self.buffered_frames) {
            self.frame_sink.emit_frame(frame).map_err(|error| {
                Self::lifecycle_error(LifecycleStage::Observe, error.to_string())
            })?;
        }
        for event in std::mem::take(&mut self.buffered_audio) {
            self.audio_sink.emit_event(event).map_err(|error| {
                Self::lifecycle_error(LifecycleStage::Observe, error.to_string())
            })?;
        }
        self.emitted = true;
        Ok(())
    }

    fn sink_set(&self) -> &SinkSet {
        &self.sink_set
    }

    fn capture(&mut self, request: &PortRequest<'_>) -> Result<CaptureOutcome, EnginePortError> {
        request.cancellation.check(LifecycleStage::Capture)?;
        let root = request.artifact_root.ok_or_else(|| {
            Self::lifecycle_error(
                LifecycleStage::Capture,
                "capture requires a managed artifact root".to_string(),
            )
        })?;
        let uri = runtime_artifact_uri(
            request.run_id,
            RuntimeArtifactKind::TraceLog,
            "reallive-port-capture",
        )
        .map_err(|error| {
            Self::lifecycle_error(
                LifecycleStage::Capture,
                format!("capture uri build failed: {error}"),
            )
        })?;
        let summary = format!(
            "utsushi-reallive port: entry_scene={} steps={} snapshot_ticks_verified={} \
             deterministic_replay_verified={}",
            self.entry_scene,
            self.observation_steps,
            self.snapshot_ticks_verified,
            self.deterministic_replay_verified,
        );
        let path = root
            .write_bytes(&uri, summary.as_bytes())
            .map_err(|error| {
                Self::lifecycle_error(
                    LifecycleStage::Capture,
                    format!("capture write failed: {error}"),
                )
            })?;
        Ok(CaptureOutcome::new(uri)
            .with_path(path)
            .with_summary(summary))
    }

    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError> {
        if self.shut_down {
            Ok(PortShutdownOutcome::already_shut_down())
        } else {
            self.shut_down = true;
            Ok(PortShutdownOutcome::clean())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{deterministic_json_after_successful_replay, reject_incomplete_frame};
    use crate::ReplayLog;
    use crate::replay::{REPLAY_LOG_SCHEMA_VERSION, ReplayEvent, ReplayOutcome};

    #[test]
    fn incomplete_frame_rejects_the_port_success_path() {
        let error = reject_incomplete_frame(1)
            .expect_err("a dropped object must not be published as a successful port frame");
        assert_eq!(error, "incomplete frame: 1 object(s) dropped during render");
        assert!(reject_incomplete_frame(0).is_ok());
    }

    #[test]
    fn fatal_replay_cannot_satisfy_determinism_proof() {
        let error = deterministic_json_after_successful_replay(ReplayLog {
            schema_version: REPLAY_LOG_SCHEMA_VERSION.to_string(),
            scene_id: 1,
            events: Vec::<ReplayEvent>::new(),
            final_outcome: ReplayOutcome::FatalDiagnostic {
                code: "synthetic.vm.failure".to_string(),
                byte_offset_in_scene: 0,
            },
        })
        .expect_err("identical fatal logs are not successful deterministic replay proof");
        assert!(error.contains("did not complete successfully"));
    }
}
