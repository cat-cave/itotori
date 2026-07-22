//! Engine-neutral binary patch transaction harness.
//! Drives `preflight → stage → verify → promote` with deterministic
//! rollback. The harness never modifies the final output path until every
//! preflight check passes and the staged bytes verify. On any failure the
//! staging file is deleted and the original output bytes are left intact.
//! The harness emits a v0.2 PatchResult JSON (see
//! [`crate::contracts::validate_patch_result_v02`]) on every outcome — including
//! preflight failures. This v0.2 surface is the sole patch-result
//! representation the harness produces.

use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

#[cfg(any(debug_assertions, test))]
use crate::contracts::validate_patch_result_v02;
use crate::{
    LayeredAccessOperationContract, SEMANTIC_PATCH_RESULT_SOURCE_INCOMPATIBLE,
    SEMANTIC_PATCH_TRANSACTION_BYTE_BUDGET_EXCEEDED,
    SEMANTIC_PATCH_TRANSACTION_EXPECTED_OUTPUT_HASH_MALFORMED,
    SEMANTIC_PATCH_TRANSACTION_RELOCATION_UNSUPPORTED, SEMANTIC_PATCH_TRANSACTION_SOURCE_MISSING,
    SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM, sha256_hash_bytes,
};

mod helpers;
mod types;
mod write_lifecycle;

pub use self::types::{
    DiagnosticSeverity, PatchTransactionConfig, PatchTransactionError, PatchTransactionOutcome,
    PreflightCheck, PreflightReport, StagedPatchPayload, TransactionDiagnostic,
    TransactionFailureCategory, TransactionState,
};

use self::helpers::{build_patch_result_v02, is_canonical_sha256, operation_contract_supports};

/// Engine-neutral binary patch transaction harness.
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
                .is_some_and(|contract| operation_contract_supports(contract, transform_id));
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

    /// Consume the transaction and produce its final outcome.
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
        }
    }
}

#[cfg(test)]
#[path = "patch_transaction/tests.rs"]
mod tests;
