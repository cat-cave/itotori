//! Metadata cross-check integration tests.

// reason: test names embed UPPER_SNAKE schema/env identifiers verbatim for grep-ability.
#![allow(non_snake_case)]

mod common;

use std::collections::BTreeSet;

use kaifuu_vault_source::metadata::read_embedded_metadata;
use kaifuu_vault_source::{
    ClaimQuery, CrossCheckTolerance, LocalCorpusSource, MaterializeOptions, ScratchConfig,
    VaultConfig, VaultSource, VaultSourceError,
};

fn open_source(v: &common::SyntheticVault) -> VaultSource {
    VaultSource::open(
        &VaultConfig {
            vault_root_override: Some(v.vault_root.clone()),
        },
        &ScratchConfig {
            scratch_root_override: Some(v.scratch_root.clone()),
        },
    )
    .unwrap()
}

#[test]
fn parses_and_validates_synthetic_by_id_sidecars_across_engine_families() {
    let expected_top_level_keys: BTreeSet<&str> = [
        "canonical_id",
        "identifiers",
        "engine",
        "engine_evidence",
        "engine_source",
        "work",
        "release",
        "languages",
        "install_manifest",
        "containers_json",
        "runnable_from_tree",
        "original_filename",
        "original_sha256",
        "size_bytes",
        "source_fetches",
        "state",
        "version",
        "version_norm",
    ]
    .into_iter()
    .collect();

    for (fixture_name, expected_engine, expected_languages) in [
        ("reallive", "reallive", &["ja", "en"][..]),
        ("unity", "unity", &["en"][..]),
    ] {
        let fixture_path = common::test_manifest_dir()
            .join("tests/fixtures/by-id-metadata")
            .join(format!("{fixture_name}.json"));
        let raw = std::fs::read_to_string(&fixture_path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let actual_top_level_keys: BTreeSet<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(actual_top_level_keys, expected_top_level_keys);

        let tree = tempfile::tempdir().unwrap();
        let metadata_dir = tree.path().join("_vault");
        std::fs::create_dir_all(&metadata_dir).unwrap();
        std::fs::write(metadata_dir.join("metadata.json"), raw).unwrap();

        let metadata =
            read_embedded_metadata(tree.path(), value["canonical_id"].as_str().unwrap()).unwrap();
        assert_eq!(metadata.engine.as_deref(), Some(expected_engine));
        assert_eq!(
            metadata.languages,
            expected_languages
                .iter()
                .map(|language| (*language).to_string())
                .collect::<Vec<_>>()
        );
        assert!(metadata.raw["identifiers"][0]["source"].as_str().is_some());
        assert!(metadata.raw["release"].is_object());
        assert!(metadata.raw["containers_json"].is_array());
        assert!(metadata.raw["source_fetches"].is_array());
    }
}

#[test]
fn rejects_synthetic_sidecar_when_languages_are_scalar_values() {
    let mut value: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/by-id-metadata/reallive.json")).unwrap();
    value["languages"] = serde_json::json!(["ja"]);

    let tree = tempfile::tempdir().unwrap();
    let metadata_dir = tree.path().join("_vault");
    std::fs::create_dir_all(&metadata_dir).unwrap();
    std::fs::write(
        metadata_dir.join("metadata.json"),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();

    let err = read_embedded_metadata(tree.path(), value["canonical_id"].as_str().unwrap())
        .expect_err("scalar language entries must fail schema validation");
    match err {
        VaultSourceError::EmbeddedMetadataInvalid { errors, .. } => {
            assert!(
                errors.iter().any(|error| error.contains("languages")),
                "schema error should identify languages: {errors:?}"
            );
        }
        other => panic!("expected EmbeddedMetadataInvalid, got {other:?}"),
    }
}

#[test]
fn materialize_returns_findings_for_platform_mismatch_without_raising_error() {
    let v = common::SyntheticVault::build();
    let source = open_source(&v);
    // Release 11's catalog platforms are {windows, macos}; the subpath
    // archive embeds {windows, macos}, so platforms do overlap — no
    // finding. We assert success here.
    let candidate = source
        .discover(&ClaimQuery::ByReleaseId { release_id: 11 })
        .unwrap()
        .pop()
        .unwrap();
    let mat = source
        .materialize(&candidate, MaterializeOptions::default())
        .unwrap();
    // Platforms overlap; no platform finding expected.
    let platform_findings: Vec<_> = mat
        .findings
        .iter()
        .filter(|f| f.field == "platforms")
        .collect();
    assert!(platform_findings.is_empty());
}

#[test]
fn materialize_raises_CatalogEmbeddedMismatch_for_disjoint_work_identifiers() {
    let v = common::SyntheticVault::build();
    let source = open_source(&v);
    let candidate = source
        .discover(&ClaimQuery::ByReleaseId { release_id: 13 })
        .unwrap()
        .pop()
        .unwrap();
    let err = source
        .materialize(&candidate, MaterializeOptions::default())
        .unwrap_err();
    match err {
        VaultSourceError::CatalogEmbeddedMismatch {
            field, entity_type, ..
        } => {
            assert_eq!(entity_type, "work");
            assert_eq!(field, "identifiers");
        }
        other => panic!("expected CatalogEmbeddedMismatch, got {other:?}"),
    }
}

#[test]
fn materialize_raises_EmbeddedMetadataMissing_when_metadata_absent() {
    let v = common::SyntheticVault::build();
    let source = open_source(&v);
    let candidate = source
        .discover(&ClaimQuery::ByReleaseId { release_id: 15 })
        .unwrap()
        .pop()
        .unwrap();
    let err = source
        .materialize(&candidate, MaterializeOptions::default())
        .unwrap_err();
    assert!(matches!(
        err,
        VaultSourceError::EmbeddedMetadataMissing { .. }
    ));
}

#[test]
fn materialize_resolves_by_id_and_extracts_under_the_canonical_id_wrapper() {
    let v = common::SyntheticVault::build();
    let source = open_source(&v);
    let candidate = source
        .discover(&ClaimQuery::ByReleaseId { release_id: 10 })
        .unwrap()
        .pop()
        .unwrap();
    let mat = source
        .materialize(&candidate, MaterializeOptions::default())
        .unwrap();
    assert_eq!(mat.artifact_canonical_id, common::CID_GOOD_PRIMARY);
    // tree_root is the `<canonical_id>/` wrapper inside extracted_root.
    assert_eq!(
        mat.tree_root,
        mat.extracted_root.join(common::CID_GOOD_PRIMARY)
    );
    assert!(mat.tree_root.join("_vault/metadata.json").exists());
    assert!(mat.tree_root.join("game/start.exe").exists());
    assert_eq!(
        mat.embedded.canonical_id.as_deref(),
        Some(common::CID_GOOD_PRIMARY)
    );
}

#[test]
fn strict_tolerance_succeeds_when_languages_and_engine_agree() {
    let v = common::SyntheticVault::build();
    let source = open_source(&v);
    let candidate = source
        .discover(&ClaimQuery::ByReleaseId { release_id: 10 })
        .unwrap()
        .pop()
        .unwrap();
    let opts = MaterializeOptions {
        tolerance: CrossCheckTolerance::strict(),
        ..Default::default()
    };
    // Embedded languages {ja} == catalog {ja}; engine "kirikiri" == catalog
    // engine fact; strict tolerance therefore raises nothing.
    let mat = source.materialize(&candidate, opts).unwrap();
    assert_eq!(mat.artifact_canonical_id, common::CID_GOOD_PRIMARY);
}
