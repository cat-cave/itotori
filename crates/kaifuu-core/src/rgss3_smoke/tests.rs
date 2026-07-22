use super::*;

#[test]
fn smoke_passes_and_verifies_all_layers() {
    let report = generate_rgss3_smoke().expect("smoke runs");
    assert_eq!(report.status, OperationStatus::Passed, "{report:#?}");
    assert!(report.findings.is_empty(), "{:#?}", report.findings);
    assert_eq!(report.engine_family, "rgss3");
    // The layered-transform metadata is present and pinned.
    assert_eq!(report.layers.container_transform, "rgssad");
    assert_eq!(report.layers.crypto_transform, "xor");
    assert_eq!(report.layers.codec_transform, "ruby_marshal");
    assert_eq!(report.layers.patch_back_transform, "repack_archive");
    assert!(report.layers.entry_names_preserved);
    assert!(report.layers.keystream_reproduced);
    assert_eq!(report.layers.entry_count, 2);
}

#[test]
fn extracts_text_bearing_data() {
    let report = generate_rgss3_smoke().expect("smoke runs");
    // Title, 3 messages, speaker = 5 text units, all from System.rvdata2.
    let texts: Vec<&str> = report.text_units.iter().map(|u| u.text.as_str()).collect();
    assert!(texts.contains(&"Prologue"));
    assert!(texts.contains(&"Hello, traveler."));
    assert!(texts.contains(&"Welcome to the village."));
    assert!(texts.contains(&"Safe travels."));
    assert!(texts.contains(&"Guide"));
    assert_eq!(report.text_units.len(), 5);
    assert!(
        report
            .text_units
            .iter()
            .all(|u| u.entry_id == "Data/System.rvdata2"),
        "opaque Title.png contributes no text units"
    );
}

#[test]
fn identity_round_trip_is_byte_preserving() {
    let scheme = Rgss3XorKeystreamScheme::rgss3();
    let source = build_fixture_archive(scheme);
    let extraction = extract_rgss3(scheme, &source).expect("extract");
    let rebuilt = rebuild_rgss3(&extraction);
    assert_eq!(
        rebuilt, source,
        "rebuild(extract(x)) must equal x byte-for-byte"
    );

    let report = generate_rgss3_smoke().expect("smoke runs");
    assert!(report.identity.byte_identical);
    assert_eq!(
        report.identity.source_hash.as_str(),
        report.identity.rebuilt_hash.as_str()
    );
}

#[test]
fn trivial_change_applied_and_isolated() {
    let report = generate_rgss3_smoke().expect("smoke runs");
    assert!(report.patch.change_applied);
    assert_eq!(report.patch.entry_id, "Data/System.rvdata2");
    assert_eq!(report.patch.old_text, "Prologue");
    assert_eq!(report.patch.new_text, "Josho: Tabidachi no Hi");
    // A length-changing localization proves offsets/bounds were recomputed.
    assert_ne!(report.patch.length_delta, 0);
    // The patched entry diverges at exactly the one localized Marshal path.
    assert_eq!(report.patch.diverging_paths.len(), 1);
    // Every other entry is byte-identical.
    assert!(report.patch.other_entries_byte_identical);
}

#[test]
fn patched_rebuild_isolates_the_change_at_byte_level() {
    // Directly prove: only the System entry's decrypted payload changes; the
    // opaque asset entry is byte-identical across the patched rebuild.
    let scheme = Rgss3XorKeystreamScheme::rgss3();
    let source = build_fixture_archive(scheme);
    let mut extraction = extract_rgss3(scheme, &source).expect("extract");
    let path = MarshalPath(vec![
        MarshalStep::Index(2),
        MarshalStep::HashValueAt(0),
        MarshalStep::Index(0),
    ]);
    let old = extraction.localize(0, &path, "localized").expect("patch");
    assert_eq!(old, "Hello, traveler.");
    let rebuilt = rebuild_rgss3(&extraction);

    let src = decode_synthetic_rgss3a(scheme, &source).unwrap();
    let pat = decode_synthetic_rgss3a(scheme, &rebuilt).unwrap();
    assert_eq!(src[1].name, "Graphics/Titles/Title.png");
    assert_eq!(src[1].payload, pat[1].payload, "opaque entry unchanged");
    assert_ne!(src[0].payload, pat[0].payload, "patched entry changed");
}

#[test]
fn unsupported_cases_are_typed_and_rejected() {
    let report = generate_rgss3_smoke().expect("smoke runs");
    assert_eq!(report.unsupported.len(), 4);
    for case in &report.unsupported {
        assert!(
            case.rejected_before_rebuild,
            "case {} must be rejected with a typed diagnostic",
            case.case_id
        );
        assert!(!case.semantic_code.is_empty());
    }
    let by_kind =
        |kind: Rgss3UnsupportedKind| report.unsupported.iter().find(|c| c.kind == kind).unwrap();
    assert_eq!(
        by_kind(Rgss3UnsupportedKind::BadContainer).semantic_code,
        SemanticErrorCode::MissingContainerCapability.as_str()
    );
    assert_eq!(
        by_kind(Rgss3UnsupportedKind::UnsupportedMarshalType).semantic_code,
        SemanticErrorCode::MissingCodecCapability.as_str()
    );
    assert_eq!(
        by_kind(Rgss3UnsupportedKind::ScriptsOutOfScope).semantic_code,
        SemanticErrorCode::UnsupportedLayeredTransform.as_str()
    );
    assert_eq!(
        by_kind(Rgss3UnsupportedKind::PatchTargetNotText).semantic_code,
        SemanticErrorCode::MissingCodecCapability.as_str()
    );
}

#[test]
fn extract_bad_container_is_typed_error() {
    let scheme = Rgss3XorKeystreamScheme::rgss3();
    let error = extract_rgss3(scheme, b"NOTRGSS\x03 nope").unwrap_err();
    assert!(matches!(
        error,
        Rgss3ExtractError::Container(RgssadError::BadMagic)
    ));
    assert_eq!(
        error.semantic_code(),
        SemanticErrorCode::MissingContainerCapability
    );
}

#[test]
fn extract_unsupported_marshal_type_is_typed_error() {
    let scheme = Rgss3XorKeystreamScheme::rgss3();
    let archive = build_synthetic_rgss3a(scheme, 1, &[("Data/Bad.rvdata2", &[0x04, 0x08, b'c'])]);
    let error = extract_rgss3(scheme, &archive).unwrap_err();
    assert!(matches!(
        error,
        Rgss3ExtractError::Codec {
            error: MarshalError::UnsupportedType(b'c'),
            ..
        }
    ));
}

#[test]
fn patch_non_text_leaf_is_typed_error() {
    let scheme = Rgss3XorKeystreamScheme::rgss3();
    let source = build_fixture_archive(scheme);
    let mut extraction = extract_rgss3(scheme, &source).unwrap();
    let int_path = MarshalPath(vec![MarshalStep::Index(0)]);
    let error = extraction.localize(0, &int_path, "x").unwrap_err();
    assert!(matches!(error, Rgss3PatchError::NotATextLeaf { .. }));
}

#[test]
fn report_stable_json_redacts_and_serializes() {
    let report = generate_rgss3_smoke().expect("smoke runs");
    let json = report.stable_json().expect("stable json");
    assert!(json.ends_with('\n'));
    // The synthetic text units survive (they are public, not secrets).
    assert!(json.contains("Data/System.rvdata2"));
    // Round-trips through serde.
    let back: Rgss3SmokeReport = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(back.status, report.status);
}

#[test]
fn marshal_path_locator_is_stable() {
    let path = MarshalPath(vec![
        MarshalStep::Index(2),
        MarshalStep::HashValueAt(0),
        MarshalStep::Index(1),
    ]);
    assert_eq!(path.locator(), "[2].{0}[1]");
}

#[test]
fn structural_diff_pinpoints_single_change() {
    let a = synthetic_text_bearing_value();
    let mut b = a.clone();
    // Change the speaker string (path [2].{1}).
    if let MarshalValue::Array(items) = &mut b
        && let MarshalValue::Hash(pairs) = &mut items[2]
    {
        pairs[1].1 = MarshalValue::ByteString(b"Narrator".to_vec());
    }
    let diff = marshal_structural_diff(&a, &b);
    assert_eq!(diff.len(), 1);
    assert_eq!(diff[0].locator(), "[2].{1}");
}
