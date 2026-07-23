use super::*;
use kaifuu_core::{HelperDiagnostic, HelperDiagnosticCode, HelperRedactionStatus, HelperResult};

fn synthetic_helper_results() -> Vec<HelperResult> {
    synthetic::helper_result_aggregate().helper_results
}

fn synthetic_support_tuples() -> Vec<ClaimedSupportTuple> {
    synthetic::support_tuple_summary().support_tuples
}

fn render_synthetic() -> Xp3PrivateLocalSummary {
    let helpers = synthetic_helper_results();
    let tuples = synthetic_support_tuples();
    render_xp3_private_local_summary(Xp3PrivateLocalSummaryInput {
        summary_id: "kaifuu/k102/xp3-private-local-summary",
        helper_results: &helpers,
        support_tuples: &tuples,
        patch_reports: &[],
    })
    .expect("clean synthetic inputs render")
}

#[test]
fn clean_summary_exposes_only_safe_metadata() {
    let summary = render_synthetic();
    assert_eq!(summary.status, OperationStatus::Passed);
    assert_eq!(summary.helper_result_count, 2);
    assert_eq!(summary.support_tuple_count, 2);
    assert_eq!(summary.honest_tuple_count, 2);
    assert_eq!(summary.overclaim_tuple_count, 0);

    // profile ids present.
    assert!(
        summary
            .helper_rows
            .iter()
            .any(|row| row.profile_id.starts_with("019ed000"))
    );
    // secret REQUIREMENT ids present (never the raw key).
    assert!(summary.helper_rows.iter().any(|row| {
        row.secret_requirement_ids
            .contains(&"kirikiri-xp3-key-profile".to_string())
    }));
    assert!(summary.support_rows.iter().any(|row| {
        row.secret_requirement_ids
            .contains(&"kaifuu-k100-xp3-crypt-key".to_string())
    }));
    // proof hashes present.
    assert!(
        summary
            .helper_rows
            .iter()
            .any(|row| !row.proof_hashes.is_empty())
    );
    assert!(
        summary
            .support_rows
            .iter()
            .any(|row| !row.evidence_proof_hashes.is_empty())
    );
    // capability levels present (aggregate).
    assert!(
        summary
            .capability_levels
            .contains(&HelperCapabilityLevel::ManualEntry)
    );
    assert!(
        summary
            .capability_levels
            .contains(&HelperCapabilityLevel::LocalKeyImport)
    );
    // deep scan ran clean.
    assert!(summary.redaction_summary.deep_scan_performed);
    assert_eq!(summary.redaction_summary.secret_leak_findings, 0);
    assert!(summary.redaction_summary.redaction_boundary_ok);
}

#[test]
fn serialized_summary_carries_no_raw_key_or_private_path() {
    let summary = render_synthetic();
    let json = summary.stable_json().expect("stable json");
    // No local absolute paths.
    assert!(!json.contains("/home/"));
    assert!(!json.contains("\\Users\\"));
    // The raw fixture key constant never appears.
    assert!(!json.contains("K100-XP3-XORKEY1"));
    // Round-trips (structurally valid).
    let value: serde_json::Value = serde_json::from_str(&json).expect("valid json");
    assert!(value.get("redactionSummary").is_some());
}

#[test]
fn empty_input_renders_valid_deterministic_summary() {
    let a = render_xp3_private_local_summary(Xp3PrivateLocalSummaryInput {
        summary_id: "kaifuu/k102/xp3-private-local-empty",
        helper_results: &[],
        support_tuples: &[],
        patch_reports: &[],
    })
    .expect("empty render");
    let b = render_xp3_private_local_summary(Xp3PrivateLocalSummaryInput {
        summary_id: "kaifuu/k102/xp3-private-local-empty",
        helper_results: &[],
        support_tuples: &[],
        patch_reports: &[],
    })
    .expect("empty render");
    assert_eq!(a.status, OperationStatus::Passed);
    assert_eq!(a.helper_result_count, 0);
    assert_eq!(a.support_tuple_count, 0);
    assert_eq!(a.patch_summary_count, 0);
    assert!(a.redaction_summary.deep_scan_performed);
    // Omitting every private-local row is fine and byte-stable.
    assert_eq!(
        a.stable_json().unwrap(),
        b.stable_json().unwrap(),
        "empty summary is deterministic"
    );
}

#[test]
fn render_is_reproducible_from_synthetic_inputs() {
    assert_eq!(
        render_synthetic().stable_json().unwrap(),
        render_synthetic().stable_json().unwrap(),
    );
}

#[test]
fn overclaim_tuple_flips_status_failed() {
    let mut tuples = synthetic_support_tuples();
    // Strip the patch-back evidence leg from the patch-claiming tuple → overclaim.
    let patch_tuple = tuples
        .iter_mut()
        .find(|tuple| tuple.claimed_level == ClaimedSupportLevel::Patch)
        .expect("patch tuple present");
    patch_tuple.evidence.patch_back = None;
    let helpers = synthetic_helper_results();
    let summary = render_xp3_private_local_summary(Xp3PrivateLocalSummaryInput {
        summary_id: "kaifuu/k102/xp3-private-local-overclaim",
        helper_results: &helpers,
        support_tuples: &tuples,
        patch_reports: &[],
    })
    .expect("overclaim still renders (it is a status, not a leak)");
    assert_eq!(summary.status, OperationStatus::Failed);
    assert_eq!(summary.overclaim_tuple_count, 1);
    assert!(summary.diagnostics.iter().any(|diagnostic| {
        diagnostic.semantic_code == SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_TUPLE_OVERCLAIM
    }));
}

// These poison a field the renderer COPIES into the summary body (the
// `profileId`, a copied+scanned safe-metadata field). The fail-loud deep
// scan must reject each of the four private-content categories — nothing is
// returned to persist.

/// Build helper results whose (copied, scanned) `profileId` carries a poison
/// payload the deep scan must reject.
fn poisoned_profile_id(poison: &str) -> Vec<HelperResult> {
    let mut helpers = synthetic_helper_results();
    helpers[0].profile_id = poison.to_string();
    helpers
}

fn render_poisoned(helpers: &[HelperResult]) -> KaifuuResult<Xp3PrivateLocalSummary> {
    render_xp3_private_local_summary(Xp3PrivateLocalSummaryInput {
        summary_id: "kaifuu/k102/xp3-private-local-poisoned",
        helper_results: helpers,
        support_tuples: &[],
        patch_reports: &[],
    })
}

#[test]
fn rejects_decrypted_story_text() {
    // Decrypted scenario / story prose is copyrighted private content.
    let helpers =
        poisoned_profile_id("decrypted script text: the heroine confesses under the cherry tree");
    let error = render_poisoned(&helpers).expect_err("story text must be rejected");
    assert!(
        error
            .to_string()
            .contains(SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_SECRET_LEAK)
    );
}

#[test]
fn rejects_screenshot_path() {
    // A screenshot of a spoiler route is private + copyrighted.
    let helpers = poisoned_profile_id("true-ending-route-spoiler.png");
    let error = render_poisoned(&helpers).expect_err("screenshot filename must be rejected");
    assert!(
        error
            .to_string()
            .contains(SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_SECRET_LEAK)
    );
}

#[test]
fn rejects_retail_byte_blob() {
    // A base64 blob of retail archive bytes is disallowed raw material.
    let helpers = poisoned_profile_id("aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldCBrZXkgYmxvYg==");
    let error = render_poisoned(&helpers).expect_err("retail byte blob must be rejected");
    assert!(
        error
            .to_string()
            .contains(SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_SECRET_LEAK)
    );
}

#[test]
fn rejects_raw_helper_output() {
    // A raw helper log / dump must never reach the summary.
    let helpers = poisoned_profile_id("raw helper log dump: register + memory dump");
    let error = render_poisoned(&helpers).expect_err("raw helper output must be rejected");
    assert!(
        error
            .to_string()
            .contains(SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_SECRET_LEAK)
    );
}

#[test]
fn rejects_local_absolute_path_in_profile_id() {
    // A private local game path leaking through a profile id is rejected.
    let helpers = poisoned_profile_id("/home/operator/games/private-title/data.xp3");
    let error = render_poisoned(&helpers).expect_err("private path must be rejected");
    assert!(
        error
            .to_string()
            .contains(SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_SECRET_LEAK)
    );
}

#[test]
fn rejects_forbidden_field_name_in_support_tuple_detail() {
    // A support tuple whose diagnostic detail carries a raw-key phrase is
    // rejected by the value scan even though the field name is innocent.
    let mut tuples = synthetic_support_tuples();
    tuples[0].profile_or_fixture_id = "/home/operator/private/route-spoiler/data.xp3".to_string();
    let helpers = synthetic_helper_results();
    let error = render_xp3_private_local_summary(Xp3PrivateLocalSummaryInput {
        summary_id: "kaifuu/k102/xp3-private-local-poisoned",
        helper_results: &helpers,
        support_tuples: &tuples,
        patch_reports: &[],
    })
    .expect_err("private path in a tuple id must be rejected");
    assert!(
        error
            .to_string()
            .contains(SEMANTIC_XP3_PRIVATE_LOCAL_SUMMARY_SECRET_LEAK)
    );
}

#[test]
fn omits_raw_helper_diagnostic_message() {
    // The renderer copies only the diagnostic CODE, never the free-text
    // helper message — so a poisoned message is OMITTED (safe by
    // construction), and the summary renders clean.
    let mut helpers = synthetic_helper_results();
    helpers[0].diagnostic = HelperDiagnostic {
        code: HelperDiagnosticCode::HelperRequired,
        message: "raw helper log dump: register + memory dump".to_string(),
    };
    let summary = render_xp3_private_local_summary(Xp3PrivateLocalSummaryInput {
        summary_id: "kaifuu/k102/xp3-private-local-omit",
        helper_results: &helpers,
        support_tuples: &[],
        patch_reports: &[],
    })
    .expect("poisoned message is dropped, so the summary renders clean");
    let json = summary.stable_json().expect("stable json");
    assert!(
        !json.contains("memory dump"),
        "helper message must be omitted"
    );
    assert!(!json.contains("register"), "helper message must be omitted");
}

#[test]
fn clean_redaction_status_aggregates() {
    let summary = render_synthetic();
    // One helper is `redacted`, so the aggregate is Redacted (not NotRequired).
    assert_eq!(
        summary.redaction_summary.aggregate_redaction_status,
        HelperRedactionStatus::Redacted
    );
}
