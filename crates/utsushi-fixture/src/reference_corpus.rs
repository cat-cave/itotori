use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use utsushi_core::{
    EvidenceTier, ObservationArtifactRef, ObservationRedactionStatus, RUNTIME_ARTIFACT_ROOT_MARKER,
    RuntimeArtifactRoot, UtsushiResult, validate_runtime_artifact_uri,
    validate_runtime_evidence_report_value,
};

mod sha256;
use sha256::{is_sha256_hex, sha256_hex};

/// Local JSON-shape view of one entry under `observationHookEvents[]`
/// introduced in in place of the deleted typed envelope
/// Rust type. Carries exactly the fields the reference-corpus validator
/// needs to compare a fixture against its runtime report.
#[derive(Debug)]
struct ParsedObservationEvent {
    event_id: String,
    runtime_target_id: String,
    source_revision: Option<ParsedObservationSourceRevision>,
    redaction_status: ObservationRedactionStatus,
    payload: ParsedObservationPayload,
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedObservationSourceRevision {
    source_id: String,
    revision_id: Option<String>,
    content_hash: Option<String>,
}

#[derive(Debug)]
enum ParsedObservationPayload {
    Frame {
        artifact_ref: Option<ObservationArtifactRef>,
    },
    Other,
}

impl ParsedObservationEvent {
    fn from_value(value: &Value, label: &str) -> UtsushiResult<Self> {
        let object = value
            .as_object()
            .ok_or_else(|| -> Box<dyn std::error::Error> {
                format!("{label} observation envelope must be an object").into()
            })?;
        let event_id = object
            .get("eventId")
            .and_then(Value::as_str)
            .ok_or_else(|| -> Box<dyn std::error::Error> {
                format!("{label} observation envelope missing eventId").into()
            })?
            .to_string();
        let runtime_target_id = object
            .get("runtimeTargetId")
            .and_then(Value::as_str)
            .ok_or_else(|| -> Box<dyn std::error::Error> {
                format!("{label} observation envelope missing runtimeTargetId").into()
            })?
            .to_string();
        let source_revision = object
            .get("sourceRevision")
            .filter(|value| !value.is_null())
            .map(|value| ParsedObservationSourceRevision::from_value(value, label))
            .transpose()?;
        let redaction_status = object
            .get("redaction")
            .and_then(|redaction| redaction.get("status"))
            .and_then(Value::as_str)
            .ok_or_else(|| -> Box<dyn std::error::Error> {
                format!("{label} observation envelope missing redaction.status").into()
            })?
            .parse::<ObservationRedactionStatus>()
            .map_err(|error| -> Box<dyn std::error::Error> {
                format!("{label} observation envelope redaction.status invalid: {error}").into()
            })?;
        let payload = match object
            .get("payload")
            .and_then(|payload| payload.get("payloadKind"))
            .and_then(Value::as_str)
        {
            Some("frame") => {
                let artifact_ref_value = object
                    .get("payload")
                    .and_then(|payload| payload.get("artifactRef"));
                let artifact_ref = match artifact_ref_value {
                    Some(value) if !value.is_null() => {
                        let parsed: ObservationArtifactRef =
                            serde_json::from_value(value.clone()).map_err(|error| {
                                format!(
                                    "{label} observation envelope payload.artifactRef invalid: {error}"
                                )
                            })?;
                        Some(parsed)
                    }
                    _ => None,
                };
                ParsedObservationPayload::Frame { artifact_ref }
            }
            _ => ParsedObservationPayload::Other,
        };
        Ok(Self {
            event_id,
            runtime_target_id,
            source_revision,
            redaction_status,
            payload,
        })
    }
}

impl ParsedObservationSourceRevision {
    fn from_value(value: &Value, label: &str) -> UtsushiResult<Self> {
        let object = value
            .as_object()
            .ok_or_else(|| -> Box<dyn std::error::Error> {
                format!("{label} observation envelope sourceRevision must be an object").into()
            })?;
        let source_id = object
            .get("sourceId")
            .and_then(Value::as_str)
            .ok_or_else(|| -> Box<dyn std::error::Error> {
                format!("{label} observation envelope sourceRevision missing sourceId").into()
            })?
            .to_string();
        let revision_id = object
            .get("revisionId")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let content_hash = object
            .get("contentHash")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        Ok(Self {
            source_id,
            revision_id,
            content_hash,
        })
    }
}

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

#[path = "reference_corpus/validation.rs"]
mod validation;
pub use validation::validate_reference_capture_corpus;

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
        window == b"\\\\" && bytes.get(index + 2).is_some_and(u8::is_ascii_alphanumeric)
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

#[cfg(test)]
#[path = "reference_corpus/tests.rs"]
mod tests;
