use std::path::PathBuf;

use super::*;

fn fixtures_dir() -> PathBuf {
    crate::test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/bgi")
}

fn load() -> BgiDetectorFixture {
    read_bgi_detector_fixture(&fixtures_dir().join("detector.profiles.json"))
        .expect("BGI detector fixture must parse")
}

fn run() -> BgiDetectorReport {
    run_bgi_detector_fixture(&load())
}

#[test]
fn detector_fixture_set_passes_and_records_kaifuu_085_fields() {
    let report = run();
    assert_eq!(report.status, OperationStatus::Passed, "{report:#?}");
    assert_eq!(report.engine_family, BGI_ENGINE_FAMILY);
    let source_node_slug = report.source_node_id.to_ascii_lowercase().replace('-', "_");
    assert_eq!(source_node_slug, "kaifuu_126");
    assert_eq!(report.entries.len(), 6);

    for entry in &report.entries {
        assert_eq!(entry.status, OperationStatus::Passed, "{entry:#?}");
        assert_eq!(entry.engine_family, BGI_ENGINE_FAMILY);
        assert!(!entry.fixture_id.is_empty());
        assert!(!entry.variant.is_empty());
        assert_eq!(entry.crypto, BgiDetectorCrypto::NoneOrUnknownVariant);
        assert!(
            entry.secret_requirement_ids.is_empty(),
            "{} invented a secret requirement",
            entry.fixture_id
        );
        assert_eq!(entry.proof_hashes.len(), 1);
        assert!(!entry.diagnostics.is_empty());
    }
}

#[test]
fn profile_variants_cover_container_compression_and_layered_cases() {
    let report = run();
    for fixture_id in [
        "bgi.buriko-arc20-container",
        "bgi.bse-encrypted-container",
        "bgi.dsc-compressed-container",
        "bgi.compressed-bg-layered-transform",
        "bgi.no-header-arc",
        "bgi.unknown-container",
    ] {
        assert!(report.entry(fixture_id).is_some(), "missing {fixture_id}");
    }

    let bse = report.entry("bgi.bse-encrypted-container").unwrap();
    let bse_codes: Vec<SemanticErrorCode> =
        bse.diagnostics.iter().map(|d| d.semantic_code).collect();
    assert!(bse_codes.contains(&SemanticErrorCode::UnknownEngineVariant));
    assert!(bse_codes.contains(&SemanticErrorCode::UnsupportedVariantEncrypted));
    assert!(bse_codes.contains(&SemanticErrorCode::MissingCryptoCapability));
    assert!(bse.secret_requirement_ids.is_empty());

    let dsc = report.entry("bgi.dsc-compressed-container").unwrap();
    assert!(
        dsc.diagnostics
            .iter()
            .any(|d| d.semantic_code == SemanticErrorCode::UnknownEngineVariant)
    );
    assert!(
        dsc.diagnostics
            .iter()
            .any(|d| d.semantic_code == SemanticErrorCode::MissingCodecCapability)
    );
    assert!(dsc.secret_requirement_ids.is_empty());

    let layered = report.entry("bgi.compressed-bg-layered-transform").unwrap();
    assert!(
        layered
            .diagnostics
            .iter()
            .any(|d| d.semantic_code == SemanticErrorCode::UnknownEngineVariant)
    );
    assert!(
        layered
            .diagnostics
            .iter()
            .any(|d| d.semantic_code == SemanticErrorCode::UnsupportedLayeredTransform)
    );
    assert!(
        layered
            .diagnostics
            .iter()
            .any(|d| d.semantic_code == SemanticErrorCode::MissingCodecCapability)
    );
    assert!(layered.secret_requirement_ids.is_empty());
}

#[test]
fn proof_hashes_are_derived_from_tuple_fields() {
    let fixture = load();
    for entry in &fixture.entries {
        let codes: Vec<SemanticErrorCode> = derive_diagnostics(entry.profile)
            .iter()
            .map(|diagnostic| diagnostic.semantic_code)
            .collect();
        assert_eq!(
            entry.proof_hashes,
            vec![proof_hash_for_entry(
                entry,
                &fixture.source_node_id,
                &fixture.engine_family,
                &codes
            )],
            "{} proof hash drifted",
            entry.fixture_id
        );
    }
}

#[test]
fn report_is_redaction_clean_and_refuses_invented_keys() {
    let mut fixture = load();
    fixture.detector_set_id = "/home/trevor/private/bgi/real-game.arc".to_string();
    let report = run_bgi_detector_fixture(&fixture);
    let json = report.stable_json().expect("stable json");
    assert!(json.contains("[REDACTED:"));
    assert!(!json.contains("/home/trevor/private/bgi/real-game.arc"));
    for forbidden in [
        "local-secret:",
        "fixture-only-bgi-container-key-v1",
        "bgi-ethornell-container-key",
        "KAIFUU_BGI_CONTAINER_KEY",
    ] {
        assert!(!json.contains(forbidden), "report leaked {forbidden}");
    }

    fixture.entries[0]
        .secret_requirement_ids
        .push("bgi-ethornell-container-key".to_string());
    let report = run_bgi_detector_fixture(&fixture);
    assert_eq!(report.status, OperationStatus::Failed);
    let first = report.entry("bgi.buriko-arc20-container").unwrap();
    assert!(first.findings.iter().any(|finding| {
        finding.code == "bgi.detector.invented_secret_requirement"
            && finding.semantic_code == SemanticErrorCode::MissingCryptoCapability
    }));
}
