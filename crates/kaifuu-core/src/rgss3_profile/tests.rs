use super::*;

#[test]
fn canonical_profile_validates_green() {
    let profile = Rgss3LayeredTransformProfile::canonical();
    let report = validate_rgss3_profile(&profile);
    assert!(report.is_ok(), "{report:#?}");
    assert!(report.findings.is_empty());
    // The engine family token is the canonical `rgss3`, distinct from MV/MZ.
    assert_eq!(profile.engine_family, "rgss3");
    assert_ne!(profile.engine_family, "rpg_maker_mv_mz");
    // Layered transform fields are pinned to the RGSS3 stack.
    assert_eq!(profile.container, ContainerTransform::Rgssad);
    assert_eq!(profile.crypto, CryptoTransform::Xor);
    assert_eq!(profile.codec, CodecTransform::RubyMarshal);
    assert_eq!(profile.surface, SurfaceTransform::ArchiveEntry);
    assert_eq!(profile.patch_back, PatchBackTransform::RepackArchive);
}

#[test]
fn profile_round_trips_through_json() {
    let profile = Rgss3LayeredTransformProfile::canonical();
    let json = serde_json::to_string(&profile).expect("serialize");
    let back: Rgss3LayeredTransformProfile = serde_json::from_str(&json).expect("round trip");
    assert_eq!(profile, back);
}

#[test]
fn wrong_codec_is_a_typed_finding() {
    let mut profile = Rgss3LayeredTransformProfile::canonical();
    profile.codec = CodecTransform::JsonText;
    let report = validate_rgss3_profile(&profile);
    assert_eq!(report.status, OperationStatus::Failed);
    let finding = report
        .findings
        .iter()
        .find(|f| f.code == "rgss3.profile.wrong_codec")
        .expect("codec finding");
    assert_eq!(
        finding.semantic_code,
        SemanticErrorCode::MissingCodecCapability.as_str()
    );
    assert!(finding.severity.is_blocking());
}

#[test]
fn every_required_patch_back_dependency_is_declared() {
    let profile = Rgss3LayeredTransformProfile::canonical();
    for required in Rgss3PatchBackDependency::required() {
        assert!(
            profile
                .patch_back_dependencies
                .iter()
                .any(|d| d.dependency == required && d.satisfied),
            "missing satisfied dependency {}",
            required.as_str()
        );
    }
}

#[test]
fn missing_patch_back_dependency_fails() {
    let mut profile = Rgss3LayeredTransformProfile::canonical();
    profile
        .patch_back_dependencies
        .retain(|d| d.dependency != Rgss3PatchBackDependency::XorKeystreamReproduced);
    let report = validate_rgss3_profile(&profile);
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(
        report
            .findings
            .iter()
            .any(|f| f.code == "rgss3.profile.patch_back_dependency_missing")
    );
}

#[test]
fn unsatisfied_patch_back_dependency_fails() {
    let mut profile = Rgss3LayeredTransformProfile::canonical();
    for decl in &mut profile.patch_back_dependencies {
        if decl.dependency == Rgss3PatchBackDependency::MarshalStructurePreserved {
            decl.satisfied = false;
        }
    }
    let report = validate_rgss3_profile(&profile);
    assert_eq!(report.status, OperationStatus::Failed);
    let finding = report
        .findings
        .iter()
        .find(|f| f.code == "rgss3.profile.patch_back_dependency_unsatisfied")
        .expect("unsatisfied finding");
    assert_eq!(
        finding.semantic_code,
        SemanticErrorCode::MissingCodecCapability.as_str()
    );
}

#[test]
fn report_stable_json_redacts_and_serializes() {
    let mut profile = Rgss3LayeredTransformProfile::canonical();
    profile.profile_id = "/home/trevor/private/leak.rgss3a".to_string();
    profile.codec = CodecTransform::Unknown;
    let report = validate_rgss3_profile(&profile);
    let json = report.stable_json().expect("stable json");
    assert!(json.ends_with('\n'));
    assert!(!json.contains("/home/trevor/private/leak.rgss3a"));
}

#[test]
fn marshal_long_matches_known_ruby_encodings() {
    // Known Marshal `long` encodings (verified against Ruby's Marshal.dump).
    for (value, expected) in [
        (0i64, vec![0x00u8]),
        (1, vec![0x06]),
        (122, vec![0x7f]),
        (123, vec![0x01, 0x7b]),
        (256, vec![0x02, 0x00, 0x01]),
        (-1, vec![0xfa]),
        (-123, vec![0x80]),
        (-124, vec![0xff, 0x84]),
    ] {
        let mut out = Vec::new();
        write_long(value, &mut out);
        assert_eq!(out, expected, "encoding of {value}");
        // And the reader inverts the writer.
        let mut reader = MarshalReader::new(&out);
        assert_eq!(reader.read_long().unwrap(), value, "decoding of {value}");
    }
}

#[test]
fn synthetic_marshal_blob_decodes_to_its_structure() {
    let value = synthetic_rvdata2_value();
    let blob = write_marshal(&value);
    // The blob carries the real Marshal 4.8 header.
    assert_eq!(&blob[0..2], &[0x04, 0x08]);

    let decoded = read_marshal(&blob).expect("decode");
    assert_eq!(decoded, value);

    // Spot-check the decoded structure matches the KNOWN values.
    let MarshalValue::Array(items) = &decoded else {
        panic!("expected top-level array");
    };
    assert_eq!(items[0], MarshalValue::Int(3));
    assert_eq!(
        items[1].as_str_lossy().as_deref(),
        Some("synthetic game title")
    );
    assert_eq!(items[2], MarshalValue::Symbol("vx_ace".to_string()));
    let MarshalValue::Hash(pairs) = &items[3] else {
        panic!("expected nested hash");
    };
    assert_eq!(pairs[0].0, MarshalValue::Symbol("greeting".to_string()));
    assert_eq!(pairs[0].1.as_str_lossy().as_deref(), Some("hello world"));
    assert_eq!(pairs[2].1, MarshalValue::Nil);
}

#[test]
fn marshal_write_read_is_structure_preserving() {
    // The MarshalStructurePreserved patch-back dependency: encode(decode(x))
    // is byte-identical for a canonical stream. This is the executable proof
    // behind the profile's patch-back constraint.
    let blob = write_marshal(&synthetic_rvdata2_value());
    let decoded = read_marshal(&blob).expect("decode");
    let reencoded = write_marshal(&decoded);
    assert_eq!(
        blob, reencoded,
        "re-serialised Marshal must be byte-identical"
    );
}

#[test]
fn marshal_reads_ivar_wrapped_string_transparently() {
    // A hand-built IVAR-wrapped string as real VX Ace writes it:
    // I "hi" <ivar_count=1>:E T (encoding = UTF-8)
    let mut blob = vec![0x04u8, 0x08];
    blob.push(b'I');
    blob.push(b'"');
    write_long(2, &mut blob);
    blob.extend_from_slice(b"hi");
    write_long(1, &mut blob); // one ivar
    blob.push(b':');
    write_long(1, &mut blob);
    blob.push(b'E');
    blob.push(b'T'); // true = UTF-8

    let decoded = read_marshal(&blob).expect("decode ivar string");
    assert_eq!(decoded, MarshalValue::ByteString(b"hi".to_vec()));
}

#[test]
fn marshal_symbol_backlink_resolves() {
    // Two symbols where the second is a back-link (`;`) to the first —
    // exactly how Ruby dedups repeated symbol keys.
    let mut blob = vec![0x04u8, 0x08];
    blob.push(b'[');
    write_long(2, &mut blob);
    blob.push(b':'); // define symbol 0
    write_long(3, &mut blob);
    blob.extend_from_slice(b"tag");
    blob.push(b';'); // link to symbol 0
    write_long(0, &mut blob);

    let decoded = read_marshal(&blob).expect("decode symlink");
    assert_eq!(
        decoded,
        MarshalValue::Array(vec![
            MarshalValue::Symbol("tag".to_string()),
            MarshalValue::Symbol("tag".to_string()),
        ])
    );
}

#[test]
fn marshal_errors_are_typed_not_panics() {
    assert_eq!(read_marshal(&[]).unwrap_err(), MarshalError::UnexpectedEof);
    assert_eq!(
        read_marshal(&[0x04, 0x07, b'0']).unwrap_err(),
        MarshalError::BadVersion { major: 4, minor: 7 }
    );
    // 'c' (class) is outside the supported subset → typed error.
    assert_eq!(
        read_marshal(&[0x04, 0x08, b'c']).unwrap_err(),
        MarshalError::UnsupportedType(b'c')
    );
}

#[test]
fn synthetic_rgss3a_round_trips() {
    let scheme = Rgss3XorKeystreamScheme::rgss3();
    // One payload is itself a Marshal blob (a real `.rvdata2` shape).
    let marshal_payload = write_marshal(&synthetic_rvdata2_value());
    let entries: Vec<(&str, &[u8])> = vec![
        ("Data/System.rvdata2", marshal_payload.as_slice()),
        (
            "Data/Map001.rvdata2",
            b"synthetic map bytes \x00\x01\x02\x03\x04",
        ),
    ];
    let archive = build_synthetic_rgss3a(scheme, 0x1234_5678, &entries);

    // Header is the real RGSSAD signature + version 3.
    assert_eq!(&archive[0..7], &RGSSAD_MAGIC);
    assert_eq!(archive[7], RGSS3_ARCHIVE_VERSION);

    let decoded = decode_synthetic_rgss3a(scheme, &archive).expect("decode archive");
    assert_eq!(decoded.len(), 2);
    assert_eq!(decoded[0].name, "Data/System.rvdata2");
    assert_eq!(decoded[0].payload, marshal_payload);
    assert_eq!(decoded[1].name, "Data/Map001.rvdata2");
    assert_eq!(
        decoded[1].payload,
        b"synthetic map bytes \x00\x01\x02\x03\x04"
    );

    // End-to-end: the extracted RGSSAD payload decodes as Marshal — the full
    // layered transform (container -> crypto -> codec) on synthetic bytes.
    let inner = read_marshal(&decoded[0].payload).expect("decode extracted marshal");
    assert_eq!(inner, synthetic_rvdata2_value());
}

#[test]
fn rgss3a_payload_is_actually_obfuscated() {
    // The archive must not contain the plaintext payload verbatim — the XOR
    // keystream is really applied.
    let scheme = Rgss3XorKeystreamScheme::rgss3();
    let plaintext = b"the quick brown fox jumps over the lazy dog!!";
    let archive = build_synthetic_rgss3a(scheme, 42, &[("a.rvdata2", plaintext)]);
    assert!(
        !archive.windows(plaintext.len()).any(|w| w == plaintext),
        "payload must be XOR-obfuscated in the archive"
    );
    let decoded = decode_synthetic_rgss3a(scheme, &archive).expect("decode");
    assert_eq!(decoded[0].payload, plaintext);
}

#[test]
fn rgss3a_wrong_magic_is_typed_error() {
    let scheme = Rgss3XorKeystreamScheme::rgss3();
    assert_eq!(
        decode_synthetic_rgss3a(scheme, b"NOTRGSS\x03....").unwrap_err(),
        RgssadError::BadMagic
    );
}

#[test]
fn keystream_scheme_derivation_is_deterministic() {
    let scheme = Rgss3XorKeystreamScheme::rgss3();
    assert_eq!(scheme.base_key(0), 3);
    assert_eq!(scheme.base_key(1), 12);
    assert_eq!(scheme.advance(3), 24);
}
