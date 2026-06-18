use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use utsushi_core::{
    EvidenceTier, ObservationArtifactRef, ObservationHookEvent, ObservationHookPayload,
    ObservationRedactionStatus, RUNTIME_ARTIFACT_ROOT_MARKER, RuntimeArtifactRoot, UtsushiResult,
    validate_runtime_artifact_uri, validate_runtime_evidence_report_value,
};

const REFERENCE_CAPTURE_CORPUS_SCHEMA_VERSION: &str = "0.1.0";
const VALIDATION_REPORT_SCHEMA_VERSION: &str = "0.1.0";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceCaptureValidationReport {
    pub schema_version: String,
    pub corpus_path: String,
    pub fixtures_validated: usize,
    pub artifacts_validated: usize,
}

impl ReferenceCaptureValidationReport {
    pub fn to_json_value(&self) -> UtsushiResult<Value> {
        Ok(serde_json::to_value(self)?)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReferenceCaptureCorpus {
    schema_version: String,
    artifact_store_root: String,
    fixtures: Vec<ReferenceCaptureFixture>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReferenceCaptureFixture {
    fixture_id: String,
    runtime_report_path: String,
    source_revision: ReferenceCaptureSourceRevision,
    runtime_target_id: String,
    observation_event_ids: Vec<String>,
    artifact_hashes: Vec<ReferenceCaptureArtifactHash>,
    evidence_tier: EvidenceTier,
    redaction_status: ObservationRedactionStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReferenceCaptureSourceRevision {
    source_id: String,
    revision_id: Option<String>,
    content_hash: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReferenceCaptureArtifactHash {
    artifact_id: String,
    observation_event_id: String,
    uri: String,
    sha256: String,
    bytes: u64,
    media_type: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ReportArtifactRef {
    artifact_id: String,
    artifact_kind: String,
    observation_event_id: Option<String>,
    uri: String,
    media_type: Option<String>,
}

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

impl ReferenceCaptureCorpus {
    fn validate_schema(&self, corpus_path: &Path) -> UtsushiResult<()> {
        if self.schema_version != REFERENCE_CAPTURE_CORPUS_SCHEMA_VERSION {
            return Err(format!(
                "{} schemaVersion must be {REFERENCE_CAPTURE_CORPUS_SCHEMA_VERSION}",
                corpus_path.display()
            )
            .into());
        }
        require_non_blank(corpus_path, "artifactStoreRoot", &self.artifact_store_root)?;
        if self.fixtures.is_empty() {
            return Err(format!("{} fixtures must not be empty", corpus_path.display()).into());
        }
        Ok(())
    }
}

impl ReferenceCaptureFixture {
    fn validate_required_metadata(&self, corpus_path: &Path) -> UtsushiResult<()> {
        let label = format!("{} fixture {}", corpus_path.display(), self.fixture_id);
        require_non_blank(corpus_path, "fixtureId", &self.fixture_id)?;
        require_non_blank(corpus_path, "runtimeReportPath", &self.runtime_report_path)?;
        self.source_revision.validate(corpus_path, &label)?;
        require_non_blank(corpus_path, "runtimeTargetId", &self.runtime_target_id)?;
        require_non_empty_strings(
            corpus_path,
            &label,
            "observationEventIds",
            &self.observation_event_ids,
        )?;
        if self.artifact_hashes.is_empty() {
            return Err(format!("{label} artifactHashes must not be empty").into());
        }
        for artifact in &self.artifact_hashes {
            artifact.validate(corpus_path, &label)?;
        }
        Ok(())
    }
}

impl ReferenceCaptureSourceRevision {
    fn validate(&self, corpus_path: &Path, label: &str) -> UtsushiResult<()> {
        require_non_blank(corpus_path, "sourceRevision.sourceId", &self.source_id)?;
        let has_revision_id = self
            .revision_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
        let has_content_hash = self
            .content_hash
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
        if !has_revision_id && !has_content_hash {
            return Err(
                format!("{label} sourceRevision must name revisionId or contentHash").into(),
            );
        }
        Ok(())
    }
}

impl ReferenceCaptureArtifactHash {
    fn validate(&self, corpus_path: &Path, label: &str) -> UtsushiResult<()> {
        require_non_blank(
            corpus_path,
            "artifactHashes[].artifactId",
            &self.artifact_id,
        )?;
        require_non_blank(
            corpus_path,
            "artifactHashes[].observationEventId",
            &self.observation_event_id,
        )?;
        require_non_blank(corpus_path, "artifactHashes[].uri", &self.uri)?;
        if !is_sha256_hex(&self.sha256) {
            return Err(format!(
                "{label} artifact {} sha256 must be 64 lowercase hex characters",
                self.artifact_id
            )
            .into());
        }
        validate_runtime_artifact_uri(&self.uri)?;
        let relative = validate_runtime_artifact_uri(&self.uri)?;
        let components = relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        if components.get(1).map(String::as_str) != Some("screenshots") {
            return Err(format!(
                "{label} artifact {} must be a screenshot stored under artifacts/utsushi/runtime/<run>/screenshots",
                self.artifact_id
            )
            .into());
        }
        Ok(())
    }
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
) -> UtsushiResult<Vec<ObservationHookEvent>> {
    report_array(report, "observationHookEvents", label)?
        .iter()
        .enumerate()
        .map(|(index, value)| {
            ObservationHookEvent::from_json_value(value.clone()).map_err(|error| {
                format!("{label} observationHookEvents[{index}] invalid envelope: {error}").into()
            })
        })
        .collect()
}

fn validate_observation_metadata(
    label: &str,
    fixture: &ReferenceCaptureFixture,
    events: &[ObservationHookEvent],
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
        if event.redaction.status != fixture.redaction_status {
            return Err(format!(
                "{label} event {} redaction status {} does not match fixture redactionStatus {}",
                event.event_id,
                event.redaction.status.as_str(),
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
    events: &[ObservationHookEvent],
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
        if let ObservationHookPayload::Frame(payload) = &event.payload
            && let Some(artifact_ref) = &payload.artifact_ref
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

fn reject_unredacted_local_paths_in_value(label: &str, value: &Value) -> UtsushiResult<()> {
    reject_unredacted_local_paths_at(label, value)
}

fn reject_unredacted_local_paths_at(path: &str, value: &Value) -> UtsushiResult<()> {
    match value {
        Value::String(text) if looks_like_local_path(text) => {
            Err(format!("{path} contains unredacted local path: {text}").into())
        }
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                reject_unredacted_local_paths_at(&format!("{path}[{index}]"), value)?;
            }
            Ok(())
        }
        Value::Object(map) => {
            for (key, value) in map {
                reject_unredacted_local_paths_at(&format!("{path}.{key}"), value)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn looks_like_local_path(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("artifacts/utsushi/runtime/")
        || lower.starts_with("artifact-store://")
        || lower.contains("<redacted")
        || lower.contains("[redacted")
        || lower.contains("${redacted")
        || lower.contains("__redacted")
    {
        return false;
    }
    lower.starts_with("file:")
        || lower.contains("file://")
        || lower.starts_with("~/")
        || has_unix_absolute_path(&lower)
        || has_windows_absolute_path(value)
        || has_unc_path(value)
}

fn has_unix_absolute_path(value: &str) -> bool {
    value
        .split(|ch: char| {
            ch.is_whitespace()
                || matches!(
                    ch,
                    '"' | '\'' | '(' | ')' | ',' | '<' | '>' | '=' | '`' | '|'
                )
        })
        .map(|token| {
            token.trim_matches(|ch: char| {
                matches!(ch, '.' | ':' | ';' | ']' | '[' | '{' | '}' | '!')
            })
        })
        .any(is_private_unix_path_token)
}

fn is_private_unix_path_token(token: &str) -> bool {
    let Some(rest) = token.strip_prefix('/') else {
        return false;
    };
    let Some((root, tail)) = rest.split_once('/') else {
        return false;
    };
    if root.is_empty() || tail.is_empty() {
        return false;
    }
    let reserved_public_roots = ["artifacts", "assets", "images", "img", "css", "js", "docs"];
    !reserved_public_roots.contains(&root)
}

fn has_windows_absolute_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.windows(3).any(|window| {
        window[0].is_ascii_alphabetic()
            && window[1] == b':'
            && (window[2] == b'\\' || window[2] == b'/')
    })
}

fn has_unc_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.windows(2).enumerate().any(|(index, window)| {
        window == b"\\\\"
            && bytes
                .get(index + 2)
                .is_some_and(|byte| byte.is_ascii_alphanumeric())
    })
}

fn report_array<'a>(report: &'a Value, field: &str, label: &str) -> UtsushiResult<&'a [Value]> {
    report[field]
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| format!("{label} runtime report field {field} must be an array").into())
}

fn require_report_string<'a>(
    report: &'a Value,
    field: &str,
    label: &str,
) -> UtsushiResult<&'a str> {
    report[field]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!("{label} runtime report field {field} must be a non-empty string").into()
        })
}

fn require_non_blank(corpus_path: &Path, field: &str, value: &str) -> UtsushiResult<()> {
    if value.trim().is_empty() {
        return Err(format!("{} {field} must not be blank", corpus_path.display()).into());
    }
    Ok(())
}

fn require_non_empty_strings(
    corpus_path: &Path,
    label: &str,
    field: &str,
    values: &[String],
) -> UtsushiResult<()> {
    if values.is_empty() {
        return Err(format!("{label} {field} must not be empty").into());
    }
    for value in values {
        require_non_blank(corpus_path, field, value)?;
    }
    Ok(())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn sha256_hex(input: &[u8]) -> String {
    const INITIAL_STATE: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let mut state = INITIAL_STATE;
    let mut message = input.to_vec();
    let bit_len = (message.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in message.chunks_exact(64) {
        let mut words = [0u32; 64];
        for (index, word) in words.iter_mut().take(16).enumerate() {
            let offset = index * 4;
            *word = u32::from_be_bytes([
                chunk[offset],
                chunk[offset + 1],
                chunk[offset + 2],
                chunk[offset + 3],
            ]);
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }

        let mut a = state[0];
        let mut b = state[1];
        let mut c = state[2];
        let mut d = state[3];
        let mut e = state[4];
        let mut f = state[5];
        let mut g = state[6];
        let mut h = state[7];

        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[index])
                .wrapping_add(words[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
        state[5] = state[5].wrapping_add(f);
        state[6] = state[6].wrapping_add(g);
        state[7] = state[7].wrapping_add(h);
    }

    state
        .iter()
        .map(|word| format!("{word:08x}"))
        .collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    const SCREENSHOT_BYTES: &[u8] = b"utsushi fixture deterministic screenshot placeholder\n";
    const SCREENSHOT_SHA256: &str =
        "fea02f42d0815df80a48355bfbee008c261e5a516f2f23f333efb757f618f232";

    #[test]
    fn sha256_hex_matches_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(sha256_hex(SCREENSHOT_BYTES), SCREENSHOT_SHA256);
    }

    #[test]
    fn validates_reference_capture_corpus_with_artifact_hashes() {
        let root = temp_dir("valid");
        let corpus = write_corpus_fixture(&root, FixtureVariant::Valid);

        let report = validate_reference_capture_corpus(&corpus).unwrap();

        assert_eq!(report.fixtures_validated, 1);
        assert_eq!(report.artifacts_validated, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_missing_artifact_hashes() {
        let root = temp_dir("missing-hashes");
        let corpus = write_corpus_fixture(&root, FixtureVariant::MissingHashes);

        let error = validate_reference_capture_corpus(&corpus)
            .unwrap_err()
            .to_string();

        assert!(error.contains("artifactHashes"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_screenshots_outside_artifact_store() {
        let root = temp_dir("outside-artifact-store");
        let corpus = write_corpus_fixture(&root, FixtureVariant::OutsideArtifactStore);

        let error = validate_reference_capture_corpus(&corpus)
            .unwrap_err()
            .to_string();

        assert!(error.contains("runtime artifact uri") || error.contains("artifact store"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_static_reads_labeled_as_runtime_evidence() {
        let root = temp_dir("static-read");
        let corpus = write_corpus_fixture(&root, FixtureVariant::StaticRead);

        let error = validate_reference_capture_corpus(&corpus)
            .unwrap_err()
            .to_string();

        assert!(error.contains("static reads labeled as runtime evidence"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_unredacted_local_paths_in_observation_envelopes() {
        let root = temp_dir("local-path");
        let corpus = write_corpus_fixture(&root, FixtureVariant::UnredactedLocalPath);

        let error = validate_reference_capture_corpus(&corpus)
            .unwrap_err()
            .to_string();

        assert!(error.contains("unredacted local path"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn local_path_detection_allows_artifact_store_redactions_and_normal_prose() {
        for allowed in [
            "artifact-store://runtime/report",
            "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000010000001/screenshots/019ed003-0000-7000-8000-000040000001.png",
            "<redacted-local-path>",
            "[redacted path]",
            "Dialogue choices use yes/no labels.",
            "The UI shows 1/2 pages.",
        ] {
            assert!(
                !looks_like_local_path(allowed),
                "{allowed:?} should not be classified as a local path"
            );
        }
    }

    #[test]
    fn rejects_additional_reference_capture_contract_failures() {
        for (variant, expected_error) in [
            (
                FixtureVariant::ReportSchemaInvalid,
                "runtime report contract invalid",
            ),
            (
                FixtureVariant::SourceRevisionMismatch,
                "sourceRevision does not match",
            ),
            (
                FixtureVariant::RuntimeTargetMismatch,
                "runtimeTargetId fixture:reference-capture-public does not match",
            ),
            (
                FixtureVariant::EventIdMismatch,
                "observationEventIds must name exactly",
            ),
            (
                FixtureVariant::DuplicateEventIds,
                "observationEventIds must be unique",
            ),
            (FixtureVariant::WrongHash, "sha256"),
            (FixtureVariant::WrongByteCount, "byte count"),
            (
                FixtureVariant::ReportIdArtifactRunMismatch,
                "must match runtimeReportId",
            ),
            (
                FixtureVariant::ReportLevelPrivatePath,
                "unredacted local path",
            ),
            (FixtureVariant::RootPrivatePath, "unredacted local path"),
            (FixtureVariant::WindowsPrivatePath, "unredacted local path"),
            (
                FixtureVariant::EmbeddedUncPrivatePath,
                "unredacted local path",
            ),
            (FixtureVariant::SrvPrivatePath, "unredacted local path"),
            (FixtureVariant::DataPrivatePath, "unredacted local path"),
            (FixtureVariant::RunUserPrivatePath, "unredacted local path"),
            (
                FixtureVariant::CorpusMetadataPrivatePath,
                "unredacted local path",
            ),
            (
                FixtureVariant::TopLevelCaptureUnmanifested,
                "top-level capture screenshot artifact",
            ),
            (
                FixtureVariant::NonUuidRuntimeReportId,
                "must be a UUID7 string",
            ),
        ] {
            let root = temp_dir("additional-negative");
            let corpus = write_corpus_fixture(&root, variant);

            let error = validate_reference_capture_corpus(&corpus)
                .unwrap_err()
                .to_string();

            assert!(
                error.contains(expected_error),
                "error {error:?} did not contain {expected_error:?}"
            );
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn public_reference_capture_fixtures_cover_positive_and_negative_cases() {
        let public_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/public/utsushi-reference-captures");

        validate_reference_capture_corpus(&public_root.join("reference-capture-corpus.json"))
            .unwrap();

        for (fixture, expected_error) in [
            ("missing-hash-corpus.json", "artifactHashes"),
            ("outside-artifact-store-corpus.json", "runtime artifact uri"),
            (
                "static-read-corpus.json",
                "static reads labeled as runtime evidence",
            ),
            ("unredacted-local-path-corpus.json", "unredacted local path"),
            (
                "capture-unmanifested-corpus.json",
                "top-level capture screenshot artifact",
            ),
            ("non-uuid-run-corpus.json", "must be a UUID7 string"),
            ("embedded-unc-corpus.json", "unredacted local path"),
            ("unlisted-unix-corpus.json", "unredacted local path"),
            ("windows-drive-corpus.json", "unredacted local path"),
        ] {
            let error =
                validate_reference_capture_corpus(&public_root.join("invalid").join(fixture))
                    .unwrap_err()
                    .to_string();
            assert!(
                error.contains(expected_error),
                "{fixture} error {error:?} did not contain {expected_error:?}"
            );
        }
    }

    #[derive(Clone, Copy)]
    enum FixtureVariant {
        Valid,
        MissingHashes,
        OutsideArtifactStore,
        StaticRead,
        UnredactedLocalPath,
        ReportSchemaInvalid,
        SourceRevisionMismatch,
        RuntimeTargetMismatch,
        EventIdMismatch,
        DuplicateEventIds,
        WrongHash,
        WrongByteCount,
        ReportIdArtifactRunMismatch,
        ReportLevelPrivatePath,
        RootPrivatePath,
        WindowsPrivatePath,
        EmbeddedUncPrivatePath,
        SrvPrivatePath,
        DataPrivatePath,
        RunUserPrivatePath,
        CorpusMetadataPrivatePath,
        TopLevelCaptureUnmanifested,
        NonUuidRuntimeReportId,
    }

    fn temp_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("utsushi-reference-corpus-{name}-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_corpus_fixture(root: &Path, variant: FixtureVariant) -> PathBuf {
        let artifact_root = root.join("artifact-store");
        let artifact_uri = match variant {
            FixtureVariant::OutsideArtifactStore => {
                "artifacts/utsushi/elsewhere/019ed003-0000-7000-8000-000040000001.png"
            }
            FixtureVariant::ReportIdArtifactRunMismatch => {
                "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000099990001/screenshots/019ed003-0000-7000-8000-000040000001.png"
            }
            FixtureVariant::NonUuidRuntimeReportId => {
                "artifacts/utsushi/runtime/not-a-uuid-run/screenshots/019ed003-0000-7000-8000-000040000001.png"
            }
            _ => {
                "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000010000001/screenshots/019ed003-0000-7000-8000-000040000001.png"
            }
        };
        let artifact_path = artifact_root.join(
            "019ed003-0000-7000-8000-000010000001/screenshots/019ed003-0000-7000-8000-000040000001.png",
        );
        fs::create_dir_all(artifact_path.parent().unwrap()).unwrap();
        fs::write(
            artifact_root.join(RUNTIME_ARTIFACT_ROOT_MARKER),
            "managed-by=utsushi-runtime\n",
        )
        .unwrap();
        fs::write(&artifact_path, SCREENSHOT_BYTES).unwrap();
        if matches!(
            variant,
            FixtureVariant::ReportIdArtifactRunMismatch | FixtureVariant::NonUuidRuntimeReportId
        ) {
            let mismatch_artifact_path =
                artifact_root.join(runtime_artifact_path_suffix(artifact_uri));
            fs::create_dir_all(mismatch_artifact_path.parent().unwrap()).unwrap();
            fs::write(&mismatch_artifact_path, SCREENSHOT_BYTES).unwrap();
        }

        let report = runtime_report_json(artifact_uri, &variant);
        fs::write(
            root.join("runtime-report.json"),
            serde_json::to_string_pretty(&report).unwrap(),
        )
        .unwrap();

        let artifact_hashes = match variant {
            FixtureVariant::MissingHashes => json!([]),
            _ => json!([
                {
                    "artifactId": "019ed003-0000-7000-8000-000040000001",
                    "observationEventId": "019ed003-0000-7000-8000-000071000001",
                    "uri": artifact_uri,
                    "sha256": match variant {
                        FixtureVariant::WrongHash => "0000000000000000000000000000000000000000000000000000000000000000",
                        _ => SCREENSHOT_SHA256
                    },
                    "bytes": match variant {
                        FixtureVariant::WrongByteCount => 54,
                        _ => 53
                    },
                    "mediaType": "text/plain"
                }
            ]),
        };
        let source_revision_source_id = match variant {
            FixtureVariant::SourceRevisionMismatch => "different-source",
            _ => "reference-capture-public",
        };
        let runtime_target_id = match variant {
            FixtureVariant::RuntimeTargetMismatch => "fixture:different-target",
            _ => "fixture:reference-capture-public",
        };
        let observation_event_ids = match variant {
            FixtureVariant::EventIdMismatch => json!([
                "019ed003-0000-7000-8000-000070000001",
                "019ed003-0000-7000-8000-000071000999"
            ]),
            FixtureVariant::DuplicateEventIds => json!([
                "019ed003-0000-7000-8000-000070000001",
                "019ed003-0000-7000-8000-000070000001"
            ]),
            _ => json!([
                "019ed003-0000-7000-8000-000070000001",
                "019ed003-0000-7000-8000-000071000001"
            ]),
        };
        let corpus = json!({
            "schemaVersion": "0.1.0",
            "artifactStoreRoot": match variant {
                FixtureVariant::CorpusMetadataPrivatePath => "/tmp/private-artifact-store",
                _ => "artifact-store"
            },
            "fixtures": [
                {
                    "fixtureId": "reference-capture-test",
                    "runtimeReportPath": "runtime-report.json",
                    "sourceRevision": {
                        "sourceId": source_revision_source_id,
                        "revisionId": "fixture-source-v0.1"
                    },
                    "runtimeTargetId": runtime_target_id,
                    "observationEventIds": observation_event_ids,
                    "artifactHashes": artifact_hashes,
                    "evidenceTier": "E2",
                    "redactionStatus": "not_required"
                }
            ]
        });
        let corpus_path = root.join("corpus.json");
        fs::write(&corpus_path, serde_json::to_string_pretty(&corpus).unwrap()).unwrap();
        corpus_path
    }

    fn runtime_report_json(artifact_uri: &str, variant: &FixtureVariant) -> Value {
        let capture_artifact_uri = match variant {
            FixtureVariant::TopLevelCaptureUnmanifested => {
                "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000010000001/screenshots/019ed003-0000-7000-8000-000040000999.png"
            }
            _ => artifact_uri,
        };
        let captures = match variant {
            FixtureVariant::StaticRead => json!([]),
            _ => json!([
                {
                    "captureId": "019ed003-0000-7000-8000-000030000001",
                    "bridgeUnitRef": {
                        "bridgeUnitId": "019ed000-0000-7000-8000-bridgeun0001",
                        "sourceUnitKey": "reference.capture.001"
                    },
                    "evidenceTier": "E2",
                    "frame": 1,
                    "width": 320,
                    "height": 180,
                    "nonZeroPixels": 57600,
                    "artifactRef": artifact_ref_json(capture_artifact_uri)
                }
            ]),
        };
        let features_used = match variant {
            FixtureVariant::StaticRead => json!(["static_trace"]),
            _ => json!([
                "static_trace",
                "text_trace",
                "frame_capture",
                "instrumentation_hooks"
            ]),
        };
        let text = match variant {
            FixtureVariant::UnredactedLocalPath => "/tmp/private/reference-capture",
            _ => "Reference capture ready.",
        };
        let approximations = match variant {
            FixtureVariant::ReportSchemaInvalid => json!([]),
            _ => json!([
                {
                    "approximationId": "019ed003-0000-7000-8000-000050000001",
                    "approximationTier": "deterministic_fixture",
                    "scope": "fixture runtime",
                    "description": "Reference capture fixture documents deterministic layout-probe evidence without reference-runtime pixel comparison.",
                    "affectedBridgeUnitRefs": [
                        {
                            "bridgeUnitId": "019ed000-0000-7000-8000-bridgeun0001",
                            "sourceUnitKey": "reference.capture.001"
                        }
                    ],
                    "evidenceTierCeiling": "E2"
                }
            ]),
        };
        let limitations = match variant {
            FixtureVariant::ReportLevelPrivatePath => json!(["Captured at /tmp/private/run"]),
            FixtureVariant::RootPrivatePath => json!(["Captured at /root/private/run"]),
            FixtureVariant::WindowsPrivatePath => json!(["Captured at C:\\Users\\private\\run"]),
            FixtureVariant::EmbeddedUncPrivatePath => {
                json!(["Captured at \\\\server\\share\\game"])
            }
            FixtureVariant::SrvPrivatePath => json!(["Captured at /srv/game"]),
            FixtureVariant::DataPrivatePath => json!(["Captured at /data/game"]),
            FixtureVariant::RunUserPrivatePath => json!(["Captured at /run/user/1000/game"]),
            _ => json!([]),
        };
        let runtime_report_id = match variant {
            FixtureVariant::NonUuidRuntimeReportId => "not-a-uuid-run",
            _ => "019ed003-0000-7000-8000-000010000001",
        };
        json!({
            "schemaVersion": "0.2.0",
            "runtimeReportId": runtime_report_id,
            "sourceLocale": "ja-JP",
            "adapterName": "utsushi-fixture",
            "adapterVersion": "0.0.0",
            "fidelityTier": "layout_probe",
            "evidenceTier": "E2",
            "controlledPlaybackSession": {
                "sessionId": "019ed003-0000-7000-8000-000060000001",
                "adapterName": "utsushi-fixture",
                "adapterVersion": "0.0.0",
                "capabilityClass": "launch_capture",
                "requestedOperation": "capture",
                "status": "passed",
                "fidelityTier": "layout_probe",
                "evidenceTier": "E2",
                "featuresUsed": features_used,
                "limitations": []
            },
            "status": "passed",
            "createdAt": "2026-06-17T00:00:00.000Z",
            "traceEvents": [],
            "observationHookEvents": [
                {
                    "schemaVersion": "0.1.0-alpha",
                    "eventId": "019ed003-0000-7000-8000-000070000001",
                    "observedAt": "2026-06-17T00:00:00.000Z",
                    "eventKind": "text",
                    "runtimeTargetId": "fixture:reference-capture-public",
                    "adapterId": {"name": "utsushi-fixture", "version": "0.0.0"},
                    "evidenceTier": "E1",
                    "environment": {"runtime": "fixture"},
                    "sourceRevision": {
                        "sourceId": "reference-capture-public",
                        "revisionId": "fixture-source-v0.1"
                    },
                    "bridgeRefs": [
                        {
                            "bridgeUnitId": "019ed000-0000-7000-8000-bridgeun0001",
                            "sourceUnitKey": "reference.capture.001"
                        }
                    ],
                    "redaction": {"status": "not_required"},
                    "payload": {
                        "payloadKind": "text",
                        "text": text
                    }
                },
                {
                    "schemaVersion": "0.1.0-alpha",
                    "eventId": "019ed003-0000-7000-8000-000071000001",
                    "observedAt": "2026-06-17T00:00:00.000Z",
                    "eventKind": "frame",
                    "runtimeTargetId": "fixture:reference-capture-public",
                    "adapterId": {"name": "utsushi-fixture", "version": "0.0.0"},
                    "evidenceTier": "E2",
                    "environment": {"runtime": "fixture"},
                    "sourceRevision": {
                        "sourceId": "reference-capture-public",
                        "revisionId": "fixture-source-v0.1"
                    },
                    "bridgeRefs": [
                        {
                            "bridgeUnitId": "019ed000-0000-7000-8000-bridgeun0001",
                            "sourceUnitKey": "reference.capture.001"
                        }
                    ],
                    "redaction": {"status": "not_required"},
                    "payload": {
                        "payloadKind": "frame",
                        "frame": 1,
                        "width": 320,
                        "height": 180,
                        "artifactRef": artifact_ref_json(artifact_uri)
                    }
                }
            ],
            "branchEvents": [],
            "captures": captures,
            "recordings": [],
            "approximations": approximations,
            "validationFindings": [],
            "limitations": limitations
        })
    }

    fn runtime_artifact_path_suffix(uri: &str) -> &str {
        uri.strip_prefix("artifacts/utsushi/runtime/").unwrap()
    }

    fn artifact_ref_json(artifact_uri: &str) -> Value {
        json!({
            "artifactId": "019ed003-0000-7000-8000-000040000001",
            "artifactKind": "screenshot",
            "uri": artifact_uri,
            "mediaType": "text/plain"
        })
    }
}
