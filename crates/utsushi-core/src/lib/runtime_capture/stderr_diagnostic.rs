use super::*;

use sha2::{Digest, Sha256};

const STDERR_DRAIN_BUFFER_BYTES: usize = 8 * 1024;
const STDERR_SUMMARY_WAIT: Duration = Duration::from_millis(250);

struct RuntimeStderrSummary {
    byte_count: u64,
    sha256: String,
    io_kind: Option<String>,
}

pub(super) struct RuntimeStderrDrain {
    completion: mpsc::Receiver<RuntimeStderrSummary>,
}

/// Start draining runtime stderr immediately so an arbitrary browser or game
/// process cannot block on a full pipe. The reader retains only a fixed-size
/// buffer while deriving a content commitment; it never writes raw bytes to a
/// report, artifact, or operator diagnostic.
pub(super) fn begin_runtime_stderr_drain<R>(stderr: R) -> RuntimeStderrDrain
where
    R: Read + Send + 'static,
{
    let (sender, completion) = mpsc::channel();
    // Dropping a JoinHandle deliberately detaches this reader. Every harness
    // error path first terminates the process tree, which closes the pipe and
    // lets the reader finish without delaying capture cleanup.
    drop(thread::spawn(move || {
        let _ = sender.send(summarize_runtime_stderr(stderr));
    }));
    RuntimeStderrDrain { completion }
}

/// Add only an opaque stderr content summary to a nonzero-exit diagnostic.
/// The bounded receive keeps a leaked descendant holding stderr open from
/// turning failure reporting into an unbounded wait.
pub(super) fn with_redacted_stderr_summary(
    error: RuntimeHarnessError,
    drain: Option<&RuntimeStderrDrain>,
) -> RuntimeHarnessError {
    let Some(drain) = drain else {
        return error.with_detail("stderrSummary", "unavailable");
    };
    match drain.completion.recv_timeout(STDERR_SUMMARY_WAIT) {
        Ok(summary) => {
            let mut error = error
                .with_detail("stderrDisposition", "content_redacted")
                .with_detail("stderrBytes", summary.byte_count.to_string())
                .with_detail("stderrSha256", summary.sha256);
            if let Some(io_kind) = summary.io_kind {
                error = error
                    .with_detail("stderrReadStatus", "incomplete")
                    .with_detail("stderrIoKind", io_kind);
            } else {
                error = error.with_detail("stderrReadStatus", "complete");
            }
            error
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            error.with_detail("stderrSummary", "drain_timed_out")
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            error.with_detail("stderrSummary", "reader_unavailable")
        }
    }
}

fn summarize_runtime_stderr<R>(mut stderr: R) -> RuntimeStderrSummary
where
    R: Read,
{
    let mut buffer = [0_u8; STDERR_DRAIN_BUFFER_BYTES];
    let mut byte_count = 0_u64;
    let mut hasher = Sha256::new();
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) => {
                return RuntimeStderrSummary {
                    byte_count,
                    sha256: format!("{:x}", hasher.finalize()),
                    io_kind: None,
                };
            }
            Ok(read) => {
                byte_count = byte_count.saturating_add(u64::try_from(read).unwrap_or(u64::MAX));
                hasher.update(&buffer[..read]);
            }
            Err(error) => {
                return RuntimeStderrSummary {
                    byte_count,
                    sha256: format!("{:x}", hasher.finalize()),
                    io_kind: Some(error.kind().to_string()),
                };
            }
        }
    }
}
