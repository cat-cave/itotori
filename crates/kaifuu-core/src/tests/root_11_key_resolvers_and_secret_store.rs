#[test]
fn source_asset_bytes_are_hashed_without_normalization() {
    // The `sourceAsset` scope declares `normalization: "bytes"`, and no
    // scope may blindly normalize raw bytes. Composed vs decomposed UTF-8
    // hash DIFFERENTLY (no NFC folding), and binary payloads containing
    // byte sequences that are not even valid UTF-8 hash by raw bytes.
    let composed = "caf\u{00e9}".as_bytes();
    let decomposed = "cafe\u{0301}".as_bytes();
    assert_ne!(composed, decomposed);
    assert_ne!(
        sha256_hash_bytes(composed),
        sha256_hash_bytes(decomposed),
        "bytes-scope hashing must not NFC-fold composed/decomposed forms"
    );

    // A decomposed voiced-kana metadata string, hashed as raw bytes, is
    // stable and NOT folded onto its composed counterpart.
    let decomposed_kana = "\u{304b}\u{3099}".as_bytes(); // か + U+3099
    let composed_kana = "\u{304c}".as_bytes(); // が
    assert_ne!(
        sha256_hash_bytes(decomposed_kana),
        sha256_hash_bytes(composed_kana)
    );

    // Raw binary (invalid UTF-8) asset bytes hash by their exact bytes.
    let binary_asset: &[u8] = &[0x00, 0xff, 0x81, 0x9f, 0xe3, 0x82];
    assert_eq!(
        sha256_hash_bytes(binary_asset),
        sha256_hash_bytes(&[0x00, 0xff, 0x81, 0x9f, 0xe3, 0x82]),
        "raw asset bytes hash deterministically with no normalization step"
    );
}

#[test]
fn helper_result_value_validation_requires_contract_arrays() {
    for missing_field in ["secretRefs", "proofHashes"] {
        let mut value = public_helper_result_fixture_value("unsupported-protected-executable");
        value.as_object_mut().unwrap().remove(missing_field);

        let validation = validate_helper_result_value(&value);

        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation.failures.iter().any(|failure| {
                failure.fixture_id.as_deref()
                    == Some("kaifuu-helper-unsupported-protected-executable")
                    && failure.code == "missing_required_field"
                    && failure.field == missing_field
            }),
            "missing required-array failure for {missing_field}: {:#?}",
            validation.failures
        );
    }
}

#[test]
fn helper_result_invalid_secret_ref_fixtures_name_field_and_redact_values() {
    for fixture in [
        "absolute-path-secret-ref",
        "traversal-secret-ref",
        "raw-base64-secret-ref",
        "raw-base64url-path-component-secret-ref",
        "raw-hex-secret-ref",
    ] {
        let value = invalid_public_helper_result_fixture_value(fixture);
        let fixture_id = value["fixtureId"].as_str().unwrap().to_string();

        let validation = validate_helper_result_value(&value).redacted_for_report();

        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation.failures.iter().any(|failure| {
                failure.fixture_id.as_deref() == Some(fixture_id.as_str())
                    && failure.code == "invalid_secret_ref"
                    && failure.field == "secretRefs.0.secretRef"
            }),
            "missing invalid secretRef failure for {fixture}: {:#?}",
            validation.failures
        );
        let serialized = serde_json::to_string(&validation).unwrap();
        assert!(!serialized.contains("/home/dev"));
        assert!(!serialized.contains("private/key.bin"));
        assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
        assert!(!serialized.contains("mP9xZpQ2rS7vLj4N8aW_KtYd0hF3uC6b"));
        assert!(serialized.contains(&fixture_id));
        assert!(serialized.contains("secretRefs.0.secretRef"));
    }
}

#[test]
fn helper_result_validation_names_field_and_fixture_id_without_raw_material() {
    let mut value = public_helper_result_fixture_value("success");
    value["diagnostic"]["message"] =
        serde_json::json!("helper output referenced path=/home/dev/private/key.bin");
    value["secretRefs"][0]["secretRef"] =
        serde_json::json!("local-secret:/home/dev/private/key.bin");
    value["proofHashes"][0]["proofHash"] = serde_json::json!("sha256:NOT-LOWER-HEX");

    let validation = validate_helper_result_value(&value).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    for field in [
        "diagnostic.message",
        "secretRefs.0.secretRef",
        "proofHashes.0.proofHash",
    ] {
        assert!(
            validation.failures.iter().any(|failure| {
                failure.fixture_id.as_deref() == Some("kaifuu-helper-success")
                    && failure.field == field
            }),
            "missing helper result validation failure for {field}: {:#?}",
            validation.failures
        );
    }
    let serialized = serde_json::to_string(&validation).unwrap();
    assert!(!serialized.contains("/home/dev"));
    assert!(!serialized.contains("key.bin"));
    assert!(serialized.contains("kaifuu-helper-success"));
    assert!(serialized.contains("secretRefs.0.secretRef"));
}

#[test]
fn profile_validation_accepts_key_profile_secret_refs_and_proofs() {
    let profile = valid_key_profile_value();

    let validation = validate_profile_value(&profile);

    assert_eq!(validation.status, OperationStatus::Passed);
    let profile: GameProfile = serde_json::from_value(profile).unwrap();
    assert_eq!(profile.key_requirements.len(), 1);
    assert_eq!(
        profile.key_requirements[0].secret_ref.as_str(),
        "local-secret:siglus/example/secondary-key"
    );
    assert_eq!(
        profile.helper_evidence.unwrap().redacted_log_hash.as_str(),
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    );
}

#[test]
fn local_key_resolver_returns_fixture_bytes_and_redacted_proofs() {
    let mut profile_value = valid_key_profile_value();
    profile_value["keyRequirements"][0]["secretRef"] =
        serde_json::json!("local-secret:fixture/siglus/secondary-key");
    let profile: GameProfile = serde_json::from_value(profile_value).unwrap();
    let resolver = LocalKeyResolver::new(InMemoryLocalSecretStore::fixture_ci())
        .with_policy(KeyResolverPolicy::allow_prefixes(["fixture/"]));

    let resolved = resolver.resolve_profile(&profile).unwrap();

    assert_eq!(
        resolved.get_bytes("siglus-secondary-key").unwrap(),
        (0_u8..16).collect::<Vec<_>>().as_slice()
    );
    assert_eq!(resolved.proof_records().len(), 1);
    let proof = &resolved.proof_records()[0];
    assert_eq!(proof.requirement_id, "siglus-secondary-key");
    assert_eq!(proof.secret_ref_scheme, SecretRefScheme::LocalSecret);
    assert_eq!(proof.material_kind, KeyMaterialKind::FixedBytes);
    assert_eq!(proof.byte_length, 16);
    assert_eq!(proof.readiness_status, KeyResolutionStatus::Resolved);
    assert_eq!(
        proof.validation_method,
        Some(KeyValidationMethod::DecryptHeaderProof)
    );
    assert_eq!(
        proof.proof_hash.as_ref().unwrap().as_str(),
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
    assert_eq!(
        proof.helper_tool_version.as_deref(),
        Some("kaifuu-key-helper/0.1.0")
    );

    let debug = format!("{resolved:?}");
    assert!(!debug.contains("00112233445566778899aabbccddeeff"));
    assert!(!debug.contains("fixture/siglus/secondary-key"));
    let report = serde_json::to_string(&resolved.redacted_proof_records()).unwrap();
    assert!(!report.contains("fixture/siglus/secondary-key"));
}

#[test]
fn local_key_resolver_decodes_public_fixture_hex_keys_for_adapters() {
    let resolver = LocalKeyResolver::new(InMemoryLocalSecretStore::fixture_ci())
        .with_policy(KeyResolverPolicy::allow_prefixes(["fixture/"]));

    let material = resolver
        .resolve_secret_ref_str(
            "rpg-maker-asset-key",
            "local-secret:fixture/rpg-maker/asset-key",
            KeyMaterialKind::RpgMakerAssetKey,
            Some(16),
        )
        .unwrap();

    assert_eq!(
        material.as_bytes(),
        &[
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
            0xee, 0xff
        ]
    );
}

#[test]
fn local_key_resolver_debug_and_diagnostics_do_not_leak_raw_material() {
    let raw_secret = "fixture-password-material";
    let resolver = LocalKeyResolver::new(
        InMemoryLocalSecretStore::new()
            .with_secret("fixture/password", raw_secret.as_bytes().to_vec()),
    );

    let material = resolver
        .resolve_secret_ref_str(
            "archive-password",
            "local-secret:fixture/password",
            KeyMaterialKind::ArchivePassword,
            None,
        )
        .unwrap();

    assert_eq!(material.as_bytes(), raw_secret.as_bytes());
    assert!(!format!("{material:?}").contains(raw_secret));
    let store = InMemoryLocalSecretStore::new()
        .with_secret("fixture/password", raw_secret.as_bytes().to_vec());
    assert!(!format!("{store:?}").contains(raw_secret));
    let policy = KeyResolverPolicy::allow_prefixes(["private/customer/account"]);
    assert!(!format!("{policy:?}").contains("customer"));
    assert!(!format!("{resolver:?}").contains(raw_secret));
    assert!(
        !format!(
            "{:?}",
            LocalSecretDirectoryStore::new("/home/dev/private/secrets.local")
        )
        .contains("/home/dev/private")
    );
}

#[test]
fn local_key_resolver_reports_missing_malformed_policy_helper_and_material_errors() {
    let empty_resolver = LocalKeyResolver::new(InMemoryLocalSecretStore::new());
    let missing = empty_resolver.resolve_profile(
        &serde_json::from_value::<GameProfile>(valid_key_profile_value()).unwrap(),
    );
    let missing_error = missing.unwrap_err();
    assert!(matches!(
        missing_error.kind(),
        KeyResolverErrorKind::MissingSecret
    ));
    assert_eq!(
        missing_error.semantic_code(),
        SemanticErrorCode::MissingKeyMaterial
    );

    let malformed = empty_resolver.resolve_secret_ref_str(
        "bad-key",
        "local-secret:00112233445566778899aabbccddeeff",
        KeyMaterialKind::FixedBytes,
        Some(16),
    );
    let malformed_error = malformed.unwrap_err();
    assert_eq!(malformed_error.kind(), KeyResolverErrorKind::MalformedRef);
    assert_eq!(
        malformed_error.semantic_code(),
        SemanticErrorCode::MalformedSecretRef
    );
    assert!(!format!("{malformed_error:?}").contains("00112233445566778899aabbccddeeff"));

    let mut policy_profile = valid_key_profile_value();
    policy_profile["keyRequirements"][0]["secretRef"] =
        serde_json::json!("local-secret:private/siglus/secondary-key");
    let policy_profile: GameProfile = serde_json::from_value(policy_profile).unwrap();
    let policy_resolver = LocalKeyResolver::new(
        InMemoryLocalSecretStore::new()
            .with_secret("private/siglus/secondary-key", (0_u8..16).collect()),
    )
    .with_policy(KeyResolverPolicy::allow_prefixes(["fixture/"]));
    let policy_error = policy_resolver
        .resolve_profile(&policy_profile)
        .unwrap_err();
    assert_eq!(policy_error.kind(), KeyResolverErrorKind::OutOfPolicy);
    assert_eq!(
        policy_error.semantic_code(),
        SemanticErrorCode::SecretRefOutOfPolicy
    );
    assert!(!format!("{policy_error:?}").contains("private/siglus/secondary-key"));

    let os_keychain_profile = key_profile_with_secret_ref("os-keychain:fixture/manual-key");
    let external_error = empty_resolver
        .resolve_profile(&os_keychain_profile)
        .unwrap_err();
    assert_eq!(
        external_error.kind(),
        KeyResolverErrorKind::ExternalStoreUnavailable
    );
    assert_eq!(
        external_error.semantic_code(),
        SemanticErrorCode::ExternalSecretUnavailable
    );

    let prompt_profile = key_profile_with_secret_ref("prompt:fixture/manual-key");
    let prompt_resolver = LocalKeyResolver::new(InMemoryLocalSecretStore::new())
        .with_external_resolver(StubExternalSecretResolver {
            resolution: ExternalSecretResolution::PromptCancelled,
        });
    let prompt_error = prompt_resolver
        .resolve_profile(&prompt_profile)
        .unwrap_err();
    assert_eq!(prompt_error.kind(), KeyResolverErrorKind::PromptCancelled);
    assert_eq!(
        prompt_error.semantic_code(),
        SemanticErrorCode::PromptCancelled
    );

    let invalid_resolver = LocalKeyResolver::new(
        InMemoryLocalSecretStore::new().with_secret("siglus/example/secondary-key", vec![1, 2]),
    );
    let invalid_error = invalid_resolver
        .resolve_profile(&serde_json::from_value::<GameProfile>(valid_key_profile_value()).unwrap())
        .unwrap_err();
    assert_eq!(invalid_error.kind(), KeyResolverErrorKind::InvalidMaterial);
    assert_eq!(
        invalid_error.semantic_code(),
        SemanticErrorCode::KeyValidationFailed
    );
}

#[test]
fn local_secret_allow_prefix_matches_on_path_segment_boundaries_not_raw_string() {
    let policy = KeyResolverPolicy::allow_prefixes(["private/customer/account"]);

    // Exact match is authorized.
    assert!(policy.permits_local_secret_id("private/customer/account"));
    // Child ids under a whole-segment boundary are authorized.
    assert!(policy.permits_local_secret_id("private/customer/account/key"));
    assert!(policy.permits_local_secret_id("private/customer/account/nested/key"));

    // Sibling id whose leading segment merely starts with the prefix's last
    // segment (`accounting` vs `account`) is REJECTED — the historical
    // raw-string-prefix bug wrongly authorized this.
    assert!(!policy.permits_local_secret_id("private/customer/accounting/key"));
    assert!(!policy.permits_local_secret_id("private/customer/accountant"));

    // A shorter, non-segment-aligned prefix is rejected too.
    let partial_segment_policy = KeyResolverPolicy::allow_prefixes(["private/customer/acc"]);
    assert!(!partial_segment_policy.permits_local_secret_id("private/customer/account/key"));
    assert!(!partial_segment_policy.permits_local_secret_id("private/customer/account"));

    // A trailing slash on the configured prefix is normalized and still
    // authorizes whole-segment children.
    let trailing_slash_policy = KeyResolverPolicy::allow_prefixes(["fixture/"]);
    assert!(trailing_slash_policy.permits_local_secret_id("fixture/password"));
    assert!(trailing_slash_policy.permits_local_secret_id("fixture"));
    assert!(!trailing_slash_policy.permits_local_secret_id("fixtures/password"));

    // Empty allow-list permits everything (allow-all-local).
    assert!(KeyResolverPolicy::allow_all_local().permits_local_secret_id("anything/goes"));
}

#[test]
fn external_secret_resolver_interface_can_supply_adapter_bytes_without_local_store() {
    let profile = key_profile_with_secret_ref("secret-manager:fixture/siglus/secondary-key");
    let resolver = LocalKeyResolver::new(InMemoryLocalSecretStore::new()).with_external_resolver(
        StubExternalSecretResolver {
            resolution: ExternalSecretResolution::Material((0_u8..16).collect()),
        },
    );

    let resolved = resolver.resolve_profile(&profile).unwrap();

    assert_eq!(
        resolved.get_bytes("siglus-secondary-key").unwrap(),
        (0_u8..16).collect::<Vec<_>>().as_slice()
    );
    assert_eq!(
        resolved.proof_records()[0].secret_ref_scheme,
        SecretRefScheme::SecretManager
    );
}

#[test]
fn local_secret_directory_store_reads_ignored_local_material_without_path_diagnostics() {
    let root = temp_dir("local-secret-store");
    let secret_path = root.join("fixture").join("siglus");
    fs::create_dir_all(&secret_path).unwrap();
    fs::write(
        secret_path.join("secondary-key"),
        (0_u8..16).collect::<Vec<_>>(),
    )
    .unwrap();
    let resolver = LocalKeyResolver::new(LocalSecretDirectoryStore::new(&root));

    let material = resolver
        .resolve_secret_ref_str(
            "siglus-secondary-key",
            "local-secret:fixture/siglus/secondary-key",
            KeyMaterialKind::FixedBytes,
            Some(16),
        )
        .unwrap();

    assert_eq!(
        material.as_bytes(),
        (0_u8..16).collect::<Vec<_>>().as_slice()
    );
    assert!(!format!("{resolver:?}").contains(&root.display().to_string()));
}

#[test]
fn local_secret_directory_store_imports_key_ref_and_hash_only_metadata() {
    let root = temp_dir("local-secret-import");
    let store = LocalSecretDirectoryStore::new(&root);
    let material = (0_u8..16).collect::<Vec<_>>();
    let source_hash = ProofHash::new(sha256_hash_bytes(b"public import source")).unwrap();

    let result = store
        .import_key_reference(LocalKeyImportRequest {
            secret_ref: SecretRef::new("local-secret:fixture/siglus/manual-secondary-key").unwrap(),
            key_purpose: "siglus-secondary-key".to_string(),
            engine_profile_id: "019ed000-0000-7000-8000-profile00087".to_string(),
            source_hash: source_hash.clone(),
            redaction_status: HelperRedactionStatus::Redacted,
            source: LocalKeyImportSource::ManualKeyEntry,
            material: material.clone(),
        })
        .unwrap();

    assert_eq!(
        result.secret_ref.as_str(),
        "local-secret:fixture/siglus/manual-secondary-key"
    );
    assert_eq!(result.key_purpose, "siglus-secondary-key");
    assert_eq!(
        result.engine_profile_id,
        "019ed000-0000-7000-8000-profile00087"
    );
    assert_eq!(result.source_hash, source_hash);
    assert_eq!(result.material_hash.as_str(), sha256_hash_bytes(&material));
    assert_eq!(result.redaction_status, HelperRedactionStatus::Redacted);
    assert_eq!(result.material_bytes, 16);
    assert_eq!(
        store
            .read_secret("fixture/siglus/manual-secondary-key")
            .unwrap()
            .unwrap(),
        material
    );
    let metadata =
        fs::read_to_string(root.join("fixture/siglus/manual-secondary-key.kaifuu-key.json"))
            .unwrap();
    assert!(metadata.contains("local-secret:fixture/siglus/manual-secondary-key"));
    assert!(metadata.contains("siglus-secondary-key"));
    assert!(metadata.contains("materialHash"));
    assert!(!metadata.contains("000102030405060708090a0b0c0d0e0f"));
}

#[test]
fn sha256_hash_bytes_matches_known_vector() {
    assert_eq!(
        sha256_hash_bytes(b"abc"),
        "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn local_secret_directory_store_rejects_non_file_oversized_and_traversal_refs() {
    let root = temp_dir("local-secret-store-negative");
    fs::create_dir_all(root.join("fixture").join("dir-secret")).unwrap();
    fs::write(root.join("fixture").join("too-large"), b"abc").unwrap();
    let store = LocalSecretDirectoryStore::new(&root).with_max_secret_bytes(2);

    assert_key_resolver_error(
        store.read_secret("fixture/dir-secret"),
        KeyResolverErrorKind::OutOfPolicy,
        SemanticErrorCode::SecretRefOutOfPolicy,
    );
    assert_key_resolver_error(
        store.read_secret("fixture/too-large"),
        KeyResolverErrorKind::OutOfPolicy,
        SemanticErrorCode::SecretRefOutOfPolicy,
    );
    assert_key_resolver_error(
        store.read_secret("../outside"),
        KeyResolverErrorKind::OutOfPolicy,
        SemanticErrorCode::SecretRefOutOfPolicy,
    );

    assert!(store.read_secret("fixture/missing").unwrap().is_none());
}
