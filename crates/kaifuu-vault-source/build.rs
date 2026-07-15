//! Build script for the synthetic-vault fixture.
//! Materializes `tests/fixtures/synthetic-vault/catalog.db` from
//! `tests/fixtures/synthetic-vault/seed.sql` so the fixture is reviewable
//! (seed is text + diff-able) but tests still see a real `.db` file.

use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let fixture_root = manifest.join("tests/fixtures/synthetic-vault");
    let seed = fixture_root.join("seed.sql");
    let catalog = fixture_root.join("catalog.db");

    println!("cargo:rerun-if-changed={}", seed.display());

    // Even if `seed.sql` is absent (e.g. clean clone before tests land),
    // do nothing — tests that rely on it will surface the absence directly.
    if !seed.exists() {
        return;
    }

    // Always rebuild the catalog from scratch so tests see a deterministic
    // file state.
    let _ = std::fs::remove_file(&catalog);

    let sql = std::fs::read_to_string(&seed).expect("read seed.sql");
    let conn = rusqlite::Connection::open(&catalog).expect("open catalog.db");
    conn.execute_batch(&sql).expect("apply seed.sql");
    drop(conn);
}
