//! private-local XP3 validation gate.
//! This module is the alpha gate that consumes an operator's **already-redacted**
//! private-local XP3 validation manifest and turns it into one aggregate report:
//! no corpus -> deterministic `skipped`; configured private-local rows -> stage
//! aggregates plus proof hashes linked to claimed XP3 support tuples.
//! The gate composes the production runner instead of reimplementing
//! XP3 crypt/extract/patch. A configured row for a claimed support tuple is not
//! allowed to be a label-only assertion: the claimed tuple must also be backed by
//! a passing synthetic production regression run. If the runner fails for a
//! claimed tuple, the report is `failed` and the diagnostic is a compatibility
//! regression. Rows outside the claimed XP3 tuple set are reported as
//! `out-of-profile` semantic diagnostics, not as support regressions.
//! # — readiness BINDS to a verified round-trip (not a label)
//! The gate runs the private-local validation workflow (the profiled
//! extract-patch-verify driver) ONCE and threads the resulting report. A claimed
//! row reaches `Passed` — and lifts the retail posture to `PrivateValidated` —
//! ONLY when its declared `roundTripProofHash` equals the WORKFLOW-BOUND value
//! recomputed from the real round-trip output for that exact tuple (the source +
//! rebuilt encrypted-container hashes, the per-member deltas, and the driver's
//! round-trip proof; see
//! [`canonical_xp3_round_trip_proof_hash_from_workflow`]). This is the
//! pattern: the proof hash is NO LONGER a mintable label (which
//! anyone who knew a kind/id string could forge), so `patch-proven` is
//! unreachable without a genuinely-passing round-trip. A missing/failed workflow,
//! or a tuple the workflow never round-tripped, is a LOUD typed diagnostic (never
//! a silent skip) and the top rungs stay unreached.
//! The manifest and report carry only logical ids, stage states, and
//! [`ProofHash`]es. They never carry raw keys, helper dumps, retail filenames,
//! decrypted text, local paths, screenshots, or assets. The report body is
//! deep-scanned before it is returned; a secret-shaped value is a hard error.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use kaifuu_core::{
    HelperRedactionStatus, KaifuuResult, OperationStatus, PartialDiagnosticSeverity, ProofHash,
    redact_for_log_or_report, sha256_hash_bytes, stable_json, validate_secret_redaction_boundary,
};

use crate::xp3_production::{
    Xp3ProductionError, Xp3ProductionOutcome, Xp3ProductionRegistry, Xp3ProductionReport,
    Xp3ProductionVariantReport, run_xp3_production,
};

/// Schema version of the private-local XP3 validation manifest + report.
pub const XP3_PRIVATE_LOCAL_VALIDATION_SCHEMA_VERSION: &str = "0.1.0";

/// Every typed error's `Display` starts here so an audit can pin the module.
pub const XP3_PRIVATE_LOCAL_VALIDATION_MARKER: &str =
    "kaifuu.kirikiri.xp3_private_local_validation";

/// Canonical no-corpus command string. The real argv is not recorded because it
/// can carry local paths.
pub const XP3_PRIVATE_LOCAL_VALIDATION_NO_CORPUS_COMMAND: &str =
    "kaifuu xp3 private-local-validation --no-corpus";

/// Canonical manifest command string. The real manifest path is not recorded.
pub const XP3_PRIVATE_LOCAL_VALIDATION_MANIFEST_COMMAND: &str =
    "kaifuu xp3 private-local-validation --manifest <private-local-xp3-validation-manifest>";

/// The blunt support boundary carried in every report.
pub const XP3_PRIVATE_LOCAL_VALIDATION_SUPPORT_BOUNDARY: &str = "Kaifuu KiriKiri XP3 private-local validation consumes an operator-authored, already-redacted manifest of owned XP3 validation outcomes and composes it with the KAIFUU-057 claimed-profile production runner. A claimed support tuple must record detect, key/profile resolution, extract, trivial patch, verify, and delta-apply proof hashes/stage outcomes, and the claimed tuple must be backed by a passing synthetic production regression run. Missing private inputs produce a deterministic skipped artifact whose alpha proof posture is not_private_validated. Claimed-tuple failures are compatibility bugs/regressions. Out-of-profile inputs are semantic diagnostics. The report carries only logical ids, counts, states, and sha256 proof hashes; it never carries raw keys, helper dumps, retail filenames, decrypted text, local paths, screenshots, or assets.";

/// Semantic code: the report failed the fail-loud deep scan.
pub const SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_SECRET_LEAK: &str =
    "kaifuu.kirikiri.xp3_private_local_validation.secret_leak";
/// Semantic code: configured private-local inputs are absent.
pub const SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_SKIPPED: &str =
    "kaifuu.kirikiri.xp3_private_local_validation.private_inputs_absent";
/// Semantic code: a claimed tuple's private-local stage failed.
pub const SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_CLAIMED_FAILED: &str =
    "kaifuu.kirikiri.xp3_private_local_validation.claimed_tuple_failed";
/// Semantic code: the production runner failed for a claimed tuple.
pub const SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_REGRESSION_FAILED: &str =
    "kaifuu.kirikiri.xp3_private_local_validation.production_regression_failed";
/// Semantic code: the row names no declared claimed XP3 support tuple.
pub const SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_OUT_OF_PROFILE: &str =
    "kaifuu.kirikiri.xp3_private_local_validation.out_of_profile";
/// Semantic code: the row's declared round-trip proof hash is not the
/// workflow-bound value from a genuinely-run round-trip (a label-only /
/// fabricated / mintable proof, refused).
pub const SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_UNVERIFIED_PROOF: &str =
    "kaifuu.kirikiri.xp3_private_local_validation.unverified_round_trip_proof";
/// Semantic code: the production workflow round-tripped no output for
/// the claimed tuple, so no verified proof can back it (fail-loud, no skip).
pub const SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_WORKFLOW_UNPROVEN: &str =
    "kaifuu.kirikiri.xp3_private_local_validation.workflow_round_trip_unproven";

/// Report/result states required by the private-local validation command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Xp3PrivateLocalValidationState {
    /// No configured private-local input exists.
    Skipped,
    /// The claimed tuple validated and its production regression passed.
    Passed,
    /// A declared claimed tuple failed a stage or the production regression.
    Failed,
    /// The input row is outside the declared XP3 support profile.
    OutOfProfile,
}

/// Alpha proof posture for retail/private validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Xp3RetailValidationPosture {
    /// No private corpus was configured, so alpha proof must not imply retail
    /// validation.
    NotPrivateValidated,
    /// At least one configured claimed private-local row passed.
    PrivateValidated,
    /// A claimed private-local row failed and must block the alpha gate.
    PrivateValidationFailed,
    /// Only out-of-profile rows were configured; claimed support remains
    /// unvalidated.
    OutOfProfileOnly,
}

/// The fixed validation stages the private-local gate aggregates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Xp3PrivateLocalValidationStage {
    /// XP3 classify/detect.
    Detect,
    /// Key/profile resolution.
    KeyProfileResolve,
    /// Extract/decrypt.
    Extract,
    /// Apply one trivial patch.
    TrivialPatch,
    /// Verify the rebuilt output.
    Verify,
    /// Apply/emit delta evidence.
    DeltaApply,
}

impl Xp3PrivateLocalValidationStage {
    /// All stages, in gate order.
    #[must_use]
    pub fn ordered() -> [Self; 6] {
        [
            Self::Detect,
            Self::KeyProfileResolve,
            Self::Extract,
            Self::TrivialPatch,
            Self::Verify,
            Self::DeltaApply,
        ]
    }

    fn as_key(self) -> &'static str {
        match self {
            Self::Detect => "detect",
            Self::KeyProfileResolve => "keyProfileResolve",
            Self::Extract => "extract",
            Self::TrivialPatch => "trivialPatch",
            Self::Verify => "verify",
            Self::DeltaApply => "deltaApply",
        }
    }
}

/// One stage outcome from an operator's already-redacted validation manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Xp3PrivateLocalValidationStageOutcome {
    pub stage: Xp3PrivateLocalValidationStage,
    pub state: Xp3PrivateLocalValidationState,
    pub proof_hash: ProofHash,
}

/// One redacted private-local validation row. This is an assertion about a
/// locally-owned input, not the input itself: only logical ids and hashes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Xp3PrivateLocalValidationManifestEntry {
    pub corpus_id_redacted: String,
    pub claimed_support_tuple_id: String,
    pub profile_id_redacted: String,
    pub result: Xp3PrivateLocalValidationState,
    /// The operator's declared proof that the private-local extract-patch-verify
    /// round-trip succeeded for this tuple. It is HONORED only if it equals the
    /// workflow-bound canonical value recomputed from the genuinely-run
    /// production round-trip for the same tuple (see
    /// [`canonical_xp3_round_trip_proof_hash_from_workflow`]). A label-only /
    /// mintable hash is refused, so `Passed` (and thus `PrivateValidated`) is
    /// unreachable without a verified round-trip.
    pub round_trip_proof_hash: ProofHash,
    pub proof_hashes: Vec<ProofHash>,
    pub stages: Vec<Xp3PrivateLocalValidationStageOutcome>,
}

/// Operator-authored private-local manifest. It is safe to commit only if it
/// stays redacted; this module still treats it as private-local input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Xp3PrivateLocalValidationManifest {
    pub schema_version: String,
    pub validation_id: String,
    #[serde(default)]
    pub entries: Vec<Xp3PrivateLocalValidationManifestEntry>,
}

/// Borrowed request for the validation gate.
#[derive(Debug, Clone, Copy)]
pub struct Xp3PrivateLocalValidationInput<'a> {
    pub validation_id: &'a str,
    pub manifest: Option<&'a Xp3PrivateLocalValidationManifest>,
    pub registry: &'a Xp3ProductionRegistry,
}

/// Per-state counts for a stage or report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PrivateLocalValidationStateCounts {
    pub skipped: u64,
    pub passed: u64,
    pub failed: u64,
    pub out_of_profile: u64,
}

impl Xp3PrivateLocalValidationStateCounts {
    fn increment(&mut self, state: Xp3PrivateLocalValidationState) {
        match state {
            Xp3PrivateLocalValidationState::Skipped => self.skipped += 1,
            Xp3PrivateLocalValidationState::Passed => self.passed += 1,
            Xp3PrivateLocalValidationState::Failed => self.failed += 1,
            Xp3PrivateLocalValidationState::OutOfProfile => self.out_of_profile += 1,
        }
    }
}

/// Stage aggregate bins keyed by the fixed private-local validation stages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PrivateLocalValidationStageBins {
    pub detect: Xp3PrivateLocalValidationStateCounts,
    pub key_profile_resolve: Xp3PrivateLocalValidationStateCounts,
    pub extract: Xp3PrivateLocalValidationStateCounts,
    pub trivial_patch: Xp3PrivateLocalValidationStateCounts,
    pub verify: Xp3PrivateLocalValidationStateCounts,
    pub delta_apply: Xp3PrivateLocalValidationStateCounts,
}

impl Xp3PrivateLocalValidationStageBins {
    fn empty() -> Self {
        Self {
            detect: Xp3PrivateLocalValidationStateCounts::default(),
            key_profile_resolve: Xp3PrivateLocalValidationStateCounts::default(),
            extract: Xp3PrivateLocalValidationStateCounts::default(),
            trivial_patch: Xp3PrivateLocalValidationStateCounts::default(),
            verify: Xp3PrivateLocalValidationStateCounts::default(),
            delta_apply: Xp3PrivateLocalValidationStateCounts::default(),
        }
    }

    fn increment(
        &mut self,
        stage: Xp3PrivateLocalValidationStage,
        state: Xp3PrivateLocalValidationState,
    ) {
        match stage {
            Xp3PrivateLocalValidationStage::Detect => self.detect.increment(state),
            Xp3PrivateLocalValidationStage::KeyProfileResolve => {
                self.key_profile_resolve.increment(state);
            }
            Xp3PrivateLocalValidationStage::Extract => self.extract.increment(state),
            Xp3PrivateLocalValidationStage::TrivialPatch => {
                self.trivial_patch.increment(state);
            }
            Xp3PrivateLocalValidationStage::Verify => self.verify.increment(state),
            Xp3PrivateLocalValidationStage::DeltaApply => self.delta_apply.increment(state),
        }
    }
}

/// One row in the emitted aggregate report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PrivateLocalValidationRow {
    pub corpus_id_redacted: String,
    pub claimed_support_tuple_id: String,
    pub profile_id_redacted: String,
    pub result: Xp3PrivateLocalValidationState,
    pub proof_hashes: Vec<ProofHash>,
    pub stages: Vec<Xp3PrivateLocalValidationStageOutcome>,
}

impl Xp3PrivateLocalValidationRow {
    fn redacted_for_report(&self) -> Self {
        Self {
            corpus_id_redacted: redact_for_log_or_report(&self.corpus_id_redacted),
            claimed_support_tuple_id: redact_for_log_or_report(&self.claimed_support_tuple_id),
            profile_id_redacted: redact_for_log_or_report(&self.profile_id_redacted),
            result: self.result,
            proof_hashes: self.proof_hashes.clone(),
            stages: self.stages.clone(),
        }
    }
}

/// Summary of the claimed-profile regression runner backing this validation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PrivateLocalRegressionSummary {
    pub runner: String,
    pub source_node_id: String,
    pub claimed_support_tuple_ids: Vec<String>,
    pub production_report_hash: Option<ProofHash>,
    pub status: OperationStatus,
    pub diagnostic: Option<String>,
}

impl Xp3PrivateLocalRegressionSummary {
    fn redacted_for_report(&self) -> Self {
        Self {
            runner: self.runner.clone(),
            source_node_id: self.source_node_id.clone(),
            claimed_support_tuple_ids: self
                .claimed_support_tuple_ids
                .iter()
                .map(|id| redact_for_log_or_report(id))
                .collect(),
            production_report_hash: self.production_report_hash.clone(),
            status: self.status.clone(),
            diagnostic: self.diagnostic.as_deref().map(redact_for_log_or_report),
        }
    }
}

/// Alpha proof posture block carried by the report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PrivateLocalAlphaProofs {
    pub retail_validation: Xp3RetailValidationPosture,
}

/// The canonical WORKFLOW-BOUND round-trip proof hash for a claimed support
/// tuple, recomputed from the genuinely-run production round-trip
/// output for the matching variant. Returns `None` if the workflow round-tripped
/// no output for that tuple (then no proof can ever be honored for it — the
/// honest floor holds and readiness cannot reach `patch-proven`).
/// The value is a sha256 over the ACTUAL round-trip output for the variant — the
/// source + rebuilt encrypted-container hashes, every per-member delta (id,
/// operation, source/target plaintext hashes, length delta), and the driver's
/// own round-trip proof hash. Because it depends on the real extract-patch-verify
/// output, it CANNOT be reproduced from a bare label/id string — this is exactly
/// what binds the readiness `patch-proven` rung to a VERIFIED round-trip (the
/// mirror).
#[must_use]
pub fn canonical_xp3_round_trip_proof_hash_from_workflow(
    workflow: &Xp3ProductionReport,
    claimed_support_tuple_id: &str,
) -> Option<ProofHash> {
    let variant = workflow_round_tripped_variant(workflow, claimed_support_tuple_id)?;
    let mut material = Vec::new();
    material.extend_from_slice(b"kaifuu.kirikiri.xp3_private_local_validation.round_trip/");
    material.extend_from_slice(variant.variant_id.as_bytes());
    material.push(0x1f);
    material.extend_from_slice(variant.source_container_hash.as_str().as_bytes());
    material.push(0x1f);
    material.extend_from_slice(variant.rebuilt_container_hash.as_str().as_bytes());
    material.push(0x1f);
    for member in &variant.members {
        material.extend_from_slice(member.member_id.as_bytes());
        material.push(0x1e);
        material.extend_from_slice(member_operation_tag(member.operation).as_bytes());
        material.push(0x1e);
        material.extend_from_slice(member.source_plaintext_hash.as_str().as_bytes());
        material.push(0x1e);
        material.extend_from_slice(member.target_plaintext_hash.as_str().as_bytes());
        material.push(0x1e);
        material.extend_from_slice(member.length_delta.to_le_bytes().as_slice());
        material.push(0x1d);
    }
    material.extend_from_slice(variant.round_trip_proof.proof_hash.as_str().as_bytes());
    proof_hash(&material).ok()
}

/// Deterministic tag for a member operation used in the round-trip proof
/// material. Local (there is no public `as_str`) and stable across runs.
fn member_operation_tag(
    operation: crate::xp3_production::Xp3ProductionMemberOperation,
) -> &'static str {
    match operation {
        crate::xp3_production::Xp3ProductionMemberOperation::Replace => "replace",
        crate::xp3_production::Xp3ProductionMemberOperation::Unchanged => "unchanged",
    }
}

/// The claimed-variant round-trip report for `tuple_id`, if the workflow
/// genuinely round-tripped it (an out-of-scope / not-claimed row yields `None`).
fn workflow_round_tripped_variant<'a>(
    workflow: &'a Xp3ProductionReport,
    tuple_id: &str,
) -> Option<&'a Xp3ProductionVariantReport> {
    workflow.outcomes.iter().find_map(|outcome| match outcome {
        Xp3ProductionOutcome::Claimed(report) if report.variant_id == tuple_id => Some(report),
        _ => None,
    })
}

/// One typed validation diagnostic.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PrivateLocalValidationDiagnostic {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    pub semantic_code: String,
}

impl Xp3PrivateLocalValidationDiagnostic {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: redact_for_log_or_report(&self.semantic_code),
        }
    }
}

/// Redaction posture of the returned report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PrivateLocalValidationRedactionSummary {
    pub deep_scan_performed: bool,
    pub strings_scanned: u64,
    pub secret_leak_findings: u64,
    pub redaction_boundary_ok: bool,
    pub redaction_status: HelperRedactionStatus,
}

/// The redacted private-local XP3 validation report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Xp3PrivateLocalValidationReport {
    pub schema_version: String,
    pub validation_id: String,
    pub source_node_id: String,
    pub command: String,
    pub support_boundary: String,
    pub status: Xp3PrivateLocalValidationState,
    pub reason: Option<String>,
    pub alpha_proofs: Xp3PrivateLocalAlphaProofs,
    pub result_counts: Xp3PrivateLocalValidationStateCounts,
    pub stage_bins: Xp3PrivateLocalValidationStageBins,
    pub configured_private_inputs: u64,
    pub claimed_private_inputs: u64,
    pub out_of_profile_inputs: u64,
    pub proof_hashes: Vec<ProofHash>,
    pub regression: Xp3PrivateLocalRegressionSummary,
    pub rows: Vec<Xp3PrivateLocalValidationRow>,
    pub diagnostics: Vec<Xp3PrivateLocalValidationDiagnostic>,
    pub redaction_summary: Xp3PrivateLocalValidationRedactionSummary,
}

impl Xp3PrivateLocalValidationReport {
    /// True iff at least one claimed private-local row passed and no claimed row
    /// failed.
    #[must_use]
    pub fn is_private_validated(&self) -> bool {
        self.alpha_proofs.retail_validation == Xp3RetailValidationPosture::PrivateValidated
    }

    /// Redacted clone for persistence.
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            validation_id: redact_for_log_or_report(&self.validation_id),
            source_node_id: self.source_node_id.clone(),
            command: self.command.clone(),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status,
            reason: self.reason.as_deref().map(redact_for_log_or_report),
            alpha_proofs: self.alpha_proofs.clone(),
            result_counts: self.result_counts,
            stage_bins: self.stage_bins.clone(),
            configured_private_inputs: self.configured_private_inputs,
            claimed_private_inputs: self.claimed_private_inputs,
            out_of_profile_inputs: self.out_of_profile_inputs,
            proof_hashes: self.proof_hashes.clone(),
            regression: self.regression.redacted_for_report(),
            rows: self
                .rows
                .iter()
                .map(Xp3PrivateLocalValidationRow::redacted_for_report)
                .collect(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(Xp3PrivateLocalValidationDiagnostic::redacted_for_report)
                .collect(),
            redaction_summary: self.redaction_summary.clone(),
        }
    }

    /// Stable, redacted JSON for writing an artifact.
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

/// Run the private-local validation gate.
pub fn run_xp3_private_local_validation(
    input: Xp3PrivateLocalValidationInput<'_>,
) -> KaifuuResult<Xp3PrivateLocalValidationReport> {
    if let Some(manifest) = input.manifest
        && manifest.schema_version != XP3_PRIVATE_LOCAL_VALIDATION_SCHEMA_VERSION
    {
        return Err(format!(
            "{XP3_PRIVATE_LOCAL_VALIDATION_MARKER}: manifest schemaVersion must be {XP3_PRIVATE_LOCAL_VALIDATION_SCHEMA_VERSION}, got {:?}",
            manifest.schema_version
        )
        .into());
    }

    let claimed_tuple_ids = claimed_tuple_ids(input.registry);
    let (regression, workflow) = run_regression(input.registry, &claimed_tuple_ids);
    let entries = input.manifest.map_or(
        &[] as &[Xp3PrivateLocalValidationManifestEntry],
        |manifest| manifest.entries.as_slice(),
    );

    if entries.is_empty() {
        let mut report = base_report(
            input.validation_id,
            XP3_PRIVATE_LOCAL_VALIDATION_NO_CORPUS_COMMAND,
            Xp3PrivateLocalValidationState::Skipped,
            Some(SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_SKIPPED.to_string()),
            Xp3RetailValidationPosture::NotPrivateValidated,
            regression,
        );
        report.redaction_summary = scan_report(&report)?;
        return Ok(report);
    }

    let mut rows = Vec::with_capacity(entries.len());
    let mut diagnostics = Vec::new();
    let mut result_counts = Xp3PrivateLocalValidationStateCounts::default();
    let mut stage_bins = Xp3PrivateLocalValidationStageBins::empty();
    let mut proof_hashes: Vec<ProofHash> = Vec::new();

    for (index, entry) in entries.iter().enumerate() {
        let in_profile = claimed_tuple_ids
            .iter()
            .any(|id| id == &entry.claimed_support_tuple_id);
        let mut stages = normalize_stages(entry)?;
        let stage_failed = stages
            .iter()
            .any(|stage| !matches!(stage.state, Xp3PrivateLocalValidationState::Passed));
        let result = if !in_profile {
            stages.iter_mut().for_each(|stage| {
                stage.state = Xp3PrivateLocalValidationState::OutOfProfile;
            });
            diagnostics.push(Xp3PrivateLocalValidationDiagnostic {
                code: "out_of_profile".to_string(),
                severity: PartialDiagnosticSeverity::P2,
                field: format!("entries[{index}].claimedSupportTupleId"),
                message: format!(
                    "input row names support tuple {} which is outside the declared XP3 claimed profile",
                    entry.claimed_support_tuple_id
                ),
                semantic_code: SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_OUT_OF_PROFILE.to_string(),
            });
            Xp3PrivateLocalValidationState::OutOfProfile
        } else if regression.status == OperationStatus::Failed {
            diagnostics.push(Xp3PrivateLocalValidationDiagnostic {
                code: "production_regression_failed".to_string(),
                severity: PartialDiagnosticSeverity::P0,
                field: "regression".to_string(),
                message: "claimed XP3 support tuple is blocked by the KAIFUU-057 production regression runner".to_string(),
                semantic_code: SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_REGRESSION_FAILED.to_string(),
            });
            Xp3PrivateLocalValidationState::Failed
        } else if entry.result == Xp3PrivateLocalValidationState::Failed || stage_failed {
            diagnostics.push(Xp3PrivateLocalValidationDiagnostic {
                code: "claimed_tuple_failed".to_string(),
                severity: PartialDiagnosticSeverity::P0,
                field: format!("entries[{index}]"),
                message: format!(
                    "claimed XP3 support tuple {} failed private-local validation; this is a compatibility bug/regression",
                    entry.claimed_support_tuple_id
                ),
                semantic_code: SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_CLAIMED_FAILED.to_string(),
            });
            Xp3PrivateLocalValidationState::Failed
        } else {
            // The last, load-bearing gate: `Passed` (and thus PrivateValidated)
            // is reached ONLY when the entry's declared round-trip proof BINDS to
            // the verified round-trip. The honored value is recomputed from the
            // genuinely-run workflow output for this exact tuple
            // (source + rebuilt container hashes + per-member deltas + round-trip
            // proof) — a label-only / mintable hash is refused, and a workflow
            // that produced no round-trip for this tuple fails loud.
            match honor_round_trip_proof(entry, index, workflow.as_ref(), &mut diagnostics) {
                true => Xp3PrivateLocalValidationState::Passed,
                false => Xp3PrivateLocalValidationState::Failed,
            }
        };

        result_counts.increment(result);
        for stage in &stages {
            stage_bins.increment(stage.stage, stage.state);
        }

        proof_hashes.extend(entry.proof_hashes.iter().cloned());
        proof_hashes.extend(stages.iter().map(|stage| stage.proof_hash.clone()));
        // The verified workflow-bound round-trip proof enters the aggregate proof
        // set ONLY when the entry passed (i.e. the proof was honored). A refused
        // label-only proof never contributes a proof hash.
        let mut row_proof_hashes = entry.proof_hashes.clone();
        if result == Xp3PrivateLocalValidationState::Passed {
            proof_hashes.push(entry.round_trip_proof_hash.clone());
            row_proof_hashes.push(entry.round_trip_proof_hash.clone());
        }
        rows.push(Xp3PrivateLocalValidationRow {
            corpus_id_redacted: entry.corpus_id_redacted.clone(),
            claimed_support_tuple_id: entry.claimed_support_tuple_id.clone(),
            profile_id_redacted: entry.profile_id_redacted.clone(),
            result,
            proof_hashes: row_proof_hashes,
            stages,
        });
    }

    proof_hashes.sort();
    proof_hashes.dedup();

    let claimed_private_inputs = result_counts.passed + result_counts.failed;
    let out_of_profile_inputs = result_counts.out_of_profile;
    let status = if result_counts.failed > 0 {
        Xp3PrivateLocalValidationState::Failed
    } else if result_counts.passed > 0 {
        Xp3PrivateLocalValidationState::Passed
    } else {
        Xp3PrivateLocalValidationState::OutOfProfile
    };
    let retail_validation = match status {
        Xp3PrivateLocalValidationState::Passed => Xp3RetailValidationPosture::PrivateValidated,
        Xp3PrivateLocalValidationState::Failed => {
            Xp3RetailValidationPosture::PrivateValidationFailed
        }
        Xp3PrivateLocalValidationState::OutOfProfile => {
            Xp3RetailValidationPosture::OutOfProfileOnly
        }
        Xp3PrivateLocalValidationState::Skipped => Xp3RetailValidationPosture::NotPrivateValidated,
    };

    let mut report = base_report(
        input.validation_id,
        XP3_PRIVATE_LOCAL_VALIDATION_MANIFEST_COMMAND,
        status,
        None,
        retail_validation,
        regression,
    );
    report.result_counts = result_counts;
    report.stage_bins = stage_bins;
    report.configured_private_inputs = entries.len() as u64;
    report.claimed_private_inputs = claimed_private_inputs;
    report.out_of_profile_inputs = out_of_profile_inputs;
    report.proof_hashes = proof_hashes;
    report.rows = rows;
    report.diagnostics = diagnostics;
    report.redaction_summary = scan_report(&report)?;
    Ok(report)
}

fn base_report(
    validation_id: &str,
    command: &str,
    status: Xp3PrivateLocalValidationState,
    reason: Option<String>,
    retail_validation: Xp3RetailValidationPosture,
    regression: Xp3PrivateLocalRegressionSummary,
) -> Xp3PrivateLocalValidationReport {
    Xp3PrivateLocalValidationReport {
        schema_version: XP3_PRIVATE_LOCAL_VALIDATION_SCHEMA_VERSION.to_string(),
        validation_id: validation_id.to_string(),
        source_node_id: "KAIFUU-144".to_string(),
        command: command.to_string(),
        support_boundary: XP3_PRIVATE_LOCAL_VALIDATION_SUPPORT_BOUNDARY.to_string(),
        status,
        reason,
        alpha_proofs: Xp3PrivateLocalAlphaProofs { retail_validation },
        result_counts: Xp3PrivateLocalValidationStateCounts::default(),
        stage_bins: Xp3PrivateLocalValidationStageBins::empty(),
        configured_private_inputs: 0,
        claimed_private_inputs: 0,
        out_of_profile_inputs: 0,
        proof_hashes: Vec::new(),
        regression,
        rows: Vec::new(),
        diagnostics: Vec::new(),
        redaction_summary: Xp3PrivateLocalValidationRedactionSummary {
            deep_scan_performed: false,
            strings_scanned: 0,
            secret_leak_findings: 0,
            redaction_boundary_ok: false,
            redaction_status: HelperRedactionStatus::Redacted,
        },
    }
}

fn claimed_tuple_ids(registry: &Xp3ProductionRegistry) -> Vec<String> {
    let mut ids: Vec<String> = registry
        .variants
        .iter()
        .filter(|variant| variant.claimed)
        .map(|variant| variant.variant_id.clone())
        .collect();
    ids.sort();
    ids
}

/// Run the production extract-patch-verify workflow ONCE and return
/// both the summary and the workflow report (when it ran). The report is the
/// source of truth every claimed entry's round-trip proof binds to: a claimed
/// entry can only reach `Passed` when its declared `roundTripProofHash` equals
/// the workflow-bound value recomputed from THIS report's real round-trip output.
/// If the workflow itself did not pass, `None` is returned and no entry can honor
/// a proof — the top rungs stay unreached (fail-loud, never a silent skip).
fn run_regression(
    registry: &Xp3ProductionRegistry,
    claimed_tuple_ids: &[String],
) -> (
    Xp3PrivateLocalRegressionSummary,
    Option<Xp3ProductionReport>,
) {
    match run_xp3_production(registry, "KAIFUU-144") {
        Ok(report) => {
            let production_report_hash = report
                .stable_json()
                .ok()
                .and_then(|json| proof_hash(json.as_bytes()).ok());
            let round_tripped_ids: Vec<&str> = report
                .outcomes
                .iter()
                .filter_map(|outcome| match outcome {
                    Xp3ProductionOutcome::Claimed(claimed) => Some(claimed.variant_id.as_str()),
                    Xp3ProductionOutcome::NotClaimed(_) => None,
                })
                .collect();
            let status = if claimed_tuple_ids
                .iter()
                .all(|id| round_tripped_ids.contains(&id.as_str()))
                && report.status == OperationStatus::Passed
            {
                OperationStatus::Passed
            } else {
                OperationStatus::Failed
            };
            let summary = Xp3PrivateLocalRegressionSummary {
                runner: "kaifuu.kirikiri.xp3_production".to_string(),
                source_node_id: "KAIFUU-057".to_string(),
                claimed_support_tuple_ids: claimed_tuple_ids.to_vec(),
                production_report_hash,
                status: status.clone(),
                diagnostic: if status == OperationStatus::Passed {
                    None
                } else {
                    Some("production runner did not round-trip every claimed tuple".to_string())
                },
            };
            // The workflow report is threaded for round-trip binding ONLY when it
            // genuinely passed; a failed workflow yields no verifiable proof.
            let workflow = (status == OperationStatus::Passed).then_some(report);
            (summary, workflow)
        }
        Err(error) => (
            Xp3PrivateLocalRegressionSummary {
                runner: "kaifuu.kirikiri.xp3_production".to_string(),
                source_node_id: "KAIFUU-057".to_string(),
                claimed_support_tuple_ids: claimed_tuple_ids.to_vec(),
                production_report_hash: None,
                status: OperationStatus::Failed,
                diagnostic: Some(redact_production_error(&error)),
            },
            None,
        ),
    }
}

/// Honor an in-profile claimed entry's declared round-trip proof. Returns `true`
/// (the entry reaches `Passed`) ONLY when the workflow genuinely round-tripped
/// this tuple AND the entry's declared `roundTripProofHash` equals the
/// workflow-bound canonical value recomputed from that real round-trip output.
/// - A workflow that produced no round-trip for the tuple is a LOUD failure
///   ([`SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_WORKFLOW_UNPROVEN`]); never a silent
///   skip — the tuple cannot reach `patch-proven` without a verified round-trip.
/// - A declared hash that does not match the workflow-bound value is a label-only
///   mintable / fabricated proof and is refused
///   ([`SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_UNVERIFIED_PROOF`]).
fn honor_round_trip_proof(
    entry: &Xp3PrivateLocalValidationManifestEntry,
    index: usize,
    workflow: Option<&Xp3ProductionReport>,
    diagnostics: &mut Vec<Xp3PrivateLocalValidationDiagnostic>,
) -> bool {
    let Some(workflow) = workflow else {
        diagnostics.push(Xp3PrivateLocalValidationDiagnostic {
            code: "workflow_round_trip_unproven".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: "regression".to_string(),
            message: format!(
                "claimed XP3 support tuple {} cannot be patch-proven: the KAIFUU-057 extract-patch-verify workflow did not produce a passing round-trip to bind the proof to",
                entry.claimed_support_tuple_id
            ),
            semantic_code: SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_WORKFLOW_UNPROVEN.to_string(),
        });
        return false;
    };
    let Some(canonical) = canonical_xp3_round_trip_proof_hash_from_workflow(
        workflow,
        &entry.claimed_support_tuple_id,
    ) else {
        diagnostics.push(Xp3PrivateLocalValidationDiagnostic {
            code: "workflow_round_trip_unproven".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: format!("entries[{index}].claimedSupportTupleId"),
            message: format!(
                "the KAIFUU-057 workflow round-tripped no output for claimed tuple {}, so no verified round-trip proof can back it",
                entry.claimed_support_tuple_id
            ),
            semantic_code: SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_WORKFLOW_UNPROVEN.to_string(),
        });
        return false;
    };
    if entry.round_trip_proof_hash != canonical {
        diagnostics.push(Xp3PrivateLocalValidationDiagnostic {
            code: "unverified_round_trip_proof".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: format!("entries[{index}].roundTripProofHash"),
            message: format!(
                "claimed XP3 support tuple {} declared a round-trip proof hash that is NOT the workflow-bound value from the real extract-patch-verify round-trip (label-only / mintable / fabricated proof, refused)",
                entry.claimed_support_tuple_id
            ),
            semantic_code: SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_UNVERIFIED_PROOF.to_string(),
        });
        return false;
    }
    true
}

fn redact_production_error(error: &Xp3ProductionError) -> String {
    redact_for_log_or_report(&error.to_string())
}

fn normalize_stages(
    entry: &Xp3PrivateLocalValidationManifestEntry,
) -> KaifuuResult<Vec<Xp3PrivateLocalValidationStageOutcome>> {
    let mut stages = Vec::with_capacity(Xp3PrivateLocalValidationStage::ordered().len());
    for stage in Xp3PrivateLocalValidationStage::ordered() {
        let Some(outcome) = entry
            .stages
            .iter()
            .find(|candidate| candidate.stage == stage)
        else {
            return Err(format!(
                "{XP3_PRIVATE_LOCAL_VALIDATION_MARKER}: entry {} missing stage {}",
                entry.claimed_support_tuple_id,
                stage.as_key()
            )
            .into());
        };
        if outcome.state == Xp3PrivateLocalValidationState::Skipped {
            return Err(format!(
                "{XP3_PRIVATE_LOCAL_VALIDATION_MARKER}: configured entry {} cannot mark stage {} skipped",
                entry.claimed_support_tuple_id,
                stage.as_key()
            )
            .into());
        }
        stages.push(outcome.clone());
    }
    Ok(stages)
}

fn proof_hash(bytes: &[u8]) -> Result<ProofHash, String> {
    ProofHash::new(sha256_hash_bytes(bytes))
}

struct DeepScanResult {
    strings_scanned: u64,
    finding_count: u64,
    first_field: Option<String>,
}

fn scan_report(
    report: &Xp3PrivateLocalValidationReport,
) -> KaifuuResult<Xp3PrivateLocalValidationRedactionSummary> {
    let value = serde_json::to_value(report).map_err(|error| -> Box<dyn std::error::Error> {
        format!("{XP3_PRIVATE_LOCAL_VALIDATION_MARKER}: report serialization before scan: {error}")
            .into()
    })?;
    let scan = deep_scan_persisted_artifact(&value);
    if scan.finding_count > 0 {
        return Err(format!(
            "{SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_SECRET_LEAK}: refusing to return an XP3 private-local validation report carrying secret-shaped material ({} finding(s), first field: {})",
            scan.finding_count,
            scan.first_field.as_deref().unwrap_or("<unknown>"),
        )
        .into());
    }
    Ok(Xp3PrivateLocalValidationRedactionSummary {
        deep_scan_performed: true,
        strings_scanned: scan.strings_scanned,
        secret_leak_findings: 0,
        redaction_boundary_ok: true,
        redaction_status: HelperRedactionStatus::Redacted,
    })
}

fn deep_scan_persisted_artifact(value: &Value) -> DeepScanResult {
    let mut strings_scanned = 0u64;
    let mut findings: Vec<String> = Vec::new();
    scan_strings(value, "$", &mut strings_scanned, &mut findings);
    for finding in validate_secret_redaction_boundary(value) {
        findings.push(finding.field);
    }
    DeepScanResult {
        strings_scanned,
        finding_count: findings.len() as u64,
        first_field: findings.first().cloned(),
    }
}

fn scan_strings(value: &Value, field: &str, strings_scanned: &mut u64, findings: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            *strings_scanned += 1;
            if is_allowed_policy_string(field, text) {
                return;
            }
            if looks_like_forbidden_private_value(text) {
                findings.push(field.to_string());
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                scan_strings(item, &format!("{field}.{index}"), strings_scanned, findings);
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                if redact_for_log_or_report(key) != *key {
                    findings.push(format!("{field}.<key>"));
                }
                let child_field = if field == "$" {
                    key.clone()
                } else {
                    format!("{field}.{key}")
                };
                scan_strings(child, &child_field, strings_scanned, findings);
            }
        }
        _ => {}
    }
}

fn is_allowed_policy_string(field: &str, text: &str) -> bool {
    matches!(field, "command" | "supportBoundary")
        && matches!(
            text,
            XP3_PRIVATE_LOCAL_VALIDATION_NO_CORPUS_COMMAND
                | XP3_PRIVATE_LOCAL_VALIDATION_MANIFEST_COMMAND
                | XP3_PRIVATE_LOCAL_VALIDATION_SUPPORT_BOUNDARY
        )
}

fn looks_like_forbidden_private_value(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("local-secret:")
        || lower.contains("/home/")
        || lower.contains("/users/")
        || lower.contains("/scratch/")
        || lower.contains("\\users\\")
        || has_windows_drive_prefix(text)
        || lower.contains("helper dump")
        || lower.contains("raw helper")
        || lower.contains("decrypted")
        || lower.contains("retail byte")
        || has_forbidden_image_extension(&lower)
        || has_raw_hex_run(text)
}

fn has_forbidden_image_extension(text: &str) -> bool {
    std::path::Path::new(text)
        .extension()
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("png") || extension.eq_ignore_ascii_case("jpg")
        })
}

fn has_windows_drive_prefix(text: &str) -> bool {
    text.as_bytes()
        .windows(3)
        .any(|window| window[0].is_ascii_alphabetic() && window[1] == b':' && window[2] == b'\\')
}

fn has_raw_hex_run(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut start = 0usize;
    let mut len = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if byte.is_ascii_hexdigit() {
            if len == 0 {
                start = index;
            }
            len += 1;
            if len >= 24 && !is_sha256_hex_run(text, start) {
                return true;
            }
        } else {
            len = 0;
        }
    }
    false
}

fn is_sha256_hex_run(text: &str, start: usize) -> bool {
    text.get(start.saturating_sub(7)..start) == Some("sha256:")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::xp3_production::synthetic;

    fn proof(byte: u8) -> ProofHash {
        ProofHash::new(format!("sha256:{}", format!("{byte:02x}").repeat(32)))
            .expect("synthetic proof hash")
    }

    fn passed_stages() -> Vec<Xp3PrivateLocalValidationStageOutcome> {
        Xp3PrivateLocalValidationStage::ordered()
            .iter()
            .enumerate()
            .map(|(index, stage)| Xp3PrivateLocalValidationStageOutcome {
                stage: *stage,
                state: Xp3PrivateLocalValidationState::Passed,
                proof_hash: proof(0x90 + u8::try_from(index).unwrap()),
            })
            .collect()
    }

    fn manifest(
        entries: Vec<Xp3PrivateLocalValidationManifestEntry>,
    ) -> Xp3PrivateLocalValidationManifest {
        Xp3PrivateLocalValidationManifest {
            schema_version: XP3_PRIVATE_LOCAL_VALIDATION_SCHEMA_VERSION.to_string(),
            validation_id: "kaifuu-k144-xp3-private-local-validation".to_string(),
            entries,
        }
    }

    /// The genuine WORKFLOW-BOUND round-trip proof hash for `tuple_id`, computed
    /// from a real production round-trip over `registry`. An entry
    /// declaring this exact value is honored; anything else is a label-only proof.
    fn workflow_bound_proof(registry: &Xp3ProductionRegistry, tuple_id: &str) -> ProofHash {
        let workflow =
            run_xp3_production(registry, "KAIFUU-144").expect("production workflow runs");
        canonical_xp3_round_trip_proof_hash_from_workflow(&workflow, tuple_id)
            .expect("workflow round-trips the claimed tuple")
    }

    /// A claimed entry whose declared round-trip proof BINDS to the real workflow
    /// round-trip for `tuple_id` (so it is honored and can reach `Passed`).
    fn entry(
        registry: &Xp3ProductionRegistry,
        tuple_id: &str,
    ) -> Xp3PrivateLocalValidationManifestEntry {
        Xp3PrivateLocalValidationManifestEntry {
            corpus_id_redacted: "owned-xp3-corpus-a".to_string(),
            claimed_support_tuple_id: tuple_id.to_string(),
            profile_id_redacted: "owned-xp3-profile-a".to_string(),
            result: Xp3PrivateLocalValidationState::Passed,
            round_trip_proof_hash: workflow_bound_proof(registry, tuple_id),
            proof_hashes: vec![proof(0x80)],
            stages: passed_stages(),
        }
    }

    /// An entry for a tuple OUTSIDE the claimed profile (the workflow never
    /// round-trips it, so its proof is never honored — it is classified
    /// out-of-profile before the round-trip gate). Uses a placeholder hash.
    fn out_of_profile_entry(tuple_id: &str) -> Xp3PrivateLocalValidationManifestEntry {
        Xp3PrivateLocalValidationManifestEntry {
            corpus_id_redacted: "owned-xp3-corpus-a".to_string(),
            claimed_support_tuple_id: tuple_id.to_string(),
            profile_id_redacted: "owned-xp3-profile-a".to_string(),
            result: Xp3PrivateLocalValidationState::Passed,
            round_trip_proof_hash: proof(0x81),
            proof_hashes: vec![proof(0x80)],
            stages: passed_stages(),
        }
    }

    fn run(
        manifest: Option<&Xp3PrivateLocalValidationManifest>,
        registry: &Xp3ProductionRegistry,
    ) -> Xp3PrivateLocalValidationReport {
        run_xp3_private_local_validation(Xp3PrivateLocalValidationInput {
            validation_id: "kaifuu-k144-xp3-private-local-validation",
            manifest,
            registry,
        })
        .expect("validation report")
    }

    #[test]
    fn no_private_inputs_emit_deterministic_skipped_artifact() {
        let registry = synthetic::production_registry();
        let a = run(None, &registry);
        let b = run(None, &registry);

        assert_eq!(a.status, Xp3PrivateLocalValidationState::Skipped);
        assert_eq!(
            a.reason.as_deref(),
            Some(SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_SKIPPED)
        );
        assert_eq!(
            a.alpha_proofs.retail_validation,
            Xp3RetailValidationPosture::NotPrivateValidated
        );
        assert_eq!(a.configured_private_inputs, 0);
        assert_eq!(a.stable_json().unwrap(), b.stable_json().unwrap());
        assert!(a.redaction_summary.deep_scan_performed);
        assert_eq!(a.redaction_summary.secret_leak_findings, 0);
    }

    #[test]
    fn configured_claimed_input_passes_and_records_all_stage_aggregates() {
        let registry = synthetic::production_registry();
        let manifest = manifest(vec![entry(&registry, "kaifuu-k057-xp3-simple-crypt")]);
        let report = run(Some(&manifest), &registry);

        assert_eq!(report.status, Xp3PrivateLocalValidationState::Passed);
        assert!(report.is_private_validated());
        assert_eq!(report.result_counts.passed, 1);
        assert_eq!(report.claimed_private_inputs, 1);
        assert_eq!(report.out_of_profile_inputs, 0);
        assert_eq!(report.stage_bins.detect.passed, 1);
        assert_eq!(report.stage_bins.key_profile_resolve.passed, 1);
        assert_eq!(report.stage_bins.extract.passed, 1);
        assert_eq!(report.stage_bins.trivial_patch.passed, 1);
        assert_eq!(report.stage_bins.verify.passed, 1);
        assert_eq!(report.stage_bins.delta_apply.passed, 1);
        assert_eq!(report.regression.status, OperationStatus::Passed);
        assert!(report.regression.production_report_hash.is_some());
        assert!(
            report
                .proof_hashes
                .iter()
                .any(|hash| hash.as_str() == proof(0x80).as_str())
        );
    }

    #[test]
    fn claimed_stage_failure_is_a_failed_compatibility_regression() {
        let registry = synthetic::production_registry();
        let mut failed = entry(&registry, "kaifuu-k057-xp3-simple-crypt");
        failed.result = Xp3PrivateLocalValidationState::Failed;
        failed.stages[2].state = Xp3PrivateLocalValidationState::Failed;
        let manifest = manifest(vec![failed]);

        let report = run(Some(&manifest), &registry);

        assert_eq!(report.status, Xp3PrivateLocalValidationState::Failed);
        assert_eq!(
            report.alpha_proofs.retail_validation,
            Xp3RetailValidationPosture::PrivateValidationFailed
        );
        assert_eq!(report.result_counts.failed, 1);
        assert_eq!(report.stage_bins.extract.failed, 1);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.semantic_code == SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_CLAIMED_FAILED
                && diagnostic.severity == PartialDiagnosticSeverity::P0
        }));
    }

    #[test]
    fn out_of_profile_input_produces_semantic_diagnostic_not_claimed_failure() {
        let registry = synthetic::production_registry();
        let manifest = manifest(vec![out_of_profile_entry("unknown-retail-xp3-profile")]);

        let report = run(Some(&manifest), &registry);

        assert_eq!(report.status, Xp3PrivateLocalValidationState::OutOfProfile);
        assert_eq!(
            report.alpha_proofs.retail_validation,
            Xp3RetailValidationPosture::OutOfProfileOnly
        );
        assert_eq!(report.result_counts.failed, 0);
        assert_eq!(report.result_counts.out_of_profile, 1);
        assert_eq!(report.stage_bins.detect.out_of_profile, 1);
        assert_eq!(
            report.rows[0].result,
            Xp3PrivateLocalValidationState::OutOfProfile
        );
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.semantic_code == SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_OUT_OF_PROFILE
        }));
    }

    #[test]
    fn production_regression_failure_blocks_claimed_private_validation() {
        // Build the entry against a healthy registry (a genuinely workflow-bound
        // proof), then break the registry so the workflow fails at run time.
        let healthy = synthetic::production_registry();
        let manifest = manifest(vec![entry(&healthy, "kaifuu-k057-xp3-simple-crypt")]);
        let mut registry = synthetic::production_registry();
        registry.variants[0].set_resolved_key_evidence(None);

        let report = run(Some(&manifest), &registry);

        assert_eq!(report.status, Xp3PrivateLocalValidationState::Failed);
        assert_eq!(report.regression.status, OperationStatus::Failed);
        assert!(report.regression.production_report_hash.is_none());
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.semantic_code == SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_REGRESSION_FAILED
        }));
    }

    #[test]
    fn report_rejects_private_paths_helper_dumps_and_raw_material() {
        let registry = synthetic::production_registry();
        let mut leaking = entry(&registry, "kaifuu-k057-xp3-simple-crypt");
        leaking.profile_id_redacted = "/home/operator/private-title/data.xp3".to_string();
        let leaking_manifest = manifest(vec![leaking]);

        let error = run_xp3_private_local_validation(Xp3PrivateLocalValidationInput {
            validation_id: "kaifuu-k144-xp3-private-local-validation",
            manifest: Some(&leaking_manifest),
            registry: &registry,
        })
        .expect_err("private path must fail before a report is returned");
        assert!(
            error
                .to_string()
                .contains(SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_SECRET_LEAK)
        );

        let mut leaking = entry(&registry, "kaifuu-k057-xp3-simple-crypt");
        leaking.profile_id_redacted = "raw helper dump: registers and memory".to_string();
        let leaking_manifest = manifest(vec![leaking]);
        let error = run_xp3_private_local_validation(Xp3PrivateLocalValidationInput {
            validation_id: "kaifuu-k144-xp3-private-local-validation",
            manifest: Some(&leaking_manifest),
            registry: &registry,
        })
        .expect_err("helper dump must fail before a report is returned");
        assert!(
            error
                .to_string()
                .contains(SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_SECRET_LEAK)
        );
    }

    #[test]
    fn configured_entries_must_record_every_validation_stage() {
        let registry = synthetic::production_registry();
        let mut incomplete = entry(&registry, "kaifuu-k057-xp3-simple-crypt");
        incomplete.stages.pop();
        let manifest = manifest(vec![incomplete]);

        let error = run_xp3_private_local_validation(Xp3PrivateLocalValidationInput {
            validation_id: "kaifuu-k144-xp3-private-local-validation",
            manifest: Some(&manifest),
            registry: &registry,
        })
        .expect_err("missing stage must be semantic failure");
        assert!(error.to_string().contains("missing stage deltaApply"));
    }

    // ---: readiness BINDS to a VERIFIED round-trip (not a label). --

    #[test]
    fn passed_row_proof_equals_the_workflow_bound_round_trip_value() {
        // The honored proof is EXACTLY the value recomputed from the real
        // extract-patch-verify round-trip output for this tuple — not
        // a static label. This is what binds `PrivateValidated` to a verified
        // round-trip.
        let registry = synthetic::production_registry();
        let canonical = workflow_bound_proof(&registry, "kaifuu-k057-xp3-simple-crypt");
        let manifest = manifest(vec![entry(&registry, "kaifuu-k057-xp3-simple-crypt")]);
        let report = run(Some(&manifest), &registry);

        assert_eq!(report.status, Xp3PrivateLocalValidationState::Passed);
        assert!(report.is_private_validated());
        // The verified workflow-bound proof entered the aggregate + row proof set.
        assert!(report.proof_hashes.contains(&canonical));
        assert!(report.rows[0].proof_hashes.contains(&canonical));
    }

    #[test]
    fn a_label_only_proof_does_not_reach_private_validated() {
        // THE missing regression: a claimed row whose declared round-trip proof
        // is a mintable label (derived from a kind/id string, exactly the
        // anti-pattern) must NOT reach patch-proven. It is refused by
        // the workflow binding even though every stage/result is authored "passed".
        let registry = synthetic::production_registry();
        let label_hash = ProofHash::new(sha256_hash_bytes(
            b"kaifuu-k144-xp3-readiness/kaifuu-k057-xp3-simple-crypt/label",
        ))
        .unwrap();
        let mut labelled = entry(&registry, "kaifuu-k057-xp3-simple-crypt");
        // Sanity: the label hash is NOT the workflow-bound value.
        assert_ne!(labelled.round_trip_proof_hash, label_hash);
        labelled.round_trip_proof_hash = label_hash;
        let manifest = manifest(vec![labelled]);

        let report = run(Some(&manifest), &registry);

        // The label-only proof is refused → the row FAILS, is NOT private-validated.
        assert_eq!(report.status, Xp3PrivateLocalValidationState::Failed);
        assert!(!report.is_private_validated());
        assert_eq!(
            report.alpha_proofs.retail_validation,
            Xp3RetailValidationPosture::PrivateValidationFailed
        );
        assert_eq!(report.result_counts.passed, 0);
        assert_eq!(report.result_counts.failed, 1);
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.semantic_code == SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_UNVERIFIED_PROOF
                && diagnostic.severity == PartialDiagnosticSeverity::P0
        }));
        // And the refused label proof never entered the proof set.
        let label_hash_again = ProofHash::new(sha256_hash_bytes(
            b"kaifuu-k144-xp3-readiness/kaifuu-k057-xp3-simple-crypt/label",
        ))
        .unwrap();
        assert!(!report.proof_hashes.contains(&label_hash_again));
    }

    #[test]
    fn a_broken_workflow_fails_loud_and_never_reaches_patch_proven() {
        // A claimed row with a genuine (previously workflow-bound) proof, but the
        // workflow itself is broken so it cannot re-derive/verify the round-trip.
        // The row must fail LOUD (typed workflow-unproven diagnostic), never a
        // silent skip, and must not reach patch-proven.
        let healthy = synthetic::production_registry();
        let manifest = manifest(vec![entry(&healthy, "kaifuu-k057-xp3-simple-crypt")]);
        let mut broken = synthetic::production_registry();
        broken.variants[0].set_resolved_key_evidence(None);

        let report = run(Some(&manifest), &broken);

        assert_eq!(report.status, Xp3PrivateLocalValidationState::Failed);
        assert!(!report.is_private_validated());
        assert_eq!(report.result_counts.passed, 0);
        // The broken workflow surfaces the loud production-regression diagnostic
        // (the regression gate fires before the per-row round-trip binding).
        assert!(report.diagnostics.iter().any(|diagnostic| {
            (diagnostic.semantic_code == SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_REGRESSION_FAILED
                || diagnostic.semantic_code
                    == SEMANTIC_XP3_PRIVATE_LOCAL_VALIDATION_WORKFLOW_UNPROVEN)
                && diagnostic.severity == PartialDiagnosticSeverity::P0
        }));
        assert_eq!(report.regression.status, OperationStatus::Failed);
    }

    #[test]
    fn a_tuple_the_workflow_never_round_trips_cannot_be_honored() {
        // Directly exercise the per-row workflow-unproven path: even a passing
        // workflow yields no canonical proof for a tuple it did not round-trip,
        // so honor_round_trip_proof refuses it loud.
        let registry = synthetic::production_registry();
        let workflow =
            run_xp3_production(&registry, "KAIFUU-144").expect("production workflow runs");
        assert!(
            canonical_xp3_round_trip_proof_hash_from_workflow(&workflow, "not-a-real-tuple")
                .is_none()
        );
    }
}
