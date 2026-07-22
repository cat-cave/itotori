use super::*;
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

#[path = "test_support.rs"]
mod test_support;
use test_support::runtime_report_json;

const SCREENSHOT_BYTES: &[u8] = b"utsushi fixture deterministic screenshot placeholder\n";
const SCREENSHOT_SHA256: &str = "fea02f42d0815df80a48355bfbee008c261e5a516f2f23f333efb757f618f232";

#[test]
fn sha256_hex_matches_known_vectors() {
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(sha256_hex(SCREENSHOT_BYTES), SCREENSHOT_SHA256);
}

#[test]
fn validates_reference_capture_corpus_with_artifact_hashes() {
    let root = temp_dir("valid");
    let corpus = write_corpus_fixture(&root, FixtureVariant::Valid);

    let report = validate_reference_capture_corpus(&corpus).unwrap();

    assert_eq!(report.fixtures_validated, 1);
    assert_eq!(report.artifacts_validated, 1);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rejects_missing_artifact_hashes() {
    let root = temp_dir("missing-hashes");
    let corpus = write_corpus_fixture(&root, FixtureVariant::MissingHashes);

    let error = validate_reference_capture_corpus(&corpus)
        .unwrap_err()
        .to_string();

    assert!(error.contains("artifactHashes"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rejects_screenshots_outside_artifact_store() {
    let root = temp_dir("outside-artifact-store");
    let corpus = write_corpus_fixture(&root, FixtureVariant::OutsideArtifactStore);

    let error = validate_reference_capture_corpus(&corpus)
        .unwrap_err()
        .to_string();

    assert!(error.contains("runtime artifact uri") || error.contains("artifact store"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rejects_static_reads_labeled_as_runtime_evidence() {
    let root = temp_dir("static-read");
    let corpus = write_corpus_fixture(&root, FixtureVariant::StaticRead);

    let error = validate_reference_capture_corpus(&corpus)
        .unwrap_err()
        .to_string();

    assert!(error.contains("static reads labeled as runtime evidence"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rejects_unredacted_local_paths_in_observation_envelopes() {
    let root = temp_dir("local-path");
    let corpus = write_corpus_fixture(&root, FixtureVariant::UnredactedLocalPath);

    let error = validate_reference_capture_corpus(&corpus)
        .unwrap_err()
        .to_string();

    assert!(error.contains("unredacted local path"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn local_path_detection_allows_artifact_store_redactions_and_normal_prose() {
    for allowed in [
        "artifact-store://runtime/report",
        "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000010000001/screenshots/019ed003-0000-7000-8000-000040000001.png",
        "<redacted-local-path>",
        "[redacted path]",
        "Dialogue choices use yes/no labels.",
        "The UI shows 1/2 pages.",
    ] {
        assert!(
            !looks_like_local_path(allowed),
            "{allowed:?} should not be classified as a local path"
        );
    }
}

#[test]
fn rejects_additional_reference_capture_contract_failures() {
    for (variant, expected_error) in [
        (
            FixtureVariant::ReportSchemaInvalid,
            "runtime report contract invalid",
        ),
        (
            FixtureVariant::SourceRevisionMismatch,
            "sourceRevision does not match",
        ),
        (
            FixtureVariant::RuntimeTargetMismatch,
            "runtimeTargetId fixture:reference-capture-public does not match",
        ),
        (
            FixtureVariant::EventIdMismatch,
            "observationEventIds must name exactly",
        ),
        (
            FixtureVariant::DuplicateEventIds,
            "observationEventIds must be unique",
        ),
        (FixtureVariant::WrongHash, "sha256"),
        (FixtureVariant::WrongByteCount, "byte count"),
        (
            FixtureVariant::ReportIdArtifactRunMismatch,
            "must match runtimeReportId",
        ),
        (
            FixtureVariant::ReportLevelPrivatePath,
            "unredacted local path",
        ),
        (FixtureVariant::RootPrivatePath, "unredacted local path"),
        (FixtureVariant::WindowsPrivatePath, "unredacted local path"),
        (
            FixtureVariant::EmbeddedUncPrivatePath,
            "unredacted local path",
        ),
        (FixtureVariant::SrvPrivatePath, "unredacted local path"),
        (FixtureVariant::DataPrivatePath, "unredacted local path"),
        (FixtureVariant::RunUserPrivatePath, "unredacted local path"),
        (
            FixtureVariant::CorpusMetadataPrivatePath,
            "unredacted local path",
        ),
        (
            FixtureVariant::TopLevelCaptureUnmanifested,
            "top-level capture screenshot artifact",
        ),
        (
            FixtureVariant::NonUuidRuntimeReportId,
            "must be a UUID7 string",
        ),
    ] {
        let root = temp_dir("additional-negative");
        let corpus = write_corpus_fixture(&root, variant);

        let error = validate_reference_capture_corpus(&corpus)
            .unwrap_err()
            .to_string();

        assert!(
            error.contains(expected_error),
            "error {error:?} did not contain {expected_error:?}"
        );
        let _ = fs::remove_dir_all(root);
    }
}

#[test]
fn public_reference_capture_fixtures_cover_positive_and_negative_cases() {
    let public_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/public/utsushi-reference-captures");

    validate_reference_capture_corpus(&public_root.join("reference-capture-corpus.json")).unwrap();

    for (fixture, expected_error) in [
        ("missing-hash-corpus.json", "artifactHashes"),
        ("outside-artifact-store-corpus.json", "runtime artifact uri"),
        (
            "static-read-corpus.json",
            "static reads labeled as runtime evidence",
        ),
        ("unredacted-local-path-corpus.json", "unredacted local path"),
        (
            "capture-unmanifested-corpus.json",
            "top-level capture screenshot artifact",
        ),
        ("non-uuid-run-corpus.json", "must be a UUID7 string"),
        ("embedded-unc-corpus.json", "unredacted local path"),
        ("unlisted-unix-corpus.json", "unredacted local path"),
        ("windows-drive-corpus.json", "unredacted local path"),
    ] {
        let error = validate_reference_capture_corpus(&public_root.join("invalid").join(fixture))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(expected_error),
            "{fixture} error {error:?} did not contain {expected_error:?}"
        );
    }
}

#[derive(Clone, Copy)]
enum FixtureVariant {
    Valid,
    MissingHashes,
    OutsideArtifactStore,
    StaticRead,
    UnredactedLocalPath,
    ReportSchemaInvalid,
    SourceRevisionMismatch,
    RuntimeTargetMismatch,
    EventIdMismatch,
    DuplicateEventIds,
    WrongHash,
    WrongByteCount,
    ReportIdArtifactRunMismatch,
    ReportLevelPrivatePath,
    RootPrivatePath,
    WindowsPrivatePath,
    EmbeddedUncPrivatePath,
    SrvPrivatePath,
    DataPrivatePath,
    RunUserPrivatePath,
    CorpusMetadataPrivatePath,
    TopLevelCaptureUnmanifested,
    NonUuidRuntimeReportId,
}

fn temp_dir(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("utsushi-reference-corpus-{name}-{nonce}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_corpus_fixture(root: &Path, variant: FixtureVariant) -> PathBuf {
    let artifact_root = root.join("artifact-store");
    let artifact_uri = match variant {
        FixtureVariant::OutsideArtifactStore => {
            "artifacts/utsushi/elsewhere/019ed003-0000-7000-8000-000040000001.png"
        }
        FixtureVariant::ReportIdArtifactRunMismatch => {
            "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000099990001/screenshots/019ed003-0000-7000-8000-000040000001.png"
        }
        FixtureVariant::NonUuidRuntimeReportId => {
            "artifacts/utsushi/runtime/not-a-uuid-run/screenshots/019ed003-0000-7000-8000-000040000001.png"
        }
        _ => {
            "artifacts/utsushi/runtime/019ed003-0000-7000-8000-000010000001/screenshots/019ed003-0000-7000-8000-000040000001.png"
        }
    };
    let artifact_path = artifact_root.join(
        "019ed003-0000-7000-8000-000010000001/screenshots/019ed003-0000-7000-8000-000040000001.png",
    );
    fs::create_dir_all(artifact_path.parent().unwrap()).unwrap();
    fs::write(
        artifact_root.join(RUNTIME_ARTIFACT_ROOT_MARKER),
        "managed-by=utsushi-runtime\n",
    )
    .unwrap();
    fs::write(&artifact_path, SCREENSHOT_BYTES).unwrap();
    if matches!(
        variant,
        FixtureVariant::ReportIdArtifactRunMismatch | FixtureVariant::NonUuidRuntimeReportId
    ) {
        let mismatch_artifact_path = artifact_root.join(runtime_artifact_path_suffix(artifact_uri));
        fs::create_dir_all(mismatch_artifact_path.parent().unwrap()).unwrap();
        fs::write(&mismatch_artifact_path, SCREENSHOT_BYTES).unwrap();
    }

    let report = runtime_report_json(artifact_uri, variant);
    fs::write(
        root.join("runtime-report.json"),
        serde_json::to_string_pretty(&report).unwrap(),
    )
    .unwrap();

    let artifact_hashes = match variant {
        FixtureVariant::MissingHashes => json!([]),
        _ => json!([
            {
                "artifactId": "019ed003-0000-7000-8000-000040000001",
                "observationEventId": "019ed003-0000-7000-8000-000071000001",
                "uri": artifact_uri,
                "sha256": match variant {
                    FixtureVariant::WrongHash => "0000000000000000000000000000000000000000000000000000000000000000",
                    _ => SCREENSHOT_SHA256
                },
                "bytes": match variant {
                    FixtureVariant::WrongByteCount => 54,
                    _ => 53
                },
                "mediaType": "text/plain"
            }
        ]),
    };
    let source_revision_source_id = match variant {
        FixtureVariant::SourceRevisionMismatch => "different-source",
        _ => "reference-capture-public",
    };
    let runtime_target_id = match variant {
        FixtureVariant::RuntimeTargetMismatch => "fixture:different-target",
        _ => "fixture:reference-capture-public",
    };
    let observation_event_ids = match variant {
        FixtureVariant::EventIdMismatch => json!([
            "019ed003-0000-7000-8000-000070000001",
            "019ed003-0000-7000-8000-000071000999"
        ]),
        FixtureVariant::DuplicateEventIds => json!([
            "019ed003-0000-7000-8000-000070000001",
            "019ed003-0000-7000-8000-000070000001"
        ]),
        _ => json!([
            "019ed003-0000-7000-8000-000070000001",
            "019ed003-0000-7000-8000-000071000001"
        ]),
    };
    let corpus = json!({
        "schemaVersion": "0.1.0",
        "artifactStoreRoot": match variant {
            FixtureVariant::CorpusMetadataPrivatePath => "/tmp/private-artifact-store",
            _ => "artifact-store"
        },
        "fixtures": [
            {
                "fixtureId": "reference-capture-test",
                "runtimeReportPath": "runtime-report.json",
                "sourceRevision": {
                    "sourceId": source_revision_source_id,
                    "revisionId": "fixture-source-v0.1"
                },
                "runtimeTargetId": runtime_target_id,
                "observationEventIds": observation_event_ids,
                "artifactHashes": artifact_hashes,
                "evidenceTier": "E2",
                "redactionStatus": "not_required"
            }
        ]
    });
    let corpus_path = root.join("corpus.json");
    fs::write(&corpus_path, serde_json::to_string_pretty(&corpus).unwrap()).unwrap();
    corpus_path
}

fn runtime_artifact_path_suffix(uri: &str) -> &str {
    uri.strip_prefix("artifacts/utsushi/runtime/").unwrap()
}
