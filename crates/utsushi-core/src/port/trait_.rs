//! The `EnginePort` trait and the value types it consumes/produces.
//!
//! Every Utsushi engine port crate implements `EnginePort` on a stateful
//! struct that owns the live engine handle. The trait is intentionally
//! lifecycle-shaped (launch / observe / capture / shutdown), distinct from
//! the operation-shaped [`RuntimeAdapter`](crate::RuntimeAdapter) consumer
//! surface. The runner in `super::runner` drives the lifecycle behind a
//! [`super::EnginePortAdapter`] so an engine-authored port registers on the
//! `RuntimeAdapter` surface that CLI consumers already use.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::sink::SinkSet;
use crate::{RuntimeArtifactRoot, RuntimeOperation, RuntimeVfs};

use super::diagnostics::{CapabilityReason, EnginePortError, PortShutdownOutcome};
use super::manifest::{
    LifecycleStage, OPTIONAL_LIFECYCLE_STAGES, PortCapability, PortManifest,
    REQUIRED_LIFECYCLE_STAGES,
};
use super::runner::RunnerCancellation;

/// Stable identifier for a "moment" in a port's playback. Engine ports
/// translate the id into whatever scene/scenario/frame coordinate is
/// natural. The substrate models a moment as an opaque, port-defined
/// identifier so the `jump` method has a typed argument; the cross-engine
/// moment index and jump planner (UTSUSHI-104) consume this identifier
/// without changing its shape.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct MomentId {
    pub value: String,
}

impl MomentId {
    pub fn new(value: impl Into<String>) -> Self {
        Self {
            value: value.into(),
        }
    }

    /// Used by the conformance harness to manufacture a deterministic
    /// synthetic moment id.
    pub fn synthetic() -> Self {
        Self::new("synthetic-moment-0001")
    }
}

/// Audited environment map exposed to a port. Constructed by the runner
/// after filtering raw values through the manifest's `EnvFieldSchema` and
/// through `looks_like_local_path`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PortEnv {
    entries: HashMap<String, String>,
}

impl PortEnv {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert a key/value pair. The runner validates values before
    /// inserting; ports should not call this directly.
    pub fn insert(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.entries.insert(key.into(), value.into());
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries.get(key).map(String::as_str)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.entries
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Request handed to every lifecycle method.
#[derive(Clone)]
pub struct PortRequest<'a> {
    /// Input root (mirrors [`crate::RuntimeRequest::input_root`]).
    pub input_root: &'a Path,

    /// Managed artifact root for capture output. Required for capture.
    pub artifact_root: Option<&'a RuntimeArtifactRoot>,

    /// VFS handoff added by UTSUSHI-020.
    pub vfs: Option<Arc<dyn RuntimeVfs>>,

    /// Cancellation token. Lifecycle methods MUST check this at every
    /// reasonable yield point (at minimum: top of `launch`, between
    /// observation events, before capture flush).
    pub cancellation: RunnerCancellation,

    /// Audited env values.
    pub env: PortEnv,

    /// Run id supplied by the runner.
    pub run_id: &'a str,

    /// Operation the runner is fulfilling on behalf of the
    /// `RuntimeAdapter` surface. Lets a port branch on Trace vs Capture vs
    /// SmokeValidation without separate methods.
    pub operation: RuntimeOperation,
}

impl<'a> PortRequest<'a> {
    /// Cheap constructor for ports that drive the port directly (tests,
    /// conformance harness).
    pub fn new(input_root: &'a Path, run_id: &'a str, operation: RuntimeOperation) -> Self {
        Self {
            input_root,
            artifact_root: None,
            vfs: None,
            cancellation: RunnerCancellation::new(),
            env: PortEnv::new(),
            run_id,
            operation,
        }
    }

    pub fn with_artifact_root(mut self, root: &'a RuntimeArtifactRoot) -> Self {
        self.artifact_root = Some(root);
        self
    }

    pub fn with_vfs(mut self, vfs: Arc<dyn RuntimeVfs>) -> Self {
        self.vfs = Some(vfs);
        self
    }

    pub fn with_cancellation(mut self, cancellation: RunnerCancellation) -> Self {
        self.cancellation = cancellation;
        self
    }

    pub fn with_env(mut self, env: PortEnv) -> Self {
        self.env = env;
        self
    }
}

impl std::fmt::Debug for PortRequest<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PortRequest")
            .field("input_root", &self.input_root)
            .field("artifact_root", &self.artifact_root.map(|root| root.path()))
            .field("vfs", &self.vfs.as_ref().map(|_| "Arc<dyn RuntimeVfs>"))
            .field("cancellation", &self.cancellation)
            .field("env_len", &self.env.len())
            .field("run_id", &self.run_id)
            .field("operation", &self.operation)
            .finish()
    }
}

/// Result of a successful `capture`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptureOutcome {
    /// Managed runtime artifact URI (`artifacts/utsushi/runtime/...`).
    pub artifact_uri: String,
    /// Materialised path on disk, if the port wrote one.
    pub artifact_path: Option<PathBuf>,
    /// Optional textual summary the runner forwards into the runtime
    /// report.
    pub summary: Option<String>,
}

impl CaptureOutcome {
    pub fn new(artifact_uri: impl Into<String>) -> Self {
        Self {
            artifact_uri: artifact_uri.into(),
            artifact_path: None,
            summary: None,
        }
    }

    pub fn with_path(mut self, path: PathBuf) -> Self {
        self.artifact_path = Some(path);
        self
    }

    pub fn with_summary(mut self, summary: impl Into<String>) -> Self {
        self.summary = Some(summary.into());
        self
    }
}

/// The substrate trait every engine port implements (UTSUSHI-224 sinks
/// bridge). Required lifecycle methods are enforced at the type system
/// level: there is no default impl on `launch`, `observe`, `capture`, or
/// `shutdown`. The optional `jump` method has a default impl that returns
/// `CapabilityUnsupported { reason: DefaultUnimplemented }` so ports that
/// do not declare the capability surface a typed diagnostic by default.
///
/// `observe` no longer returns a typed event. Implementors push
/// observation emissions into the [`SinkSet`] surfaced by [`Self::sink_set`]
/// and the runner drains the sinks per tick (text, then frame, then audio)
/// to assemble [`crate::port::RunnerOutcome`].
pub trait EnginePort: Send + Sync {
    /// Audit-grade manifest declaration. Read by the runner before any
    /// lifecycle method runs.
    const MANIFEST: PortManifest;

    /// Lifecycle stages every implementor MUST cover. Not overridable.
    const REQUIRED_STAGES: &'static [LifecycleStage] = REQUIRED_LIFECYCLE_STAGES;

    /// Lifecycle stages a port MAY declare in `MANIFEST.optional_methods`.
    const OPTIONAL_STAGES: &'static [LifecycleStage] = OPTIONAL_LIFECYCLE_STAGES;

    /// Required: launch the engine port and ready it for observation.
    /// Implementors must honour `request.cancellation` at the top of the
    /// method.
    fn launch(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError>;

    /// Required: perform one observation step. Implementors push observed
    /// text / frame / audio emissions into the sinks held by
    /// [`Self::sink_set`]. The runner re-validates every drained item
    /// before forwarding it into [`crate::port::RunnerOutcome`]. Returning
    /// `Ok(())` after a tick that emitted nothing signals end-of-stream
    /// to the runner.
    fn observe(&mut self, request: &PortRequest<'_>) -> Result<(), EnginePortError>;

    /// Required: surface the sink set this port pushes observation
    /// emissions into. The runner drains the sinks per tick (text, then
    /// frame, then audio).
    fn sink_set(&self) -> &SinkSet;

    /// Required: produce a capture artifact through the managed runtime
    /// artifact store via `request.artifact_root`. Implementors must NOT
    /// write outside that root.
    fn capture(&mut self, request: &PortRequest<'_>) -> Result<CaptureOutcome, EnginePortError>;

    /// Optional: jump to a declared moment. Default returns
    /// `CapabilityUnsupported { reason: DefaultUnimplemented }`.
    fn jump(
        &mut self,
        _request: &PortRequest<'_>,
        _moment: &MomentId,
    ) -> Result<(), EnginePortError> {
        Err(EnginePortError::CapabilityUnsupported {
            capability: PortCapability::Jump,
            reason: CapabilityReason::DefaultUnimplemented,
        })
    }

    /// Required: idempotent shutdown. Calling twice on the same port must
    /// succeed both times. The first call returns
    /// `PortShutdownStatus::Clean`, the second returns
    /// `PortShutdownStatus::AlreadyShutDown`.
    fn shutdown(&mut self) -> Result<PortShutdownOutcome, EnginePortError>;
}
