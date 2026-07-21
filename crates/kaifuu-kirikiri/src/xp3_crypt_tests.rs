use super::*;

fn synthetic_fixture() -> Xp3CryptFixture {
    Xp3CryptFixture {
        schema_version: XP3_CRYPT_SCHEMA_VERSION.to_string(),
        fixture_id: "kirikiri-xp3-crypt-smoke-fixture".to_string(),
        source_node_id: "xp3-crypt-smoke".to_string(),
        engine_family: XP3_CRYPT_ENGINE_FAMILY.to_string(),
        container: XP3_CRYPT_CONTAINER.to_string(),
        crypto_profile: Xp3CryptoProfile::XorSimpleCryptFixture,
        codec: CodecTransform::ShiftJisText,
        surface: KirikiriXp3Surface::ScenarioScript,
        secret_requirement_id: XP3_CRYPT_REQUIREMENT_ID.to_string(),
        secret_ref: SecretRef::new(XP3_CRYPT_VALID_SECRET_REF).unwrap(),
        container_source: Xp3CryptContainerSource::SyntheticStub,
        expected_member_ids: vec![
            "scenario/intro.ks".to_string(),
            "system/config.txt".to_string(),
        ],
    }
}

#[test]
fn synthetic_crypt_xp3_payload_is_not_plaintext() {
    // The committed/produced container must carry ciphertext, not the
    // authored plaintext (proves it is genuinely enciphered).
    let container = build_synthetic_crypt_xp3();
    for (_, text) in FIXTURE_MEMBERS {
        assert!(
            !windows_contains(&container, text.as_bytes()),
            "member plaintext leaked into the encrypted container"
        );
    }
}

#[test]
fn filter_is_its_own_inverse() {
    let secret_ref = SecretRef::new(XP3_CRYPT_VALID_SECRET_REF).unwrap();
    let key = module_private_fixture_secret_holder(&secret_ref, SYNTHETIC_FIXTURE_KEY.to_vec());
    let plaintext = b"the quick brown fox\x00\x01\xff";
    for profile in [
        Xp3CryptoProfile::XorSimpleCryptFixture,
        Xp3CryptoProfile::XorPositionCryptFixture,
    ] {
        let scheme = profile.scheme();
        let cipher = key.apply_filter(scheme, plaintext);
        assert_ne!(cipher, plaintext);
        assert_eq!(key.apply_filter(scheme, &cipher), plaintext);
    }
}

#[test]
fn distinct_profiles_produce_distinct_ciphertext() {
    // Two profiled crypt schemes, same key → different ciphertext. Proves the
    // scheme is genuinely data-driven, not a single hard-coded transform.
    let secret_ref = SecretRef::new(XP3_CRYPT_VALID_SECRET_REF).unwrap();
    let key = module_private_fixture_secret_holder(&secret_ref, SYNTHETIC_FIXTURE_KEY.to_vec());
    let plaintext = b"synthetic-kirikiri-profiled-crypt-sample-0123456789";
    let simple = key.apply_filter(Xp3CryptoProfile::XorSimpleCryptFixture.scheme(), plaintext);
    let position = key.apply_filter(
        Xp3CryptoProfile::XorPositionCryptFixture.scheme(),
        plaintext,
    );
    assert_ne!(simple, position);
}

#[test]
fn valid_secret_ref_decrypts_and_extracts() {
    let fixture = synthetic_fixture();
    let report = run_xp3_crypt_smoke_from_fixture(&fixture, Path::new(".")).expect("smoke runs");
    assert_eq!(report.status, OperationStatus::Passed);
    assert_eq!(report.manifest.len(), FIXTURE_MEMBERS.len());
    assert_eq!(report.manifest[0].member_id, "scenario/intro.ks");
    // The manifest is hash-based: byte length + hash + adler, no text.
    assert_eq!(
        report.manifest[0].plaintext_byte_len as usize,
        FIXTURE_MEMBERS[0].1.len()
    );
    assert_eq!(
        report.manifest[0].plaintext_hash.as_str(),
        sha256_hash_bytes(FIXTURE_MEMBERS[0].1.as_bytes())
    );
}

#[test]
fn wrong_secret_ref_is_typed_integrity_failure() {
    let container = build_synthetic_crypt_xp3();
    let resolver = FixtureSecretResolver::fixture_default();
    let wrong_ref = SecretRef::new(XP3_CRYPT_WRONG_SECRET_REF).unwrap();
    let wrong_key = resolver
        .resolve(XP3_CRYPT_REQUIREMENT_ID, &wrong_ref)
        .expect("wrong ref resolves to (wrong) material");
    let err = decrypt_and_extract(
        &container,
        wrong_key,
        Xp3CryptoProfile::XorSimpleCryptFixture.scheme(),
    )
    .expect_err("wrong key must fail integrity, not silently pass");
    assert!(matches!(err, Xp3CryptError::IntegrityCheckFailed { .. }));
    assert!(err.to_string().starts_with(XP3_CRYPT_MARKER));
}

#[test]
fn missing_secret_ref_is_typed_resolution_failure() {
    let resolver = FixtureSecretResolver::fixture_default();
    let missing_ref = SecretRef::new(XP3_CRYPT_MISSING_SECRET_REF).unwrap();
    let err = resolver
        .resolve(XP3_CRYPT_REQUIREMENT_ID, &missing_ref)
        .expect_err("unknown ref must be a typed error, not a panic/skip");
    match err {
        Xp3CryptError::MissingSecret { requirement_id, .. } => {
            assert_eq!(requirement_id, XP3_CRYPT_REQUIREMENT_ID);
        }
        other => panic!("expected MissingSecret, got {other}"),
    }
}

#[test]
fn report_carries_no_raw_key_and_no_plaintext() {
    let fixture = synthetic_fixture();
    let report = run_xp3_crypt_smoke_from_fixture(&fixture, Path::new(".")).expect("smoke runs");
    assert!(report.wrong_key.typed_error);
    assert!(report.missing_key.typed_error);

    let json = report.stable_json().expect("stable json");
    // Raw key material never appears (correct or wrong).
    assert!(!json.contains(&String::from_utf8_lossy(SYNTHETIC_FIXTURE_KEY).into_owned()));
    assert!(!json.contains(&String::from_utf8_lossy(SYNTHETIC_WRONG_KEY).into_owned()));
    // Decrypted plaintext never appears — only its hash.
    for (_, text) in FIXTURE_MEMBERS {
        assert!(!json.contains(text));
    }
    // The requirement id + secret ref (safe) are disclosed; the key bytes
    // are not — only the length + one-way hash.
    assert_eq!(report.key_bytes as usize, SYNTHETIC_FIXTURE_KEY.len());
    assert_eq!(
        report.key_material_hash.as_str(),
        sha256_hash_bytes(SYNTHETIC_FIXTURE_KEY)
    );
}

#[test]
fn key_is_redacted_and_zeroized_in_debug() {
    let secret_ref = SecretRef::new(XP3_CRYPT_VALID_SECRET_REF).unwrap();
    let key = module_private_fixture_secret_holder(&secret_ref, SYNTHETIC_FIXTURE_KEY.to_vec());
    let rendered = format!("{key:?}");
    assert!(rendered.contains("REDACTED"));
    assert!(!rendered.contains(&String::from_utf8_lossy(SYNTHETIC_FIXTURE_KEY).into_owned()));
}

#[test]
fn resolver_debug_never_emits_raw_key_bytes() {
    // P1(b): FixtureSecretResolver stores each key inside the zeroize-on-drop
    // Xp3CryptKey holder and has a manual redacting Debug. `format!("{:?}")`
    // (and pretty `{:#?}`) must never render either the correct or the wrong
    // fixture key, while the (safe) secret refs are still shown.
    let resolver = FixtureSecretResolver::fixture_default();
    for rendered in [format!("{resolver:?}"), format!("{resolver:#?}")] {
        assert!(
            !rendered.contains(&String::from_utf8_lossy(SYNTHETIC_FIXTURE_KEY).into_owned()),
            "resolver Debug leaked the correct key"
        );
        assert!(
            !rendered.contains(&String::from_utf8_lossy(SYNTHETIC_WRONG_KEY).into_owned()),
            "resolver Debug leaked the wrong key"
        );
        assert!(
            rendered.contains("REDACTED"),
            "resolver Debug should mark redaction"
        );
        // The reportable secret refs are safe to disclose.
        assert!(rendered.contains(XP3_CRYPT_VALID_SECRET_REF));
    }
}

#[test]
fn no_leak_probe_detects_raw_hex_and_base64_key_encodings() {
    // Sanity: the shared `appears_in` probe backs the runtime guards. It
    // must refuse a key that reaches JSON as raw bytes, hex (either case),
    // or base64 (padded or unpadded), not only as a raw byte window.
    let secret_ref = SecretRef::new(XP3_CRYPT_VALID_SECRET_REF).unwrap();
    let key = module_private_fixture_secret_holder(&secret_ref, SYNTHETIC_FIXTURE_KEY.to_vec());
    for (encoding, haystack) in [
        ("raw", b"prefix K100-XP3-XORKEY1 suffix".as_slice()),
        (
            "lowercase hex",
            b"prefix 4b3130302d5850332d584f524b455931 suffix".as_slice(),
        ),
        (
            "uppercase hex",
            b"prefix 4B3130302D5850332D584F524B455931 suffix".as_slice(),
        ),
        (
            "padded base64",
            b"prefix SzEwMC1YUDMtWE9SS0VZMQ== suffix".as_slice(),
        ),
        (
            "unpadded base64",
            b"prefix SzEwMC1YUDMtWE9SS0VZMQ suffix".as_slice(),
        ),
    ] {
        assert!(
            key.appears_in(haystack),
            "{encoding} key encoding escaped the probe"
        );
    }

    let base64_variant_key = module_private_fixture_secret_holder(&secret_ref, b"\xff".to_vec());
    for (encoding, haystack) in [
        ("URL-safe padded base64", b"prefix _w== suffix".as_slice()),
        ("URL-safe unpadded base64", b"prefix _w suffix".as_slice()),
    ] {
        assert!(
            base64_variant_key.appears_in(haystack),
            "{encoding} key encoding escaped the probe"
        );
    }
    assert!(!key.appears_in(b"no key here"));
}

fn windows_contains(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || needle.len() > haystack.len() {
        return false;
    }
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}
