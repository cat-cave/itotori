use super::stderr_redaction::{REDACTED_CONTENT, redact_runtime_diagnostic};
use super::stderr_secret_redaction::REDACTED_SECRET;
use super::*;

use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

const STDERR_DRAIN_BUFFER_BYTES: usize = 8 * 1024;
const STDERR_DIAGNOSTIC_CAPTURE_BYTES: usize = 8 * 1024;
const STDERR_RENDERED_DIAGNOSTIC_BYTES: usize = 12 * 1024;
const STDERR_SUMMARY_WAIT: Duration = Duration::from_millis(250);

struct RuntimeStderrSummary {
    byte_count: u64,
    sha256: Option<String>,
    captured: Vec<u8>,
    truncated: bool,
    complete: bool,
    io_kind: Option<String>,
}

#[derive(Default)]
struct RuntimeStderrSnapshot {
    byte_count: u64,
    captured: Vec<u8>,
}

pub(super) struct RuntimeStderrDrain {
    completion: mpsc::Receiver<RuntimeStderrSummary>,
    snapshot: Arc<Mutex<RuntimeStderrSnapshot>>,
}

/// Start draining runtime stderr immediately so an arbitrary browser or game
/// process cannot block on a full pipe. The reader keeps a bounded prefix for
/// an operator diagnostic and hashes the complete stream only if it overflows.
pub(super) fn begin_runtime_stderr_drain<R>(stderr: R) -> RuntimeStderrDrain
where
    R: Read + Send + 'static,
{
    let (sender, completion) = mpsc::channel();
    let snapshot = Arc::new(Mutex::new(RuntimeStderrSnapshot::default()));
    let reader_snapshot = Arc::clone(&snapshot);
    // Dropping a JoinHandle deliberately detaches this reader. Every harness
    // error path first terminates the process tree, which closes the pipe and
    // lets the reader finish without delaying capture cleanup.
    drop(thread::spawn(move || {
        let _ = sender.send(summarize_runtime_stderr(stderr, &reader_snapshot));
    }));
    RuntimeStderrDrain {
        completion,
        snapshot,
    }
}

/// Attach a bounded, span-redacted stderr diagnostic to a nonzero-exit error.
/// The bounded receive keeps a leaked descendant holding stderr open from
/// turning failure reporting into an unbounded wait.
pub(super) fn with_bounded_stderr_diagnostic(
    error: RuntimeHarnessError,
    drain: Option<&RuntimeStderrDrain>,
) -> RuntimeHarnessError {
    let Some(drain) = drain else {
        return error.with_detail("stderrSummary", "unavailable");
    };
    match drain.completion.recv_timeout(STDERR_SUMMARY_WAIT) {
        Ok(summary) => append_stderr_diagnostic(error, summary),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let error = error.with_detail("stderrSummary", "drain_timed_out");
            match drain.partial_summary() {
                Some(summary) => append_stderr_diagnostic(error, summary),
                None => error,
            }
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            error.with_detail("stderrSummary", "reader_unavailable")
        }
    }
}

impl RuntimeStderrDrain {
    fn partial_summary(&self) -> Option<RuntimeStderrSummary> {
        let snapshot = self.snapshot.lock().ok()?;
        Some(RuntimeStderrSummary {
            byte_count: snapshot.byte_count,
            sha256: None,
            captured: snapshot.captured.clone(),
            truncated: true,
            complete: false,
            io_kind: None,
        })
    }
}

fn append_stderr_diagnostic(
    mut error: RuntimeHarnessError,
    summary: RuntimeStderrSummary,
) -> RuntimeHarnessError {
    let diagnostic = render_stderr_diagnostic(&summary);
    let disposition =
        if diagnostic.contains(REDACTED_CONTENT) || diagnostic.contains(REDACTED_SECRET) {
            "span_redacted"
        } else {
            "verbatim"
        };
    error = error
        .with_detail("stderrDisposition", disposition)
        .with_detail("stderrBytes", summary.byte_count.to_string());
    if summary.truncated {
        error = error
            .with_detail("stderrCapturedBytes", summary.captured.len().to_string())
            .with_detail("stderrDiagnosticTruncated", "true");
        if let Some(sha256) = &summary.sha256 {
            error = error.with_detail("stderrSha256", sha256.clone());
        }
    }
    error = match (summary.complete, summary.io_kind) {
        (false, _) => error.with_detail("stderrReadStatus", "draining"),
        (true, Some(io_kind)) => error
            .with_detail("stderrReadStatus", "incomplete")
            .with_detail("stderrIoKind", io_kind),
        (true, None) => error.with_detail("stderrReadStatus", "complete"),
    };
    if !diagnostic.is_empty() {
        error.message.push_str(": ");
        error.message.push_str(&diagnostic);
        error = error.with_detail("stderrDiagnostic", diagnostic);
    }
    error
}

fn render_stderr_diagnostic(summary: &RuntimeStderrSummary) -> String {
    let mut diagnostic = bounded_diagnostic(redact_runtime_diagnostic(&lossy_diagnostic_text(
        &summary.captured,
    )));
    if summary.truncated {
        if !diagnostic.is_empty() {
            diagnostic.push('\n');
        }
        let suffix = match &summary.sha256 {
            Some(sha256) => format!(
                "[stderr diagnostic truncated: captured {} of {} bytes (sha256 {sha256})]",
                summary.captured.len(),
                summary.byte_count,
            ),
            None => format!(
                "[stderr diagnostic still draining: captured {} bytes]",
                summary.captured.len(),
            ),
        };
        diagnostic.push_str(&suffix);
    }
    diagnostic
}

fn bounded_diagnostic(diagnostic: String) -> String {
    if diagnostic.len() <= STDERR_RENDERED_DIAGNOSTIC_BYTES {
        return diagnostic;
    }
    let mut end = STDERR_RENDERED_DIAGNOSTIC_BYTES;
    while !diagnostic.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}[stderr diagnostic rendering truncated]",
        &diagnostic[..end]
    )
}

fn lossy_diagnostic_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .chars()
        .map(|character| match character {
            '\n' | '\r' | '\t' => character,
            character if character.is_control() => '\u{fffd}',
            character => character,
        })
        .collect()
}

fn summarize_runtime_stderr<R>(
    mut stderr: R,
    snapshot: &Arc<Mutex<RuntimeStderrSnapshot>>,
) -> RuntimeStderrSummary
where
    R: Read,
{
    let mut buffer = [0_u8; STDERR_DRAIN_BUFFER_BYTES];
    let mut byte_count = 0_u64;
    let mut hasher = Sha256::new();
    let mut captured = Vec::with_capacity(STDERR_DIAGNOSTIC_CAPTURE_BYTES);
    let mut truncated = false;
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) => {
                return RuntimeStderrSummary {
                    byte_count,
                    sha256: Some(format!("{:x}", hasher.finalize())),
                    captured,
                    truncated,
                    complete: true,
                    io_kind: None,
                };
            }
            Ok(read) => {
                byte_count = byte_count.saturating_add(u64::try_from(read).unwrap_or(u64::MAX));
                hasher.update(&buffer[..read]);
                let available = STDERR_DIAGNOSTIC_CAPTURE_BYTES.saturating_sub(captured.len());
                let retained = read.min(available);
                captured.extend_from_slice(&buffer[..retained]);
                truncated |= retained < read;
                update_runtime_stderr_snapshot(snapshot, byte_count, &captured);
            }
            Err(error) => {
                return RuntimeStderrSummary {
                    byte_count,
                    sha256: Some(format!("{:x}", hasher.finalize())),
                    captured,
                    truncated,
                    complete: true,
                    io_kind: Some(error.kind().to_string()),
                };
            }
        }
    }
}

fn update_runtime_stderr_snapshot(
    snapshot: &Arc<Mutex<RuntimeStderrSnapshot>>,
    byte_count: u64,
    captured: &[u8],
) {
    let Ok(mut published) = snapshot.lock() else {
        return;
    };
    published.byte_count = byte_count;
    if published.captured.len() < captured.len() {
        published.captured = captured.to_vec();
    }
}
