//! Resolution integration tests.

mod common;

use kaifuu_vault_source::{
    ArtifactSelection, ClaimQuery, LocalCorpusSource, MaterializeOptions, ScratchConfig,
    VaultConfig, VaultSource,
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
fn selects_primary_role_by_default_and_includes_patch_role_on_request() {
    let v = common::SyntheticVault::build();
    let source = open_source(&v);

    // Default: only primary.
    let candidate = source
        .discover(&ClaimQuery::ByReleaseId { release_id: 10 })
        .unwrap()
        .pop()
        .unwrap();
    let mat = source
        .materialize(&candidate, MaterializeOptions::default())
        .unwrap();
    let roles: Vec<&str> = mat.artifacts.iter().map(|a| a.role.as_str()).collect();
    assert_eq!(roles, vec!["primary"]);

    // With patch included.
    let candidate2 = source
        .discover(&ClaimQuery::ByReleaseId { release_id: 10 })
        .unwrap()
        .pop()
        .unwrap();
    let opts = MaterializeOptions {
        selection: ArtifactSelection::default().with_roles(["patch"]),
        ..Default::default()
    };
    let mat = source.materialize(&candidate2, opts).unwrap();
    let mut roles: Vec<&str> = mat.artifacts.iter().map(|a| a.role.as_str()).collect();
    roles.sort_unstable();
    assert_eq!(roles, vec!["patch", "primary"]);
}

#[test]
fn never_reads_from_artifacts_by_name_subtree() {
    // The fixture's by-name/ tree contains a decoy. The adapter must
    // resolve by-id and never touch by-name/.
    // We can't easily observe "no syscall" from a Rust test, but we can
    // observe: after a successful materialize using by-id, by-name/'s
    // contents are unchanged (modification times preserved).
    let v = common::SyntheticVault::build();

    let by_name_snapshot = common::snapshot_tree(&v.vault_root.join("artifacts/by-name"));
    assert!(
        !by_name_snapshot.is_empty(),
        "decoy by-name/ tree should exist for this test"
    );

    let source = open_source(&v);
    let candidate = source
        .discover(&ClaimQuery::ByReleaseId { release_id: 10 })
        .unwrap()
        .pop()
        .unwrap();
    let _ = source
        .materialize(&candidate, MaterializeOptions::default())
        .unwrap();

    let after = common::snapshot_tree(&v.vault_root.join("artifacts/by-name"));
    assert_eq!(by_name_snapshot, after);
}

#[test]
fn extracts_subpath_artifact_and_returns_subpath_root_under_extracted_root() {
    let v = common::SyntheticVault::build();
    let source = open_source(&v);
    let candidate = source
        .discover(&ClaimQuery::ByReleaseId { release_id: 11 })
        .unwrap()
        .pop()
        .unwrap();
    let mat = source
        .materialize(&candidate, MaterializeOptions::default())
        .unwrap();
    assert!(mat.subpath_root.is_some());
    let sp = mat.subpath_root.as_ref().unwrap();
    assert!(sp.starts_with(&mat.extracted_root));
    assert!(sp.exists(), "subpath root must exist");
    assert!(sp.join("game.exe").exists(), "Win/game.exe should exist");
}
