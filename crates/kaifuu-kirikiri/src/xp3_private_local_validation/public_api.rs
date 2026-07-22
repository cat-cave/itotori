use super::*;

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
pub const XP3_PRIVATE_LOCAL_VALIDATION_SUPPORT_BOUNDARY: &str = "Kaifuu KiriKiri XP3 private-local validation consumes an operator-authored, already-redacted manifest of owned XP3 validation outcomes and composes it with the claimed-profile production runner. A claimed support tuple must record detect, key/profile resolution, extract, trivial patch, verify, and delta-apply proof hashes/stage outcomes, and the claimed tuple must be backed by a passing synthetic production regression run. Missing private inputs produce a deterministic skipped artifact whose alpha proof posture is not_private_validated. Claimed-tuple failures are compatibility bugs/regressions. Out-of-profile inputs are semantic diagnostics. The report carries only logical ids, counts, states, and sha256 proof hashes; it never carries raw keys, helper dumps, retail filenames, decrypted text, local paths, screenshots, or assets.";

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
