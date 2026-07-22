use super::*;

impl EnginePort for FixtureEnginePort {
    const MANIFEST: PortManifest = Self::MANIFEST;

    fn launch(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Launch)?;
        let source = crate::read_source_for_engine_port(request.input_root).map_err(|error| {
            EnginePortError::Lifecycle {
                stage: LifecycleStage::Launch,
                message: error.to_string(),
                source: Some(error),
            }
        })?;

        let game_id = source["gameId"].as_str().unwrap_or("fixture").to_string();
        let units = source["units"].as_array().cloned().unwrap_or_default();
        if units.is_empty() {
            return Err(EnginePortError::Lifecycle {
                stage: LifecycleStage::Launch,
                message: "fixture source has no units".to_string(),
                source: None,
            });
        }

        self.units_loaded = units.len() as u64;
        self.lines_emitted = 0;
        self.frames_emitted = 0;
        self.queued_lines.clear();
        self.queued_frames.clear();

        for (index, unit) in units.iter().enumerate() {
            let source_unit_key = unit["sourceUnitKey"].as_str().unwrap_or("").to_string();
            let text = unit["targetText"]
                .as_str()
                .or_else(|| unit["sourceText"].as_str())
                .unwrap_or("")
                .to_string();
            self.queued_lines.push(TextLine {
                line_id: deterministic_line_id(&game_id, index),
                evidence_tier: EvidenceTier::E1,
                text,
                speaker: unit["speaker"].as_str().map(ToString::to_string),
                color: None,
                text_surface: unit["textSurface"].as_str().map(ToString::to_string),
                bridge_ref: Some(ObservationBridgeRef {
                    bridge_unit_id: Some(deterministic_bridge_unit_id(&game_id, index)),
                    source_unit_key: Some(source_unit_key),
                    runtime_object_id: None,
                }),
                source_asset: AssetId::parse(&format!("vfs://fixture/units/unit-{index:03}.json"))
                    .ok(),
                byte_offset_in_scene: None,
                body_shift_jis: None,
            });
        }

        if !matches!(request.operation, utsushi_core::RuntimeOperation::Trace) {
            // Capture/smoke reports must not announce a frame artifact URI that
            // differs from the file materialised by `capture`. Trace does not
            // run the capture stage, so it must not queue this screenshot ref.
            let artifact_id = FIXTURE_CAPTURE_ARTIFACT_ID.to_string();
            let uri = utsushi_core::runtime_artifact_uri(
                request.run_id,
                RuntimeArtifactKind::Screenshot,
                &artifact_id,
            )
            .map_err(|error| EnginePortError::Lifecycle {
                stage: LifecycleStage::Launch,
                message: format!("fixture capture uri build failed: {error}"),
                source: None,
            })?;
            let bridge_ref = ObservationBridgeRef {
                bridge_unit_id: Some(deterministic_bridge_unit_id(&game_id, 0)),
                source_unit_key: units[0]
                    .get("sourceUnitKey")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                runtime_object_id: None,
            };
            self.queued_frames.push(FrameArtifact {
                frame_id: artifact_id.clone(),
                evidence_tier: EvidenceTier::E2,
                artifact_ref: ObservationArtifactRef {
                    artifact_id,
                    artifact_kind: "screenshot".to_string(),
                    uri,
                    media_type: Some("image/png".to_string()),
                },
                width: Some(320),
                height: Some(180),
                frame_index: 1,
                bridge_ref: Some(bridge_ref),
            });
        }

        self.state = PortState::Launched;
        Ok(())
    }

    fn observe(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError> {
        request.cancellation.check(LifecycleStage::Observe)?;
        if self.state == PortState::ShutDown {
            return Err(EnginePortError::Lifecycle {
                stage: LifecycleStage::Observe,
                message: "fixture port observed after shutdown".to_string(),
                source: None,
            });
        }
        // Drain a single text line first; once those are exhausted, push
        // the queued frame; once both queues are empty the runner sees an
        // empty tick and terminates the observation phase.
        if let Some(line) = pop_front(&mut self.queued_lines) {
            self.sinks
                .text
                .emit_line(line)
                .map_err(|error| EnginePortError::Lifecycle {
                    stage: LifecycleStage::Observe,
                    message: format!("text emit failed: {error}"),
                    source: None,
                })?;
            self.lines_emitted = self.lines_emitted.saturating_add(1);
            return Ok(());
        }
        if let Some(frame) = pop_front(&mut self.queued_frames) {
            self.sinks
                .frame
                .emit_frame(frame)
                .map_err(|error| EnginePortError::Lifecycle {
                    stage: LifecycleStage::Observe,
                    message: format!("frame emit failed: {error}"),
                    source: None,
                })?;
            self.frames_emitted = self.frames_emitted.saturating_add(1);
            return Ok(());
        }
        self.state = PortState::Drained;
        Ok(())
    }

    fn sink_set(&self) -> &SinkSet {
        self.sinks.sink_set()
    }

    fn capture(&mut self, request: &PortRequest<'_>) -> Result<CaptureOutcome, EnginePortError> {
        request.cancellation.check(LifecycleStage::Capture)?;
        let root = request
            .artifact_root
            .ok_or_else(|| EnginePortError::Lifecycle {
                stage: LifecycleStage::Capture,
                message: "fixture capture requires an artifact root".to_string(),
                source: None,
            })?;
        let uri = utsushi_core::runtime_artifact_uri(
            request.run_id,
            RuntimeArtifactKind::Screenshot,
            FIXTURE_CAPTURE_ARTIFACT_ID,
        )
        .map_err(|error| EnginePortError::Lifecycle {
            stage: LifecycleStage::Capture,
            message: format!("fixture capture uri build failed: {error}"),
            source: None,
        })?;
        let path = root
            .write_bytes(
                &uri,
                b"utsushi fixture deterministic screenshot placeholder\n",
            )
            .map_err(|error| EnginePortError::Lifecycle {
                stage: LifecycleStage::Capture,
                message: format!("fixture capture write failed: {error}"),
                source: None,
            })?;
        self.capture_target = Some(path.clone());
        Ok(CaptureOutcome::new(uri)
            .with_path(path)
            .with_summary("utsushi-fixture deterministic capture"))
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
