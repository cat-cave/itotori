use super::*;
/// The one deliberate, scoped browser-engine exception to the workspace's
/// "no shipped `Command::new`" port posture.
///
/// `to_command` builds the `std::process::Command::new(&self.program)` spawn
/// that drives the MV/MZ browser runtime-evidence adapter
/// (`BrowserLaunchAdapter` in `utsushi-fixture`/`launch_adapters.rs`
/// registered as a production adapter in `utsushi-cli`). RPG Maker MV/MZ games
/// are browser/NW.js JavaScript games with no proprietary opcode VM, so
/// launching a real headless Chromium runs the actual engine rather than a
/// from-scratch mimic — the faithful runtime for a browser game is the
/// browser. This is the ONLY shipped external-process spawn: every other
/// `Command::new` in the workspace is a `#[cfg(test)]` dev-oracle that
/// re-launches `current_exe()` or an integration-test binary invocation, and
/// every other `kaifuu`/`utsushi` engine module retains its
/// no-`Command::new`, in-process-Rust rule.
///
/// See `docs/dev/architecture.md` ("MV/MZ runtime evidence: real-Chromium
/// policy") for the full decided policy and its scope boundary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeLaunchCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub current_dir: Option<PathBuf>,
    pub env: Vec<(String, String)>,
}

impl RuntimeLaunchCommand {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            current_dir: None,
            env: Vec::new(),
        }
    }

    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn current_dir(mut self, current_dir: impl Into<PathBuf>) -> Self {
        self.current_dir = Some(current_dir.into());
        self
    }

    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    pub(super) fn to_command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command
            .args(&self.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(current_dir) = &self.current_dir {
            command.current_dir(current_dir);
        }
        for (key, value) in &self.env {
            command.env(key, value);
        }
        command
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeLaunchCapturePlan {
    pub run_id: String,
    pub operation: RuntimeOperation,
    pub command: RuntimeLaunchCommand,
    pub timeout: Duration,
    pub shutdown_grace: Duration,
    pub hook_timeout: Duration,
    pub poll_interval: Duration,
    pub artifact_root: Option<PathBuf>,
    /// When set, the harness pipes the launched process's stdout and drains
    /// it on a dedicated reader thread, surfacing the captured bytes as
    /// [`RuntimeLaunchCaptureOutcome::stdout`]. This is how the MV/MZ browser
    /// trace probe reads the live post-render DOM (`--dump-dom`) instead of
    /// the fixture-declared text. Off by default so screenshot/capture launches
    /// keep discarding stdout.
    pub capture_stdout: bool,
}

impl RuntimeLaunchCapturePlan {
    pub fn new(
        run_id: impl Into<String>,
        operation: RuntimeOperation,
        command: RuntimeLaunchCommand,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            operation,
            command,
            timeout: DEFAULT_HARNESS_TIMEOUT,
            shutdown_grace: DEFAULT_HARNESS_SHUTDOWN_GRACE,
            hook_timeout: DEFAULT_HARNESS_HOOK_TIMEOUT,
            poll_interval: DEFAULT_HARNESS_POLL_INTERVAL,
            artifact_root: None,
            capture_stdout: false,
        }
    }

    /// Enable draining and capturing the launched process's stdout. Used by
    /// the browser trace probe to read the live `--dump-dom` output.
    pub fn with_stdout_capture(mut self, capture_stdout: bool) -> Self {
        self.capture_stdout = capture_stdout;
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn with_shutdown_grace(mut self, shutdown_grace: Duration) -> Self {
        self.shutdown_grace = shutdown_grace;
        self
    }

    pub fn with_hook_timeout(mut self, hook_timeout: Duration) -> Self {
        self.hook_timeout = hook_timeout;
        self
    }

    pub fn with_poll_interval(mut self, poll_interval: Duration) -> Self {
        self.poll_interval = poll_interval;
        self
    }

    pub fn with_artifact_root(mut self, artifact_root: impl Into<PathBuf>) -> Self {
        self.artifact_root = Some(artifact_root.into());
        self
    }

    pub(super) fn validate(&self) -> Result<(), RuntimeHarnessError> {
        if let Err(error) = validate_artifact_segment("run id", &self.run_id) {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                self.operation,
                format!("invalid runtime harness run id: {error}"),
            ));
        }
        if self.command.program.as_os_str().is_empty() {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                self.operation,
                "runtime launch command program must not be empty",
            ));
        }
        if self.timeout.is_zero() {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                self.operation,
                "runtime launch timeout must be greater than zero",
            ));
        }
        if self.shutdown_grace.is_zero() {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                self.operation,
                "runtime launch shutdown grace must be greater than zero",
            ));
        }
        if self.hook_timeout.is_zero() {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                self.operation,
                "runtime capture hook timeout must be greater than zero",
            ));
        }
        if self.poll_interval.is_zero() {
            return Err(RuntimeHarnessError::new(
                RuntimeHarnessErrorKind::InvalidPlan,
                self.operation,
                "runtime launch poll interval must be greater than zero",
            ));
        }
        Ok(())
    }
}
