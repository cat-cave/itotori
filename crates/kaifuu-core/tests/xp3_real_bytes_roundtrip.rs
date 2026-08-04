//! Metadata guards for the public plain-XP3 profile-A manifest.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

/// The fixture referenced BY PATH (no node-id token): a metadata-only
/// manifest under `fixtures/public/`. The path is anchored at the
/// `kaifuu-core` crate so the lookup is stable from both `cargo test` and
/// out-of-tree invocations.
const FIXTURE_RELATIVE_PATH: &str = "fixtures/public/kaifuu-xp3-plain-profile-a.manifest.json";

/// The fixture id recorded inside the manifest. Used to fail loudly if the
/// fixture at [`FIXTURE_RELATIVE_PATH`] is somehow swapped for an unrelated
/// one — keeps the real-bytes proof honest.
const EXPECTED_FIXTURE_ID: &str = "kaifuu-xp3-plain-profile-a";

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn fixture_path() -> PathBuf {
    crate_dir().join("../../").join(FIXTURE_RELATIVE_PATH)
}

fn fixture_manifest() -> Value {
    let path = fixture_path();
    let bytes = fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_slice(&bytes)
        .unwrap_or_else(|error| panic!("parse {} as JSON: {error}", path.display()))
}

fn require_source_archive_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        panic!("real-bytes proof not established: required corpus archive is unavailable");
    }
    path
}

#[test]
#[should_panic(
    expected = "real-bytes proof not established: required corpus archive is unavailable"
)]
fn source_archive_path_refuses_a_missing_archive() {
    require_source_archive_path(PathBuf::from(
        "/scratch/corpus/absent-xp3-real-bytes-proof-source.xp3",
    ));
}

#[test]
fn fixture_metadata_records_profile_a_id_and_zlib_index_encoding() {
    // Always-on guard: the committed fixture referenced BY PATH is the
    // metadata-only profile-A manifest. This catches a stale swap (e.g. the
    // fixture path being silently repointed at an unrelated manifest)
    // before the real-corpus case is even attempted.
    let manifest = fixture_manifest();
    assert_eq!(
        manifest["fixture"]["id"].as_str(),
        Some(EXPECTED_FIXTURE_ID),
        "fixture at {FIXTURE_RELATIVE_PATH} must be the profile-A manifest"
    );
    assert_eq!(
        manifest["archive"]["indexEncoding"].as_str(),
        Some("zlib"),
        "profile-A fixture declares a zlib-compressed index encoding"
    );
    assert_eq!(
        manifest["archive"]["inventoryReader"].as_str(),
        Some("read_plain_xp3_inventory"),
        "the manifest records the plain-XP3 reader as its inventory source"
    );
}
