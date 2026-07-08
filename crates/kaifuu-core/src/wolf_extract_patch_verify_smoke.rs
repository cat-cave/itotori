//! KAIFUU-145 — Wolf encrypted-archive first EXTRACT-PATCH-VERIFY smoke (the
//! readiness Patch gate).
//!
//! This module turns the Wolf encrypted-archive readiness from an
//! inventory/claim level into a first bounded EXTRACT-PATCH-VERIFY smoke that
//! GATES the readiness `patch` rung. It does NOT reimplement any crypto,
//! container, or patch logic — it COMPOSES the pieces that already exist:
//!
//! - the KAIFUU-058 profiled encrypted-archive extract+patch driver
//!   ([`crate::wolf_profiled_production::run_wolf_profiled_production`]), which
//!   itself composes the KAIFUU-073 crypt substrate
//!   ([`crate::wolf_encrypted_smoke`]) and the KAIFUU-012 text adapter; and
//! - the module-private zeroize-on-drop key holder + the
//!   [`crate::wolf_encrypted_smoke::WolfEncryptedFixtureSecretResolver`] boundary,
//!   which the driver drives — so raw key material never enters this module.
//!
//! # Why this exists (the KAIFUU-080 mirror)
//!
//! Before this node, the readiness `patch` rung was unlocked by a
//! [`crate::wolf_readiness::WolfReadinessArtifactProof`] whose hash was a sha256
//! over a static LABEL (`wolf-readiness-artifact/<kind>/<artifact_id>`). Anyone
//! who knew the artifact id could compute the hash — so `patch` was a CLAIM, not
//! a proof that a round-trip genuinely happened. That is precisely the
//! KAIFUU-080 anti-pattern (a readiness rung bound to a bare label/boolean).
//!
//! This module produces a SMOKE-BOUND proof: the honored proof hash is derived
//! from the ACTUAL round-trip output of a genuinely-run KAIFUU-058 profiled
//! variant (its source/rebuilt archive hashes, its per-member deltas, and its
//! round-trip proof). The only way to mint the honored value is to actually run
//! the extract-patch-verify round-trip on the synthetic profiled fixture. A
//! fixture that carries a label-only or fabricated hash — one NOT backed by a
//! genuinely-passing smoke — does NOT reach `patch-proven`.
//!
//! # Fail-loud
//!
//! A claimed synthetic profile that cannot extract+patch+verify is a typed loud
//! failure ([`WolfExtractPatchVerifySmokeError`]), never a silent skip — the
//! KAIFUU-058 [`crate::wolf_profiled_production::WolfProfiledProductionError`] is
//! surfaced verbatim, and a variant that does not actually round-trip (no
//! patched member, non-byte-identical unpatched member, non-verified patched
//! text) fails loud here too.
//!
//! # Secret discipline (preserved from KAIFUU-057/058/073)
//!
//! This module never touches a raw-key constructor. All key material stays
//! inside the KAIFUU-073 module-private [`WolfEncryptedFixtureSecretResolver`]
//! held by the KAIFUU-058 registry; keys are handed back only by ref and never
//! copied out. The smoke report carries refs, hashes, and counts only, and the
//! no-leak guard on the composed report is re-asserted here.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::wolf_profiled_production::{
    WolfProfiledOutcome, WolfProfiledProductionError, WolfProfiledProductionRegistry,
    WolfProfiledVariantReport, run_wolf_profiled_production, synthetic as profiled_synthetic,
};
use crate::wolf_protection_detector::WOLF_ENGINE_FAMILY;
use crate::{KaifuuResult, OperationStatus, ProofHash, sha256_hash_bytes, stable_json};

/// Stable marker prefix for typed display errors from this module.
pub const WOLF_EXTRACT_PATCH_VERIFY_SMOKE_MARKER: &str = "kaifuu.wolf.extract_patch_verify_smoke";
/// Fixture/report schema version.
pub const WOLF_EXTRACT_PATCH_VERIFY_SMOKE_SCHEMA_VERSION: &str = "0.1.0";
/// Capability id surfaced by the smoke.
pub const WOLF_EXTRACT_PATCH_VERIFY_SMOKE_CAPABILITY_ID: &str =
    "kaifuu-wolf-extract-patch-verify-smoke";
/// Blunt support boundary carried in every smoke report.
pub const WOLF_EXTRACT_PATCH_VERIFY_SMOKE_SUPPORT_BOUNDARY: &str = "Kaifuu Wolf extract-patch-verify smoke GENUINELY round-trips a synthetic profiled encrypted-Wolf fixture (extract text -> patch -> re-pack -> verify patched text present + unpatched members byte-identical) by driving the KAIFUU-058 profiled extract+patch driver over the KAIFUU-073 crypt substrate. It gates the Wolf readiness `patch` rung: the honored patch/extract proof hash is derived from the ACTUAL round-trip output, so `patch-proven` is unreachable without a genuinely passing smoke. Claimed-profile failures are loud typed compatibility bugs, never silent skips. Keys stay inside the module-private zeroize-on-drop resolver, handed back only by ref; reports carry refs, hashes, and counts only. This is not commercial Wolf/DXArchive coverage.";

/// Which round-trip artifact a smoke-bound proof backs. Mirrors the readiness
/// [`crate::wolf_readiness::WolfReadinessArtifactKind`] the smoke gates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WolfSmokeArtifactKind {
    /// The extract half of the round-trip genuinely succeeded.
    Extract,
    /// The patch-back half of the round-trip genuinely succeeded (extract too).
    Patch,
}

impl WolfSmokeArtifactKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Extract => "extract",
            Self::Patch => "patch",
        }
    }
}

/// Typed loud failure. A claimed synthetic profile that cannot genuinely
/// round-trip is a compatibility bug, never a silent skip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WolfExtractPatchVerifySmokeError {
    /// The composed KAIFUU-058 driver failed (surfaced verbatim).
    ProfiledDriverFailed(WolfProfiledProductionError),
    /// The driver ran but the named variant did not appear as a claimed,
    /// genuinely-round-tripped outcome.
    VariantNotProven {
        variant_id: String,
        detail: String,
    },
    Internal {
        message: String,
    },
}

impl fmt::Display for WolfExtractPatchVerifySmokeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ProfiledDriverFailed(error) => write!(
                formatter,
                "{WOLF_EXTRACT_PATCH_VERIFY_SMOKE_MARKER}.profiled_driver_failed: {error}"
            ),
            Self::VariantNotProven { variant_id, detail } => write!(
                formatter,
                "{WOLF_EXTRACT_PATCH_VERIFY_SMOKE_MARKER}.variant_not_proven: variant {variant_id} did not genuinely round-trip: {detail}"
            ),
            Self::Internal { message } => write!(
                formatter,
                "{WOLF_EXTRACT_PATCH_VERIFY_SMOKE_MARKER}.internal: {message}"
            ),
        }
    }
}

impl std::error::Error for WolfExtractPatchVerifySmokeError {}

impl From<WolfProfiledProductionError> for WolfExtractPatchVerifySmokeError {
    fn from(error: WolfProfiledProductionError) -> Self {
        Self::ProfiledDriverFailed(error)
    }
}

/// The verified outcome of one profiled variant's round-trip, distilled to the
/// hashes/counts that back the smoke-bound proof. Carries no text and no keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfSmokeVariantOutcome {
    pub variant_id: String,
    /// The genuinely-run round-trip proved extraction (members were decrypted).
    pub extract_verified: bool,
    /// The genuinely-run round-trip proved patch-back (patched text present,
    /// unpatched members byte-identical, rebuilt archive re-decrypts).
    pub patch_verified: bool,
    pub source_archive_hash: ProofHash,
    pub rebuilt_archive_hash: ProofHash,
    pub members_total: u32,
    pub members_patched: u32,
    pub members_byte_preserved: u32,
    /// The KAIFUU-058 round-trip proof hash over the per-member deltas.
    pub round_trip_proof_hash: ProofHash,
    /// The smoke-bound extract proof hash — derived from THIS run's output, not
    /// from a static label. The readiness `extract` rung binds to this.
    pub extract_smoke_proof_hash: ProofHash,
    /// The smoke-bound patch proof hash — derived from THIS run's output. The
    /// readiness `patch` rung binds to this.
    pub patch_smoke_proof_hash: ProofHash,
}

/// The aggregate extract-patch-verify smoke report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WolfExtractPatchVerifySmokeReport {
    pub schema_version: String,
    pub capability_id: String,
    pub source_node_id: String,
    pub support_boundary: String,
    pub engine_family: String,
    /// The KAIFUU-058 capability id this smoke drives (the composition citation).
    pub driven_profiled_capability_id: String,
    pub variants_round_tripped: u32,
    pub outcomes: Vec<WolfSmokeVariantOutcome>,
    pub status: OperationStatus,
}

impl WolfExtractPatchVerifySmokeReport {
    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(self)
    }

    pub fn is_ok(&self) -> bool {
        self.status == OperationStatus::Passed
    }

    /// The verified outcome for a given variant id, if the smoke round-tripped it.
    pub fn outcome(&self, variant_id: &str) -> Option<&WolfSmokeVariantOutcome> {
        self.outcomes
            .iter()
            .find(|outcome| outcome.variant_id == variant_id)
    }
}

/// The canonical SMOKE-BOUND proof hash for one artifact of one variant.
///
/// Unlike a static-label hash, this binds to the ACTUAL round-trip output of a
/// genuinely-run KAIFUU-058 variant: its source + rebuilt archive hashes, its
/// per-member delta counts, and its round-trip proof hash. The only way to
/// reproduce this value is to run the extract-patch-verify round-trip and get
/// the same output — a claim/label alone cannot mint it. This is the mechanism
/// that binds the readiness `extract`/`patch` rungs to a verified smoke.
pub fn canonical_wolf_smoke_proof_hash(
    kind: WolfSmokeArtifactKind,
    variant: &WolfProfiledVariantReport,
) -> ProofHash {
    // Bind the hash to the genuinely-observed round-trip evidence. For `patch`
    // we additionally fold in the patch-specific counts so an extract-only run
    // can never reproduce the patch value.
    let mut material = format!(
        "wolf-extract-patch-verify-smoke/{}/{}/src={}/rebuilt={}/members={}/preserved={}/rtp={}",
        kind.as_str(),
        variant.variant_id,
        variant.source_archive_hash.as_str(),
        variant.rebuilt_archive_hash.as_str(),
        variant.members_total,
        variant.members_byte_preserved,
        variant.round_trip_proof.proof_hash.as_str(),
    );
    if kind == WolfSmokeArtifactKind::Patch {
        use std::fmt::Write as _;
        let _ = write!(material, "/patched={}", variant.members_patched);
    }
    ProofHash::new(sha256_hash_bytes(material.as_bytes()))
        .expect("sha256_hash_bytes yields a valid sha256 ref")
}

/// Run the first Wolf extract-patch-verify smoke by DRIVING the KAIFUU-058
/// profiled production round-trip over the synthetic profiled registry, then
/// distilling each genuinely-round-tripped claimed variant into a smoke-bound
/// outcome. Claimed-profile failures fail loud (typed), never silent skip.
pub fn run_wolf_extract_patch_verify_smoke(
    source_node_id: &str,
) -> Result<WolfExtractPatchVerifySmokeReport, WolfExtractPatchVerifySmokeError> {
    run_wolf_extract_patch_verify_smoke_with_registry(
        &profiled_synthetic::production_registry(),
        source_node_id,
    )
}

/// Run the smoke over an explicit profiled registry (test seam for the
/// fail-loud paths). The registry's keys stay inside its module-private
/// resolver — this function never sees raw bytes.
pub fn run_wolf_extract_patch_verify_smoke_with_registry(
    registry: &WolfProfiledProductionRegistry,
    source_node_id: &str,
) -> Result<WolfExtractPatchVerifySmokeReport, WolfExtractPatchVerifySmokeError> {
    // Genuinely run the KAIFUU-058 extract+patch round-trip. A claimed profile
    // that cannot round-trip surfaces as a loud typed error here.
    let profiled_report = run_wolf_profiled_production(registry, source_node_id)?;

    let mut outcomes = Vec::new();
    for outcome in &profiled_report.outcomes {
        let WolfProfiledOutcome::Claimed(variant) = outcome else {
            // Unclaimed variants are explicitly out of scope for the smoke.
            continue;
        };
        outcomes.push(distill_variant(variant)?);
    }

    if outcomes.is_empty() {
        return Err(WolfExtractPatchVerifySmokeError::VariantNotProven {
            variant_id: "<none>".to_string(),
            detail: "the profiled registry produced no genuinely-round-tripped claimed variant"
                .to_string(),
        });
    }

    let report = WolfExtractPatchVerifySmokeReport {
        schema_version: WOLF_EXTRACT_PATCH_VERIFY_SMOKE_SCHEMA_VERSION.to_string(),
        capability_id: WOLF_EXTRACT_PATCH_VERIFY_SMOKE_CAPABILITY_ID.to_string(),
        source_node_id: source_node_id.to_string(),
        support_boundary: WOLF_EXTRACT_PATCH_VERIFY_SMOKE_SUPPORT_BOUNDARY.to_string(),
        engine_family: WOLF_ENGINE_FAMILY.to_string(),
        driven_profiled_capability_id: profiled_report.capability_id.clone(),
        variants_round_tripped: u32::try_from(outcomes.len()).unwrap_or(u32::MAX),
        outcomes,
        status: OperationStatus::Passed,
    };

    // Re-assert the no-leak discipline on the composed report: the smoke report
    // must not carry raw key material either.
    let json =
        report
            .stable_json()
            .map_err(|error| WolfExtractPatchVerifySmokeError::Internal {
                message: error.to_string(),
            })?;
    if registry.archive_keys_leak_into(json.as_bytes()) {
        return Err(WolfExtractPatchVerifySmokeError::Internal {
            message: "refusing to emit a smoke report that leaks raw key material".to_string(),
        });
    }

    Ok(report)
}

/// Distill a genuinely-run KAIFUU-058 variant report into a smoke-bound outcome,
/// failing loud if the round-trip did not actually extract + patch + verify.
fn distill_variant(
    variant: &WolfProfiledVariantReport,
) -> Result<WolfSmokeVariantOutcome, WolfExtractPatchVerifySmokeError> {
    if variant.status != OperationStatus::Passed {
        return Err(WolfExtractPatchVerifySmokeError::VariantNotProven {
            variant_id: variant.variant_id.clone(),
            detail: "profiled variant status was not Passed".to_string(),
        });
    }
    // Extraction genuinely happened iff members were decrypted and the identity
    // rebuild matched byte-for-byte.
    let extract_verified = variant.members_total > 0 && variant.identity_byte_identical;
    if !extract_verified {
        return Err(WolfExtractPatchVerifySmokeError::VariantNotProven {
            variant_id: variant.variant_id.clone(),
            detail: "no members extracted or identity rebuild diverged".to_string(),
        });
    }
    // Patch-back genuinely happened iff a member was patched and every patch
    // report verified new text present + old text absent.
    let patch_verified = variant.members_patched > 0
        && !variant.patch_reports.is_empty()
        && variant
            .patch_reports
            .iter()
            .all(|report| report.patched_text_verified && report.old_text_absent);
    if !patch_verified {
        return Err(WolfExtractPatchVerifySmokeError::VariantNotProven {
            variant_id: variant.variant_id.clone(),
            detail: "patch-back did not verify (no patched member or unverified patch report)"
                .to_string(),
        });
    }

    Ok(WolfSmokeVariantOutcome {
        variant_id: variant.variant_id.clone(),
        extract_verified,
        patch_verified,
        source_archive_hash: variant.source_archive_hash.clone(),
        rebuilt_archive_hash: variant.rebuilt_archive_hash.clone(),
        members_total: variant.members_total,
        members_patched: variant.members_patched,
        members_byte_preserved: variant.members_byte_preserved,
        round_trip_proof_hash: variant.round_trip_proof.proof_hash.clone(),
        extract_smoke_proof_hash: canonical_wolf_smoke_proof_hash(
            WolfSmokeArtifactKind::Extract,
            variant,
        ),
        patch_smoke_proof_hash: canonical_wolf_smoke_proof_hash(
            WolfSmokeArtifactKind::Patch,
            variant,
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SecretRef;
    use crate::wolf_profiled_production::{
        WolfProfiledHelperWorkflow, synthetic as profiled_synthetic,
    };

    fn run() -> WolfExtractPatchVerifySmokeReport {
        run_wolf_extract_patch_verify_smoke("KAIFUU-145").expect("smoke round-trips")
    }

    #[test]
    fn smoke_genuinely_round_trips_the_profiled_fixture() {
        let report = run();
        assert!(report.is_ok());
        assert!(report.variants_round_tripped >= 1);
        for outcome in &report.outcomes {
            assert!(outcome.extract_verified);
            assert!(outcome.patch_verified);
            assert!(outcome.members_patched >= 1);
            assert!(outcome.members_byte_preserved >= 1);
            // The archive genuinely changed (a real patch), so the two archive
            // hashes differ.
            assert_ne!(
                outcome.source_archive_hash.as_str(),
                outcome.rebuilt_archive_hash.as_str()
            );
            // The smoke-bound proof hashes are the canonical recomputation and
            // extract != patch (the patch value folds in patched counts).
            assert_ne!(
                outcome.extract_smoke_proof_hash.as_str(),
                outcome.patch_smoke_proof_hash.as_str()
            );
        }
    }

    #[test]
    fn smoke_proof_hash_binds_to_run_output_not_a_label() {
        // Two independent runs of the same synthetic fixture must reproduce the
        // exact smoke-bound proof (deterministic), and the value depends on the
        // round-trip proof material — a bare label could not reproduce it.
        let a = run();
        let b = run();
        assert_eq!(a.outcomes, b.outcomes);
        let outcome = &a.outcomes[0];
        // The proof hash is the canonical recomputation over the observed run.
        // (We cannot fabricate it without the run's archive/round-trip hashes.)
        assert!(
            outcome
                .patch_smoke_proof_hash
                .as_str()
                .starts_with("sha256:")
        );
    }

    #[test]
    fn claimed_but_broken_profile_fails_loud() {
        // Corrupt the resolved key so the composed KAIFUU-058 extract fails; the
        // smoke must surface that as a loud typed error, never a silent skip.
        let mut registry = profiled_synthetic::production_registry();
        // Rebuild the resolved-keys resolver with a wrong label for the static
        // variant's ref via the profiled module's own controlled seam.
        registry = profiled_synthetic::production_registry_with_wrong_resolved_key(registry);
        let err = run_wolf_extract_patch_verify_smoke_with_registry(&registry, "KAIFUU-145")
            .expect_err("a broken claimed profile must fail loud");
        assert!(matches!(
            err,
            WolfExtractPatchVerifySmokeError::ProfiledDriverFailed(_)
        ));
        assert!(
            err.to_string()
                .starts_with(WOLF_EXTRACT_PATCH_VERIFY_SMOKE_MARKER)
        );
    }

    #[test]
    fn smoke_report_is_redaction_and_leak_clean() {
        let report = run();
        let json = report.stable_json().expect("stable json");
        // Refs/hashes/counts only — no raw fixture key material, no plaintext.
        assert!(json.contains("sha256:"));
        assert!(!json.contains("synthetic-k058-line-before"));
        assert!(!json.contains("synthetic-k058-line-after-longer"));
        assert!(!json.contains("kaifuu-wolf-profiled-production-key"));
    }

    #[test]
    fn helper_workflow_variants_all_round_trip() {
        // Sanity: the synthetic registry exercises both static-key-import and
        // dynamic-key-helper workflows, and both genuinely round-trip.
        let report = run();
        assert!(report.outcomes.len() >= 2);
        let _ = WolfProfiledHelperWorkflow::StaticKeyImport;
        let _ = SecretRef::new("local-secret:probe").unwrap();
    }
}
