//! Versioned, inactive schemas for the future catalog and proof receipts.
//!
//! This crate deliberately has no caller in the current command path. It
//! establishes the file contracts only; planning, execution, and validation
//! belong to a later migration step.

mod model;
mod parse;

pub use model::{
    CapabilityClaim, Catalog, Check, Corpus, Executor, FailurePolicy, InputRequirement, Inventory,
    Lane, LaneClass, Plan, PlanProof, PlanRequirement, Proof, ProofReceiptRequirement, Receipt,
    ReceiptCounts, ReceiptDiagnostic, ReceiptDiagnosticCode, ReceiptDocument, ReceiptPolicy,
    ReceiptProof, ReceiptProofState, RequirementState, Runner, RunnerState,
};
pub use parse::{
    ContractParseError, parse_catalog, parse_inventory, parse_lane, parse_plan, parse_receipt,
};
