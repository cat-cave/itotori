use super::*;
use serde::{Deserializer, Serializer};

/// Wire-format helper for [`RuntimeArtifactKind`] so the result schema
/// can serialize/deserialize it via serde without modifying the
/// existing enum at the crate root (which is owned by other concerns).
/// The wire shape is the same `snake_case` string `artifact_kind()`
/// already returns.
// reason: serde `serialize_with` callbacks must take the field by shared
// reference (`&T`); passing `RuntimeArtifactKind` by value would not match the
// signature serde expects.
#[allow(clippy::trivially_copy_pass_by_ref)]
pub(super) fn serialize_runtime_artifact_kind<S>(
    kind: &RuntimeArtifactKind,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(kind.artifact_kind())
}

pub(super) fn deserialize_runtime_artifact_kind<'de, D>(
    deserializer: D,
) -> Result<RuntimeArtifactKind, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    match raw.as_str() {
        "trace_log" => Ok(RuntimeArtifactKind::TraceLog),
        "screenshot" => Ok(RuntimeArtifactKind::Screenshot),
        "frame_capture" => Ok(RuntimeArtifactKind::FrameCapture),
        "recording" => Ok(RuntimeArtifactKind::Recording),
        "reference_comparison" => Ok(RuntimeArtifactKind::ConformanceReport),
        other => Err(serde::de::Error::custom(format!(
            "unknown runtime artifact kind: {other}"
        ))),
    }
}
