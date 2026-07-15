//! known-key Siglus Scene/Gameexe extract-patch-verify smoke.
//! Drives the committed fixture profile end-to-end through the REAL narrow
//! known-key implementation: extract profiled Scene/Gameexe text + metadata,
//! apply + verify a trivial translated patch, and confirm the out-of-profile
//! (proprietary-LZSS) case is a typed not-implemented — never a silent pass.
//! Fixture provenance: the committed profile uses `synthetic-stub` container
//! sources, so this smoke needs NO retail bytes. It is a *profiled synthetic*
//! case (noted honestly): the containers are materialised in-process from
//! clearly-fake in-module constants, masked with a clearly-fake known key. The
//! real `Scene.pck`/`Gameexe.dat` decrypt + LZSS stack stays a skeleton stub.

use std::path::PathBuf;

use kaifuu_core::{
    HelperRedactionStatus, KeyMaterialKind, KeyValidationMethod, OperationStatus, read_json,
    sha256_hash_bytes,
};
use kaifuu_siglus::{
    SiglusKnownKeyCompression, SiglusKnownKeyEncoding, SiglusKnownKeySmokeFixture,
    run_known_key_smoke_from_fixture,
};

/// Resolve this crate's manifest directory for locating tracked test fixtures.
/// `env!("CARGO_MANIFEST_DIR")` is baked at COMPILE time, so a test binary
/// reused from a different (since-removed) worktree would point fixture reads at
/// a dead path (`Os NotFound`). `cargo test` sets `CARGO_MANIFEST_DIR` in the
/// RUNTIME environment to the LIVE crate directory; prefer that, falling back to
/// the compile-time constant only outside cargo.
fn test_manifest_dir() -> PathBuf {
    std::env::var_os("CARGO_MANIFEST_DIR")
        .map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from)
}

fn fixtures_dir() -> PathBuf {
    test_manifest_dir().join("../../fixtures/kaifuu/siglus")
}

fn load_fixture() -> SiglusKnownKeySmokeFixture {
    read_json(&fixtures_dir().join("siglus-knownkey-smoke.json"))
        .expect("known-key smoke fixture must parse")
}

#[test]
fn known_key_smoke_extracts_patches_verifies_and_reports() {
    let fixture = load_fixture();
    let report = run_known_key_smoke_from_fixture(&fixture, &fixtures_dir())
        .expect("known-key smoke runs against the fixture profile");

    // Overall: green, and HONESTLY narrow (not broad Siglus support).
    assert_eq!(report.status, OperationStatus::Passed);
    assert_eq!(report.source_node_id, "KAIFUU-070");
    assert!(!report.capability.broad_siglus_support);
    assert!(!report.capability.shells_out);
    assert_eq!(report.capability.encoding, SiglusKnownKeyEncoding::Utf16Le);
    assert_eq!(
        report.capability.in_profile_compression,
        SiglusKnownKeyCompression::Uncompressed
    );

    // (1) Extraction smoke: Scene + Gameexe text + metadata recovered.
    assert_eq!(report.scene.unit_count, 3);
    assert_eq!(
        report.scene.units[0].source_unit_key,
        "siglus:scene-0001#0000"
    );
    assert_eq!(report.gameexe.entry_count, 3);

    // (2) Trivial patch round-trip verified, other units preserved.
    assert!(report.patch.verified);
    assert!(report.patch.other_units_preserved);
    assert_eq!(
        report.patch.proof.method,
        KeyValidationMethod::FixtureRoundTripProof
    );

    // (3) Out-of-profile is a typed not-implemented, not a silent pass.
    assert!(report.out_of_profile.typed_not_implemented);
    assert_eq!(report.out_of_profile.attempted_compression, "lzss");
    assert!(
        report
            .out_of_profile
            .diagnostic_code
            .contains("out_of_profile_compression_not_implemented")
    );

    // (4) Redaction: the key is disclosed only as a ref + one-way commitment.
    assert_eq!(report.redaction_status, HelperRedactionStatus::Redacted);
    assert_eq!(report.key_material_kind, KeyMaterialKind::FixedBytes);
    assert_eq!(report.key_bytes, 16);
    assert_eq!(
        report.secret_ref.as_str(),
        "local-secret:siglus-secondary-key"
    );
}

#[test]
fn known_key_smoke_report_never_leaks_raw_key_or_text() {
    let fixture = load_fixture();
    let report = run_known_key_smoke_from_fixture(&fixture, &fixtures_dir()).unwrap();
    let json = report.stable_json().expect("stable redacted json");

    // No raw key bytes (the fixture key is the clearly-fake constant).
    assert!(!json.contains("KSIG-SMOKE-KEY01"), "raw key leaked");
    // No extracted or translated text — only sha256 commitments.
    assert!(
        !json.contains("[synthetic-siglus-dialogue-unit-1]"),
        "scene text leaked"
    );
    assert!(
        !json.contains("[synthetic-translation-EN-0]"),
        "translated text leaked"
    );

    // The report DOES carry the one-way commitment + secret-ref.
    assert!(json.contains(&sha256_hash_bytes(b"KSIG-SMOKE-KEY01")));
    assert!(json.contains("local-secret:siglus-secondary-key"));
}
