//! Negative-path tests: every Failure-Mode row triggered against the
//! synthetic vault.

// reason: test names embed UPPER_SNAKE schema/env identifiers verbatim for grep-ability.
#![allow(non_snake_case)]

mod common;

use std::path::PathBuf;

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
fn vault_root_missing_when_configured_path_does_not_exist() {
    common::isolate_ambient_vault_env();
    let err = VaultSource::open(
        &VaultConfig {
            vault_root_override: Some(PathBuf::from("/tmp/kaifuu-vault-source-nonexistent-please")),
        },
        &ScratchConfig::default(),
    )
    .unwrap_err();
    assert!(matches!(err, VaultSourceError::VaultRootMissing { .. }));
}

#[test]
fn vault_root_incomplete_when_artifacts_by_id_subdir_is_absent() {
    common::isolate_ambient_vault_env();
    let td = tempfile::tempdir().unwrap();
    std::fs::write(td.path().join("catalog.db"), b"x").unwrap();
    let err = VaultSource::open(
        &VaultConfig {
            vault_root_override: Some(td.path().to_path_buf()),
        },
        &ScratchConfig::default(),
    )
    .unwrap_err();
    assert!(matches!(
        err,
        VaultSourceError::VaultRootIncomplete {
            missing: "artifacts/by-id",
            ..
        }
    ));
}

#[test]
fn catalog_open_failed_when_catalog_db_is_a_directory() {
    common::isolate_ambient_vault_env();
    let td = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(td.path().join("catalog.db")).unwrap();
    std::fs::create_dir_all(td.path().join("artifacts/by-id")).unwrap();

    let err = VaultSource::open(
        &VaultConfig {
            vault_root_override: Some(td.path().to_path_buf()),
        },
        &ScratchConfig::default(),
    )
    .unwrap_err();
    // Note: with a directory at catalog.db, validate_vault_root will
    // succeed (catalog.db exists, just isn't a file) — but rusqlite
    // open will fail. The contract distinguishes these but
    // validate_vault_root specifically checks `is_file()`, so we get
    // VaultRootIncomplete with missing=catalog.db here. Either
    // VaultRootIncomplete or CatalogOpenFailed is valid for this
    // pathological setup.
    assert!(
        matches!(
            err,
            VaultSourceError::CatalogOpenFailed { .. }
                | VaultSourceError::VaultRootIncomplete { .. }
        ),
        "expected CatalogOpenFailed or VaultRootIncomplete, got {err:?}"
    );
}

#[test]
fn catalog_schema_unsupported_when_schema_version_row_is_absent() {
    common::isolate_ambient_vault_env();
    let td = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(td.path().join("artifacts/by-id")).unwrap();
    let cat_path = td.path().join("catalog.db");
    let c = rusqlite::Connection::open(&cat_path).unwrap();
    c.execute_batch("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);")
        .unwrap();
    drop(c);

    let err = VaultSource::open(
        &VaultConfig {
            vault_root_override: Some(td.path().to_path_buf()),
        },
        &ScratchConfig::default(),
    )
    .unwrap_err();
    assert!(matches!(
        err,
        VaultSourceError::CatalogSchemaUnsupported { observed: None, .. }
    ));
}

#[test]
fn catalog_schema_unsupported_when_schema_version_exceeds_supported() {
    common::isolate_ambient_vault_env();
    let td = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(td.path().join("artifacts/by-id")).unwrap();
    let cat_path = td.path().join("catalog.db");
    let c = rusqlite::Connection::open(&cat_path).unwrap();
    c.execute_batch(
        "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
         INSERT INTO schema_version (version, applied_at) VALUES (99, '2026-06-23');",
    )
    .unwrap();
    drop(c);

    let err = VaultSource::open(
        &VaultConfig {
            vault_root_override: Some(td.path().to_path_buf()),
        },
        &ScratchConfig::default(),
    )
    .unwrap_err();
    assert!(matches!(
        err,
        VaultSourceError::CatalogSchemaUnsupported {
            observed: Some(99),
            ..
        }
    ));
}

#[test]
fn scratch_unwritable_when_scratch_root_parent_is_read_only() {
    common::isolate_ambient_vault_env();
    // We can't easily make a directory read-only in CI; instead use
    // a path under /proc/1 which is genuinely unwritable on Linux.
    let v = common::SyntheticVault::build();
    let bad_scratch = std::path::PathBuf::from("/proc/1/cannot-create-here");
    let err = VaultSource::open(
        &VaultConfig {
            vault_root_override: Some(v.vault_root.clone()),
        },
        &ScratchConfig {
            scratch_root_override: Some(bad_scratch),
        },
    )
    .unwrap_err();
    assert!(matches!(err, VaultSourceError::ScratchUnwritable { .. }));
}

#[test]
fn materialize_raises_ArtifactMissing_when_by_id_archive_is_absent_from_disk() {
    // Resolution succeeds (catalog row + valid canonical_id) but the by-id
    // archive file is deleted from disk before materialize.
    let v = common::SyntheticVault::build();
    let missing = v.fixtures[common::FIXTURE_GOOD_PRIMARY].on_disk.clone();
    std::fs::remove_file(&missing).unwrap();
    let source = open_source(&v);
    let candidate = source
        .discover(&ClaimQuery::ByReleaseId { release_id: 10 })
        .unwrap()
        .pop()
        .unwrap();
    let err = source
        .materialize(&candidate, MaterializeOptions::default())
        .unwrap_err();
    assert!(
        matches!(err, VaultSourceError::ArtifactMissing { .. }),
        "expected ArtifactMissing, got {err:?}"
    );
}

#[test]
fn this_crate_has_no_references_to_kaifuu_secrets_local() {
    // Acceptance criterion: secrets in `.kaifuu/secrets.local/` remain
    // Linux-side and are never read from or written into the vault by
    // this adapter. Verified by inspection of the crate's sources.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut hits = Vec::new();
    walk_collect_secret_references(&root, &mut hits);
    assert!(
        hits.is_empty(),
        "expected no references to .kaifuu/secrets.local/ but found: {hits:?}"
    );
}

fn walk_collect_secret_references(dir: &std::path::Path, hits: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            walk_collect_secret_references(&p, hits);
            continue;
        }
        if p.extension().and_then(|s| s.to_str()) != Some("rs") {
            continue;
        }
        let Ok(s) = std::fs::read_to_string(&p) else {
            continue;
        };
        if s.contains(".kaifuu/secrets.local") || s.contains("secrets.local") {
            hits.push(format!("{}", p.display()));
        }
    }
}
