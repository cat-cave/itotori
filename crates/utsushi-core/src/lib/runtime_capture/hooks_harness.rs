use super::*;

use super::execution_adapter::{
    RuntimeHookExecutionError, bounded_hook_timeout, configure_runtime_process_tree,
    remaining_until, run_capture_hook_with_timeout,
};
pub struct RuntimeCaptureContext {
    pub operation: RuntimeOperation,
    pub boundary: RuntimeCaptureBoundary,
    pub process_id: u32,
    pub run_id: String,
    artifact_store: Option<RuntimeCaptureArtifactStore>,
    artifacts: Vec<RuntimeCapturedArtifact>,
    // gates managed-artifact writes. Shared (cloned) with the
    // harness so the harness can close it at the capture boundary and refuse
    // writes from a detached worker that outlives `launch-capture`.
    pub(super) write_fence: CaptureWriteFence,
}

impl RuntimeCaptureContext {
    fn new(
        operation: RuntimeOperation,
        boundary: RuntimeCaptureBoundary,
        process_id: u32,
        run_id: impl Into<String>,
        artifact_store: Option<RuntimeCaptureArtifactStore>,
    ) -> Self {
        Self {
            operation,
            boundary,
            process_id,
            run_id: run_id.into(),
            artifact_store,
            artifacts: Vec::new(),
            write_fence: CaptureWriteFence::open(),
        }
    }

    pub fn write_artifact(
        &mut self,
        kind: RuntimeArtifactKind,
        artifact_id: impl Into<String>,
        media_type: impl Into<Option<String>>,
        contents: &[u8],
    ) -> Result<RuntimeCapturedArtifact, RuntimeHarnessError> {
        // refuse writes once the capture boundary has closed. This
        // is checked before touching the store so a detached worker that keeps
        // running after `launch-capture` returns cannot mutate managed artifact
        // state; the refusal carries a distinct code from a normal timeout.
        if !self.write_fence.is_open() {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::CaptureBoundaryClosed,
                self.operation,
                "capture hook attempted to write a managed runtime artifact after the capture boundary closed; write refused",
            )
            .with_boundary(self.boundary)
            .with_process_id(self.process_id));
        }
        let Some(store) = &self.artifact_store else {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::ArtifactStoreUnavailable,
                self.operation,
                "capture hook requested artifact storage but no managed runtime artifact root was configured",
            )
            .with_boundary(self.boundary)
            .with_process_id(self.process_id));
        };
        let mut artifact = store
            .write_artifact(kind, artifact_id, media_type, contents)
            .map_err(|error| {
                RuntimeHarnessError::new(
                    RuntimeHarnessErrorKind::ArtifactWriteFailed,
                    self.operation,
                    format!("capture hook failed to write runtime artifact: {error}"),
                )
                .with_boundary(self.boundary)
                .with_process_id(self.process_id)
            })?;
        artifact.boundary = Some(self.boundary);
        self.artifacts.push(artifact.clone());
        Ok(artifact)
    }

    pub fn artifacts(&self) -> &[RuntimeCapturedArtifact] {
        &self.artifacts
    }

    pub(super) fn into_artifacts(self) -> Vec<RuntimeCapturedArtifact> {
        self.artifacts
    }
}

pub trait RuntimeCaptureHook: Send + 'static {
    fn boundary(&self) -> RuntimeCaptureBoundary;

    fn capture(&mut self, context: &mut RuntimeCaptureContext) -> Result<(), RuntimeHarnessError>;
}

#[derive(Default)]
pub struct RuntimeCaptureHooks {
    hooks: Vec<Box<dyn RuntimeCaptureHook>>,
}

impl RuntimeCaptureHooks {
    pub fn new() -> Self {
        Self { hooks: Vec::new() }
    }

    pub fn push<H>(&mut self, hook: H)
    where
        H: RuntimeCaptureHook,
    {
        self.hooks.push(Box::new(hook));
    }

    pub fn push_boxed(&mut self, hook: Box<dyn RuntimeCaptureHook>) {
        self.hooks.push(hook);
    }

    pub fn is_empty(&self) -> bool {
        self.hooks.is_empty()
    }
}

impl From<Vec<Box<dyn RuntimeCaptureHook>>> for RuntimeCaptureHooks {
    fn from(hooks: Vec<Box<dyn RuntimeCaptureHook>>) -> Self {
        Self { hooks }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuntimeProcessExit {
    pub success: bool,
    pub code: Option<i32>,
}

impl RuntimeProcessExit {
    fn from_status(status: ExitStatus) -> Self {
        Self {
            success: status.success(),
            code: status.code(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeLaunchCaptureOutcome {
    pub process_id: u32,
    pub exit: RuntimeProcessExit,
    pub elapsed: Duration,
    pub artifacts: Vec<RuntimeCapturedArtifact>,
    /// Captured process stdout, present only when the plan set
    /// [`RuntimeLaunchCapturePlan::capture_stdout`]. Carries the live
    /// post-render DOM for the browser trace probe. Bytes are decoded
    /// lossily as UTF-8.
    pub stdout: Option<String>,
}

#[derive(Clone, Copy)]
struct RuntimeHookRun<'a> {
    plan: &'a RuntimeLaunchCapturePlan,
    process_id: u32,
    artifact_store: Option<&'a RuntimeCaptureArtifactStore>,
}

#[derive(Clone, Debug, Default)]
pub struct RuntimeLaunchCaptureHarness;

impl RuntimeLaunchCaptureHarness {
    pub fn new() -> Self {
        Self
    }

    pub fn run(
        &self,
        plan: &RuntimeLaunchCapturePlan,
        hooks: &mut RuntimeCaptureHooks,
    ) -> Result<RuntimeLaunchCaptureOutcome, RuntimeHarnessError> {
        plan.validate()?;
        let artifact_store = plan
            .artifact_root
            .as_ref()
            .map(|artifact_root| {
                RuntimeCaptureArtifactStore::prepare(
                    artifact_root.clone(),
                    plan.run_id.clone(),
                    plan.operation,
                )
            })
            .transpose()?;

        let started_at = Instant::now();
        let deadline = started_at + plan.timeout;
        let mut command = plan.command.to_command();
        if plan.capture_stdout {
            command.stdout(Stdio::piped());
        }
        configure_runtime_process_tree(&mut command, plan.operation)?;
        let mut child = command.spawn().map_err(|error| {
            RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::LaunchFailed,
                plan.operation,
                format!(
                    "failed to launch runtime command {}: {error}",
                    plan.command.program.display()
                ),
            )
            .with_detail("ioKind", error.kind().to_string())
        })?;
        let process_id = child.id();
        // Drain stdout on a dedicated thread so a large `--dump-dom` payload
        // cannot deadlock the poll-based wait by filling the pipe buffer while
        // the child blocks writing. The buffer is joined only on the success
        // path; on every error path the child is terminated, the pipe closes
        // and the detached reader thread completes on its own.
        let mut stdout_reader: Option<thread::JoinHandle<Vec<u8>>> = if plan.capture_stdout {
            child.stdout.take().map(|mut stdout| {
                thread::spawn(move || {
                    let mut buffer = Vec::new();
                    let _ = stdout.read_to_end(&mut buffer);
                    buffer
                })
            })
        } else {
            None
        };
        let mut artifacts = Vec::new();
        let hook_run = RuntimeHookRun {
            plan,
            process_id,
            artifact_store: artifact_store.as_ref(),
        };

        if let Err(error) = Self::run_hooks(
            RuntimeCaptureBoundary::AfterLaunch,
            hook_run,
            hooks,
            &mut artifacts,
            bounded_hook_timeout(plan, deadline),
        ) {
            let cleanup =
                terminate_runtime_process(&mut child, plan.shutdown_grace, plan.poll_interval);
            return Err(error.with_process_id(process_id).with_cleanup(cleanup));
        }

        let status =
            match wait_for_child_exit(&mut child, remaining_until(deadline), plan.poll_interval) {
                Ok(Some(status)) => status,
                Ok(None) => {
                    let before_terminate_error = Self::run_hooks(
                        RuntimeCaptureBoundary::BeforeTerminate,
                        hook_run,
                        hooks,
                        &mut artifacts,
                        plan.hook_timeout,
                    );
                    let cleanup = terminate_runtime_process(
                        &mut child,
                        plan.shutdown_grace,
                        plan.poll_interval,
                    );
                    let mut error = RuntimeHarnessError::new(
                        RuntimeHarnessErrorKind::Timeout,
                        plan.operation,
                        format!("runtime command exceeded timeout of {:?}", plan.timeout),
                    )
                    .with_process_id(process_id)
                    .with_cleanup(cleanup)
                    .with_detail("timeoutMillis", plan.timeout.as_millis().to_string());
                    if let Err(hook_error) = before_terminate_error {
                        error = error
                            .with_detail("beforeTerminateHookError", hook_error.code())
                            .with_detail("beforeTerminateHookMessage", hook_error.message);
                    }
                    return Err(error);
                }
                Err(error) => {
                    let cleanup = terminate_runtime_process(
                        &mut child,
                        plan.shutdown_grace,
                        plan.poll_interval,
                    );
                    return Err(RuntimeHarnessError::new(
                        RuntimeHarnessErrorKind::ProcessWaitFailed,
                        plan.operation,
                        format!("failed while waiting for runtime process: {error}"),
                    )
                    .with_process_id(process_id)
                    .with_cleanup(cleanup)
                    .with_detail("ioKind", error.kind().to_string()));
                }
            };

        let after_exit_error = Self::run_hooks(
            RuntimeCaptureBoundary::AfterExit,
            hook_run,
            hooks,
            &mut artifacts,
            plan.hook_timeout,
        )
        .err();

        let exit = RuntimeProcessExit::from_status(status);
        if !exit.success {
            let cleanup =
                terminate_runtime_process(&mut child, plan.shutdown_grace, plan.poll_interval);
            if let Some(error) = after_exit_error {
                let mut error = error
                    .with_process_id(process_id)
                    .with_cleanup(cleanup)
                    .with_detail(
                        "processFailure",
                        RuntimeHarnessErrorKind::ProcessFailed.code(),
                    );
                if let Some(code) = exit.code {
                    error = error.with_detail("exitCode", code.to_string());
                }
                return Err(error);
            }
            let mut error = RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::ProcessFailed,
                plan.operation,
                "runtime process exited with a non-zero status",
            )
            .with_process_id(process_id)
            .with_cleanup(cleanup);
            if let Some(code) = exit.code {
                error = error.with_detail("exitCode", code.to_string());
            }
            return Err(error);
        }

        if let Some(error) = after_exit_error {
            return Err(error
                .with_detail("processExit", "success")
                .with_detail("processExitSuccess", "true"));
        }

        let stdout = stdout_reader.take().map(|handle| {
            let bytes = handle.join().unwrap_or_default();
            String::from_utf8_lossy(&bytes).into_owned()
        });

        Ok(RuntimeLaunchCaptureOutcome {
            process_id,
            exit,
            elapsed: started_at.elapsed(),
            artifacts,
            stdout,
        })
    }

    fn run_hooks(
        boundary: RuntimeCaptureBoundary,
        run: RuntimeHookRun<'_>,
        hooks: &mut RuntimeCaptureHooks,
        artifacts: &mut Vec<RuntimeCapturedArtifact>,
        hook_timeout: Duration,
    ) -> Result<(), RuntimeHarnessError> {
        let mut index = 0;
        while index < hooks.hooks.len() {
            if hooks.hooks[index].boundary() != boundary {
                index += 1;
                continue;
            }
            let hook = hooks.hooks.remove(index);
            let context = RuntimeCaptureContext::new(
                run.plan.operation,
                boundary,
                run.process_id,
                run.plan.run_id.clone(),
                run.artifact_store.cloned(),
            );
            match run_capture_hook_with_timeout(hook, context, hook_timeout) {
                Ok((hook, hook_artifacts)) => {
                    artifacts.extend(hook_artifacts);
                    hooks.hooks.insert(index, hook);
                    index += 1;
                }
                Err(RuntimeHookExecutionError::Failed { hook, error }) => {
                    hooks.hooks.insert(index, hook);
                    return Err(error
                        .with_boundary(boundary)
                        .with_process_id(run.process_id));
                }
                Err(RuntimeHookExecutionError::Unrecoverable(error)) => return Err(error),
            }
        }
        Ok(())
    }
}
