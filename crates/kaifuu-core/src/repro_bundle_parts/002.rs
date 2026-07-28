// Validator

fn scan_field(
    bundle_id: &str,
    tuple_id: Option<&str>,
    field: &str,
    value: &str,
    out: &mut Vec<PrivateAssetViolation>,
) {
    if let Some(class) = scan_private_asset(value) {
        out.push(PrivateAssetViolation::new(
            bundle_id, tuple_id, field, class,
        ));
    }
}

/// Collect every private-asset violation in the bundle. Walks the plain-string
/// fields only — [`SecretRef`] / [`ProofHash`] fields are structurally safe and
/// reject raw material at deserialize time.
fn collect_private_asset_violations(bundle: &ReproBundle) -> Vec<PrivateAssetViolation> {
    let mut violations = Vec::new();
    let bundle_id = bundle.bundle_id.as_str();

    // Bundle-level fields.
    scan_field(bundle_id, None, "bundleId", bundle_id, &mut violations);
    for (index, note) in bundle.notes.iter().enumerate() {
        scan_field(
            bundle_id,
            None,
            &format!("notes[{index}]"),
            note,
            &mut violations,
        );
    }

    // Reproduction proofs.
    for (index, proof) in bundle.reproduction_proofs.iter().enumerate() {
        scan_field(
            bundle_id,
            Some(proof.tuple_id.as_str()),
            &format!("reproductionProofs[{index}].tupleId"),
            &proof.tuple_id,
            &mut violations,
        );
        scan_field(
            bundle_id,
            Some(proof.tuple_id.as_str()),
            &format!("reproductionProofs[{index}].fixtureId"),
            &proof.fixture_id,
            &mut violations,
        );
    }

    // Embedded tuples.
    for tuple in &bundle.support_tuples {
        let tuple_id = tuple.profile_or_fixture_id.as_str();
        scan_field(
            bundle_id,
            Some(tuple_id),
            "profileOrFixtureId",
            &tuple.profile_or_fixture_id,
            &mut violations,
        );
        scan_field(
            bundle_id,
            Some(tuple_id),
            "engineVariant",
            &tuple.engine_variant,
            &mut violations,
        );
        for (index, requirement) in tuple.secret_requirement_ids.iter().enumerate() {
            scan_field(
                bundle_id,
                Some(tuple_id),
                &format!("secretRequirementIds[{index}].requirementId"),
                &requirement.requirement_id,
                &mut violations,
            );
        }
        for (index, diagnostic) in tuple.diagnostics.iter().enumerate() {
            if let Some(detail) = &diagnostic.detail {
                scan_field(
                    bundle_id,
                    Some(tuple_id),
                    &format!("diagnostics[{index}].detail"),
                    detail,
                    &mut violations,
                );
            }
        }
        for (leg, evidence) in [
            ("extraction", tuple.evidence.extraction.as_ref()),
            ("validation", tuple.evidence.validation.as_ref()),
            ("patchBack", tuple.evidence.patch_back.as_ref()),
            ("runtime", tuple.evidence.runtime.as_ref()),
        ] {
            if let Some(evidence) = evidence {
                scan_field(
                    bundle_id,
                    Some(tuple_id),
                    &format!("evidence.{leg}.evidenceId"),
                    &evidence.evidence_id,
                    &mut violations,
                );
            }
        }
    }

    violations
}

/// Collect the self-sufficiency gaps: every proof must resolve to an embedded
/// tuple, and every embedded tuple must have at least one reproduction proof.
fn collect_reproduction_gaps(bundle: &ReproBundle) -> Vec<ReproductionGap> {
    let mut gaps = Vec::new();
    let bundle_id = bundle.bundle_id.as_str();

    let tuple_ids: Vec<&str> = bundle
        .support_tuples
        .iter()
        .map(|tuple| tuple.profile_or_fixture_id.as_str())
        .collect();

    for (index, proof) in bundle.reproduction_proofs.iter().enumerate() {
        if !tuple_ids.contains(&proof.tuple_id.as_str()) {
            gaps.push(ReproductionGap::new(
                bundle_id,
                &proof.tuple_id,
                &format!("reproductionProofs[{index}].tupleId"),
                ReproductionGapKind::UnresolvedTupleReference,
            ));
        }
    }

    let proven_ids: Vec<&str> = bundle
        .reproduction_proofs
        .iter()
        .map(|proof| proof.tuple_id.as_str())
        .collect();
    for tuple in &bundle.support_tuples {
        let tuple_id = tuple.profile_or_fixture_id.as_str();
        if !proven_ids.contains(&tuple_id) {
            gaps.push(ReproductionGap::new(
                bundle_id,
                tuple_id,
                "profileOrFixtureId",
                ReproductionGapKind::TupleWithoutReproductionProof,
            ));
        }
    }

    gaps
}

/// Validate a redacted reproduction bundle. Never panics, never returns `Err`.
/// The bundle FAILS iff it carries any private asset, is not self-sufficient for
/// public reproduction, or embeds an overclaiming tuple (gate).
pub fn validate_repro_bundle(bundle: &ReproBundle) -> ReproBundleValidationReport {
    let violations = collect_private_asset_violations(bundle);
    let gaps = collect_reproduction_gaps(bundle);
    let tuple_report = validate_claimed_support_profile(&bundle.support_tuples);

    let self_sufficient = violations.is_empty() && gaps.is_empty();
    let status = if self_sufficient && tuple_report.status == OperationStatus::Passed {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    ReproBundleValidationReport {
        schema_version: REPRO_BUNDLE_REPORT_SCHEMA_VERSION.to_string(),
        boundary: REPRO_BUNDLE_BOUNDARY.to_string(),
        bundle_id: bundle.bundle_id.clone(),
        status,
        tuple_count: bundle.support_tuples.len() as u64,
        proof_count: bundle.reproduction_proofs.len() as u64,
        self_sufficient,
        violations,
        gaps,
        tuple_report,
    }
}

// Fixtures — a clean redacted bundle + per-class dirty bundles (synthetic)

/// Synthetic, redacted, ref-only reproduction-bundle fixtures. The clean bundle
/// validates green; the `inject_*` helpers produce a copy carrying exactly ONE
/// private-asset class (synthetic markers — no real private assets).
pub mod fixtures {
    use super::*;
    use crate::ProofHash;
    use crate::compat_profile::fixtures as tuple_fixtures;
    use crate::sha256_hash_bytes;

    fn proof(seed: &str) -> ProofHash {
        ProofHash::new(sha256_hash_bytes(seed.as_bytes())).expect("synthetic proof hash is valid")
    }

    /// A clean redacted bundle: two honest embedded tuples, each backed by a
    /// public reproduction proof. No private assets, fully self-sufficient.
    pub fn clean_bundle() -> ReproBundle {
        let siglus = tuple_fixtures::level_extract_siglus();
        let kag = tuple_fixtures::level_patch_kirikiri_kag_plaintext();
        ReproBundle {
            schema_version: REPRO_BUNDLE_SCHEMA_VERSION.to_string(),
            bundle_id: "repro/kaifuu/siglus-and-kag".to_string(),
            reproduction_proofs: vec![
                ReproductionProof::new(
                    siglus.profile_or_fixture_id.clone(),
                    "public/siglus-known-key-extract",
                    proof("repro:siglus-extract"),
                ),
                ReproductionProof::new(
                    kag.profile_or_fixture_id.clone(),
                    "public/kirikiri-kag-plaintext-patch",
                    proof("repro:kag-patch"),
                ),
            ],
            support_tuples: vec![siglus, kag],
            notes: vec![
                "reproduce by running the named public fixtures and matching the proof hashes"
                    .to_string(),
            ],
        }
    }

    /// The clean bundle with a synthetic RAW KEY injected into a tuple diagnostic
    /// detail (64 hex chars — trips the raw-key entropy detector).
    pub fn dirty_raw_key() -> ReproBundle {
        let mut bundle = clean_bundle();
        set_first_diagnostic_detail(
            &mut bundle,
            "leaked static key deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        );
        bundle
    }

    /// The clean bundle with a synthetic PRIVATE PATH injected into a note.
    pub fn dirty_private_path() -> ReproBundle {
        let mut bundle = clean_bundle();
        bundle
            .notes
            .push("/home/operator/games/retail/Scene.pck".to_string());
        bundle
    }

    /// The clean bundle with an inline RETAIL BYTES payload injected into a
    /// reproduction-proof fixture id.
    pub fn dirty_retail_bytes() -> ReproBundle {
        let mut bundle = clean_bundle();
        bundle.reproduction_proofs[0].fixture_id =
            "data:application/octet-stream;base64,AAECAwQFBgc=".to_string();
        bundle
    }

    /// The clean bundle with an inline SCREENSHOT injected into a note.
    pub fn dirty_screenshot() -> ReproBundle {
        let mut bundle = clean_bundle();
        bundle
            .notes
            .push("data:image/png;base64,iVBORw0KGgoAAAANS".to_string());
        bundle
    }

    /// The clean bundle with a PROMPT LOG injected into a note.
    pub fn dirty_prompt_log() -> ReproBundle {
        let mut bundle = clean_bundle();
        bundle
            .notes
            .push("system prompt: you are a translator\nassistant: translated line".to_string());
        bundle
    }

    /// The clean bundle with STORY TEXT injected into a tuple diagnostic detail.
    pub fn dirty_story_text() -> ReproBundle {
        let mut bundle = clean_bundle();
        set_first_diagnostic_detail(
            &mut bundle,
            "decrypted script: the heroine confesses her feelings",
        );
        bundle
    }

    /// A bundle whose reproduction proof references a tuple NOT in the bundle —
    /// breaks self-sufficiency without any private asset.
    pub fn dirty_unresolved_reference() -> ReproBundle {
        let mut bundle = clean_bundle();
        bundle.reproduction_proofs[0].tuple_id = "compat/does-not-exist".to_string();
        bundle
    }

    fn set_first_diagnostic_detail(bundle: &mut ReproBundle, detail: &str) {
        let tuple = bundle
            .support_tuples
            .first_mut()
            .expect("clean bundle has tuples");
        let diagnostic = tuple
            .diagnostics
            .first_mut()
            .expect("clean bundle tuple has a diagnostic");
        diagnostic.detail = Some(detail.to_string());
    }
}


