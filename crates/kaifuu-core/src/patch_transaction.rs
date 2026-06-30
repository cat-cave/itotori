//! Engine-neutral binary patch transaction harness (KAIFUU-084).
//!
//! Drives `preflight → stage → verify → promote` with deterministic
//! rollback. The harness never modifies the final output path until every
//! preflight check passes and the staged bytes verify. On any failure the
//! staging file is deleted and the original output bytes are left intact.
//!
//! The harness emits a v0.2 PatchResult JSON (see
//! [`crate::contracts::validate_patch_result_v02`]) on every outcome — including
//! preflight failures — alongside the legacy in-Rust [`crate::PatchResult`]
//! shape used by the existing `EngineAdapter::patch` callers.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use sha2::{Digest, Sha256};

use crate::contracts::validate_patch_result_v02;
use crate::{
    AdapterCapabilities, BRIDGE_SCHEMA_VERSION_V02, CapabilityStatus,
    LayeredAccessOperationContract, OperationStatus, PatchResult,
    SEMANTIC_PATCH_RESULT_OUTPUT_HASH_DRIFT, SEMANTIC_PATCH_RESULT_SOURCE_INCOMPATIBLE,
    SEMANTIC_PATCH_TRANSACTION_BYTE_BUDGET_EXCEEDED, SEMANTIC_PATCH_TRANSACTION_CANCELLED,
    SEMANTIC_PATCH_TRANSACTION_EXPECTED_OUTPUT_HASH_MALFORMED,
    SEMANTIC_PATCH_TRANSACTION_PROMOTE_FAILED, SEMANTIC_PATCH_TRANSACTION_PROMOTE_ROLLED_BACK,
    SEMANTIC_PATCH_TRANSACTION_RELOCATION_UNSUPPORTED, SEMANTIC_PATCH_TRANSACTION_SOURCE_MISSING,
    SEMANTIC_PATCH_TRANSACTION_STAGED_COLLISION, SEMANTIC_PATCH_TRANSACTION_STAGED_READ_FAILED,
    SEMANTIC_PATCH_TRANSACTION_STAGED_VERIFY_ROLLED_BACK,
    SEMANTIC_PATCH_TRANSACTION_STAGED_WRITE_FAILED, SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM,
    sha256_hash_bytes,
};

/// Caller-facing configuration for a single patch transaction.
///
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

/// State of a [`PatchTransaction`].
///
/// The legal forward transitions are
/// `Idle → Preflight → Staged → Verified → Promoted`. Any failure routes
/// to the corresponding `*Failed` terminal state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactionState {
    Idle,
    Preflight,
    Staged,
    Verified,
    Promoted,
    PreflightFailed,
    VerifyFailed,
    PromoteFailed,
    Cancelled,
}

impl TransactionState {
    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Promoted
                | Self::PreflightFailed
                | Self::VerifyFailed
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
    fn as_v02_category(self) -> &'static str {
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

/// Staged-write metadata returned by [`PatchTransaction::stage`].
#[derive(Debug, Clone)]
pub struct StagedPatchPayload {
    pub staged_path: PathBuf,
    pub payload_len: u64,
}

/// Final outcome of a transaction. Produced by [`PatchTransaction::into_outcome`].
#[derive(Debug, Clone)]
pub struct PatchTransactionOutcome {
    pub final_state: TransactionState,
    /// v0.2 PatchResult JSON, guaranteed (in debug builds) to pass
    /// [`crate::contracts::validate_patch_result_v02`].
    pub patch_result_v02: Value,
    /// Legacy in-Rust struct preserved for existing `EngineAdapter::patch`
    /// callers.
    pub legacy_patch_result: PatchResult,
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

/// Engine-neutral binary patch transaction harness.
///
/// Construct with [`PatchTransaction::new`] then drive forward via
/// `run_preflight → stage → verify → promote`. On any failure the staged
/// file is cleaned up and the harness retains the diagnostics for emission
/// via [`PatchTransaction::into_outcome`].
pub struct PatchTransaction<'a> {
    config: PatchTransactionConfig<'a>,
    state: TransactionState,
    staged_path: Option<PathBuf>,
    diagnostics: Vec<TransactionDiagnostic>,
    preflight_payload_len: Option<u64>,
}

impl<'a> PatchTransaction<'a> {
    /// Create a new transaction in the [`TransactionState::Idle`] state.
    pub fn new(config: PatchTransactionConfig<'a>) -> Self {
        Self {
            config,
            state: TransactionState::Idle,
            staged_path: None,
            diagnostics: Vec::new(),
            preflight_payload_len: None,
        }
    }

    /// Current state of the transaction.
    pub fn state(&self) -> TransactionState {
        self.state
    }

    /// Run all five preflight checks. The harness accumulates every fatal
    /// diagnostic in a single pass so callers see the full list of blockers
    /// before any byte is written.
    ///
    /// If any check fires the harness transitions to
    /// [`TransactionState::PreflightFailed`] — no file is created or
    /// modified.
    pub fn run_preflight(&mut self) -> Result<PreflightReport, PatchTransactionError> {
        if self.state != TransactionState::Idle {
            return Err(PatchTransactionError::StateMachineMisuse {
                method: "run_preflight",
                state: self.state,
            });
        }
        self.state = TransactionState::Preflight;

        // Order is fixed for determinism. Each check appends at most one
        // fatal diagnostic, but every check runs.
        self.check_transform_support();
        self.check_byte_budget();
        let source_bytes = self.check_source();
        self.check_relocation(source_bytes.as_deref());
        self.check_output_hash_format();

        let report = PreflightReport {
            diagnostics: self.diagnostics.clone(),
        };
        if !report.is_clear() {
            self.state = TransactionState::PreflightFailed;
        }
        Ok(report)
    }

    fn check_transform_support(&mut self) {
        let patch_contract: Option<&LayeredAccessOperationContract> = self
            .config
            .adapter_capabilities
            .access_contract
            .as_ref()
            .map(|contract| &contract.patch);

        for transform_id in self.config.required_transforms {
            let supported = patch_contract
                .map(|contract| operation_contract_supports(contract, transform_id))
                .unwrap_or(false);
            if !supported {
                self.diagnostics.push(TransactionDiagnostic {
                    check: PreflightCheck::TransformSupport,
                    category: TransactionFailureCategory::AdapterUnsupported,
                    diagnostic_code: SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM.to_string(),
                    cause: format!(
                        "adapter {} does not declare layered transform {transform_id} as supported for the patch operation",
                        self.config.adapter_id
                    ),
                    severity: DiagnosticSeverity::Fatal,
                });
            }
        }
    }

    fn check_byte_budget(&mut self) {
        if self.config.expected_payload_len > self.config.byte_budget {
            self.diagnostics.push(TransactionDiagnostic {
                check: PreflightCheck::ByteBudget,
                category: TransactionFailureCategory::PatchWriteFailed,
                diagnostic_code: SEMANTIC_PATCH_TRANSACTION_BYTE_BUDGET_EXCEEDED.to_string(),
                cause: format!(
                    "expected payload length {} exceeds per-asset byte budget {}",
                    self.config.expected_payload_len, self.config.byte_budget
                ),
                severity: DiagnosticSeverity::Fatal,
            });
        }
    }

    fn check_source(&mut self) -> Option<Vec<u8>> {
        let source_bytes = match fs::read(self.config.output_path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == ErrorKind::NotFound => {
                self.diagnostics.push(TransactionDiagnostic {
                    check: PreflightCheck::SourceMissing,
                    category: TransactionFailureCategory::AssetMissing,
                    diagnostic_code: SEMANTIC_PATCH_TRANSACTION_SOURCE_MISSING.to_string(),
                    cause: format!(
                        "source bytes not found at {}",
                        self.config.output_path.display()
                    ),
                    severity: DiagnosticSeverity::Fatal,
                });
                return None;
            }
            Err(err) => {
                self.diagnostics.push(TransactionDiagnostic {
                    check: PreflightCheck::SourceMissing,
                    category: TransactionFailureCategory::AssetMissing,
                    diagnostic_code: SEMANTIC_PATCH_TRANSACTION_SOURCE_MISSING.to_string(),
                    cause: format!(
                        "failed to read source bytes at {}: {err}",
                        self.config.output_path.display()
                    ),
                    severity: DiagnosticSeverity::Fatal,
                });
                return None;
            }
        };
        let actual_hash = sha256_hash_bytes(&source_bytes);
        if actual_hash != self.config.expected_source_hash {
            self.diagnostics.push(TransactionDiagnostic {
                check: PreflightCheck::SourceHash,
                category: TransactionFailureCategory::SourceIncompatible,
                diagnostic_code: SEMANTIC_PATCH_RESULT_SOURCE_INCOMPATIBLE.to_string(),
                cause: format!(
                    "source hash drift at {}: expected {} but got {actual_hash}",
                    self.config.output_path.display(),
                    self.config.expected_source_hash
                ),
                severity: DiagnosticSeverity::Fatal,
            });
        }
        Some(source_bytes)
    }

    fn check_relocation(&mut self, source_bytes: Option<&[u8]>) {
        let Some(source_bytes) = source_bytes else {
            // Source already failed; relocation check needs the source
            // length, which would be misleading without bytes on disk.
            return;
        };
        if self.config.expected_payload_len != source_bytes.len() as u64 {
            self.diagnostics.push(TransactionDiagnostic {
                check: PreflightCheck::Relocation,
                category: TransactionFailureCategory::AdapterUnsupported,
                diagnostic_code: SEMANTIC_PATCH_TRANSACTION_RELOCATION_UNSUPPORTED.to_string(),
                cause: format!(
                    "non-identity relocation rejected: expected payload length {} != source length {}",
                    self.config.expected_payload_len,
                    source_bytes.len()
                ),
                severity: DiagnosticSeverity::Fatal,
            });
        }
        self.preflight_payload_len = Some(self.config.expected_payload_len);
    }

    fn check_output_hash_format(&mut self) {
        if !is_canonical_sha256(self.config.expected_output_hash) {
            self.diagnostics.push(TransactionDiagnostic {
                check: PreflightCheck::OutputHashFormat,
                category: TransactionFailureCategory::OutputHashMismatch,
                diagnostic_code: SEMANTIC_PATCH_TRANSACTION_EXPECTED_OUTPUT_HASH_MALFORMED
                    .to_string(),
                cause: format!(
                    "expected output hash must match sha256:[0-9a-f]{{64}} but was {:?}",
                    self.config.expected_output_hash
                ),
                severity: DiagnosticSeverity::Fatal,
            });
        }
    }

    /// Stage `payload` into `<output_dir>/.staging/<asset_id>-<run_id>.tmp`
    /// using exclusive-create open. The original output path is **not**
    /// touched.
    ///
    /// Requires the harness to be in [`TransactionState::Preflight`] with no
    /// recorded fatal diagnostics.
    pub fn stage(&mut self, payload: &[u8]) -> Result<StagedPatchPayload, PatchTransactionError> {
        if self.state != TransactionState::Preflight {
            return Err(PatchTransactionError::StateMachineMisuse {
                method: "stage",
                state: self.state,
            });
        }
        if !self.diagnostics.is_empty() {
            return Err(PatchTransactionError::StateMachineMisuse {
                method: "stage",
                state: self.state,
            });
        }
        let staged_path = staging_path_for(&self.config);

        // Enforce the preflighted payload-length guarantee on the real
        // bytes. run_preflight validated config.expected_payload_len
        // against the byte budget and the identity-relocation invariant
        // and recorded it as preflight_payload_len; the bytes actually
        // handed to stage() MUST match that length and re-satisfy the
        // byte budget, or those invariants would go unenforced on the
        // real content. Fail closed (fatal diagnostic, no write) on any
        // mismatch instead of silently staging an unvalidated payload.
        let actual_payload_len = payload.len() as u64;
        let preflighted_len = match self.preflight_payload_len {
            Some(len) => len,
            None => {
                self.record_stage_failure(
                    None,
                    PreflightCheck::Relocation,
                    TransactionFailureCategory::AdapterUnsupported,
                    SEMANTIC_PATCH_TRANSACTION_RELOCATION_UNSUPPORTED,
                    "stage invoked without a completed preflight payload-length check".to_string(),
                );
                return Ok(StagedPatchPayload {
                    staged_path,
                    payload_len: actual_payload_len,
                });
            }
        };
        if actual_payload_len != preflighted_len {
            self.record_stage_failure(
                None,
                PreflightCheck::Relocation,
                TransactionFailureCategory::AdapterUnsupported,
                SEMANTIC_PATCH_TRANSACTION_RELOCATION_UNSUPPORTED,
                format!(
                    "staged payload length {actual_payload_len} != preflighted payload length {preflighted_len}"
                ),
            );
            return Ok(StagedPatchPayload {
                staged_path,
                payload_len: actual_payload_len,
            });
        }
        if actual_payload_len > self.config.byte_budget {
            self.record_stage_failure(
                None,
                PreflightCheck::ByteBudget,
                TransactionFailureCategory::PatchWriteFailed,
                SEMANTIC_PATCH_TRANSACTION_BYTE_BUDGET_EXCEEDED,
                format!(
                    "staged payload length {actual_payload_len} exceeds per-asset byte budget {}",
                    self.config.byte_budget
                ),
            );
            return Ok(StagedPatchPayload {
                staged_path,
                payload_len: actual_payload_len,
            });
        }

        let parent = match staged_path.parent() {
            Some(parent) => parent,
            None => {
                self.record_stage_failure(
                    None,
                    PreflightCheck::StageWrite,
                    TransactionFailureCategory::PatchWriteFailed,
                    SEMANTIC_PATCH_TRANSACTION_STAGED_WRITE_FAILED,
                    "staged path has no parent directory".to_string(),
                );
                return Ok(StagedPatchPayload {
                    staged_path,
                    payload_len: payload.len() as u64,
                });
            }
        };
        if let Err(err) = fs::create_dir_all(parent) {
            self.record_stage_failure(
                None,
                PreflightCheck::StageWrite,
                TransactionFailureCategory::PatchWriteFailed,
                SEMANTIC_PATCH_TRANSACTION_STAGED_WRITE_FAILED,
                format!(
                    "failed to create staging directory {}: {err}",
                    parent.display()
                ),
            );
            return Ok(StagedPatchPayload {
                staged_path,
                payload_len: payload.len() as u64,
            });
        }

        let open = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged_path);
        let mut file = match open {
            Ok(file) => file,
            Err(err) if err.kind() == ErrorKind::AlreadyExists => {
                self.record_stage_failure(
                    None,
                    PreflightCheck::StageCollision,
                    TransactionFailureCategory::PatchWriteFailed,
                    SEMANTIC_PATCH_TRANSACTION_STAGED_COLLISION,
                    format!(
                        "staged file already exists at {} — refusing to overwrite a concurrent run",
                        staged_path.display()
                    ),
                );
                return Ok(StagedPatchPayload {
                    staged_path,
                    payload_len: payload.len() as u64,
                });
            }
            Err(err) => {
                self.record_stage_failure(
                    None,
                    PreflightCheck::StageWrite,
                    TransactionFailureCategory::PatchWriteFailed,
                    SEMANTIC_PATCH_TRANSACTION_STAGED_WRITE_FAILED,
                    format!(
                        "failed to open staged file {}: {err}",
                        staged_path.display()
                    ),
                );
                return Ok(StagedPatchPayload {
                    staged_path,
                    payload_len: payload.len() as u64,
                });
            }
        };
        if let Err(err) = file.write_all(payload) {
            self.record_stage_failure(
                Some(&staged_path),
                PreflightCheck::StageWrite,
                TransactionFailureCategory::PatchWriteFailed,
                SEMANTIC_PATCH_TRANSACTION_STAGED_WRITE_FAILED,
                format!(
                    "failed to write staged bytes to {}: {err}",
                    staged_path.display()
                ),
            );
            return Ok(StagedPatchPayload {
                staged_path,
                payload_len: payload.len() as u64,
            });
        }
        if let Err(err) = file.sync_all() {
            self.record_stage_failure(
                Some(&staged_path),
                PreflightCheck::StageWrite,
                TransactionFailureCategory::PatchWriteFailed,
                SEMANTIC_PATCH_TRANSACTION_STAGED_WRITE_FAILED,
                format!(
                    "failed to fsync staged bytes at {}: {err}",
                    staged_path.display()
                ),
            );
            return Ok(StagedPatchPayload {
                staged_path,
                payload_len: payload.len() as u64,
            });
        }

        self.state = TransactionState::Staged;
        self.staged_path = Some(staged_path.clone());
        Ok(StagedPatchPayload {
            staged_path,
            payload_len: payload.len() as u64,
        })
    }

    fn record_stage_failure(
        &mut self,
        staged_path: Option<&Path>,
        check: PreflightCheck,
        category: TransactionFailureCategory,
        diagnostic_code: &str,
        cause: String,
    ) {
        if let Some(path) = staged_path {
            let _ = fs::remove_file(path);
        }
        self.diagnostics.push(TransactionDiagnostic {
            check,
            category,
            diagnostic_code: diagnostic_code.to_string(),
            cause,
            severity: DiagnosticSeverity::Fatal,
        });
        self.state = TransactionState::PromoteFailed;
    }

    /// Re-read the staged payload and verify its sha256 matches
    /// `expected_output_hash`. Mismatches or read failures roll back the
    /// staged file.
    ///
    /// Requires the harness to be in [`TransactionState::Staged`].
    pub fn verify(&mut self) -> Result<(), PatchTransactionError> {
        if self.state != TransactionState::Staged {
            return Err(PatchTransactionError::StateMachineMisuse {
                method: "verify",
                state: self.state,
            });
        }
        let staged_path = self
            .staged_path
            .clone()
            .expect("staged_path is set in Staged state");
        let bytes = match fs::read(&staged_path) {
            Ok(bytes) => bytes,
            Err(err) => {
                let _ = fs::remove_file(&staged_path);
                self.diagnostics.push(TransactionDiagnostic {
                    check: PreflightCheck::StageRead,
                    category: TransactionFailureCategory::PatchWriteFailed,
                    diagnostic_code: SEMANTIC_PATCH_TRANSACTION_STAGED_READ_FAILED.to_string(),
                    cause: format!(
                        "failed to read staged bytes at {}: {err}",
                        staged_path.display()
                    ),
                    severity: DiagnosticSeverity::Fatal,
                });
                self.state = TransactionState::VerifyFailed;
                return Ok(());
            }
        };
        let actual_hash = sha256_hash_bytes(&bytes);
        if actual_hash != self.config.expected_output_hash {
            let _ = fs::remove_file(&staged_path);
            self.diagnostics.push(TransactionDiagnostic {
                check: PreflightCheck::Verify,
                category: TransactionFailureCategory::OutputHashMismatch,
                diagnostic_code: SEMANTIC_PATCH_RESULT_OUTPUT_HASH_DRIFT.to_string(),
                cause: format!(
                    "staged output hash drift at {}: expected {} but got {actual_hash}",
                    staged_path.display(),
                    self.config.expected_output_hash
                ),
                severity: DiagnosticSeverity::Fatal,
            });
            self.state = TransactionState::VerifyFailed;
            return Ok(());
        }
        self.state = TransactionState::Verified;
        Ok(())
    }

    /// Atomically rename the staged file over `output_path`. On POSIX this is
    /// atomic when both paths are on the same filesystem; the harness
    /// enforces same-filesystem siblings by construction (the staging
    /// directory is `<output_path>.parent()/.staging`).
    ///
    /// Requires the harness to be in [`TransactionState::Verified`].
    pub fn promote(&mut self) -> Result<(), PatchTransactionError> {
        if self.state != TransactionState::Verified {
            return Err(PatchTransactionError::StateMachineMisuse {
                method: "promote",
                state: self.state,
            });
        }
        let staged_path = self
            .staged_path
            .clone()
            .expect("staged_path is set in Verified state");
        if let Err(err) = fs::rename(&staged_path, self.config.output_path) {
            let _ = fs::remove_file(&staged_path);
            self.diagnostics.push(TransactionDiagnostic {
                check: PreflightCheck::Promote,
                category: TransactionFailureCategory::PatchWriteFailed,
                diagnostic_code: SEMANTIC_PATCH_TRANSACTION_PROMOTE_FAILED.to_string(),
                cause: format!(
                    "atomic rename failed from {} to {}: {err}",
                    staged_path.display(),
                    self.config.output_path.display()
                ),
                severity: DiagnosticSeverity::Fatal,
            });
            self.state = TransactionState::PromoteFailed;
            return Ok(());
        }
        self.state = TransactionState::Promoted;
        Ok(())
    }

    /// Cancel an in-flight transaction. From `Idle` or `Preflight` this is a
    /// no-op (no files exist yet); from `Staged` or `Verified` it deletes
    /// the staging file and transitions to [`TransactionState::Cancelled`].
    /// Calling `cancel` after `promote` returned `Ok` is misuse.
    pub fn cancel(&mut self) -> Result<(), PatchTransactionError> {
        match self.state {
            TransactionState::Idle | TransactionState::Preflight => {
                // No file to clean up. We still transition to Cancelled so
                // the caller can `into_outcome` and get a v0.2 report.
                self.diagnostics.push(TransactionDiagnostic {
                    check: PreflightCheck::Cancel,
                    category: TransactionFailureCategory::PatchWriteFailed,
                    diagnostic_code: SEMANTIC_PATCH_TRANSACTION_CANCELLED.to_string(),
                    cause: "transaction cancelled before any staged write".to_string(),
                    severity: DiagnosticSeverity::Fatal,
                });
                self.state = TransactionState::Cancelled;
                Ok(())
            }
            TransactionState::Staged | TransactionState::Verified => {
                if let Some(path) = self.staged_path.as_ref() {
                    let _ = fs::remove_file(path);
                }
                self.diagnostics.push(TransactionDiagnostic {
                    check: PreflightCheck::Cancel,
                    category: TransactionFailureCategory::PatchWriteFailed,
                    diagnostic_code: SEMANTIC_PATCH_TRANSACTION_CANCELLED.to_string(),
                    cause: "transaction cancelled after staging".to_string(),
                    severity: DiagnosticSeverity::Fatal,
                });
                self.state = TransactionState::Cancelled;
                Ok(())
            }
            TransactionState::Promoted => Err(PatchTransactionError::StateMachineMisuse {
                method: "cancel",
                state: self.state,
            }),
            TransactionState::PreflightFailed
            | TransactionState::VerifyFailed
            | TransactionState::PromoteFailed
            | TransactionState::Cancelled => {
                // Already terminal — cancel is a no-op.
                Ok(())
            }
        }
    }

    /// Consume the transaction and produce its final outcome.
    ///
    /// In debug builds the harness validates `patch_result_v02` against
    /// [`crate::contracts::validate_patch_result_v02`] so callers do not
    /// silently ship a malformed JSON.
    pub fn into_outcome(self) -> PatchTransactionOutcome {
        let final_state = if self.state.is_terminal() {
            self.state
        } else {
            // Caller forgot to drive the state machine to a terminal — emit
            // a Cancelled outcome so the contract validator stays happy.
            TransactionState::Cancelled
        };
        let patch_result_v02 = build_patch_result_v02(&self.config, final_state, &self.diagnostics);
        let legacy_patch_result = build_legacy_patch_result(&self.config, final_state);

        #[cfg(debug_assertions)]
        {
            debug_assert!(
                validate_patch_result_v02(&patch_result_v02).is_ok(),
                "patch_transaction emitted invalid PatchResult v0.2: {:?}",
                validate_patch_result_v02(&patch_result_v02)
            );
        }

        PatchTransactionOutcome {
            final_state,
            patch_result_v02,
            legacy_patch_result,
        }
    }
}

fn staging_path_for(config: &PatchTransactionConfig<'_>) -> PathBuf {
    let parent = config
        .output_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    parent
        .join(".staging")
        .join(format!("{}-{}.tmp", config.asset_id, config.run_id))
}

fn operation_contract_supports(
    contract: &LayeredAccessOperationContract,
    transform_id: &str,
) -> bool {
    if contract.status != CapabilityStatus::Supported {
        return false;
    }
    let lists = [
        contract
            .supported_surfaces
            .iter()
            .map(serde_json_snake_case)
            .collect::<Vec<_>>(),
        contract
            .supported_containers
            .iter()
            .map(serde_json_snake_case)
            .collect::<Vec<_>>(),
        contract
            .supported_crypto
            .iter()
            .map(serde_json_snake_case)
            .collect::<Vec<_>>(),
        contract
            .supported_codecs
            .iter()
            .map(serde_json_snake_case)
            .collect::<Vec<_>>(),
        contract
            .supported_patch_back
            .iter()
            .map(serde_json_snake_case)
            .collect::<Vec<_>>(),
    ];
    lists
        .iter()
        .any(|list| list.iter().any(|entry| entry == transform_id))
}

fn serde_json_snake_case<T: serde::Serialize>(value: &T) -> String {
    // The transform enums use #[serde(rename_all = "snake_case")], so their
    // JSON serialization is a plain string. We trim the surrounding quotes
    // to recover the snake_case token.
    let raw = serde_json::to_string(value).unwrap_or_default();
    raw.trim_matches('"').to_string()
}

fn is_canonical_sha256(value: &str) -> bool {
    if value.len() != 71 || !value.starts_with("sha256:") {
        return false;
    }
    value[7..]
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn build_legacy_patch_result(
    config: &PatchTransactionConfig<'_>,
    final_state: TransactionState,
) -> PatchResult {
    let status = if final_state == TransactionState::Promoted {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };
    let output_hash = if final_state == TransactionState::Promoted {
        config.expected_output_hash.to_string()
    } else {
        String::new()
    };
    PatchResult {
        schema_version: BRIDGE_SCHEMA_VERSION_V02.to_string(),
        patch_result_id: deterministic_uuid7(&[
            "patch-tx-rs",
            config.patch_export_id,
            config.asset_id,
            config.run_id,
            &format!("{final_state:?}"),
        ]),
        patch_export_id: config.patch_export_id.to_string(),
        status,
        output_hash,
        failures: vec![],
    }
}

fn build_patch_result_v02(
    config: &PatchTransactionConfig<'_>,
    final_state: TransactionState,
    diagnostics: &[TransactionDiagnostic],
) -> Value {
    let mut result = Map::new();
    result.insert(
        "schemaVersion".to_string(),
        Value::String(BRIDGE_SCHEMA_VERSION_V02.to_string()),
    );
    result.insert(
        "patchResultId".to_string(),
        Value::String(deterministic_uuid7(&[
            "patch-tx-result",
            config.patch_export_id,
            config.asset_id,
            config.run_id,
            &format!("{final_state:?}"),
        ])),
    );
    result.insert(
        "patchExportId".to_string(),
        Value::String(config.patch_export_id.to_string()),
    );
    result.insert(
        "adapterId".to_string(),
        Value::String(config.adapter_id.to_string()),
    );

    let status = match final_state {
        TransactionState::Promoted => "passed",
        TransactionState::PreflightFailed
        | TransactionState::VerifyFailed
        | TransactionState::PromoteFailed
        | TransactionState::Cancelled => "failed",
        _ => "failed", // non-terminal default routed via into_outcome
    };
    result.insert("status".to_string(), Value::String(status.to_string()));

    if status == "passed" {
        let touched = json!([{
            "assetId": config.asset_id,
            "outputHash": config.expected_output_hash,
            "byteSize": config.expected_payload_len,
        }]);
        let rollup = touched_assets_rollup(config);
        result.insert("touchedAssets".to_string(), touched);
        result.insert("outputHash".to_string(), Value::String(rollup));
        result.insert("failures".to_string(), Value::Array(vec![]));
    } else {
        let failures: Vec<Value> = diagnostics
            .iter()
            .enumerate()
            .map(|(index, diag)| build_failure_v02(config, diag, index))
            .collect();
        let mut categories: Vec<String> = diagnostics
            .iter()
            .map(|diag| diag.category.as_v02_category().to_string())
            .collect();
        categories.sort();
        categories.dedup();
        result.insert("failures".to_string(), Value::Array(failures));
        result.insert(
            "failureCategories".to_string(),
            Value::Array(categories.into_iter().map(Value::String).collect()),
        );
        result.insert(
            "partialWrite".to_string(),
            build_partial_write_v02(config, final_state, diagnostics),
        );
    }

    Value::Object(result)
}

fn build_failure_v02(
    config: &PatchTransactionConfig<'_>,
    diagnostic: &TransactionDiagnostic,
    index: usize,
) -> Value {
    json!({
        "failureId": deterministic_uuid7(&[
            "patch-tx-failure",
            config.patch_export_id,
            config.asset_id,
            config.run_id,
            &diagnostic.diagnostic_code,
            &format!("{index}"),
        ]),
        "category": diagnostic.category.as_v02_category(),
        "diagnosticCode": diagnostic.diagnostic_code,
        "cause": diagnostic.cause,
        "assetId": config.asset_id,
        "bridgeUnitId": config.bridge_unit_id,
        "adapterId": config.adapter_id,
        "command": config.command,
    })
}

fn build_partial_write_v02(
    config: &PatchTransactionConfig<'_>,
    final_state: TransactionState,
    diagnostics: &[TransactionDiagnostic],
) -> Value {
    let disposition = match final_state {
        TransactionState::Cancelled => "cleaned_up",
        _ => "rolled_back",
    };
    let rollback_diagnostic = rollback_diagnostic_code(final_state, diagnostics);
    json!({
        "attemptedAssetIds": [config.asset_id],
        "writtenAssetIds": [],
        "skippedAssetIds": [config.asset_id],
        "disposition": disposition,
        "rollbackDiagnosticCode": rollback_diagnostic,
    })
}

fn rollback_diagnostic_code(
    final_state: TransactionState,
    diagnostics: &[TransactionDiagnostic],
) -> String {
    match final_state {
        TransactionState::VerifyFailed => {
            SEMANTIC_PATCH_TRANSACTION_STAGED_VERIFY_ROLLED_BACK.to_string()
        }
        TransactionState::PromoteFailed => {
            // Distinguish stage-time failures (recorded as PromoteFailed) from
            // an actual rename failure; the diagnostic code that fired is the
            // most precise rollback marker.
            if diagnostics
                .iter()
                .any(|d| d.diagnostic_code == SEMANTIC_PATCH_TRANSACTION_PROMOTE_FAILED)
            {
                SEMANTIC_PATCH_TRANSACTION_PROMOTE_ROLLED_BACK.to_string()
            } else {
                diagnostics
                    .first()
                    .map(|d| d.diagnostic_code.clone())
                    .unwrap_or_else(|| SEMANTIC_PATCH_TRANSACTION_STAGED_WRITE_FAILED.to_string())
            }
        }
        TransactionState::Cancelled => SEMANTIC_PATCH_TRANSACTION_CANCELLED.to_string(),
        _ => diagnostics
            .first()
            .map(|d| d.diagnostic_code.clone())
            .unwrap_or_else(|| SEMANTIC_PATCH_TRANSACTION_CANCELLED.to_string()),
    }
}

fn touched_assets_rollup(config: &PatchTransactionConfig<'_>) -> String {
    // Single-asset rollup: sha256(format!("{assetId}\n{outputHash}\n")).
    let payload = format!("{}\n{}\n", config.asset_id, config.expected_output_hash);
    sha256_hash_bytes(payload.as_bytes())
}

/// Build a deterministic UUID7-shaped string from the supplied parts.
///
/// The UUID variant byte (position 19, i.e. the first hex char of the fourth
/// group) is forced into `8..=b` and the version nibble (position 14) is
/// forced to `7`, matching `assert_uuid7` in the contracts validator.
fn deterministic_uuid7(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    // 8-4-4-4-12 layout. We fix the version (group 3 first hex) to '7' and
    // the variant (group 4 first hex) to '8'.
    let g1 = &hex[0..8];
    let g2 = &hex[8..12];
    let g3 = &hex[12..16];
    let g4 = &hex[16..20];
    let g5 = &hex[20..32];
    // Force version 7 (position 14 in the final string, position 0 of g3).
    let g3 = format!("7{}", &g3[1..]);
    // Force variant 8 (position 19 of the final string, position 0 of g4).
    let g4 = format!("8{}", &g4[1..]);
    format!("{g1}-{g2}-{g3}-{g4}-{g5}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AdapterCapabilities, AdapterCapabilityMatrix, CapabilityStatus,
        LayeredAccessCapabilityContract, LayeredAccessOperationContract,
    };

    const ADAPTER_ID: &str = "kaifuu-fixture";
    const PATCH_EXPORT_ID: &str = "0190a000-0000-7000-8000-000000000001";
    const BRIDGE_UNIT_ID: &str = "0190a000-0000-7000-8000-000000000002";
    const ASSET_ID: &str = "0190a000-0000-7000-8000-000000000003";
    const RUN_ID: &str = "run-001";
    const COMMAND: &str = "patch.write_string_slot";

    /// Patch-transaction tests run inside `kaifuu-core`'s own crate boundary
    /// and exercise the access-contract machinery directly; the level matrix
    /// is not the subject of these tests, but KAIFUU-053 requires every
    /// `AdapterCapabilities` to declare one. Use the explicitly-derived
    /// matrix from an empty report vec (every rung Unsupported) so the
    /// fixture cannot be mistaken for an adapter that supports
    /// inventory/extract/patch from registry-side gates.
    fn fixture_matrix() -> AdapterCapabilityMatrix {
        AdapterCapabilityMatrix::derive_from_reports(ADAPTER_ID, &[])
    }

    fn capabilities_with_identity_patch() -> AdapterCapabilities {
        AdapterCapabilities::new(ADAPTER_ID, vec![], fixture_matrix())
            .with_access_contract(LayeredAccessCapabilityContract::plaintext_identity())
    }

    fn capabilities_with_no_access_contract() -> AdapterCapabilities {
        AdapterCapabilities::new(ADAPTER_ID, vec![], fixture_matrix())
    }

    fn capabilities_with_unsupported_patch() -> AdapterCapabilities {
        let mut contract = LayeredAccessCapabilityContract::plaintext_identity();
        contract.patch = LayeredAccessOperationContract {
            status: CapabilityStatus::Unsupported,
            required_capabilities: vec![],
            supported_surfaces: vec![],
            supported_containers: vec![],
            supported_crypto: vec![],
            supported_codecs: vec![],
            supported_patch_back: vec![],
            support_boundary: Some("intentionally unsupported".to_string()),
        };
        AdapterCapabilities::new(ADAPTER_ID, vec![], fixture_matrix())
            .with_access_contract(contract)
    }

    fn make_config<'a>(
        output_path: &'a Path,
        expected_source_hash: &'a str,
        expected_output_hash: &'a str,
        expected_payload_len: u64,
        byte_budget: u64,
        required_transforms: &'a [&'a str],
        capabilities: &'a AdapterCapabilities,
    ) -> PatchTransactionConfig<'a> {
        PatchTransactionConfig {
            adapter_id: ADAPTER_ID,
            patch_export_id: PATCH_EXPORT_ID,
            bridge_unit_id: BRIDGE_UNIT_ID,
            asset_id: ASSET_ID,
            output_path,
            expected_source_hash,
            expected_output_hash,
            expected_payload_len,
            byte_budget,
            required_transforms,
            adapter_capabilities: capabilities,
            command: COMMAND,
            run_id: RUN_ID,
        }
    }

    fn write_source(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, bytes).unwrap();
    }

    fn touched_assets_rollup_for(asset_id: &str, output_hash: &str) -> String {
        let payload = format!("{asset_id}\n{output_hash}\n");
        sha256_hash_bytes(payload.as_bytes())
    }

    #[test]
    fn patches_then_verifies_a_length_preserving_payload() {
        let dir = tempfile::tempdir().unwrap();
        let output_path = dir.path().join("SEEN.TXT");
        let source = vec![b'A'; 32];
        let target: Vec<u8> = (0..32u8).collect();
        write_source(&output_path, &source);
        let expected_source_hash = sha256_hash_bytes(&source);
        let expected_output_hash = sha256_hash_bytes(&target);
        let capabilities = capabilities_with_identity_patch();
        let required = ["identity"];
        let config = make_config(
            &output_path,
            &expected_source_hash,
            &expected_output_hash,
            target.len() as u64,
            target.len() as u64,
            &required,
            &capabilities,
        );

        let mut transaction = PatchTransaction::new(config);
        let report = transaction.run_preflight().unwrap();
        assert!(
            report.is_clear(),
            "expected clean preflight, got {report:?}"
        );
        transaction.stage(&target).unwrap();
        transaction.verify().unwrap();
        transaction.promote().unwrap();
        assert_eq!(transaction.state(), TransactionState::Promoted);

        let outcome = transaction.into_outcome();
        assert_eq!(outcome.final_state, TransactionState::Promoted);
        assert_eq!(
            fs::read(&output_path).unwrap(),
            target,
            "promote should write target bytes to output_path"
        );
        assert!(
            !dir.path()
                .join(".staging")
                .join(format!("{ASSET_ID}-{RUN_ID}.tmp"))
                .exists(),
            "staging file should be removed after promote"
        );
        assert_eq!(outcome.patch_result_v02["status"], "passed");
        assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
        let touched = outcome.patch_result_v02["touchedAssets"]
            .as_array()
            .unwrap();
        assert_eq!(touched.len(), 1);
        assert_eq!(
            touched[0]["outputHash"].as_str().unwrap(),
            expected_output_hash
        );
        let expected_rollup = touched_assets_rollup_for(ASSET_ID, &expected_output_hash);
        assert_eq!(
            outcome.patch_result_v02["outputHash"].as_str().unwrap(),
            expected_rollup
        );
    }

    #[test]
    fn rejects_payload_that_exceeds_byte_budget_before_any_write() {
        let dir = tempfile::tempdir().unwrap();
        let output_path = dir.path().join("SEEN.TXT");
        let source = vec![b'A'; 32];
        write_source(&output_path, &source);
        let expected_source_hash = sha256_hash_bytes(&source);
        // Provide a syntactically valid sha256 placeholder for the output.
        let expected_output_hash = "sha256:".to_string() + &"0".repeat(64);
        let capabilities = capabilities_with_identity_patch();
        let required = ["identity"];
        let config = make_config(
            &output_path,
            &expected_source_hash,
            &expected_output_hash,
            32,
            16,
            &required,
            &capabilities,
        );
        let mut transaction = PatchTransaction::new(config);
        let report = transaction.run_preflight().unwrap();
        assert!(!report.is_clear());
        assert_eq!(transaction.state(), TransactionState::PreflightFailed);
        // Staging dir should not exist — no writes happened.
        assert!(
            !dir.path().join(".staging").exists(),
            "preflight must not create the staging directory"
        );
        // Output untouched.
        assert_eq!(fs::read(&output_path).unwrap(), source);

        let outcome = transaction.into_outcome();
        assert_eq!(outcome.final_state, TransactionState::PreflightFailed);
        assert_eq!(outcome.patch_result_v02["status"], "failed");
        let failures = outcome.patch_result_v02["failures"].as_array().unwrap();
        let codes: Vec<&str> = failures
            .iter()
            .map(|f| f["diagnosticCode"].as_str().unwrap())
            .collect();
        assert!(codes.contains(&SEMANTIC_PATCH_TRANSACTION_BYTE_BUDGET_EXCEEDED));
        let categories: Vec<&str> = failures
            .iter()
            .map(|f| f["category"].as_str().unwrap())
            .collect();
        assert!(categories.contains(&"patch_write_failed"));
        let partial = &outcome.patch_result_v02["partialWrite"];
        assert_eq!(partial["disposition"], "rolled_back");
        assert!(partial["writtenAssetIds"].as_array().unwrap().is_empty());
        assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
    }

    #[test]
    fn rejects_when_source_bytes_drifted_from_expected_hash() {
        let dir = tempfile::tempdir().unwrap();
        let output_path = dir.path().join("SEEN.TXT");
        let source = vec![b'A'; 32];
        write_source(&output_path, &source);
        let expected_source_hash = "sha256:".to_string() + &"b".repeat(64);
        let target = vec![b'B'; 32];
        let expected_output_hash = sha256_hash_bytes(&target);
        let capabilities = capabilities_with_identity_patch();
        let required = ["identity"];
        let config = make_config(
            &output_path,
            &expected_source_hash,
            &expected_output_hash,
            32,
            32,
            &required,
            &capabilities,
        );
        let mut transaction = PatchTransaction::new(config);
        transaction.run_preflight().unwrap();
        assert_eq!(transaction.state(), TransactionState::PreflightFailed);
        let outcome = transaction.into_outcome();
        let categories: Vec<&str> = outcome.patch_result_v02["failures"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["category"].as_str().unwrap())
            .collect();
        assert!(categories.contains(&"source_incompatible"));
        assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
    }

    #[test]
    fn rejects_when_source_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let output_path = dir.path().join("missing.bin");
        let expected_source_hash = "sha256:".to_string() + &"a".repeat(64);
        let expected_output_hash = "sha256:".to_string() + &"b".repeat(64);
        let capabilities = capabilities_with_identity_patch();
        let required = ["identity"];
        let config = make_config(
            &output_path,
            &expected_source_hash,
            &expected_output_hash,
            16,
            32,
            &required,
            &capabilities,
        );
        let mut transaction = PatchTransaction::new(config);
        transaction.run_preflight().unwrap();
        assert_eq!(transaction.state(), TransactionState::PreflightFailed);
        let outcome = transaction.into_outcome();
        let categories: Vec<&str> = outcome.patch_result_v02["failures"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["category"].as_str().unwrap())
            .collect();
        assert!(categories.contains(&"asset_missing"));
        assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
    }

    #[test]
    fn rejects_when_required_transform_is_not_declared_by_the_adapter() {
        let dir = tempfile::tempdir().unwrap();
        let output_path = dir.path().join("SEEN.TXT");
        let source = vec![b'A'; 16];
        write_source(&output_path, &source);
        let expected_source_hash = sha256_hash_bytes(&source);
        let target = vec![b'B'; 16];
        let expected_output_hash = sha256_hash_bytes(&target);
        let capabilities = capabilities_with_no_access_contract();
        let required = ["non_existent_transform"];
        let config = make_config(
            &output_path,
            &expected_source_hash,
            &expected_output_hash,
            16,
            32,
            &required,
            &capabilities,
        );
        let mut transaction = PatchTransaction::new(config);
        transaction.run_preflight().unwrap();
        let outcome = transaction.into_outcome();
        let categories: Vec<&str> = outcome.patch_result_v02["failures"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["category"].as_str().unwrap())
            .collect();
        assert!(categories.contains(&"adapter_unsupported"));
        assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
    }

    #[test]
    fn rejects_when_patch_operation_contract_is_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let output_path = dir.path().join("SEEN.TXT");
        let source = vec![b'A'; 16];
        write_source(&output_path, &source);
        let expected_source_hash = sha256_hash_bytes(&source);
        let target = vec![b'B'; 16];
        let expected_output_hash = sha256_hash_bytes(&target);
        let capabilities = capabilities_with_unsupported_patch();
        let required = ["identity"];
        let config = make_config(
            &output_path,
            &expected_source_hash,
            &expected_output_hash,
            16,
            32,
            &required,
            &capabilities,
        );
        let mut transaction = PatchTransaction::new(config);
        transaction.run_preflight().unwrap();
        let outcome = transaction.into_outcome();
        let codes: Vec<&str> = outcome.patch_result_v02["failures"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["diagnosticCode"].as_str().unwrap())
            .collect();
        assert!(codes.contains(&SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM));
    }

    #[test]
    fn rejects_non_length_preserving_relocation() {
        let dir = tempfile::tempdir().unwrap();
        let output_path = dir.path().join("SEEN.TXT");
        let source = vec![b'A'; 32];
        write_source(&output_path, &source);
        let expected_source_hash = sha256_hash_bytes(&source);
        // expected_payload_len 24 != source.len() 32 → relocation rejection.
        let target = vec![b'B'; 24];
        let expected_output_hash = sha256_hash_bytes(&target);
        let capabilities = capabilities_with_identity_patch();
        let required = ["identity"];
        let config = make_config(
            &output_path,
            &expected_source_hash,
            &expected_output_hash,
            24,
            32,
            &required,
            &capabilities,
        );
        let mut transaction = PatchTransaction::new(config);
        transaction.run_preflight().unwrap();
        let outcome = transaction.into_outcome();
        let codes: Vec<&str> = outcome.patch_result_v02["failures"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["diagnosticCode"].as_str().unwrap())
            .collect();
        assert!(codes.contains(&SEMANTIC_PATCH_TRANSACTION_RELOCATION_UNSUPPORTED));
        let categories: Vec<&str> = outcome.patch_result_v02["failures"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["category"].as_str().unwrap())
            .collect();
        assert!(categories.contains(&"adapter_unsupported"));
        assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
    }

    #[test]
    fn rejects_malformed_expected_output_hash() {
        let dir = tempfile::tempdir().unwrap();
        let output_path = dir.path().join("SEEN.TXT");
        let source = vec![b'A'; 16];
        write_source(&output_path, &source);
        let expected_source_hash = sha256_hash_bytes(&source);
        let bad_hash = "not-a-hash";
        let capabilities = capabilities_with_identity_patch();
        let required = ["identity"];
        let config = make_config(
            &output_path,
            &expected_source_hash,
            bad_hash,
            16,
            32,
            &required,
            &capabilities,
        );
        let mut transaction = PatchTransaction::new(config);
        transaction.run_preflight().unwrap();
        let outcome = transaction.into_outcome();
        let codes: Vec<&str> = outcome.patch_result_v02["failures"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["diagnosticCode"].as_str().unwrap())
            .collect();
        assert!(codes.contains(&SEMANTIC_PATCH_TRANSACTION_EXPECTED_OUTPUT_HASH_MALFORMED));
        assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
    }

    #[test]
    fn rolls_back_staged_payload_when_verify_hash_mismatches() {
        let dir = tempfile::tempdir().unwrap();
        let output_path = dir.path().join("SEEN.TXT");
        let source = vec![b'A'; 32];
        write_source(&output_path, &source);
        let expected_source_hash = sha256_hash_bytes(&source);
        let intended = vec![b'B'; 32];
        let expected_output_hash = sha256_hash_bytes(&intended);
        // Stage a payload that does not hash to expected_output_hash.
        let mut bad_payload = intended.clone();
        bad_payload[0] ^= 0xff;
        let capabilities = capabilities_with_identity_patch();
        let required = ["identity"];
        let config = make_config(
            &output_path,
            &expected_source_hash,
            &expected_output_hash,
            32,
            32,
            &required,
            &capabilities,
        );
        let mut transaction = PatchTransaction::new(config);
        transaction.run_preflight().unwrap();
        transaction.stage(&bad_payload).unwrap();
        transaction.verify().unwrap();
        assert_eq!(transaction.state(), TransactionState::VerifyFailed);

        let staged_path = dir
            .path()
            .join(".staging")
            .join(format!("{ASSET_ID}-{RUN_ID}.tmp"));
        assert!(
            !staged_path.exists(),
            "verify should remove the staged file"
        );
        assert_eq!(
            fs::read(&output_path).unwrap(),
            source,
            "output path must still hold the original source bytes"
        );
        let outcome = transaction.into_outcome();
        let failures = outcome.patch_result_v02["failures"].as_array().unwrap();
        assert!(
            failures
                .iter()
                .any(|f| f["category"] == "output_hash_mismatch")
        );
        let partial = &outcome.patch_result_v02["partialWrite"];
        assert_eq!(partial["disposition"], "rolled_back");
        assert_eq!(
            partial["rollbackDiagnosticCode"].as_str().unwrap(),
            SEMANTIC_PATCH_TRANSACTION_STAGED_VERIFY_ROLLED_BACK
        );
        assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
    }

    #[test]
    fn rejects_staged_payload_whose_length_differs_from_preflight() {
        // A payload whose actual length differs from the preflighted
        // expected_payload_len must fail closed: the staged file is never
        // written and a fatal relocation diagnostic is recorded, instead
        // of silently staging an unvalidated payload.
        let dir = tempfile::tempdir().unwrap();
        let output_path = dir.path().join("SEEN.TXT");
        let source = vec![b'A'; 32];
        write_source(&output_path, &source);
        let expected_source_hash = sha256_hash_bytes(&source);
        let intended = vec![b'B'; 32];
        let expected_output_hash = sha256_hash_bytes(&intended);
        let capabilities = capabilities_with_identity_patch();
        let required = ["identity"];
        let config = make_config(
            &output_path,
            &expected_source_hash,
            &expected_output_hash,
            32,
            32,
            &required,
            &capabilities,
        );
        let mut transaction = PatchTransaction::new(config);
        let report = transaction.run_preflight().unwrap();
        assert!(
            report.is_clear(),
            "expected clean preflight, got {report:?}"
        );
        // Stage a payload one byte longer than the preflighted length.
        let oversized = vec![b'B'; 33];
        transaction.stage(&oversized).unwrap();
        assert_eq!(transaction.state(), TransactionState::PromoteFailed);
        let staged_path = dir
            .path()
            .join(".staging")
            .join(format!("{ASSET_ID}-{RUN_ID}.tmp"));
        assert!(
            !staged_path.exists(),
            "mismatched payload must never be written to the staging file"
        );
        assert_eq!(
            fs::read(&output_path).unwrap(),
            source,
            "output path must still hold the original source bytes"
        );
        let outcome = transaction.into_outcome();
        let failures = outcome.patch_result_v02["failures"].as_array().unwrap();
        let codes: Vec<&str> = failures
            .iter()
            .map(|f| f["diagnosticCode"].as_str().unwrap())
            .collect();
        assert!(codes.contains(&SEMANTIC_PATCH_TRANSACTION_RELOCATION_UNSUPPORTED));
        assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
    }

    #[test]
    fn rolls_back_when_promote_rename_fails() {
        let dir = tempfile::tempdir().unwrap();
        let output_path = dir.path().join("SEEN.TXT");
        let source = vec![b'A'; 32];
        write_source(&output_path, &source);
        let expected_source_hash = sha256_hash_bytes(&source);
        let target = vec![b'B'; 32];
        let expected_output_hash = sha256_hash_bytes(&target);
        let capabilities = capabilities_with_identity_patch();
        let required = ["identity"];
        let config = make_config(
            &output_path,
            &expected_source_hash,
            &expected_output_hash,
            32,
            32,
            &required,
            &capabilities,
        );
        let mut transaction = PatchTransaction::new(config);
        transaction.run_preflight().unwrap();
        transaction.stage(&target).unwrap();
        transaction.verify().unwrap();
        // Replace output_path with a non-empty directory to force a rename
        // failure: POSIX `rename` cannot replace a non-empty directory with
        // a regular file.
        fs::remove_file(&output_path).unwrap();
        fs::create_dir(&output_path).unwrap();
        fs::write(output_path.join("guard.bin"), b"guard").unwrap();
        transaction.promote().unwrap();
        assert_eq!(transaction.state(), TransactionState::PromoteFailed);
        let staged_path = dir
            .path()
            .join(".staging")
            .join(format!("{ASSET_ID}-{RUN_ID}.tmp"));
        assert!(
            !staged_path.exists(),
            "promote failure should remove staged file"
        );
        let outcome = transaction.into_outcome();
        let codes: Vec<&str> = outcome.patch_result_v02["failures"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["diagnosticCode"].as_str().unwrap())
            .collect();
        assert!(codes.contains(&SEMANTIC_PATCH_TRANSACTION_PROMOTE_FAILED));
        let partial = &outcome.patch_result_v02["partialWrite"];
        assert_eq!(partial["disposition"], "rolled_back");
        assert_eq!(
            partial["rollbackDiagnosticCode"].as_str().unwrap(),
            SEMANTIC_PATCH_TRANSACTION_PROMOTE_ROLLED_BACK
        );
        assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
    }

    #[test]
    fn cancels_after_stage_and_cleans_up_staging() {
        let dir = tempfile::tempdir().unwrap();
        let output_path = dir.path().join("SEEN.TXT");
        let source = vec![b'A'; 32];
        write_source(&output_path, &source);
        let expected_source_hash = sha256_hash_bytes(&source);
        let target = vec![b'B'; 32];
        let expected_output_hash = sha256_hash_bytes(&target);
        let capabilities = capabilities_with_identity_patch();
        let required = ["identity"];
        let config = make_config(
            &output_path,
            &expected_source_hash,
            &expected_output_hash,
            32,
            32,
            &required,
            &capabilities,
        );
        let mut transaction = PatchTransaction::new(config);
        transaction.run_preflight().unwrap();
        transaction.stage(&target).unwrap();
        transaction.cancel().unwrap();
        assert_eq!(transaction.state(), TransactionState::Cancelled);
        let staged_path = dir
            .path()
            .join(".staging")
            .join(format!("{ASSET_ID}-{RUN_ID}.tmp"));
        assert!(!staged_path.exists());
        assert_eq!(fs::read(&output_path).unwrap(), source);
        let outcome = transaction.into_outcome();
        let partial = &outcome.patch_result_v02["partialWrite"];
        assert_eq!(partial["disposition"], "cleaned_up");
        assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
    }

    #[test]
    fn rejects_double_promote_with_state_machine_misuse_error() {
        let dir = tempfile::tempdir().unwrap();
        let output_path = dir.path().join("SEEN.TXT");
        let source = vec![b'A'; 16];
        let target = vec![b'B'; 16];
        write_source(&output_path, &source);
        let expected_source_hash = sha256_hash_bytes(&source);
        let expected_output_hash = sha256_hash_bytes(&target);
        let capabilities = capabilities_with_identity_patch();
        let required = ["identity"];
        let config = make_config(
            &output_path,
            &expected_source_hash,
            &expected_output_hash,
            16,
            16,
            &required,
            &capabilities,
        );
        let mut transaction = PatchTransaction::new(config);
        transaction.run_preflight().unwrap();
        transaction.stage(&target).unwrap();
        transaction.verify().unwrap();
        transaction.promote().unwrap();
        let err = transaction.promote().unwrap_err();
        assert!(matches!(
            err,
            PatchTransactionError::StateMachineMisuse {
                method: "promote",
                state: TransactionState::Promoted
            }
        ));
    }

    #[test]
    fn rejects_a_second_stage_when_the_same_run_id_is_already_staged() {
        let dir = tempfile::tempdir().unwrap();
        let output_path = dir.path().join("SEEN.TXT");
        let source = vec![b'A'; 16];
        let target = vec![b'B'; 16];
        write_source(&output_path, &source);
        let expected_source_hash = sha256_hash_bytes(&source);
        let expected_output_hash = sha256_hash_bytes(&target);
        let capabilities = capabilities_with_identity_patch();
        let required = ["identity"];
        // Pre-create the staging file out-of-band to simulate a concurrent run.
        let staging_dir = dir.path().join(".staging");
        fs::create_dir_all(&staging_dir).unwrap();
        let existing = staging_dir.join(format!("{ASSET_ID}-{RUN_ID}.tmp"));
        fs::write(&existing, b"squatter").unwrap();

        let config = make_config(
            &output_path,
            &expected_source_hash,
            &expected_output_hash,
            16,
            16,
            &required,
            &capabilities,
        );
        let mut transaction = PatchTransaction::new(config);
        transaction.run_preflight().unwrap();
        transaction.stage(&target).unwrap();
        assert_eq!(transaction.state(), TransactionState::PromoteFailed);
        // Squatter file is preserved — we did not remove it (we never owned it).
        assert!(existing.exists());
        let outcome = transaction.into_outcome();
        let codes: Vec<&str> = outcome.patch_result_v02["failures"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["diagnosticCode"].as_str().unwrap())
            .collect();
        assert!(codes.contains(&SEMANTIC_PATCH_TRANSACTION_STAGED_COLLISION));
        assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
    }

    #[test]
    fn cancel_before_preflight_emits_valid_failed_result() {
        let dir = tempfile::tempdir().unwrap();
        let output_path = dir.path().join("SEEN.TXT");
        write_source(&output_path, b"x");
        let source_hash = sha256_hash_bytes(b"x");
        let output_hash = sha256_hash_bytes(b"y");
        let capabilities = capabilities_with_identity_patch();
        let required = ["identity"];
        let config = make_config(
            &output_path,
            &source_hash,
            &output_hash,
            1,
            1,
            &required,
            &capabilities,
        );
        let mut transaction = PatchTransaction::new(config);
        transaction.cancel().unwrap();
        let outcome = transaction.into_outcome();
        assert_eq!(outcome.final_state, TransactionState::Cancelled);
        assert!(validate_patch_result_v02(&outcome.patch_result_v02).is_ok());
    }
}
