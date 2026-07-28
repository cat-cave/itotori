use std::collections::BTreeMap;
use std::error::Error;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::model::{Executor, Inventory, Plan, Receipt, ReceiptProof, ReceiptProofState};
use crate::planner::{ReceiptValidationError, new_receipt, validate_receipt};

/// The local-only corpus facts passed across the plugin boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginCorpus {
    /// Opaque inventory id retained in the content-free receipt.
    pub id: String,
    /// Private local root supplied only to the selected plugin.
    pub root: String,
    /// Content address the plugin must associate with its local input.
    pub content_address: String,
}

/// One generic plugin invocation derived from a selected plan proof.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginRequest {
    /// The selected plan identity.
    pub plan_id: String,
    /// The proof this invocation must account for.
    pub proof_id: String,
    /// The descriptor engine identity.
    pub engine: String,
    /// The descriptor-declared plugin action.
    pub executor: Executor,
    /// Resolved private inputs, never serialized into the plan or receipt.
    pub corpora: Vec<PluginCorpus>,
}

/// Content-free receipt evidence produced by a plugin invocation.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PluginResponse {
    /// The proof receipts the plugin executed for its request.
    pub proofs: Vec<ReceiptProof>,
}

/// The stable contract every installed engine plugin must implement.
pub trait EnginePlugin {
    /// Plugin-specific invocation failure.
    type Error: Error;

    /// Execute the descriptor-selected operation and return content-free evidence.
    fn execute(&mut self, request: &PluginRequest) -> Result<PluginResponse, Self::Error>;
}

/// Failures while executing a compiled plan through the generic plugin contract.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum PluginExecutionError {
    /// The plan selected a corpus missing from the execution inventory.
    #[error(
        "selected corpus `{corpus}` for proof `{proof}` is absent from the execution inventory"
    )]
    CorpusAbsent {
        /// The selected proof.
        proof: String,
        /// The missing corpus id.
        corpus: String,
    },
    /// The plugin returned an invocation error.
    #[error("plugin failed while executing proof `{proof}`: {message}")]
    PluginFailed {
        /// The selected proof.
        proof: String,
        /// The plugin's error text.
        message: String,
    },
    /// A plugin returned no executed receipt entry for its selected proof.
    #[error("plugin returned zero executed receipt entries for selected proof `{0}`")]
    ZeroExecution(String),
    /// A plugin's receipt entry belonged to another proof.
    #[error("plugin receipt proof `{actual}` does not match selected proof `{expected}`")]
    ProofMismatch {
        /// The proof selected by the plan.
        expected: String,
        /// The proof returned by the plugin.
        actual: String,
    },
    /// The generated receipt violated its declared selected plan.
    #[error(transparent)]
    InvalidReceipt(#[from] ReceiptValidationError),
}

/// Execute every selected proof with a generic plugin and validate its receipt.
pub fn execute_plan<P: EnginePlugin>(
    plan: &Plan,
    inventory: &Inventory,
    plugin: &mut P,
    run_id: &str,
) -> Result<Receipt, PluginExecutionError> {
    let corpus_by_id = inventory
        .corpus
        .iter()
        .map(|corpus| (corpus.id.as_str(), corpus))
        .collect::<BTreeMap<_, _>>();
    let mut proofs = Vec::with_capacity(plan.proofs.len());

    for planned in &plan.proofs {
        let corpora = planned
            .corpora
            .iter()
            .map(|corpus_id| {
                let corpus = corpus_by_id.get(corpus_id.as_str()).ok_or_else(|| {
                    PluginExecutionError::CorpusAbsent {
                        proof: planned.id.clone(),
                        corpus: corpus_id.clone(),
                    }
                })?;
                Ok(PluginCorpus {
                    id: corpus.id.clone(),
                    root: corpus.relative_path.clone(),
                    content_address: corpus.content_address.clone(),
                })
            })
            .collect::<Result<Vec<_>, PluginExecutionError>>()?;
        let request = PluginRequest {
            plan_id: plan.id.clone(),
            proof_id: planned.id.clone(),
            engine: planned.engine.clone(),
            executor: planned.executor.clone(),
            corpora,
        };
        let response =
            plugin
                .execute(&request)
                .map_err(|error| PluginExecutionError::PluginFailed {
                    proof: planned.id.clone(),
                    message: error.to_string(),
                })?;
        let entry = match response.proofs.as_slice() {
            [] => return Err(PluginExecutionError::ZeroExecution(planned.id.clone())),
            [entry] if entry.id == planned.id => entry.clone(),
            [entry] => {
                return Err(PluginExecutionError::ProofMismatch {
                    expected: planned.id.clone(),
                    actual: entry.id.clone(),
                });
            }
            _ => {
                return Err(PluginExecutionError::ProofMismatch {
                    expected: planned.id.clone(),
                    actual: "multiple receipt entries".to_owned(),
                });
            }
        };
        proofs.push(entry);
    }

    let receipt = new_receipt(plan, run_id, proofs);
    validate_receipt(plan, &receipt)?;
    Ok(receipt)
}

/// Construct fixture-oriented executed proof evidence for contract plugins.
pub fn executed_proof(id: impl Into<String>, assertions: u32) -> ReceiptProof {
    ReceiptProof {
        id: id.into(),
        state: ReceiptProofState::Executed,
        assertion_count: Some(assertions),
    }
}
