//! Runtime artifact kinds, names, and managed URI validation.
//!
//! Extracted from `lib.rs` as part of the runtime-artifact store band.

use std::path::{Component, Path, PathBuf};

use crate::UtsushiResult;

pub const RUNTIME_ARTIFACT_URI_ROOT: &str = "artifacts/utsushi/runtime";
pub const RUNTIME_ARTIFACT_ROOT_MARKER: &str = ".utsushi-runtime-artifacts";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeArtifactKind {
    TraceLog,
    Screenshot,
    FrameCapture,
    Recording,
    ConformanceReport,
}

impl RuntimeArtifactKind {
    pub fn artifact_kind(self) -> &'static str {
        match self {
            Self::TraceLog => "trace_log",
            Self::Screenshot => "screenshot",
            Self::FrameCapture => "frame_capture",
            Self::Recording => "recording",
            Self::ConformanceReport => "reference_comparison",
        }
    }

    pub fn directory(self) -> &'static str {
        match self {
            Self::TraceLog => "traces",
            Self::Screenshot => "screenshots",
            Self::FrameCapture => "frame-captures",
            Self::Recording => "recordings",
            Self::ConformanceReport => "conformance-reports",
        }
    }

    pub fn default_extension(self) -> &'static str {
        match self {
            Self::TraceLog | Self::ConformanceReport => "json",
            Self::Screenshot | Self::FrameCapture => "png",
            Self::Recording => "webm",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeArtifactName {
    pub run_id: String,
    pub kind: RuntimeArtifactKind,
    pub artifact_id: String,
    pub extension: String,
}

impl RuntimeArtifactName {
    pub fn new(
        run_id: impl Into<String>,
        kind: RuntimeArtifactKind,
        artifact_id: impl Into<String>,
    ) -> UtsushiResult<Self> {
        Self::with_extension(run_id, kind, artifact_id, kind.default_extension())
    }

    pub fn with_extension(
        run_id: impl Into<String>,
        kind: RuntimeArtifactKind,
        artifact_id: impl Into<String>,
        extension: impl Into<String>,
    ) -> UtsushiResult<Self> {
        let name = Self {
            run_id: run_id.into(),
            kind,
            artifact_id: artifact_id.into(),
            extension: extension.into(),
        };
        validate_artifact_segment("run id", &name.run_id)?;
        validate_artifact_segment("artifact id", &name.artifact_id)?;
        validate_artifact_extension(&name.extension)?;
        Ok(name)
    }

    pub fn uri(&self) -> String {
        format!(
            "{}/{}/{}/{}.{}",
            RUNTIME_ARTIFACT_URI_ROOT,
            self.run_id,
            self.kind.directory(),
            self.artifact_id,
            self.extension
        )
    }
}

/// Stable `budget` label surfaced by [`RuntimeArtifactRoot::write_bytes`] when
/// a write exceeds the configured soft artifact-byte budget. This is the
/// `budget` field of [`SinkError::BudgetExhausted`] for every write routed
/// through the artifact store; the artifact store is the `FrameArtifact` sink's
/// storage surface, so the accompanying sink id is always
/// [`SinkKind::FrameArtifact`].
pub const RUNTIME_ARTIFACT_SOFT_BYTE_BUDGET_LABEL: &str = "frame_byte_cap";

pub fn runtime_artifact_uri(
    run_id: &str,
    kind: RuntimeArtifactKind,
    artifact_id: &str,
) -> UtsushiResult<String> {
    Ok(RuntimeArtifactName::new(run_id, kind, artifact_id)?.uri())
}

pub fn validate_runtime_artifact_uri(uri: &str) -> UtsushiResult<PathBuf> {
    if uri.starts_with('/')
        || uri.contains('\\')
        || uri.starts_with("data:")
        || uri.starts_with("blob:")
        || uri.starts_with("file:")
        || has_uri_scheme(uri)
    {
        return Err(format!("runtime artifact uri must be managed and portable: {uri}").into());
    }

    let Some(relative) = uri.strip_prefix(&format!("{RUNTIME_ARTIFACT_URI_ROOT}/")) else {
        return Err(format!(
            "runtime artifact uri must live under {RUNTIME_ARTIFACT_URI_ROOT}: {uri}"
        )
        .into());
    };
    if relative
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(format!("runtime artifact uri must not contain traversal: {uri}").into());
    }
    let path = Path::new(relative);
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => clean.push(segment),
            _ => {
                return Err(
                    format!("runtime artifact uri must not contain traversal: {uri}").into(),
                );
            }
        }
    }
    if clean.components().count() < 3 {
        return Err(
            format!("runtime artifact uri is missing run, kind, or filename: {uri}").into(),
        );
    }
    Ok(clean)
}

pub(crate) fn has_uri_scheme(value: &str) -> bool {
    let Some(colon) = value.find(':') else {
        return false;
    };
    let scheme = &value[..colon];
    !scheme.is_empty()
        && scheme.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphabetic()
                || (index > 0
                    && (character.is_ascii_digit()
                        || character == '+'
                        || character == '.'
                        || character == '-'))
        })
}

pub(crate) fn validate_artifact_segment(label: &str, value: &str) -> UtsushiResult<()> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(format!("runtime artifact {label} is not a safe path segment: {value}").into());
    }
    Ok(())
}

pub(crate) fn validate_artifact_extension(extension: &str) -> UtsushiResult<()> {
    if extension.is_empty()
        || extension.starts_with('.')
        || !extension
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err(format!("runtime artifact extension is not safe: {extension}").into());
    }
    Ok(())
}
