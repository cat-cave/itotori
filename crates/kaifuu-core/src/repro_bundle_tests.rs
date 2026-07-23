use super::*;

use super::fixtures::*;
#[test]
fn clean_bundle_validates_green() {
    let report = validate_repro_bundle(&clean_bundle());
    assert!(report.is_clean(), "{report:#?}");
    assert_eq!(report.status, OperationStatus::Passed);
    assert!(report.self_sufficient);
    assert!(report.violations.is_empty());
    assert!(report.gaps.is_empty());
    assert_eq!(report.tuple_report.status, OperationStatus::Passed);
    assert_eq!(report.tuple_count, 2);
    assert_eq!(report.proof_count, 2);
}

#[test]
fn clean_bundle_round_trips_through_json() {
    let bundle = clean_bundle();
    let json = serde_json::to_string(&bundle).expect("serialize");
    let round: ReproBundle = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(round, bundle);
}

fn assert_rejects_class(bundle: &ReproBundle, class: PrivateAssetClass) {
    let report = validate_repro_bundle(bundle);
    assert_eq!(
        report.status,
        OperationStatus::Failed,
        "bundle carrying {} must fail: {report:#?}",
        class.as_str()
    );
    assert!(!report.self_sufficient);
    let hits = report.violations_of(class);
    assert!(
        !hits.is_empty(),
        "expected a {} violation, got {:#?}",
        class.as_str(),
        report.violations
    );
    // The error NAMES bundle id, tuple id (when applicable), and field.
    for hit in hits {
        assert_eq!(hit.bundle_id, bundle.bundle_id);
        assert!(!hit.field.is_empty());
        assert!(hit.message.contains(&bundle.bundle_id));
        assert!(hit.message.contains(&hit.field));
        if let Some(tuple_id) = &hit.tuple_id {
            assert!(hit.message.contains(tuple_id));
        }
        // The rejected value never leaks into the message.
        assert!(!hit.message.contains("deadbeef"));
        assert!(!hit.message.contains("/home/operator"));
    }
}

#[test]
fn rejects_raw_key() {
    assert_rejects_class(&dirty_raw_key(), PrivateAssetClass::RawKey);
    // Named on the tuple + the diagnostic detail field.
    let report = validate_repro_bundle(&dirty_raw_key());
    let hit = report.violations_of(PrivateAssetClass::RawKey)[0];
    assert_eq!(hit.field, "diagnostics[0].detail");
    assert!(hit.tuple_id.is_some());
}

#[test]
fn rejects_private_path() {
    assert_rejects_class(&dirty_private_path(), PrivateAssetClass::PrivatePath);
}

#[test]
fn rejects_retail_bytes() {
    assert_rejects_class(&dirty_retail_bytes(), PrivateAssetClass::RetailBytes);
    let report = validate_repro_bundle(&dirty_retail_bytes());
    let hit = report.violations_of(PrivateAssetClass::RetailBytes)[0];
    assert_eq!(hit.field, "reproductionProofs[0].fixtureId");
}

#[test]
fn rejects_screenshot() {
    assert_rejects_class(&dirty_screenshot(), PrivateAssetClass::Screenshot);
}

#[test]
fn rejects_prompt_log() {
    assert_rejects_class(&dirty_prompt_log(), PrivateAssetClass::PromptLog);
}

#[test]
fn rejects_story_text() {
    assert_rejects_class(&dirty_story_text(), PrivateAssetClass::StoryText);
}

#[test]
fn every_private_asset_class_is_rejected() {
    // One dirty bundle per class — all six are policed.
    let cases: [(ReproBundle, PrivateAssetClass); 6] = [
        (dirty_raw_key(), PrivateAssetClass::RawKey),
        (dirty_private_path(), PrivateAssetClass::PrivatePath),
        (dirty_retail_bytes(), PrivateAssetClass::RetailBytes),
        (dirty_screenshot(), PrivateAssetClass::Screenshot),
        (dirty_prompt_log(), PrivateAssetClass::PromptLog),
        (dirty_story_text(), PrivateAssetClass::StoryText),
    ];
    for (bundle, class) in &cases {
        assert_rejects_class(bundle, *class);
    }
    // And all six classes are distinct strings.
    let mut names: Vec<&str> = PrivateAssetClass::all()
        .iter()
        .map(|c| c.as_str())
        .collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), 6);
}

#[test]
fn proof_hashes_and_fixture_ids_are_self_sufficient() {
    // A clean bundle needs no private corpus: every tuple has a public
    // reproduction proof (fixture id + proof hash) and every proof resolves.
    let report = validate_repro_bundle(&clean_bundle());
    assert!(report.self_sufficient);
    // The serialized report carries only proof-hash refs + local secret refs.
    let json = report.stable_json().expect("serialize");
    assert!(json.contains("sha256:"));
    assert!(json.contains("local-secret:"));
    assert!(!json.contains("BEGIN"));
}

#[test]
fn unresolved_tuple_reference_breaks_self_sufficiency() {
    let report = validate_repro_bundle(&dirty_unresolved_reference());
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(!report.self_sufficient);
    assert!(report.violations.is_empty(), "no private asset here");
    assert!(
        report
            .gaps
            .iter()
            .any(|g| g.kind == ReproductionGapKind::UnresolvedTupleReference)
    );
    // And the original tuple is now unproven → a second gap.
    assert!(
        report
            .gaps
            .iter()
            .any(|g| g.kind == ReproductionGapKind::TupleWithoutReproductionProof)
    );
}

#[test]
fn embedded_overclaim_tuple_fails_the_bundle() {
    // A bundle that embeds an overclaiming tuple (patch without evidence)
    // fails via the rolled-up gate, even with no private asset.
    let mut bundle = clean_bundle();
    let overclaim = tuple_overclaim();
    bundle.reproduction_proofs.push(ReproductionProof::new(
        overclaim.profile_or_fixture_id.clone(),
        "public/siglus-overclaim",
        proof_for("overclaim"),
    ));
    bundle.support_tuples.push(overclaim);
    let report = validate_repro_bundle(&bundle);
    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.tuple_report.status, OperationStatus::Failed);
    assert!(report.violations.is_empty());
}

fn tuple_overclaim() -> crate::compat_profile::ClaimedSupportTuple {
    crate::compat_profile::fixtures::overclaim_patch_without_evidence()
}

fn proof_for(seed: &str) -> ProofHash {
    ProofHash::new(crate::sha256_hash_bytes(seed.as_bytes())).expect("valid proof")
}

#[test]
fn scanner_classifies_each_class_directly() {
    assert_eq!(
        scan_private_asset("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
        Some(PrivateAssetClass::RawKey)
    );
    assert_eq!(
        scan_private_asset("/home/trevor/games/x.pck"),
        Some(PrivateAssetClass::PrivatePath)
    );
    assert_eq!(
        scan_private_asset("attached Scene.xp3 archive"),
        Some(PrivateAssetClass::RetailBytes)
    );
    assert_eq!(
        scan_private_asset("frame.png of the title screen"),
        Some(PrivateAssetClass::Screenshot)
    );
    assert_eq!(
        scan_private_asset("system prompt: translate this"),
        Some(PrivateAssetClass::PromptLog)
    );
    assert_eq!(
        scan_private_asset("decrypted script contents"),
        Some(PrivateAssetClass::StoryText)
    );
    // Clean strings the bundle legitimately carries are NOT flagged.
    assert_eq!(scan_private_asset("compat/siglus/known-key-extract"), None);
    assert_eq!(
        scan_private_asset(
            "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        ),
        None
    );
    assert_eq!(
        scan_private_asset("local-secret:siglus-scene-static-key"),
        None
    );
    assert_eq!(
        scan_private_asset("per-title key material must be resolved by an external helper"),
        None
    );
    assert_eq!(
        scan_private_asset("plaintext KAG only — encrypted commercial XP3 is NOT covered"),
        None
    );
}
