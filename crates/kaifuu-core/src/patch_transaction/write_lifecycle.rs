//! Staged-write lifecycle for the patch transaction harness.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::Path;

use crate::{
    SEMANTIC_PATCH_RESULT_OUTPUT_HASH_DRIFT, SEMANTIC_PATCH_TRANSACTION_BYTE_BUDGET_EXCEEDED,
    SEMANTIC_PATCH_TRANSACTION_CANCELLED, SEMANTIC_PATCH_TRANSACTION_PROMOTE_FAILED,
    SEMANTIC_PATCH_TRANSACTION_RELOCATION_UNSUPPORTED, SEMANTIC_PATCH_TRANSACTION_STAGED_COLLISION,
    SEMANTIC_PATCH_TRANSACTION_STAGED_READ_FAILED, SEMANTIC_PATCH_TRANSACTION_STAGED_WRITE_FAILED,
    sha256_hash_bytes,
};

use super::PatchTransaction;
use super::helpers::staging_path_for;
use super::types::{
    DiagnosticSeverity, PatchTransactionError, PreflightCheck, StagedPatchPayload,
    TransactionDiagnostic, TransactionFailureCategory, TransactionState,
};

impl PatchTransaction<'_> {
    /// Stage `payload` into `<output_dir>/.staging/<asset_id>-<run_id>.tmp`
    /// using exclusive-create open. The original output path is **not**
    /// touched.
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
        // handed to stage MUST match that length and re-satisfy the
        // byte budget, or those invariants would go unenforced on the
        // real content. Fail closed (fatal diagnostic, no write) on any
        // mismatch instead of silently staging an unvalidated payload.
        let actual_payload_len = payload.len() as u64;
        let Some(preflighted_len) = self.preflight_payload_len else {
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

        let Some(parent) = staged_path.parent() else {
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
        // Stage-time write failure: no rename was ever attempted, so this is
        // distinct from a promote-time rename failure (PromoteFailed).
        self.state = TransactionState::StageFailed;
    }

    /// Re-read the staged payload and verify its sha256 matches
    /// `expected_output_hash`. Mismatches or read failures roll back the
    /// staged file.
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
    /// directory is `<output_path>.parent/.staging`).
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
            | TransactionState::StageFailed
            | TransactionState::PromoteFailed
            | TransactionState::Cancelled => {
                // Already terminal — cancel is a no-op.
                Ok(())
            }
        }
    }
}
