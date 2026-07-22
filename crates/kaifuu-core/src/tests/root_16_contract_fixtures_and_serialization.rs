#[test]
fn shared_contract_fixture_suite_binds_alpha_public_manifest_hash_links() {
    let mut fixture = alpha_proof_fixture_value();
    fixture["fixture"]["publicManifestHash"] = serde_json::json!(
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    expect_alpha_proof_error(
        fixture,
        "fixture.publicManifestHash must match AlphaVerticalProofManifestV02.artifactRefs.publicFixtureManifest.hash",
    );

    let mut fixture = alpha_proof_fixture_value();
    let replacement_hash =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    fixture["fixture"]["publicManifestHash"] = serde_json::json!(replacement_hash);
    fixture["artifactRefs"]["publicFixtureManifest"]["hash"] = serde_json::json!(replacement_hash);
    let public_fixture_hash = fixture["contentHashes"]
        .as_array_mut()
        .expect("contentHashes should be an array")
        .iter_mut()
        .find(|entry| entry["scope"].as_str() == Some("public_fixture_manifest"))
        .expect("public fixture manifest hash should exist");
    public_fixture_hash["hash"] = serde_json::json!(replacement_hash);

    contracts::validate_alpha_vertical_proof_manifest_v02(&fixture)
        .expect("aligned public manifest hash links should validate");
}

#[test]
fn rust_runtime_evidence_rejects_controlled_playback_status_mismatch() {
    let mut report = contract_example_fixture_value("./runtime-evidence-v0.2.json");
    report["status"] = Value::String("failed".to_string());

    let error = contracts::validate_runtime_evidence_report_v02(&report)
        .expect_err("controlled playback status mismatch should fail Rust validation")
        .to_string();

    assert!(
        error.contains("controlledPlaybackSession.status must match"),
        "unexpected error: {error}"
    );
}

#[test]
fn rust_runtime_evidence_rejects_trace_operation_with_capture_evidence() {
    let mut report = contract_example_fixture_value("./runtime-evidence-v0.2.json");
    report["controlledPlaybackSession"]["requestedOperation"] = Value::String("trace".to_string());
    report["branchEvents"] = Value::Array(vec![]);
    report["recordings"] = Value::Array(vec![]);

    let error = contracts::validate_runtime_evidence_report_v02(&report)
        .expect_err("trace-requested session with capture evidence should fail Rust validation")
        .to_string();

    assert!(
        error.contains("requestedOperation trace must not carry capture evidence"),
        "unexpected error: {error}"
    );
}

#[test]
fn shared_contract_fixture_suite_rejects_all_manifest_invalid_fixtures() {
    let manifest = contract_fixture_manifest_v02_value();
    let invalid_fixtures = manifest["invalidFixtures"]
        .as_array()
        .expect("manifest invalidFixtures should be an array");

    for fixture in invalid_fixtures {
        let kind = fixture["kind"]
            .as_str()
            .expect("fixture kind should be a string");
        let path = fixture["path"]
            .as_str()
            .expect("fixture path should be a string");
        let expected = fixture["expectedSemanticError"]
            .as_str()
            .expect("expected error should be a string");
        let value = contract_example_fixture_value(path);

        let error = contracts::validate_shared_contract_fixture_v02(kind, &value)
            .expect_err("invalid contract fixture should fail Rust validation")
            .to_string();
        assert!(
            semantic_error_matches(&error, expected),
            "{kind} fixture {path} produced unexpected error. expected {expected:?}, got {error:?}"
        );
    }
}

#[test]
fn rust_bridge_contract_rejects_invalid_shared_bridge_fixtures_semantically() {
    for (relative_path, expected_error) in [
        (
            "packages/localization-bridge-schema/test/examples/invalid/bridge-v0.2-dangling-asset-ref.json",
            "sourceAssetRef.assetId must reference an asset",
        ),
        (
            "packages/localization-bridge-schema/test/examples/invalid/bridge-v0.2-malformed-hash.json",
            "sourceBundleHash must be a canonical sha256 hash string",
        ),
        (
            "packages/localization-bridge-schema/test/examples/invalid/bridge-v0.2-schema-version-0.1.json",
            "schemaVersion must be 0.2.0; 0.1.0 is the legacy fixture contract",
        ),
    ] {
        let fixture = bridge_fixture_value(relative_path);
        let error = BridgeBundleV02::validate_json(&fixture)
            .expect_err("invalid bridge fixture should fail Rust validation")
            .to_string();
        assert!(
            error.contains(expected_error),
            "{relative_path} produced unexpected error: {error}"
        );
    }
}

#[test]
fn rust_source_revision_v02_matches_ts_revision_kind_enum() {
    for (revision_kind, value) in [
        (
            "content_hash",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
        ("source_control", "main@abc123"),
        ("build", "build-2026-06-17"),
        ("manual_snapshot", "snapshot-1"),
    ] {
        SourceRevisionV02 {
            revision_id: "019ed001-0000-7000-8000-000000000001".to_string(),
            revision_kind: revision_kind.to_string(),
            value: value.to_string(),
            created_at: None,
        }
        .validate("SourceRevisionV02")
        .expect("TS-supported revisionKind should validate in Rust");
    }

    for revision_kind in ["manual", "release"] {
        let error = SourceRevisionV02 {
            revision_id: "019ed001-0000-7000-8000-000000000001".to_string(),
            revision_kind: revision_kind.to_string(),
            value: "snapshot-1".to_string(),
            created_at: None,
        }
        .validate("SourceRevisionV02")
        .expect_err("TS-unsupported revisionKind should fail in Rust")
        .to_string();
        assert!(error.contains("revisionKind"), "{error}");
    }
}

#[test]
fn rust_bridge_contract_rejects_audited_v02_semantic_divergences() {
    let mut fixture = bridge_v02_fixture_value();
    fixture["units"][0]["sourceLocation"] = serde_json::json!(["script/prologue"]);
    expect_bridge_v02_error(fixture, "sourceLocation must be an object");

    let mut fixture = bridge_v02_fixture_value();
    fixture["units"][0]["sourceLocation"]["range"]["endByte"] = serde_json::json!(0);
    expect_bridge_v02_error(fixture, "sourceLocation.range.endByte must be greater than");

    let mut fixture = bridge_v02_fixture_value();
    fixture["units"][3]["context"]
        .as_object_mut()
        .unwrap()
        .remove("choice");
    expect_bridge_v02_error(fixture, "context.choice is required for choice_label");

    let mut fixture = bridge_v02_fixture_value();
    fixture["units"][6]["context"]["database"]["databaseKind"] = serde_json::json!("global");
    expect_bridge_v02_error(fixture, "context.database.databaseKind");

    let mut fixture = bridge_v02_fixture_value();
    fixture["units"][6]["policy"] = serde_json::json!({
        "policyAction": "localize"
    });
    expect_bridge_v02_error(
        fixture,
        "policy must include targetLocale or localeBranchId",
    );

    let mut fixture = bridge_v02_fixture_value();
    fixture["units"][0]["spans"][0]["policy"] = serde_json::json!({
        "policyAction": "manual"
    });
    expect_bridge_v02_error(fixture, "spans[0].policy.policyAction");

    let mut fixture = bridge_v02_fixture_value();
    fixture["units"][0]["spans"][0]["parsedName"] = serde_json::json!("");
    expect_bridge_v02_error(fixture, "spans[0].parsedName must be a non-empty string");

    let mut fixture = bridge_v02_fixture_value();
    fixture["units"][0]["spans"][0]["arguments"] = serde_json::json!({
        "name": "player"
    });
    expect_bridge_v02_error(fixture, "spans[0].arguments must be an array");

    let mut fixture = bridge_v02_fixture_value();
    fixture["units"][0]["spans"][0]["exampleValues"] = serde_json::json!([""]);
    expect_bridge_v02_error(
        fixture,
        "spans[0].exampleValues[0] must be a non-empty string",
    );

    let mut fixture = bridge_v02_fixture_value();
    fixture["units"][0]["spans"][0]["spanKind"] = serde_json::json!("ruby_annotation");
    expect_bridge_v02_error(
        fixture,
        "spans[0].base.startByte must be a non-negative integer",
    );

    let mut fixture = bridge_v02_fixture_value();
    fixture["units"][0]["spans"][0] = serde_json::json!({
        "spanId": "019ed001-0000-7000-8000-000000000801",
        "spanKind": "ruby_annotation",
        "raw": "{player}",
        "startByte": 7,
        "endByte": 15,
        "preserveMode": "locale_policy",
        "baseStartByte": 7,
        "baseEndByte": 7,
        "annotationStartByte": 7,
        "annotationEndByte": 15,
        "annotationText": "player"
    });
    expect_bridge_v02_error(fixture, "spans[0].base.endByte must be greater than");

    let mut fixture = bridge_v02_fixture_value();
    fixture["units"][0]["spans"][0] = serde_json::json!({
        "spanId": "019ed001-0000-7000-8000-000000000801",
        "spanKind": "ruby_annotation",
        "raw": "{player}",
        "startByte": 7,
        "endByte": 15,
        "preserveMode": "locale_policy",
        "baseStartByte": 7,
        "baseEndByte": 15,
        "annotationStartByte": 7,
        "annotationEndByte": 15,
        "annotationText": ""
    });
    expect_bridge_v02_error(
        fixture,
        "spans[0].annotationText must be a non-empty string",
    );

    let mut fixture = bridge_v02_fixture_value();
    fixture["units"][7]["context"]["song"]["audioAssetRef"]["assetId"] =
        serde_json::json!("019ed001-0000-7000-8000-00000000ffff");
    expect_bridge_v02_error(fixture, "context.song.audioAssetRef.assetId");

    let mut fixture = bridge_v02_fixture_value();
    fixture["units"][0]["patchRef"]["assetId"] =
        serde_json::json!("019ed001-0000-7000-8000-00000000ffff");
    expect_bridge_v02_error(fixture, "patchRef.assetId");

    let mut fixture = bridge_v02_fixture_value();
    fixture["units"][0]["runtimeExpectation"]["traceKey"] = serde_json::json!("");
    expect_bridge_v02_error(fixture, "runtimeExpectation.traceKey");

    let mut fixture = bridge_v02_fixture_value();
    fixture["units"][8]["runtimeExpectation"]["region"]["width"] = serde_json::json!(0);
    expect_bridge_v02_error(fixture, "runtimeExpectation.region.width");
}

#[test]
fn rust_bridge_contract_documents_non_bridge_fixture_scope() {
    let fixture =
        bridge_fixture_value("packages/localization-bridge-schema/test/examples/triage-v0.2.json");

    let error = BridgeBundleV02::validate_json(&fixture)
        .expect_err("triage fixture is not a bridge bundle")
        .to_string();

    assert!(
        error.contains("BridgeBundleV02 must match the Rust serde contract"),
        "{error}"
    );
    assert!(error.contains("serialized input"), "{error}");
    assert!(error.contains("sha256"), "{error}");
}

#[test]
fn profile_serialization_is_deterministic() {
    let mut metadata = BTreeMap::new();
    metadata.insert("source".to_string(), "fixture".to_string());
    metadata.insert(
        "supportBoundary".to_string(),
        "plain JSON fixture".to_string(),
    );
    let profile = GameProfile {
        schema_version: "0.1.0".to_string(),
        profile_id: deterministic_id("profile", 1),
        game_id: "hello-fixture".to_string(),
        title: "Hello Fixture".to_string(),
        source_locale: "ja-JP".to_string(),
        engine: EngineProfile {
            adapter_id: "kaifuu.fixture".to_string(),
            engine_family: "fixture".to_string(),
            engine_version: Some("0.0.0".to_string()),
            detected_variant: "plain-json".to_string(),
        },
        source_fingerprint: None,
        key_requirements: vec![],
        archive_parameters: vec![],
        helper_evidence: None,
        assets: vec![AssetProfile {
            asset_id: deterministic_id("asset", 1),
            path: "source.json".to_string(),
            asset_kind: AssetKind::Script,
            text_surfaces: vec![TextSurface::Dialogue],
            source_hash: Some("abcdef".to_string()),
            patching: CapabilityReport::limited(
                Capability::Patching,
                "fixture rewrites source.json with pretty JSON",
            ),
        }],
        layered_access: None,
        capabilities: vec![
            CapabilityReport::unsupported(
                Capability::DeltaPatching,
                "delta packages are handled outside the engine adapter",
            ),
            CapabilityReport::supported(Capability::Detection),
        ],
        requirements: vec![ProfileRequirement {
            category: RequirementCategory::SecretKey,
            key: "decryption_key".to_string(),
            status: RequirementStatus::NotRequired,
            description: "decryption key not required".to_string(),
            placeholder: None,
            secret: true,
        }],
        metadata,
    };

    // `stable_json` is report-safe: it routes through the centralized
    // redaction policy, so keys are emitted in canonical (sorted) order and
    // sensitive values are redacted. This fixture uses clean data, so
    // redaction is a no-op and the values pass through unchanged.
    let expected = r#"{
  "assets": [
    {
      "assetId": "019ed000-0000-7000-8000-asset0000001",
      "assetKind": "script",
      "patching": {
        "capability": "patching",
        "limitation": "fixture rewrites source.json with pretty JSON",
        "status": "limited"
      },
      "path": "source.json",
      "sourceHash": "abcdef",
      "textSurfaces": [
        "dialogue"
      ]
    }
  ],
  "capabilities": [
    {
      "capability": "delta_patching",
      "limitation": "delta packages are handled outside the engine adapter",
      "status": "unsupported"
    },
    {
      "capability": "detection",
      "limitation": null,
      "status": "supported"
    }
  ],
  "engine": {
    "adapterId": "kaifuu.fixture",
    "detectedVariant": "plain-json",
    "engineFamily": "fixture",
    "engineVersion": "0.0.0"
  },
  "gameId": "hello-fixture",
  "metadata": {
    "source": "fixture",
    "supportBoundary": "plain JSON fixture"
  },
  "profileId": "019ed000-0000-7000-8000-profile00001",
  "requirements": [
    {
      "category": "secret_key",
      "description": "decryption key not required",
      "key": "decryption_key",
      "placeholder": null,
      "secret": true,
      "status": "not_required"
    }
  ],
  "schemaVersion": "0.1.0",
  "sourceLocale": "ja-JP",
  "title": "Hello Fixture"
}
"#;
    assert_eq!(profile.stable_json().unwrap(), expected);
    assert_eq!(
        profile.stable_json().unwrap(),
        profile.stable_json().unwrap()
    );
}

/// Synthetic sensitive values (NO real key material) spanning every
/// redaction class the centralized policy protects.
const SENSITIVE_ABSOLUTE_PATH: &str = "/home/dev/games/secret/game.exe";
const SENSITIVE_KEY_MATERIAL: &str = "00112233445566778899aabbccddeeff00112233";
const SENSITIVE_HELPER_DUMP: &str = "helper dump: fixture-helper --dump 0xfeed";
const SENSITIVE_PRIVATE_TEXT: &str = "decrypted text: private-ending spoiler line";

fn sensitive_metadata() -> BTreeMap<String, String> {
    let mut metadata = BTreeMap::new();
    metadata.insert(
        "absolutePath".to_string(),
        SENSITIVE_ABSOLUTE_PATH.to_string(),
    );
    metadata.insert(
        "keyMaterial".to_string(),
        SENSITIVE_KEY_MATERIAL.to_string(),
    );
    metadata.insert("helperDump".to_string(), SENSITIVE_HELPER_DUMP.to_string());
    metadata.insert(
        "privateText".to_string(),
        SENSITIVE_PRIVATE_TEXT.to_string(),
    );
    metadata
}

fn assert_public_serialization_is_report_safe(serialized: &str) {
    for leaked in [
        SENSITIVE_ABSOLUTE_PATH,
        SENSITIVE_KEY_MATERIAL,
        SENSITIVE_HELPER_DUMP,
        SENSITIVE_PRIVATE_TEXT,
    ] {
        assert!(
            !serialized.contains(leaked),
            "public serialization leaked sensitive value {leaked:?}: {serialized}"
        );
    }
    assert!(
        serialized.contains("[REDACTED:"),
        "public serialization should carry redaction placeholders: {serialized}"
    );
    // The redacted output must still be valid, re-parseable JSON.
    let value: Value = serde_json::from_str(serialized).unwrap();
    assert!(value.is_object());
}

#[test]
fn game_profile_public_stable_json_redacts_sensitive_fields() {
    let mut profile = GameProfile {
        schema_version: PROFILE_SCHEMA_VERSION.to_string(),
        profile_id: deterministic_id("profile", 913_201),
        game_id: "sensitive-fixture".to_string(),
        // Absolute path smuggled into a typed string field.
        title: SENSITIVE_ABSOLUTE_PATH.to_string(),
        source_locale: "ja-JP".to_string(),
        engine: EngineProfile {
            adapter_id: "kaifuu.fixture".to_string(),
            engine_family: "fixture".to_string(),
            engine_version: None,
            detected_variant: "plain".to_string(),
        },
        source_fingerprint: None,
        key_requirements: vec![],
        archive_parameters: vec![],
        helper_evidence: None,
        assets: vec![],
        layered_access: None,
        // Raw key material smuggled into a capability limitation.
        capabilities: vec![CapabilityReport::unsupported(
            Capability::AssetTextPatching,
            SENSITIVE_KEY_MATERIAL,
        )],
        requirements: vec![],
        metadata: sensitive_metadata(),
    };
    profile.normalize();

    // The only public serialization path is report-safe; there is no raw
    // `stable_json` bypass on `GameProfile`.
    assert_public_serialization_is_report_safe(&profile.stable_json().unwrap());
}
