//! Extraction integration tests.

// reason: test names embed UPPER_SNAKE schema/env identifiers verbatim for grep-ability.
#![allow(non_snake_case)]

mod common;

use kaifuu_vault_source::{
    ClaimQuery, LocalCorpusSource, MaterializeOptions, ScratchConfig, VaultConfig, VaultSource,
    VaultSourceError,
};

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
fn materialize_raises_ExtractionUnsafePath_for_path_traversal_fixture() {
    let v = common::SyntheticVault::build();
    let source = open_source(&v);
    let candidate = source
        .discover(&ClaimQuery::ByReleaseId { release_id: 14 })
        .unwrap()
        .pop()
        .unwrap();
    let err = source
        .materialize(&candidate, MaterializeOptions::default())
        .unwrap_err();
    assert!(
        matches!(
            err,
            VaultSourceError::ExtractionUnsafePath {
                reason: "parent-dir",
                ..
            }
        ),
        "expected ExtractionUnsafePath{{parent-dir}}, got {err:?}"
    );
}

#[test]
fn removes_per_run_extraction_directory_on_extraction_failure() {
    let v = common::SyntheticVault::build();
    let source = open_source(&v);
    let candidate = source
        .discover(&ClaimQuery::ByReleaseId { release_id: 14 })
        .unwrap()
        .pop()
        .unwrap();
    let _err = source
        .materialize(&candidate, MaterializeOptions::default())
        .unwrap_err();
    // After failure, scratch must not contain a leftover run dir for this game.
    let game_root = v.scratch_root.join("v5000");
    if game_root.exists() {
        // Allow the game-root dir itself to exist; assert no run-id
        // subdir survives.
        for e in std::fs::read_dir(&game_root).unwrap() {
            let e = e.unwrap();
            let name = e.file_name().into_string().unwrap();
            // Marker file (.last-canonical-id) is fine; run dirs are not.
            assert!(
                name.starts_with('.'),
                "leftover run dir survived failure: {name}"
            );
        }
    }
}

#[test]
fn does_not_write_any_file_under_vault_root_during_a_materialize_call() {
    let v = common::SyntheticVault::build();
    let before = common::snapshot_tree(&v.vault_root);
    let source = open_source(&v);
    let candidate = source
        .discover(&ClaimQuery::ByReleaseId { release_id: 10 })
        .unwrap()
        .pop()
        .unwrap();
    let _ = source
        .materialize(&candidate, MaterializeOptions::default())
        .unwrap();
    let after = common::snapshot_tree(&v.vault_root);
    // The vault root tree must be entirely unchanged: same paths, same
    // mtimes.
    assert_eq!(before.len(), after.len());
    for (b, a) in before.iter().zip(after.iter()) {
        assert_eq!(b.0, a.0, "path drift: before={:?} after={:?}", b.0, a.0);
        assert_eq!(b.1, a.1, "mtime drift on {:?}", b.0);
    }
}
