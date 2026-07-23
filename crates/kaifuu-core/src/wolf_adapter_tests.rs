use super::*;

fn fixture() -> WolfTextTableAdapterFixture {
    WolfTextTableAdapterFixture::synthetic()
}

#[test]
fn text_table_codec_round_trips_shift_jis() {
    let table = WolfTextTable {
        table_name: "CharacterDB".to_string(),
        field_count: 2,
        records: vec![
            vec!["hero".to_string(), "テスト".to_string()],
            vec!["mage".to_string(), "説明".to_string()],
        ],
    };
    let bytes = encode_wolf_text_table(&table).expect("encode");
    let decoded = decode_wolf_text_table(&bytes).expect("decode");
    assert_eq!(decoded, table);
}

#[test]
fn text_table_bytes_are_shift_jis_not_utf8() {
    // A multi-byte Japanese cell must be stored as Shift-JIS, so the UTF-8
    // byte sequence must NOT appear verbatim in the encoded table.
    let table = WolfTextTable {
        table_name: "T".to_string(),
        field_count: 1,
        records: vec![vec!["テスト".to_string()]],
    };
    let bytes = encode_wolf_text_table(&table).expect("encode");
    let utf8 = "テスト".as_bytes();
    assert!(
        !bytes.windows(utf8.len()).any(|window| window == utf8),
        "UTF-8 bytes leaked into the Shift-JIS table"
    );
}

// --- THE crux: the extract → patch round-trip on the synthetic fixture. --

#[test]
fn adapter_extracts_and_patches_text_tables_round_trip() {
    let report = run_wolf_text_table_adapter(&fixture()).expect("adapter runs");
    assert_eq!(report.outcome, WolfAdapterOutcome::Supported);
    assert_eq!(report.status, OperationStatus::Passed);
    assert_eq!(report.protection_profile, WolfProtectionProfile::Protected);
    assert_eq!(
        report.helper_outcome,
        Some(WolfHelperBoundaryOutcome::KeyResolved)
    );

    // All three tables extracted.
    assert_eq!(report.extract_manifest.len(), 3);
    // Two tables patched (CharacterDB + SystemStrings); MenuStrings untouched.
    assert_eq!(report.patch_reports.len(), 2);
    for patch in &report.patch_reports {
        assert!(patch.patched_text_verified);
        // Every patch changed the member bytes (hashes differ).
        assert_ne!(
            patch.source_member_hash.as_str(),
            patch.patched_member_hash.as_str()
        );
    }

    // `layout_changed` proves EXACTLY the offset-table rewrite it claims —
    // not merely that bytes differ. The CharacterDB patch lengthens a cell, so
    // downstream offsets are rewritten (true). The SystemStrings patch is a
    // same-length swap ("=start" -> "=begin"): the member bytes differ but the
    // (offset,len) index is untouched, so it is honestly false.
    let character = report
        .patch_reports
        .iter()
        .find(|report| report.table_name == "CharacterDB")
        .expect("CharacterDB was patched");
    let system = report
        .patch_reports
        .iter()
        .find(|report| report.table_name == "SystemStrings")
        .expect("SystemStrings was patched");
    assert!(
        character.layout_changed,
        "a length-changing patch must rewrite the offset table"
    );
    assert_eq!(
        character
            .source_member_byte_len
            .cmp(&character.patched_member_byte_len),
        std::cmp::Ordering::Less,
        "the CharacterDB member grew (its cell got longer)"
    );
    assert!(
        !system.layout_changed,
        "a same-length patch must NOT be reported as an offset-table rewrite"
    );
    assert_eq!(
        system.source_member_byte_len, system.patched_member_byte_len,
        "the same-length patch keeps the member byte length"
    );
    assert_ne!(
        system.source_member_hash.as_str(),
        system.patched_member_hash.as_str(),
        "the same-length patch still changed the member bytes"
    );

    // One unchanged table (MenuStrings) is verified byte-identical.
    assert_eq!(report.unchanged_tables_verified, 1);
    assert_ne!(
        report.source_archive_hash.as_ref().unwrap().as_str(),
        report.rebuilt_archive_hash.as_ref().unwrap().as_str()
    );
    assert!(report.verify_proof.is_some());
}

#[test]
fn unchanged_tables_are_byte_identical() {
    let mut fixture = fixture();
    // Patch only the first table.
    fixture
        .patches
        .retain(|patch| patch.table_name == "CharacterDB");
    let report = run_wolf_text_table_adapter(&fixture).expect("adapter runs");
    assert_eq!(report.patch_reports.len(), 1);
    // The untouched SystemStrings + MenuStrings tables are verified
    // byte-identical after repack.
    assert_eq!(report.unchanged_tables_verified, 2);
}

#[test]
fn adapter_is_engine_general_data_driven() {
    let mut fixture = fixture();
    // Swap in a completely different table set + patch (a different "game").
    fixture.tables = vec![WolfTextTable {
        table_name: "ItemDB".to_string(),
        field_count: 1,
        records: vec![vec!["potion=synthetic".to_string()]],
    }];
    fixture.patches = vec![WolfTextPatchRequest {
        table_name: "ItemDB".to_string(),
        record_index: 0,
        field_index: 0,
        new_text: "elixir=synthetic".to_string(),
    }];
    let report = run_wolf_text_table_adapter(&fixture).expect("adapter runs");
    assert_eq!(report.outcome, WolfAdapterOutcome::Supported);
    assert_eq!(report.extract_manifest.len(), 1);
    assert_eq!(report.patch_reports.len(), 1);
    assert!(report.patch_reports[0].patched_text_verified);
}

#[test]
fn report_is_redaction_clean_and_keys_are_ref_only() {
    let report = run_wolf_text_table_adapter(&fixture()).expect("adapter runs");
    let json = report.stable_json().expect("stable json");
    // The reportable secret ref survives; the raw key does not.
    assert!(json.contains(WOLF_ENCRYPTED_SMOKE_VALID_SECRET_REF));
    assert!(!json.contains("K073-WOLF-FIXTURE"));
    // No decoded table text (ASCII or Shift-JIS UTF-8) leaks.
    assert!(!json.contains("synthetic-menu=start"));
    assert!(!json.contains("テスト説明A"));
    assert!(!json.contains("テスト説明A-改"));
    // No private paths.
    assert!(!json.contains("/home/"));
    assert!(!json.contains("/scratch/"));
    // It cites the smoke evidence.
    assert!(json.contains(WOLF_ADAPTER_CITED_SMOKE_CAPABILITY_ID));
}

#[test]
fn report_redacts_local_paths_in_ids() {
    let mut fixture = fixture();
    fixture.fixture_id = "/home/trevor/private/wolf/leak.wolf".to_string();
    let report = run_wolf_text_table_adapter(&fixture).expect("adapter runs");
    let json = report.stable_json().expect("stable json");
    assert!(json.contains("[REDACTED:"));
    assert!(!json.contains("/home/trevor/private/wolf/leak.wolf"));
}

#[test]
fn missing_key_is_unsupported_with_semantic_diagnostic() {
    let mut fixture = fixture();
    // Flip the helper boundary to key-unavailable and swap in a missing ref.
    let secret_ref =
        SecretRef::new(crate::wolf_encrypted_smoke::WOLF_ENCRYPTED_SMOKE_MISSING_SECRET_REF)
            .unwrap();
    fixture.secret_ref = secret_ref.clone();
    fixture.helper_boundary = Some(synthetic_helper_profile(&secret_ref, false));

    let report = run_wolf_text_table_adapter(&fixture).expect("adapter runs (unsupported)");
    assert_eq!(report.outcome, WolfAdapterOutcome::Unsupported);
    assert!(report.extract_manifest.is_empty());
    assert!(report.patch_reports.is_empty());
    assert_eq!(report.capability_diagnostics.len(), 1);
    let diagnostic = &report.capability_diagnostics[0];
    assert_eq!(
        diagnostic.semantic_code,
        SemanticErrorCode::MissingKeyMaterial.as_str()
    );
    // The claimed-support tuple context is present + never claims extract/patch.
    assert!(diagnostic.claimed_support.extract.is_unsupported());
    assert!(diagnostic.claimed_support.patch.is_unsupported());
    // No key material hash is emitted for an unsupported variant.
    assert!(report.key_material_hash.is_none());
}

#[test]
fn failed_helper_posture_is_unsupported_and_not_bypassable() {
    let mut fixture = fixture();
    // A helper-boundary profile whose derived outcome is `key_resolved`
    // (static-key import, key locally available) but which FAILS its own
    // validation: the declared expectation lies about the outcome
    // so the boundary raises a finding and reports status=Failed. A gate that
    // only read the outcome would wave this straight through to extract/patch.
    let mut profile = synthetic_helper_profile(&fixture.secret_ref, true);
    profile.expected_outcome = WolfHelperBoundaryOutcome::HelperUnavailable;
    fixture.helper_boundary = Some(profile.clone());

    // Bait check: the boundary itself STILL derives `key_resolved` (the value
    // a bypassable gate would have trusted) even though its status is Failed.
    let boundary = run_wolf_helper_boundary(&WolfHelperBoundaryFixture {
        schema_version: crate::wolf_helper_boundary::WOLF_HELPER_BOUNDARY_SCHEMA_VERSION
            .to_string(),
        boundary_set_id: "wolf-adapter/gate-test/helper-boundary".to_string(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        profiles: vec![profile],
    });
    let entry = &boundary.entries[0];
    assert_eq!(entry.outcome, WolfHelperBoundaryOutcome::KeyResolved);
    assert_eq!(entry.status, OperationStatus::Failed);
    assert!(!entry.findings.is_empty());

    // The honest gate refuses: Unsupported, no extract/patch, no key material.
    let report = run_wolf_text_table_adapter(&fixture).expect("adapter runs (unsupported)");
    assert_eq!(report.outcome, WolfAdapterOutcome::Unsupported);
    assert!(report.extract_manifest.is_empty());
    assert!(report.patch_reports.is_empty());
    assert!(report.key_material_hash.is_none());
    assert!(report.source_archive_hash.is_none());
    // The report still records the derived outcome for provenance...
    assert_eq!(
        report.helper_outcome,
        Some(WolfHelperBoundaryOutcome::KeyResolved)
    );
    // ...proving the gate refused DESPITE a key_resolved outcome: the diagnostic
    // is a key-validation failure, and the tuple never claims extract/patch.
    assert_eq!(report.capability_diagnostics.len(), 1);
    let diagnostic = &report.capability_diagnostics[0];
    assert_eq!(
        diagnostic.semantic_code,
        SemanticErrorCode::KeyValidationFailed.as_str()
    );
    assert!(diagnostic.claimed_support.extract.is_unsupported());
    assert!(diagnostic.claimed_support.patch.is_unsupported());
}

#[test]
fn unknown_protection_variant_is_unsupported() {
    use crate::wolf_protection_detector::WolfArchiveProtectionSignal;
    let mut fixture = fixture();
    // Unrecognized protection → detector classifies Unknown.
    fixture.detector.protection_signal = WolfArchiveProtectionSignal::UnrecognizedProtection;
    fixture.detector.crypto = CryptoTransform::Unknown;
    fixture.detector.secret_requirements = vec![];
    fixture.detector.expected_profile = WolfProtectionProfile::Unknown;
    fixture.detector.expected_semantic_codes =
        vec![SemanticErrorCode::UnknownEngineVariant.as_str().to_string()];
    fixture.helper_boundary = None;

    let report = run_wolf_text_table_adapter(&fixture).expect("adapter runs (unsupported)");
    assert_eq!(report.outcome, WolfAdapterOutcome::Unsupported);
    assert_eq!(report.protection_profile, WolfProtectionProfile::Unknown);
    assert_eq!(
        report.capability_diagnostics[0].semantic_code,
        SemanticErrorCode::UnsupportedVariantEncrypted.as_str()
    );
}

#[test]
fn out_of_range_patch_is_typed_error() {
    let mut fixture = fixture();
    fixture.patches = vec![WolfTextPatchRequest {
        table_name: "CharacterDB".to_string(),
        record_index: 99,
        field_index: 0,
        new_text: "x".to_string(),
    }];
    let err = run_wolf_text_table_adapter(&fixture).expect_err("out-of-range patch fails");
    assert!(matches!(err, WolfAdapterError::PatchTargetMissing { .. }));
    assert!(err.to_string().starts_with(WOLF_ADAPTER_MARKER));
}

#[test]
fn report_round_trips_through_json() {
    let report = run_wolf_text_table_adapter(&fixture()).expect("adapter runs");
    let json = serde_json::to_string(&report.redacted_for_report()).expect("serialize");
    let round: WolfTextTableAdapterReport = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(round, report.redacted_for_report());
}

#[test]
fn fixture_loads_from_disk_and_round_trips() {
    let path = crate::test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/wolf/adapter.text-table.json");
    let report = run_wolf_text_table_adapter_from_path(&path).expect("adapter runs from path");
    assert_eq!(report.outcome, WolfAdapterOutcome::Supported);
    assert_eq!(report.extract_manifest.len(), 3);
    // The disk fixture carries an UNCHANGED table (MenuStrings) with no patch
    // request, so the byte-identical property is genuinely exercised: exactly
    // one unchanged table is verified byte-identical after repack.
    assert_eq!(report.patch_reports.len(), 2);
    assert_eq!(report.unchanged_tables_verified, 1);
}

#[test]
fn synthetic_fixture_uses_a_local_secret_ref() {
    assert_eq!(
        fixture().secret_ref.scheme(),
        crate::SecretRefScheme::LocalSecret
    );
}
