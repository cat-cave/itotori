use std::collections::{BTreeMap, BTreeSet};

use thiserror::Error;

use crate::model::{
    Catalog, Corpus, Inventory, Lane, LaneClass, Plan, PlanProof, PlanRequirement, Proof, Receipt,
    ReceiptCounts, ReceiptDocument, ReceiptProof, ReceiptProofState, RequirementState, Runner,
    RunnerState,
};

const PLAN_SCHEMA: &str = "plan/v1";
const RECEIPT_SCHEMA: &str = "receipt/v1";

/// Failures while compiling declared descriptors into a content-free plan.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum PlanningError {
    /// An engine descriptor id appeared more than once.
    #[error("duplicate engine descriptor `{0}`")]
    DuplicateEngine(String),
    /// A proof id appeared more than once across descriptors.
    #[error("duplicate proof descriptor `{0}`")]
    DuplicateProof(String),
    /// A lane descriptor id appeared more than once.
    #[error("duplicate lane descriptor `{0}`")]
    DuplicateLane(String),
    /// A descriptor referred to a lane that was not supplied to the compiler.
    #[error("proof `{proof}` refers to undeclared lane `{lane}`")]
    UndeclaredProofLane {
        /// The proof with the invalid lane reference.
        proof: String,
        /// The missing lane id.
        lane: String,
    },
    /// A lane selector used syntax outside the small declarative selector contract.
    #[error("lane `{lane}` has invalid selector `{selector}`")]
    InvalidSelector {
        /// The lane with the malformed selector.
        lane: String,
        /// The selector text that could not be compiled.
        selector: String,
    },
    /// A selector was well formed but did not name its own lane.
    #[error("lane `{lane}` selector targets `{target}` instead of itself")]
    SelectorTargetMismatch {
        /// The lane being compiled.
        lane: String,
        /// The lane named in its selector.
        target: String,
    },
    /// A public lane attempted to select an inventory-dependent proof.
    #[error("public lane `{lane}` selects inventory-dependent proof `{proof}`")]
    PublicLaneNeedsInventory {
        /// The public lane.
        lane: String,
        /// The proof that requires corpus inputs.
        proof: String,
    },
    /// A requested lane had no matching declared proof.
    #[error("lane `{0}` selected no proofs")]
    EmptySelection(String),
    /// A selected proof could not obtain its declared corpus inputs.
    #[error(
        "required corpus selection is unsatisfied for proof `{proof}`: need {required}, found {available}"
    )]
    MissingCorpus {
        /// The selected proof with unsatisfied inputs.
        proof: String,
        /// The declared number of corpus inputs.
        required: usize,
        /// The number of matching inventory entries.
        available: usize,
    },
}

/// Failures when comparing a receipt against its exact selected plan.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ReceiptValidationError {
    /// A required receipt artifact was missing.
    #[error("required receipt is missing for plan `{0}`")]
    MissingReceipt(String),
    /// A receipt belongs to a different plan.
    #[error("receipt plan `{receipt}` does not match selected plan `{plan}`")]
    PlanMismatch {
        /// The selected plan id.
        plan: String,
        /// The plan id recorded by the receipt.
        receipt: String,
    },
    /// A selected proof did not appear in the receipt.
    #[error("selected proof `{0}` has no receipt entry")]
    MissingSelectedProof(String),
    /// More than one receipt entry accounted for the same selected proof.
    #[error("selected proof `{0}` has multiple receipt entries")]
    DuplicateSelectedProof(String),
    /// A receipt contained an entry not selected by the plan.
    #[error("receipt proof `{0}` was not selected by the plan")]
    UnexpectedProof(String),
    /// A selected proof was skipped rather than executed.
    #[error("selected proof `{0}` was skipped")]
    SkippedProof(String),
    /// A selected proof did not reach an execution state.
    #[error("selected proof `{0}` was not executed")]
    UnexecutedProof(String),
    /// The designated runner did not accept the selected plan.
    #[error("runner was unavailable for selected plan `{0}")]
    RunnerUnavailable(String),
    /// The runner reported that it executed no job steps.
    #[error("runner recorded zero job steps for selected plan `{0}")]
    RunnerZeroSteps(String),
    /// The receipt aggregate counts did not reflect its proof entries.
    #[error("receipt count `{field}` is {actual}, expected {expected}")]
    CountMismatch {
        /// The count field that differed.
        field: &'static str,
        /// The value supplied by the receipt.
        actual: u32,
        /// The value derived from proof entries.
        expected: u32,
    },
}

/// Compile descriptors and private inventory into one lane-specific plan.
pub fn compile_plan(
    catalogs: &[Catalog],
    lanes: &[Lane],
    inventory: &Inventory,
    lane: &Lane,
    plan_id: &str,
) -> Result<Plan, PlanningError> {
    let catalog_by_engine = compile_catalog(catalogs, lanes)?;
    let target_lane = selector_target(lane)?;
    if target_lane != lane.id {
        return Err(PlanningError::SelectorTargetMismatch {
            lane: lane.id.clone(),
            target: target_lane,
        });
    }

    let selected = catalogs
        .iter()
        .flat_map(|catalog| catalog.proof.iter().map(move |proof| (catalog, proof)))
        .filter(|(_, proof)| proof.lane == lane.id)
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return Err(PlanningError::EmptySelection(lane.id.clone()));
    }

    let mut requirements = Vec::with_capacity(selected.len());
    let mut proofs = Vec::with_capacity(selected.len());
    for (catalog, proof) in selected {
        let matching = matching_corpora(inventory, catalog, proof);
        let required = usize::try_from(proof.requires.corpus_count)
            .expect("u32 count always fits usize on supported targets");
        if matching.len() < required {
            return Err(PlanningError::MissingCorpus {
                proof: proof.id.clone(),
                required,
                available: matching.len(),
            });
        }
        let corpora = matching
            .into_iter()
            .take(required)
            .map(|corpus| corpus.id.clone())
            .collect();
        requirements.push(PlanRequirement {
            id: format!("requirement-{}-inputs", proof.id),
            state: RequirementState::Satisfied,
            diagnostic: None,
        });
        proofs.push(PlanProof {
            id: proof.id.clone(),
            engine: catalog.id.clone(),
            corpora,
            executor: proof.executor.clone(),
        });
    }

    debug_assert_eq!(catalog_by_engine.len(), catalogs.len());
    Ok(Plan {
        schema: PLAN_SCHEMA.to_owned(),
        id: plan_id.to_owned(),
        lane: lane.id.clone(),
        requirements,
        proofs,
    })
}

/// Validate catalog identity, lane closure, selectors, and public-lane inputs.
pub fn compile_catalog<'a>(
    catalogs: &'a [Catalog],
    lanes: &[Lane],
) -> Result<BTreeMap<&'a str, &'a Catalog>, PlanningError> {
    let mut lane_by_id = BTreeMap::new();
    for lane in lanes {
        if lane_by_id.insert(lane.id.as_str(), lane).is_some() {
            return Err(PlanningError::DuplicateLane(lane.id.clone()));
        }
    }
    let mut catalog_by_engine = BTreeMap::new();
    let mut proof_ids = BTreeSet::new();

    for catalog in catalogs {
        if catalog_by_engine
            .insert(catalog.id.as_str(), catalog)
            .is_some()
        {
            return Err(PlanningError::DuplicateEngine(catalog.id.clone()));
        }
        for proof in &catalog.proof {
            if !proof_ids.insert(proof.id.as_str()) {
                return Err(PlanningError::DuplicateProof(proof.id.clone()));
            }
            let Some(proof_lane) = lane_by_id.get(proof.lane.as_str()) else {
                return Err(PlanningError::UndeclaredProofLane {
                    proof: proof.id.clone(),
                    lane: proof.lane.clone(),
                });
            };
            let target = selector_target(proof_lane)?;
            if target != proof_lane.id {
                return Err(PlanningError::SelectorTargetMismatch {
                    lane: proof_lane.id.clone(),
                    target,
                });
            }
            if proof_lane.class == LaneClass::Public && proof.requires.corpus_count > 0 {
                return Err(PlanningError::PublicLaneNeedsInventory {
                    lane: proof_lane.id.clone(),
                    proof: proof.id.clone(),
                });
            }
        }
    }
    Ok(catalog_by_engine)
}

/// Reject a missing document before comparing its selected proof set.
pub fn validate_receipt_document(
    plan: &Plan,
    document: ReceiptDocument,
) -> Result<(), ReceiptValidationError> {
    match document {
        ReceiptDocument::Missing => Err(ReceiptValidationError::MissingReceipt(plan.id.clone())),
        ReceiptDocument::Present(receipt) => validate_receipt(plan, &receipt),
    }
}

/// Verify that every selected proof has exactly one executed receipt entry.
pub fn validate_receipt(plan: &Plan, receipt: &Receipt) -> Result<(), ReceiptValidationError> {
    if receipt.plan_id != plan.id {
        return Err(ReceiptValidationError::PlanMismatch {
            plan: plan.id.clone(),
            receipt: receipt.plan_id.clone(),
        });
    }
    let selected = plan
        .proofs
        .iter()
        .map(|proof| proof.id.as_str())
        .collect::<BTreeSet<_>>();
    if receipt.runner.state == RunnerState::Unavailable {
        return Err(ReceiptValidationError::RunnerUnavailable(plan.id.clone()));
    }
    if receipt.runner.job_steps == Some(0) {
        return Err(ReceiptValidationError::RunnerZeroSteps(plan.id.clone()));
    }
    let receipt_ids = receipt
        .proofs
        .iter()
        .map(|proof| proof.id.as_str())
        .collect::<Vec<_>>();
    if let Some(duplicate) = receipt_ids.iter().find(|id| {
        receipt_ids
            .iter()
            .filter(|candidate| *candidate == *id)
            .count()
            > 1
    }) {
        return Err(ReceiptValidationError::DuplicateSelectedProof(
            (**duplicate).to_owned(),
        ));
    }
    let entries = receipt
        .proofs
        .iter()
        .map(|proof| (proof.id.as_str(), proof))
        .collect::<BTreeMap<_, _>>();

    for proof in &selected {
        let Some(entry) = entries.get(proof) else {
            return Err(ReceiptValidationError::MissingSelectedProof(
                (*proof).to_owned(),
            ));
        };
        match entry.state {
            ReceiptProofState::Skipped => {
                return Err(ReceiptValidationError::SkippedProof((*proof).to_owned()));
            }
            ReceiptProofState::Executed | ReceiptProofState::Passed | ReceiptProofState::Failed => {
            }
            ReceiptProofState::Selected
            | ReceiptProofState::Started
            | ReceiptProofState::Unavailable => {
                return Err(ReceiptValidationError::UnexecutedProof((*proof).to_owned()));
            }
        }
    }
    for proof in entries.keys() {
        if !selected.contains(proof) {
            return Err(ReceiptValidationError::UnexpectedProof((*proof).to_owned()));
        }
    }
    validate_counts(plan, receipt)
}

fn matching_corpora<'a>(
    inventory: &'a Inventory,
    catalog: &Catalog,
    proof: &Proof,
) -> Vec<&'a Corpus> {
    inventory
        .corpus
        .iter()
        .filter(|corpus| {
            corpus.engine == catalog.id
                && proof
                    .requires
                    .tags
                    .iter()
                    .all(|tag| corpus.tags.iter().any(|available| available == tag))
        })
        .collect()
}

fn selector_target(lane: &Lane) -> Result<String, PlanningError> {
    let Some((left, right)) = lane.selector.split_once("==") else {
        return Err(invalid_selector(lane));
    };
    let right = right.trim();
    let Some(target) = right
        .strip_prefix('\'')
        .and_then(|value| value.strip_suffix('\''))
    else {
        return Err(invalid_selector(lane));
    };
    if left.trim() != "proof.lane" || target.is_empty() {
        return Err(invalid_selector(lane));
    }
    Ok(target.to_owned())
}

fn invalid_selector(lane: &Lane) -> PlanningError {
    PlanningError::InvalidSelector {
        lane: lane.id.clone(),
        selector: lane.selector.clone(),
    }
}

fn validate_counts(plan: &Plan, receipt: &Receipt) -> Result<(), ReceiptValidationError> {
    let expected = ReceiptCounts {
        planned: u32::try_from(plan.proofs.len()).expect("proof count fits u32"),
        selected: u32::try_from(plan.proofs.len()).expect("proof count fits u32"),
        started: u32::try_from(receipt.proofs.len()).expect("proof count fits u32"),
        executed: count_states(
            receipt,
            &[
                ReceiptProofState::Executed,
                ReceiptProofState::Passed,
                ReceiptProofState::Failed,
            ],
        ),
        passed: count_states(receipt, &[ReceiptProofState::Passed]),
        failed: count_states(receipt, &[ReceiptProofState::Failed]),
        skipped: count_states(receipt, &[ReceiptProofState::Skipped]),
        unavailable: count_states(receipt, &[ReceiptProofState::Unavailable]),
    };
    for (field, actual, expected) in [
        ("planned", receipt.counts.planned, expected.planned),
        ("selected", receipt.counts.selected, expected.selected),
        ("started", receipt.counts.started, expected.started),
        ("executed", receipt.counts.executed, expected.executed),
        ("passed", receipt.counts.passed, expected.passed),
        ("failed", receipt.counts.failed, expected.failed),
        ("skipped", receipt.counts.skipped, expected.skipped),
        (
            "unavailable",
            receipt.counts.unavailable,
            expected.unavailable,
        ),
    ] {
        if actual != expected {
            return Err(ReceiptValidationError::CountMismatch {
                field,
                actual,
                expected,
            });
        }
    }
    Ok(())
}

fn count_states(receipt: &Receipt, states: &[ReceiptProofState]) -> u32 {
    receipt
        .proofs
        .iter()
        .filter(|proof| states.contains(&proof.state))
        .count()
        .try_into()
        .expect("proof count fits u32")
}

/// Construct the receipt shell shared by generic plugin executors.
pub(crate) fn new_receipt(plan: &Plan, run_id: &str, proofs: Vec<ReceiptProof>) -> Receipt {
    let started = u32::try_from(proofs.len()).expect("proof count fits u32");
    let receipt = Receipt {
        schema: RECEIPT_SCHEMA.to_owned(),
        plan_id: plan.id.clone(),
        run_id: run_id.to_owned(),
        runner: Runner {
            state: RunnerState::Available,
            job_steps: Some(started),
        },
        counts: ReceiptCounts {
            planned: u32::try_from(plan.proofs.len()).expect("proof count fits u32"),
            selected: u32::try_from(plan.proofs.len()).expect("proof count fits u32"),
            started,
            executed: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            unavailable: 0,
        },
        proofs,
        diagnostics: Vec::new(),
    };
    Receipt {
        counts: ReceiptCounts {
            planned: receipt.counts.planned,
            selected: receipt.counts.selected,
            started: receipt.counts.started,
            executed: count_states(
                &receipt,
                &[
                    ReceiptProofState::Executed,
                    ReceiptProofState::Passed,
                    ReceiptProofState::Failed,
                ],
            ),
            passed: count_states(&receipt, &[ReceiptProofState::Passed]),
            failed: count_states(&receipt, &[ReceiptProofState::Failed]),
            skipped: count_states(&receipt, &[ReceiptProofState::Skipped]),
            unavailable: count_states(&receipt, &[ReceiptProofState::Unavailable]),
        },
        ..receipt
    }
}
