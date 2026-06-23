//! Embed-boundary artifact reference.
//!
//! Wraps the engine-neutral [`crate::ObservationArtifactRef`] so the ABI
//! module owns the validator and the wire form is decoupled from any future
//! field additions on the underlying type. The validator re-runs
//! [`crate::validate_runtime_artifact_uri`] so URIs that drift outside
//! `artifacts/utsushi/runtime/` (absolute paths, drive letters, `data:` /
//! `blob:` / `file:` schemes, traversal) are rejected on construction —
//! host paths are structurally impossible to serialize through this type.

use serde::{Deserialize, Serialize};

use crate::{ObservationArtifactRef, validate_runtime_artifact_uri};

use super::diagnostics::EmbedError;

/// Embed-boundary artifact reference. Mirrors [`ObservationArtifactRef`] but
/// owns its own validator that surfaces failures as [`EmbedError`] rather
/// than the host-side `Box<dyn Error>`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EmbedArtifactRef {
    /// Stable per-run artifact id; non-blank.
    pub artifact_id: String,
    /// Stable artifact kind string (matches
    /// `crate::RuntimeArtifactKind::artifact_kind`).
    pub artifact_kind: String,
    /// Managed runtime URI. MUST start with `artifacts/utsushi/runtime/`
    /// and pass [`validate_runtime_artifact_uri`].
    pub uri: String,
    /// Optional MIME type label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

impl EmbedArtifactRef {
    /// Per-field validator. Called by [`super::state::EmbedState::validate`].
    pub fn validate(&self) -> Result<(), EmbedError> {
        if self.artifact_id.trim().is_empty() {
            return Err(EmbedError::InvalidArtifactRef {
                reason: "artifact_id must be non-blank".to_string(),
            });
        }
        if self.artifact_kind.trim().is_empty() {
            return Err(EmbedError::InvalidArtifactRef {
                reason: "artifact_kind must be non-blank".to_string(),
            });
        }
        if !self.artifact_kind.is_ascii() {
            return Err(EmbedError::InvalidArtifactRef {
                reason: "artifact_kind must be ASCII".to_string(),
            });
        }
        validate_runtime_artifact_uri(&self.uri).map_err(|err| EmbedError::InvalidArtifactRef {
            reason: format!("uri rejected: {err}"),
        })?;
        if let Some(media_type) = &self.media_type
            && media_type.trim().is_empty()
        {
            return Err(EmbedError::InvalidArtifactRef {
                reason: "media_type must be non-blank when present".to_string(),
            });
        }
        Ok(())
    }
}

impl From<&ObservationArtifactRef> for EmbedArtifactRef {
    fn from(value: &ObservationArtifactRef) -> Self {
        Self {
            artifact_id: value.artifact_id.clone(),
            artifact_kind: value.artifact_kind.clone(),
            uri: value.uri.clone(),
            media_type: value.media_type.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_ref() -> EmbedArtifactRef {
        EmbedArtifactRef {
            artifact_id: "frame-001".to_string(),
            artifact_kind: "frame_capture".to_string(),
            uri: "artifacts/utsushi/runtime/run-001/frame-captures/frame-001.png".to_string(),
            media_type: Some("image/png".to_string()),
        }
    }

    #[test]
    fn embed_artifact_ref_accepts_managed_runtime_uri() {
        let value = sample_ref();
        value.validate().expect("managed uri accepted");
    }

    #[test]
    fn embed_artifact_ref_rejects_absolute_host_path() {
        let mut value = sample_ref();
        value.uri = "/home/leak/screenshot.png".to_string();
        let error = value.validate().expect_err("absolute path rejected");
        assert!(matches!(error, EmbedError::InvalidArtifactRef { .. }));
    }

    #[test]
    fn embed_artifact_ref_rejects_data_blob_file_uri_schemes() {
        for uri in [
            "data:image/png;base64,abc",
            "blob:https://example/abc",
            "file:///etc/passwd",
        ] {
            let mut value = sample_ref();
            value.uri = uri.to_string();
            let error = value.validate().expect_err("scheme rejected");
            assert!(matches!(error, EmbedError::InvalidArtifactRef { .. }));
        }
    }

    #[test]
    fn embed_artifact_ref_rejects_uri_with_path_traversal() {
        let mut value = sample_ref();
        value.uri = "artifacts/utsushi/runtime/run-001/../leak.png".to_string();
        let error = value.validate().expect_err("traversal rejected");
        assert!(matches!(error, EmbedError::InvalidArtifactRef { .. }));
    }

    #[test]
    fn embed_artifact_ref_rejects_blank_id_and_kind() {
        let mut value = sample_ref();
        value.artifact_id = String::new();
        assert!(matches!(
            value.validate().expect_err("blank id rejected"),
            EmbedError::InvalidArtifactRef { .. }
        ));
        value = sample_ref();
        value.artifact_kind = "   ".to_string();
        assert!(matches!(
            value.validate().expect_err("blank kind rejected"),
            EmbedError::InvalidArtifactRef { .. }
        ));
    }

    #[test]
    fn embed_artifact_ref_rejects_blank_media_type_when_present() {
        let mut value = sample_ref();
        value.media_type = Some("   ".to_string());
        let error = value.validate().expect_err("blank media_type rejected");
        assert!(matches!(error, EmbedError::InvalidArtifactRef { .. }));
    }

    #[test]
    fn embed_artifact_ref_round_trips_through_serde_json() {
        let value = sample_ref();
        let json = serde_json::to_value(&value).expect("serialize");
        let parsed: EmbedArtifactRef = serde_json::from_value(json).expect("deserialize");
        assert_eq!(parsed, value);
    }

    #[test]
    fn embed_artifact_ref_serializes_with_camel_case_wire_form() {
        let value = sample_ref();
        let json = serde_json::to_value(&value).expect("serialize");
        let obj = json.as_object().expect("object");
        assert!(obj.contains_key("artifactId"));
        assert!(obj.contains_key("artifactKind"));
        assert!(obj.contains_key("mediaType"));
        assert!(!obj.contains_key("artifact_id"));
        assert!(!obj.contains_key("artifact_kind"));
        assert!(!obj.contains_key("media_type"));
    }

    #[test]
    fn embed_artifact_ref_from_observation_artifact_ref_preserves_fields() {
        let observation = ObservationArtifactRef {
            artifact_id: "screenshot-001".to_string(),
            artifact_kind: "screenshot".to_string(),
            uri: "artifacts/utsushi/runtime/run-001/screenshots/screenshot-001.png".to_string(),
            media_type: Some("image/png".to_string()),
        };
        let embed_ref: EmbedArtifactRef = (&observation).into();
        embed_ref.validate().expect("inherited validation");
        assert_eq!(embed_ref.artifact_id, observation.artifact_id);
        assert_eq!(embed_ref.artifact_kind, observation.artifact_kind);
        assert_eq!(embed_ref.uri, observation.uri);
        assert_eq!(embed_ref.media_type, observation.media_type);
    }

    #[test]
    fn embed_artifact_ref_rejects_unknown_fields_on_deserialize() {
        let raw = serde_json::json!({
            "artifactId": "frame-001",
            "artifactKind": "frame_capture",
            "uri": "artifacts/utsushi/runtime/run-001/frame-captures/frame-001.png",
            "secretField": "should be rejected"
        });
        let error = serde_json::from_value::<EmbedArtifactRef>(raw)
            .expect_err("unknown field rejected by deny_unknown_fields");
        assert!(error.to_string().contains("secretField"));
    }
}
