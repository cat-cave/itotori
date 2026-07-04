//! KAIFUU-105 — on-disk claimed-support tuple fixtures validate at their
//! HONEST levels, and the schema round-trips from disk.
//!
//! The committed fixtures live under `fixtures/kaifuu/compat-profile/`; each is
//! a synthetic, redacted, ref-only claimed-support tuple (no retail bytes, no
//! raw secrets). The Siglus fixture is honest at `extract` (known-key), the
//! KAG fixture is honest at `patch` (plaintext, loose-file), and the overclaim
//! fixture (patch without evidence) MUST fail the anti-overclaim gate.

use std::path::{Path, PathBuf};

use kaifuu_core::OperationStatus;
use kaifuu_core::compat_profile::{
    ClaimedSupportLevel, ClaimedSupportTuple, CompatEngineFamily, validate_claimed_support_tuple,
};

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("fixtures/kaifuu/compat-profile")
}

fn load(name: &str) -> ClaimedSupportTuple {
    kaifuu_core::read_json(&fixtures_dir().join(name)).expect("fixture parses against the schema")
}

#[test]
fn siglus_fixture_is_honest_at_extract() {
    let tuple = load("siglus.extract.tuple.json");
    assert_eq!(tuple.engine_family, CompatEngineFamily::Siglus);
    assert_eq!(tuple.claimed_level, ClaimedSupportLevel::Extract);
    let entry = validate_claimed_support_tuple(&tuple);
    assert_eq!(entry.status, OperationStatus::Passed);
    assert!(!entry.claimed_level.claims_patch_back());
    assert_eq!(entry.secret_requirement_ids.len(), 1);
}

#[test]
fn kag_fixture_is_honest_at_patch_loose_file() {
    let tuple = load("kirikiri-kag.patch.tuple.json");
    assert_eq!(
        tuple.engine_family,
        CompatEngineFamily::KirikiriKagPlaintext
    );
    assert_eq!(tuple.claimed_level, ClaimedSupportLevel::Patch);
    let entry = validate_claimed_support_tuple(&tuple);
    assert_eq!(entry.status, OperationStatus::Passed);
    assert!(entry.claimed_level.claims_patch_back());
}

#[test]
fn overclaim_fixture_fails_anti_overclaim_gate() {
    let tuple = load("siglus.overclaim-patch.tuple.json");
    let entry = validate_claimed_support_tuple(&tuple);
    assert_eq!(entry.status, OperationStatus::Failed);
}
