//! KAIFUU-171 — end-to-end encrypted-XP3 contract scaffolding harness.
//!
//! This module wires the **existing** kaifuu encrypted-XP3 contract surface
//! (detect, key resolution, extract, patch, verify, delta-apply) around a
//! fully synthetic, public-redistributable fixture
//! (`fixtures/public/kaifuu-encrypted-xp3-contract-scaffold/`). It exists so
//! the contract surface stays continuously exercised in public CI WITHOUT
//! being the alpha proof itself.
//!
//! It invents **no** engine logic. Every stage delegates to a published
//! kaifuu-core / kaifuu-delta function:
//!
//! | stage         | existing contract entry point                                   |
//! | ------------- | --------------------------------------------------------------- |
//! | detect        | `kaifuu_core::xp3_profile_proof`                                |
//! | key resolution| `kaifuu_core::LocalKeyResolver::resolve_requirements`           |
//! | extract       | `kaifuu_core::unpack_plain_xp3_to_directory`                    |
//! | patch         | `kaifuu_core::replace_plain_xp3_entry_payload` + `pack_plain_xp3_from_directory` |
//! | verify        | `kaifuu_core::read_plain_xp3_archive` + `encode_xp3`           |
//! | delta apply   | `crate::create_delta` + `crate::apply_delta`                   |
//!
//! Contract drift — a missing or changed stage — fails the harness with a
//! structured SEMANTIC diagnostic, never a panic or opaque error. The report
//! declares itself contract scaffolding and never claims retail
//! encrypted-XP3 readiness.

use std::fs;
use std::path::Path;

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

// --- Fixture descriptor ------------------------------------------------------

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

// --- Harness entry point -----------------------------------------------------

/// Run the full encrypted-XP3 contract scaffolding harness against the
/// synthetic fixture descriptor at `fixture_path`, using `work_dir` (which
/// must not yet exist or must be empty) as scratch space.
///
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
        not_retail_readiness_claim: fixture.not_retail_readiness_claim,
        status,
        stages,
    })
}

fn stage_order(stage: ContractStage) -> usize {
    CONTRACT_SCAFFOLD_STAGES
        .iter()
        .position(|candidate| *candidate == stage)
        .unwrap_or(usize::MAX)
}

fn run_stage(stage: ContractStage, body: impl FnOnce() -> StageResult) -> ContractStageOutcome {
    match body() {
        Ok(detail) => ContractStageOutcome::passed(stage, detail),
        Err(drift) => ContractStageOutcome::failed(stage, drift),
    }
}

// --- Stage 1: DETECT ---------------------------------------------------------

fn stage_detect(fixture: &ScaffoldFixture, fixture_dir: &Path) -> StageResult {
    // Encrypted envelope: routes to the encrypted variant with a satisfied
    // crypt profile, and the detector flags the unsupported encrypted variant.
    let encrypted_fixture = Xp3ProfileProofFixture {
        schema_version: "0.1.0".to_string(),
        fixture_id: format!("{}-encrypted-detect", fixture.fixture_id),
        profile_id: "019ed000-0000-7000-8000-000000171001".to_string(),
        archive: Xp3ProfileProofFixtureArchive {
            archive_id: fixture.encrypted_envelope.archive_id.clone(),
            path: fixture.encrypted_envelope.path.clone(),
        },
        expected_classification: Xp3ProfileClassification::Encrypted,
        patch_capability_level: Xp3PatchCapabilityLevel::Unsupported,
        crypt_profile: Some(Xp3ProfileProofFixtureCryptProfile {
            crypt_profile_id: fixture.crypt_profile.crypt_profile_id.clone(),
            key_ref_requirement: Some(Xp3ProfileProofFixtureKeyRefRequirement {
                requirement_id: fixture
                    .crypt_profile
                    .key_ref_requirement
                    .requirement_id
                    .clone(),
                secret_ref: parse_secret_ref(
                    &fixture.crypt_profile.key_ref_requirement.secret_ref,
                )?,
            }),
        }),
    };
    let encrypted_report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &encrypted_fixture,
        fixture_dir,
    })
    .map_err(|error| StageDrift::drift(format!("encrypted detect proof errored: {error}")))?;

    if encrypted_report.classification != Xp3ProfileClassification::Encrypted {
        return Err(StageDrift::drift(format!(
            "encrypted envelope classified as {} (expected encrypted)",
            encrypted_report.classification.as_str()
        )));
    }
    // The descriptor's declared classification must match what the detector
    // actually routes — a mismatch is fixture/contract drift.
    if encrypted_report.classification.as_str()
        != fixture.encrypted_envelope.expected_classification
    {
        return Err(StageDrift::drift(format!(
            "encrypted envelope detector routed {} but the fixture declares {}",
            encrypted_report.classification.as_str(),
            fixture.encrypted_envelope.expected_classification
        )));
    }
    if encrypted_report.crypt_profile.status != Xp3CryptProfileStatus::Satisfied {
        return Err(StageDrift::drift(format!(
            "encrypted envelope crypt profile status is {} (expected satisfied)",
            encrypted_report.crypt_profile.status.as_str()
        )));
    }
    let flags_encrypted = encrypted_report.diagnostics.iter().any(|diagnostic| {
        diagnostic.semantic_code.as_deref()
            == Some(kaifuu_core::SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED)
    });
    if !flags_encrypted {
        return Err(StageDrift::drift(
            "detector no longer flags the encrypted variant as unsupported",
        ));
    }

    // Decrypted inner: a real plain XP3 the later stages can patch back.
    let plain_fixture = Xp3ProfileProofFixture {
        schema_version: "0.1.0".to_string(),
        fixture_id: format!("{}-plain-detect", fixture.fixture_id),
        profile_id: "019ed000-0000-7000-8000-000000171002".to_string(),
        archive: Xp3ProfileProofFixtureArchive {
            archive_id: fixture.decrypted_inner.archive_id.clone(),
            path: fixture.decrypted_inner.path.clone(),
        },
        expected_classification: Xp3ProfileClassification::Plain,
        patch_capability_level: Xp3PatchCapabilityLevel::PatchBack,
        crypt_profile: None,
    };
    let plain_report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &plain_fixture,
        fixture_dir,
    })
    .map_err(|error| StageDrift::drift(format!("plain detect proof errored: {error}")))?;
    if plain_report.classification != Xp3ProfileClassification::Plain {
        return Err(StageDrift::drift(format!(
            "decrypted inner classified as {} (expected plain)",
            plain_report.classification.as_str()
        )));
    }
    if plain_report.patch_capability_level != Xp3PatchCapabilityLevel::PatchBack {
        return Err(StageDrift::drift(format!(
            "decrypted inner patch capability is {} (expected patch_back)",
            plain_report.patch_capability_level.as_str()
        )));
    }
    if plain_report.classification.as_str() != fixture.decrypted_inner.expected_classification {
        return Err(StageDrift::drift(format!(
            "decrypted inner detector routed {} but the fixture declares {}",
            plain_report.classification.as_str(),
            fixture.decrypted_inner.expected_classification
        )));
    }

    Ok(format!(
        "envelope=encrypted(crypt_profile=satisfied); inner=plain(patch_back); archive_hash={}",
        plain_report.archive.archive_hash.as_str()
    ))
}

// --- Stage 2: KEY RESOLUTION -------------------------------------------------

fn stage_key_resolution(fixture: &ScaffoldFixture, fixture_dir: &Path) -> StageResult {
    let requirement_id = fixture
        .crypt_profile
        .key_ref_requirement
        .requirement_id
        .clone();
    let secret_ref = parse_secret_ref(&fixture.crypt_profile.key_ref_requirement.secret_ref)?;
    let kind = parse_material_kind(&fixture.crypt_profile.key_ref_requirement.material_kind)?;

    // Resolve the fixture-only key from the committed public key manifest.
    let manifest: PublicKeyManifest = read_json(&fixture_dir.join(&fixture.key_manifest_path))
        .map_err(|error| StageDrift::drift(format!("public key manifest unreadable: {error}")))?;
    let key = manifest
        .keys
        .iter()
        .find(|entry| entry.requirement_id == requirement_id)
        .ok_or_else(|| {
            StageDrift::drift(format!(
                "key manifest declares no key for requirement `{requirement_id}`"
            ))
        })?;

    // Seed a fixture-CI secret store and resolve through the published local
    // key resolver — the same contract the rpg-maker / siglus key lanes use.
    let store = InMemoryLocalSecretStore::new().with_secret(
        secret_ref.name(),
        key.public_key_material.as_bytes().to_vec(),
    );
    let resolver = LocalKeyResolver::new(store);
    let requirement = KeyRequirement {
        requirement_id: requirement_id.clone(),
        secret_ref,
        kind,
        bytes: None,
        validation: None,
    };
    let resolved = resolver
        .resolve_requirements(std::slice::from_ref(&requirement), None)
        .map_err(|error| {
            StageDrift::semantic(
                kaifuu_core::SEMANTIC_MISSING_KEY_MATERIAL,
                format!("key resolution failed: {error}"),
            )
        })?;
    let byte_len = resolved
        .get_bytes(&requirement_id)
        .ok_or_else(|| {
            StageDrift::semantic(
                kaifuu_core::SEMANTIC_MISSING_KEY_MATERIAL,
                format!("resolver returned no material for `{requirement_id}`"),
            )
        })?
        .len();
    if byte_len == 0 {
        return Err(StageDrift::semantic(
            kaifuu_core::SEMANTIC_MISSING_KEY_MATERIAL,
            "resolved key material is empty",
        ));
    }

    Ok(format!(
        "resolved requirement `{requirement_id}` (fixture-only key, byte_len={byte_len})"
    ))
}

// --- Stage 3: EXTRACT --------------------------------------------------------

fn stage_extract(inner_bytes: &[u8], original_dir: &Path, patched_dir: &Path) -> StageResult {
    // Unpack twice: an immutable original baseline and a working copy the
    // patch stage mutates. Both go through the published unpacker.
    let original = unpack_plain_xp3_to_directory(inner_bytes, original_dir)
        .map_err(writer_drift("extract (original)"))?;
    let working = unpack_plain_xp3_to_directory(inner_bytes, patched_dir)
        .map_err(writer_drift("extract (working copy)"))?;
    if original.entries.is_empty() {
        return Err(StageDrift::drift("extract produced zero entries"));
    }
    if original.entries.len() != working.entries.len() {
        return Err(StageDrift::drift(
            "extract produced inconsistent entry counts across copies",
        ));
    }
    Ok(format!(
        "unpacked {} entr{} to original + working copies",
        original.entries.len(),
        if original.entries.len() == 1 {
            "y"
        } else {
            "ies"
        }
    ))
}

// --- Stage 4: PATCH ----------------------------------------------------------

fn stage_patch(fixture: &ScaffoldFixture, inner_bytes: &[u8], patched_dir: &Path) -> StageResult {
    let replacement = fixture.patch.replacement_utf8.as_bytes();
    let manifest =
        replace_plain_xp3_entry_payload(patched_dir, &fixture.patch.entry_path, replacement)
            .map_err(writer_drift("patch (replace entry)"))?;
    if !manifest
        .entries
        .iter()
        .any(|entry| entry.path == fixture.patch.entry_path)
    {
        return Err(StageDrift::drift(format!(
            "patched entry `{}` vanished from the manifest",
            fixture.patch.entry_path
        )));
    }
    let patched_archive =
        pack_plain_xp3_from_directory(patched_dir).map_err(writer_drift("patch (repack)"))?;
    if patched_archive == inner_bytes {
        return Err(StageDrift::drift(
            "patched archive is byte-identical to the source — the patch had no effect",
        ));
    }
    Ok(format!(
        "replaced `{}` and repacked ({} source bytes -> {} patched bytes)",
        fixture.patch.entry_path,
        inner_bytes.len(),
        patched_archive.len()
    ))
}

// --- Stage 5: VERIFY ---------------------------------------------------------

fn stage_verify(fixture: &ScaffoldFixture, inner_bytes: &[u8], patched_dir: &Path) -> StageResult {
    // Determinism: the source archive must re-encode byte-identically.
    let source_archive =
        read_plain_xp3_archive(inner_bytes).map_err(writer_drift("verify (read source)"))?;
    let reencoded = encode_xp3(&source_archive).map_err(writer_drift("verify (encode source)"))?;
    if reencoded != inner_bytes {
        return Err(StageDrift::drift(
            "source archive did not re-encode byte-identically (determinism violation)",
        ));
    }

    // Round-trip: the patched archive must re-read and carry the new payload.
    let patched_archive = pack_plain_xp3_from_directory(patched_dir)
        .map_err(writer_drift("verify (repack patched)"))?;
    let patched =
        read_plain_xp3_archive(&patched_archive).map_err(writer_drift("verify (read patched)"))?;
    let patched_entry = patched
        .entries
        .iter()
        .find(|entry| entry.path == fixture.patch.entry_path)
        .ok_or_else(|| {
            StageDrift::drift(format!(
                "verify could not find patched entry `{}`",
                fixture.patch.entry_path
            ))
        })?;
    if patched_entry.payload != fixture.patch.replacement_utf8.as_bytes() {
        return Err(StageDrift::drift(
            "verify found the patched entry payload did not match the replacement",
        ));
    }
    Ok(format!(
        "source re-encode byte-identical; patched entry `{}` carries the replacement",
        fixture.patch.entry_path
    ))
}

// --- Stage 6: DELTA APPLY ----------------------------------------------------

fn stage_delta_apply(original_dir: &Path, patched_dir: &Path, work_dir: &Path) -> StageResult {
    let delta = create_delta(original_dir, patched_dir, SourceProvenance::complete())
        .map_err(|error| StageDrift::drift(format!("create_delta failed: {error}")))?;
    let delta_path = work_dir.join("contract-scaffold.delta.json");
    fs::write(&delta_path, format!("{delta:#}"))
        .map_err(|error| StageDrift::drift(format!("could not persist delta package: {error}")))?;

    let applied_dir = work_dir.join("applied");
    apply_delta(original_dir, &delta_path, &applied_dir)
        .map_err(|error| StageDrift::drift(format!("apply_delta failed: {error}")))?;

    // The applied directory must repack to the exact patched archive bytes.
    let applied_archive = pack_plain_xp3_from_directory(&applied_dir)
        .map_err(writer_drift("delta_apply (repack applied)"))?;
    let patched_archive = pack_plain_xp3_from_directory(patched_dir)
        .map_err(writer_drift("delta_apply (repack patched)"))?;
    if applied_archive != patched_archive {
        return Err(StageDrift::drift(
            "delta-applied archive did not match the patched archive (round-trip violation)",
        ));
    }
    Ok(format!(
        "delta applied; repacked {} bytes match the patched archive",
        applied_archive.len()
    ))
}

// --- Helpers -----------------------------------------------------------------

fn writer_drift(
    context: &'static str,
) -> impl FnOnce(kaifuu_core::PlainXp3WriterError) -> StageDrift {
    move |error| StageDrift::semantic(error.semantic_code(), format!("{context}: {error}"))
}

fn parse_secret_ref(value: &str) -> Result<SecretRef, StageDrift> {
    SecretRef::new(value.to_string())
        .map_err(|error| StageDrift::drift(format!("malformed secretRef: {error}")))
}

fn parse_material_kind(value: &str) -> Result<KeyMaterialKind, StageDrift> {
    serde_json::from_value::<KeyMaterialKind>(serde_json::Value::String(value.to_string()))
        .map_err(|error| StageDrift::drift(format!("unknown materialKind `{value}`: {error}")))
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> KaifuuResult<T> {
    let bytes = fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    Ok(serde_json::from_slice(&bytes)?)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn fixture_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("fixtures/public/kaifuu-encrypted-xp3-contract-scaffold")
    }

    fn fixture_descriptor() -> PathBuf {
        fixture_dir().join("contract-scaffold.fixture.json")
    }

    fn copy_dir_recursive(source: &Path, dest: &Path) {
        fs::create_dir_all(dest).unwrap();
        for entry in fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            let target = dest.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_dir_recursive(&entry.path(), &target);
            } else {
                fs::copy(entry.path(), &target).unwrap();
            }
        }
    }

    #[test]
    fn stage_count_matches_contract() {
        // Compile-time half of the drift guard: the canonical stage list must
        // enumerate exactly the six contract stages, in order.
        assert_eq!(CONTRACT_SCAFFOLD_STAGES.len(), 6);
        assert_eq!(
            CONTRACT_SCAFFOLD_STAGES,
            &[
                ContractStage::Detect,
                ContractStage::KeyResolution,
                ContractStage::Extract,
                ContractStage::Patch,
                ContractStage::Verify,
                ContractStage::DeltaApply,
            ]
        );
    }

    #[test]
    fn full_contract_surface_passes_end_to_end() {
        let work = tempfile::tempdir().unwrap();
        let report =
            run_encrypted_xp3_contract_scaffold(&fixture_descriptor(), &work.path().join("run"))
                .expect("harness should not error environmentally");

        assert_eq!(
            report.status,
            OperationStatus::Passed,
            "stages: {:?}",
            report.stages
        );
        assert!(report.not_retail_readiness_claim);
        assert_eq!(
            report.disclaimer,
            ENCRYPTED_XP3_CONTRACT_SCAFFOLD_DISCLAIMER
        );
        assert!(
            report.disclaimer.to_lowercase().contains("not")
                && report.disclaimer.to_lowercase().contains("readiness"),
            "disclaimer must disclaim readiness"
        );

        // Every canonical stage ran exactly once and passed.
        assert_eq!(report.stages.len(), CONTRACT_SCAFFOLD_STAGES.len());
        for stage in CONTRACT_SCAFFOLD_STAGES {
            let outcome = report
                .stage(*stage)
                .unwrap_or_else(|| panic!("stage {} missing", stage.as_str()));
            assert_eq!(
                outcome.status,
                ContractStageStatus::Passed,
                "stage {} failed: {}",
                stage.as_str(),
                outcome.detail
            );
            assert!(outcome.semantic_code.is_none());
        }
    }

    #[test]
    fn contract_drift_fails_with_semantic_diagnostic_not_panic() {
        // Induce drift by corrupting the decrypted inner archive into
        // encrypted bytes. The extract stage must fail with the existing
        // semantic capability code — never a panic or opaque error.
        let tmp = tempfile::tempdir().unwrap();
        let drifted = tmp.path().join("fixture");
        copy_dir_recursive(&fixture_dir(), &drifted);
        let envelope = fs::read(drifted.join("encrypted-envelope.xp3")).unwrap();
        fs::write(drifted.join("decrypted-inner.xp3"), &envelope).unwrap();

        let report = run_encrypted_xp3_contract_scaffold(
            &drifted.join("contract-scaffold.fixture.json"),
            &tmp.path().join("run"),
        )
        .expect("harness must return a structured report, not error, on drift");

        assert_eq!(report.status, OperationStatus::Failed);
        // The disclaimer is still present even when the contract drifts.
        assert_eq!(
            report.disclaimer,
            ENCRYPTED_XP3_CONTRACT_SCAFFOLD_DISCLAIMER
        );
        // The extract stage carries the existing encrypted-variant semantic
        // code.
        let extract = report.stage(ContractStage::Extract).unwrap();
        assert_eq!(extract.status, ContractStageStatus::Failed);
        assert_eq!(
            extract.semantic_code.as_deref(),
            Some(kaifuu_core::SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED)
        );
        // Every failed stage carries a non-empty semantic code (no opaque
        // failures).
        for outcome in &report.stages {
            if outcome.status == ContractStageStatus::Failed {
                assert!(
                    outcome
                        .semantic_code
                        .as_deref()
                        .is_some_and(|c| !c.is_empty()),
                    "failed stage {} lacks a semantic code",
                    outcome.stage.as_str()
                );
            }
        }
    }

    #[test]
    fn missing_descriptor_is_an_environmental_error() {
        let work = tempfile::tempdir().unwrap();
        let result = run_encrypted_xp3_contract_scaffold(
            Path::new("/nonexistent/contract-scaffold.fixture.json"),
            &work.path().join("run"),
        );
        assert!(result.is_err());
    }
}
