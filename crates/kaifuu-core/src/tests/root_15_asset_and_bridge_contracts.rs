#[test]
fn asset_metadata_hash_is_deterministic_and_identity_bound() {
    let manifest = asset_inventory_patch_capability_positive_fixture();
    let surface = manifest
        .surfaces
        .iter()
        .find(|surface| surface.surface_id == "surface-song-title")
        .expect("song-title surface");

    // Deterministic: recomputing the hash yields the same value, and it is a
    // well-formed sha256 ref.
    let first = asset_inventory_surface_metadata_hash(&manifest, surface);
    let second = asset_inventory_surface_metadata_hash(&manifest, surface);
    assert_eq!(first, second, "metadata hash must be deterministic");
    assert!(is_sha256_ref(&first), "metadata hash must be a sha256 ref");
    assert_eq!(
        surface.metadata_hash.as_deref(),
        Some(first.as_str()),
        "stamped hash must equal the recomputed hash",
    );

    // Identity/patch-decision bound: mutating the referenced asset's identity
    // (source_hash) changes the hash; mutating the patch capability changes it.
    let mut mutated_identity = manifest.clone();
    for asset in &mut mutated_identity.assets {
        if asset.asset_id == "asset-song" {
            asset.source_hash = Some(content_hash("audio/theme/tampered"));
        }
    }
    assert_ne!(
        asset_inventory_surface_metadata_hash(&mutated_identity, surface),
        first,
        "changing asset identity must change the metadata hash",
    );

    let mut mutated_capability = surface.clone();
    mutated_capability.patch_mode = AssetInventoryPatchMode::Unsupported;
    assert_ne!(
        asset_inventory_surface_metadata_hash(&manifest, &mutated_capability),
        first,
        "changing the patch decision must change the metadata hash",
    );
}

#[test]
fn asset_inventory_patch_capability_positive_fixture_passes() {
    let manifest = asset_inventory_patch_capability_positive_fixture();
    // Structurally valid.
    assert_eq!(manifest.validate().status, OperationStatus::Passed);
    // Consistent: no capability diagnostics.
    assert_eq!(validate_asset_inventory_patch_capability(&manifest), vec![]);
    assert!(manifest.validate_patch_capability().is_ok());
}

#[test]
fn asset_inventory_rejects_patch_payload_for_unsupported_asset() {
    let manifest = asset_inventory_patch_capability_unsupported_patched_fixture();
    // The manifest is otherwise structurally valid.
    assert_eq!(manifest.validate().status, OperationStatus::Passed);

    let diagnostics = manifest
        .validate_patch_capability()
        .expect_err("manifest advertising a patch for an unsupported asset must be rejected");
    assert_eq!(diagnostics.len(), 1, "exactly one typed diagnostic");
    match &diagnostics[0] {
        AssetCapabilityDiagnostic::UnsupportedAssetPatched {
            surface_id,
            asset_id,
            asset_ref,
            required_capability,
            ..
        } => {
            assert_eq!(diagnostics[0].code(), "unsupported_asset_patched");
            assert_eq!(surface_id, "surface-logo-art");
            assert_eq!(asset_id, "asset-logo");
            assert_eq!(asset_ref, "art/logo");
            assert_eq!(*required_capability, Capability::NonTextSurfaceExtraction);
        }
        AssetCapabilityDiagnostic::MetadataHashMismatch { .. } => {
            panic!("expected unsupported_asset_patched, got a hash mismatch")
        }
    }
}

#[test]
fn asset_inventory_rejects_metadata_hash_mismatch() {
    let manifest = asset_inventory_metadata_hash_mismatch_fixture();
    // Structurally valid, but the declared hash has drifted.
    assert_eq!(manifest.validate().status, OperationStatus::Passed);

    let diagnostics = manifest
        .validate_patch_capability()
        .expect_err("manifest with a drifted metadata hash must be rejected");
    assert_eq!(diagnostics.len(), 1, "exactly one typed diagnostic");
    match &diagnostics[0] {
        AssetCapabilityDiagnostic::MetadataHashMismatch {
            surface_id,
            asset_id,
            declared_hash,
            computed_hash,
        } => {
            assert_eq!(diagnostics[0].code(), "metadata_hash_mismatch");
            assert_eq!(surface_id, "surface-song-title");
            assert_eq!(asset_id, "asset-song");
            assert_ne!(declared_hash, computed_hash);
            assert!(is_sha256_ref(computed_hash));
        }
        AssetCapabilityDiagnostic::UnsupportedAssetPatched { .. } => {
            panic!("expected metadata_hash_mismatch, got an unsupported-patched diagnostic")
        }
    }
}

#[test]
fn asset_capability_diagnostic_serializes_with_typed_code() {
    let diagnostic = AssetCapabilityDiagnostic::UnsupportedAssetPatched {
        surface_id: "s".to_string(),
        asset_id: "a".to_string(),
        asset_ref: "k".to_string(),
        required_capability: Capability::NonTextSurfaceExtraction,
        support_boundary: "boundary".to_string(),
    };
    let json = serde_json::to_value(&diagnostic).expect("serialize diagnostic");
    assert_eq!(json["code"], "unsupported_asset_patched");
    let round_trip: AssetCapabilityDiagnostic =
        serde_json::from_value(json).expect("round-trip diagnostic");
    assert_eq!(round_trip, diagnostic);
}

#[test]
fn atomic_write_text_cleans_temp_file_when_rename_fails() {
    let dir = temp_dir("atomic-rename-failure");
    let target = dir.join("source.json");
    fs::create_dir_all(&target).unwrap();

    let error = atomic_write_text(&target, "patched\n")
        .unwrap_err()
        .to_string();

    assert!(
        error.contains("Is a directory")
            || error.contains("Access is denied")
            || error.contains("cannot be moved")
            || error.contains("directory")
    );
    assert!(target.is_dir());
    let temp_entries = fs::read_dir(&dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".source.json.tmp-")
        })
        .count();
    assert_eq!(temp_entries, 0);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn rust_bridge_contract_accepts_shared_v02_bridge_fixture() {
    let fixture = bridge_v02_fixture_value();

    let bundle = BridgeBundleV02::validate_json(&fixture)
        .expect("shared v0.2 bridge fixture should validate in Rust");

    assert_eq!(bundle.schema_version, BRIDGE_SCHEMA_VERSION_V02);
    assert_eq!(bundle.bridge_id, "019ed001-0000-7000-8000-000000000001");
    assert_eq!(bundle.units.len(), 12);
}

#[test]
fn v02_source_compatibility_rejects_duplicate_raw_protected_spans_without_valid_identity() {
    let mut bridge = bridge_v02_fixture_value();
    let unit = bridge["units"][0].as_object_mut().unwrap();
    unit.insert(
        "sourceText".to_string(),
        serde_json::json!("{name} meets {name}"),
    );
    unit.insert(
        "spans".to_string(),
        serde_json::json!([
            {
                "spanId": "019ed001-0000-7000-8000-000000000841",
                "spanKind": "variable_placeholder",
                "raw": "{name}",
                "startByte": 0,
                "endByte": 6,
                "preserveMode": "map",
                "variableName": "name"
            },
            {
                "spanId": "019ed001-0000-7000-8000-000000000842",
                "spanKind": "variable_placeholder",
                "raw": "{name}",
                "startByte": 13,
                "endByte": 19,
                "preserveMode": "map",
                "variableName": "name"
            }
        ]),
    );
    let source_unit_key = bridge["units"][0]["sourceUnitKey"].as_str().unwrap();
    let units = v02_bridge_units_by_key(&bridge).unwrap();
    let source_unit = units.get(source_unit_key).unwrap();

    let valid = serde_json::json!({
        "targetText": "{name} and {name}",
        "protectedSpanMappings": [
            {
                "raw": "{name}",
                "sourceSpanId": "019ed001-0000-7000-8000-000000000842",
                "sourceStartByte": 13,
                "sourceEndByte": 19,
                "targetStart": 0,
                "targetEnd": 6
            },
            {
                "raw": "{name}",
                "sourceSpanId": "019ed001-0000-7000-8000-000000000841",
                "sourceStartByte": 0,
                "sourceEndByte": 6,
                "targetStart": 11,
                "targetEnd": 17
            }
        ]
    });
    let no_identity = serde_json::json!({
        "targetText": "{name} and {name}",
        "protectedSpanMappings": [
            { "raw": "{name}", "targetStart": 0, "targetEnd": 6 },
            { "raw": "{name}", "targetStart": 11, "targetEnd": 17 }
        ]
    });
    let wrong_identity = serde_json::json!({
        "targetText": "{name} and {name}",
        "protectedSpanMappings": [
            {
                "raw": "{name}",
                "sourceSpanId": "019ed001-0000-7000-8000-000000000841",
                "sourceStartByte": 0,
                "sourceEndByte": 6,
                "targetStart": 0,
                "targetEnd": 6
            },
            {
                "raw": "{name}",
                "sourceSpanId": "019ed001-0000-7000-8000-000000000842",
                "sourceStartByte": 20,
                "sourceEndByte": 26,
                "targetStart": 11,
                "targetEnd": 17
            }
        ]
    });
    let reused_identity = serde_json::json!({
        "targetText": "{name} and {name}",
        "protectedSpanMappings": [
            {
                "raw": "{name}",
                "sourceSpanId": "019ed001-0000-7000-8000-000000000841",
                "sourceStartByte": 0,
                "sourceEndByte": 6,
                "targetStart": 0,
                "targetEnd": 6
            },
            {
                "raw": "{name}",
                "sourceSpanId": "019ed001-0000-7000-8000-000000000841",
                "sourceStartByte": 0,
                "sourceEndByte": 6,
                "targetStart": 11,
                "targetEnd": 17
            }
        ]
    });

    assert!(v02_patch_entry_span_mappings_compatible(
        &valid,
        source_unit
    ));
    assert!(!v02_patch_entry_span_mappings_compatible(
        &no_identity,
        source_unit
    ));
    assert!(!v02_patch_entry_span_mappings_compatible(
        &wrong_identity,
        source_unit
    ));
    assert!(!v02_patch_entry_span_mappings_compatible(
        &reused_identity,
        source_unit
    ));

    // A mapping whose `raw` is absent from the source unit's spans must
    // fail the compatibility gate (fail closed), not be silently skipped.
    // `{x}` matches the target text at 14..17 but is not a source span,
    // so the patch carries a span referencing a non-existent source span.
    let bogus_raw = serde_json::json!({
        "targetText": "{name} {name} {x}",
        "protectedSpanMappings": [
            {
                "raw": "{name}",
                "sourceSpanId": "019ed001-0000-7000-8000-000000000841",
                "sourceStartByte": 0,
                "sourceEndByte": 6,
                "targetStart": 0,
                "targetEnd": 6
            },
            {
                "raw": "{name}",
                "sourceSpanId": "019ed001-0000-7000-8000-000000000842",
                "sourceStartByte": 13,
                "sourceEndByte": 19,
                "targetStart": 7,
                "targetEnd": 13
            },
            {
                "raw": "{x}",
                "targetStart": 14,
                "targetEnd": 17
            }
        ]
    });
    assert!(!v02_patch_entry_span_mappings_compatible(
        &bogus_raw,
        source_unit
    ));
}

#[test]
fn shared_contract_fixture_suite_accepts_all_manifest_valid_fixtures() {
    let manifest = contract_fixture_manifest_v02_value();
    contracts::validate_shared_contract_fixture_v02("contract-fixtures-v0.2", &manifest)
        .expect("contract fixture manifest should validate in Rust");

    let valid_fixtures = manifest["validFixtures"]
        .as_array()
        .expect("manifest validFixtures should be an array");
    for fixture in valid_fixtures {
        let kind = fixture["kind"]
            .as_str()
            .expect("fixture kind should be a string");
        let path = fixture["path"]
            .as_str()
            .expect("fixture path should be a string");
        let value = contract_example_fixture_value(path);

        contracts::validate_shared_contract_fixture_v02(kind, &value).unwrap_or_else(|error| {
            panic!("{kind} fixture {path} failed Rust validation: {error}")
        });
    }
}

/// legacy (raw-only) protected spans are compatibility-
/// preserving: a duplicate `raw` value with no source identity is ALLOWED,
/// disambiguated by distinct target byte ranges. This locks in the documented
/// legacy v0.1 policy so it stays distinct from the strict v0.2 identity path.
#[test]
fn patch_export_v02_allows_duplicate_raw_legacy_spans_without_source_identity() {
    let mut fixture = contract_example_fixture_value("./patch-export-v0.2.json");
    // The same protected literal "{player}" recurs twice in one unit, each
    // occurrence carrying only `raw` + a distinct target range (no
    // sourceSpanId / sourceStartByte / sourceEndByte).
    fixture["entries"][0]["protectedSpanMappings"] = serde_json::json!([
        { "raw": "{player}", "targetStart": 0, "targetEnd": 8 },
        { "raw": "{player}", "targetStart": 20, "targetEnd": 28 },
    ]);
    contracts::validate_patch_export_v02(&fixture)
        .expect("legacy raw-only duplicate protected spans must stay compatibility-preserving");
}

/// v0.2 source-identity spans are strict: a duplicate
/// `sourceSpanId` within an entry is an identity collision and is rejected
/// with the typed diagnostic.
#[test]
fn patch_export_v02_rejects_duplicate_source_span_identity() {
    let mut fixture = contract_example_fixture_value("./patch-export-v0.2.json");
    fixture["entries"][0]["protectedSpanMappings"] = serde_json::json!([
        {
            "raw": "{player}",
            "sourceSpanId": "019ed001-0000-7000-8000-000000000801",
            "sourceStartByte": 0,
            "sourceEndByte": 8,
            "targetStart": 0,
            "targetEnd": 8
        },
        {
            "raw": "{other}",
            "sourceSpanId": "019ed001-0000-7000-8000-000000000801",
            "sourceStartByte": 9,
            "sourceEndByte": 16,
            "targetStart": 20,
            "targetEnd": 27
        },
    ]);
    let error = contracts::validate_patch_export_v02(&fixture)
        .expect_err("duplicate sourceSpanId must be rejected under strict v0.2 identity")
        .to_string();
    assert!(
        error.contains("kaifuu.patch_export.duplicate_source_span_identity"),
        "rejection must carry the typed diagnostic, got: {error}"
    );
}

/// the v0.2 identity path stays distinct from the legacy path
/// two spans with the SAME `raw` but DISTINCT `sourceSpanId`s are allowed
/// (the reordered/duplicate-raw case source identity exists to carry).
#[test]
fn patch_export_v02_allows_duplicate_raw_with_distinct_source_span_identity() {
    let mut fixture = contract_example_fixture_value("./patch-export-v0.2.json");
    fixture["entries"][0]["protectedSpanMappings"] = serde_json::json!([
        {
            "raw": "{player}",
            "sourceSpanId": "019ed001-0000-7000-8000-000000000801",
            "sourceStartByte": 0,
            "sourceEndByte": 8,
            "targetStart": 0,
            "targetEnd": 8
        },
        {
            "raw": "{player}",
            "sourceSpanId": "019ed001-0000-7000-8000-000000000802",
            "sourceStartByte": 20,
            "sourceEndByte": 28,
            "targetStart": 20,
            "targetEnd": 28
        },
    ]);
    contracts::validate_patch_export_v02(&fixture)
        .expect("duplicate raw with distinct source identity must stay allowed under v0.2");
}

#[test]
fn shared_contract_fixture_suite_accepts_permission_local_user_grants() {
    let fixture = contract_example_fixture_value("./permission-local-user-v0.2.json");
    let grants = fixture["grants"]
        .as_array()
        .expect("permission fixture grants should be an array");

    assert!(
        grants
            .iter()
            .any(|grant| grant.as_str() == Some("queue.read")),
        "shared permission fixture should include queue.read"
    );
    contracts::validate_permission_local_user_fixture_v02(&fixture)
        .expect("Rust permission validator should accept queue.read");
}

#[test]
fn shared_contract_fixture_suite_rejects_alpha_proof_hash_link_mutations() {
    let mut fixture = alpha_proof_fixture_value();
    fixture["contentHashes"]
        .as_array_mut()
        .expect("contentHashes should be an array")
        .retain(|entry| entry["scope"].as_str() != Some("provider_proof"));
    expect_alpha_proof_error(fixture, "contentHashes must include provider_proof");

    let mut fixture = alpha_proof_fixture_value();
    fixture["contentHashes"]
        .as_array_mut()
        .expect("contentHashes should be an array")
        .retain(|entry| entry["scope"].as_str() != Some("bridge_unit"));
    expect_alpha_proof_error(fixture, "contentHashes must include bridge_unit");

    let mut fixture = alpha_proof_fixture_value();
    let provider_hash = fixture["contentHashes"]
        .as_array_mut()
        .expect("contentHashes should be an array")
        .iter_mut()
        .find(|entry| entry["scope"].as_str() == Some("provider_proof"))
        .expect("provider proof hash should exist");
    provider_hash["contentId"] = serde_json::json!("019ed025-0000-7000-8000-000000000202");
    expect_alpha_proof_error(fixture, "providerProofIds[0]");

    let mut fixture = alpha_proof_fixture_value();
    let patch_export_hash = fixture["contentHashes"]
        .as_array_mut()
        .expect("contentHashes should be an array")
        .iter_mut()
        .find(|entry| entry["scope"].as_str() == Some("patch_export"))
        .expect("patch export hash should exist");
    patch_export_hash["contentId"] =
        serde_json::json!("fixtures/hello-game/expected/patch-export-other.json");
    expect_alpha_proof_error(fixture, "artifactRefs.patch_export.hash");
}
