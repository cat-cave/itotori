use super::*;

/// Build the narrow MV/MZ screenshot-evidence report from the parsed fixture
/// document and one screenshot reference per command.
///
/// The linkage is positional-by-frame: command `i` (frame `i + 1`) produces the
/// trace event and screenshot capture that share command `i`'s bridge unit ref
/// and `screenshots[i]` is the artifactRef that capture points at. The pure
/// builder performs NO IO and needs NO browser — the same report is produced
/// whether `screenshots` come from synthetic placeholders or a live capture.
pub fn build_mv_mz_screenshot_evidence(
    fixture: &Value,
    screenshots: &[ScreenshotEvidenceRef],
    capture_metadata: &CaptureMetadata,
) -> UtsushiResult<Value> {
    let game_id = fixture
        .get("gameId")
        .and_then(Value::as_str)
        .ok_or("mvmz fixture missing gameId")?;
    let source_locale = fixture
        .get("sourceLocale")
        .and_then(Value::as_str)
        .unwrap_or("und");
    let adapter = fixture
        .get("adapter")
        .ok_or("mvmz fixture missing adapter")?;
    let adapter_name = adapter
        .get("name")
        .and_then(Value::as_str)
        .ok_or("mvmz fixture adapter missing name")?;
    let adapter_version = adapter
        .get("version")
        .and_then(Value::as_str)
        .ok_or("mvmz fixture adapter missing version")?;

    let commands = fixture
        .get("commands")
        .and_then(Value::as_array)
        .ok_or("mvmz fixture missing commands array")?;
    if commands.is_empty() {
        return Err("mvmz fixture commands must not be empty".into());
    }
    if commands.len() != screenshots.len() {
        return Err(format!(
            "mvmz screenshot evidence needs one screenshot per command: {} commands, {} screenshots",
            commands.len(),
            screenshots.len()
        )
        .into());
    }

    let runtime_report_id =
        deterministic_uuid7(EVIDENCE_UUID_NAMESPACE, &format!("report-{game_id}"));

    let mut trace_events = Vec::with_capacity(commands.len());
    let mut captures = Vec::with_capacity(commands.len());
    let mut observation_events = Vec::with_capacity(commands.len());
    let mut bridge_refs = Vec::with_capacity(commands.len());
    let capture_metadata_json = capture_metadata.to_json();

    for (index, command_value) in commands.iter().enumerate() {
        let command = MvMzCommand::parse(command_value, index)?;
        let frame = u64::try_from(index + 1)?;
        let bridge_unit_ref = command.bridge_unit_ref();
        let mv_command_ref = command.mv_command_ref();
        let screenshot = &screenshots[index];

        let trace_event_id = deterministic_uuid7(
            EVIDENCE_UUID_NAMESPACE,
            &format!("trace-{}", command.source_unit_key),
        );
        let capture_id = deterministic_uuid7(
            EVIDENCE_UUID_NAMESPACE,
            &format!("capture-{}", command.source_unit_key),
        );
        let observation_id = deterministic_uuid7(
            EVIDENCE_UUID_NAMESPACE,
            &format!("frame-observation-{}", command.source_unit_key),
        );

        trace_events.push(json!({
            "traceEventId": trace_event_id,
            "eventKind": "text_observed",
            "bridgeUnitRef": bridge_unit_ref,
            "frame": frame,
            "traceKey": command.source_unit_key,
            "observedText": command.source_text,
            "mvCommandRef": mv_command_ref,
        }));

        // The screenshot capture links back to the trace event it evidences
        // (evidencesTraceEventId) and forward to the managed screenshot
        // artifactRef, sharing the trace's bridgeUnitRef + frame.
        captures.push(json!({
            "captureId": capture_id,
            "bridgeUnitRef": bridge_unit_ref,
            "evidenceTier": EvidenceTier::E2.as_str(),
            "frame": frame,
            "width": capture_metadata.viewport_width,
            "height": capture_metadata.viewport_height,
            "evidencesTraceEventId": trace_event_id,
            "mvCommandRef": mv_command_ref,
            "captureMetadata": capture_metadata_json,
            "artifactRef": screenshot.to_artifact_ref_json(),
        }));

        // Frame observation-hook event, mirroring the browser
        // capture path so the screenshot evidence is also attached on the
        // observation-hook surface.
        observation_events.push(json!({
            "schemaVersion": FIXTURE_OBSERVATION_HOOK_SCHEMA_LITERAL,
            "eventId": observation_id,
            "observedAt": "2026-06-17T00:00:00.000Z",
            "eventKind": "frame",
            "runtimeTargetId": format!("mvmz:{game_id}"),
            "adapterId": {
                "name": adapter_name,
                "version": adapter_version,
            },
            "evidenceTier": EvidenceTier::E2.as_str(),
            "environment": {
                "runtime": "mvmz-screenshot-evidence",
                "engine": "rpg_maker_mv_mz",
                "display": capture_metadata.adapter,
                "locale": source_locale,
            },
            "sourceRevision": {
                "sourceId": game_id,
                "revisionId": "mvmz-screenshot-evidence-v0.1",
            },
            "bridgeRefs": [bridge_unit_ref],
            "redaction": {"status": "not_required"},
            "payload": {
                "payloadKind": "frame",
                "frame": frame,
                "width": capture_metadata.viewport_width,
                "height": capture_metadata.viewport_height,
                "evidencesTraceEventId": trace_event_id,
                "artifactRef": screenshot.to_artifact_ref_json(),
            },
        }));

        bridge_refs.push(bridge_unit_ref);
    }

    Ok(json!({
        "schemaVersion": "0.2.0",
        "runtimeReportId": runtime_report_id,
        "sourceLocale": source_locale,
        "adapterName": adapter_name,
        "adapterVersion": adapter_version,
        "fidelityTier": "layout_probe",
        "evidenceTier": EvidenceTier::E2.as_str(),
        "status": "passed",
        "createdAt": "2026-06-17T00:00:00.000Z",
        "captureMetadata": capture_metadata_json,
        "traceEvents": trace_events,
        "observationHookEvents": observation_events,
        "branchEvents": [],
        "captures": captures,
        "recordings": [],
        "approximations": [
            {
                "approximationId": deterministic_uuid7(EVIDENCE_UUID_NAMESPACE, &format!("approximation-{game_id}")),
                "approximationTier": "layout_probe",
                "scope": "mvmz screenshot evidence",
                "description": "MV/MZ map / common-event command trace events are linked to screenshot artifactRefs by bridge unit ref + frame; this narrow evidence proves screenshot attachment, not reference-runtime fidelity.",
                "affectedBridgeUnitRefs": bridge_refs,
                "evidenceTierCeiling": EvidenceTier::E2.as_str(),
            }
        ],
        "validationFindings": [],
        "limitations": [
            "Synthetic public MV/MZ fixture; screenshot artifactRefs reference managed runtime artifacts, not live commercial-engine pixels.",
            "Narrow screenshot-evidence attachment only; not the broad runtime conformance manifest.",
        ],
    }))
}
