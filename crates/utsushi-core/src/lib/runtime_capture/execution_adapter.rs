use super::*;
struct RuntimeHookThreadResult {
    hook: Box<dyn RuntimeCaptureHook>,
    result: Result<Vec<RuntimeCapturedArtifact>, RuntimeHarnessError>,
}

pub(super) enum RuntimeHookExecutionError {
    Failed {
        hook: Box<dyn RuntimeCaptureHook>,
        error: RuntimeHarnessError,
    },
    Unrecoverable(RuntimeHarnessError),
}

pub(super) fn run_capture_hook_with_timeout(
    mut hook: Box<dyn RuntimeCaptureHook>,
    mut context: RuntimeCaptureContext,
    timeout: Duration,
) -> Result<(Box<dyn RuntimeCaptureHook>, Vec<RuntimeCapturedArtifact>), RuntimeHookExecutionError>
{
    if timeout.is_zero() {
        return Err(RuntimeHookExecutionError::Unrecoverable(
            capture_hook_timeout_error(
                context.operation,
                context.boundary,
                context.process_id,
                timeout,
            ),
        ));
    }

    let operation = context.operation;
    let boundary = context.boundary;
    let process_id = context.process_id;
    // install a fresh open fence and keep a clone in the harness.
    // The worker thread receives its own clone inside `context`; closing the
    // harness-side handle at the capture boundary flips the shared flag so any
    // later write from a still-running worker is refused.
    let fence = CaptureWriteFence::open();
    context.write_fence = fence.clone();
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let result = match panic::catch_unwind(AssertUnwindSafe(|| hook.capture(&mut context))) {
            Ok(Ok(())) => Ok(context.into_artifacts()),
            Ok(Err(error)) => Err(error),
            Err(payload) => Err(RuntimeHarnessError::capture_failed(
                operation,
                format!(
                    "capture hook panicked at {}: {}",
                    boundary.as_str(),
                    panic_payload_message(payload.as_ref())
                ),
            )
            .with_boundary(boundary)
            .with_process_id(process_id)),
        };
        let _ = sender.send(RuntimeHookThreadResult { hook, result });
    });

    let outcome = receiver.recv_timeout(timeout);
    // the capture boundary is crossed the instant the harness stops
    // waiting for the hook (completion OR timeout). Close the fence here so any
    // write the worker attempts after this point is refused, while writes made
    // during the valid in-progress window above still succeeded.
    fence.close();

    match outcome {
        Ok(RuntimeHookThreadResult {
            hook,
            result: Ok(artifacts),
        }) => Ok((hook, artifacts)),
        Ok(RuntimeHookThreadResult {
            hook,
            result: Err(error),
        }) => Err(RuntimeHookExecutionError::Failed { hook, error }),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(RuntimeHookExecutionError::Unrecoverable(
            capture_hook_timeout_error(operation, boundary, process_id, timeout),
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(RuntimeHookExecutionError::Unrecoverable(
            RuntimeHarnessError::capture_failed(
                operation,
                format!(
                    "capture hook worker stopped before reporting {}",
                    boundary.as_str()
                ),
            )
            .with_boundary(boundary)
            .with_process_id(process_id),
        )),
    }
}

fn capture_hook_timeout_error(
    operation: RuntimeOperation,
    boundary: RuntimeCaptureBoundary,
    process_id: u32,
    timeout: Duration,
) -> RuntimeHarnessError {
    RuntimeHarnessError::new(
        RuntimeHarnessErrorKind::CaptureTimeout,
        operation,
        format!(
            "capture hook at {} exceeded timeout of {:?}",
            boundary.as_str(),
            timeout
        ),
    )
    .with_boundary(boundary)
    .with_process_id(process_id)
    .with_detail("hookTimeoutMillis", timeout.as_millis().to_string())
}

fn panic_payload_message(payload: &(dyn Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_string();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "non-string panic payload".to_string()
}

pub(super) fn bounded_hook_timeout(plan: &RuntimeLaunchCapturePlan, deadline: Instant) -> Duration {
    let remaining = remaining_until(deadline);
    if remaining < plan.hook_timeout {
        remaining
    } else {
        plan.hook_timeout
    }
}

pub(super) fn remaining_until(deadline: Instant) -> Duration {
    deadline
        .checked_duration_since(Instant::now())
        .unwrap_or(Duration::ZERO)
}

// reason: the return is only infallible on unix (where clippy evaluates this);
// the `#[cfg(not(unix))]` sibling below legitimately returns `Err` because
// process-tree cleanup is unsupported there, so the `Result` is required.
#[cfg(unix)]
// reason: the #[cfg(unix)] sibling returns Err on unsupported targets, so the Result wrapper is required for signature parity.
#[allow(clippy::unnecessary_wraps)]
pub(super) fn configure_runtime_process_tree(
    command: &mut Command,
    _operation: RuntimeOperation,
) -> Result<(), RuntimeHarnessError> {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
    Ok(())
}

#[cfg(not(unix))]
pub(super) fn configure_runtime_process_tree(
    _command: &mut Command,
    operation: RuntimeOperation,
) -> Result<(), RuntimeHarnessError> {
    Err(RuntimeHarnessError::new(
        RuntimeHarnessErrorKind::InvalidPlan,
        operation,
        "runtime launch process-tree cleanup is unsupported on this platform",
    )
    .with_detail(
        "cleanupScope",
        RuntimeProcessCleanupScope::ProcessTree.as_str(),
    ))
}

pub trait RuntimeAdapter {
    fn descriptor(&self) -> RuntimeAdapterDescriptor;

    fn trace(&self, request: &RuntimeRequest<'_>) -> UtsushiResult<Value>;

    fn discover_branches(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Err(unsupported_operation(&self.descriptor(), RuntimeOperation::BranchDiscovery).into())
    }

    fn capture(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Err(unsupported_operation(&self.descriptor(), RuntimeOperation::Capture).into())
    }

    fn smoke_validate(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Err(unsupported_operation(&self.descriptor(), RuntimeOperation::SmokeValidation).into())
    }

    fn replay_review(&self, _request: &RuntimeRequest<'_>) -> UtsushiResult<Value> {
        Err(unsupported_operation(&self.descriptor(), RuntimeOperation::ReplayReview).into())
    }

    fn run(
        &self,
        operation: RuntimeOperation,
        request: &RuntimeRequest<'_>,
    ) -> UtsushiResult<Value> {
        match operation {
            RuntimeOperation::Trace => self.trace(request),
            RuntimeOperation::BranchDiscovery => self.discover_branches(request),
            RuntimeOperation::Capture => self.capture(request),
            RuntimeOperation::SmokeValidation => self.smoke_validate(request),
            RuntimeOperation::ReplayReview => self.replay_review(request),
        }
    }
}

pub struct RuntimeAdapterRegistry<'a> {
    adapters: Vec<&'a dyn RuntimeAdapter>,
}

impl<'a> RuntimeAdapterRegistry<'a> {
    pub fn new() -> Self {
        Self {
            adapters: Vec::new(),
        }
    }

    pub fn register(&mut self, adapter: &'a dyn RuntimeAdapter) -> UtsushiResult<()> {
        let descriptor = adapter.descriptor();
        descriptor.validate_contract()?;
        if self
            .adapters
            .iter()
            .any(|registered| registered.descriptor().name == descriptor.name)
        {
            return Err(format!("runtime adapter already registered: {}", descriptor.name).into());
        }
        self.adapters.push(adapter);
        Ok(())
    }

    pub fn adapter(&self, name: &str) -> Option<&'a dyn RuntimeAdapter> {
        self.adapters
            .iter()
            .find(|adapter| adapter.descriptor().name == name)
            .copied()
    }

    pub fn require(&self, name: &str) -> UtsushiResult<&'a dyn RuntimeAdapter> {
        self.adapter(name)
            .ok_or_else(|| format!("runtime adapter not registered: {name}").into())
    }

    pub fn descriptors(&self) -> Vec<RuntimeAdapterDescriptor> {
        self.adapters
            .iter()
            .map(|adapter| adapter.descriptor())
            .collect()
    }

    pub fn run(
        &self,
        adapter_name: &str,
        operation: RuntimeOperation,
        request: &RuntimeRequest<'_>,
    ) -> UtsushiResult<Value> {
        let adapter = self.require(adapter_name)?;
        let descriptor = adapter.descriptor();
        let required_capability = operation.required_capability();
        if !descriptor.supports(required_capability) {
            return Err(unsupported_operation(&descriptor, operation).into());
        }
        adapter.run(operation, request)
    }
}

impl Default for RuntimeAdapterRegistry<'_> {
    fn default() -> Self {
        Self::new()
    }
}
