use super::*;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeCaptureBoundary {
    AfterLaunch,
    BeforeTerminate,
    AfterExit,
}

impl RuntimeCaptureBoundary {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AfterLaunch => "after_launch",
            Self::BeforeTerminate => "before_terminate",
            Self::AfterExit => "after_exit",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuntimeHarnessErrorKind {
    InvalidPlan,
    LaunchFailed,
    Timeout,
    ProcessFailed,
    ProcessWaitFailed,
    ProcessCleanupFailed,
    CaptureTimeout,
    CaptureFailed,
    /// a capture hook worker attempted to write a managed runtime
    /// artifact after the capture boundary closed (the hook timed out or
    /// `launch-capture` already returned). The write fence refuses the mutation
    /// so a detached, still-running hook worker cannot corrupt managed artifact
    /// state after completion. Semantic code: `runtime_capture_boundary_closed`.
    /// Distinct from `CaptureTimeout` so a fenced late write is distinguishable
    /// from the normal timeout diagnostic.
    CaptureBoundaryClosed,
    ArtifactStoreUnavailable,
    ArtifactWriteFailed,
    /// Browser-launch path could not locate a Chromium-compatible binary.
    ///
    /// Reported when neither an explicitly configured browser, the
    /// `UTSUSHI_BROWSER_BIN` env override, the PATH lookup, nor the
    /// platform-specific install-path fallback yields a launchable executable.
    /// The semantic code attached to the harness error is
    /// `utsushi.browser.chromium_unavailable`.
    ChromiumUnavailable,
    /// Browser-launch path detected a Chromium binary whose major version is
    /// below the minimum supported floor. Semantic code:
    /// `utsushi.browser.chromium_version_mismatch`.
    ChromiumVersionMismatch,
    /// Browser-launch path could not reach a usable display surface under
    /// strict display checking. Produced by the strict-display probe
    /// () when the operator opts into the `UTSUSHI_STRICT_DISPLAY`
    /// activation gate and no usable display surface is detected; off by
    /// default. Semantic code: `utsushi.browser.display_unavailable`.
    ChromiumDisplayUnavailable,
    /// Adapter is research-tier and not advertised as alpha capability;
    /// invoking trace/capture/smoke returns this kind. Semantic code:
    /// `utsushi.runtime.research_tier_unsupported`.
    ResearchTierUnsupported,
}

impl RuntimeHarnessErrorKind {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidPlan => "runtime_harness_invalid_plan",
            Self::LaunchFailed => "runtime_launch_failed",
            Self::Timeout => "runtime_launch_timeout",
            Self::ProcessFailed => "runtime_process_failed",
            Self::ProcessWaitFailed => "runtime_process_wait_failed",
            Self::ProcessCleanupFailed => "runtime_process_cleanup_failed",
            Self::CaptureTimeout => "runtime_capture_timeout",
            Self::CaptureFailed => "runtime_capture_failed",
            Self::CaptureBoundaryClosed => "runtime_capture_boundary_closed",
            Self::ArtifactStoreUnavailable => "runtime_artifact_store_unavailable",
            Self::ArtifactWriteFailed => "runtime_artifact_write_failed",
            Self::ChromiumUnavailable => "runtime_browser_chromium_unavailable",
            Self::ChromiumVersionMismatch => "runtime_browser_chromium_version_mismatch",
            Self::ChromiumDisplayUnavailable => "runtime_browser_display_unavailable",
            Self::ResearchTierUnsupported => "runtime_research_tier_unsupported",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeProcessCleanupScope {
    ProcessTree,
}

impl RuntimeProcessCleanupScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ProcessTree => "process_tree",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuntimeProcessCleanup {
    pub attempted: bool,
    pub completed: bool,
    pub scope: RuntimeProcessCleanupScope,
    pub escalated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeHarnessError {
    pub kind: RuntimeHarnessErrorKind,
    pub operation: RuntimeOperation,
    pub message: String,
    pub boundary: Option<RuntimeCaptureBoundary>,
    pub process_id: Option<u32>,
    pub cleanup: Option<RuntimeProcessCleanup>,
    pub details: Vec<(String, String)>,
}

impl RuntimeHarnessError {
    pub fn new(
        kind: RuntimeHarnessErrorKind,
        operation: RuntimeOperation,
        message: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            operation,
            message: message.into(),
            boundary: None,
            process_id: None,
            cleanup: None,
            details: Vec::new(),
        }
    }

    pub fn capture_failed(operation: RuntimeOperation, message: impl Into<String>) -> Self {
        Self::new(RuntimeHarnessErrorKind::CaptureFailed, operation, message)
    }

    pub fn code(&self) -> &'static str {
        self.kind.code()
    }

    pub fn with_boundary(mut self, boundary: RuntimeCaptureBoundary) -> Self {
        self.boundary = Some(boundary);
        self
    }

    pub fn with_process_id(mut self, process_id: u32) -> Self {
        self.process_id = Some(process_id);
        self
    }

    pub fn with_cleanup(mut self, cleanup: RuntimeProcessCleanup) -> Self {
        self.cleanup = Some(cleanup);
        if !cleanup.completed && self.kind != RuntimeHarnessErrorKind::Timeout {
            self.kind = RuntimeHarnessErrorKind::ProcessCleanupFailed;
        }
        self
    }

    pub fn with_detail(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.details.push((key.into(), value.into()));
        self
    }

    pub fn to_json(&self) -> Value {
        let details = self
            .details
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect::<serde_json::Map<_, _>>();
        let mut value = serde_json::Map::new();
        value.insert("errorCode".to_string(), self.code().into());
        value.insert("message".to_string(), self.message.clone().into());
        value.insert("operation".to_string(), self.operation.as_str().into());
        if let Some(boundary) = self.boundary {
            value.insert("boundary".to_string(), boundary.as_str().into());
        }
        if let Some(process_id) = self.process_id {
            value.insert("processId".to_string(), process_id.into());
        }
        if let Some(cleanup) = self.cleanup {
            value.insert(
                "cleanup".to_string(),
                serde_json::json!({
                    "attempted": cleanup.attempted,
                    "completed": cleanup.completed,
                    "scope": cleanup.scope.as_str(),
                    "escalated": cleanup.escalated
                }),
            );
        }
        if !details.is_empty() {
            value.insert("details".to_string(), Value::Object(details));
        }
        Value::Object(value)
    }

    pub fn to_validation_finding(
        &self,
        finding_id: impl Into<String>,
        finding_kind: impl Into<String>,
        severity: impl Into<String>,
        evidence_tier: EvidenceTier,
    ) -> Value {
        serde_json::json!({
            "findingId": finding_id.into(),
            "findingKind": finding_kind.into(),
            "severity": severity.into(),
            "message": format!("{}: {}", self.code(), self.message),
            "evidenceTier": evidence_tier.as_str()
        })
    }
}

impl std::fmt::Display for RuntimeHarnessError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code(), self.message)
    }
}

impl std::error::Error for RuntimeHarnessError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeCapturedArtifact {
    pub artifact_id: String,
    pub artifact_kind: RuntimeArtifactKind,
    pub uri: String,
    pub media_type: Option<String>,
    pub byte_size: u64,
    pub path: PathBuf,
    pub boundary: Option<RuntimeCaptureBoundary>,
}

impl RuntimeCapturedArtifact {
    pub fn artifact_ref_json(&self) -> Value {
        let mut value = serde_json::Map::new();
        value.insert("artifactId".to_string(), self.artifact_id.clone().into());
        value.insert(
            "artifactKind".to_string(),
            self.artifact_kind.artifact_kind().into(),
        );
        value.insert("uri".to_string(), self.uri.clone().into());
        if let Some(media_type) = &self.media_type {
            value.insert("mediaType".to_string(), media_type.clone().into());
        }
        value.insert("byteSize".to_string(), self.byte_size.into());
        Value::Object(value)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeCaptureArtifactStore {
    root: RuntimeArtifactRoot,
    run_id: String,
}

impl RuntimeCaptureArtifactStore {
    pub fn prepare(
        root: impl Into<PathBuf>,
        run_id: impl Into<String>,
        operation: RuntimeOperation,
    ) -> Result<Self, RuntimeHarnessError> {
        let run_id = run_id.into();
        if let Err(error) = validate_artifact_segment("run id", &run_id) {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                operation,
                format!("invalid runtime artifact run id: {error}"),
            ));
        }
        let store = Self {
            root: RuntimeArtifactRoot::new(root.into()),
            run_id,
        };
        store.root.prepare().map_err(|error| {
            RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::ArtifactWriteFailed,
                operation,
                format!("failed to prepare runtime artifact root: {error}"),
            )
        })?;
        Ok(store)
    }

    pub fn root(&self) -> &RuntimeArtifactRoot {
        &self.root
    }

    pub fn write_artifact(
        &self,
        kind: RuntimeArtifactKind,
        artifact_id: impl Into<String>,
        media_type: impl Into<Option<String>>,
        contents: &[u8],
    ) -> UtsushiResult<RuntimeCapturedArtifact> {
        self.write_artifact_with_extension(
            kind,
            artifact_id,
            kind.default_extension(),
            media_type,
            contents,
        )
    }

    pub fn write_artifact_with_extension(
        &self,
        kind: RuntimeArtifactKind,
        artifact_id: impl Into<String>,
        extension: impl Into<String>,
        media_type: impl Into<Option<String>>,
        contents: &[u8],
    ) -> UtsushiResult<RuntimeCapturedArtifact> {
        let artifact_id = artifact_id.into();
        let name = RuntimeArtifactName::with_extension(
            &self.run_id,
            kind,
            artifact_id.clone(),
            extension.into(),
        )?;
        let uri = name.uri();
        let path = self.root.write_bytes(&uri, contents)?;
        Ok(RuntimeCapturedArtifact {
            artifact_id,
            artifact_kind: kind,
            uri,
            media_type: media_type.into(),
            byte_size: contents.len() as u64,
            path,
            boundary: None,
        })
    }
}

/// a write fence shared between the launch-capture harness and a
/// spawned capture-hook worker thread.
///
/// A capture hook runs on a detached worker thread (see
/// [`super::execution_adapter::run_capture_hook_with_timeout`]). When the hook
/// times out, the harness
/// stops waiting and `launch-capture` returns, but the worker thread may still
/// be running and still holds a clone of the [`RuntimeCaptureArtifactStore`].
/// Without a fence, that detached worker could write a managed runtime artifact
/// *after* the capture boundary, corrupting managed artifact state
/// (use-after-completion side effect).
///
/// The fence is open while a hook's bounded capture window is valid and is
/// closed at the capture boundary (the moment the harness stops waiting for the
/// hook — completion or timeout). Every managed-artifact write is gated on the
/// fence, so a post-boundary write from a still-running worker is refused
/// (typed [`RuntimeHarnessErrorKind::CaptureBoundaryClosed`], no state
/// mutation) while writes during the valid window still succeed.
#[derive(Clone, Debug)]
pub struct CaptureWriteFence {
    open: Arc<AtomicBool>,
}

impl CaptureWriteFence {
    /// A fresh, open fence: managed-artifact writes are permitted until it is
    /// [`close`](Self::close)d at the capture boundary.
    pub(super) fn open() -> Self {
        Self {
            open: Arc::new(AtomicBool::new(true)),
        }
    }

    /// Whether managed-artifact writes are currently permitted. Checked before
    /// every write so a late write from a detached worker is refused.
    pub(super) fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    /// Close the fence at the capture boundary. Idempotent; once closed, any
    /// subsequent managed-artifact write through a context sharing this fence
    /// is refused.
    pub(super) fn close(&self) {
        self.open.store(false, Ordering::SeqCst);
    }
}

impl Default for CaptureWriteFence {
    fn default() -> Self {
        Self::open()
    }
}
