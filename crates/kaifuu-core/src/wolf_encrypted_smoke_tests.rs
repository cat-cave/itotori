use super::*;

fn fixture() -> WolfEncryptedSmokeFixture {
    WolfEncryptedSmokeFixture::synthetic()
}

#[test]
fn synthetic_archive_is_encrypted_not_plaintext() {
    let archive = build_synthetic_wolf_encrypted_archive();
    for (_, text) in FIXTURE_MEMBERS {
        assert!(
            !archive
                .windows(text.len())
                .any(|window| window == text.as_bytes()),
            "synthetic plaintext leaked into encrypted archive"
        );
    }
}

#[test]
fn full_smoke_decrypts_extracts_patches_reencrypts_and_verifies() {
    let report = run_wolf_encrypted_smoke_from_fixture(&fixture(), Path::new("."))
        .expect("Wolf encrypted smoke runs");
    assert_eq!(report.status, OperationStatus::Passed);
    let stages: Vec<WolfEncryptedSmokeStage> =
        report.stages.iter().map(|stage| stage.stage).collect();
    assert_eq!(stages, WolfEncryptedSmokeStage::ordered().to_vec());
    assert_eq!(report.extract_manifest.len(), FIXTURE_MEMBERS.len());
    assert!(report.patch_proof.patched_text_verified);
    assert_eq!(report.patch_proof.unchanged_members_verified, 1);
    assert_ne!(
        report.source_archive_hash.as_str(),
        report.rebuilt_archive_hash.as_str()
    );
    assert_eq!(
        report.secret_ref.as_str(),
        WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF
    );
    assert_eq!(report.key_bytes, SYNTHETIC_FIXTURE_KEY.len() as u32);
}

#[test]
fn rebuilt_archive_decrypts_to_the_patched_text() {
    let resolver = WolfEncryptedFixtureSecretResolver::fixture_default();
    let key = resolver
        .resolve(
            WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID,
            &SecretRef::new(WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF).unwrap(),
        )
        .expect("fixture key resolves");
    let source = build_synthetic_wolf_encrypted_archive();
    let extracted = decrypt_archive_members(&source, key).expect("source decrypts");
    let patched = apply_trivial_patch(&extracted).expect("patch applies");
    let rebuilt = pack_encrypted_archive(&patched, key).expect("repack succeeds");
    let verified = decrypt_archive_members(&rebuilt, key).expect("rebuilt decrypts");
    let patched_member = verified
        .iter()
        .find(|member| member.member_id == PATCH_MEMBER_ID)
        .expect("patched member exists");
    let patched_text = std::str::from_utf8(&patched_member.plaintext).unwrap();
    assert!(patched_text.contains(PATCH_REPLACE));
    assert!(!patched_text.contains(PATCH_FIND));
}

#[test]
fn missing_secret_ref_is_typed_and_ref_only() {
    let mut fixture = fixture();
    fixture.secret_ref = SecretRef::new(WOLF_ENCRYPTED_SMOKE_MISSING_SECRET_REF).unwrap();
    let err = run_wolf_encrypted_smoke_from_fixture(&fixture, Path::new("."))
        .expect_err("missing key must fail");
    assert!(matches!(err, WolfEncryptedSmokeError::MissingSecret { .. }));
    assert!(err.to_string().starts_with(WOLF_ENCRYPTED_SMOKE_MARKER));
    assert!(!err.to_string().contains("K073-WOLF-FIXTURE"));
}

#[test]
fn report_is_redaction_clean_and_no_raw_key_or_plaintext_leaks() {
    let report =
        run_wolf_encrypted_smoke_from_fixture(&fixture(), Path::new(".")).expect("smoke runs");
    let json = report.stable_json().expect("stable json");
    assert!(json.contains(WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF));
    assert!(!json.contains("K073-WOLF-FIXTURE"));
    assert!(!json.contains(PATCH_FIND));
    assert!(!json.contains(PATCH_REPLACE));
    for (_, text) in FIXTURE_MEMBERS {
        assert!(!json.contains(text));
    }
    assert!(!json.contains("/scratch/"));
    assert!(!json.contains("/home/"));
}

#[test]
fn key_debug_is_redacted() {
    let secret_ref = SecretRef::new(WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF).unwrap();
    let key = wolf_key_from_secret_ref_entry(&secret_ref, SYNTHETIC_FIXTURE_KEY.to_vec());
    let debug = format!("{key:?}");
    assert!(debug.contains("[REDACTED:kaifuu.secret_redacted]"));
    assert!(!debug.contains("K073-WOLF-FIXTURE"));
}

#[test]
fn from_entries_is_module_private_fixture_construction_path() {
    // The raw-entry constructor is module-private: it mints synthetic
    // fixture bytes into the shared zeroize-on-drop holder and hands keys
    // back BY REF. Crate-visible callers must bind refs to existing holders
    // through `from_key_refs`.
    let secret_ref = WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF.to_string();
    let raw = b"synthetic-controlled-entry-key".to_vec();
    let resolver =
        WolfEncryptedFixtureSecretResolver::from_entries(vec![(secret_ref, raw.clone())]);

    let key = resolver
        .resolve(
            WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID,
            &SecretRef::new(WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF).unwrap(),
        )
        .expect("controlled-entry key resolves by ref");
    // The holder carries exactly the bytes it was minted from...
    assert_eq!(key.byte_len(), raw.len());
    assert!(key.appears_in(&raw));
    // ...and the resolver's no-leak helper sees the raw material only for the
    // guard, never copying it out.
    assert!(resolver.any_key_appears_in(&raw));
    // Debug never reveals the raw bytes.
    assert!(format!("{resolver:?}").contains("[REDACTED:kaifuu.secret_redacted]"));
}

#[test]
fn resolver_holds_key_ref_only_and_never_emits_raw_bytes() {
    // The resolver now stores the key material inside a zeroize-on-drop
    // holder, so even its own `Debug` must not leak the raw bytes.
    let resolver = WolfEncryptedFixtureSecretResolver::fixture_default();
    let debug = format!("{resolver:?}");
    assert!(debug.contains("[REDACTED:kaifuu.secret_redacted]"));
    assert!(!debug.contains("K073-WOLF-FIXTURE"));

    // Resolution returns a borrow of the held key; the raw bytes are never
    // copied out or serialized. The no-leak guard proves the material does
    // not appear in the emitted report.
    let key = resolver
        .resolve(
            WOLF_ENCRYPTED_SMOKE_REQUIREMENT_ID,
            &SecretRef::new(WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF).unwrap(),
        )
        .expect("fixture key resolves");
    let report =
        run_wolf_encrypted_smoke_from_fixture(&fixture(), Path::new(".")).expect("smoke runs");
    let json = report.stable_json().expect("stable json");
    assert!(!key.appears_in(json.as_bytes()));
    assert!(!json.contains("K073-WOLF-FIXTURE"));
}
