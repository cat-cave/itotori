//! Public surface types for the engine-neutral binary patch transaction harness:
//! config, state machine enums, diagnostics, staged payload metadata, outcome,
//! and state-machine misuse errors.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::AdapterCapabilities;

/// Caller-facing configuration for a single patch transaction.
/// All references are borrowed; the harness clones the small strings it needs
/// to persist into the resulting [`PatchTransactionOutcome`].
pub struct PatchTransactionConfig<'a> {
    /// Engine adapter id, e.g. `"kaifuu-reallive"`.
    pub adapter_id: &'a str,
    /// Patch export id (uuid7) — propagates into the v0.2 PatchResult.
    pub patch_export_id: &'a str,
    /// Bridge unit id (uuid7) for the asset being patched.
    pub bridge_unit_id: &'a str,
    /// Asset id (uuid7) being patched.
    pub asset_id: &'a str,
    /// Final destination for the patched bytes (also the source file at
    /// preflight time).
    pub output_path: &'a Path,
    /// Expected sha256 (canonical `sha256:<64-hex>`) of the **source** bytes
    /// at `output_path` before the patch is applied.
    pub expected_source_hash: &'a str,
    /// Expected sha256 (canonical `sha256:<64-hex>`) of the **output** bytes
    /// after the patch is applied.
    pub expected_output_hash: &'a str,
    /// Expected payload length in bytes. Checked at preflight against
    /// `byte_budget` and against the on-disk source length (identity
    /// relocation).
    pub expected_payload_len: u64,
    /// Per-asset write budget in bytes. Payloads exceeding this are rejected
    /// at preflight.
    pub byte_budget: u64,
    /// Layered transform ids required for this patch. Each entry must appear
    /// in `adapter_capabilities.access_contract.patch` as a supported
    /// transform (surface/container/crypto/codec/patch_back).
    pub required_transforms: &'a [&'a str],
    /// Adapter capabilities. The harness consults the `patch` operation
    /// contract.
    pub adapter_capabilities: &'a AdapterCapabilities,
    /// Semantic command name, e.g. `"patch.write_string_slot"`.
    pub command: &'a str,
    /// Run id — included in the staging filename to allow concurrent runs.
    pub run_id: &'a str,
}

/// State of a [`super::PatchTransaction`].
/// The legal forward transitions are
/// `Idle → Preflight → Staged → Verified → Promoted`. Any failure routes
/// to the corresponding `*Failed` terminal state.
/// A stage-time write failure (the staged bytes never landed, so no atomic
/// rename was ever attempted) terminates in [`Self::StageFailed`], distinct
/// from [`Self::PromoteFailed`] which is reserved for a promote-time rename
/// failure (the staged bytes wrote and verified, but the final atomic swap
/// failed). Callers inspecting `outcome.final_state` can therefore tell a
/// safe-to-retry stage failure apart from a verify-passed promote failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionState {
    Idle,
    Preflight,
    Staged,
    Verified,
    Promoted,
    PreflightFailed,
    VerifyFailed,
    /// A stage-time write failure: the staged payload could not be written
    /// (or a stage-time invariant failed) and no rename was attempted.
    StageFailed,
    /// A promote-time rename failure: staging wrote and verified, but the
    /// atomic rename onto `output_path` failed and was rolled back.
    PromoteFailed,
    Cancelled,
}

impl TransactionState {
    pub(super) fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Promoted
                | Self::PreflightFailed
                | Self::VerifyFailed
                | Self::StageFailed
                | Self::PromoteFailed
                | Self::Cancelled
        )
    }
}

/// Diagnostic severity. `Fatal` blocks the transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticSeverity {
    Fatal,
}

/// Fixed enumeration of failure points used to classify a
/// [`TransactionDiagnostic`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreflightCheck {
    TransformSupport,
    ByteBudget,
    SourceMissing,
    SourceHash,
    Relocation,
    OutputHashFormat,
    StageWrite,
    StageCollision,
    StageRead,
    Verify,
    Promote,
    Cancel,
}

/// Failure category buckets, isomorphic to the v0.2
/// `PATCH_FAILURE_CATEGORIES_V02` allowed values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionFailureCategory {
    SourceIncompatible,
    PatchWriteFailed,
    AssetMissing,
    AdapterUnsupported,
    OutputHashMismatch,
}

impl TransactionFailureCategory {
    pub(crate) fn as_v02_category(self) -> &'static str {
        match self {
            Self::SourceIncompatible => "source_incompatible",
            Self::PatchWriteFailed => "patch_write_failed",
            Self::AssetMissing => "asset_missing",
            Self::AdapterUnsupported => "adapter_unsupported",
            Self::OutputHashMismatch => "output_hash_mismatch",
        }
    }
}

/// A single accumulated diagnostic from a transaction step.
#[derive(Debug, Clone)]
pub struct TransactionDiagnostic {
    pub check: PreflightCheck,
    pub category: TransactionFailureCategory,
    pub diagnostic_code: String,
    pub cause: String,
    pub severity: DiagnosticSeverity,
}

/// Aggregated preflight report — every diagnostic produced by `run_preflight`,
/// regardless of which check fired.
#[derive(Debug, Clone, Default)]
pub struct PreflightReport {
    pub diagnostics: Vec<TransactionDiagnostic>,
}

impl PreflightReport {
    pub fn is_clear(&self) -> bool {
        self.diagnostics.is_empty()
    }
}

/// Staged-write metadata returned by [`super::PatchTransaction::stage`].
#[derive(Debug, Clone)]
pub struct StagedPatchPayload {
    pub staged_path: PathBuf,
    pub payload_len: u64,
}

/// Final outcome of a transaction. Produced by [`super::PatchTransaction::into_outcome`].
#[derive(Debug, Clone)]
pub struct PatchTransactionOutcome {
    pub final_state: TransactionState,
    /// v0.2 PatchResult JSON, guaranteed (in debug builds) to pass
    /// [`crate::contracts::validate_patch_result_v02`].
    pub patch_result_v02: Value,
}

/// Errors signalling caller misuse of the state machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatchTransactionError {
    /// A method was called from a state that does not permit it.
    StateMachineMisuse {
        method: &'static str,
        state: TransactionState,
    },
}

impl std::fmt::Display for PatchTransactionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::StateMachineMisuse { method, state } => {
                write!(
                    f,
                    "patch_transaction::{method} called in invalid state {state:?}"
                )
            }
        }
    }
}

impl std::error::Error for PatchTransactionError {}
