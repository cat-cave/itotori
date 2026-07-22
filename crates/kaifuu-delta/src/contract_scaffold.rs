//! end-to-end encrypted-XP3 contract scaffolding harness.
//! This module wires the **existing** kaifuu encrypted-XP3 contract surface
//! (detect, key resolution, extract, patch, verify, delta-apply) around a
//! fully synthetic, public-redistributable fixture
//! (`fixtures/public/kaifuu-encrypted-xp3-contract-scaffold/`). It exists so
//! the contract surface stays continuously exercised in public CI WITHOUT
//! being the alpha proof itself.
//! It invents **no** engine logic. Every stage delegates to a published
//! kaifuu-core / kaifuu-delta function:
//! | stage | existing contract entry point |
//! | detect | `kaifuu_core::xp3_profile_proof` |
//! | key resolution| `kaifuu_core::LocalKeyResolver::resolve_requirements` |
//! | extract | `kaifuu_core::unpack_plain_xp3_to_directory` |
//! | patch | `kaifuu_core::replace_plain_xp3_entry_payload` + `pack_plain_xp3_from_directory` |
//! | verify | `kaifuu_core::read_plain_xp3_archive` + `encode_xp3` |
//! | delta apply | `crate::create_delta` + `crate::apply_delta` |
//! Contract drift — a missing or changed stage — fails the harness with a
//! structured SEMANTIC diagnostic, never a panic or opaque error. The report
//! declares itself contract scaffolding and never claims retail
//! encrypted-XP3 readiness.

use std::fs;
use std::path::Path;

#[cfg(test)]
use std::path::PathBuf;

use kaifuu_core::{
    InMemoryLocalSecretStore, KaifuuResult, KeyMaterialKind, KeyRequirement, LocalKeyResolver,
    OperationStatus, SecretRef, Xp3CryptProfileStatus, Xp3PatchCapabilityLevel,
    Xp3ProfileClassification, Xp3ProfileProofFixture, Xp3ProfileProofFixtureArchive,
    Xp3ProfileProofFixtureCryptProfile, Xp3ProfileProofFixtureKeyRefRequirement,
    Xp3ProfileProofRequest, encode_xp3, pack_plain_xp3_from_directory, read_plain_xp3_archive,
    replace_plain_xp3_entry_payload, unpack_plain_xp3_to_directory, xp3_profile_proof,
};
use serde::{Deserialize, Serialize};

use crate::{SourceProvenance, apply_delta, create_delta};

/// Schema version of the scaffold report.
pub const CONTRACT_SCAFFOLD_SCHEMA_VERSION: &str = "0.1.0";

/// The canonical not-a-retail-readiness-claim disclaimer. Kept byte-identical
/// to the `DISCLAIMER` constant in
/// `fixtures/generate-kaifuu-encrypted-xp3-contract-scaffold.mjs` so the
/// harness and the fixture never drift on the claim they make.
pub const ENCRYPTED_XP3_CONTRACT_SCAFFOLD_DISCLAIMER: &str = "CONTRACT SCAFFOLDING ONLY: this harness exercises the encrypted-XP3 contract surface against a fully synthetic, public-redistributable fixture. It does NOT decrypt, extract, or patch any retail KiriKiri/XP3 game, and it is NOT a claim of retail encrypted-XP3 readiness.";

/// Semantic code emitted when the harness detects contract drift — a stage
/// whose existing-contract invariant no longer holds (a missing input, a
/// changed classification, or a broken round-trip). It is a structured
/// diagnostic, not a panic.
pub const SEMANTIC_CONTRACT_SCAFFOLD_STAGE_DRIFT: &str = "kaifuu.contract_scaffold.stage_drift";

/// The ordered contract stages the harness asserts are wired. If a future
/// change drops a stage from this list, `stage_count_matches_contract` (a
/// unit test) fails — that is the compile-time half of the drift guard.
pub const CONTRACT_SCAFFOLD_STAGES: &[ContractStage] = &[
    ContractStage::Detect,
    ContractStage::KeyResolution,
    ContractStage::Extract,
    ContractStage::Patch,
    ContractStage::Verify,
    ContractStage::DeltaApply,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContractStage {
    Detect,
    KeyResolution,
    Extract,
    Patch,
    Verify,
    DeltaApply,
}

impl ContractStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Detect => "detect",
            Self::KeyResolution => "key_resolution",
            Self::Extract => "extract",
            Self::Patch => "patch",
            Self::Verify => "verify",
            Self::DeltaApply => "delta_apply",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContractStageStatus {
    Passed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractStageOutcome {
    pub stage: ContractStage,
    pub status: ContractStageStatus,
    /// Stable evidence summary (aggregate only — never raw keys, decrypted
    /// text, or local paths).
    pub detail: String,
    /// Present iff the stage drifted. Always a stable semantic code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_code: Option<String>,
}

impl ContractStageOutcome {
    fn passed(stage: ContractStage, detail: impl Into<String>) -> Self {
        Self {
            stage,
            status: ContractStageStatus::Passed,
            detail: detail.into(),
            semantic_code: None,
        }
    }

    fn failed(stage: ContractStage, drift: StageDrift) -> Self {
        Self {
            stage,
            status: ContractStageStatus::Failed,
            detail: drift.message,
            semantic_code: Some(drift.semantic_code),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedXp3ContractScaffoldReport {
    pub schema_version: String,
    pub fixture_id: String,
    /// The not-a-retail-readiness-claim disclaimer, surfaced in every report.
    pub disclaimer: String,
    /// Always `true`: this harness is never a retail readiness claim.
    pub not_retail_readiness_claim: bool,
    pub status: OperationStatus,
    pub stages: Vec<ContractStageOutcome>,
}

impl EncryptedXp3ContractScaffoldReport {
    pub fn stage(&self, stage: ContractStage) -> Option<&ContractStageOutcome> {
        self.stages.iter().find(|outcome| outcome.stage == stage)
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        Ok(format!("{}\n", serde_json::to_string_pretty(self)?))
    }
}

/// A structured stage-drift diagnostic. Never a panic.
struct StageDrift {
    semantic_code: String,
    message: String,
}

impl StageDrift {
    fn drift(message: impl Into<String>) -> Self {
        Self {
            semantic_code: SEMANTIC_CONTRACT_SCAFFOLD_STAGE_DRIFT.to_string(),
            message: message.into(),
        }
    }

    fn semantic(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            semantic_code: code.into(),
            message: message.into(),
        }
    }
}

type StageResult = Result<String, StageDrift>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScaffoldFixture {
    fixture_id: String,
    not_retail_readiness_claim: bool,
    encrypted_envelope: ScaffoldArchive,
    decrypted_inner: ScaffoldArchive,
    crypt_profile: ScaffoldCryptProfile,
    key_manifest_path: String,
    patch: ScaffoldPatch,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScaffoldArchive {
    path: String,
    archive_id: String,
    expected_classification: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScaffoldCryptProfile {
    crypt_profile_id: String,
    key_ref_requirement: ScaffoldKeyRefRequirement,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScaffoldKeyRefRequirement {
    requirement_id: String,
    secret_ref: String,
    material_kind: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScaffoldPatch {
    entry_path: String,
    replacement_utf8: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublicKeyManifest {
    keys: Vec<PublicKeyEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublicKeyEntry {
    requirement_id: String,
    public_key_material: String,
}

/// Run the full encrypted-XP3 contract scaffolding harness against the
/// synthetic fixture descriptor at `fixture_path`, using `work_dir` (which
/// must not yet exist or must be empty) as scratch space.
/// Returns a structured report. Stage failures are surfaced as semantic
/// diagnostics inside the report; only environmental failures (e.g. the
/// descriptor cannot be read) return `Err`.
pub fn run_encrypted_xp3_contract_scaffold(
    fixture_path: &Path,
    work_dir: &Path,
) -> KaifuuResult<EncryptedXp3ContractScaffoldReport> {
    let fixture_dir = fixture_path
        .parent()
        .ok_or("fixture descriptor path must have a parent directory")?
        .to_path_buf();
    let fixture: ScaffoldFixture = read_json(fixture_path)?;

    // The report hardcodes `not_retail_readiness_claim: true` (it is never a
    // retail readiness claim). Reject a fixture that asserts otherwise rather
    // than emitting a report whose integrity flag would contradict its own
    // hardcoded disclaimer.
    if !fixture.not_retail_readiness_claim {
        return Err("contract scaffold fixture must set notRetailReadinessClaim: true".into());
    }

    fs::create_dir_all(work_dir)?;

    let mut stages = Vec::new();

    // Stage 1 — DETECT.
    let detect = run_stage(ContractStage::Detect, || {
        stage_detect(&fixture, &fixture_dir)
    });
    let detect_passed = matches!(detect.status, ContractStageStatus::Passed);
    stages.push(detect);

    // Stage 2 — KEY RESOLUTION.
    stages.push(run_stage(ContractStage::KeyResolution, || {
        stage_key_resolution(&fixture, &fixture_dir)
    }));

    // Stages 3-6 share the extract working directories. They only run once the
    // inner archive bytes are available; the extract stage owns reading them.
    let inner_path = fixture_dir.join(&fixture.decrypted_inner.path);
    let inner_bytes = match fs::read(&inner_path) {
        Ok(bytes) => Some(bytes),
        Err(error) => {
            stages.push(ContractStageOutcome::failed(
                ContractStage::Extract,
                StageDrift::drift(format!("decrypted inner archive unreadable: {error}")),
            ));
            None
        }
    };

    if let Some(inner_bytes) = inner_bytes {
        let original_dir = work_dir.join("original-extract");
        let patched_dir = work_dir.join("patched-extract");

        // Stage 3 — EXTRACT.
        let extract = run_stage(ContractStage::Extract, || {
            stage_extract(&inner_bytes, &original_dir, &patched_dir)
        });
        let extract_passed = matches!(extract.status, ContractStageStatus::Passed);
        stages.push(extract);

        if extract_passed {
            // Stage 4 — PATCH.
            stages.push(run_stage(ContractStage::Patch, || {
                stage_patch(&fixture, &inner_bytes, &patched_dir)
            }));
            // Stage 5 — VERIFY.
            stages.push(run_stage(ContractStage::Verify, || {
                stage_verify(&fixture, &inner_bytes, &patched_dir)
            }));
            // Stage 6 — DELTA APPLY.
            stages.push(run_stage(ContractStage::DeltaApply, || {
                stage_delta_apply(&original_dir, &patched_dir, work_dir)
            }));
        }
    }

    let _ = detect_passed; // detect failure is already recorded; later stages
    // run independently so a single regression yields a complete drift map.

    // Drift guard: every canonical stage must have produced exactly one
    // outcome. A missing stage is itself contract drift.
    for stage in CONTRACT_SCAFFOLD_STAGES {
        if !stages.iter().any(|outcome| outcome.stage == *stage) {
            stages.push(ContractStageOutcome::failed(
                *stage,
                StageDrift::drift(format!(
                    "contract stage `{}` did not run — pipeline drift",
                    stage.as_str()
                )),
            ));
        }
    }
    stages.sort_by_key(|outcome| stage_order(outcome.stage));

    let status = if stages
        .iter()
        .all(|outcome| matches!(outcome.status, ContractStageStatus::Passed))
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    Ok(EncryptedXp3ContractScaffoldReport {
        schema_version: CONTRACT_SCAFFOLD_SCHEMA_VERSION.to_string(),
        fixture_id: fixture.fixture_id,
        disclaimer: ENCRYPTED_XP3_CONTRACT_SCAFFOLD_DISCLAIMER.to_string(),
        // Always true: validated at load (above); never sourced from the
        // fixture into the report, so the integrity flag cannot drift from
        // the hardcoded disclaimer.
        not_retail_readiness_claim: true,
        status,
        stages,
    })
}

#[path = "contract_scaffold/stages.rs"]
mod stages;
use stages::*;

#[cfg(test)]
#[path = "contract_scaffold/tests.rs"]
mod tests;
