use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::MANAGED_ARTIFACT_URI_ROOT;

pub(super) struct Check {
    pub(super) id: &'static str,
    pub(super) passed: bool,
    pub(super) detail: String,
}

impl Check {
    pub(super) fn to_json(&self) -> Value {
        json!({
            "checkId": self.id,
            "status": if self.passed { "pass" } else { "fail" },
            "mandatory": true,
            "detail": self.detail,
        })
    }
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Whether a URI is a managed runtime artifact URI. Mirrors the runtime-web-
/// review `isManagedRuntimeUri` guard byte-for-byte so the Rust producer and the
/// TS renderer agree on what is safe to surface.
pub(super) fn is_managed_artifact_uri(uri: &str) -> bool {
    uri.starts_with(MANAGED_ARTIFACT_URI_ROOT)
        && !uri.contains('\\')
        && !uri.starts_with('/')
        // no `scheme:` prefix (file:, data:, http:, C:...).
        && !uri
            .split_once(':')
            .is_some_and(|(scheme, _)| !scheme.is_empty() && !scheme.contains('/'))
        && !uri.split('/').any(|segment| segment == "." || segment == "..")
}

/// The observation-hook events of a trace, or an empty slice.
pub(super) fn observation_events(trace: &Value) -> &[Value] {
    trace
        .get("observationHookEvents")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
}

/// The first bridge ref (id + key) of an observation event, as a normalized
/// `{ bridgeUnitId, sourceUnitKey }` object.
pub(super) fn event_bridge_ref(event: &Value) -> Value {
    let bridge = event
        .get("bridgeRefs")
        .and_then(Value::as_array)
        .and_then(|refs| refs.first());
    json!({
        "bridgeUnitId": bridge.and_then(|b| b.get("bridgeUnitId")).cloned().unwrap_or(Value::Null),
        "sourceUnitKey": bridge.and_then(|b| b.get("sourceUnitKey")).cloned().unwrap_or(Value::Null),
    })
}

/// Build the playback-facing observation envelope from the patched runtime
/// trace: the observed dialogue text + choices, each linked to its bridge unit
/// ref. This is the data the embedded playback surface renders.
pub(super) fn build_observation_envelope(trace: &Value) -> Value {
    let mut events: Vec<Value> = Vec::new();
    for event in observation_events(trace) {
        let bridge_ref = event_bridge_ref(event);
        let payload = event.get("payload").unwrap_or(&Value::Null);
        match event.get("eventKind").and_then(Value::as_str) {
            Some("text") => {
                events.push(json!({
                    "eventKind": "text",
                    "bridgeUnitRef": bridge_ref,
                    "speaker": payload.get("speaker").cloned().unwrap_or(Value::Null),
                    "text": payload.get("text").cloned().unwrap_or(Value::Null),
                    "textSurface": payload.get("textSurface").cloned().unwrap_or(Value::Null),
                }));
            }
            Some("choice") => {
                let options: Vec<Value> = payload
                    .get("options")
                    .and_then(Value::as_array)
                    .map(|opts| {
                        opts.iter()
                            .map(|option| {
                                json!({
                                    "optionId": option.get("optionId").cloned().unwrap_or(Value::Null),
                                    "label": option.get("label").cloned().unwrap_or(Value::Null),
                                    "bridgeUnitRef": {
                                        "bridgeUnitId": option.get("bridgeRef").and_then(|b| b.get("bridgeUnitId")).cloned().unwrap_or(Value::Null),
                                        "sourceUnitKey": option.get("bridgeRef").and_then(|b| b.get("sourceUnitKey")).cloned().unwrap_or(Value::Null),
                                    },
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                events.push(json!({
                    "eventKind": "choice",
                    "bridgeUnitRef": bridge_ref,
                    "prompt": payload.get("prompt").cloned().unwrap_or(Value::Null),
                    "options": options,
                }));
            }
            _ => {}
        }
    }
    json!({
        "runtimeReportId": trace.get("runtimeReportId").cloned().unwrap_or(Value::Null),
        "runtimeTargetId": observation_events(trace)
            .first()
            .and_then(|e| e.get("runtimeTargetId"))
            .cloned()
            .unwrap_or(Value::Null),
        "evidenceTier": trace.get("evidenceTier").cloned().unwrap_or(Value::Null),
        "observationSource": "live_dom",
        "events": events,
    })
}

/// The top-level bridge unit ids the observation envelope covers.
pub(super) fn envelope_bridge_unit_ids(envelope: &Value) -> Vec<String> {
    envelope
        .get("events")
        .and_then(Value::as_array)
        .map(|events| {
            events
                .iter()
                .filter_map(|e| {
                    e.get("bridgeUnitRef")
                        .and_then(|b| b.get("bridgeUnitId"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Validate one screenshot capture reference and build its packaged form. A
/// capture is validated iff its artifactRef resolves to a managed runtime URI
/// declares a screenshot artifact kind + media type + byte size, and links to a
/// bridge unit ref + the trace event it evidences. The `refHash` is a
/// deterministic content-addressed handle over the canonical artifactRef so the
/// reference resolves to a stable hash a reviewer can verify.
pub(super) fn validate_capture(capture: &Value) -> (Value, bool) {
    let artifact_ref = capture.get("artifactRef").cloned().unwrap_or(Value::Null);
    let uri = artifact_ref
        .get("uri")
        .and_then(Value::as_str)
        .unwrap_or("");
    let uri_managed = is_managed_artifact_uri(uri);
    let kind_is_screenshot = artifact_ref
        .get("artifactKind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "screenshot");
    let artifact_id_present = artifact_ref
        .get("artifactId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty());
    let media_type_present = artifact_ref
        .get("mediaType")
        .and_then(Value::as_str)
        .is_some_and(|m| !m.is_empty());
    let byte_size_present = artifact_ref
        .get("byteSize")
        .and_then(Value::as_u64)
        .is_some();
    let bridge_ref = capture.get("bridgeUnitRef").cloned().unwrap_or(Value::Null);
    let bridge_linked = bridge_ref
        .get("bridgeUnitId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty())
        && bridge_ref
            .get("sourceUnitKey")
            .and_then(Value::as_str)
            .is_some_and(|k| !k.is_empty());
    let trace_linked = capture
        .get("evidencesTraceEventId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty());

    let validated = uri_managed
        && kind_is_screenshot
        && artifact_id_present
        && media_type_present
        && byte_size_present
        && bridge_linked
        && trace_linked;

    // Content-addressed handle over the canonical (serde-sorted) artifactRef.
    let ref_hash = format!(
        "sha256:{}",
        sha256_hex(&serde_json::to_vec(&artifact_ref).unwrap_or_default())
    );

    let packaged = json!({
        "captureId": capture.get("captureId").cloned().unwrap_or(Value::Null),
        "frame": capture.get("frame").cloned().unwrap_or(Value::Null),
        "bridgeUnitRef": bridge_ref,
        "evidencesTraceEventId": capture.get("evidencesTraceEventId").cloned().unwrap_or(Value::Null),
        "mvCommandRef": capture.get("mvCommandRef").cloned().unwrap_or(Value::Null),
        "artifactRef": artifact_ref,
        "refHash": ref_hash,
        "validated": validated,
        "validation": {
            "uriManaged": uri_managed,
            "artifactKindIsScreenshot": kind_is_screenshot,
            "artifactIdPresent": artifact_id_present,
            "mediaTypePresent": media_type_present,
            "byteSizePresent": byte_size_present,
            "bridgeLinked": bridge_linked,
            "traceLinked": trace_linked,
        },
    });
    (packaged, validated)
}

/// The screenshot artifact ids the 010 review manifest names.
pub(super) fn review_manifest_screenshot_ids(review_manifest: &Value) -> Vec<String> {
    review_manifest
        .get("screenshotArtifactRefs")
        .and_then(|s| s.get("refs"))
        .and_then(Value::as_array)
        .map(|refs| {
            refs.iter()
                .filter_map(|r| {
                    r.get("artifactRef")
                        .and_then(|a| a.get("artifactId"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_a_complete_managed_screenshot_capture() {
        let capture = json!({
            "captureId": "capture-1",
            "artifactRef": {
                "uri": "artifacts/utsushi/runtime/run-1/capture-1.png",
                "artifactKind": "screenshot",
                "artifactId": "capture-1",
                "mediaType": "image/png",
                "byteSize": 1
            },
            "bridgeUnitRef": {
                "bridgeUnitId": "bridge-1",
                "sourceUnitKey": "source-1"
            },
            "evidencesTraceEventId": "event-1"
        });

        let (packaged, valid) = validate_capture(&capture);

        assert!(valid);
        assert_eq!(packaged["validated"], true);
        assert!(
            packaged["refHash"]
                .as_str()
                .is_some_and(|hash| hash.starts_with("sha256:"))
        );
    }
}
