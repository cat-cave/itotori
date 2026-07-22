#[test]
fn asset_inventory_manifest_public_stable_json_redacts_sensitive_fields() {
    let mut manifest = AssetInventoryManifest {
        schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
        manifest_id: "sensitive-manifest".to_string(),
        adapter_id: "kaifuu.fixture".to_string(),
        source_locale: "ja-JP".to_string(),
        assets: vec![],
        surfaces: vec![],
        // Raw key material smuggled into a warning message.
        warnings: vec![AdapterWarning {
            code: "diagnostic".to_string(),
            message: SENSITIVE_KEY_MATERIAL.to_string(),
        }],
        capabilities: vec![],
        metadata: sensitive_metadata(),
    };
    manifest.normalize();

    // The only public serialization path is report-safe; there is no raw
    // `stable_json` bypass on `AssetInventoryManifest`.
    assert_public_serialization_is_report_safe(&manifest.stable_json().unwrap());
}

#[test]
fn detection_result_omits_unknown_optional_engine_fields() {
    let unknown = DetectionResult {
        adapter_id: "kaifuu.fixture".to_string(),
        detected: false,
        engine_family: None,
        engine_version: None,
        detected_variant: None,
        evidence: vec![],
        requirements: vec![],
        capabilities: vec![],
    };

    let unknown_json = serde_json::to_value(&unknown).unwrap();
    let unknown_object = unknown_json.as_object().unwrap();
    assert!(!unknown_object.contains_key("engineFamily"));
    assert!(!unknown_object.contains_key("engineVersion"));
    assert!(!unknown_object.contains_key("detectedVariant"));

    let detected = DetectionResult {
        adapter_id: "kaifuu.fixture".to_string(),
        detected: true,
        engine_family: Some("fixture".to_string()),
        engine_version: Some("0.0.0".to_string()),
        detected_variant: Some("plain-json".to_string()),
        evidence: vec![],
        requirements: vec![],
        capabilities: vec![],
    };

    let detected_json = serde_json::to_value(&detected).unwrap();
    assert_eq!(detected_json["engineFamily"], "fixture");
    assert_eq!(detected_json["engineVersion"], "0.0.0");
    assert_eq!(detected_json["detectedVariant"], "plain-json");
}

#[test]
fn protected_span_normalizer_uses_engine_neutral_byte_spans() {
    let source_text = "こんにちは、{player}。";
    let spans = normalize_protected_spans(
        source_text,
        vec![ProtectedSpan::new(
            "placeholder",
            "{player}",
            18,
            26,
            "exact",
        )],
    )
    .unwrap();

    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].kind, "variable_placeholder");
    assert_eq!(spans[0].preserve_mode, "map");
    assert_eq!(spans[0].variable_name.as_deref(), Some("player"));
    assert_eq!(
        &source_text[spans[0].start as usize..spans[0].end as usize],
        spans[0].raw
    );
}

#[test]
fn protected_span_normalizer_rejects_overlapping_spans() {
    let error = normalize_protected_spans(
        "abc {name}",
        vec![
            ProtectedSpan::control_markup("{name}", 4, 10, "unknown_placeholder", vec![]),
            ProtectedSpan::variable_placeholder("{name}", 4, 10, "name"),
            ProtectedSpan::control_markup("name", 5, 9, "bad_nested_span", vec![]),
        ],
    )
    .expect_err("overlapping spans should fail")
    .to_string();

    assert!(error.contains("must not overlap"), "{error}");
}

#[test]
fn registry_orders_adapters_by_id() {
    struct Adapter(&'static str);

    impl EngineAdapter for Adapter {
        fn id(&self) -> &'static str {
            self.0
        }

        fn name(&self) -> &'static str {
            self.0
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(self.0, vec![], derived_matrix_for(self.0, &[]))
        }

        fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            Ok(DetectionResult {
                adapter_id: self.0.to_string(),
                detected: true,
                engine_family: Some(self.0.to_string()),
                engine_version: None,
                detected_variant: Some("test".to_string()),
                evidence: vec![],
                requirements: vec![],
                capabilities: vec![],
            })
        }

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            unreachable!()
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            unreachable!()
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            unreachable!()
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            unreachable!()
        }

        fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            unreachable!()
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            unreachable!()
        }
    }

    let mut registry = AdapterRegistry::new();
    registry.register(Adapter("z.fixture"));
    registry.register(Adapter("a.fixture"));
    let ids = registry
        .adapters()
        .iter()
        .map(|adapter| adapter.id())
        .collect::<Vec<_>>();
    assert_eq!(ids, vec!["a.fixture", "z.fixture"]);
}

mod diagnostic_candidate;

// XP3 profile proof tests

fn write_xp3_archive(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let archive = dir.join(name);
    fs::write(&archive, bytes).unwrap();
    archive
}

fn build_plain_xp3_archive_bytes() -> Vec<u8> {
    // Smallest synthetic plain XP3 archive the
    // `read_plain_xp3_inventory` parser will accept: magic + index
    // offset pointing at an empty index.
    let mut bytes = Vec::new();
    bytes.extend_from_slice(XP3_PLAIN_MAGIC);
    let index_offset = (bytes.len() + 8) as u64;
    bytes.extend_from_slice(&index_offset.to_le_bytes());
    // Plain index encoding flag.
    bytes.push(0);
    // Index size = 0 (empty index).
    bytes.extend_from_slice(&0u64.to_le_bytes());
    bytes
}

fn build_encrypted_xp3_marker_archive_bytes() -> Vec<u8> {
    b"XP3\r\nXP3-CRYPT\nkaifuu-xp3-encrypted synthetic routing fixture\n".to_vec()
}

fn build_helper_required_xp3_marker_archive_bytes() -> Vec<u8> {
    b"XP3\r\nXP3-HELPER-REQUIRED\nkaifuu-xp3-helper-required synthetic routing fixture\n".to_vec()
}

fn build_compressed_xp3_marker_archive_bytes() -> Vec<u8> {
    b"XP3\r\nXP3-COMPRESSED\nkaifuu-xp3-compressed synthetic routing fixture\n".to_vec()
}

fn build_protected_executable_bytes() -> Vec<u8> {
    b"MZ\x90\0\x03\0\0\0PROTECTED-EXECUTABLE-FIXTURE\n".to_vec()
}

fn make_plain_fixture(archive_name: &str) -> Xp3ProfileProofFixture {
    Xp3ProfileProofFixture {
        schema_version: XP3_PROFILE_PROOF_SCHEMA_VERSION.to_string(),
        fixture_id: "kaifuu-kirikiri-xp3-plain-profile-proof".to_string(),
        profile_id: "019ed000-0000-7000-8000-000000095001".to_string(),
        archive: Xp3ProfileProofFixtureArchive {
            archive_id: "kirikiri-xp3-archive".to_string(),
            path: archive_name.to_string(),
        },
        expected_classification: Xp3ProfileClassification::Plain,
        patch_capability_level: Xp3PatchCapabilityLevel::PatchBack,
        crypt_profile: None,
    }
}

fn make_encrypted_fixture(archive_name: &str) -> Xp3ProfileProofFixture {
    Xp3ProfileProofFixture {
        schema_version: XP3_PROFILE_PROOF_SCHEMA_VERSION.to_string(),
        fixture_id: "kaifuu-kirikiri-xp3-encrypted-profile-proof".to_string(),
        profile_id: "019ed000-0000-7000-8000-000000095002".to_string(),
        archive: Xp3ProfileProofFixtureArchive {
            archive_id: "kirikiri-xp3-archive".to_string(),
            path: archive_name.to_string(),
        },
        expected_classification: Xp3ProfileClassification::Encrypted,
        patch_capability_level: Xp3PatchCapabilityLevel::Unsupported,
        crypt_profile: Some(Xp3ProfileProofFixtureCryptProfile {
            crypt_profile_id: "kirikiri-xp3-fixture-key-profile".to_string(),
            key_ref_requirement: Some(Xp3ProfileProofFixtureKeyRefRequirement {
                requirement_id: "kirikiri-xp3-key-profile".to_string(),
                secret_ref: SecretRef::new(
                    "local-secret:fixture/kirikiri/xp3-archive-password".to_string(),
                )
                .unwrap(),
            }),
        }),
    }
}

fn make_compressed_fixture(archive_name: &str) -> Xp3ProfileProofFixture {
    Xp3ProfileProofFixture {
        schema_version: XP3_PROFILE_PROOF_SCHEMA_VERSION.to_string(),
        fixture_id: "kaifuu-kirikiri-xp3-compressed-profile-proof".to_string(),
        profile_id: "019ed000-0000-7000-8000-000000095003".to_string(),
        archive: Xp3ProfileProofFixtureArchive {
            archive_id: "kirikiri-xp3-archive".to_string(),
            path: archive_name.to_string(),
        },
        expected_classification: Xp3ProfileClassification::Compressed,
        patch_capability_level: Xp3PatchCapabilityLevel::Unsupported,
        crypt_profile: None,
    }
}

fn xp3_profile_diagnostic<'a>(
    report: &'a Xp3ProfileProofReport,
    code: &str,
) -> &'a Xp3ProfileProofDiagnostic {
    report
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code == code)
        .unwrap_or_else(|| panic!("missing XP3 profile diagnostic {code}"))
}

#[test]
fn xp3_profile_proof_distinct_outcomes_for_each_variant() {
    // Acceptance criterion: "Plain XP3, encrypted XP3, compressed
    // XP3, helper-required XP3, and protected executable cases
    // produce distinct capability outcomes."
    let dir = temp_dir("xp3-profile-proof-distinct");

    write_xp3_archive(&dir, "plain.xp3", &build_plain_xp3_archive_bytes());
    write_xp3_archive(
        &dir,
        "encrypted.xp3",
        &build_encrypted_xp3_marker_archive_bytes(),
    );
    write_xp3_archive(
        &dir,
        "compressed.xp3",
        &build_compressed_xp3_marker_archive_bytes(),
    );
    write_xp3_archive(
        &dir,
        "helper-required.xp3",
        &build_helper_required_xp3_marker_archive_bytes(),
    );
    write_xp3_archive(
        &dir,
        "protected-executable.bin",
        &build_protected_executable_bytes(),
    );

    let plain_report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &make_plain_fixture("plain.xp3"),
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(plain_report.status, OperationStatus::Passed);
    assert_eq!(plain_report.classification, Xp3ProfileClassification::Plain);
    assert_eq!(
        plain_report.patch_capability_level,
        Xp3PatchCapabilityLevel::PatchBack
    );
    assert_eq!(
        plain_report.helper_requirement,
        Xp3HelperRequirement::NotRequired
    );
    assert_eq!(plain_report.archive.entry_count, Some(0));
    assert!(!plain_report.patch_write_attempted);
    assert!(plain_report.diagnostics.is_empty());
    assert_eq!(
        plain_report.crypt_profile.status,
        Xp3CryptProfileStatus::NotRequired
    );

    let encrypted_report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &make_encrypted_fixture("encrypted.xp3"),
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(
        encrypted_report.classification,
        Xp3ProfileClassification::Encrypted
    );
    assert_eq!(
        encrypted_report.patch_capability_level,
        Xp3PatchCapabilityLevel::Unsupported
    );
    assert_eq!(
        encrypted_report.helper_requirement,
        Xp3HelperRequirement::NotRequired
    );
    assert_eq!(encrypted_report.archive.entry_count, None);
    assert!(!encrypted_report.patch_write_attempted);
    assert_eq!(
        encrypted_report.crypt_profile.status,
        Xp3CryptProfileStatus::Satisfied
    );
    assert!(
        encrypted_report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "xp3.encrypted.unsupported"
                && diagnostic.semantic_code.as_deref()
                    == Some(SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED))
    );

    let compressed_report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &make_compressed_fixture("compressed.xp3"),
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(
        compressed_report.classification,
        Xp3ProfileClassification::Compressed
    );
    assert_eq!(
        compressed_report.patch_capability_level,
        Xp3PatchCapabilityLevel::Unsupported
    );
    assert_eq!(
        compressed_report.helper_requirement,
        Xp3HelperRequirement::NotRequired
    );
    assert_eq!(compressed_report.archive.entry_count, None);
    assert!(!compressed_report.patch_write_attempted);
    assert_eq!(
        compressed_report.crypt_profile.status,
        Xp3CryptProfileStatus::NotRequired
    );
    assert!(compressed_report.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == "xp3.compressed.unsupported"
            && diagnostic.semantic_code.as_deref() == Some(SEMANTIC_UNSUPPORTED_VARIANT_PACKED)
    }));

    let mut helper_fixture = make_encrypted_fixture("helper-required.xp3");
    helper_fixture.fixture_id = "kaifuu-kirikiri-xp3-helper-required-profile-proof".to_string();
    helper_fixture.profile_id = "019ed000-0000-7000-8000-000000095004".to_string();
    helper_fixture.expected_classification = Xp3ProfileClassification::HelperRequired;
    helper_fixture.crypt_profile = Some(Xp3ProfileProofFixtureCryptProfile {
        crypt_profile_id: "kirikiri-xp3-helper-required-key-profile".to_string(),
        key_ref_requirement: Some(Xp3ProfileProofFixtureKeyRefRequirement {
            requirement_id: "kirikiri-xp3-key-profile".to_string(),
            secret_ref: SecretRef::new(
                "local-secret:fixture/kirikiri/xp3-archive-password".to_string(),
            )
            .unwrap(),
        }),
    });
    let helper_report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &helper_fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(
        helper_report.classification,
        Xp3ProfileClassification::HelperRequired
    );
    assert_eq!(
        helper_report.patch_capability_level,
        Xp3PatchCapabilityLevel::Unsupported
    );
    assert_eq!(
        helper_report.helper_requirement,
        Xp3HelperRequirement::Required
    );
    assert!(
        helper_report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "xp3.helper_required"
                && diagnostic.semantic_code.as_deref() == Some(SEMANTIC_HELPER_REQUIRED))
    );

    let mut protected_fixture = make_plain_fixture("protected-executable.bin");
    protected_fixture.fixture_id =
        "kaifuu-kirikiri-xp3-protected-executable-profile-proof".to_string();
    protected_fixture.profile_id = "019ed000-0000-7000-8000-000000095099".to_string();
    protected_fixture.expected_classification =
        Xp3ProfileClassification::UnsupportedProtectedExecutable;
    protected_fixture.patch_capability_level = Xp3PatchCapabilityLevel::Unsupported;
    let protected_report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &protected_fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(
        protected_report.classification,
        Xp3ProfileClassification::UnsupportedProtectedExecutable
    );
    assert_eq!(
        protected_report.patch_capability_level,
        Xp3PatchCapabilityLevel::Unsupported
    );
    assert!(
        protected_report
            .diagnostics
            .iter()
            .any(
                |diagnostic| diagnostic.code == "xp3.unsupported_protected_executable"
                    && diagnostic.semantic_code.as_deref()
                        == Some(SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED)
            )
    );
    // The routed classifications cover distinct outcomes.
    assert_ne!(plain_report.classification, encrypted_report.classification);
    assert_ne!(
        encrypted_report.classification,
        compressed_report.classification
    );
    assert_ne!(
        compressed_report.classification,
        helper_report.classification
    );
    assert_ne!(
        helper_report.classification,
        protected_report.classification
    );
}
