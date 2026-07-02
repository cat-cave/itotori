//! Discovery integration tests against the synthetic vault.

mod common;

use kaifuu_vault_source::{ClaimQuery, LocalCorpusSource, ScratchConfig, VaultConfig, VaultSource};

fn open_source(v: &common::SyntheticVault) -> VaultSource {
    common::isolate_ambient_vault_env();
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
fn discovers_release_for_engine_claim_via_v_current_facts() {
    let v = common::SyntheticVault::build();
    let source = open_source(&v);
    let candidates = source
        .discover(&ClaimQuery::ByEngineClaim {
            engine: "kirikiri".into(),
            engine_version: None,
        })
        .unwrap();
    let ids: Vec<i64> = candidates.iter().map(|c| c.release_id).collect();
    assert!(
        ids.contains(&10) && ids.contains(&11),
        "expected releases 10 and 11 in kirikiri claim, got {ids:?}"
    );
}

#[test]
fn discovers_release_for_external_vndb_id() {
    let v = common::SyntheticVault::build();
    let source = open_source(&v);
    let candidates = source
        .discover(&ClaimQuery::ByExternalId {
            source: "vndb".into(),
            kind: "v".into(),
            value: "v1234".into(),
        })
        .unwrap();
    let ids: Vec<i64> = candidates.iter().map(|c| c.release_id).collect();
    // Both release 10 and 11 belong to work 1.
    assert_eq!(ids, vec![10, 11]);
}

#[test]
fn discovers_release_for_dlsite_rj_code() {
    let v = common::SyntheticVault::build();
    let source = open_source(&v);
    let candidates = source
        .discover(&ClaimQuery::ByExternalId {
            source: "dlsite".into(),
            kind: "rj".into(),
            value: "RJ222222".into(),
        })
        .unwrap();
    let ids: Vec<i64> = candidates.iter().map(|c| c.release_id).collect();
    assert_eq!(ids, vec![20]);
}

#[test]
fn discovers_release_by_release_id_directly() {
    let v = common::SyntheticVault::build();
    let source = open_source(&v);
    let candidates = source
        .discover(&ClaimQuery::ByReleaseId { release_id: 10 })
        .unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].release_id, 10);
    assert_eq!(candidates[0].engine.as_deref(), Some("kirikiri"));
    assert_eq!(candidates[0].engine_version.as_deref(), Some("2.32"));
}

#[test]
fn discovery_raises_release_not_resolved_for_unknown_external_id() {
    let v = common::SyntheticVault::build();
    let source = open_source(&v);
    let err = source
        .discover(&ClaimQuery::ByExternalId {
            source: "vndb".into(),
            kind: "v".into(),
            value: "v0".into(),
        })
        .unwrap_err();
    assert!(matches!(
        err,
        kaifuu_vault_source::VaultSourceError::ReleaseNotResolved { .. }
    ));
}
