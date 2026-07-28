use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// A committed engine descriptor from the catalog.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Catalog {
    pub schema: String,
    pub id: String,
    pub plugin: String,
    pub capabilities: BTreeMap<String, CapabilityClaim>,
    #[serde(default)]
    pub proof: Vec<Proof>,
    #[serde(default)]
    pub check: Vec<Check>,
}

/// The declared state of one capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityClaim {
    Supported,
    Partial,
    NotClaimed,
}

/// One strict or private proof declaration.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Proof {
    pub id: String,
    pub lane: String,
    pub covers: Vec<String>,
    pub requires: InputRequirement,
    pub executor: Executor,
    pub receipt: ProofReceiptRequirement,
}

/// One public check declaration.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Check {
    pub id: String,
    pub lane: String,
    pub covers: Vec<String>,
    pub executor: Executor,
}

/// Required input properties for a proof.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InputRequirement {
    pub corpus_count: u32,
    pub tags: Vec<String>,
}

/// A plugin invocation selected from a descriptor.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Executor {
    pub kind: String,
    pub command: String,
    pub selector: String,
}

/// The declared minimum receipt evidence for one proof.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProofReceiptRequirement {
    pub outcome: String,
    pub minimum_executed: u32,
}

/// Private machine inventory, kept outside the committed catalog.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Inventory {
    pub schema: String,
    pub corpus: Vec<Corpus>,
}

/// One locally available corpus, addressed by opaque fields.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Corpus {
    pub id: String,
    pub engine: String,
    pub variant: String,
    /// User-selected library location relative to the operator-owned media mount.
    pub relative_path: String,
    pub content_address: String,
    pub tags: Vec<String>,
    pub access: String,
}

/// Declarative selection and failure policy for a lane.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Lane {
    pub schema: String,
    pub id: String,
    pub class: LaneClass,
    pub selector: String,
    pub requirements: Vec<String>,
    pub empty_plan: FailurePolicy,
    pub missing_requirement: FailurePolicy,
    pub unexecuted_selection: FailurePolicy,
    pub receipt: ReceiptPolicy,
}

/// Where a lane is intended to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LaneClass {
    Public,
    Periodic,
    Private,
}

/// A lane condition that must fail rather than silently pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailurePolicy {
    Fail,
}

/// Whether a lane requires a receipt artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReceiptPolicy {
    Required,
}

/// Content-free plan written before execution.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub schema: String,
    pub id: String,
    pub lane: String,
    pub requirements: Vec<PlanRequirement>,
    pub proofs: Vec<PlanProof>,
}

/// A checked prerequisite recorded in a plan.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PlanRequirement {
    pub id: String,
    pub state: RequirementState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

/// Whether a plan requirement was satisfied by its input inventory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequirementState {
    Satisfied,
    Absent,
}

/// One proof selected into a plan.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PlanProof {
    pub id: String,
    pub engine: String,
    pub corpora: Vec<String>,
    pub executor: Executor,
}

/// A receipt document written by a runner or its availability watchdog.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub schema: String,
    pub plan_id: String,
    pub run_id: String,
    pub runner: Runner,
    pub counts: ReceiptCounts,
    pub proofs: Vec<ReceiptProof>,
    #[serde(default)]
    pub diagnostics: Vec<ReceiptDiagnostic>,
}

/// The distinct result of attempting to obtain a receipt artifact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiptDocument {
    Missing,
    Present(Receipt),
}

/// Runner availability and its observed job-step count.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Runner {
    pub state: RunnerState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_steps: Option<u32>,
}

/// Whether the designated runner accepted the job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RunnerState {
    Available,
    Unavailable,
}

/// Aggregate proof lifecycle counts, retained for compact reporting.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptCounts {
    pub planned: u32,
    pub selected: u32,
    pub started: u32,
    pub executed: u32,
    pub passed: u32,
    pub failed: u32,
    pub skipped: u32,
    pub unavailable: u32,
}

/// Receipt evidence for one selected proof.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptProof {
    pub id: String,
    pub state: ReceiptProofState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assertion_count: Option<u32>,
}

/// The lifecycle state reached by a selected proof.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReceiptProofState {
    Selected,
    Started,
    Executed,
    Passed,
    Failed,
    Skipped,
    Unavailable,
}

/// A machine-readable diagnostic code retained with a receipt.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptDiagnostic {
    pub code: ReceiptDiagnosticCode,
    pub subject: String,
}

/// Contract-level failure reasons that must not collapse into a pass/fail bit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReceiptDiagnosticCode {
    SelectedProofUnexecuted,
    ExecutedProofProducedNoAssertions,
    RequiredInputAbsent,
    RunnerUnavailable,
    RunnerZeroStepJob,
}
