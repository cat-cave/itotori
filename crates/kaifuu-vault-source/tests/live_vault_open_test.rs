//! Live v3 vault open proof.
//! This test opens the *real* read-only `/archive/vault/catalog.db`, which is
//! `schema_version = 3`. It is `#[ignore]`d by default and only meaningful
//! when `ITOTORI_VAULT_ROOT=/archive/vault` is set, because the live vault is
//! not available in ordinary CI. Run it explicitly with:
//! ```text
//! ITOTORI_VAULT_ROOT=/archive/vault \
//! cargo test -p kaifuu-vault-source \
//! --test live_vault_open_test -- --ignored --nocapture
//! It is strictly read-only: it never writes under the vault root. A scratch
//! override points at a throwaway tempdir so `VaultSource::open`'s
//! scratch-writability probe cannot touch `/archive` or the platform default.

use kaifuu_vault_source::{LocalCorpusSource, ScratchConfig, VaultConfig, VaultSource};

/// `VaultSource::open` must succeed against the live v3 catalog — i.e. it must
/// not fail with `CatalogSchemaUnsupported` (the failure this node fixes).
#[test]
#[ignore = "requires ITOTORI_VAULT_ROOT=/archive/vault (live read-only vault)"]
fn opens_live_v3_catalog_without_schema_unsupported() {
    let vault_root = std::env::var("ITOTORI_VAULT_ROOT")
        .expect("set ITOTORI_VAULT_ROOT=/archive/vault to run this proof");
    assert_eq!(
        vault_root, "/archive/vault",
        "this proof targets the live read-only vault root"
    );

    // Throwaway scratch so the open probe never writes under the vault.
    let scratch = tempfile::tempdir().expect("tempdir for scratch override");

    // VaultConfig resolves the vault root from ITOTORI_VAULT_ROOT.
    let vault_cfg = VaultConfig::default();
    let scratch_cfg = ScratchConfig {
        scratch_root_override: Some(scratch.path().to_path_buf()),
    };

    let source = VaultSource::open(&vault_cfg, &scratch_cfg)
        .expect("VaultSource::open must succeed on the live v3 vault");

    // Confirm we actually observed schema v3 (not, say, a stale v1 copy).
    let caps = source.capabilities();
    assert_eq!(
        caps.schema_version, 3,
        "live /archive/vault/catalog.db is expected to be schema v3"
    );
    assert!(caps.read_only, "vault adapter is always read-only");
}
