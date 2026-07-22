use super::*;

use super::fixtures::*;
use crate::OperationStatus;

fn tuple_json(tuple: &ClaimedSupportTuple) -> serde_json::Value {
    serde_json::to_value(tuple).expect("tuple serializes")
}

#[test]
fn all_six_levels_are_distinguished() {
    let levels: Vec<ClaimedSupportLevel> =
        honest_catalogue().iter().map(|t| t.claimed_level).collect();
    for level in ClaimedSupportLevel::all() {
        assert!(
            levels.contains(&level),
            "honest catalogue must demonstrate the {} level",
            level.as_str()
        );
    }
    // And the 6 enum strings are distinct.
    let mut names: Vec<&str> = ClaimedSupportLevel::all()
        .iter()
        .map(|l| l.as_str())
        .collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), 6);
}

#[test]
fn schema_requires_all_ten_fields() {
    // Deserializing a tuple with any one of the 10 required fields removed
    // must fail (serde has no default for them).
    let tuple = level_patch_kirikiri_kag_plaintext();
    let base = tuple_json(&tuple);
    for field in CLAIMED_SUPPORT_REQUIRED_FIELDS {
        let mut object = base.as_object().expect("tuple is a JSON object").clone();
        assert!(
            object.remove(field).is_some(),
            "field {field} must be present in a serialized tuple"
        );
        let result: Result<ClaimedSupportTuple, _> =
            serde_json::from_value(serde_json::Value::Object(object));
        assert!(
            result.is_err(),
            "removing required field {field} must fail deserialization"
        );
    }
    // Sanity: the untouched tuple round-trips.
    let round: ClaimedSupportTuple = serde_json::from_value(base).expect("round trip");
    assert_eq!(round, tuple);
}

#[test]
fn claim_and_evidence_fields_are_also_required() {
    let tuple = level_patch_kirikiri_kag_plaintext();
    for field in ["claimedLevel", "evidence"] {
        let mut object = tuple_json(&tuple).as_object().expect("object").clone();
        object.remove(field);
        let result: Result<ClaimedSupportTuple, _> =
            serde_json::from_value(serde_json::Value::Object(object));
        assert!(result.is_err(), "missing {field} must fail deserialization");
    }
}

#[test]
fn honest_catalogue_all_validates_green() {
    let report = validate_claimed_support_profile(&honest_catalogue());
    assert_eq!(report.status, OperationStatus::Passed, "{report:#?}");
    assert_eq!(report.overclaim_count, 0);
    assert_eq!(report.honest_count, report.tuple_count);
}

#[test]
fn siglus_validates_at_extract_not_patch() {
    let entry = validate_claimed_support_tuple(&level_extract_siglus());
    assert!(entry.is_honest());
    assert_eq!(entry.claimed_level, ClaimedSupportLevel::Extract);
    // Honest posture: patch-back is declared not-implemented and NOT claimed.
    assert!(!entry.claimed_level.claims_patch_back());
    assert!(
        entry
            .diagnostics
            .iter()
            .any(|d| d.layer == CompatLayer::PatchBack
                && d.status == CompatDiagnosticStatus::NotImplemented)
    );
    assert!(!is_real_patch_back(entry.patch_back_mode));
}

#[test]
fn plaintext_kag_is_loose_file_not_xp3() {
    let entry = validate_claimed_support_tuple(&level_patch_kirikiri_kag_plaintext());
    assert!(entry.is_honest());
    assert_eq!(
        entry.engine_family,
        CompatEngineFamily::KirikiriKagPlaintext
    );
    assert_eq!(entry.container, ContainerTransform::LooseFile);
    assert_ne!(entry.container, ContainerTransform::Xp3);
    assert!(entry.claimed_level.claims_patch_back());
}

#[test]
fn encrypted_asset_patch_carries_secret_requirement() {
    let entry = validate_claimed_support_tuple(&patch_rpg_maker_encrypted_asset());
    assert!(entry.is_honest());
    assert_eq!(entry.secret_requirement_ids.len(), 1);
    assert_eq!(
        entry.secret_requirement_ids[0].requirement_id,
        "rpg_maker.mv.encryption-key"
    );
    // Secret is a ref, never raw material.
    assert!(
        entry.secret_requirement_ids[0]
            .secret_ref
            .as_str()
            .starts_with("local-secret:")
    );
}

#[test]
fn anti_overclaim_patch_without_evidence_fails() {
    let entry = validate_claimed_support_tuple(&overclaim_patch_without_evidence());
    assert_eq!(entry.status, OperationStatus::Failed);
    // Blocking evidence-missing diagnostics on every required leg + the
    // not-implemented patch-back mode.
    let blocking: Vec<&CompatDiagnostic> = entry
        .diagnostics
        .iter()
        .filter(|d| d.is_blocking())
        .collect();
    assert!(!blocking.is_empty());
    assert!(
        blocking
            .iter()
            .any(|d| d.status == CompatDiagnosticStatus::EvidenceMissing)
    );
    assert!(blocking.iter().any(|d| d.layer == CompatLayer::PatchBack));
    // The aggregate report flips to Failed and counts the overclaim.
    let report = validate_claimed_support_profile(&[overclaim_patch_without_evidence()]);
    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.overclaim_count, 1);
}

#[test]
fn anti_overclaim_patch_missing_one_leg_fails() {
    // Full mode + extraction + patch_back but MISSING validation → still an
    // overclaim (the chain must be complete).
    let mut tuple = level_patch_kirikiri_kag_plaintext();
    tuple.evidence.validation = None;
    let entry = validate_claimed_support_tuple(&tuple);
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(
        entry
            .diagnostics
            .iter()
            .any(|d| d.status == CompatDiagnosticStatus::EvidenceMissing
                && d.layer == CompatLayer::Evidence)
    );
}

#[test]
fn unknown_variant_is_explicit_typed_diagnostic_not_broad_string() {
    let mut tuple = level_identify();
    tuple.engine_family = CompatEngineFamily::Unknown;
    let entry = validate_claimed_support_tuple(&tuple);
    assert_eq!(entry.status, OperationStatus::Failed);
    let diag = entry
        .diagnostics
        .iter()
        .find(|d| d.status == CompatDiagnosticStatus::UnknownVariant)
        .expect("unknown variant emits a typed diagnostic");
    assert_eq!(diag.layer, CompatLayer::Variant);
    assert_eq!(diag.reason_id, SemanticErrorCode::UnknownEngineVariant);
    assert!(diag.is_blocking());
    // Honesty: every diagnostic carries a typed (layer, status, reasonId),
    // and NO diagnostic status is the broad "unsupported" string — the
    // status enum has no such variant (`not_implemented` etc. state why).
    for d in &entry.diagnostics {
        let status = d.status.as_str();
        assert_ne!(status, "unsupported", "diagnostic status must be specific");
        assert!(!d.reason_id.as_str().is_empty());
    }
    // The serialized diagnostics never carry a bare "unsupported" status.
    let json = validate_claimed_support_profile(&[tuple])
        .stable_json()
        .expect("report serializes");
    assert!(
        !json.contains("\"status\":\"unsupported\""),
        "diagnostics must use typed statuses, not a broad 'unsupported' string"
    );
}

#[test]
fn report_is_redacted_and_ref_only() {
    let report = validate_claimed_support_profile(&honest_catalogue());
    let json = report.stable_json().expect("serialize");
    // No raw key material — only local-scheme refs.
    assert!(!json.contains("BEGIN"));
    assert!(json.contains("local-secret:"));
    // Evidence is proof-hash refs only.
    assert!(json.contains("sha256:"));
}

#[test]
fn identify_and_inventory_need_no_evidence() {
    for tuple in [level_identify(), level_inventory()] {
        let entry = validate_claimed_support_tuple(&tuple);
        assert!(entry.is_honest(), "{entry:?}");
        assert!(entry.evidence == SupportEvidence::none());
    }
}

#[test]
fn runtime_level_requires_runtime_evidence_leg() {
    // Drop the runtime leg from the runtime fixture → overclaim.
    let mut tuple = level_runtime_synthetic();
    tuple.evidence.runtime = None;
    let entry = validate_claimed_support_tuple(&tuple);
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(
        entry
            .diagnostics
            .iter()
            .any(|d| d.layer == CompatLayer::Runtime
                && d.status == CompatDiagnosticStatus::EvidenceMissing)
    );
}
