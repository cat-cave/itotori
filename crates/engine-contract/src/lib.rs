//! Versioned, inactive schemas and planner contracts for future engine plugins.
//!
//! This crate deliberately has no caller in the current command path. Its
//! compiler, receipt validator, and generic plugin seam remain fixture-only
//! preparation for the later atomic migration.

mod model;
mod parse;
mod planner;
mod plugin;

pub use model::{
    CapabilityClaim, Catalog, Check, Corpus, Executor, FailurePolicy, InputRequirement, Inventory,
    Lane, LaneClass, Plan, PlanProof, PlanRequirement, Proof, ProofReceiptRequirement, Receipt,
    ReceiptCounts, ReceiptDiagnostic, ReceiptDiagnosticCode, ReceiptDocument, ReceiptPolicy,
    ReceiptProof, ReceiptProofState, RequirementState, Runner, RunnerState,
};
pub use parse::{
    ContractParseError, parse_catalog, parse_inventory, parse_lane, parse_plan, parse_receipt,
};
pub use planner::{
    PlanningError, ReceiptValidationError, compile_catalog, compile_plan, validate_receipt,
    validate_receipt_document,
};
pub use plugin::{
    EnginePlugin, PluginCorpus, PluginExecutionError, PluginRequest, PluginResponse, execute_plan,
    executed_proof,
};
