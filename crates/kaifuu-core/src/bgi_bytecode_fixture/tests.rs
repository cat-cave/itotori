use super::*;

use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    crate::test_manifest_dir()
        .join("../..")
        .join("fixtures/kaifuu/bgi")
}

fn load() -> BgiBytecodeFixture {
    read_bgi_bytecode_fixture(&fixtures_dir().join("bytecode.profiles.json"))
        .expect("BGI bytecode fixture must parse")
}

fn run() -> BgiBytecodeReport {
    run_bgi_bytecode_fixture(&load())
}

#[test]
fn bytecode_profiles_pass_and_record_kaifuu_085_fields() {
    let report = run();
    assert_eq!(report.status, OperationStatus::Passed, "{report:#?}");
    assert_eq!(report.engine_family, crate::BGI_ENGINE_FAMILY);
    assert_eq!(report.source_node_id, load().source_node_id);
    assert_eq!(report.entries.len(), 2);

    for entry in &report.entries {
        assert_eq!(entry.status, OperationStatus::Passed, "{entry:#?}");
        assert_eq!(entry.engine_family, crate::BGI_ENGINE_FAMILY);
        assert_eq!(entry.container, BgiBytecodeContainer::Bytecode);
        assert_eq!(entry.crypto, BgiBytecodeCrypto::None);
        assert_eq!(entry.codec, BgiBytecodeCodec::ShiftJis);
        assert_eq!(entry.surface, BgiBytecodeSurface::StringReference);
        assert_eq!(
            entry.parser_surface.surface_transform,
            SurfaceTransform::BinaryOffset
        );
        assert_eq!(
            entry.parser_surface.pointer_base,
            "code_size_relative_text_offset"
        );
        assert_eq!(entry.proof_hashes, vec![entry.source_hash.clone()]);
        assert!(!entry.string_references.is_empty());
        assert!(!entry.patch_reports.is_empty());
        assert!(entry.patch_reports.iter().all(|patch| patch.patch_back
            == PatchBackTransform::RecompileBytecode
            && patch.patched_text_verified
            && patch.untouched_bytes_identical));
        assert!(entry.negative_cases.len() >= 3);
        assert!(
            entry.negative_cases.iter().all(|case| case.rejected),
            "{entry:#?}"
        );
    }
}

#[test]
fn header_and_no_header_parser_surfaces_are_exact() {
    let report = run();
    let header = report.entry("bgi.bytecode.header").unwrap();
    assert_eq!(header.variant, BgiBytecodeVariant::Header);
    assert_eq!(header.parser_surface.header_size_bytes, 32);
    assert_eq!(header.parser_surface.code_start_byte, 32);
    assert_eq!(header.string_references.len(), 2);
    assert_eq!(header.patch_reports.len(), 2);
    assert!(header.string_references.iter().any(|reference| {
        reference.reference_id == "bgi.header.name.001"
            && reference.text_surface == BgiBytecodeTextSurface::CharacterName
            && reference.pointer_offset_byte == 36
            && reference.string_start_byte == 56
            && reference.decoded_text == "\u{30a2}\u{30ea}\u{30b9}"
    }));
    assert!(header.string_references.iter().any(|reference| {
        reference.reference_id == "bgi.header.dialogue.001"
            && reference.text_surface == BgiBytecodeTextSurface::Dialogue
            && reference.pointer_offset_byte == 44
            && reference.string_start_byte == 63
            && reference.decoded_text == "\u{3053}\u{3093}\u{306b}\u{3061}\u{306f}"
    }));

    let no_header = report.entry("bgi.bytecode.no-header").unwrap();
    assert_eq!(no_header.variant, BgiBytecodeVariant::NoHeader);
    assert_eq!(no_header.parser_surface.header_size_bytes, 0);
    assert_eq!(no_header.parser_surface.code_start_byte, 0);
    assert_eq!(no_header.string_references.len(), 3);
    assert_eq!(no_header.patch_reports.len(), 3);
    assert!(no_header.string_references.iter().any(|reference| {
        reference.reference_id == "bgi.no_header.other.001"
            && reference.text_surface == BgiBytecodeTextSurface::Other
            && reference.pointer_offset_byte == 20
            && reference.string_start_byte == 74
            && reference.decoded_text == "\u{9078}\u{629e}\u{80a2}"
    }));
}

#[test]
fn malformed_negative_cases_are_rejected_with_expected_diagnostics() {
    let report = run();
    for entry in &report.entries {
        for case in &entry.negative_cases {
            assert!(case.rejected, "{case:#?}");
            assert_eq!(
                case.observed_diagnostic_code.as_deref(),
                Some(case.expected_diagnostic_code.as_str()),
                "{case:#?}"
            );
        }
    }
    let no_header = report.entry("bgi.bytecode.no-header").unwrap();
    assert!(no_header.negative_cases.iter().any(|case| {
        case.case_id == "bgi.no_header.false-positive-code-pointer"
            && case.observed_diagnostic_code.as_deref() == Some("missing_string_reference_surface")
    }));
}

#[test]
fn fixture_expected_references_match_parser_output() {
    let fixture = load();
    for entry in &fixture.entries {
        let parsed = parse_bgi_bytecode_entry(entry)
            .unwrap_or_else(|error| panic!("{} failed: {error}", entry.fixture_id));
        assert_eq!(
            parsed, entry.expected_string_references,
            "{} string-reference surfaces drifted",
            entry.fixture_id
        );
    }
}

#[test]
fn patch_cases_round_trip_and_leave_untouched_bytes_identical() {
    let fixture = load();
    for entry in &fixture.entries {
        let source = decode_hex(&entry.source_bytes_hex).expect("fixture source hex");
        let (patched, reports) = patch_bgi_bytecode_entry(entry, &entry.patch_cases)
            .unwrap_or_else(|error| panic!("{} patch proof failed: {error}", entry.fixture_id));
        assert_eq!(
            reports.len(),
            entry.patch_cases.len(),
            "{}",
            entry.fixture_id
        );
        assert!(
            reports
                .iter()
                .all(|report| { report.patched_text_verified && report.untouched_bytes_identical })
        );
        assert!(
            patched.len() > source.len(),
            "{} patch fixture must prove length-changing string-table rebuild",
            entry.fixture_id
        );

        let reparsed = parse_bgi_bytecode(&patched, entry.variant).expect("patched parses");
        for patch in &entry.patch_cases {
            let reference = reparsed
                .iter()
                .find(|reference| reference.reference_id == patch.reference_id)
                .expect("patched target reference exists");
            assert_eq!(reference.decoded_text, patch.replacement_text);
        }
    }
}

#[test]
fn claimed_patch_support_failures_are_loud() {
    let mut fixture = load();
    fixture.entries[0].patch_cases = vec![BgiBytecodePatchCase {
        patch_id: "bgi.header.patch.bad-encoding".to_string(),
        reference_id: "bgi.header.name.001".to_string(),
        replacement_text: "🙂".to_string(),
    }];

    let report = run_bgi_bytecode_fixture(&fixture);
    let header = report.entry("bgi.bytecode.header").unwrap();
    assert_eq!(header.status, OperationStatus::Failed);
    assert!(header.patch_reports.is_empty());
    assert!(
        header
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == "patch_replacement_not_shift_jis" })
    );
}

#[test]
fn claimed_patch_with_empty_patch_cases_fails_loud() {
    let mut fixture = load();
    assert!(
        fixture.entries[0].claims_patch_support,
        "committed bytecode profiles claim extract-to-patch support"
    );
    fixture.entries[0].patch_cases.clear();

    let report = run_bgi_bytecode_fixture(&fixture);
    let header = report.entry("bgi.bytecode.header").unwrap();
    assert_eq!(header.status, OperationStatus::Failed);
    assert!(header.patch_reports.is_empty());
    assert!(
        header.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "claimed_patch_cases_missing" && diagnostic.field == "patchCases"
        }),
        "empty patchCases on a claimed-patch entry must fail loud: {header:#?}"
    );
}

#[test]
fn non_patch_entry_may_omit_patch_cases() {
    let mut fixture = load();
    // A parse/negative-only entry does not claim patch support: empty
    // patchCases is a silent (and correct) skip, not a failure.
    fixture.entries[0].claims_patch_support = false;
    fixture.entries[0].patch_cases.clear();

    let report = run_bgi_bytecode_fixture(&fixture);
    let header = report.entry("bgi.bytecode.header").unwrap();
    assert_eq!(header.status, OperationStatus::Passed, "{header:#?}");
    assert!(header.patch_reports.is_empty());
    assert!(
        header
            .diagnostics
            .iter()
            .all(|diagnostic| diagnostic.code != "claimed_patch_cases_missing")
    );
}

#[test]
fn report_is_redaction_clean() {
    let mut fixture = load();
    fixture.profile_set_id = "/home/trevor/private/bgi/Scenario0001".to_string();
    let report = run_bgi_bytecode_fixture(&fixture);
    let json = report.stable_json().expect("stable json");
    assert!(json.contains("[REDACTED:"));
    assert!(!json.contains("/home/trevor/private/bgi/Scenario0001"));
    for forbidden in [
        "local-secret:",
        "rawKey",
        "keyMaterial",
        "C:\\",
        "/home/trevor/private",
    ] {
        assert!(!json.contains(forbidden), "report leaked {forbidden}");
    }
}
