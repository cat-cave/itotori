//! Runner orchestrator placeholder. Slice A introduces the cooperative
//! cancellation token here so the trait definition has a typed argument
//! to point at; the full `Runner` and `RunnerOutcome` machinery land in
//! the next commit.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use super::diagnostics::EnginePortError;
use super::manifest::LifecycleStage;

/// Cooperative cancellation token. Cheaply clonable; backed by
/// `Arc<AtomicBool>`. The runner sets `requested = true` on timeout,
/// hook failure, or explicit shutdown.
#[derive(Clone, Debug, Default)]
pub struct RunnerCancellation {
    inner: Arc<AtomicBool>,
}

impl RunnerCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.load(Ordering::SeqCst)
    }

    pub fn cancel(&self) {
        self.inner.store(true, Ordering::SeqCst);
    }

    /// Yield an error if cancellation is set. Ports call this inside
    /// long loops.
    pub fn check(&self, stage: LifecycleStage) -> Result<(), EnginePortError> {
        if self.is_cancelled() {
            Err(EnginePortError::Cancelled { stage })
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_cancellation_check_returns_cancelled_for_stage() {
        let token = RunnerCancellation::new();
        token.cancel();
        let error = token
            .check(LifecycleStage::Launch)
            .expect_err("cancelled token must return Cancelled");
        match error {
            EnginePortError::Cancelled { stage } => assert_eq!(stage, LifecycleStage::Launch),
            other => panic!("expected Cancelled, got {other:?}"),
        }
    }

    #[test]
    fn runner_cancellation_default_token_never_signals() {
        let token = RunnerCancellation::new();
        assert!(!token.is_cancelled());
        token
            .check(LifecycleStage::Observe)
            .expect("default token does not signal cancel");
    }
}
