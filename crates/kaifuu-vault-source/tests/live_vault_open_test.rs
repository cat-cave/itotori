//! Deterministic schema-v3 vault-open proof.
//!
//! The synthetic catalog is promoted from schema v1 to v3 before opening, so
//! this test keeps the observable contract: a supported v3 catalog opens
//! read-only and never raises CatalogSchemaUnsupported.

mod common;

use kaifuu_vault_source::{LocalCorpusSource, ScratchConfig, VaultConfig, VaultSource};

#[test]
fn opens_schema_v3_catalog_without_schema_unsupported() {
    let vault = common::SyntheticVault::build();
    common::isolate_ambient_vault_env();

    let catalog = vault.vault_root.join("catalog.db");
    let connection = rusqlite::Connection::open(&catalog).expect("open synthetic catalog");
    connection
        .execute("UPDATE schema_version SET version = 3", [])
        .expect("promote synthetic catalog to schema v3");
    drop(connection);

    let source = VaultSource::open(
        &VaultConfig {
            vault_root_override: Some(vault.vault_root.clone()),
        },
        &ScratchConfig {
            scratch_root_override: Some(vault.scratch_root.clone()),
        },
    )
    .expect("VaultSource::open must accept schema v3");

    let capabilities = source.capabilities();
    assert_eq!(capabilities.schema_version, 3);
    assert!(capabilities.read_only, "vault adapter is always read-only");
}
