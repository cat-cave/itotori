use super::*;

pub fn validate_reference_capture_corpus(
    corpus_path: &Path,
) -> UtsushiResult<ReferenceCaptureValidationReport> {
    let corpus_text = fs::read_to_string(corpus_path)?;
    let corpus_value: Value = serde_json::from_str(&corpus_text)?;
    reject_unredacted_local_paths_in_value("referenceCaptureCorpus", &corpus_value)?;
    let corpus: ReferenceCaptureCorpus = serde_json::from_value(corpus_value)?;
    corpus.validate_schema(corpus_path)?;

    let base_dir = corpus_path.parent().unwrap_or_else(|| Path::new("."));
    let artifact_store_root = resolve_corpus_path(base_dir, &corpus.artifact_store_root);
    validate_artifact_store_root(corpus_path, &artifact_store_root)?;

    let mut artifacts_validated = 0;
    for fixture in &corpus.fixtures {
        fixture.validate_required_metadata(corpus_path)?;
        artifacts_validated +=
            validate_reference_capture_fixture(base_dir, &artifact_store_root, fixture)?;
    }

    Ok(ReferenceCaptureValidationReport {
        schema_version: VALIDATION_REPORT_SCHEMA_VERSION.to_string(),
        corpus_path: corpus_path.display().to_string(),
        fixtures_validated: corpus.fixtures.len(),
        artifacts_validated,
    })
}

fn validate_reference_capture_fixture(
    base_dir: &Path,
    artifact_store_root: &Path,
    fixture: &ReferenceCaptureFixture,
) -> UtsushiResult<usize> {
    let label = format!("reference capture fixture {}", fixture.fixture_id);
    let report_path = resolve_corpus_path(base_dir, &fixture.runtime_report_path);
    let report: Value = serde_json::from_str(&fs::read_to_string(&report_path)?)?;
    reject_unredacted_local_paths_in_value(&format!("{label} runtime report"), &report)?;
    validate_runtime_evidence_report_value(&report)
        .map_err(|error| format!("{label} runtime report contract invalid: {error}"))?;

    if report["schemaVersion"] != "0.2.0" {
        return Err(format!("{label} runtime report schemaVersion must be 0.2.0").into());
    }
    let runtime_report_id = require_report_string(&report, "runtimeReportId", &label)?;
    let report_evidence_tier = require_report_string(&report, "evidenceTier", &label)?;
    if report_evidence_tier != fixture.evidence_tier.as_str() {
        return Err(format!(
            "{label} evidenceTier {} does not match runtime report evidenceTier {report_evidence_tier}",
            fixture.evidence_tier.as_str()
        )
        .into());
    }

    let events = parse_observation_events(&report, &label)?;
    validate_observation_metadata(&label, fixture, &events)?;

    let captures = report_array(&report, "captures", &label)?;
    reject_static_runtime_claims(&report, captures, fixture, &label)?;

    let report_artifacts = collect_report_artifacts(&report, &events, &label)?;
    validate_screenshot_artifact_runs(runtime_report_id, &report_artifacts, &label)?;
    validate_artifact_hashes(artifact_store_root, fixture, &report_artifacts, &label)
}

fn parse_observation_events(
    report: &Value,
    label: &str,
) -> UtsushiResult<Vec<ParsedObservationEvent>> {
    report_array(report, "observationHookEvents", label)?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            ParsedObservationEvent::from_value(
                value,
                &format!("{label} observationHookEvents[{index}]"),
            )
        })
        .collect()
}

fn validate_observation_metadata(
    label: &str,
    fixture: &ReferenceCaptureFixture,
    events: &[ParsedObservationEvent],
) -> UtsushiResult<()> {
    let expected_ids = fixture
        .observation_event_ids
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    if expected_ids.len() != fixture.observation_event_ids.len() {
        return Err(format!("{label} observationEventIds must be unique").into());
    }

    let actual_ids = events
        .iter()
        .map(|event| event.event_id.clone())
        .collect::<HashSet<_>>();
    if actual_ids != expected_ids {
        return Err(format!(
            "{label} observationEventIds must name exactly the runtime report observation hook event ids"
        )
        .into());
    }
    for artifact in &fixture.artifact_hashes {
        if !expected_ids.contains(&artifact.observation_event_id) {
            return Err(format!(
                "{label} artifact {} observationEventId {} must name one of fixture observationEventIds",
                artifact.artifact_id, artifact.observation_event_id
            )
            .into());
        }
    }

    for event in events {
        if event.runtime_target_id != fixture.runtime_target_id {
            return Err(format!(
                "{label} event {} runtimeTargetId {} does not match fixture runtimeTargetId {}",
                event.event_id, event.runtime_target_id, fixture.runtime_target_id
            )
            .into());
        }
        let Some(source_revision) = &event.source_revision else {
            return Err(format!(
                "{label} event {} must include sourceRevision",
                event.event_id
            )
            .into());
        };
        if source_revision.source_id != fixture.source_revision.source_id
            || source_revision.revision_id != fixture.source_revision.revision_id
            || source_revision.content_hash != fixture.source_revision.content_hash
        {
            return Err(format!(
                "{label} event {} sourceRevision does not match fixture sourceRevision",
                event.event_id
            )
            .into());
        }
        if event.redaction_status != fixture.redaction_status {
            return Err(format!(
                "{label} event {} redaction status {} does not match fixture redactionStatus {}",
                event.event_id,
                event.redaction_status.as_str(),
                fixture.redaction_status.as_str()
            )
            .into());
        }
    }
    Ok(())
}

fn reject_static_runtime_claims(
    report: &Value,
    captures: &[Value],
    fixture: &ReferenceCaptureFixture,
    label: &str,
) -> UtsushiResult<()> {
    let features = report
        .pointer("/controlledPlaybackSession/featuresUsed")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    let capability_class = report
        .pointer("/controlledPlaybackSession/capabilityClass")
        .and_then(Value::as_str);
    let uses_capture_evidence = features.iter().any(|feature| {
        matches!(
            *feature,
            "launch" | "frame_capture" | "screenshot" | "instrumentation_hooks"
        )
    });
    if fixture.evidence_tier >= EvidenceTier::E2
        && (captures.is_empty()
            || !uses_capture_evidence
            || capability_class == Some("static_trace")
            || features.iter().all(|feature| *feature == "static_trace"))
    {
        return Err(format!(
            "{label} rejects static reads labeled as runtime evidence; reference captures require frame capture evidence"
        )
        .into());
    }
    Ok(())
}

fn collect_report_artifacts(
    report: &Value,
    events: &[ParsedObservationEvent],
    label: &str,
) -> UtsushiResult<Vec<ReportArtifactRef>> {
    let mut artifacts = Vec::new();
    for (index, capture) in report_array(report, "captures", label)?.iter().enumerate() {
        let artifact = parse_report_artifact_ref(
            &capture["artifactRef"],
            &format!("{label} captures[{index}].artifactRef"),
        )?;
        artifacts.push(artifact);
    }
    for event in events {
        if let ParsedObservationPayload::Frame {
            artifact_ref: Some(artifact_ref),
        } = &event.payload
        {
            artifacts.push(ReportArtifactRef {
                artifact_id: artifact_ref.artifact_id.clone(),
                artifact_kind: artifact_ref.artifact_kind.clone(),
                observation_event_id: Some(event.event_id.clone()),
                uri: artifact_ref.uri.clone(),
                media_type: artifact_ref.media_type.clone(),
            });
        }
    }
    Ok(artifacts)
}

fn parse_report_artifact_ref(value: &Value, label: &str) -> UtsushiResult<ReportArtifactRef> {
    let artifact_ref: ObservationArtifactRef = serde_json::from_value(value.clone())
        .map_err(|error| format!("{label} invalid artifactRef: {error}"))?;
    artifact_ref.validate()?;
    Ok(ReportArtifactRef {
        artifact_id: artifact_ref.artifact_id,
        artifact_kind: artifact_ref.artifact_kind,
        observation_event_id: None,
        uri: artifact_ref.uri,
        media_type: artifact_ref.media_type,
    })
}

fn validate_screenshot_artifact_runs(
    runtime_report_id: &str,
    report_artifacts: &[ReportArtifactRef],
    label: &str,
) -> UtsushiResult<()> {
    for artifact in report_artifacts {
        if artifact.artifact_kind != "screenshot" {
            continue;
        }
        let run_id = runtime_artifact_run_segment(&artifact.uri)?;
        if run_id != runtime_report_id {
            return Err(format!(
                "{label} screenshot artifact {} run segment {run_id} must match runtimeReportId {runtime_report_id}",
                artifact.artifact_id
            )
            .into());
        }
    }
    Ok(())
}

fn validate_artifact_hashes(
    artifact_store_root: &Path,
    fixture: &ReferenceCaptureFixture,
    report_artifacts: &[ReportArtifactRef],
    label: &str,
) -> UtsushiResult<usize> {
    let mut expected_by_key = HashMap::new();
    for artifact in &fixture.artifact_hashes {
        expected_by_key.insert(
            (
                artifact.artifact_id.as_str(),
                artifact.observation_event_id.as_str(),
                artifact.uri.as_str(),
            ),
            artifact,
        );
    }

    for artifact in report_artifacts {
        if artifact.artifact_kind == "screenshot"
            && artifact.observation_event_id.is_none()
            && !fixture.artifact_hashes.iter().any(|expected| {
                expected.artifact_id == artifact.artifact_id && expected.uri == artifact.uri
            })
        {
            return Err(format!(
                "{label} top-level capture screenshot artifact {} at {} is missing byte/hash provenance in artifactHashes",
                artifact.artifact_id, artifact.uri
            )
            .into());
        }
        if artifact.artifact_kind == "screenshot"
            && artifact.observation_event_id.is_some()
            && !expected_by_key.contains_key(&(
                artifact.artifact_id.as_str(),
                artifact.observation_event_id.as_deref().unwrap_or_default(),
                artifact.uri.as_str(),
            ))
        {
            return Err(format!(
                "{label} screenshot artifact {} from observation event {} at {} is missing from artifactHashes",
                artifact.artifact_id,
                artifact.observation_event_id.as_deref().unwrap_or("<none>"),
                artifact.uri
            )
            .into());
        }
    }

    let artifact_root = RuntimeArtifactRoot::new(artifact_store_root);
    let canonical_root = fs::canonicalize(artifact_store_root)?;
    for expected in &fixture.artifact_hashes {
        let Some(report_artifact) = report_artifacts.iter().find(|artifact| {
            artifact.artifact_id == expected.artifact_id
                && artifact.observation_event_id.as_deref()
                    == Some(expected.observation_event_id.as_str())
                && artifact.uri == expected.uri
        }) else {
            return Err(format!(
                "{label} artifactHashes entry {} for observation event {} at {} is not referenced by the runtime report",
                expected.artifact_id, expected.observation_event_id, expected.uri
            )
            .into());
        };
        if report_artifact.artifact_kind != "screenshot" {
            return Err(format!(
                "{label} artifact {} must be reported as screenshot evidence",
                expected.artifact_id
            )
            .into());
        }
        if let (Some(expected_media_type), Some(actual_media_type)) =
            (&expected.media_type, &report_artifact.media_type)
            && expected_media_type != actual_media_type
        {
            return Err(format!(
                "{label} artifact {} mediaType {} does not match runtime report mediaType {}",
                expected.artifact_id, expected_media_type, actual_media_type
            )
            .into());
        }

        let artifact_path = artifact_root.artifact_path(&expected.uri)?;
        if !artifact_path.is_file() {
            return Err(format!(
                "{label} artifact {} is not present in the artifact store at {}",
                expected.artifact_id,
                artifact_path.display()
            )
            .into());
        }
        let canonical_artifact = fs::canonicalize(&artifact_path)?;
        if !canonical_artifact.starts_with(&canonical_root) {
            return Err(format!(
                "{label} artifact {} resolves outside the artifact store",
                expected.artifact_id
            )
            .into());
        }

        let bytes = fs::read(&artifact_path)?;
        if bytes.len() as u64 != expected.bytes {
            return Err(format!(
                "{label} artifact {} byte count {} does not match {}",
                expected.artifact_id,
                expected.bytes,
                bytes.len()
            )
            .into());
        }
        let actual_sha256 = sha256_hex(&bytes);
        if actual_sha256 != expected.sha256 {
            return Err(format!(
                "{label} artifact {} sha256 {} does not match {}",
                expected.artifact_id, expected.sha256, actual_sha256
            )
            .into());
        }
    }

    Ok(fixture.artifact_hashes.len())
}

fn validate_artifact_store_root(
    corpus_path: &Path,
    artifact_store_root: &Path,
) -> UtsushiResult<()> {
    if !artifact_store_root.is_dir() {
        return Err(format!(
            "{} artifactStoreRoot {} is not a directory",
            corpus_path.display(),
            artifact_store_root.display()
        )
        .into());
    }
    let marker = artifact_store_root.join(RUNTIME_ARTIFACT_ROOT_MARKER);
    if !marker.is_file() {
        return Err(format!(
            "{} artifactStoreRoot {} is missing {}",
            corpus_path.display(),
            artifact_store_root.display(),
            RUNTIME_ARTIFACT_ROOT_MARKER
        )
        .into());
    }
    Ok(())
}

fn resolve_corpus_path(base_dir: &Path, path: &str) -> PathBuf {
    let path = Path::new(path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base_dir.join(path)
    }
}

fn runtime_artifact_run_segment(uri: &str) -> UtsushiResult<String> {
    let relative = validate_runtime_artifact_uri(uri)?;
    relative
        .components()
        .next()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .ok_or_else(|| format!("runtime artifact uri is missing run segment: {uri}").into())
}
