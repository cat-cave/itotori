//! Integration tests that load the synthetic conformance JSON fixtures
//! committed under `tests/fixtures/conformance/`.
//!
//! Each test corresponds 1:1 to a fixture file and asserts the
//! expected acceptance / rejection behavior. The fixtures are stored
//! as JSON (not inline `json!` macros) so reviewers can read them as
//! data and a future TypeScript schema mirror has a clear input
//! (plan §12.6).

use std::path::PathBuf;

use serde_json::Value;

use utsushi_core::{
    ConformanceError, ConformanceManifest, ConformanceResult,
    cross_validate_results_against_manifest,
};

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("conformance")
        .join(name)
}

fn load_fixture(name: &str) -> Value {
    let path = fixture_path(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("read fixture {}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|_| panic!("parse fixture {}", path.display()))
}

fn load_paired_fixture(name: &str) -> (ConformanceManifest, Vec<ConformanceResult>) {
    let value = load_fixture(name);
    let object = value
        .as_object()
        .expect("paired fixture is a JSON object with manifest+results");
    let manifest_value = object.get("manifest").expect("manifest field").clone();
    let results_value = object.get("results").expect("results field").clone();
    let manifest = ConformanceManifest::from_json_value(manifest_value)
        .expect("manifest parses and validates");
    let results: Vec<ConformanceResult> = results_value
        .as_array()
        .expect("results is an array")
        .iter()
        .map(|value| {
            ConformanceResult::from_json_value(value.clone())
                .expect("each result parses and validates")
        })
        .collect();
    (manifest, results)
}

#[test]
fn positive_fixture_text_trace_pass_round_trips_and_cross_validates() {
    let (manifest, results) = load_paired_fixture("positive_fixture_text_trace_pass.json");
    cross_validate_results_against_manifest(&manifest, &results).expect("cross-validates");
}

#[test]
fn positive_fixture_frame_capture_pass_round_trips_and_cross_validates() {
    let (manifest, results) = load_paired_fixture("positive_fixture_frame_capture_pass.json");
    cross_validate_results_against_manifest(&manifest, &results).expect("cross-validates");
}

#[test]
fn negative_fixture_declared_profile_skipped_cross_validation_rejects() {
    // The fixture's manifest and result are individually well-formed —
    // ConformanceResult::validate accepts a Skip outcome standalone.
    // The DeclaredProfileSkipped rejection comes from the cross-check.
    let value = load_fixture("negative_fixture_declared_profile_skipped.json");
    let object = value.as_object().expect("paired fixture object");
    let manifest = ConformanceManifest::from_json_value(object["manifest"].clone())
        .expect("manifest parses individually");
    let result = ConformanceResult::from_json_value(object["results"][0].clone())
        .expect("result parses individually (Skip is structurally valid)");
    let error = cross_validate_results_against_manifest(&manifest, &[result])
        .expect_err("cross-check rejects Skip for declared profile");
    assert!(matches!(
        error,
        ConformanceError::DeclaredProfileSkipped { .. }
    ));
}

#[test]
fn negative_fixture_pass_without_evidence_from_json_value_rejects() {
    let value = load_fixture("negative_fixture_pass_without_evidence.json");
    let error = ConformanceResult::from_json_value(value)
        .expect_err("Pass without evidence must reject on parse");
    let downcast = error
        .downcast::<ConformanceError>()
        .expect("error is a ConformanceError");
    assert!(matches!(
        *downcast,
        ConformanceError::PassWithoutEvidence { .. }
    ));
}

#[test]
fn negative_fixture_pass_above_profile_ceiling_from_json_value_rejects() {
    let value = load_fixture("negative_fixture_pass_above_profile_ceiling.json");
    let error = ConformanceResult::from_json_value(value)
        .expect_err("Pass tier above profile ceiling must reject on parse");
    let downcast = error
        .downcast::<ConformanceError>()
        .expect("error is a ConformanceError");
    assert!(matches!(
        *downcast,
        ConformanceError::EvidenceTierAboveProfileCeiling { .. }
    ));
}

#[test]
fn negative_fixture_unsupported_declared_in_manifest_true_from_json_value_rejects() {
    let value = load_fixture("negative_fixture_unsupported_declared_in_manifest_true.json");
    let error = ConformanceResult::from_json_value(value)
        .expect_err("Unsupported with declared_in_manifest=true must reject on parse");
    let downcast = error
        .downcast::<ConformanceError>()
        .expect("error is a ConformanceError");
    assert!(matches!(
        *downcast,
        ConformanceError::DeclaredProfileReportedAsUnsupported { .. }
    ));
}

#[test]
fn negative_fixture_evidence_ref_file_scheme_from_json_value_rejects() {
    let value = load_fixture("negative_fixture_evidence_ref_file_scheme.json");
    let error = ConformanceResult::from_json_value(value)
        .expect_err("file:// evidence ref must reject on parse");
    let downcast = error
        .downcast::<ConformanceError>()
        .expect("error is a ConformanceError");
    assert!(matches!(
        *downcast,
        ConformanceError::EvidenceRefInvalid {
            artifact_kind: "runtime_artifact",
            ..
        }
    ));
}

#[test]
fn negative_fixture_duplicate_profile_from_json_value_rejects() {
    let value = load_fixture("negative_fixture_duplicate_profile.json");
    let error = ConformanceManifest::from_json_value(value)
        .expect_err("duplicate profile must reject on parse");
    let downcast = error
        .downcast::<ConformanceError>()
        .expect("error is a ConformanceError");
    assert!(matches!(
        *downcast,
        ConformanceError::DuplicateProfile { .. }
    ));
}

#[test]
fn negative_fixture_orphaned_extension_from_json_value_rejects() {
    let value = load_fixture("negative_fixture_orphaned_extension.json");
    let error = ConformanceManifest::from_json_value(value)
        .expect_err("orphaned extension must reject on parse");
    let downcast = error
        .downcast::<ConformanceError>()
        .expect("error is a ConformanceError");
    assert!(matches!(
        *downcast,
        ConformanceError::OrphanedExtension { .. }
    ));
}
