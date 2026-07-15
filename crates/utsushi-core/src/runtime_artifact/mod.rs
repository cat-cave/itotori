//! Runtime artifact store: kinds/names/URIs, managed root, fd-relative FS ops.
//!
//! Extracted from `lib.rs` as a cohesive band: runtime-artifact kind/name/URI
//! surface plus the managed `RuntimeArtifactRoot` store and its unix
//! fd-relative/no-follow filesystem primitives.

#[cfg(unix)]
mod artifact_fs;
mod root;
mod types;

pub use root::RuntimeArtifactRoot;
pub use types::{
    RUNTIME_ARTIFACT_ROOT_MARKER, RUNTIME_ARTIFACT_SOFT_BYTE_BUDGET_LABEL,
    RUNTIME_ARTIFACT_URI_ROOT, RuntimeArtifactKind, RuntimeArtifactName, runtime_artifact_uri,
    validate_runtime_artifact_uri,
};

pub(crate) use types::validate_artifact_segment;
