use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

// identity/null-key-only capability annotation.

#[test]
fn identity_or_null_key_only_report_carries_explicit_limitation_and_marker() {
    // A container/crypto/codec/patch capability that only works at the
    // identity/null-key rung must be Supported (it works) BUT explicitly
    // annotated so a consumer cannot over-read it as broad transform
    // support.
    for capability in [
        Capability::ContainerAccess,
        Capability::CryptoAccess,
        Capability::CodecAccess,
        Capability::PatchBack,
    ] {
        let report = CapabilityReport::identity_or_null_key_only(capability.clone());
        assert_eq!(report.status, CapabilityStatus::Supported);
        assert!(report.is_identity_or_null_key_only());
        assert_eq!(
            report.limitation.as_deref(),
            Some(IDENTITY_OR_NULL_KEY_ONLY_LIMITATION)
        );
        assert!(capability.is_transform_bearing());
    }
}

#[test]
fn plain_supported_report_does_not_falsely_claim_identity_or_null_key_only() {
    // A report claiming genuine broad support must NOT carry the marker,
    // so a consumer can distinguish it from identity/null-key-only.
    let broad = CapabilityReport::supported(Capability::CryptoAccess);
    assert!(!broad.is_identity_or_null_key_only());
    assert!(broad.limitation.is_none());

    let annotated = CapabilityReport::identity_or_null_key_only(Capability::CryptoAccess);
    assert_ne!(
        broad.is_identity_or_null_key_only(),
        annotated.is_identity_or_null_key_only()
    );
}

#[test]
fn identity_or_null_key_marker_serializes_only_when_true() {
    let plain = CapabilityReport::supported(Capability::ContainerAccess);
    let plain_json = serde_json::to_value(&plain).expect("serialize");
    assert!(
        plain_json.get("identityOrNullKeyOnly").is_none(),
        "false marker must be skipped so existing payloads round-trip unchanged"
    );

    let annotated = CapabilityReport::identity_or_null_key_only(Capability::ContainerAccess);
    let annotated_json = serde_json::to_value(&annotated).expect("serialize");
    assert_eq!(
        annotated_json["identityOrNullKeyOnly"],
        serde_json::json!(true)
    );
    let round: CapabilityReport = serde_json::from_value(annotated_json).expect("deserialize");
    assert_eq!(round, annotated);
}

#[test]
fn into_identity_or_null_key_only_annotates_and_states_boundary() {
    let annotated =
        CapabilityReport::supported(Capability::PatchBack).into_identity_or_null_key_only();
    assert!(annotated.is_identity_or_null_key_only());
    assert_eq!(
        annotated.limitation.as_deref(),
        Some(IDENTITY_OR_NULL_KEY_ONLY_LIMITATION)
    );
}

#[test]
fn plaintext_identity_operation_contract_is_identity_or_null_key_only() {
    let contract = LayeredAccessCapabilityContract::plaintext_identity();
    assert!(
        contract.is_identity_or_null_key_only(),
        "the plaintext-identity contract declares no broader transform support"
    );
}

#[test]
fn contract_with_real_transform_is_not_identity_or_null_key_only() {
    // A real archive container + non-null crypto is a genuine broader
    // transform — distinguishable from the identity/null-key rung.
    let mut op = LayeredAccessOperationContract::supported_identity(vec![Capability::Extraction]);
    assert!(op.is_identity_or_null_key_only());
    op.supported_containers.push(ContainerTransform::Xp3);
    op.supported_crypto.push(CryptoTransform::KeyProfile);
    assert!(!op.is_identity_or_null_key_only());
}

#[test]
fn adapter_overread_detector_flags_unannotated_supported_transform_reports() {
    // No access contract + a plain Supported CryptoAccess report ->
    // over-read risk a consumer can catch.
    let reports = vec![
        CapabilityReport::supported(Capability::Detection),
        CapabilityReport::supported(Capability::CryptoAccess),
    ];
    let matrix = AdapterCapabilityMatrix::identify_only("kaifuu.overread", "detector-only");
    let caps = AdapterCapabilities::new("kaifuu.overread", reports, matrix);
    assert!(!caps.declares_broader_transform_support());
    assert_eq!(
        caps.identity_or_null_key_overreads(),
        vec![Capability::CryptoAccess]
    );
}

#[test]
fn adapter_overread_detector_clears_when_annotated_or_backed_by_broader_support() {
    let matrix = AdapterCapabilityMatrix::identify_only("kaifuu.honest", "detector-only");

    // Annotated identity/null-key-only -> no over-read.
    let annotated = AdapterCapabilities::new(
        "kaifuu.honest",
        vec![
            CapabilityReport::supported(Capability::Detection),
            CapabilityReport::identity_or_null_key_only(Capability::CryptoAccess),
        ],
        matrix.clone(),
    );
    assert!(annotated.identity_or_null_key_overreads().is_empty());

    // Backed by a broader (real-transform) access contract -> no over-read,
    // and the plain Supported report is understood as genuine broad support.
    let mut broad_contract = LayeredAccessCapabilityContract::plaintext_identity();
    broad_contract
        .extract
        .supported_crypto
        .push(CryptoTransform::KeyProfile);
    broad_contract
        .extract
        .supported_containers
        .push(ContainerTransform::Xp3);
    let broad = AdapterCapabilities::new(
        "kaifuu.honest",
        vec![
            CapabilityReport::supported(Capability::Detection),
            CapabilityReport::supported(Capability::CryptoAccess),
        ],
        matrix,
    )
    .with_access_contract(broad_contract);
    assert!(broad.declares_broader_transform_support());
    assert!(broad.identity_or_null_key_overreads().is_empty());
}

#[test]
fn validator_permits_supported_limitation_only_with_identity_marker() {
    // Supported + limitation + marker=true -> valid (the path).
    let ok = serde_json::json!({
        "capability": "crypto_access",
        "status": "supported",
        "limitation": IDENTITY_OR_NULL_KEY_ONLY_LIMITATION,
        "identityOrNullKeyOnly": true,
    });
    let mut failures = Vec::new();
    validate_capability_report(&mut failures, Some(&ok), "capabilities[0]");
    assert!(failures.is_empty(), "unexpected failures: {failures:?}");

    // Supported + limitation but NO marker -> still rejected (over-read
    // guard: a silent free-text limitation on a Supported report).
    let bad = serde_json::json!({
        "capability": "crypto_access",
        "status": "supported",
        "limitation": "reads encrypted archives",
    });
    let mut failures = Vec::new();
    validate_capability_report(&mut failures, Some(&bad), "capabilities[0]");
    assert!(
        failures
            .iter()
            .any(|f| f.code == "unexpected_capability_limitation"),
        "expected unexpected_capability_limitation, got {failures:?}"
    );
}

#[test]
fn validator_requires_marker_to_be_supported_with_a_limitation() {
    // marker=true but status!= supported -> rejected.
    let bad_status = serde_json::json!({
        "capability": "crypto_access",
        "status": "limited",
        "limitation": "x",
        "identityOrNullKeyOnly": true,
    });
    let mut failures = Vec::new();
    validate_capability_report(&mut failures, Some(&bad_status), "c");
    assert!(
        failures
            .iter()
            .any(|f| f.code == "invalid_identity_or_null_key_marker"),
        "got {failures:?}"
    );

    // marker=true but no limitation -> rejected (must state the boundary).
    let bad_missing = serde_json::json!({
        "capability": "crypto_access",
        "status": "supported",
        "identityOrNullKeyOnly": true,
    });
    let mut failures = Vec::new();
    validate_capability_report(&mut failures, Some(&bad_missing), "c");
    assert!(
        failures
            .iter()
            .any(|f| f.code == "missing_identity_or_null_key_limitation"),
        "got {failures:?}"
    );
}

fn partial_report_with(adapter_id: &str, message: &str) -> PartialAdapterReport {
    PartialAdapterReport::new(
        adapter_id.to_string(),
        None,
        PartialAdapterCommand::Extract,
        vec![DetectionEvidence {
            path: "data/SEEN.TXT".to_string(),
            kind: "envelope".to_string(),
            status: EvidenceStatus::Matched,
            detail: "ok".to_string(),
        }],
        vec![PartialAdapterDiagnostic {
            code: "kaifuu.partial.example".to_string(),
            severity: PartialDiagnosticSeverity::P2,
            message: message.to_string(),
            asset_ref: None,
            remediation: None,
        }],
        PartialAdapterInventory::default(),
    )
}

#[test]
fn partial_report_id_is_content_derived_not_a_constant() {
    // P3 fix: report_id used to be the hardcoded
    // `deterministic_id("kaifuu-partial-adapter", 193)` — identical for
    // every partial report. It must now vary with the report content so
    // dashboard de-duplication by reportId cannot collapse independent runs.
    let a = partial_report_with("kaifuu-reallive", "scene index mismatch");
    let b = partial_report_with("kaifuu-siglus", "scene index mismatch");
    let c = partial_report_with("kaifuu-reallive", "gameexe key mismatch");

    // Distinct adapter and distinct diagnostic content each change the id.
    assert_ne!(a.report_id, b.report_id);
    assert_ne!(a.report_id, c.report_id);

    // It is no longer the old hardcoded constant.
    assert_ne!(a.report_id, deterministic_id("kaifuu-partial-adapter", 193));
    assert!(a.report_id.starts_with("kaifuu-partial-adapter-"));

    // Identical content (after normalization) is reproducible.
    let a2 = partial_report_with("kaifuu-reallive", "scene index mismatch");
    assert_eq!(a.report_id, a2.report_id);
}

/// test helper: explicitly request the derived-from-reports
/// matrix for fixtures that exercise contract / preflight machinery
/// where the registry-side capability gate is not the subject of the
/// test. This is an *explicit* request (not a silent fallback) — the
/// derivation rule lives in
/// [`AdapterCapabilityMatrix::derive_from_reports`].
fn derived_matrix_for(adapter_id: &str, reports: &[CapabilityReport]) -> AdapterCapabilityMatrix {
    AdapterCapabilityMatrix::derive_from_reports(adapter_id, reports)
}

fn temp_dir(name: &str) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir =
        std::env::temp_dir().join(format!("kaifuu-core-{name}-{}-{nonce}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn bridge_fixture_value(relative_path: &str) -> Value {
    let path = repo_fixture_path(relative_path);
    serde_json::from_str(&fs::read_to_string(path).expect("fixture should be readable"))
        .expect("fixture should be valid JSON")
}

fn repo_fixture_path(relative_path: &str) -> PathBuf {
    crate::test_manifest_dir().join("../..").join(relative_path)
}

/// Cross-language parity: run the SHARED RFC3339 acceptance matrix through
/// the Rust contract validator. The identical matrix is run through the
/// TypeScript validator in
/// `packages/localization-bridge-schema/test/rfc3339-instant-parity-matrix.test.ts`,
/// so both languages must agree on every row's accept/reject decision, and
/// every rejection must carry the shared semantic code.
#[test]
fn rfc3339_instant_parity_matrix_matches_typescript_validator() {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MatrixRow {
        id: String,
        value: serde_json::Value,
        expected: String,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ParityMatrix {
        semantic_code: String,
        rows: Vec<MatrixRow>,
    }

    let matrix: ParityMatrix = serde_json::from_str(
        &fs::read_to_string(repo_fixture_path(
            "packages/localization-bridge-schema/test/rfc3339-instant-parity-matrix.v0.2.json",
        ))
        .expect("parity matrix fixture should be readable"),
    )
    .expect("parity matrix fixture should be valid JSON");

    assert_eq!(
        matrix.semantic_code,
        crate::SEMANTIC_RFC3339_INSTANT_MALFORMED,
        "matrix must pin the shared cross-language semantic code",
    );
    assert!(
        matrix.rows.iter().any(|row| row.expected == "accept")
            && matrix.rows.iter().any(|row| row.expected == "reject"),
        "matrix must cover both accept and reject",
    );

    for row in &matrix.rows {
        let value = row
            .value
            .as_str()
            .unwrap_or_else(|| panic!("row {} value must be a JSON string", row.id));
        let result = crate::contracts::validate_rfc3339_instant(value, "matrix");
        match row.expected.as_str() {
            "accept" => assert!(
                result.is_ok(),
                "row {} ({value:?}) should be ACCEPTED, got {result:?}",
                row.id,
            ),
            "reject" => {
                let error =
                    result.expect_err(&format!("row {} ({value:?}) should be REJECTED", row.id));
                assert_eq!(
                    error.code(),
                    Some(crate::SEMANTIC_RFC3339_INSTANT_MALFORMED),
                    "row {} rejection must carry the shared semantic code",
                    row.id,
                );
            }
            other => panic!("row {} has unknown expected value {other}", row.id),
        }
    }
}

fn bridge_v02_fixture_value() -> Value {
    bridge_fixture_value("packages/localization-bridge-schema/test/examples/bridge-v0.2.json")
}

fn contract_fixture_manifest_v02_value() -> Value {
    bridge_fixture_value(
        "packages/localization-bridge-schema/test/examples/contract-fixtures-v0.2.json",
    )
}

fn contract_example_fixture_value(manifest_path: &str) -> Value {
    let relative_path = manifest_path
        .strip_prefix("./")
        .expect("manifest paths should be relative to examples");
    bridge_fixture_value(&format!(
        "packages/localization-bridge-schema/test/examples/{relative_path}"
    ))
}

fn alpha_proof_fixture_value() -> Value {
    contract_example_fixture_value("./alpha-vertical-proof-manifest-v0.2.json")
}

fn semantic_error_matches(error: &str, expected_pattern: &str) -> bool {
    let simplified = expected_pattern
        .replace("\\.", ".")
        .replace("\\[", "[")
        .replace("\\]", "]")
        .replace("\\(", "(")
        .replace("\\)", ")");
    simplified
        .split(".*")
        .filter(|part| !part.is_empty())
        .all(|part| error.contains(part))
}

fn expect_bridge_v02_error(fixture: Value, expected_error: &str) {
    let error = BridgeBundleV02::validate_json(&fixture)
        .expect_err("invalid bridge fixture should fail Rust validation")
        .to_string();
    assert!(
        error.contains(expected_error),
        "expected error containing {expected_error:?}, got: {error}"
    );
}

fn expect_alpha_proof_error(fixture: Value, expected_error: &str) {
    let error = contracts::validate_alpha_vertical_proof_manifest_v02(&fixture)
        .expect_err("invalid alpha proof manifest should fail Rust validation")
        .to_string();
    assert!(
        error.contains(expected_error),
        "expected error containing {expected_error:?}, got: {error}"
    );
}

fn write_fixture_file(root: &Path, relative_path: &str, bytes: &[u8]) {
    let path = root.join(relative_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, bytes).unwrap();
}

#[derive(Clone, Copy)]
struct Xp3TestEntry<'a> {
    path: &'a str,
    payload: &'a [u8],
    compressed: bool,
    adler32: u32,
}

fn plain_xp3_fixture(entries: &[Xp3TestEntry<'_>]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(XP3_PLAIN_MAGIC);
    bytes.extend_from_slice(&0_u64.to_le_bytes());

    let mut segment_offsets = Vec::new();
    for entry in entries {
        segment_offsets.push(bytes.len() as u64);
        bytes.extend_from_slice(entry.payload);
    }

    let index_offset = bytes.len() as u64;
    let mut index = Vec::new();
    for (entry, offset) in entries.iter().zip(segment_offsets) {
        let mut file = Vec::new();
        let path_units = entry.path.encode_utf16().collect::<Vec<_>>();

        let mut info = Vec::new();
        info.extend_from_slice(&0_u32.to_le_bytes());
        info.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
        info.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
        info.extend_from_slice(&(path_units.len() as u16).to_le_bytes());
        for unit in path_units {
            info.extend_from_slice(&unit.to_le_bytes());
        }
        append_xp3_chunk(&mut file, *b"info", &info);

        let mut segment = Vec::new();
        segment.extend_from_slice(&(u32::from(entry.compressed)).to_le_bytes());
        segment.extend_from_slice(&offset.to_le_bytes());
        segment.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
        segment.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
        append_xp3_chunk(&mut file, *b"segm", &segment);
        append_xp3_chunk(&mut file, *b"adlr", &entry.adler32.to_le_bytes());
        append_xp3_chunk(&mut index, *b"File", &file);
    }

    bytes.push(0);
    bytes.extend_from_slice(&(index.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&index);
    bytes[XP3_PLAIN_MAGIC.len()..XP3_PLAIN_MAGIC.len() + 8]
        .copy_from_slice(&index_offset.to_le_bytes());
    bytes
}

fn append_xp3_chunk(output: &mut Vec<u8>, name: [u8; 4], content: &[u8]) {
    output.extend_from_slice(&name);
    output.extend_from_slice(&(content.len() as u64).to_le_bytes());
    output.extend_from_slice(content);
}

fn detected_archive_row<'a>(
    report: &'a ArchiveDetectionReport,
    row_id: &str,
) -> &'a ArchiveDetectionRow {
    let row = report
        .rows
        .iter()
        .find(|row| row.row_id == row_id)
        .unwrap_or_else(|| panic!("missing archive row {row_id}"));
    assert!(row.detected, "{row_id} should be detected: {row:#?}");
    row
}

#[test]
fn plain_xp3_inventory_reads_file_table_hashes_and_compression_flags() {
    let bytes = plain_xp3_fixture(&[
        Xp3TestEntry {
            path: "scenario/intro.ks",
            payload: b"first line",
            compressed: false,
            adler32: 0x0102_0304,
        },
        Xp3TestEntry {
            path: "scenario/compressed.ks",
            payload: b"compressed bytes fixture",
            compressed: true,
            adler32: 0x0a0b_0c0d,
        },
    ]);

    let inventory = read_plain_xp3_inventory(&bytes).unwrap();

    assert_eq!(inventory.entries.len(), 2);
    assert_eq!(inventory.entries[0].path, "scenario/compressed.ks");
    assert_eq!(inventory.entries[0].original_size, 24);
    assert_eq!(inventory.entries[0].archive_size, 24);
    assert!(inventory.entries[0].compressed);
    assert_eq!(inventory.entries[0].segment_count, 1);
    let compressed_hash = sha256_hash_bytes(b"compressed bytes fixture");
    assert_eq!(
        inventory.entries[0].payload_hash.as_deref(),
        Some(compressed_hash.as_str())
    );
    assert_eq!(
        inventory.entries[0].stored_adler32.as_deref(),
        Some("adler32:0a0b0c0d")
    );
    assert_eq!(inventory.entries[1].path, "scenario/intro.ks");
    assert!(!inventory.entries[1].compressed);
    let plain_hash = sha256_hash_bytes(b"first line");
    assert_eq!(
        inventory.entries[1].payload_hash.as_deref(),
        Some(plain_hash.as_str())
    );
}

#[test]
fn plain_xp3_inventory_rejects_malformed_header_and_encrypted_marker() {
    assert_eq!(
        read_plain_xp3_inventory(b"XP3\r\nnot the full plain header").unwrap_err(),
        PlainXp3InventoryError::MalformedHeader
    );

    assert_eq!(
        read_plain_xp3_inventory(b"XP3\r\nXP3-CRYPT\nfixture-only encrypted archive").unwrap_err(),
        PlainXp3InventoryError::UnsupportedEncrypted
    );

    let bytes = plain_xp3_fixture(&[Xp3TestEntry {
        path: "scenario/secret.ks",
        payload: b"XP3-CRYPT appears inside a plain member payload",
        compressed: false,
        adler32: 0,
    }]);
    let inventory = read_plain_xp3_inventory(&bytes).unwrap();
    assert_eq!(inventory.entries.len(), 1);
}

#[test]
fn plain_xp3_inventory_rejects_duplicate_file_entries() {
    let bytes = plain_xp3_fixture(&[
        Xp3TestEntry {
            path: "scenario/dup.ks",
            payload: b"one",
            compressed: false,
            adler32: 1,
        },
        Xp3TestEntry {
            path: "scenario/dup.ks",
            payload: b"two",
            compressed: false,
            adler32: 2,
        },
    ]);

    assert_eq!(
        read_plain_xp3_inventory(&bytes).unwrap_err(),
        PlainXp3InventoryError::DuplicateEntry("scenario/dup.ks".to_string())
    );
}

// Plain XP3 deterministic writer tests

#[test]
fn plain_xp3_writer_capability_records_archive_rebuild_plain() {
    // Acceptance criterion: "Writer capability tuple records
    // patch_back_mode=archive_rebuild_plain".
    let capability = plain_xp3_writer_capability();
    assert_eq!(capability.adapter_id, PLAIN_XP3_WRITER_ADAPTER_ID);
    assert_eq!(capability.variant, PLAIN_XP3_WRITER_VARIANT);
    assert_eq!(
        capability.patch_back_mode,
        PatchBackMode::ArchiveRebuildPlain
    );
    assert_eq!(capability.patch_back_mode.as_str(), "archive_rebuild_plain");
}

#[test]
fn encode_xp3_round_trips_synthetic_fixture_byte_identical() {
    // Acceptance criterion: "Rebuilding an unchanged plain fixture
    // produces stable archive structure and expected hashes."
    let synthetic = plain_xp3_fixture(&[
        Xp3TestEntry {
            path: "scenario/intro.ks",
            payload: b"hello public xp3\n",
            compressed: false,
            adler32: 0x1111_2222,
        },
        Xp3TestEntry {
            path: "scenario/compressed.ks",
            payload: b"compressed public payload\n",
            compressed: true,
            adler32: 0x3333_44dd,
        },
        Xp3TestEntry {
            path: "image/title.png",
            payload: b"png fixture bytes\n",
            compressed: false,
            adler32: 0x5555_66ff,
        },
    ]);

    let archive = read_plain_xp3_archive(&synthetic).unwrap();
    assert_eq!(archive.entries.len(), 3);
    // Source order is preserved (specifically does not
    // sort like `PlainXp3Inventory::normalize`).
    assert_eq!(archive.entries[0].path, "scenario/intro.ks");
    assert_eq!(archive.entries[1].path, "scenario/compressed.ks");
    assert_eq!(archive.entries[2].path, "image/title.png");
    // The compressed entry carries the flag.
    assert!(archive.entries[1].segments[0].is_compressed());

    let re_encoded = encode_xp3(&archive).unwrap();
    assert_eq!(
        re_encoded, synthetic,
        "encode_xp3 must produce byte-identical output for an unchanged manifest"
    );

    // Determinism: encoding twice yields the same bytes.
    let re_encoded_again = encode_xp3(&archive).unwrap();
    assert_eq!(re_encoded_again, re_encoded);

    // Re-parsing the rebuilt bytes through the read-side inventory
    // (which sorts) reproduces the same payload hashes and adler32
    // strings, confirming the rebuild kept payload bytes intact.
    let original_inventory = read_plain_xp3_inventory(&synthetic).unwrap();
    let rebuilt_inventory = read_plain_xp3_inventory(&re_encoded).unwrap();
    assert_eq!(original_inventory.entries, rebuilt_inventory.entries);
}

#[test]
fn encode_xp3_round_trips_real_plain_xp3_fixture_byte_identical() {
    // Real-bytes round-trip against the canonical plain XP3 fixture
    // . 's determinism guarantee is enforced
    // here: bytes -> archive -> bytes is the identity for an unchanged
    // manifest, and the rebuilt archive's sha256 matches the source.
    let fixture_bytes = fs::read(repo_fixture_path("fixtures/kaifuu/kirikiri/plain.xp3"))
        .expect("real-bytes plain XP3 fixture should be readable");
    let archive = read_plain_xp3_archive(&fixture_bytes).unwrap();
    assert!(
        archive
            .entries
            .iter()
            .any(|entry| entry.segments[0].is_compressed())
    );
    let rebuilt = encode_xp3(&archive).unwrap();
    assert_eq!(
        rebuilt, fixture_bytes,
        "encode_xp3 must reproduce the real plain XP3 fixture byte-identical"
    );
    assert_eq!(
        sha256_hash_bytes(&rebuilt),
        sha256_hash_bytes(&fixture_bytes),
        "rebuild hash must match source hash"
    );
}

#[test]
fn unpack_and_pack_round_trips_real_plain_xp3_directory_byte_identical() {
    // Acceptance criterion: "Rebuilding an unchanged plain fixture
    // produces stable archive structure and expected hashes." This
    // exercises the directory unpack/repack path (the actual writer
    // entry point: "take an unpacked plain XP3 dir + rebuild a
    // byte-identical XP3 archive").
    let fixture_bytes = fs::read(repo_fixture_path("fixtures/kaifuu/kirikiri/plain.xp3")).unwrap();
    let dir = temp_dir("kaifuu-098-unpack-real");
    let manifest = unpack_plain_xp3_to_directory(&fixture_bytes, &dir).unwrap();
    assert_eq!(manifest.variant, PLAIN_XP3_MANIFEST_VARIANT);
    assert_eq!(manifest.entries.len(), 3);
    assert!(dir.join("manifest.json").exists());
    for entry in &manifest.entries {
        assert!(
            dir.join(&entry.payload_relative_path).exists(),
            "payload file for {:?} should exist",
            entry.path
        );
    }

    let rebuilt = pack_plain_xp3_from_directory(&dir).unwrap();
    assert_eq!(
        rebuilt, fixture_bytes,
        "unpack -> pack round trip must be byte-identical for the real plain XP3 fixture"
    );

    // Determinism: packing twice from the unchanged directory yields
    // the same bytes.
    let rebuilt_again = pack_plain_xp3_from_directory(&dir).unwrap();
    assert_eq!(rebuilt, rebuilt_again);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn replace_plain_xp3_entry_updates_table_metadata_and_verification() {
    // Acceptance criterion: "Replacing an allowed plain fixture file
    // updates table metadata and verification output."
    let fixture_bytes = fs::read(repo_fixture_path("fixtures/kaifuu/kirikiri/plain.xp3")).unwrap();
    let dir = temp_dir("kaifuu-098-replace-real");
    unpack_plain_xp3_to_directory(&fixture_bytes, &dir).unwrap();

    let replacement = b"replaced public payload bytes\n";
    let updated_manifest =
        replace_plain_xp3_entry_payload(&dir, "scenario/intro.ks", replacement).unwrap();
    let replaced_entry = updated_manifest
        .entries
        .iter()
        .find(|entry| entry.path == "scenario/intro.ks")
        .unwrap();
    assert_eq!(replaced_entry.original_size, replacement.len() as u64);
    assert_eq!(replaced_entry.archive_size, replacement.len() as u64);
    assert_eq!(
        replaced_entry.segments[0].original_size,
        replacement.len() as u64
    );
    assert_eq!(
        replaced_entry.segments[0].archive_size,
        replacement.len() as u64
    );
    // adler32 was recomputed.
    let expected_adler = compute_adler32(replacement);
    assert_eq!(
        replaced_entry.stored_adler32_hex.as_deref(),
        Some(format!("{expected_adler:08x}").as_str())
    );

    // Unchanged entries keep their original metadata.
    let untouched_entry = updated_manifest
        .entries
        .iter()
        .find(|entry| entry.path == "image/title.png")
        .unwrap();
    assert_eq!(untouched_entry.archive_size, 18);

    // Rebuild and verify via the read-side inventory: the replaced
    // entry's payload hash now equals the sha256 of the new bytes,
    // and the table records the new size.
    let rebuilt = pack_plain_xp3_from_directory(&dir).unwrap();
    let inventory = read_plain_xp3_inventory(&rebuilt).unwrap();
    let intro = inventory
        .entries
        .iter()
        .find(|entry| entry.path == "scenario/intro.ks")
        .unwrap();
    assert_eq!(intro.original_size, replacement.len() as u64);
    assert_eq!(intro.archive_size, replacement.len() as u64);
    assert_eq!(
        intro.payload_hash.as_deref(),
        Some(sha256_hash_bytes(replacement).as_str())
    );
    assert_eq!(
        intro.stored_adler32.as_deref(),
        Some(format!("adler32:{expected_adler:08x}").as_str())
    );
    // The other plain entry survived the replacement untouched.
    let title = inventory
        .entries
        .iter()
        .find(|entry| entry.path == "image/title.png")
        .unwrap();
    assert_eq!(title.archive_size, 18);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn replace_plain_xp3_entry_rejects_tampered_payload_path_before_write() {
    let fixture_bytes = fs::read(repo_fixture_path("fixtures/kaifuu/kirikiri/plain.xp3")).unwrap();
    let root = temp_dir("kaifuu-098-replace-tampered-payload");
    let dir = root.join("unpacked");
    let outside_path = root.join("escape.bin");
    unpack_plain_xp3_to_directory(&fixture_bytes, &dir).unwrap();

    let manifest_path = dir.join("manifest.json");
    let manifest_bytes = fs::read(&manifest_path).unwrap();
    let mut manifest: PlainXp3DirectoryManifest = serde_json::from_slice(&manifest_bytes).unwrap();
    let entry = manifest
        .entries
        .iter_mut()
        .find(|entry| entry.path == "scenario/intro.ks")
        .unwrap();
    let expected_original_size = entry.original_size;
    let expected_archive_size = entry.archive_size;
    entry.payload_relative_path = "../escape.bin".to_string();
    let tampered_manifest = serde_json::to_string_pretty(&manifest).unwrap();
    fs::write(&manifest_path, tampered_manifest).unwrap();

    let error = replace_plain_xp3_entry_payload(&dir, "scenario/intro.ks", b"must not escape\n")
        .unwrap_err();
    assert!(matches!(
        error,
        PlainXp3WriterError::UnsafeRelativePath(ref path) if path == "../escape.bin"
    ));
    assert!(
        !outside_path.exists(),
        "replace must reject the tampered payloadRelativePath before writing outside dir"
    );

    let persisted_manifest: PlainXp3DirectoryManifest =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    let persisted_entry = persisted_manifest
        .entries
        .iter()
        .find(|entry| entry.path == "scenario/intro.ks")
        .unwrap();
    assert_eq!(
        persisted_entry.original_size, expected_original_size,
        "replace must fail before mutating manifest metadata"
    );
    assert_eq!(
        persisted_entry.archive_size, expected_archive_size,
        "replace must fail before mutating manifest metadata"
    );

    let _ = fs::remove_dir_all(&root);
}

/// SECURITY regression (symlink-traversal hardening): a symlink
/// planted inside the unpack directory must not let `replace` follow it out
/// of the root, even when the manifest-declared relative path is
/// string-safe. We swap the real `payload/` subdir for a symlink pointing
/// OUTSIDE the root; the string check passes ("payload/..." has no `..`),
/// but the fd-relative `O_NOFOLLOW` materialization refuses the traversal
/// and the outside target is never written.
/// Mutation proof: reverting `write_no_follow` to a plain `dir.join(rel)` +
/// `fs::write` makes the write follow the symlink and create the escaped
/// target, flipping the `!escaped_target.exists` assertion to a failure.
#[cfg(unix)]
#[test]
fn replace_plain_xp3_entry_refuses_symlinked_payload_dir() {
    use std::os::unix::fs::symlink;

    let fixture_bytes = fs::read(repo_fixture_path("fixtures/kaifuu/kirikiri/plain.xp3")).unwrap();
    let root = temp_dir("kaifuu-098-replace-symlink-dir");
    let dir = root.join("unpacked");
    unpack_plain_xp3_to_directory(&fixture_bytes, &dir).unwrap();

    // Attacker-controlled area OUTSIDE the unpack root.
    let outside = root.join("outside");
    fs::create_dir_all(&outside).unwrap();

    let manifest: PlainXp3DirectoryManifest =
        serde_json::from_slice(&fs::read(dir.join("manifest.json")).unwrap()).unwrap();
    let target = manifest
        .entries
        .iter()
        .find(|entry| entry.path == "scenario/intro.ks")
        .unwrap();
    let leaf = target
        .payload_relative_path
        .strip_prefix("payload/")
        .expect("payload path stays inside the payload/ subdir");
    let escaped_target = outside.join(leaf);

    // Replace the real `payload/` directory with a symlink pointing outside
    // the root. The manifest's payloadRelativePath is still "payload/...".
    let payload_dir = dir.join("payload");
    fs::remove_dir_all(&payload_dir).unwrap();
    symlink(&outside, &payload_dir).unwrap();

    let error = replace_plain_xp3_entry_payload(&dir, "scenario/intro.ks", b"must not escape\n")
        .unwrap_err();
    assert!(
        matches!(
            error,
            PlainXp3WriterError::SymlinkTraversalRefused(ref path)
                if *path == target.payload_relative_path
        ),
        "replace must refuse the symlinked payload dir with SymlinkTraversalRefused, got {error:?}"
    );
    assert_eq!(
        error.semantic_code(),
        "kaifuu.plain_xp3_writer.symlink_traversal_refused"
    );
    assert!(
        !escaped_target.exists(),
        "replace must not follow the symlinked payload/ dir out of the root"
    );

    let _ = fs::remove_dir_all(&root);
}

/// SECURITY regression: the read side (`pack`) must also refuse a symlink
/// component, so a tampered manifest plus a planted symlink cannot
/// exfiltrate a file outside the root. We stage look-alike payload files in
/// a secret dir outside the root and symlink `payload/` at it; the read is
/// refused rather than following the link.
/// Mutation proof: reverting `read_no_follow` to `fs::read(dir.join(rel))`
/// makes the read follow the symlink and load the outside bytes, so the
/// error becomes `InconsistentManifest`/`Io` instead of
/// `SymlinkTraversalRefused` and the assertion fails.
#[cfg(unix)]
#[test]
fn pack_plain_xp3_refuses_symlinked_payload_dir() {
    use std::os::unix::fs::symlink;

    let fixture_bytes = fs::read(repo_fixture_path("fixtures/kaifuu/kirikiri/plain.xp3")).unwrap();
    let root = temp_dir("kaifuu-098-pack-symlink-dir");
    let dir = root.join("unpacked");
    unpack_plain_xp3_to_directory(&fixture_bytes, &dir).unwrap();

    let secret = root.join("secret");
    fs::create_dir_all(&secret).unwrap();
    let manifest: PlainXp3DirectoryManifest =
        serde_json::from_slice(&fs::read(dir.join("manifest.json")).unwrap()).unwrap();
    for entry in &manifest.entries {
        let leaf = entry
            .payload_relative_path
            .strip_prefix("payload/")
            .expect("payload path stays inside the payload/ subdir");
        fs::write(secret.join(leaf), b"secret-outside-root").unwrap();
    }

    let payload_dir = dir.join("payload");
    fs::remove_dir_all(&payload_dir).unwrap();
    symlink(&secret, &payload_dir).unwrap();

    let error = pack_plain_xp3_from_directory(&dir).unwrap_err();
    assert!(
        matches!(error, PlainXp3WriterError::SymlinkTraversalRefused(_)),
        "pack must refuse the symlinked payload dir on read, got {error:?}"
    );

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn replace_plain_xp3_entry_refuses_compressed_entry() {
    // Acceptance criterion: "Encrypted, compressed-unknown, or
    // helper-required profiles fail before writes with semantic
    // diagnostics." Compressed-entry replacement is the
    // compressed-unknown path: does not claim
    // recompression, so the writer refuses with the matching
    // semantic diagnostic before mutating the directory.
    let fixture_bytes = fs::read(repo_fixture_path("fixtures/kaifuu/kirikiri/plain.xp3")).unwrap();
    let dir = temp_dir("kaifuu-098-replace-compressed");
    unpack_plain_xp3_to_directory(&fixture_bytes, &dir).unwrap();

    let error = replace_plain_xp3_entry_payload(
        &dir,
        "scenario/compressed.ks",
        b"would require recompression\n",
    )
    .unwrap_err();
    assert!(matches!(
        error,
        PlainXp3WriterError::UnsupportedCompressedReplacement(_)
    ));
    assert_eq!(
        error.semantic_code(),
        SEMANTIC_UNSUPPORTED_VARIANT_PACKED,
        "compressed-entry refusal must surface kaifuu.unsupported_variant.packed"
    );

    // No write happened: rebuilding the directory still yields the
    // original fixture bytes.
    let rebuilt = pack_plain_xp3_from_directory(&dir).unwrap();
    assert_eq!(rebuilt, fixture_bytes);

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_plain_xp3_archive_refuses_encrypted_with_semantic_diagnostic() {
    // Acceptance criterion: "Encrypted... profiles fail before
    // writes with semantic diagnostics."
    let encrypted_bytes = b"XP3\r\nXP3-CRYPT\nkaifuu-xp3-encrypted fixture\n";
    let error = read_plain_xp3_archive(encrypted_bytes).unwrap_err();
    assert_eq!(error, PlainXp3WriterError::UnsupportedEncrypted);
    assert_eq!(
        error.semantic_code(),
        SEMANTIC_UNSUPPORTED_VARIANT_ENCRYPTED
    );

    // Unpack must refuse before creating the target directory.
    let dir = temp_dir("kaifuu-098-encrypted-refusal");
    // We don't pre-create the directory — unpack creates it on the
    // happy path. The encrypted path must refuse before any side
    // effect, so `dir` should not be populated.
    let target_dir = dir.join("unpacked");
    let error = unpack_plain_xp3_to_directory(encrypted_bytes, &target_dir).unwrap_err();
    assert_eq!(error, PlainXp3WriterError::UnsupportedEncrypted);
    assert!(
        !target_dir.exists(),
        "encrypted unpack must not create the target directory"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_plain_xp3_archive_refuses_compressed_profile_with_packed_semantic_diagnostic() {
    // Acceptance criterion: "... compressed-unknown... profiles
    // fail before writes with semantic diagnostics."
    let compressed_bytes = b"XP3\r\nXP3-COMPRESSED\nkaifuu-xp3-compressed fixture\n";
    let error = read_plain_xp3_archive(compressed_bytes).unwrap_err();
    assert_eq!(error, PlainXp3WriterError::UnsupportedCompressed);
    assert_eq!(error.semantic_code(), SEMANTIC_UNSUPPORTED_VARIANT_PACKED);
    assert!(
        error
            .to_string()
            .contains(SEMANTIC_UNSUPPORTED_VARIANT_PACKED),
        "compressed-profile refusal must surface kaifuu.unsupported_variant.packed"
    );

    // Unpack must refuse before creating the target directory.
    let dir = temp_dir("kaifuu-098-compressed-refusal");
    let target_dir = dir.join("unpacked");
    let error = unpack_plain_xp3_to_directory(compressed_bytes, &target_dir).unwrap_err();
    assert_eq!(error, PlainXp3WriterError::UnsupportedCompressed);
    assert!(
        !target_dir.exists(),
        "compressed unpack must not create the target directory"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_plain_xp3_archive_refuses_helper_required_with_semantic_diagnostic() {
    // Acceptance criterion: "... helper-required profiles fail
    // before writes with semantic diagnostics."
    let helper_bytes = b"XP3\r\nXP3-HELPER-REQUIRED\nkaifuu-xp3-helper-required fixture\n";
    let error = read_plain_xp3_archive(helper_bytes).unwrap_err();
    assert_eq!(error, PlainXp3WriterError::UnsupportedHelperRequired);
    assert_eq!(error.semantic_code(), SEMANTIC_HELPER_REQUIRED);

    let dir = temp_dir("kaifuu-098-helper-required-refusal");
    let target_dir = dir.join("unpacked");
    let error = unpack_plain_xp3_to_directory(helper_bytes, &target_dir).unwrap_err();
    assert_eq!(error, PlainXp3WriterError::UnsupportedHelperRequired);
    assert!(!target_dir.exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn read_plain_xp3_archive_refuses_unknown_container_with_semantic_diagnostic() {
    // Acceptance criterion (protected-executable / unknown
    // container variant of "fail before writes").
    let protected_bytes = b"MZ\x90\0\x03\0\0\0PROTECTED-EXECUTABLE\n";
    let error = read_plain_xp3_archive(protected_bytes).unwrap_err();
    assert_eq!(error, PlainXp3WriterError::UnsupportedProtectedExecutable);
    assert_eq!(
        error.semantic_code(),
        SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED
    );
}

#[test]
fn encode_xp3_refuses_non_plain_variant_with_semantic_diagnostic() {
    let archive = PlainXp3Archive {
        schema_version: PLAIN_XP3_MANIFEST_SCHEMA_VERSION.to_string(),
        variant: "encrypted".to_string(),
        entries: Vec::new(),
    };
    let error = encode_xp3(&archive).unwrap_err();
    assert!(
        matches!(error, PlainXp3WriterError::UnsupportedVariant(ref variant) if variant == "encrypted")
    );
    assert_eq!(error.semantic_code(), SEMANTIC_UNSUPPORTED_ENGINE_VARIANT);
}

#[test]
fn encode_xp3_rejects_inconsistent_manifest() {
    // Inconsistent manifest: declared archive_size does not match
    // segment archive_size sum.
    let archive = PlainXp3Archive {
        schema_version: PLAIN_XP3_MANIFEST_SCHEMA_VERSION.to_string(),
        variant: PLAIN_XP3_MANIFEST_VARIANT.to_string(),
        entries: vec![PlainXp3ArchiveEntry {
            path: "scenario/intro.ks".to_string(),
            original_size: 10,
            archive_size: 10,
            stored_adler32: None,
            segments: vec![PlainXp3ArchiveSegment {
                flags: 0,
                original_size: 5,
                archive_size: 5,
            }],
            payload: vec![0; 5],
        }],
    };
    let error = encode_xp3(&archive).unwrap_err();
    assert!(matches!(
        error,
        PlainXp3WriterError::InconsistentManifest(_)
    ));
}

#[test]
fn encode_xp3_rejects_path_exceeding_u16_utf16_units() {
    // A path longer than u16::MAX UTF-16 units cannot be written
    // truthfully into the info chunk's u16 path-length field. The
    // writer must surface InconsistentManifest rather than silently
    // truncating the count while emitting the full path payload.
    let long_path = "a".repeat(usize::from(u16::MAX) + 1);
    let archive = PlainXp3Archive {
        schema_version: PLAIN_XP3_MANIFEST_SCHEMA_VERSION.to_string(),
        variant: PLAIN_XP3_MANIFEST_VARIANT.to_string(),
        entries: vec![PlainXp3ArchiveEntry {
            path: long_path,
            original_size: 0,
            archive_size: 0,
            stored_adler32: None,
            segments: vec![],
            payload: vec![],
        }],
    };
    let error = encode_xp3(&archive).unwrap_err();
    assert!(matches!(
        error,
        PlainXp3WriterError::InconsistentManifest(_)
    ));
}

#[test]
fn encode_xp3_rejects_unsafe_relative_path() {
    let archive = PlainXp3Archive {
        schema_version: PLAIN_XP3_MANIFEST_SCHEMA_VERSION.to_string(),
        variant: PLAIN_XP3_MANIFEST_VARIANT.to_string(),
        entries: vec![PlainXp3ArchiveEntry {
            path: "../escape.ks".to_string(),
            original_size: 1,
            archive_size: 1,
            stored_adler32: None,
            segments: vec![PlainXp3ArchiveSegment {
                flags: 0,
                original_size: 1,
                archive_size: 1,
            }],
            payload: vec![0],
        }],
    };
    let error = encode_xp3(&archive).unwrap_err();
    assert!(matches!(error, PlainXp3WriterError::UnsafeRelativePath(_)));
}

#[test]
fn compute_adler32_matches_zlib_reference_vectors() {
    // Known Adler-32 reference vectors.
    assert_eq!(compute_adler32(b""), 1);
    assert_eq!(compute_adler32(b"abc"), 0x024d_0127);
    assert_eq!(compute_adler32(b"Wikipedia"), 0x11e6_0398);
}

fn golden_boundary_profile(adapter_id: &str) -> GameProfile {
    GameProfile {
        schema_version: PROFILE_SCHEMA_VERSION.to_string(),
        profile_id: deterministic_id("profile", 91),
        game_id: "golden-boundary-fixture".to_string(),
        title: "Golden Boundary Fixture".to_string(),
        source_locale: "ja-JP".to_string(),
        engine: EngineProfile {
            adapter_id: adapter_id.to_string(),
            engine_family: "fixture".to_string(),
            engine_version: None,
            detected_variant: "preflight-boundary".to_string(),
        },
        source_fingerprint: None,
        key_requirements: vec![],
        archive_parameters: vec![],
        helper_evidence: None,
        assets: vec![AssetProfile {
            asset_id: deterministic_id("asset", 91),
            path: "source.json".to_string(),
            asset_kind: AssetKind::Script,
            text_surfaces: vec![TextSurface::Dialogue],
            source_hash: Some(content_hash("こんにちは")),
            patching: CapabilityReport::supported(Capability::Patching),
        }],
        layered_access: None,
        capabilities: vec![
            CapabilityReport::supported(Capability::Detection),
            CapabilityReport::supported(Capability::Extraction),
            CapabilityReport::supported(Capability::Patching),
            CapabilityReport::supported(Capability::Verification),
        ],
        requirements: vec![],
        metadata: BTreeMap::new(),
    }
}

fn golden_boundary_extraction(adapter_id: &str) -> ExtractionResult {
    let source_unit_key = "scene.001.line.001".to_string();
    ExtractionResult {
        adapter_id: adapter_id.to_string(),
        profile: golden_boundary_profile(adapter_id),
        bridge: BridgeBundle {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            bridge_id: deterministic_id("bridge", 91),
            source_bundle_hash: content_hash("こんにちは"),
            source_locale: "ja-JP".to_string(),
            extractor_name: "golden-boundary-test".to_string(),
            extractor_version: "0.0.0".to_string(),
            units: vec![BridgeUnit {
                bridge_unit_id: deterministic_id("bridge-unit", 91),
                source_unit_key: source_unit_key.clone(),
                occurrence_id: "scene.001.line.001#1".to_string(),
                source_hash: content_hash("こんにちは"),
                source_locale: "ja-JP".to_string(),
                source_text: "こんにちは".to_string(),
                speaker: "Narrator".to_string(),
                text_surface: "dialogue".to_string(),
                protected_spans: vec![],
                patch_ref: PatchRef {
                    asset_id: deterministic_id("asset", 91),
                    write_mode: "replace_text".to_string(),
                    source_unit_key,
                },
            }],
        },
        warnings: vec![],
    }
}

fn golden_boundary_patch_export(patch_export_id: impl Into<String>) -> PatchExport {
    PatchExport {
        patch_export_id: patch_export_id.into(),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![PatchExportEntry {
            bridge_unit_id: deterministic_id("bridge-unit", 91),
            source_unit_key: "scene.001.line.001".to_string(),
            source_hash: content_hash("こんにちは"),
            target_text: "Hello.".to_string(),
            protected_span_mappings: vec![],
        }],
    }
}

// test adapters + fixtures proving the golden harness drives asset
// assertions off adapter INVENTORY + CAPABILITY data rather than a fixture
// `source.json` layout.

const INVENTORY_GOLDEN_ID: &str = "kaifuu.inventory-golden";
const INVENTORY_SCENE_ASSET: &str = "scene.dat";
const INVENTORY_LOGO_ASSET: &str = "art/logo.dat";
const INVENTORY_LOGO_ASSET_ID: &str = "asset-art-logo";
const INVENTORY_LOGO_BOUNDARY: &str = "inventory-golden adapter reports the logo art surface but cannot redraw or replace binary art assets";

fn write_file_all(base: &Path, relative: &str, bytes: &[u8]) {
    let path = base.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, bytes).unwrap();
}

/// A NON-`source.json` game layout: a `scene.dat` script asset the adapter can
/// edit plus an `art/logo.dat` binary asset it reports as capability-unsupported.
fn inventory_golden_game(name: &str) -> PathBuf {
    let dir = temp_dir(name);
    write_file_all(&dir, INVENTORY_SCENE_ASSET, b"scene bytes v1");
    write_file_all(&dir, INVENTORY_LOGO_ASSET, b"logo binary bytes");
    dir
}

struct InventoryGoldenAdapter {
    /// When true, the unchanged patch corrupts the capability-unsupported
    /// `art/logo.dat` asset so the adapter-neutral preservation check flags it.
    mutate_unsupported_asset: bool,
}

impl InventoryGoldenAdapter {
    fn asset_hash(game_dir: &Path, relative: &str) -> Option<String> {
        fs::read(game_dir.join(relative))
            .ok()
            .map(|bytes| content_hash(&String::from_utf8_lossy(&bytes)))
    }
}

impl EngineAdapter for InventoryGoldenAdapter {
    fn id(&self) -> &'static str {
        INVENTORY_GOLDEN_ID
    }

    fn name(&self) -> &'static str {
        "Inventory Golden"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        let reports = vec![
            CapabilityReport::supported(Capability::Detection),
            CapabilityReport::supported(Capability::Extraction),
            CapabilityReport::supported(Capability::Patching),
            CapabilityReport::supported(Capability::Verification),
            CapabilityReport::supported(Capability::AssetInventory),
            CapabilityReport::unsupported(
                Capability::NonTextSurfaceExtraction,
                "cannot patch binary art surfaces",
            ),
        ];
        let matrix = AdapterCapabilityMatrix::derive_from_reports(self.id(), &reports);
        AdapterCapabilities::new(self.id(), reports, matrix)
    }

    fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        Ok(DetectionResult {
            adapter_id: self.id().to_string(),
            detected: true,
            engine_family: Some("fixture".to_string()),
            engine_version: None,
            detected_variant: Some("inventory-golden".to_string()),
            evidence: vec![],
            requirements: vec![],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        Ok(golden_boundary_profile(self.id()))
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        Ok(AssetList {
            adapter_id: self.id().to_string(),
            assets: vec![],
        })
    }

    fn asset_inventory(
        &self,
        request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        let mut manifest = AssetInventoryManifest {
            schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
            manifest_id: deterministic_id("inventory-golden", 1),
            adapter_id: self.id().to_string(),
            source_locale: "ja-JP".to_string(),
            assets: vec![
                AssetInventoryAsset {
                    asset_id: "asset-scene".to_string(),
                    asset_key: "scene/main".to_string(),
                    asset_kind: AssetInventoryAssetKind::Script,
                    path: Some(INVENTORY_SCENE_ASSET.to_string()),
                    source_hash: Self::asset_hash(request.game_dir, INVENTORY_SCENE_ASSET),
                    metadata: BTreeMap::new(),
                },
                AssetInventoryAsset {
                    asset_id: INVENTORY_LOGO_ASSET_ID.to_string(),
                    asset_key: "art/logo".to_string(),
                    asset_kind: AssetInventoryAssetKind::Image,
                    path: Some(INVENTORY_LOGO_ASSET.to_string()),
                    source_hash: Self::asset_hash(request.game_dir, INVENTORY_LOGO_ASSET),
                    metadata: BTreeMap::new(),
                },
            ],
            surfaces: vec![AssetInventorySurface {
                surface_id: "surface-art-logo".to_string(),
                asset_surface_kind: AssetInventorySurfaceKind::UiArt,
                source_asset_ref: AssetInventoryAssetRef {
                    asset_id: INVENTORY_LOGO_ASSET_ID.to_string(),
                    asset_key: Some("art/logo".to_string()),
                },
                source_location: None,
                source_text: None,
                source_hash: Self::asset_hash(request.game_dir, INVENTORY_LOGO_ASSET),
                text_source_kind: AssetInventoryTextSourceKind::NotApplicable,
                patch_mode: AssetInventoryPatchMode::AssetReplacementRequired,
                patching: CapabilityReport::unsupported(
                    Capability::NonTextSurfaceExtraction,
                    INVENTORY_LOGO_BOUNDARY,
                ),
                patch_payload: None,
                metadata_hash: None,
                notes: vec![],
            }],
            capabilities: self.capabilities().reports,
            warnings: vec![],
            metadata: BTreeMap::new(),
        };
        manifest.normalize();
        Ok(manifest)
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Ok(ExtractionResult {
            adapter_id: self.id().to_string(),
            profile: golden_boundary_profile(self.id()),
            bridge: BridgeBundle {
                schema_version: PROFILE_SCHEMA_VERSION.to_string(),
                bridge_id: deterministic_id("inventory-golden-bridge", 1),
                source_bundle_hash: content_hash("inventory-golden"),
                source_locale: "ja-JP".to_string(),
                extractor_name: "inventory-golden-test".to_string(),
                extractor_version: "0.0.0".to_string(),
                units: vec![],
            },
            warnings: vec![],
        })
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        // Identity round-trip: copy the editable script asset byte-for-byte.
        let scene = fs::read(request.game_dir.join(INVENTORY_SCENE_ASSET))?;
        write_file_all(request.output_dir, INVENTORY_SCENE_ASSET, &scene);
        // The capability-unsupported asset must be passed through unchanged;
        // the mutating variant deliberately corrupts it.
        if self.mutate_unsupported_asset {
            write_file_all(
                request.output_dir,
                INVENTORY_LOGO_ASSET,
                b"corrupted logo bytes",
            );
        } else {
            let logo = fs::read(request.game_dir.join(INVENTORY_LOGO_ASSET))?;
            write_file_all(request.output_dir, INVENTORY_LOGO_ASSET, &logo);
        }
        Ok(PatchResult {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: deterministic_id("inventory-golden-patch", 1),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: content_hash(&String::from_utf8_lossy(&scene)),
            failures: vec![],
        })
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Ok(VerificationResult {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: deterministic_id("inventory-golden-verify", 1),
            status: OperationStatus::Passed,
            output_hash: content_hash("verified"),
            failures: vec![],
        })
    }
}

/// A `source.json`-shaped identity adapter used to keep the fixture
/// `source.json` byte-equivalence path covered as ONE case.
struct SourceJsonGoldenAdapter {
    mutate: bool,
}

impl EngineAdapter for SourceJsonGoldenAdapter {
    fn id(&self) -> &'static str {
        "kaifuu.source-json-golden"
    }

    fn name(&self) -> &'static str {
        "Source Json Golden"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        let reports = vec![
            CapabilityReport::supported(Capability::Detection),
            CapabilityReport::supported(Capability::Extraction),
            CapabilityReport::supported(Capability::Patching),
            CapabilityReport::supported(Capability::Verification),
        ];
        let matrix = AdapterCapabilityMatrix::derive_from_reports(self.id(), &reports);
        AdapterCapabilities::new(self.id(), reports, matrix)
    }

    fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        Ok(DetectionResult {
            adapter_id: self.id().to_string(),
            detected: true,
            engine_family: Some("fixture".to_string()),
            engine_version: None,
            detected_variant: Some("source-json-golden".to_string()),
            evidence: vec![],
            requirements: vec![],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        Ok(golden_boundary_profile(self.id()))
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        Ok(AssetList {
            adapter_id: self.id().to_string(),
            assets: vec![],
        })
    }

    fn asset_inventory(
        &self,
        _request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        Err("source-json-golden adapter uses the source.json byte case".into())
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Ok(ExtractionResult {
            adapter_id: self.id().to_string(),
            profile: golden_boundary_profile(self.id()),
            bridge: BridgeBundle {
                schema_version: PROFILE_SCHEMA_VERSION.to_string(),
                bridge_id: deterministic_id("source-json-golden-bridge", 1),
                source_bundle_hash: content_hash("source-json-golden"),
                source_locale: "ja-JP".to_string(),
                extractor_name: "source-json-golden-test".to_string(),
                extractor_version: "0.0.0".to_string(),
                units: vec![],
            },
            warnings: vec![],
        })
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        let bytes = if self.mutate {
            b"{\"changed\": true}\n".to_vec()
        } else {
            fs::read(request.game_dir.join("source.json"))?
        };
        write_file_all(request.output_dir, "source.json", &bytes);
        Ok(PatchResult {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: deterministic_id("source-json-golden-patch", 1),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: content_hash(&String::from_utf8_lossy(&bytes)),
            failures: vec![],
        })
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Ok(VerificationResult {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: deterministic_id("source-json-golden-verify", 1),
            status: OperationStatus::Passed,
            output_hash: content_hash("verified"),
            failures: vec![],
        })
    }
}

fn inventory_golden_registry(mutate_unsupported_asset: bool) -> AdapterRegistry {
    let mut registry = AdapterRegistry::new();
    registry.register(InventoryGoldenAdapter {
        mutate_unsupported_asset,
    });
    registry
}

#[test]
fn derive_asset_preservation_claims_from_inventory_is_source_json_agnostic() {
    let adapter = InventoryGoldenAdapter {
        mutate_unsupported_asset: false,
    };
    let game_dir = inventory_golden_game("k032-derive-claims");
    let manifest = adapter
        .asset_inventory(AssetInventoryRequest {
            game_dir: &game_dir,
        })
        .unwrap();

    let claims = derive_asset_preservation_claims(&manifest);
    assert_eq!(claims.len(), 1, "one capability-unsupported surface");
    let claim = &claims[0];
    assert_eq!(claim.asset_id, INVENTORY_LOGO_ASSET_ID);
    assert_eq!(claim.asset_ref, "art/logo");
    assert_eq!(
        claim.required_capability,
        Capability::NonTextSurfaceExtraction
    );
    assert_eq!(claim.support_boundary, INVENTORY_LOGO_BOUNDARY);
    // The claim never mentions source.json (adapter-neutral).
    assert!(!claim.asset_ref.contains("source.json"));

    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn golden_inventory_mode_asserts_preservation_and_capability_diagnostic_without_source_json() {
    let game_dir = inventory_golden_game("k032-inventory-pass-game");
    let work_dir = temp_dir("k032-inventory-pass-work");
    assert!(
        !game_dir.join("source.json").exists(),
        "the adapter-neutral fixture must have NO source.json"
    );

    let report = run_round_trip_golden(
        &inventory_golden_registry(false),
        GoldenHarnessRequest {
            game_dir: &game_dir,
            work_dir: &work_dir,
            adapter_id: Some(INVENTORY_GOLDEN_ID),
            byte_equivalence: GoldenByteEquivalenceMode::AssertInventory,
            translated_patch_export: None,
            translated_source_bridge: None,
        },
    )
    .unwrap();

    assert_eq!(report.status, OperationStatus::Passed);
    assert!(report.failures.is_empty());

    // Capability-aware diagnostic: typed, keyed on the unsupported capability.
    let diagnostic = report
        .phases
        .iter()
        .find(|phase| phase.phase == "asset_capability_diagnostic")
        .expect("capability-aware diagnostic phase");
    assert_eq!(diagnostic.status, GoldenAssertionStatus::Skipped);
    assert_eq!(
        diagnostic.required_capability,
        Some(Capability::NonTextSurfaceExtraction)
    );
    assert_eq!(diagnostic.asset_ref.as_deref(), Some("art/logo"));

    // Preservation asserted from inventory + capability, not source.json.
    let preservation = report
        .phases
        .iter()
        .find(|phase| phase.phase == "inventory_asset_preservation")
        .expect("inventory preservation phase");
    assert_eq!(preservation.status, GoldenAssertionStatus::Passed);

    // The asset-assertion phases (preservation + capability diagnostics) are
    // adapter-neutral: none of them fall back to a source.json asset ref, and
    // no byte_equivalence-by-source.json phase is emitted in inventory mode.
    assert!(
        !report
            .phases
            .iter()
            .any(|phase| phase.phase == "byte_equivalence")
    );
    assert!(
        report
            .phases
            .iter()
            .filter(|phase| {
                phase.phase == "inventory_asset_preservation"
                    || phase.phase == "asset_capability_diagnostic"
            })
            .all(|phase| phase.asset_ref.as_deref() != Some("source.json")),
        "adapter-neutral asset assertions must not reference a source.json asset ref"
    );

    let _ = fs::remove_dir_all(game_dir);
    let _ = fs::remove_dir_all(work_dir);
}

#[test]
fn golden_inventory_mode_flags_mutated_capability_unsupported_asset() {
    let game_dir = inventory_golden_game("k032-inventory-mutate-game");
    let work_dir = temp_dir("k032-inventory-mutate-work");

    let report = run_round_trip_golden(
        &inventory_golden_registry(true),
        GoldenHarnessRequest {
            game_dir: &game_dir,
            work_dir: &work_dir,
            adapter_id: Some(INVENTORY_GOLDEN_ID),
            byte_equivalence: GoldenByteEquivalenceMode::AssertInventory,
            translated_patch_export: None,
            translated_source_bridge: None,
        },
    )
    .unwrap();

    assert_eq!(report.status, OperationStatus::Failed);
    let failure = report
        .failures
        .iter()
        .find(|failure| failure.code == "inventory_unsupported_asset_mutated")
        .expect("mutated capability-unsupported asset failure");
    assert_eq!(failure.phase, "inventory_asset_preservation");
    assert_eq!(failure.asset_ref.as_deref(), Some("art/logo"));
    assert_eq!(
        failure.required_capability,
        Some(Capability::NonTextSurfaceExtraction)
    );

    let _ = fs::remove_dir_all(game_dir);
    let _ = fs::remove_dir_all(work_dir);
}

#[test]
fn golden_source_json_mode_asserts_byte_identity_as_one_retained_case() {
    let game_dir = temp_dir("k032-source-json-pass-game");
    write_file_all(&game_dir, "source.json", b"{\"units\": []}\n");
    let work_dir = temp_dir("k032-source-json-pass-work");

    let mut registry = AdapterRegistry::new();
    registry.register(SourceJsonGoldenAdapter { mutate: false });

    let report = run_round_trip_golden(
        &registry,
        GoldenHarnessRequest {
            game_dir: &game_dir,
            work_dir: &work_dir,
            adapter_id: Some("kaifuu.source-json-golden"),
            byte_equivalence: GoldenByteEquivalenceMode::AssertSourceJson,
            translated_patch_export: None,
            translated_source_bridge: None,
        },
    )
    .unwrap();

    assert_eq!(report.status, OperationStatus::Passed);
    let byte_phase = report
        .phases
        .iter()
        .find(|phase| phase.phase == "byte_equivalence")
        .expect("byte equivalence phase");
    assert_eq!(byte_phase.status, GoldenAssertionStatus::Passed);
    assert_eq!(byte_phase.asset_ref.as_deref(), Some("source.json"));

    let _ = fs::remove_dir_all(game_dir);
    let _ = fs::remove_dir_all(work_dir);
}

#[test]
fn golden_source_json_mode_flags_byte_mismatch() {
    let game_dir = temp_dir("k032-source-json-fail-game");
    write_file_all(&game_dir, "source.json", b"{\"units\": []}\n");
    let work_dir = temp_dir("k032-source-json-fail-work");

    let mut registry = AdapterRegistry::new();
    registry.register(SourceJsonGoldenAdapter { mutate: true });

    let report = run_round_trip_golden(
        &registry,
        GoldenHarnessRequest {
            game_dir: &game_dir,
            work_dir: &work_dir,
            adapter_id: Some("kaifuu.source-json-golden"),
            byte_equivalence: GoldenByteEquivalenceMode::AssertSourceJson,
            translated_patch_export: None,
            translated_source_bridge: None,
        },
    )
    .unwrap();

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.failures.iter().any(|failure| {
        failure.phase == "byte_equivalence" && failure.code == "byte_equivalence_mismatch"
    }));

    let _ = fs::remove_dir_all(game_dir);
    let _ = fs::remove_dir_all(work_dir);
}

struct GoldenPreflightBoundaryAdapter {
    block_on_preflight_call: usize,
    preflight_calls: Arc<AtomicUsize>,
    patch_calls: Arc<AtomicUsize>,
}

impl GoldenPreflightBoundaryAdapter {
    fn preflight_failure(&self, patch_export: &PatchExport) -> PatchResult {
        let raw_key = "00112233445566778899aabbccddeeff";
        let preflight = LayeredAccessPreflightReport::from_requirements(
            self.id(),
            "fixture",
            "layered-access-test",
            vec![
                LayeredAccessPreflightRequirement::missing_capability(
                    LayeredAccessStage::Container,
                    "private-route-name/ending.ks",
                    "container helper unavailable for $HOME/Private Route Spoiler Game/data.xp3",
                ),
                LayeredAccessPreflightRequirement::missing_capability(
                    LayeredAccessStage::Crypto,
                    "%USERPROFILE%\\Games\\Scene.pck",
                    format!(
                        "helper dump at ~/games/private/key.bin included unresolved raw key {raw_key}"
                    ),
                ),
            ],
        );
        PatchResult {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: "patch-result=~/Private Route Spoiler Game/patch-result.json"
                .to_string(),
            patch_export_id: patch_export.patch_export_id.clone(),
            status: OperationStatus::Failed,
            output_hash: format!("helper dump output hash {raw_key}"),
            failures: preflight.failures,
        }
    }
}

impl EngineAdapter for GoldenPreflightBoundaryAdapter {
    fn id(&self) -> &'static str {
        "kaifuu.golden-preflight-boundary"
    }

    fn name(&self) -> &'static str {
        "Golden Preflight Boundary"
    }

    fn capabilities(&self) -> AdapterCapabilities {
        // the golden boundary covers Detection, Extraction
        // Patching, Verification — but not AssetListing/AssetInventory,
        // so derive the matrix explicitly to keep the registry gate
        // honest (Inventory will land at Unsupported).
        let reports = vec![
            CapabilityReport::supported(Capability::Detection),
            CapabilityReport::supported(Capability::Extraction),
            CapabilityReport::supported(Capability::Patching),
            CapabilityReport::supported(Capability::Verification),
        ];
        let matrix = AdapterCapabilityMatrix::derive_from_reports(self.id(), &reports);
        AdapterCapabilities::new(self.id(), reports, matrix)
    }

    fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
        Ok(DetectionResult {
            adapter_id: self.id().to_string(),
            detected: true,
            engine_family: Some("fixture".to_string()),
            engine_version: None,
            detected_variant: Some("preflight-boundary".to_string()),
            evidence: vec![],
            requirements: vec![],
            capabilities: self.capabilities().reports,
        })
    }

    fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
        Ok(golden_boundary_profile(self.id()))
    }

    fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
        Ok(AssetList {
            adapter_id: self.id().to_string(),
            assets: vec![],
        })
    }

    fn asset_inventory(
        &self,
        _request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest> {
        Err("asset inventory is not used by golden preflight tests".into())
    }

    fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
        Ok(golden_boundary_extraction(self.id()))
    }

    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        let call = self.preflight_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if call == self.block_on_preflight_call {
            Ok(self.preflight_failure(request.patch_export))
        } else {
            Ok(PatchResult::preflight_pass(request.patch_export))
        }
    }

    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
        self.patch_calls.fetch_add(1, Ordering::SeqCst);
        fs::write(request.output_dir.join("source.json"), "{}\n")?;
        Ok(PatchResult {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: deterministic_id("patch-result", 91),
            patch_export_id: request.patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: content_hash("patched"),
            failures: vec![],
        })
    }

    fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
        Ok(VerificationResult {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: deterministic_id("verify", 91),
            status: OperationStatus::Passed,
            output_hash: content_hash("verified"),
            failures: vec![],
        })
    }
}

#[test]
fn archive_detection_matrix_reports_requested_engine_families() {
    let root = temp_dir("archive-matrix-families");
    write_fixture_file(
        &root,
        "private-spoiler-route-name.xp3",
        b"XP3\r\nKAIFUU-XP3-ENCRYPTED",
    );
    write_fixture_file(&root, "Scene.pck", b"siglus scene package");
    write_fixture_file(&root, "Gameexe.dat", b"siglus metadata");
    write_fixture_file(
        &root,
        "www/data/System.json",
        br#"{
  "hasEncryptedImages": true,
  "hasEncryptedAudio": true,
  "encryptionKey": "00112233445566778899aabbccddeeff"
}"#,
    );
    write_fixture_file(&root, "img/pictures/title.rpgmvp", b"rpgmvp synthetic");
    write_fixture_file(&root, "img/pictures/title.png_", b"mz image synthetic");
    write_fixture_file(
        &root,
        "img/pictures/plain-title.png",
        b"plain image synthetic",
    );
    write_fixture_file(
        &root,
        "img/pictures/title.webp_",
        b"unknown image synthetic",
    );
    write_fixture_file(&root, "audio/bgm/theme.m4a_", b"mz audio synthetic");
    write_fixture_file(&root, "audio/se/cursor.ogg_", b"mz audio synthetic");
    write_fixture_file(
        &root,
        "Data.wolf",
        b"WOLF RPG Editor synthetic WOLF-PROTECTED protection-key",
    );
    write_fixture_file(&root, "pack.arc", b"BURIKO ARC20\0BGI-ENCRYPTED synthetic");
    write_fixture_file(&root, "game/archive.rpa", b"RenPy archive synthetic");
    write_fixture_file(&root, "game/script.rpyc", b"RenPy bytecode synthetic");
    write_fixture_file(&root, "mystery/private-route-name.pak", b"unknown archive");

    let report = ArchiveDetectionReport::scan(&root);

    assert_eq!(report.status, ArchiveDetectionStatus::Matched);
    assert_eq!(
        report
            .rows
            .iter()
            .map(|row| row.row_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "kirikiri-xp3",
            "siglus-scene-pck",
            "reallive-seen-txt",
            "rpg-maker-mv-mz-encrypted-assets",
            "wolf-rpg-editor-archives",
            "bgi-ethornell-containers",
            "renpy-packed-inputs",
            "unknown-archive-variant",
        ]
    );

    let kirikiri = detected_archive_row(&report, "kirikiri-xp3");
    assert!(
        kirikiri
            .signals
            .contains(&ArchiveDetectionSignal::Encrypted)
    );
    assert!(
        kirikiri.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == SemanticErrorCode::UnsupportedVariantEncrypted
        })
    );

    let siglus = detected_archive_row(&report, "siglus-scene-pck");
    assert!(siglus.signals.contains(&ArchiveDetectionSignal::MissingKey));
    assert!(
        siglus
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == SemanticErrorCode::HelperUnavailable })
    );

    let rpg_maker = detected_archive_row(&report, "rpg-maker-mv-mz-encrypted-assets");
    assert_eq!(rpg_maker.detected_variant, "mv_or_mz_with_unknown_suffix");
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 4
    }));
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == RPG_MAKER_MV_MZ_PLAIN_SUFFIX_PATTERN
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == RPG_MAKER_MV_MZ_UNKNOWN_SUFFIX_PATTERN
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == "data/System.json encryption fields"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(rpg_maker.surfaces.iter().any(|surface| {
        surface.fixture_id == "kaifuu-rpgmaker-mv-image-rpgmvp"
            && surface.engine_family == "rpg_maker_mv_mz"
            && surface.variant == "mv_or_mz"
            && surface.container == ContainerTransform::ProjectAsset
            && surface.crypto == CryptoTransform::RpgMakerAssetXor
            && surface.codec == CodecTransform::PngImage
            && surface.surface == "image_asset"
            && surface.key_requirement_refs == vec!["rpg-maker-mv-mz-asset-key".to_string()]
    }));
    assert!(rpg_maker.surfaces.iter().any(|surface| {
        surface.fixture_id == "kaifuu-rpgmaker-plain-image-png"
            && surface.variant == "plain_asset"
            && surface.crypto == CryptoTransform::NullKey
            && surface.codec == CodecTransform::PngImage
            && surface.key_requirement_refs.is_empty()
            && surface.diagnostics.is_empty()
    }));
    assert!(rpg_maker.surfaces.iter().any(|surface| {
        surface.fixture_id == "kaifuu-rpgmaker-unknown-webp_"
            && surface.variant == "unknown_suffix"
            && surface.crypto == CryptoTransform::Unknown
            && surface.key_requirement_refs.is_empty()
            && surface
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == SemanticErrorCode::MissingCryptoCapability)
    }));

    let wolf = detected_archive_row(&report, "wolf-rpg-editor-archives");
    assert!(wolf.signals.contains(&ArchiveDetectionSignal::Protected));
    assert!(wolf.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == SemanticErrorCode::ProtectedExecutableUnsupported
    }));

    let bgi = detected_archive_row(&report, "bgi-ethornell-containers");
    assert!(
        bgi.signals
            .contains(&ArchiveDetectionSignal::UnknownVariant)
    );
    assert!(
        bgi.diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == SemanticErrorCode::UnknownEngineVariant })
    );

    let renpy = detected_archive_row(&report, "renpy-packed-inputs");
    assert!(
        renpy
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == SemanticErrorCode::UnsupportedVariantPacked })
    );

    let unknown = detected_archive_row(&report, "unknown-archive-variant");
    assert!(
        unknown
            .signals
            .contains(&ArchiveDetectionSignal::UnknownVariant)
    );

    let serialized = serde_json::to_string(&report).unwrap();
    assert!(!serialized.contains("private-spoiler-route-name"));
    assert!(!serialized.contains("private-route-name"));
    assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
    assert!(!serialized.contains("confidence"));
    assert!(serialized.contains("aggregate-only"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_detection_plain_xp3_with_marker_like_payload_is_not_encrypted_or_compressed() {
    // a valid plain XP3 whose member payload legitimately
    // contains marker-like text ("XP3-CRYPT", "xp3-encrypted",
    // "xp3-compressed") must be classified PLAIN. The aggregate detector
    // must not treat an incidental payload substring as a structural
    // subtype marker.
    let root = temp_dir("kirikiri-xp3-plain-with-marker-payload");
    let bytes = plain_xp3_fixture(&[Xp3TestEntry {
        path: "scenario/spoiler.ks",
        // Marker-like tokens embedded in ordinary member payload
        // bytes — exactly the false-positive trigger.
        payload:
            b"the villain says: XP3-CRYPT and xp3-encrypted and xp3-compressed are just words here",
        compressed: false,
        adler32: 0x0102_0304,
    }]);
    // Sanity: the fixture really is a genuine plain XP3 the structural
    // parser accepts, and the marker-like text lands inside the header
    // window the detector reads.
    assert!(bytes.starts_with(XP3_PLAIN_MAGIC));
    assert!(read_plain_xp3_inventory(&bytes).is_ok());
    write_fixture_file(&root, "private-route-name.xp3", &bytes);

    let report = ArchiveDetectionReport::scan(&root);
    let kirikiri = detected_archive_row(&report, "kirikiri-xp3");
    assert_eq!(
        kirikiri.detected_variant, "xp3-archive",
        "plain XP3 with marker-like payload must classify as a plain archive"
    );
    assert!(
        !kirikiri
            .signals
            .contains(&ArchiveDetectionSignal::Encrypted),
        "plain XP3 must not be flagged encrypted from a payload substring: {kirikiri:#?}"
    );
    assert!(
        !kirikiri
            .signals
            .contains(&ArchiveDetectionSignal::Compressed),
        "plain XP3 must not be flagged compressed from a payload substring: {kirikiri:#?}"
    );
    assert!(
        !kirikiri
            .signals
            .contains(&ArchiveDetectionSignal::UnknownVariant)
    );
    // The encrypted-marker evidence count is zero for a plain archive.
    assert!(kirikiri.evidence.iter().any(|evidence| {
        evidence.pattern == "synthetic XP3 encryption marker" && evidence.count == 0
    }));
    assert!(kirikiri.evidence.iter().any(|evidence| {
        evidence.pattern == "synthetic XP3 compression marker" && evidence.count == 0
    }));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_detection_bgi_negative_variants_emit_unknown_and_missing_capability_diagnostics() {
    let root = temp_dir("bgi-negative-variants");
    write_fixture_file(
        &root,
        "bse.arc",
        b"BURIKO ARC20\0BGI-ENCRYPTED synthetic BSE marker",
    );
    write_fixture_file(
        &root,
        "dsc.arc",
        b"BURIKO ARC20\0DSC-COMPRESSED synthetic compressed marker",
    );
    write_fixture_file(
        &root,
        "layer.arc",
        b"BURIKO ARC20\0CompressedBG synthetic layered transform marker",
    );

    let report = ArchiveDetectionReport::scan(&root);
    let bgi = detected_archive_row(&report, "bgi-ethornell-containers");

    assert_eq!(
        bgi.detected_variant,
        "buriko-arc20-compressed-bg-layered-transform"
    );
    assert_eq!(bgi.requirements, vec![]);
    assert!(
        bgi.signals
            .contains(&ArchiveDetectionSignal::UnknownVariant)
    );
    assert!(bgi.signals.contains(&ArchiveDetectionSignal::Encrypted));
    assert!(
        bgi.signals
            .contains(&ArchiveDetectionSignal::CryptoUnsupported)
    );
    assert!(bgi.signals.contains(&ArchiveDetectionSignal::Compressed));
    assert!(
        bgi.signals
            .contains(&ArchiveDetectionSignal::LayeredTransform)
    );
    assert!(bgi.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == SemanticErrorCode::UnknownEngineVariant
            && diagnostic.required_capability == Some(Capability::Detection)
    }));
    assert!(bgi.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == SemanticErrorCode::UnsupportedVariantEncrypted
            && diagnostic.required_capability == Some(Capability::EncryptedInput)
    }));
    // fixture parity: an encrypted (BSE) BGI archive must emit
    // the missing_capability.crypto diagnostic the detector fixtures claim.
    assert!(bgi.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == SemanticErrorCode::MissingCryptoCapability
            && diagnostic.required_capability == Some(Capability::CryptoAccess)
    }));
    assert!(bgi.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == SemanticErrorCode::MissingCodecCapability
            && diagnostic.required_capability == Some(Capability::CodecAccess)
    }));
    // fixture parity: a CompressedBG/layered BGI archive must
    // emit the unsupported layered-transform diagnostic the fixtures claim.
    assert!(bgi.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == SemanticErrorCode::UnsupportedLayeredTransform
            && diagnostic.required_capability == Some(Capability::ContainerAccess)
    }));
    assert!(bgi.capabilities.iter().any(|capability| {
        capability.capability == Capability::EncryptedInput
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(bgi.capabilities.iter().any(|capability| {
        capability.capability == Capability::CryptoAccess
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(bgi.capabilities.iter().any(|capability| {
        capability.capability == Capability::CodecAccess
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(bgi.capabilities.iter().any(|capability| {
        capability.capability == Capability::ContainerAccess
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(bgi.capabilities.iter().any(|capability| {
        capability.capability == Capability::Extraction
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(bgi.capabilities.iter().any(|capability| {
        capability.capability == Capability::Patching
            && capability.status == CapabilityStatus::Unsupported
    }));

    let serialized = serde_json::to_string(&report).unwrap();
    assert!(!serialized.contains("BGI-ENCRYPTED"));
    assert!(!serialized.contains("DSC-COMPRESSED"));
    assert!(!serialized.contains("CompressedBG"));

    let _ = fs::remove_dir_all(root);
}

// strict-proof: the detector fixtures
// (`fixtures/kaifuu/bgi/detector.profiles.json`) claim, per profile, the
// semantic diagnostics BGI containers produce (BSE encrypted =>
// missing_capability.crypto; CompressedBG layered => unsupported_layered_transform,
// etc.). This test proves the LIVE archive detector actually EMITS every
// semantic code those fixtures claim for a synthetic encrypted + compressed
// + layered BGI archive — so the fixtures never claim a diagnostic the live
// detector does not emit (no fixture-vs-detector drift).
#[test]
fn archive_detection_bgi_live_detector_agrees_with_kaifuu_128_fixture_claims() {
    // What the detector fixtures CLAIM, per profile.
    let fixture = read_bgi_detector_fixture(
        &test_manifest_dir()
            .join("../..")
            .join("fixtures/kaifuu/bgi/detector.profiles.json"),
    )
    .expect("KAIFUU-128 BGI detector fixture must parse");
    let fixture_report = run_bgi_detector_fixture(&fixture);
    assert_eq!(fixture_report.status, OperationStatus::Passed);

    let claimed_codes = |fixture_id: &str| -> Vec<SemanticErrorCode> {
        fixture_report
            .entry(fixture_id)
            .unwrap_or_else(|| panic!("missing fixture entry {fixture_id}"))
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.semantic_code)
            .collect()
    };
    let encrypted_claims = claimed_codes("bgi.bse-encrypted-container");
    let layered_claims = claimed_codes("bgi.compressed-bg-layered-transform");
    // Guard the drift class directly: the fixtures must genuinely CLAIM the
    // two codes the audit found missing from the live detector.
    assert!(encrypted_claims.contains(&SemanticErrorCode::MissingCryptoCapability));
    assert!(layered_claims.contains(&SemanticErrorCode::UnsupportedLayeredTransform));

    // What the LIVE archive detector EMITS for the same profiles combined.
    let root = temp_dir("bgi-live-vs-fixture");
    write_fixture_file(
        &root,
        "bse.arc",
        b"BURIKO ARC20\0BGI-ENCRYPTED synthetic BSE marker",
    );
    write_fixture_file(
        &root,
        "dsc.arc",
        b"BURIKO ARC20\0DSC-COMPRESSED synthetic compressed marker",
    );
    write_fixture_file(
        &root,
        "layer.arc",
        b"BURIKO ARC20\0CompressedBG synthetic layered transform marker",
    );
    let report = ArchiveDetectionReport::scan(&root);
    let bgi = detected_archive_row(&report, "bgi-ethornell-containers");
    let live_codes: Vec<SemanticErrorCode> = bgi.diagnostics.iter().map(|d| d.code).collect();

    // Every semantic code the fixtures claim for the encrypted + layered
    // profiles must be emitted by the live detector: fixture ⊆ detector.
    for claimed in encrypted_claims.iter().chain(layered_claims.iter()) {
        assert!(
            live_codes.contains(claimed),
            "fixture claims {claimed:?} but the live BGI detector did not emit it (drift); live emitted {live_codes:?}"
        );
    }

    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_detection_genuinely_encrypted_and_compressed_xp3_are_still_detected() {
    // true-positive guard: hardening the marker scan must not
    // break detection of a real synthetic encrypted/compressed XP3, whose
    // subtype token sits on the structural marker line right after the
    // `XP3\r\n` container prefix.
    let encrypted_root = temp_dir("kirikiri-xp3-genuine-encrypted");
    write_fixture_file(
        &encrypted_root,
        "private-route-name.xp3",
        b"XP3\r\nXP3-CRYPT\nkaifuu-xp3-encrypted synthetic fixture\n",
    );
    let report = ArchiveDetectionReport::scan(&encrypted_root);
    let kirikiri = detected_archive_row(&report, "kirikiri-xp3");
    assert_eq!(kirikiri.detected_variant, "xp3-encrypted-archive");
    assert!(
        kirikiri
            .signals
            .contains(&ArchiveDetectionSignal::Encrypted)
    );
    assert!(
        kirikiri.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == SemanticErrorCode::UnsupportedVariantEncrypted
        })
    );
    let _ = fs::remove_dir_all(encrypted_root);

    let compressed_root = temp_dir("kirikiri-xp3-genuine-compressed");
    write_fixture_file(
        &compressed_root,
        "private-route-name.xp3",
        b"XP3\r\nXP3-COMPRESSED\nkaifuu-xp3-compressed synthetic fixture\n",
    );
    let report = ArchiveDetectionReport::scan(&compressed_root);
    let kirikiri = detected_archive_row(&report, "kirikiri-xp3");
    assert_eq!(kirikiri.detected_variant, "xp3-compressed-archive");
    assert!(
        kirikiri
            .signals
            .contains(&ArchiveDetectionSignal::Compressed)
    );
    let _ = fs::remove_dir_all(compressed_root);
}

#[test]
fn archive_detection_matrix_includes_reallive_row() {
    let root = temp_dir("reallive-row-present");
    write_fixture_file(&root, "placeholder.txt", b"unrelated");
    let report = ArchiveDetectionReport::scan(&root);
    assert!(
        report
            .rows
            .iter()
            .any(|row| row.row_id == "reallive-seen-txt"),
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_detection_reallive_row_reports_seen_txt_and_gameexe_ini_counts_as_aggregate_evidence() {
    let root = temp_dir("reallive-row-aggregate-evidence");
    write_fixture_file(&root, "SEEN.TXT", b"SEEN\x01");
    write_fixture_file(&root, "SEEN.GAN", b"GAN\x01");
    write_fixture_file(
        &root,
        "Gameexe.ini",
        b"# RealLive Gameexe.ini fixture\n#GAMEEXE_VERSION=1.0\n",
    );
    write_fixture_file(&root, "image.g00", b"\0");
    write_fixture_file(&root, "voice.ovk", b"\0");
    let report = ArchiveDetectionReport::scan(&root);
    let reallive = detected_archive_row(&report, "reallive-seen-txt");
    assert_eq!(reallive.engine_family, ArchiveEngineFamily::RealLive);
    assert_eq!(reallive.detected_variant, "reallive-seen-txt-archive");
    assert!(reallive.signals.contains(&ArchiveDetectionSignal::Packed));
    assert!(reallive.evidence.iter().any(|evidence| {
        evidence.pattern == "SEEN.TXT"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(reallive.evidence.iter().any(|evidence| {
        evidence.pattern == "SEEN.GAN"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(reallive.evidence.iter().any(|evidence| {
        evidence.pattern == "Gameexe.ini"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(reallive.evidence.iter().any(|evidence| {
        evidence.pattern == "*.g00"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(reallive.evidence.iter().any(|evidence| {
        evidence.pattern == "*.ovk|*.koe|*.nwk"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_detection_reallive_row_emits_ambiguous_diagnostic_when_siglus_markers_co_present() {
    let root = temp_dir("reallive-row-ambiguous-siglus");
    write_fixture_file(&root, "SEEN.TXT", b"SEEN\x01");
    write_fixture_file(
        &root,
        "Gameexe.ini",
        b"# RealLive Gameexe.ini fixture\n#GAMEEXE_VERSION=1.0\n",
    );
    write_fixture_file(&root, "Scene.pck", b"SIGLUS-SCENE-PCK");
    write_fixture_file(&root, "Gameexe.dat", b"SIGLUS-GAMEEXE-DAT");
    let report = ArchiveDetectionReport::scan(&root);
    let reallive = report
        .rows
        .iter()
        .find(|row| row.row_id == "reallive-seen-txt")
        .unwrap();
    assert!(!reallive.detected);
    assert_eq!(
        reallive.detected_variant,
        "ambiguous-reallive-siglus-scene-pck"
    );
    assert!(
        reallive
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == SemanticErrorCode::AmbiguousEngineVariant })
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_detection_reallive_row_emits_unsupported_engine_variant_for_avg32_lineage() {
    let root = temp_dir("reallive-row-avg32-lineage");
    write_fixture_file(&root, "SEEN.TXT", b"SEEN\x01");
    write_fixture_file(&root, "image.PDT", b"\0");
    let report = ArchiveDetectionReport::scan(&root);
    let reallive = report
        .rows
        .iter()
        .find(|row| row.row_id == "reallive-seen-txt")
        .unwrap();
    assert!(!reallive.detected);
    assert_eq!(reallive.detected_variant, "avg32-lineage-seen-txt");
    assert!(
        reallive
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == SemanticErrorCode::UnsupportedEngineVariant })
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_detection_reallive_row_does_not_claim_extraction_or_patch_support() {
    let root = temp_dir("reallive-row-no-extract-claim");
    write_fixture_file(&root, "SEEN.TXT", b"SEEN\x01");
    write_fixture_file(&root, "Gameexe.ini", b"# RealLive Gameexe.ini fixture\n");
    let report = ArchiveDetectionReport::scan(&root);
    let reallive = detected_archive_row(&report, "reallive-seen-txt");
    assert!(reallive.capabilities.iter().any(|capability| {
        capability.capability == Capability::Extraction
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(reallive.capabilities.iter().any(|capability| {
        capability.capability == Capability::Patching
            && capability.status == CapabilityStatus::Unsupported
    }));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rpg_maker_encrypted_suffix_detection_matrix_covers_mv_mz_suffixes() {
    let root = temp_dir("rpg-maker-suffix-matrix");
    for suffix in RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIXES {
        write_fixture_file(
            &root,
            &format!("encrypted-assets/sample.{suffix}"),
            b"synthetic encrypted RPG Maker asset suffix fixture",
        );
    }

    let report = ArchiveDetectionReport::scan(&root);

    assert_eq!(report.status, ArchiveDetectionStatus::Matched);
    let rpg_maker = detected_archive_row(&report, "rpg-maker-mv-mz-encrypted-assets");
    assert_eq!(rpg_maker.detected_variant, "mv_or_mz");
    assert_eq!(
        rpg_maker.signals,
        vec![
            ArchiveDetectionSignal::Encrypted,
            ArchiveDetectionSignal::MissingKey,
        ]
    );
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIXES.len() as u64
    }));
    assert!(rpg_maker.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == SemanticErrorCode::UnsupportedVariantEncrypted
            && diagnostic.required_capability == Some(Capability::EncryptedInput)
    }));
    assert!(rpg_maker.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == SemanticErrorCode::MissingKeyMaterial
            && diagnostic.required_capability == Some(Capability::KeyProfile)
    }));
    assert!(rpg_maker.capabilities.iter().any(|capability| {
        capability.capability == Capability::EncryptedInput
            && capability.status == CapabilityStatus::Unsupported
    }));
    assert!(rpg_maker.capabilities.iter().any(|capability| {
        capability.capability == Capability::KeyProfile
            && capability.status == CapabilityStatus::RequiresUserInput
    }));
    assert_eq!(rpg_maker.requirements.len(), 1);
    assert_eq!(rpg_maker.requirements[0].key, "rpg-maker-mv-mz-asset-key");
    assert_eq!(
        rpg_maker.surfaces.len(),
        RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIXES.len()
    );
    for suffix in RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIXES {
        let surface = rpg_maker
            .surfaces
            .iter()
            .find(|surface| surface.fixture_id.ends_with(suffix))
            .unwrap_or_else(|| panic!("missing surface for suffix {suffix}"));
        assert_eq!(surface.engine_family, "rpg_maker_mv_mz");
        assert_eq!(surface.variant, "mv_or_mz");
        assert_eq!(surface.container, ContainerTransform::ProjectAsset);
        assert_eq!(surface.crypto, CryptoTransform::RpgMakerAssetXor);
        assert_eq!(
            surface.key_requirement_refs,
            vec!["rpg-maker-mv-mz-asset-key"]
        );
        assert!(
            surface
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.code == SemanticErrorCode::MissingKeyMaterial })
        );
    }

    let serialized = serde_json::to_string(&report).unwrap();
    assert!(!serialized.contains("sample.rpgmvp"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn rpg_maker_unknown_suffixes_do_not_emit_missing_key_without_known_requirement() {
    let root = temp_dir("rpg-maker-unknown-suffix-matrix");
    for suffix in RPG_MAKER_MV_MZ_UNKNOWN_SUFFIXES {
        write_fixture_file(
            &root,
            &format!("encrypted-assets/sample.{suffix}"),
            b"synthetic unknown RPG Maker-like asset suffix fixture",
        );
    }

    let report = ArchiveDetectionReport::scan(&root);

    assert_eq!(report.status, ArchiveDetectionStatus::Matched);
    let rpg_maker = detected_archive_row(&report, "rpg-maker-mv-mz-encrypted-assets");
    assert_eq!(rpg_maker.detected_variant, "unknown_suffix");
    assert_eq!(
        rpg_maker.signals,
        vec![ArchiveDetectionSignal::UnknownVariant]
    );
    assert!(rpg_maker.requirements.is_empty());
    assert!(
        !rpg_maker
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == SemanticErrorCode::MissingKeyMaterial)
    );
    assert!(
        rpg_maker
            .diagnostics
            .iter()
            .any(|diagnostic| { diagnostic.code == SemanticErrorCode::UnknownEngineVariant })
    );
    assert_eq!(
        rpg_maker.surfaces.len(),
        RPG_MAKER_MV_MZ_UNKNOWN_SUFFIXES.len()
    );
    for surface in &rpg_maker.surfaces {
        assert_eq!(surface.engine_family, "rpg_maker_mv_mz");
        assert_eq!(surface.variant, "unknown_suffix");
        assert_eq!(surface.container, ContainerTransform::ProjectAsset);
        assert_eq!(surface.crypto, CryptoTransform::Unknown);
        assert_eq!(surface.codec, CodecTransform::Unknown);
        assert!(surface.key_requirement_refs.is_empty());
        assert!(
            surface.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == SemanticErrorCode::MissingCryptoCapability
            })
        );
        assert!(
            !surface
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == SemanticErrorCode::MissingKeyMaterial)
        );
    }

    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_detection_normalizes_marker_only_subtypes_to_unknown_variant_diagnostics() {
    let root = temp_dir("archive-marker-only");
    let marker_only_fixtures: &[(&str, &[u8])] = &[
        (
            "notes/kaifuu-xp3-encrypted-marker.txt",
            b"synthetic kaifuu-xp3-encrypted marker",
        ),
        (
            "notes/xp3-encrypted-marker.txt",
            b"synthetic xp3-encrypted marker",
        ),
        ("notes/xp3-crypt-marker.txt", b"synthetic xp3-crypt marker"),
        ("notes/bgi-marker.txt", b"BGI-ENCRYPTED"),
        ("notes/ethornell-marker.txt", b"ethornell-encrypted"),
        ("notes/wolf-protected-marker.txt", b"wolf-protected"),
        ("notes/wolf-protection-key-marker.txt", b"protection-key"),
    ];
    for (relative_path, bytes) in marker_only_fixtures {
        write_fixture_file(&root, relative_path, bytes);
    }

    let report = ArchiveDetectionReport::scan(&root);

    assert_eq!(report.status, ArchiveDetectionStatus::Matched);
    for row_id in [
        "kirikiri-xp3",
        "bgi-ethornell-containers",
        "wolf-rpg-editor-archives",
    ] {
        let row = report
            .rows
            .iter()
            .find(|row| row.row_id == row_id)
            .unwrap_or_else(|| panic!("missing archive row {row_id}"));
        assert!(!row.detected, "{row_id} should not be family-detected");
        assert!(
            row.signals.is_empty(),
            "{row_id} leaked marker-only signals"
        );
        assert!(
            row.requirements.is_empty(),
            "{row_id} leaked marker-only key requirements"
        );
        assert!(
            row.diagnostics.is_empty(),
            "{row_id} leaked marker-only diagnostics"
        );
        assert!(!row.capabilities.iter().any(|capability| {
            capability.capability == Capability::EncryptedInput
                || capability.capability == Capability::KeyProfile
        }));
    }

    let unknown = detected_archive_row(&report, "unknown-archive-variant");
    assert_eq!(
        unknown.signals,
        vec![ArchiveDetectionSignal::UnknownVariant]
    );
    assert!(unknown.evidence.iter().any(|evidence| {
        evidence.pattern == "orphaned encrypted/protected subtype marker"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == marker_only_fixtures.len() as u64
    }));
    assert!(unknown.diagnostics.iter().any(|diagnostic| {
        diagnostic.code == SemanticErrorCode::UnknownEngineVariant
            && diagnostic.required_capability == Some(Capability::Detection)
    }));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn archive_detection_preserves_wolf_match_with_primary_evidence() {
    let root = temp_dir("wolf-primary-evidence");
    write_fixture_file(
        &root,
        "notes/wolf-header.txt",
        b"WOLF RPG Editor synthetic wolf-protected protection-key marker",
    );
    write_fixture_file(
        &root,
        "Data.wolf",
        b"synthetic protected archive marker without textual header",
    );

    let report = ArchiveDetectionReport::scan(&root);

    assert_eq!(report.status, ArchiveDetectionStatus::Matched);
    let wolf = detected_archive_row(&report, "wolf-rpg-editor-archives");
    assert_eq!(wolf.detected_variant, "wolf-protected-archive");
    assert!(wolf.signals.contains(&ArchiveDetectionSignal::Packed));
    assert!(wolf.signals.contains(&ArchiveDetectionSignal::Encrypted));
    assert!(wolf.signals.contains(&ArchiveDetectionSignal::Protected));
    assert!(wolf.evidence.iter().any(|evidence| {
        evidence.pattern == "*.wolf"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(wolf.evidence.iter().any(|evidence| {
        evidence.pattern == "WOLF header"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(wolf.evidence.iter().any(|evidence| {
        evidence.pattern == "Wolf protection marker"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 2
    }));
    assert_eq!(wolf.requirements.len(), 1);
    assert_eq!(wolf.requirements[0].key, "wolf-rpg-editor-archive-key");

    let unknown = report
        .rows
        .iter()
        .find(|row| row.row_id == "unknown-archive-variant")
        .unwrap();
    assert!(!unknown.detected);
    assert!(unknown.evidence.iter().any(|evidence| {
        evidence.pattern == "orphaned encrypted/protected subtype marker"
            && evidence.status == EvidenceStatus::Missing
            && evidence.count == 0
    }));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn detection_report_status_matches_archive_only_inputs_without_adapter_claims() {
    let root = temp_dir("archive-only-detection-report");
    write_fixture_file(&root, "game/scripts.rpa", b"RenPy archive synthetic");
    let report = DetectionReport::from_results(
        &root,
        vec![DetectionResult {
            adapter_id: "kaifuu.fixture".to_string(),
            detected: false,
            engine_family: None,
            engine_version: None,
            detected_variant: None,
            evidence: vec![],
            requirements: vec![],
            capabilities: vec![],
        }],
    );

    assert_eq!(report.status, DetectionReportStatus::Unknown);
    assert_eq!(
        report.archive_detection.status,
        ArchiveDetectionStatus::Matched
    );
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| { warning.contains("no registered extraction adapter") })
    );
    let renpy = detected_archive_row(&report.archive_detection, "renpy-packed-inputs");
    assert!(renpy.capabilities.iter().any(|capability| {
        capability.capability == Capability::Extraction
            && capability.status == CapabilityStatus::Unsupported
    }));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn detection_report_redacts_absolute_game_dir_and_private_title() {
    let root = temp_dir("private-detection-report");
    let game_dir = root.join("Private Route Spoiler Game");
    fs::create_dir_all(&game_dir).unwrap();
    write_fixture_file(&game_dir, "img/pictures/spoiler-title.png_", b"encrypted");
    let report = DetectionReport::from_results(
        &game_dir,
        vec![DetectionResult {
            adapter_id: "kaifuu.fixture".to_string(),
            detected: false,
            engine_family: None,
            engine_version: None,
            detected_variant: None,
            evidence: vec![],
            requirements: vec![],
            capabilities: vec![],
        }],
    );

    assert_eq!(report.game_dir, REDACTED_DETECTION_GAME_DIR);
    let serialized = serde_json::to_string(&report).unwrap();
    assert!(!serialized.contains(&game_dir.display().to_string()));
    assert!(!serialized.contains("Private Route Spoiler Game"));
    assert!(!serialized.contains("spoiler-title"));
    let rpg_maker = detected_archive_row(
        &report.archive_detection,
        "rpg-maker-mv-mz-encrypted-assets",
    );
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));

    let _ = fs::remove_dir_all(root);
}

const UNSAFE_RELATIVE_PATH_FIXTURES: &[(&str, &str)] = &[
    ("empty", ""),
    ("absolute slash", "/source.json"),
    ("absolute backslash", "\\source.json"),
    ("ordinary backslash", "data\\source.json"),
    ("drive absolute slash", "C:/source.json"),
    ("drive absolute backslash", "C:\\source.json"),
    ("drive relative upper", "C:source.json"),
    ("drive relative lower", "c:source.json"),
    ("drive prefix component slash", "data/C:source.json"),
    ("drive prefix component backslash", "data\\C:source.json"),
    ("dot only", "."),
    ("leading dot slash", "./source.json"),
    ("leading dot backslash", ".\\source.json"),
    ("dot component slash", "data/./source.json"),
    ("dot component backslash", "data\\.\\source.json"),
    ("trailing dot component", "data/."),
    ("parent leading slash", "../source.json"),
    ("parent leading backslash", "..\\source.json"),
    ("parent component slash", "data/../source.json"),
    ("parent component backslash", "data\\..\\source.json"),
    ("empty component slash", "data//source.json"),
    ("empty component backslash", "data\\\\source.json"),
    ("nul byte", "source.json\0suffix"),
];

fn profile_with_asset_path(path: &str) -> Value {
    serde_json::json!({
        "schemaVersion": PROFILE_SCHEMA_VERSION,
        "profileId": deterministic_id("profile", 1),
        "gameId": "hello-fixture",
        "title": "Hello Fixture",
        "sourceLocale": "ja-JP",
        "engine": {
            "adapterId": "kaifuu.fixture",
            "engineFamily": "fixture",
            "engineVersion": null,
            "detectedVariant": "plain-json"
        },
        "assets": [
            {
                "assetId": deterministic_id("asset", 1),
                "path": path,
                "assetKind": "script",
                "textSurfaces": ["dialogue"],
                "patching": {
                    "capability": "patching",
                    "status": "supported",
                    "limitation": null
                }
            }
        ],
        "capabilities": [
            {
                "capability": "patching",
                "status": "supported",
                "limitation": null
            }
        ],
        "requirements": []
    })
}

#[test]
fn safe_relative_path_validator_and_join_share_negative_matrix() {
    let root = Path::new("patched-game");
    let safe = safe_join_relative(root, "data/source.json").unwrap();
    assert_eq!(safe, root.join("data").join("source.json"));
    assert!(validate_safe_relative_path("data/source.json").is_ok());

    for (case, unsafe_path) in UNSAFE_RELATIVE_PATH_FIXTURES {
        assert!(
            validate_safe_relative_path(unsafe_path).is_err(),
            "{case}: {unsafe_path:?} should be rejected by shared validation"
        );
        assert!(
            safe_join_relative(root, unsafe_path).is_err(),
            "{case}: {unsafe_path:?} should be rejected by safe_join_relative"
        );
    }
}

#[test]
fn profile_validation_uses_shared_relative_path_negative_matrix() {
    for (case, unsafe_path) in UNSAFE_RELATIVE_PATH_FIXTURES {
        let profile = profile_with_asset_path(unsafe_path);
        let validation = validate_profile_value(&profile);

        assert_eq!(
            validation.status,
            OperationStatus::Failed,
            "{case}: {unsafe_path:?} should fail profile validation"
        );
        if unsafe_path.is_empty() {
            assert!(
                validation.failures.iter().any(|failure| {
                    failure.code == "missing_required_field" && failure.field == "assets.0.path"
                }),
                "{case}: empty path should be rejected as a missing required field, got {:?}",
                validation.failures
            );
        } else {
            assert!(
                validation.failures.iter().any(|failure| {
                    failure.code == "invalid_asset_path" && failure.field == "assets.0.path"
                }),
                "{case}: {unsafe_path:?} should be rejected as invalid asset path, got {:?}",
                validation.failures
            );
        }
    }
}

const ALL_LETTER_RAW_KEY_MATERIAL: &str = "XqQbHYcPLaMRvTEsJZoWknNd";

fn valid_key_profile_value() -> Value {
    serde_json::json!({
        "schemaVersion": PROFILE_SCHEMA_VERSION,
        "profileId": deterministic_id("profile", 14),
        "gameId": "siglus-owned-local",
        "title": "Siglus Owned Local",
        "sourceLocale": "ja-JP",
        "engine": {
            "adapterId": "kaifuu.siglus",
            "engineFamily": "siglus",
            "engineVersion": null,
            "detectedVariant": "scene-pck-secondary-key"
        },
        "sourceFingerprint": {
            "gameRootHash": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "engineEvidence": ["Scene.pck", "Gameexe.dat"]
        },
        "keyRequirements": [
            {
                "requirementId": "siglus-secondary-key",
                "secretRef": "local-secret:siglus/example/secondary-key",
                "kind": "fixedBytes",
                "bytes": 16,
                "validation": {
                    "method": "decryptHeaderProof",
                    "proofHash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                }
            }
        ],
        "archiveParameters": [
            {
                "parameterId": "scene-archive",
                "name": "sceneArchive",
                "kind": "archiveFormat",
                "value": "Scene.pck",
                "source": "detected"
            }
        ],
        "helperEvidence": {
            "helperKind": "staticParser",
            "toolVersion": "kaifuu-key-helper/0.1.0",
            "redactedLogHash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "proofHashes": [
                {
                    "method": "decryptHeaderProof",
                    "proofHash": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                }
            ]
        },
        "assets": [
            {
                "assetId": deterministic_id("asset", 14),
                "path": "Scene.pck",
                "assetKind": "archive",
                "textSurfaces": ["dialogue"],
                "sourceHash": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                "patching": {
                    "capability": "patching",
                    "status": "limited",
                    "limitation": "requires caller-provided resolved keys and archive parameters"
                }
            }
        ],
        "capabilities": [
            {
                "capability": "key_profile",
                "status": "supported",
                "limitation": null
            },
            {
                "capability": "patching",
                "status": "limited",
                "limitation": "requires caller-provided resolved keys and archive parameters"
            }
        ],
        "requirements": [
            {
                "category": "secret_key",
                "key": "siglus-secondary-key",
                "status": "satisfied",
                "description": "secondary key is referenced through local secret storage",
                "placeholder": null,
                "secret": true
            }
        ],
        "metadata": {}
    })
}

#[derive(Debug, Clone)]
struct StubExternalSecretResolver {
    resolution: ExternalSecretResolution,
}

impl ExternalSecretResolver for StubExternalSecretResolver {
    fn resolve_external_secret(
        &self,
        _request: ExternalSecretRequest<'_>,
    ) -> Result<ExternalSecretResolution, KeyResolverError> {
        Ok(self.resolution.clone())
    }
}

fn key_profile_with_secret_ref(secret_ref: &str) -> GameProfile {
    let mut profile = valid_key_profile_value();
    profile["keyRequirements"][0]["secretRef"] = serde_json::json!(secret_ref);
    serde_json::from_value(profile).unwrap()
}

fn assert_key_resolver_error(
    result: Result<Option<Vec<u8>>, KeyResolverError>,
    expected_kind: KeyResolverErrorKind,
    expected_code: SemanticErrorCode,
) {
    let error = result.unwrap_err();
    assert_eq!(error.kind(), expected_kind);
    assert_eq!(error.semantic_code(), expected_code);
    let diagnostic = error.diagnostic();
    assert_eq!(diagnostic.kind, expected_kind);
    assert_eq!(diagnostic.code, expected_code);
    let serialized = serde_json::to_string(&diagnostic).unwrap();
    assert!(!serialized.contains("/tmp"));
    assert!(!serialized.contains("private"));
}

fn public_helper_result_fixture_value(name: &str) -> Value {
    bridge_fixture_value(&format!(
        "fixtures/public/kaifuu-helper-results/{name}.json"
    ))
}

fn invalid_public_helper_result_fixture_value(name: &str) -> Value {
    bridge_fixture_value(&format!(
        "fixtures/public/kaifuu-helper-results/invalid/{name}.json"
    ))
}

fn encrypted_matrix_fixture_value(relative_path: &str) -> Value {
    bridge_fixture_value(&format!(
        "fixtures/public/kaifuu-encrypted-matrix/{relative_path}"
    ))
}

fn public_helper_request_fixture_value(name: &str) -> Value {
    bridge_fixture_value(&format!(
        "fixtures/public/kaifuu-helper-results/helper-request/{name}.json"
    ))
}

fn public_helper_registry_fixture_value(name: &str) -> Value {
    bridge_fixture_value(&format!(
        "fixtures/public/kaifuu-helper-results/helper-registry/{name}.json"
    ))
}

fn public_helper_binary_path(name: &str) -> PathBuf {
    crate::test_manifest_dir()
        .join("../..")
        .join("fixtures/public/kaifuu-helper-results/helper-binaries")
        .join(name)
}

fn fixture_helper_invocation(input: &Value) -> HelperRegistryInvocationRequest<'_> {
    HelperRegistryInvocationRequest {
        helper_id: FIXTURE_HELPER_REGISTRY_ID,
        helper_version: "0.1.0",
        allowlist_entry_id: FIXTURE_HELPER_ALLOWLIST_REF_ID,
        capability: HelperCapability::FixtureInvocation,
        input,
    }
}

fn fixture_helper_key_validation(input: &Value) -> HelperRegistryInvocationRequest<'_> {
    HelperRegistryInvocationRequest {
        helper_id: FIXTURE_HELPER_REGISTRY_ID,
        helper_version: "0.1.0",
        allowlist_entry_id: FIXTURE_HELPER_ALLOWLIST_REF_ID,
        capability: HelperCapability::KeyValidation,
        input,
    }
}

#[test]
fn helper_execution_modes_have_no_external_process_launch_variant() {
    // Regression guard for the deleted external helper-process launch path.
    // No helper execution mode names a real local-process launch: helper key
    // discovery is in-process (StaticParser) or a dry-run descriptor only.
    assert!(
        serde_json::from_value::<HelperResultExecutionMode>(serde_json::json!("localProcess"))
            .is_err(),
        "HelperResultExecutionMode must not accept a real local-process launch mode"
    );
    assert!(
        serde_json::from_value::<HelperExecutionMode>(serde_json::json!("local_process")).is_err(),
        "HelperExecutionMode must not accept a real local-process launch policy"
    );
    // The remaining result modes are in-process or dry-run descriptors only.
    for mode in ["notExecuted", "inProcess", "platformHelper", "remoteHelper"] {
        assert!(
            serde_json::from_value::<HelperResultExecutionMode>(serde_json::json!(mode)).is_ok(),
            "expected descriptor mode {mode} to remain valid"
        );
    }
}

#[test]
fn public_helper_registry_fixtures_validate_semantic_diagnostics() {
    let valid = public_helper_registry_fixture_value("valid-helper");
    let validation = validate_helper_registry_entry_value(&valid);
    assert_eq!(
        validation.status,
        OperationStatus::Passed,
        "{:#?}",
        validation.diagnostics
    );
    let entry: HelperRegistryEntry = serde_json::from_value(valid).unwrap();
    assert_eq!(entry.helper_id, FIXTURE_HELPER_REGISTRY_ID);
    assert_eq!(
        entry.execution_policy.allowlist_ref_id,
        FIXTURE_HELPER_ALLOWLIST_REF_ID
    );
    assert_eq!(
        entry.binary_allowlist.entries[0].sha256_hash,
        sha256_file_ref(&public_helper_binary_path("kaifuu-fixture-helper")).unwrap()
    );

    let invalid_cases = [
        (
            "missing-capability",
            SEMANTIC_HELPER_REGISTRY_MISSING_CAPABILITY,
            "capabilities",
        ),
        (
            "bad-schema-id",
            SEMANTIC_HELPER_REGISTRY_UNSUPPORTED_SCHEMA_ID,
            "inputSchemaId",
        ),
        (
            "bad-schema-id",
            SEMANTIC_HELPER_REGISTRY_INCOMPATIBLE_OUTPUT_SCHEMA,
            "outputSchemaId",
        ),
        (
            "unsupported-redaction-class",
            SEMANTIC_HELPER_REGISTRY_INVALID_REDACTION_CLASS,
            "redactionClass",
        ),
    ];

    for (fixture, expected_code, expected_field) in invalid_cases {
        let validation =
            validate_helper_registry_entry_value(&public_helper_registry_fixture_value(fixture))
                .redacted_for_report();

        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == expected_code && diagnostic.field == expected_field
            }),
            "missing {expected_code} for {fixture}: {:#?}",
            validation.diagnostics
        );
    }
}

#[test]
fn helper_registry_rejects_arbitrary_command_configuration_fields() {
    let mut value = public_helper_registry_fixture_value("valid-helper");
    value["command"] = serde_json::json!("sh -c helper");
    value["executionPolicy"]["args"] = serde_json::json!(["--dump"]);
    value["binaryAllowlist"]["entries"][0]["env"] =
        serde_json::json!({"SECRET_PATH": "/home/dev/private-game"});

    let validation = validate_helper_registry_entry_value(&value).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    for field in [
        "command",
        "executionPolicy.args",
        "binaryAllowlist.entries.0.env",
    ] {
        assert!(
            validation.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == SEMANTIC_HELPER_REGISTRY_FORBIDDEN_EXECUTION_FIELD
                    && diagnostic.field == field
            }),
            "missing forbidden command diagnostic for {field}: {:#?}",
            validation.diagnostics
        );
    }
    let serialized = serde_json::to_string(&validation).unwrap();
    assert!(!serialized.contains("/home/dev/private-game"));
}

#[test]
fn helper_binary_allowlist_hash_gate_blocks_before_launch() {
    let valid_value = public_helper_registry_fixture_value("valid-helper");
    let valid_entry: HelperRegistryEntry = serde_json::from_value(valid_value).unwrap();
    let allowed_binary = public_helper_binary_path("kaifuu-fixture-helper");
    let mismatch_binary = public_helper_binary_path("kaifuu-fixture-helper-mismatch");

    let allowed_staging = tempfile::tempdir().unwrap();
    let allowed_outcome = valid_entry.stage_and_validate_binary_launch(
        HelperBinaryLaunchValidationRequest {
            helper_id: FIXTURE_HELPER_REGISTRY_ID,
            allowlist_entry_id: FIXTURE_HELPER_ALLOWLIST_REF_ID,
            executable_path: &allowed_binary,
            platform: "fixture-any",
            helper_version: "0.1.0",
            required_capabilities: &[HelperCapability::FixtureInvocation],
        },
        allowed_staging.path(),
    );
    let allowed = allowed_outcome.validation;
    assert_eq!(allowed.status, OperationStatus::Passed, "{allowed:#?}");
    assert_eq!(
        allowed.observed_hash.as_deref(),
        Some("sha256:c1ac7473395cf2fbb823d33c63b5b4810352e3d2c255833498ba4fc4efb29f7c")
    );
    // The passed launch bound the validated bytes to a trusted staged copy,
    // distinct from the mutable source path.
    let staged = allowed_outcome
        .staged
        .as_ref()
        .expect("passed launch binds a staged execution reference");
    assert_ne!(staged.staged_path(), allowed_binary.as_path());
    assert_eq!(
        staged.staged_hash(),
        "sha256:c1ac7473395cf2fbb823d33c63b5b4810352e3d2c255833498ba4fc4efb29f7c"
    );

    let cases = [
        (
            "missing binary",
            valid_entry.clone(),
            public_helper_binary_path("missing-kaifuu-fixture-helper"),
            "fixture-any",
            "0.1.0",
            &[HelperCapability::FixtureInvocation][..],
            SEMANTIC_HELPER_ALLOWLIST_MISSING_BINARY,
        ),
        (
            "hash mismatch",
            valid_entry.clone(),
            mismatch_binary,
            "fixture-any",
            "0.1.0",
            &[HelperCapability::FixtureInvocation][..],
            SEMANTIC_HELPER_ALLOWLIST_HASH_MISMATCH,
        ),
        (
            "wrong platform",
            serde_json::from_value(public_helper_registry_fixture_value(
                "allowlist-wrong-platform",
            ))
            .unwrap(),
            allowed_binary.clone(),
            "fixture-any",
            "0.1.0",
            &[HelperCapability::FixtureInvocation][..],
            SEMANTIC_HELPER_ALLOWLIST_WRONG_PLATFORM,
        ),
        (
            "stale version",
            serde_json::from_value(public_helper_registry_fixture_value(
                "allowlist-stale-version",
            ))
            .unwrap(),
            allowed_binary.clone(),
            "fixture-any",
            "0.1.0",
            &[HelperCapability::FixtureInvocation][..],
            SEMANTIC_HELPER_ALLOWLIST_STALE_VERSION,
        ),
        (
            "undeclared capability",
            serde_json::from_value(public_helper_registry_fixture_value(
                "allowlist-missing-declared-capability",
            ))
            .unwrap(),
            allowed_binary.clone(),
            "fixture-any",
            "0.1.0",
            &[HelperCapability::KeyDiscovery][..],
            SEMANTIC_HELPER_ALLOWLIST_UNDECLARED_CAPABILITY,
        ),
    ];

    for (
        name,
        entry,
        executable_path,
        platform,
        helper_version,
        required_capabilities,
        expected_code,
    ) in cases
    {
        let case_staging = tempfile::tempdir().unwrap();
        let report = entry
            .stage_and_validate_binary_launch(
                HelperBinaryLaunchValidationRequest {
                    helper_id: FIXTURE_HELPER_REGISTRY_ID,
                    allowlist_entry_id: FIXTURE_HELPER_ALLOWLIST_REF_ID,
                    executable_path: &executable_path,
                    platform,
                    helper_version,
                    required_capabilities,
                },
                case_staging.path(),
            )
            .validation
            .redacted_for_report();
        assert_eq!(
            report.status,
            OperationStatus::Failed,
            "{name}: {report:#?}"
        );
        if name == "hash mismatch" {
            let observed_hash = report
                .observed_hash
                .as_deref()
                .expect("hash mismatch should report the observed helper binary hash");
            assert!(is_sha256_ref(observed_hash), "{name}: {report:#?}");
            assert!(
                report.diagnostics.iter().any(|diagnostic| {
                    diagnostic.code == expected_code
                        && diagnostic.observed_hash.as_deref() == Some(observed_hash)
                }),
                "{name}: diagnostic did not preserve observed hash: {:#?}",
                report.diagnostics
            );
        }
        assert!(
            report.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == expected_code
                    && diagnostic.helper_id == FIXTURE_HELPER_REGISTRY_ID
                    && diagnostic.allowlist_entry_id == FIXTURE_HELPER_ALLOWLIST_REF_ID
                    && diagnostic.platform == platform
                    && !diagnostic.remediation_code.is_empty()
            }),
            "{name}: missing {expected_code}: {:#?}",
            report.diagnostics
        );
    }
}

#[test]
fn helper_binary_allowlist_diagnostic_observed_hash_redaction_keeps_only_canonical_hashes() {
    for unsafe_hash in [
        "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "00112233445566778899aabbccddeeff",
        "/home/dev/game/private-helper",
        "C:\\Games\\SecretRoute\\helper.exe",
    ] {
        let diagnostic = HelperBinaryLaunchDiagnostic {
            helper_id: FIXTURE_HELPER_REGISTRY_ID.to_string(),
            allowlist_entry_id: FIXTURE_HELPER_ALLOWLIST_REF_ID.to_string(),
            code: SEMANTIC_HELPER_ALLOWLIST_HASH_MISMATCH.to_string(),
            field: "sha256Hash".to_string(),
            observed_hash: Some(unsafe_hash.to_string()),
            platform: "fixture-any".to_string(),
            remediation_code: "reinstall_helper_binary".to_string(),
            message: "helper binary hash does not match the allowlist entry".to_string(),
        }
        .redacted_for_report();

        assert_eq!(
            diagnostic.observed_hash.as_deref(),
            Some("[REDACTED:kaifuu.secret_redacted]"),
            "{unsafe_hash} should be redacted"
        );
    }
}

#[test]
fn fixture_helper_is_discovered_and_invoked_through_registry_boundary() {
    let registry = fixture_helper_registry().unwrap();
    let helpers = registry.entries_for_capability(HelperCapability::FixtureInvocation);
    assert_eq!(helpers.len(), 1);
    assert_eq!(helpers[0].helper_id, FIXTURE_HELPER_REGISTRY_ID);
    assert!(registry.get(FIXTURE_HELPER_REGISTRY_ID).is_some());

    let input = serde_json::json!({"fixture": true});
    let output = registry.invoke(fixture_helper_invocation(&input)).unwrap();

    assert_eq!(
        validate_helper_result_value(&output).status,
        OperationStatus::Passed
    );
    assert_eq!(output["helper"]["helperId"], FIXTURE_HELPER_REGISTRY_ID);
    assert_eq!(output["diagnostic"]["code"], "success");
}

#[test]
fn fixture_helper_invocation_requires_registered_version_and_allowlist_ref() {
    let registry = fixture_helper_registry().unwrap();
    let input = serde_json::json!({"fixture": true});

    let stale_version = registry
        .invoke(HelperRegistryInvocationRequest {
            helper_id: FIXTURE_HELPER_REGISTRY_ID,
            helper_version: "9.9.9",
            allowlist_entry_id: FIXTURE_HELPER_ALLOWLIST_REF_ID,
            capability: HelperCapability::FixtureInvocation,
            input: &input,
        })
        .unwrap_err()
        .to_string();
    assert!(stale_version.contains(SEMANTIC_HELPER_ALLOWLIST_STALE_VERSION));

    let wrong_allowlist = registry
        .invoke(HelperRegistryInvocationRequest {
            helper_id: FIXTURE_HELPER_REGISTRY_ID,
            helper_version: "0.1.0",
            allowlist_entry_id: "unknown-helper-allowlist",
            capability: HelperCapability::FixtureInvocation,
            input: &input,
        })
        .unwrap_err()
        .to_string();
    assert!(wrong_allowlist.contains(SEMANTIC_HELPER_ALLOWLIST_MISSING_ENTRY));
}

#[test]
fn helper_key_ref_request_passes_refs_without_serializing_material() {
    let registry = fixture_helper_registry().unwrap();
    let request = public_helper_request_fixture_value("key-ref-request");

    let output = registry
        .invoke(fixture_helper_invocation(&request))
        .unwrap();

    assert_eq!(output["diagnostic"]["code"], "success");
    assert_eq!(
        output["secretRefs"][0]["secretRef"],
        "local-secret:fixture/siglus/manual-secondary-key"
    );
    let serialized_request = serde_json::to_string(&request).unwrap();
    let serialized_output = serde_json::to_string(&output).unwrap();
    for forbidden in [
        "rawKey",
        "keyMaterial",
        "00112233445566778899aabbccddeeff",
        "decrypted script",
        "/home/dev",
    ] {
        assert!(!serialized_request.contains(forbidden));
        assert!(!serialized_output.contains(forbidden));
    }
}

#[test]
fn helper_key_ref_request_diagnostics_distinguish_boundary_failures() {
    let registry = fixture_helper_registry().unwrap();
    let mut missing = public_helper_request_fixture_value("key-ref-request");
    missing["keyRefs"] = serde_json::json!([]);
    let output = registry
        .invoke(fixture_helper_invocation(&missing))
        .unwrap();
    assert_eq!(output["diagnostic"]["code"], "missing_key");
    assert_eq!(
        output["diagnostic"]["message"],
        SEMANTIC_MISSING_KEY_MATERIAL
    );

    let mut wrong_profile = public_helper_request_fixture_value("key-ref-request");
    wrong_profile["keyRefs"][0]["engineProfileId"] =
        serde_json::json!("019ed000-0000-7000-8000-profile99999");
    let output = registry
        .invoke(fixture_helper_invocation(&wrong_profile))
        .unwrap();
    assert_eq!(output["diagnostic"]["code"], "validation_failed");
    assert_eq!(
        output["diagnostic"]["message"],
        SEMANTIC_KEY_IMPORT_WRONG_ENGINE_PROFILE
    );

    let mut hash_mismatch = public_helper_request_fixture_value("key-ref-request");
    hash_mismatch["keyRefs"][0]["sourceHash"] = serde_json::json!(
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    );
    let output = registry
        .invoke(fixture_helper_invocation(&hash_mismatch))
        .unwrap();
    assert_eq!(output["diagnostic"]["code"], "validation_failed");
    assert_eq!(
        output["diagnostic"]["message"],
        SEMANTIC_KEY_IMPORT_HASH_MISMATCH
    );

    let mut forbidden = public_helper_request_fixture_value("key-ref-request");
    forbidden["keyRefs"][0]["rawKey"] = serde_json::json!("00112233445566778899aabbccddeeff");
    let output = registry
        .invoke(fixture_helper_invocation(&forbidden))
        .unwrap();
    assert_eq!(output["diagnostic"]["code"], "redaction_failure");
    assert_eq!(
        output["diagnostic"]["message"],
        SEMANTIC_FORBIDDEN_PUBLIC_SERIALIZATION
    );
}

#[test]
fn siglus_secondary_key_helper_boundary_fixture_matches_redacted_output() {
    let registry = fixture_helper_registry().unwrap();
    let request = public_helper_request_fixture_value("siglus-secondary-key-request");
    let output = registry
        .invoke(fixture_helper_key_validation(&request))
        .unwrap();
    let expected = bridge_fixture_value(
        "fixtures/public/kaifuu-helper-results/siglus-secondary-key-helper-boundary-success.json",
    );

    assert_eq!(output, expected);
    assert_eq!(
        validate_helper_result_value(&output).status,
        OperationStatus::Passed
    );
    assert_eq!(output["diagnostic"]["code"], "success");
    assert_eq!(output["helper"]["helperId"], FIXTURE_HELPER_REGISTRY_ID);
    assert_eq!(
        output["secretRefs"][0]["requirementId"],
        "siglus-secondary-key"
    );
    assert_eq!(
        output["secretRefs"][0]["secretRef"],
        "local-secret:fixture/siglus/secondary-key-ref"
    );
    assert_eq!(
        output["redaction"]["redactedLogHash"],
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    );

    let serialized_request = serde_json::to_string(&request).unwrap();
    let serialized_output = serde_json::to_string(&output).unwrap();
    for forbidden in [
        "rawKey",
        "keyMaterial",
        "00112233445566778899aabbccddeeff",
        "fixture-only-siglus-secondary-key-v1",
        "decrypted script",
        "/home/",
        "C:\\",
    ] {
        assert!(!serialized_request.contains(forbidden));
        assert!(!serialized_output.contains(forbidden));
    }
}

#[test]
fn siglus_secondary_key_helper_boundary_requires_redacted_output_for_success_key_refs() {
    let registry = fixture_helper_registry().unwrap();
    let mut request = public_helper_request_fixture_value("siglus-secondary-key-request");
    let request_object = request.as_object_mut().unwrap();
    request_object.remove("expectedRedactedLogHash");
    request_object.remove("requiredKeyRefs");

    let output = registry
        .invoke(fixture_helper_key_validation(&request))
        .unwrap();

    assert_eq!(output["diagnostic"]["code"], "redaction_failure");
    assert_eq!(
        output["diagnostic"]["message"],
        SEMANTIC_HELPER_REQUEST_MISSING_REDACTED_OUTPUT_EXPECTATION
    );
    assert_eq!(output["redaction"]["status"], "failed");
    assert_eq!(output["secretRefs"], serde_json::json!([]));
    assert_eq!(
        validate_helper_result_value(&output).status,
        OperationStatus::Passed
    );

    let serialized = serde_json::to_string(&output).unwrap();
    for forbidden in [
        "rawKey",
        "keyMaterial",
        "00112233445566778899aabbccddeeff",
        "fixture-only-siglus-secondary-key-v1",
        "decrypted script",
        "/home/",
        "C:\\",
    ] {
        assert!(!serialized.contains(forbidden), "leaked {forbidden}");
    }
}

#[test]
fn siglus_secondary_key_helper_boundary_diagnostics_cover_required_failures() {
    let registry = fixture_helper_registry().unwrap();
    let cases = [
        (
            "siglus-secondary-key-missing-key-ref",
            "missing_key",
            SEMANTIC_MISSING_KEY_MATERIAL,
        ),
        (
            "siglus-secondary-key-wrong-profile",
            "validation_failed",
            SEMANTIC_KEY_IMPORT_WRONG_ENGINE_PROFILE,
        ),
        (
            "siglus-secondary-key-wrong-purpose",
            "validation_failed",
            SEMANTIC_KEY_IMPORT_WRONG_KEY_PURPOSE,
        ),
        (
            "siglus-secondary-key-helper-rejection",
            "validation_failed",
            SEMANTIC_HELPER_REQUEST_WRONG_HELPER,
        ),
        (
            "siglus-secondary-key-redacted-output-mismatch",
            "redaction_failure",
            SEMANTIC_HELPER_REQUEST_REDACTED_OUTPUT_MISMATCH,
        ),
        (
            "siglus-secondary-key-missing-redacted-output-expectation",
            "redaction_failure",
            SEMANTIC_HELPER_REQUEST_MISSING_REDACTED_OUTPUT_EXPECTATION,
        ),
    ];

    for (fixture, expected_code, expected_message) in cases {
        let request = public_helper_request_fixture_value(fixture);
        let output = registry
            .invoke(fixture_helper_key_validation(&request))
            .unwrap();
        assert_eq!(
            output["diagnostic"]["code"], expected_code,
            "{fixture}: {output:#?}"
        );
        assert_eq!(
            output["diagnostic"]["message"], expected_message,
            "{fixture}: {output:#?}"
        );
        assert_eq!(
            validate_helper_result_value(&output).status,
            OperationStatus::Passed,
            "{fixture}: {output:#?}"
        );

        let serialized = serde_json::to_string(&output).unwrap();
        for forbidden in [
            "rawKey",
            "keyMaterial",
            "00112233445566778899aabbccddeeff",
            "decrypted script",
            "/home/",
            "C:\\",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "{fixture} leaked {forbidden}"
            );
        }
    }
}

#[test]
fn siglus_known_key_parser_boundary_smoke_reports_slots_and_redacted_diagnostics() {
    let scene_path =
        repo_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/siglus/Scene.pck");
    let gameexe_path =
        repo_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/siglus/Gameexe.dat");
    let key_request = public_helper_request_fixture_value("siglus-secondary-key-request");

    let success = run_siglus_known_key_parser_boundary_smoke(SiglusParserBoundarySmokeRequest {
        scene_path: &scene_path,
        gameexe_path: &gameexe_path,
        key_request: Some(&key_request),
        variant: SiglusParserBoundarySmokeVariant::ParserBoundarySuccess,
    })
    .unwrap();
    assert_eq!(success.status, OperationStatus::Passed);
    assert_eq!(
        success.outcome,
        SiglusParserBoundaryOutcome::ParserBoundarySuccess
    );
    assert_eq!(success.profile_id, "019ed000-0000-7000-8000-000000091001");
    assert!(!success.patch_write_attempted);
    assert!(
        success
            .support_boundary
            .contains("does not claim production Siglus")
    );
    assert!(success.sources.iter().any(|source| {
        source.asset_id == "siglus-scene-pck"
            && source.source_hash.as_str()
                == "sha256:9afaac8af2dd96468e97e069cb678ada48a77d9726e8ebebf1ca75e76b65d465"
    }));
    assert!(success.text_slots.iter().any(|slot| {
        slot.text_slot_id == "siglus.synthetic.scene.text.001"
            && slot.byte_span.start_byte == 17
            && slot.byte_span.end_byte == 52
            && slot.source_hash.as_str()
                == "sha256:9afaac8af2dd96468e97e069cb678ada48a77d9726e8ebebf1ca75e76b65d465"
    }));
    assert_eq!(success.key_refs.len(), 1);
    assert_eq!(
        success.key_refs[0].secret_ref.as_str(),
        "local-secret:fixture/siglus/secondary-key-ref"
    );

    let cases = [
        (
            SiglusParserBoundarySmokeVariant::HelperRequired,
            SiglusParserBoundaryOutcome::HelperRequired,
            "helper_required",
            SEMANTIC_HELPER_REQUIRED,
        ),
        (
            SiglusParserBoundarySmokeVariant::MissingKey,
            SiglusParserBoundaryOutcome::MissingKey,
            "missing_key",
            SEMANTIC_MISSING_KEY_MATERIAL,
        ),
        (
            SiglusParserBoundarySmokeVariant::UnsupportedOpcode,
            SiglusParserBoundaryOutcome::UnsupportedOpcode,
            "unsupported_opcode",
            SEMANTIC_SIGLUS_UNSUPPORTED_OPCODE,
        ),
        (
            SiglusParserBoundarySmokeVariant::OutOfProfile,
            SiglusParserBoundaryOutcome::OutOfProfile,
            "out_of_profile",
            SEMANTIC_KEY_IMPORT_WRONG_ENGINE_PROFILE,
        ),
    ];

    for (variant, outcome, code, semantic_code) in cases {
        let report = run_siglus_known_key_parser_boundary_smoke(SiglusParserBoundarySmokeRequest {
            scene_path: &scene_path,
            gameexe_path: &gameexe_path,
            key_request: Some(&key_request),
            variant,
        })
        .unwrap();
        assert_eq!(report.status, OperationStatus::Failed, "{variant:?}");
        assert_eq!(report.outcome, outcome, "{variant:?}");
        assert!(!report.patch_write_attempted, "{variant:?}");
        assert!(report.text_slots.is_empty(), "{variant:?}");
        assert!(report.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == code && diagnostic.semantic_code.as_deref() == Some(semantic_code)
        }));
        if outcome == SiglusParserBoundaryOutcome::UnsupportedOpcode {
            assert!(report.diagnostics.iter().any(|diagnostic| {
                diagnostic.unsupported_opcode.as_deref() == Some("SIGLUS_SYNTH_UNSUPPORTED_7f")
                    && diagnostic
                        .byte_span
                        .as_ref()
                        .is_some_and(|span| span.start_byte == 48 && span.end_byte == 49)
            }));
        }
    }

    let serialized = success.stable_json().unwrap();
    for forbidden in [
        "rawKey",
        "keyMaterial",
        "00112233445566778899aabbccddeeff",
        "fixture-only-siglus-secondary-key-v1",
        "decrypted script",
        "/home/",
        "C:\\",
    ] {
        assert!(!serialized.contains(forbidden), "leaked {forbidden}");
    }
}

#[test]
fn helper_key_ref_request_rejects_requirement_id_only_refs() {
    let registry = fixture_helper_registry().unwrap();
    let mut request = public_helper_request_fixture_value("key-ref-request");
    request["keyRefs"][0] = serde_json::json!({
        "requirementId": "siglus-secondary-key"
    });

    let diagnostics = validate_helper_key_ref_request(&request);
    assert!(
        diagnostics.iter().any(|diagnostic| {
            diagnostic.code == SEMANTIC_MISSING_KEY_MATERIAL
                && diagnostic.field == "keyRefs.0.secretRef"
        }),
        "requirement-id-only keyRef should not satisfy requiredKeyRefs: {diagnostics:#?}"
    );

    let output = registry
        .invoke(fixture_helper_invocation(&request))
        .unwrap();
    assert_eq!(output["diagnostic"]["code"], "missing_key");
    assert_eq!(
        output["diagnostic"]["message"],
        SEMANTIC_MISSING_KEY_MATERIAL
    );
}

#[test]
fn helper_key_ref_request_rejects_required_ref_missing_engine_profile() {
    let registry = fixture_helper_registry().unwrap();
    let mut request = public_helper_request_fixture_value("key-ref-request");
    request["keyRefs"][0]
        .as_object_mut()
        .unwrap()
        .remove("engineProfileId");

    let diagnostics = validate_helper_key_ref_request(&request);
    assert!(
        diagnostics.iter().any(|diagnostic| {
            diagnostic.code == SEMANTIC_KEY_IMPORT_WRONG_ENGINE_PROFILE
                && diagnostic.field == "keyRefs.0.engineProfileId"
        }),
        "required keyRef missing engineProfileId should fail binding: {diagnostics:#?}"
    );

    let output = registry
        .invoke(fixture_helper_invocation(&request))
        .unwrap();
    assert_eq!(output["diagnostic"]["code"], "validation_failed");
    assert_eq!(
        output["diagnostic"]["message"],
        SEMANTIC_KEY_IMPORT_WRONG_ENGINE_PROFILE
    );
}

#[test]
fn helper_key_ref_request_rejects_required_ref_missing_source_hash() {
    let registry = fixture_helper_registry().unwrap();
    let mut request = public_helper_request_fixture_value("key-ref-request");
    request["keyRefs"][0]
        .as_object_mut()
        .unwrap()
        .remove("sourceHash");

    let diagnostics = validate_helper_key_ref_request(&request);
    assert!(
        diagnostics.iter().any(|diagnostic| {
            diagnostic.code == SEMANTIC_KEY_IMPORT_HASH_MISMATCH
                && diagnostic.field == "keyRefs.0.sourceHash"
        }),
        "required keyRef missing sourceHash should fail binding: {diagnostics:#?}"
    );

    let output = registry
        .invoke(fixture_helper_invocation(&request))
        .unwrap();
    assert_eq!(output["diagnostic"]["code"], "validation_failed");
    assert_eq!(
        output["diagnostic"]["message"],
        SEMANTIC_KEY_IMPORT_HASH_MISMATCH
    );
}

#[test]
fn fixture_helper_registry_rejects_missing_capability_and_bad_output() {
    struct BadOutputAdapter;

    impl HelperExecutableAdapter for BadOutputAdapter {
        fn helper_id(&self) -> &'static str {
            FIXTURE_HELPER_REGISTRY_ID
        }

        fn invoke(
            &self,
            _entry: &HelperRegistryEntry,
            _request: HelperRegistryInvocationRequest<'_>,
        ) -> KaifuuResult<Value> {
            Ok(serde_json::json!({"not": "a helper result"}))
        }
    }

    let registry = fixture_helper_registry().unwrap();
    let input = serde_json::json!({"fixture": true});
    let missing_capability = registry.invoke(HelperRegistryInvocationRequest {
        helper_id: FIXTURE_HELPER_REGISTRY_ID,
        helper_version: "0.1.0",
        allowlist_entry_id: FIXTURE_HELPER_ALLOWLIST_REF_ID,
        capability: HelperCapability::KeyDiscovery,
        input: &input,
    });
    assert!(missing_capability.is_err());
    assert!(
        missing_capability
            .unwrap_err()
            .to_string()
            .contains(SEMANTIC_HELPER_REGISTRY_MISSING_CAPABILITY)
    );

    let mut bad_registry = HelperRegistry::new();
    bad_registry
        .register_entry(FixtureHelperStubAdapter::registry_entry())
        .unwrap();
    bad_registry.register_executable(BadOutputAdapter);

    let error = bad_registry
        .invoke(fixture_helper_invocation(&input))
        .unwrap_err()
        .to_string();
    assert!(error.contains(SEMANTIC_HELPER_REGISTRY_INCOMPATIBLE_OUTPUT_SCHEMA));
}

#[test]
fn public_helper_result_fixtures_validate_and_cover_diagnostic_matrix() {
    let fixture_codes = [
        ("success", HelperDiagnosticCode::Success),
        ("missing-key", HelperDiagnosticCode::MissingKey),
        ("xp3/wrong-key", HelperDiagnosticCode::WrongKey),
        ("helper-required", HelperDiagnosticCode::HelperRequired),
        (
            "helper-unavailable",
            HelperDiagnosticCode::HelperUnavailable,
        ),
        ("validation-failed", HelperDiagnosticCode::ValidationFailed),
        (
            "unsupported-protected-executable",
            HelperDiagnosticCode::UnsupportedProtectedExecutable,
        ),
        ("redaction-failure", HelperDiagnosticCode::RedactionFailure),
        (
            "key-helper/windows-helper-timeout",
            HelperDiagnosticCode::HelperTimeout,
        ),
        (
            "key-helper/authorization-denied",
            HelperDiagnosticCode::HelperAuthorizationDenied,
        ),
    ];
    let mut covered = BTreeSet::new();

    for (fixture, expected_code) in fixture_codes {
        let value = public_helper_result_fixture_value(fixture);
        let validation = validate_helper_result_value(&value);

        assert_eq!(
            validation.status,
            OperationStatus::Passed,
            "{fixture} should validate: {:#?}",
            validation.failures
        );
        let helper_result: HelperResult = serde_json::from_value(value).unwrap();
        assert_eq!(helper_result.diagnostic.code, expected_code);
        covered.insert(helper_result.diagnostic.code);
        let serialized = helper_result.stable_json().unwrap();
        let serialized_value: Value = serde_json::from_str(&serialized).unwrap();
        assert!(serialized_value["secretRefs"].is_array());
        assert!(serialized_value["proofHashes"].is_array());
        assert_eq!(
            validate_helper_result_value(&serialized_value).status,
            OperationStatus::Passed
        );
        assert!(!serialized.contains("rawKey"));
        assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
    }

    assert_eq!(
        covered,
        [
            HelperDiagnosticCode::Success,
            HelperDiagnosticCode::MissingKey,
            HelperDiagnosticCode::WrongKey,
            HelperDiagnosticCode::HelperRequired,
            HelperDiagnosticCode::HelperUnavailable,
            HelperDiagnosticCode::HelperAuthorizationDenied,
            HelperDiagnosticCode::HelperTimeout,
            HelperDiagnosticCode::ValidationFailed,
            HelperDiagnosticCode::UnsupportedProtectedExecutable,
            HelperDiagnosticCode::RedactionFailure,
        ]
        .into_iter()
        .collect::<BTreeSet<_>>()
    );
}

#[test]
fn xp3_helper_result_fixtures_distinguish_required_key_and_protected_states() {
    let fixture_codes = [
        ("xp3/helper-required", HelperDiagnosticCode::HelperRequired),
        ("xp3/missing-key", HelperDiagnosticCode::MissingKey),
        ("xp3/wrong-key", HelperDiagnosticCode::WrongKey),
        (
            "xp3/validation-failed",
            HelperDiagnosticCode::ValidationFailed,
        ),
        (
            "xp3/unsupported-protected-executable",
            HelperDiagnosticCode::UnsupportedProtectedExecutable,
        ),
    ];
    let mut covered = BTreeSet::new();

    for (fixture, expected_code) in fixture_codes {
        let value = public_helper_result_fixture_value(fixture);
        let validation = validate_helper_result_value(&value);
        assert_eq!(
            validation.status,
            OperationStatus::Passed,
            "{fixture} should validate: {:#?}",
            validation.failures
        );

        let helper_result: HelperResult = serde_json::from_value(value).unwrap();
        assert_eq!(helper_result.diagnostic.code, expected_code, "{fixture}");
        assert!(
            helper_result.profile_id.contains("095")
                || helper_result.fixture_id.contains("protected-executable"),
            "{fixture} should be tied to XP3 fixture profile ids"
        );
        assert!(
            !helper_result.proof_hashes.is_empty(),
            "{fixture} must carry public proof hash evidence"
        );
        if expected_code == HelperDiagnosticCode::MissingKey {
            assert!(
                helper_result
                    .secret_refs
                    .iter()
                    .any(|secret| { secret.requirement_id == "kirikiri-xp3-key-profile" }),
                "missing_key must identify the concrete XP3 key requirement id"
            );
        }
        covered.insert(helper_result.diagnostic.code);

        let serialized = helper_result.stable_json().unwrap();
        for forbidden in [
            "rawKey",
            "keyMaterial",
            "00112233445566778899aabbccddeeff",
            "/home/",
            "C:\\",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "{fixture} leaked {forbidden}"
            );
        }
    }

    assert_eq!(
        covered,
        [
            HelperDiagnosticCode::HelperRequired,
            HelperDiagnosticCode::MissingKey,
            HelperDiagnosticCode::WrongKey,
            HelperDiagnosticCode::ValidationFailed,
            HelperDiagnosticCode::UnsupportedProtectedExecutable,
        ]
        .into_iter()
        .collect::<BTreeSet<_>>()
    );
}

#[test]
fn helper_result_contract_rejects_missing_key_without_concrete_requirement() {
    let mut value = public_helper_result_fixture_value("xp3/missing-key");
    value["secretRefs"] = serde_json::json!([]);

    let validation = validate_helper_result_value(&value).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation.failures.iter().any(|failure| {
            failure.fixture_id.as_deref() == Some("kaifuu-xp3-missing-key")
                && failure.field == "secretRefs"
                && failure.code == "missing_key_requires_secret_ref"
        }),
        "{:#?}",
        validation.failures
    );
}

#[test]
fn public_encrypted_matrix_helper_results_cover_failure_paths() {
    let fixture_codes = [
        ("missing-key", HelperDiagnosticCode::MissingKey),
        ("helper-required", HelperDiagnosticCode::HelperRequired),
        (
            "helper-unavailable",
            HelperDiagnosticCode::HelperUnavailable,
        ),
        ("validation-failed", HelperDiagnosticCode::ValidationFailed),
        ("redaction-path", HelperDiagnosticCode::RedactionFailure),
    ];

    for (fixture, expected_code) in fixture_codes {
        let value = encrypted_matrix_fixture_value(&format!("helper-results/{fixture}.json"));
        let validation = validate_helper_result_value(&value);
        assert_eq!(
            validation.status,
            OperationStatus::Passed,
            "{fixture} should validate: {:#?}",
            validation.failures
        );

        let helper_result: HelperResult = serde_json::from_value(value).unwrap();
        assert_eq!(helper_result.diagnostic.code, expected_code);
        let serialized = helper_result.stable_json().unwrap();
        assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
        assert!(!serialized.contains("/home/dev"));
        assert!(!serialized.contains("private/key.bin"));
    }
}

#[test]
fn public_encrypted_matrix_key_profile_fixtures_validate_and_redact_negatives() {
    let valid =
        encrypted_matrix_fixture_value("key-profiles/siglus-valid-placeholder.profile.json");
    let validation = validate_profile_value(&valid);
    assert_eq!(
        validation.status,
        OperationStatus::Passed,
        "valid placeholder profile should pass: {:#?}",
        validation.failures
    );

    for fixture in [
        "key-profiles/negative/raw-key-secret-ref.profile.json",
        "key-profiles/negative/private-path-secret-ref.profile.json",
    ] {
        let value = encrypted_matrix_fixture_value(fixture);
        let validation = validate_profile_value(&value).redacted_for_report();
        assert_eq!(
            validation.status,
            OperationStatus::Failed,
            "{fixture} should fail profile validation"
        );
        let serialized = serde_json::to_string(&validation).unwrap();
        assert!(serialized.contains("secretRef"));
        assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
        assert!(!serialized.contains("/home/dev"));
        assert!(!serialized.contains("private/key.bin"));
    }
}

#[test]
fn public_encrypted_matrix_fixture_reports_detector_aggregate_output() {
    let raw_dir = repo_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw");
    let report = DetectionReport::from_results(
        &raw_dir,
        vec![DetectionResult {
            adapter_id: "kaifuu.fixture".to_string(),
            detected: false,
            engine_family: None,
            engine_version: None,
            detected_variant: None,
            evidence: vec![],
            requirements: vec![],
            capabilities: vec![],
        }],
    );
    let expected = encrypted_matrix_fixture_value("expected/detection-summary-v0.1.json");

    assert_eq!(report.status, DetectionReportStatus::Unknown);
    assert_eq!(report.game_dir, REDACTED_DETECTION_GAME_DIR);
    assert_eq!(
        report.archive_detection.status,
        ArchiveDetectionStatus::Matched
    );
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| warning.contains("unsupported input diagnostics"))
    );

    for expected_row in expected["expectedRows"].as_array().unwrap() {
        let row_id = expected_row["rowId"].as_str().unwrap();
        let row = detected_archive_row(&report.archive_detection, row_id);
        assert_eq!(
            serde_json::to_value(&row.engine_family).unwrap(),
            expected_row["engineFamily"]
        );
        assert_eq!(row.detected, expected_row["detected"].as_bool().unwrap());
        assert_eq!(
            serde_json::to_value(&row.signals).unwrap(),
            expected_row["signals"],
            "{row_id} signals should match public fixture summary"
        );
    }

    let kirikiri = detected_archive_row(&report.archive_detection, "kirikiri-xp3");
    assert!(kirikiri.evidence.iter().any(|evidence| {
        evidence.pattern == "*.xp3"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 4
    }));
    assert!(kirikiri.evidence.iter().any(|evidence| {
        evidence.pattern == "synthetic XP3 encryption marker"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(kirikiri.evidence.iter().any(|evidence| {
        evidence.pattern == "synthetic XP3 compression marker"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(kirikiri.evidence.iter().any(|evidence| {
        evidence.pattern == "synthetic XP3 unknown-variant marker"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));

    let rpg_maker = detected_archive_row(
        &report.archive_detection,
        "rpg-maker-mv-mz-encrypted-assets",
    );
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == RPG_MAKER_MV_MZ_ENCRYPTED_SUFFIX_PATTERN
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));
    assert!(rpg_maker.evidence.iter().any(|evidence| {
        evidence.pattern == "data/System.json encryption fields"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 1
    }));

    let unknown = detected_archive_row(&report.archive_detection, "unknown-archive-variant");
    assert!(unknown.evidence.iter().any(|evidence| {
        evidence.pattern == "*.pak|*.bundle|*.bin|unprofiled *.dat|*.pck|*.arc"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 3
    }));

    let serialized = serde_json::to_string(&report).unwrap();
    for forbidden in [
        raw_dir.display().to_string(),
        "data.xp3".to_string(),
        "fixture-only-rpg-maker-asset-key-v1".to_string(),
    ] {
        assert!(
            !serialized.contains(&forbidden),
            "report leaked {forbidden}"
        );
    }
    assert!(serialized.contains("aggregate-only"));
}

#[test]
fn public_encrypted_matrix_detector_negative_markers_stay_unknown_only() {
    let marker_dir = repo_fixture_path(
        "fixtures/public/kaifuu-encrypted-matrix/negative-detectors/orphaned-subtype-markers",
    );
    let report = ArchiveDetectionReport::scan(&marker_dir);

    assert_eq!(report.status, ArchiveDetectionStatus::Matched);
    for row_id in [
        "kirikiri-xp3",
        "bgi-ethornell-containers",
        "wolf-rpg-editor-archives",
    ] {
        let row = report
            .rows
            .iter()
            .find(|row| row.row_id == row_id)
            .unwrap_or_else(|| panic!("missing archive row {row_id}"));
        assert!(!row.detected, "{row_id} should not family-detect");
        assert!(row.signals.is_empty(), "{row_id} leaked signals");
        assert!(row.requirements.is_empty(), "{row_id} leaked requirements");
        assert!(row.diagnostics.is_empty(), "{row_id} leaked diagnostics");
    }

    let unknown = detected_archive_row(&report, "unknown-archive-variant");
    assert_eq!(
        unknown.signals,
        vec![ArchiveDetectionSignal::UnknownVariant]
    );
    assert!(unknown.evidence.iter().any(|evidence| {
        evidence.pattern == "orphaned encrypted/protected subtype marker"
            && evidence.status == EvidenceStatus::Matched
            && evidence.count == 3
    }));
}

fn public_rpg_maker_fixture_key_validation_report(
    resolver: &LocalKeyResolver<InMemoryLocalSecretStore>,
    image_asset_path: &Path,
) -> RpgMakerMvMzFixtureKeyValidationReport {
    let game_dir = repo_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/rpg-maker");
    validate_rpg_maker_mv_mz_fixture_key(RpgMakerMvMzFixtureKeyValidationRequest {
        fixture_id: "kaifuu-rpg-maker-mv-mz-key-validation-success",
        game_dir: &game_dir,
        image_asset_path,
        requirement_id: "rpg-maker-mv-mz-asset-key",
        secret_ref: "local-secret:fixture/rpg-maker/asset-key",
        resolver,
    })
}

#[test]
fn rpg_maker_mv_mz_fixture_key_validation_matches_system_json_and_image_evidence() {
    let resolver = LocalKeyResolver::new(InMemoryLocalSecretStore::fixture_ci())
        .with_policy(KeyResolverPolicy::allow_prefixes(["fixture/"]));
    let image_asset_path = repo_fixture_path(
        "fixtures/public/kaifuu-encrypted-matrix/raw/rpg-maker/img/pictures/title.rpgmvp",
    );

    let report = public_rpg_maker_fixture_key_validation_report(&resolver, &image_asset_path);

    assert_eq!(report.status, OperationStatus::Passed);
    assert!(!report.decrypt_or_patch_claimed);
    assert_eq!(report.records.len(), 1);
    let record = &report.records[0];
    assert_eq!(record.requirement_id, "rpg-maker-mv-mz-asset-key");
    assert_eq!(record.secret_ref_scheme, Some(SecretRefScheme::LocalSecret));
    assert_eq!(record.surface, "image_asset");
    assert_eq!(record.codec, CodecTransform::PngImage);
    assert_eq!(
        record.diagnostic_result,
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::Success
    );
    assert!(record.proof_hash.is_some());
    assert!(record.system_json_proof_hash.is_some());
    assert!(record.image_evidence_hash.is_some());
    assert_eq!(
        report.diagnostics[0].code,
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::Success
    );
    let expected: Value = read_json(&repo_fixture_path(
            "fixtures/public/kaifuu-encrypted-matrix/expected/rpg-maker-mv-mz-key-validation-success-v0.1.json",
        ))
        .unwrap();
    assert_eq!(
        serde_json::to_value(report.redacted_for_report()).unwrap(),
        expected
    );

    let serialized = report.stable_json().unwrap();
    for forbidden in [
        "fixture-only-rpg-maker-asset-key-v1",
        "00112233445566778899aabbccddeeff",
        "fixture/rpg-maker/asset-key",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "validation report leaked {forbidden}: {serialized}"
        );
    }
    assert!(
        !serialized.contains(&image_asset_path.display().to_string()),
        "validation report leaked fixture path: {serialized}"
    );
    assert!(serialized.contains("rpg-maker-mv-mz-asset-key"));
    assert!(serialized.contains("image_asset"));
    assert!(serialized.contains("png_image"));
}

#[test]
fn rpg_maker_mv_mz_fixture_key_validation_fails_closed_without_image_evidence() {
    let resolver = LocalKeyResolver::new(InMemoryLocalSecretStore::fixture_ci())
        .with_policy(KeyResolverPolicy::allow_prefixes(["fixture/"]));
    let game_dir = repo_fixture_path("fixtures/public/kaifuu-encrypted-matrix/raw/rpg-maker");
    let missing_image_asset = game_dir.join("img/pictures/missing.rpgmvp");

    let report = validate_rpg_maker_mv_mz_fixture_key(RpgMakerMvMzFixtureKeyValidationRequest {
        fixture_id: "kaifuu-rpg-maker-missing-image-evidence",
        game_dir: &game_dir,
        image_asset_path: &missing_image_asset,
        requirement_id: "rpg-maker-mv-mz-asset-key",
        secret_ref: "local-secret:fixture/rpg-maker/asset-key",
        resolver: &resolver,
    });

    assert_eq!(report.status, OperationStatus::Failed);
    let record = &report.records[0];
    assert_eq!(record.surface, "image_asset");
    assert_eq!(record.codec, CodecTransform::PngImage);
    assert_eq!(
        record.diagnostic_result,
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingImageEvidence
    );
    assert!(record.proof_hash.is_none());
    assert!(record.system_json_proof_hash.is_some());
    assert!(record.image_evidence_hash.is_none());
    assert_eq!(
        report.diagnostics[0].code,
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingImageEvidence
    );
    assert_eq!(
        report.diagnostics[0].semantic_code,
        SemanticErrorCode::KeyValidationFailed
    );
    assert_eq!(report.diagnostics[0].field, "imageAssetPath");
    assert_eq!(
        report.diagnostics[0].message,
        "encrypted image evidence is missing or unreadable"
    );

    let serialized = report.stable_json().unwrap();
    for forbidden in [
        "fixture-only-rpg-maker-asset-key-v1",
        "00112233445566778899aabbccddeeff",
        "fixture/rpg-maker/asset-key",
        &missing_image_asset.display().to_string(),
    ] {
        assert!(
            !serialized.contains(forbidden),
            "validation report leaked {forbidden}: {serialized}"
        );
    }
    assert!(serialized.contains("missing_image_evidence"));
    assert!(!serialized.contains("image evidence matched"));
}

#[test]
fn rpg_maker_mv_mz_fixture_key_validation_reports_distinct_failure_diagnostics() {
    let image_asset_path = repo_fixture_path(
        "fixtures/public/kaifuu-encrypted-matrix/raw/rpg-maker/img/pictures/title.rpgmvp",
    );

    let missing_key_resolver = LocalKeyResolver::new(InMemoryLocalSecretStore::new());
    let missing_key =
        public_rpg_maker_fixture_key_validation_report(&missing_key_resolver, &image_asset_path);
    assert_eq!(missing_key.status, OperationStatus::Failed);
    assert_eq!(
        missing_key.records[0].diagnostic_result,
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingKey
    );

    let bad_key_resolver = LocalKeyResolver::new(InMemoryLocalSecretStore::new().with_secret(
        "fixture/rpg-maker/asset-key",
        b"ffffffffffffffffffffffffffffffff".to_vec(),
    ));
    let bad_key =
        public_rpg_maker_fixture_key_validation_report(&bad_key_resolver, &image_asset_path);
    assert_eq!(bad_key.status, OperationStatus::Failed);
    assert_eq!(
        bad_key.records[0].diagnostic_result,
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::BadKey
    );

    let resolver = LocalKeyResolver::new(InMemoryLocalSecretStore::fixture_ci());
    let missing_system_root = temp_dir("rpg-maker-missing-system-json");
    write_fixture_file(
        &missing_system_root,
        "img/pictures/title.rpgmvp",
        b"RPGMVP fixture-only encrypted image payload\n",
    );
    let missing_system =
        validate_rpg_maker_mv_mz_fixture_key(RpgMakerMvMzFixtureKeyValidationRequest {
            fixture_id: "kaifuu-rpg-maker-missing-system-json",
            game_dir: &missing_system_root,
            image_asset_path: &missing_system_root.join("img/pictures/title.rpgmvp"),
            requirement_id: "rpg-maker-mv-mz-asset-key",
            secret_ref: "local-secret:fixture/rpg-maker/asset-key",
            resolver: &resolver,
        });
    assert_eq!(
        missing_system.records[0].diagnostic_result,
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::MissingSystemJson
    );

    let unsupported_root = temp_dir("rpg-maker-unsupported-surface");
    write_fixture_file(
        &unsupported_root,
        "www/data/System.json",
        br#"{"hasEncryptedImages":true,"encryptionKey":"fixture-only-rpg-maker-asset-key-v1"}"#,
    );
    write_fixture_file(
        &unsupported_root,
        "audio/bgm/theme.rpgmvm",
        b"synthetic unsupported audio surface",
    );
    let unsupported_surface =
        validate_rpg_maker_mv_mz_fixture_key(RpgMakerMvMzFixtureKeyValidationRequest {
            fixture_id: "kaifuu-rpg-maker-unsupported-surface",
            game_dir: &unsupported_root,
            image_asset_path: &unsupported_root.join("audio/bgm/theme.rpgmvm"),
            requirement_id: "rpg-maker-mv-mz-asset-key",
            secret_ref: "local-secret:fixture/rpg-maker/asset-key",
            resolver: &resolver,
        });
    assert_eq!(
        unsupported_surface.records[0].diagnostic_result,
        RpgMakerMvMzFixtureKeyValidationDiagnosticCode::UnsupportedSurface
    );
    assert_eq!(unsupported_surface.records[0].surface, "audio_asset");
    assert_eq!(
        unsupported_surface.records[0].codec,
        CodecTransform::M4aAudio
    );
    let _ = fs::remove_dir_all(missing_system_root);
    let _ = fs::remove_dir_all(unsupported_root);

    let diagnostics = serde_json::to_string(&[
        missing_key.redacted_for_report(),
        bad_key.redacted_for_report(),
        missing_system.redacted_for_report(),
        unsupported_surface.redacted_for_report(),
    ])
    .unwrap();
    assert!(!diagnostics.contains("00112233445566778899aabbccddeeff"));
    assert!(!diagnostics.contains("fixture/rpg-maker/asset-key"));
    assert!(!diagnostics.contains("fixture-only-rpg-maker-asset-key-v1"));
}

#[test]
fn known_key_import_boundary_fixture_is_hash_only_public_output() {
    let value = public_helper_result_fixture_value("known-key-import-boundary");
    let validation = validate_helper_result_value(&value);

    assert_eq!(
        validation.status,
        OperationStatus::Passed,
        "{:#?}",
        validation.failures
    );
    assert_eq!(value["helper"]["helperKind"], "knownKeyDatabaseImport");
    assert_eq!(
        value["secretRefs"][0]["secretRef"],
        "local-secret:fixture/siglus/manual-secondary-key"
    );
    assert!(
        value["secretRefs"][0]["validation"]["proofHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert!(
        value["proofHashes"][0]["proofHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert!(value.get("sourceHash").is_none());
    assert!(value.get("materialHash").is_none());
    let serialized = serde_json::to_string(&value).unwrap();
    for forbidden in [
        "rawKey",
        "keyMaterial",
        "00112233445566778899aabbccddeeff",
        "decrypted script",
        "/home/dev",
    ] {
        assert!(!serialized.contains(forbidden));
    }
}

#[test]
fn key_helper_fixture_matrix_normalizes_all_helper_methods() {
    let cases = [
        (
            "key-helper/static-parser",
            HelperKind::StaticParser,
            HelperCapabilityLevel::StaticAnalysis,
            HelperResultExecutionMode::InProcess,
        ),
        (
            "key-helper/known-key-import",
            HelperKind::KnownKeyDatabaseImport,
            HelperCapabilityLevel::LocalKeyImport,
            HelperResultExecutionMode::NotExecuted,
        ),
        (
            "key-helper/manual-entry",
            HelperKind::ManualKeyEntry,
            HelperCapabilityLevel::ManualEntry,
            HelperResultExecutionMode::NotExecuted,
        ),
        (
            "key-helper/wine-helper-unavailable",
            HelperKind::WineLocalWindowsHelper,
            HelperCapabilityLevel::WineLocal,
            HelperResultExecutionMode::PlatformHelper,
        ),
        (
            "key-helper/windows-helper-timeout",
            HelperKind::WineLocalWindowsHelper,
            HelperCapabilityLevel::WindowsLocal,
            HelperResultExecutionMode::PlatformHelper,
        ),
    ];

    for (fixture, expected_kind, expected_level, expected_mode) in cases {
        let value = public_helper_result_fixture_value(fixture);
        let helper_result = normalize_helper_result_value(&value)
            .unwrap_or_else(|validation| panic!("{fixture} failed: {validation:#?}"));
        let serialized = helper_result.stable_json().unwrap();
        let serialized_value: Value = serde_json::from_str(&serialized).unwrap();

        assert_eq!(helper_result.helper.helper_kind, expected_kind);
        assert_eq!(helper_result.capability_level, expected_level);
        assert_eq!(helper_result.execution.mode, expected_mode);
        assert!(helper_result.execution.bounded);
        assert!(helper_result.execution.timeout_ms > 0);
        assert_eq!(
            validate_helper_result_value(&serialized_value).status,
            OperationStatus::Passed
        );
        for forbidden in [
            "rawKey",
            "helperDump",
            "command",
            "00112233445566778899aabbccddeeff",
            "/home/dev",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "{fixture} normalized output leaked {forbidden}: {serialized}"
            );
        }
    }
}

#[test]
fn key_helper_contract_rejects_arbitrary_execution_command_metadata() {
    let value = invalid_public_helper_result_fixture_value("execution-command-field");
    let validation = validate_helper_result_value(&value).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation.failures.iter().any(|failure| {
            failure.fixture_id.as_deref() == Some("kaifuu-key-helper-invalid-command-field")
                && failure.field == "execution.command"
                && failure.code == "forbidden_helper_execution_field"
        }),
        "{:#?}",
        validation.failures
    );
    let serialized = serde_json::to_string(&validation).unwrap();
    assert!(!serialized.contains("fixture-helper --dump"));
}

#[test]
fn helper_result_contract_rejects_unknown_top_level_fields_before_deserialization() {
    let mut value = public_helper_result_fixture_value("key-helper/static-parser");
    value
        .as_object_mut()
        .unwrap()
        .insert("unexpectedAuditField".to_string(), serde_json::json!(true));

    let validation = validate_helper_result_value(&value).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation.failures.iter().any(|failure| {
            failure.fixture_id.as_deref() == Some("kaifuu-key-helper-static-parser")
                && failure.field == "unexpectedAuditField"
                && failure.code == "unknown_helper_result_field"
        }),
        "{:#?}",
        validation.failures
    );
    assert!(serde_json::from_value::<HelperResult>(value).is_err());
}

#[test]
fn helper_result_contract_rejects_top_level_command_metadata() {
    let mut value = public_helper_result_fixture_value("key-helper/static-parser");
    value.as_object_mut().unwrap().insert(
        "command".to_string(),
        serde_json::json!("fixture-helper --dump-private-state"),
    );

    let validation = validate_helper_result_value(&value).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation.failures.iter().any(|failure| {
            failure.fixture_id.as_deref() == Some("kaifuu-key-helper-static-parser")
                && failure.field == "command"
                && failure.code == "forbidden_helper_metadata_field"
        }),
        "{:#?}",
        validation.failures
    );
    let serialized = serde_json::to_string(&validation).unwrap();
    assert!(!serialized.contains("dump-private-state"));
    assert!(serde_json::from_value::<HelperResult>(value).is_err());
}

#[test]
fn helper_result_contract_rejects_unknown_nested_fields_outside_execution() {
    let mut value = public_helper_result_fixture_value("key-helper/static-parser");
    value["diagnostic"]["unexpected"] = serde_json::json!("extra diagnostic metadata");
    value["secretRefs"][0]["validation"]["extraProofMetadata"] = serde_json::json!(true);

    let validation = validate_helper_result_value(&value).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    for field in [
        "diagnostic.unexpected",
        "secretRefs.0.validation.extraProofMetadata",
    ] {
        assert!(
            validation.failures.iter().any(|failure| {
                failure.fixture_id.as_deref() == Some("kaifuu-key-helper-static-parser")
                    && failure.field == field
                    && failure.code == "unknown_helper_result_field"
            }),
            "missing unknown-field failure for {field}: {:#?}",
            validation.failures
        );
    }
    assert!(serde_json::from_value::<HelperResult>(value).is_err());
}

#[test]
fn key_helper_contract_rejects_static_parser_remote_overclaim() {
    let mut value = public_helper_result_fixture_value("key-helper/static-parser");
    value["capabilityLevel"] = serde_json::json!("remoteWindows");
    value["execution"]["mode"] = serde_json::json!("remoteHelper");

    let validation = validate_helper_result_value(&value).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation.failures.iter().any(|failure| {
            failure.fixture_id.as_deref() == Some("kaifuu-key-helper-static-parser")
                && failure.field == "helper"
                && failure.code == "invalid_helper_semantics"
        }),
        "{:#?}",
        validation.failures
    );
}

#[test]
fn helper_result_contract_rejects_success_without_secret_ref_and_proof_hash() {
    let mut value = public_helper_result_fixture_value("success");
    value["secretRefs"] = serde_json::json!([]);
    value["proofHashes"] = serde_json::json!([]);

    let validation = validate_helper_result_value(&value).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    for (field, code) in [
        ("secretRefs", "missing_success_secret_ref"),
        ("proofHashes", "missing_success_proof_hash"),
    ] {
        assert!(
            validation.failures.iter().any(|failure| {
                failure.fixture_id.as_deref() == Some("kaifuu-helper-success")
                    && failure.field == field
                    && failure.code == code
            }),
            "missing success-evidence failure for {field}: {:#?}",
            validation.failures
        );
    }
}

#[test]
fn helper_result_stable_json_keeps_empty_arrays_in_public_contract() {
    let value = public_helper_result_fixture_value("unsupported-protected-executable");
    let helper_result: HelperResult = serde_json::from_value(value).unwrap();
    assert!(helper_result.secret_refs.is_empty());
    assert!(helper_result.proof_hashes.is_empty());

    let serialized = helper_result.stable_json().unwrap();
    let serialized_value: Value = serde_json::from_str(&serialized).unwrap();

    assert_eq!(serialized_value["secretRefs"], serde_json::json!([]));
    assert_eq!(serialized_value["proofHashes"], serde_json::json!([]));
    assert_eq!(
        validate_helper_result_value(&serialized_value).status,
        OperationStatus::Passed
    );
}

// the hash rule is named `utf8-lf-json-stable-v1`. It USED to
// claim `nfc`, but no write path NFC-normalizes string contents — and it
// must not: the bridge (`sourceText`, `spans.raw`) is emitted through
// `stable_json` and must stay BYTE-EXACT for the "span byte range must
// would compose e.g. a decomposed Japanese voiced kana (か + U+3099 → が)
// and corrupt that round-trip. These fixtures + test pin the honest
// behavior: composed and decomposed metadata serialize DISTINCTLY (no
// silent normalization), and raw/asset bytes are hashed untouched.
fn nfc_alignment_fixture(name: &str) -> String {
    let path = repo_fixture_path(&format!("fixtures/kaifuu-core/nfc-alignment/{name}"));
    fs::read_to_string(path).unwrap()
}

#[test]
fn stable_json_metadata_rule_does_not_nfc_normalize_string_contents() {
    // Composed: "café" = U+00E9; "がぎぐ" = U+304C U+304E U+3050.
    // Decomposed: "cafe" + U+0301; "か"+U+3099... = the SAME logical text.
    let composed: Value = serde_json::from_str(&nfc_alignment_fixture("composed-metadata.json"))
        .expect("composed fixture is valid JSON");
    let decomposed: Value =
        serde_json::from_str(&nfc_alignment_fixture("decomposed-metadata.json"))
            .expect("decomposed fixture is valid JSON");

    // The fixtures encode exactly the code points we claim: byte-distinct
    // representations of the same logical strings.
    assert_eq!(composed["displayName"].as_str().unwrap(), "caf\u{00e9}");
    assert_eq!(decomposed["displayName"].as_str().unwrap(), "cafe\u{0301}");
    assert_eq!(
        composed["speakerNote"].as_str().unwrap(),
        "\u{304c}\u{304e}\u{3050}"
    );
    assert_eq!(
        decomposed["speakerNote"].as_str().unwrap(),
        "\u{304b}\u{3099}\u{304d}\u{3099}\u{304f}\u{3099}"
    );
    // Logically equal, byte-distinct (this is exactly what an NFC rule would
    // otherwise collapse — and what we must NOT collapse).
    assert_ne!(
        composed["displayName"], decomposed["displayName"],
        "fixtures must differ at the code-point level"
    );

    let composed_json = stable_json(&composed).unwrap();
    let decomposed_json = stable_json(&decomposed).unwrap();

    // Honest `utf8-lf-json-stable-v1`: NO NFC. The decomposed input keeps
    // its combining marks; the two serializations stay distinct. If the
    // writer NFC-normalized (as the old `...nfc...` name claimed), these
    // would be byte-identical.
    assert_ne!(
        composed_json, decomposed_json,
        "stable_json must NOT NFC-normalize (decomposed != composed)"
    );
    assert!(
        decomposed_json.contains("cafe\u{0301}"),
        "decomposed combining acute must survive stable_json byte-exact"
    );
    assert!(
        decomposed_json.contains("\u{304b}\u{3099}"),
        "decomposed combining dakuten must survive stable_json byte-exact"
    );
    assert!(
        !decomposed_json.contains("caf\u{00e9}"),
        "stable_json must not silently compose the decomposed form"
    );

    // Round-trip: the emitted bytes reparse to the SAME (still decomposed)
    // value — proving byte-exact preservation the patchback path relies on.
    let reparsed: Value = serde_json::from_str(&decomposed_json).unwrap();
    assert_eq!(reparsed, decomposed);
}

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

#[cfg(unix)]
#[test]
fn local_secret_directory_store_rejects_final_and_intermediate_symlinks() {
    use std::os::unix::fs::symlink;

    let root = temp_dir("local-secret-store-symlink");
    let outside = temp_dir("local-secret-store-symlink-outside");
    fs::create_dir_all(root.join("fixture")).unwrap();
    fs::create_dir_all(outside.join("escape")).unwrap();
    fs::write(
        outside.join("escape").join("secondary-key"),
        (0_u8..16).collect::<Vec<_>>(),
    )
    .unwrap();
    fs::write(
        root.join("fixture").join("real-key"),
        (0_u8..16).collect::<Vec<_>>(),
    )
    .unwrap();
    symlink(
        outside.join("escape"),
        root.join("fixture").join("linked-dir"),
    )
    .unwrap();
    symlink(
        root.join("fixture").join("real-key"),
        root.join("fixture").join("linked-key"),
    )
    .unwrap();

    let store = LocalSecretDirectoryStore::new(&root);
    assert_key_resolver_error(
        store.read_secret("fixture/linked-dir/secondary-key"),
        KeyResolverErrorKind::OutOfPolicy,
        SemanticErrorCode::SecretRefOutOfPolicy,
    );
    assert_key_resolver_error(
        store.read_secret("fixture/linked-key"),
        KeyResolverErrorKind::OutOfPolicy,
        SemanticErrorCode::SecretRefOutOfPolicy,
    );
    assert!(store.support_boundary().contains("device/inode"));
}

#[cfg(not(unix))]
#[test]
fn local_secret_directory_store_documents_non_unix_final_open_boundary() {
    let store = LocalSecretDirectoryStore::new("ignored");

    assert!(
        store
            .support_boundary()
            .contains("unavailable on this platform")
    );
}

#[test]
fn profile_validation_rejects_account_shaped_secret_ref_names() {
    for secret_ref in [
        "local-secret:provider:customer/key",
        "local-secret:customer@example/key",
    ] {
        let mut profile = valid_key_profile_value();
        profile["keyRequirements"][0]["secretRef"] = serde_json::json!(secret_ref);
        let validation = validate_profile_value(&profile);

        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation.failures.iter().any(|failure| {
                failure.code == "invalid_secret_ref"
                    && failure.field == "keyRequirements.0.secretRef"
            }),
            "missing account-shaped secretRef failure for {secret_ref}: {:#?}",
            validation.failures
        );
    }
}

#[test]
fn profile_validation_requires_matching_key_requirement_ids() {
    let mut profile = valid_key_profile_value();
    profile["keyRequirements"][0]["requirementId"] = serde_json::json!("siglus-unrelated-key");

    let validation = validate_profile_value(&profile);

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation.failures.iter().any(|failure| {
            failure.code == SEMANTIC_MISSING_KEY_PROFILE
                && failure.field == "keyRequirements"
                && failure.message.contains("siglus-secondary-key")
        }),
        "missing strict key requirement match failure: {:#?}",
        validation.failures
    );
}

#[test]
fn profile_validation_rejects_base64url_raw_secret_refs() {
    let mut profile = valid_key_profile_value();
    let raw_base64url = "local-secret:mP9xZpQ2rS7vLj4N8aW_KtYd0hF3uC6b";
    profile["keyRequirements"][0]["secretRef"] = serde_json::json!(raw_base64url);

    let validation = validate_profile_value(&profile);

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation.failures.iter().any(|failure| {
            failure.code == "invalid_secret_ref" && failure.field == "keyRequirements.0.secretRef"
        }),
        "missing raw secretRef failure: {:#?}",
        validation.failures
    );
    assert!(SecretRef::new("local-secret:siglus-primary-key").is_ok());
}

#[test]
fn profile_validation_rejects_all_letter_base64url_raw_secret_refs() {
    let mut profile = valid_key_profile_value();
    profile["keyRequirements"][0]["secretRef"] =
        serde_json::json!(format!("local-secret:{ALL_LETTER_RAW_KEY_MATERIAL}"));

    let validation = validate_profile_value(&profile);

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation.failures.iter().any(|failure| {
            failure.code == "invalid_secret_ref" && failure.field == "keyRequirements.0.secretRef"
        }),
        "missing all-letter raw secretRef failure: {:#?}",
        validation.failures
    );
    assert!(SecretRef::new("local-secret:siglus-primary-key").is_ok());
    assert!(SecretRef::new("local-secret:rpgmaker-mv-key").is_ok());
}

#[test]
fn profile_validation_rejects_raw_archive_parameter_key_values() {
    let mut profile = valid_key_profile_value();
    let raw_base64url = "mP9xZpQ2rS7vLj4N8aW_KtYd0hF3uC6b";
    profile["archiveParameters"][0]["name"] = serde_json::json!("cipherKey");
    profile["archiveParameters"][0]["kind"] = serde_json::json!("cipherScheme");
    profile["archiveParameters"][0]["value"] = serde_json::json!(raw_base64url);

    let validation = validate_profile_value(&profile);

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation.failures.iter().any(|failure| {
            failure.code == SEMANTIC_SECRET_REDACTED && failure.field == "archiveParameters.0.value"
        }),
        "missing raw archive parameter redaction failure: {:#?}",
        validation.failures
    );

    let redacted = redact_secret_bearing_value(&profile);
    assert_eq!(
        redacted.value["archiveParameters"][0]["value"],
        format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")
    );
    assert!(
        !serde_json::to_string(&redacted.value)
            .unwrap()
            .contains(raw_base64url)
    );
}

#[test]
fn profile_validation_rejects_all_letter_raw_archive_parameter_key_values() {
    for parameter_name in ["archiveKey", "cipherMaterial", "secretMaterial"] {
        let mut profile = valid_key_profile_value();
        profile["archiveParameters"][0]["name"] = serde_json::json!(parameter_name);
        profile["archiveParameters"][0]["kind"] = serde_json::json!("cipherScheme");
        profile["archiveParameters"][0]["value"] = serde_json::json!(ALL_LETTER_RAW_KEY_MATERIAL);
        profile["archiveParameters"][0]["source"] = serde_json::json!("manual");

        let validation = validate_profile_value(&profile);

        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation.failures.iter().any(|failure| {
                failure.code == SEMANTIC_SECRET_REDACTED
                    && failure.field == "archiveParameters.0.value"
            }),
            "missing all-letter raw archive parameter redaction failure for {parameter_name}: {:#?}",
            validation.failures
        );

        let redacted = redact_secret_bearing_value(&profile);
        assert_eq!(
            redacted.value["archiveParameters"][0]["value"],
            format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")
        );
        assert!(
            !serde_json::to_string(&redacted.value)
                .unwrap()
                .contains(ALL_LETTER_RAW_KEY_MATERIAL)
        );
    }
}

#[test]
fn profile_validation_rejects_raw_key_material_and_private_evidence() {
    let mut profile = valid_key_profile_value();
    profile["keyRequirements"][0]["rawKey"] = serde_json::json!("00112233445566778899aabbccddeeff");
    profile["helperEvidence"]["helperDump"] = serde_json::json!("register dump with key bytes");
    profile["metadata"]["localPath"] = serde_json::json!("/home/dev/private-game");
    profile["metadata"]["decryptedText"] = serde_json::json!("private translated script line");

    let validation = validate_profile_value(&profile);

    assert_eq!(validation.status, OperationStatus::Failed);
    for field in [
        "keyRequirements.0.rawKey",
        "helperEvidence.helperDump",
        "metadata.localPath",
        "metadata.decryptedText",
    ] {
        assert!(
            validation.failures.iter().any(|failure| {
                failure.code == SEMANTIC_SECRET_REDACTED && failure.field == field
            }),
            "missing redaction failure for {field}: {:#?}",
            validation.failures
        );
    }

    let redacted = redact_secret_bearing_value(&profile);
    assert_eq!(
        redacted.value["keyRequirements"][0]["secretRef"],
        "local-secret:siglus/example/secondary-key"
    );
    let serialized = serde_json::to_string(&redacted.value).unwrap();
    assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
    assert!(!serialized.contains("/home/dev/private-game"));
    assert!(!serialized.contains("private translated script line"));
}

#[test]
fn profile_validation_rejects_arbitrary_helper_command_metadata() {
    let mut profile = valid_key_profile_value();
    profile["metadata"]["command"] = serde_json::json!("sh -c helper");
    profile["metadata"]["args"] = serde_json::json!("--dump");
    profile["helperEvidence"]["executable"] = serde_json::json!("helper.exe");
    profile["helperEvidence"]["path"] = serde_json::json!("helpers/key-helper.exe");
    profile["helperEvidence"]["config"] = serde_json::json!({"path": "helpers/key-helper.exe"});

    let validation = validate_profile_value(&profile).redacted_for_report();

    assert_eq!(validation.status, OperationStatus::Failed);
    for field in [
        "metadata.command",
        "metadata.args",
        "helperEvidence.executable",
        "helperEvidence.path",
        "helperEvidence.config",
        "helperEvidence.config.path",
    ] {
        assert!(
            validation.failures.iter().any(|failure| {
                failure.code == SEMANTIC_HELPER_PROFILE_FORBIDDEN_EXECUTION_FIELD
                    && failure.field == field
            }),
            "missing forbidden profile helper execution diagnostic for {field}: {:#?}",
            validation.failures
        );
    }
    let serialized = serde_json::to_string(&validation).unwrap();
    assert!(!serialized.contains("sh -c helper"));
}

#[test]
fn profile_validation_scans_requirement_and_capability_free_text_fields() {
    let mut profile = valid_key_profile_value();
    profile["requirements"][0]["status"] = serde_json::json!("missing");
    profile["requirements"][0]["description"] = serde_json::json!(
        "helper dump source:/home/dev/game/private-route-ending.ks included raw key 00112233445566778899aabbccddeeff"
    );
    profile["requirements"][0]["placeholder"] =
        serde_json::json!("file=C:\\Games\\SecretRoute\\key.bin");
    profile["capabilities"][1]["limitation"] =
        serde_json::json!("decrypted text from private-route-ending.ks requires local review");

    let validation = validate_profile_value(&profile);

    assert_eq!(validation.status, OperationStatus::Failed);
    for field in [
        "requirements.0.description",
        "requirements.0.placeholder",
        "capabilities.1.limitation",
    ] {
        assert!(
            validation.failures.iter().any(|failure| {
                failure.code == SEMANTIC_SECRET_REDACTED && failure.field == field
            }),
            "missing free-text redaction failure for {field}: {:#?}",
            validation.failures
        );
    }

    let redacted = validation.redacted_for_report();
    let serialized = serde_json::to_string(&redacted).unwrap();
    assert!(!serialized.contains("/home/dev/game"));
    assert!(!serialized.contains("C:\\Games"));
    assert!(!serialized.contains("helper dump"));
    assert!(!serialized.contains("decrypted text"));
    assert!(!serialized.contains("00112233445566778899aabbccddeeff"));
    assert!(!serialized.contains("private-route-ending.ks"));
}

#[test]
fn log_report_redaction_catches_embedded_local_path_formats() {
    for text in [
        "helper failed path=/home/dev/game",
        "helper failed source:/home/dev/game",
        "helper failed file=C:\\Games\\SecretRoute\\game.exe",
        "helper failed path=~/games/private/key.bin",
        "helper failed path=$HOME/games/key.bin",
        "helper failed path=%USERPROFILE%\\Games\\key.bin",
    ] {
        let redacted = redact_for_log_or_report(text);
        assert_eq!(
            redacted,
            format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]"),
            "{text} should be redacted"
        );
    }
}

#[test]
fn report_value_redaction_covers_secret_keys_paths_and_nested_payload_text() {
    let value = serde_json::json!({
        "adapterId": "kaifuu.fixture",
        "rawKey": "actual-secret",
        "metadata": {
            "localPath": "~/Private Route Spoiler Game",
            "safeRelativePath": "scripts/common.ks",
            "diagnostic": "source=$HOME/games/private-key.bin"
        },
        "failures": [
            {
                "message": "decrypted text included 00112233445566778899aabbccddeeff",
                "assetRef": "%USERPROFILE%\\Games\\private-key.bin"
            }
        ]
    });

    let redacted = redact_report_value(&value);
    let serialized = serde_json::to_string(&redacted).unwrap();

    assert_eq!(redacted["adapterId"], "kaifuu.fixture");
    assert_eq!(
        redacted["metadata"]["safeRelativePath"],
        "scripts/common.ks"
    );
    assert!(serialized.contains(SEMANTIC_SECRET_REDACTED));
    for forbidden in [
        "actual-secret",
        "~/Private Route Spoiler Game",
        "$HOME/games",
        "%USERPROFILE%",
        "Private Route Spoiler Game",
        "private-key.bin",
        "decrypted text",
        "00112233445566778899aabbccddeeff",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "redacted report value leaked {forbidden}: {serialized}"
        );
    }
}

#[test]
fn patchback_diagnostic_codes_stay_visible_while_secret_material_redacts() {
    // KAIFUU: exempt typed patchback diagnostic codes/categories/reasons
    // from the free-text secret-redactor so an agent can triage patch
    // failures at scale, WITHOUT weakening raw-key redaction. This is the
    // v0.2 PatchResult `failures` shape emitted by `build_failure_v02` /
    // `map_patchback_error_to_v02_failure` and redacted through
    // `redact_report_value` on the CLI emit path.
    let raw_key = "sk-Ab3xQ9pLmN7rT2vW8yZ4dK6hJ1cF5gB0nP-eR_uS";
    let value = serde_json::json!({
        "schemaVersion": "0.2.0",
        "status": "failed",
        "failureCategories": ["patch_write_failed", "source_incompatible"],
        "failures": [
            {
                // A UUID failure id — must survive verbatim (not a secret).
                "failureId": "019ed011-0000-7000-8000-000000000031",
                "category": "patch_write_failed",
                // The typed diagnostic code false-tripped the raw-key
                // heuristic in prose form before this fix; it MUST be visible.
                "diagnosticCode": "kaifuu.reallive.patchback_target_encode_failure",
                // Free-text cause: the typed code prefix + the human reason
                // (a UUID unit id, a scene id, an offset) stay visible while
                // an embedded raw-key-shaped token is scrubbed in place.
                "cause": format!(
                    "kaifuu.reallive.patchback_target_encode_failure: unit 019ed011-0000-7000-8000-000000000020 target text could not be encoded as Shift-JIS at scene 0031 offset 0x1a2b; leaked key {raw_key}"
                ),
                "bridgeUnitId": "019ed011-0000-7000-8000-000000000020",
                "adapterId": "kaifuu-reallive",
                "command": "patch.write_string_slot",
            },
            {
                "failureId": "019ed011-0000-7000-8000-000000000032",
                "category": "source_incompatible",
                "diagnosticCode": "kaifuu.reallive.patchback_provenance_mismatch",
                "cause": "kaifuu.reallive.patchback_provenance_mismatch: unit u1 byte range 0x1a2b..0x1a3c does not resolve to a scene textout body: offset drift",
                "bridgeUnitId": "019ed011-0000-7000-8000-000000000021",
                "adapterId": "kaifuu-reallive",
                "command": "patch.write_string_slot",
            }
        ],
    });

    let redacted = redact_report_value(&value);

    assert_eq!(
        redacted["failures"][0]["diagnosticCode"],
        "kaifuu.reallive.patchback_target_encode_failure",
        "typed diagnostic code must be visible for triage, not [REDACTED]"
    );
    assert_eq!(
        redacted["failures"][0]["category"], "patch_write_failed",
        "typed failure category must be visible"
    );
    assert_eq!(
        redacted["failures"][1]["diagnosticCode"],
        "kaifuu.reallive.patchback_provenance_mismatch"
    );
    assert_eq!(
        redacted["failures"][0]["failureId"], "019ed011-0000-7000-8000-000000000031",
        "UUID failure id must survive verbatim"
    );
    assert_eq!(
        redacted["failureCategories"][0], "patch_write_failed",
        "failure category vocabulary must survive verbatim"
    );
    // The human-readable reason stays legible: the code, the unit id, the
    // scene id and the offset all remain in the cause string.
    let cause0 = redacted["failures"][0]["cause"].as_str().unwrap();
    for legible in [
        "kaifuu.reallive.patchback_target_encode_failure",
        "could not be encoded as Shift-JIS",
        "scene 0031",
        "offset 0x1a2b",
        "019ed011-0000-7000-8000-000000000020",
    ] {
        assert!(
            cause0.contains(legible),
            "diagnostic reason lost triage detail {legible}: {cause0}"
        );
    }
    // The second, entirely-non-secret cause survives unchanged.
    assert_eq!(
        redacted["failures"][1]["cause"],
        "kaifuu.reallive.patchback_provenance_mismatch: unit u1 byte range 0x1a2b..0x1a3c does not resolve to a scene textout body: offset drift"
    );

    assert!(
        cause0.contains(SEMANTIC_SECRET_REDACTED),
        "the embedded raw-key token must be scrubbed: {cause0}"
    );
    let serialized = serde_json::to_string(&redacted).unwrap();
    assert!(
        !serialized.contains(raw_key),
        "raw key material leaked through the diagnostic exemption: {serialized}"
    );
}

#[test]
fn diagnostic_free_text_scrub_masks_secret_tokens_but_keeps_reason() {
    // Directly exercise the token scrubber: a free-text reason keeps every
    // safe token while masking each secret-shaped token in place, so the
    // raw-key heuristic is not weakened.
    let raw_hex = "00112233445566778899aabbccddeeff00112233";
    let text = format!(
        "scene 0031 header parse failed at offset 0x40; leaked key {raw_hex} and path /home/dev/private.bin"
    );
    let scrubbed = super::redact_secret_tokens_in_text(&text);
    for legible in [
        "scene", "0031", "header", "parse", "failed", "offset", "0x40",
    ] {
        assert!(
            scrubbed.contains(legible),
            "scrub dropped safe token {legible}: {scrubbed}"
        );
    }
    assert!(
        !scrubbed.contains(raw_hex),
        "raw hex key not scrubbed: {scrubbed}"
    );
    assert!(
        !scrubbed.contains("/home/dev/private.bin"),
        "local path not scrubbed: {scrubbed}"
    );
    assert!(scrubbed.contains(SEMANTIC_SECRET_REDACTED));
}

#[test]
fn typed_diagnostic_field_exemption_is_value_shape_gated_not_name_gated() {
    // The exemption must not ride on the field NAME alone: a secret-shaped
    // value that lands in a diagnosticCode / failureId / category field must
    // STILL redact, while a genuine enum code / category / UUID in the same
    // field stays visible.
    let raw_key_hex = "00112233445566778899aabbccddeeff00112233";
    let raw_key_b64url = "Ab3xQ9pLmN7rT2vW8yZ4dK6hJ1cF5gB0nP-eR_uS0-9";
    let value = serde_json::json!({
        // Safe values — must survive verbatim.
        "diagnosticCode": "kaifuu.reallive.patchback_target_encode_failure",
        "category": "patch_write_failed",
        "failureId": "019ed011-0000-7000-8000-000000000031",
        // Hostile values wearing typed-identifier field NAMES — must redact.
        "failures": [
            { "diagnosticCode": raw_key_hex },
            { "category": raw_key_b64url },
            // A non-UUID secret-shaped value in a failureId field.
            { "failureId": raw_key_hex },
        ],
    });

    let redacted = redact_report_value(&value);
    let serialized = serde_json::to_string(&redacted).unwrap();

    // Common case: real codes/categories/UUIDs stay visible.
    assert_eq!(
        redacted["diagnosticCode"],
        "kaifuu.reallive.patchback_target_encode_failure"
    );
    assert_eq!(redacted["category"], "patch_write_failed");
    assert_eq!(
        redacted["failureId"],
        "019ed011-0000-7000-8000-000000000031"
    );

    // Secret-shaped values in code-named fields must NOT ride through.
    assert_eq!(
        redacted["failures"][0]["diagnosticCode"],
        format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]"),
        "raw-key-shaped value in a diagnosticCode field must redact"
    );
    assert_eq!(
        redacted["failures"][1]["category"],
        format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]"),
        "base64url-shaped value in a category field must redact"
    );
    assert_eq!(
        redacted["failures"][2]["failureId"],
        format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]"),
        "non-UUID secret-shaped value in a failureId field must redact"
    );
    for leaked in [raw_key_hex, raw_key_b64url] {
        assert!(
            !serialized.contains(leaked),
            "secret rode through a code-named field: {serialized}"
        );
    }
}

#[test]
fn patch_and_verify_report_redaction_covers_hostile_top_level_fields() {
    let raw_key = "00112233445566778899aabbccddeeff";
    let patch_result = PatchResult {
        schema_version: PROFILE_SCHEMA_VERSION.to_string(),
        patch_result_id: "patch-result=/home/dev/game/private-route-ending.ks".to_string(),
        patch_export_id: format!("patch-export helper dump raw key {raw_key}"),
        status: OperationStatus::Failed,
        output_hash: "C:\\Games\\SecretRoute\\private-route-ending.ks".to_string(),
        failures: vec![AdapterFailure::secret_redacted(
            "kaifuu.fixture",
            "fixture",
            "private-route",
            "private-route-ending.ks",
            format!("helper dump source:/home/dev/game/private-route-ending.ks raw key {raw_key}"),
        )],
    };
    let verify_result = VerificationResult {
        schema_version: PROFILE_SCHEMA_VERSION.to_string(),
        patch_result_id: "verify-result=/home/dev/game/private-route-ending.ks".to_string(),
        status: OperationStatus::Failed,
        output_hash: format!("helper dump outputHash {raw_key}"),
        failures: vec![AdapterFailure::helper_unavailable(
            "kaifuu.fixture",
            "fixture",
            "private-route",
            "helper unavailable for C:\\Games\\SecretRoute\\private-route-ending.ks",
        )],
    };

    let patch_serialized = serde_json::to_string(&patch_result.redacted_for_report()).unwrap();
    let verify_serialized = serde_json::to_string(&verify_result.redacted_for_report()).unwrap();

    for serialized in [&patch_serialized, &verify_serialized] {
        assert!(serialized.contains(SEMANTIC_SECRET_REDACTED));
        for forbidden in [
            "/home/dev/game",
            "C:\\Games",
            "SecretRoute",
            "helper dump",
            raw_key,
            "private-route-ending.ks",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "report leaked {forbidden}: {serialized}"
            );
        }
    }
}

#[test]
fn profile_validation_accepts_layered_capability_variants() {
    let mut profile = valid_key_profile_value();
    let capabilities = profile["capabilities"].as_array_mut().unwrap();
    for capability in [
        "container_access",
        "crypto_access",
        "codec_access",
        "patch_back",
    ] {
        capabilities.push(serde_json::json!({
            "capability": capability,
            "status": "requires_user_input",
            "limitation": "requires local layered access support"
        }));
    }

    let validation = validate_profile_value(&profile);

    assert_eq!(validation.status, OperationStatus::Passed);
}

#[test]
fn golden_unchanged_patch_preflight_redaction_blocks_before_work_dir_prepare() {
    let game_dir = temp_dir("golden-unchanged-preflight-game");
    let work_dir = temp_dir("golden-unchanged-preflight-work");
    let sentinel = work_dir.join("unchanged-patch").join("sentinel.txt");
    fs::create_dir_all(sentinel.parent().unwrap()).unwrap();
    fs::write(&sentinel, "keep").unwrap();

    let preflight_calls = Arc::new(AtomicUsize::new(0));
    let patch_calls = Arc::new(AtomicUsize::new(0));
    let mut registry = AdapterRegistry::new();
    registry.register(GoldenPreflightBoundaryAdapter {
        block_on_preflight_call: 1,
        preflight_calls: Arc::clone(&preflight_calls),
        patch_calls: Arc::clone(&patch_calls),
    });

    let report = run_round_trip_golden(
        &registry,
        GoldenHarnessRequest {
            game_dir: &game_dir,
            work_dir: &work_dir,
            adapter_id: Some("kaifuu.golden-preflight-boundary"),
            byte_equivalence: GoldenByteEquivalenceMode::Unsupported {
                support_boundary: "byte identity is outside this preflight test".to_string(),
            },
            translated_patch_export: None,
            translated_source_bridge: None,
        },
    )
    .unwrap();

    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(preflight_calls.load(Ordering::SeqCst), 1);
    assert_eq!(patch_calls.load(Ordering::SeqCst), 0);
    assert!(
        sentinel.exists(),
        "unchanged work dir should not be removed before preflight"
    );
    assert!(report.failures.iter().any(|failure| {
        failure.phase == "unchanged_patch" && failure.code == SEMANTIC_MISSING_CONTAINER_CAPABILITY
    }));
    let serialized = report.stable_json().unwrap();
    for forbidden in [
        "$HOME",
        "%USERPROFILE%",
        "~/",
        "Private Route Spoiler Game",
        "private-route-name",
        "Scene.pck",
        "helper dump",
        "00112233445566778899aabbccddeeff",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "golden report leaked {forbidden}: {serialized}"
        );
    }
}

#[test]
fn golden_translated_patch_preflight_blocks_before_work_dir_prepare() {
    let game_dir = temp_dir("golden-translated-preflight-game");
    let work_dir = temp_dir("golden-translated-preflight-work");
    let sentinel = work_dir.join("translated-patch").join("sentinel.txt");
    fs::create_dir_all(sentinel.parent().unwrap()).unwrap();
    fs::write(&sentinel, "keep").unwrap();

    let preflight_calls = Arc::new(AtomicUsize::new(0));
    let patch_calls = Arc::new(AtomicUsize::new(0));
    let mut registry = AdapterRegistry::new();
    registry.register(GoldenPreflightBoundaryAdapter {
        block_on_preflight_call: 2,
        preflight_calls: Arc::clone(&preflight_calls),
        patch_calls: Arc::clone(&patch_calls),
    });
    let translated_patch =
        serde_json::to_value(golden_boundary_patch_export("translated-patch-1")).unwrap();

    let report = run_round_trip_golden(
        &registry,
        GoldenHarnessRequest {
            game_dir: &game_dir,
            work_dir: &work_dir,
            adapter_id: Some("kaifuu.golden-preflight-boundary"),
            byte_equivalence: GoldenByteEquivalenceMode::Unsupported {
                support_boundary: "byte identity is outside this preflight test".to_string(),
            },
            translated_patch_export: Some(&translated_patch),
            translated_source_bridge: None,
        },
    )
    .unwrap();

    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(preflight_calls.load(Ordering::SeqCst), 2);
    assert_eq!(patch_calls.load(Ordering::SeqCst), 1);
    assert!(
        sentinel.exists(),
        "translated work dir should not be removed before preflight"
    );
    assert!(report.failures.iter().any(|failure| {
        failure.phase == "translated_patch" && failure.code == SEMANTIC_MISSING_CONTAINER_CAPABILITY
    }));
}

#[test]
fn missing_secret_requirements_emit_key_profile_semantic_errors() {
    let mut profile = valid_key_profile_value();
    profile.as_object_mut().unwrap().remove("keyRequirements");
    profile["requirements"][0]["status"] = serde_json::json!("missing");
    profile["requirements"][0]["placeholder"] = serde_json::json!("KAIFUU_SIGLUS_KEY");

    let validation = validate_profile_value(&profile);

    assert_eq!(validation.status, OperationStatus::Failed);
    for expected_code in [SEMANTIC_MISSING_KEY_MATERIAL, SEMANTIC_MISSING_KEY_PROFILE] {
        assert!(
            validation
                .failures
                .iter()
                .any(|failure| failure.code == expected_code),
            "missing {expected_code}: {:#?}",
            validation.failures
        );
    }
}

#[test]
fn adapter_key_declarations_serialize_stable_semantic_errors() {
    let reports = vec![
        CapabilityReport::requires_user_input(
            Capability::KeyProfile,
            "requires local-only key profile secret refs",
        ),
        CapabilityReport::requires_user_input(
            Capability::EncryptedInput,
            "requires caller-provided resolved keys",
        ),
    ];
    // derive explicitly from reports so the registry gate
    // sees Identify Unsupported (no Detection report) rather than a
    // bubbled-up identify-only claim against missing Detection.
    let matrix = AdapterCapabilityMatrix::derive_from_reports("kaifuu.siglus", &reports);
    let capabilities = AdapterCapabilities::new("kaifuu.siglus", reports, matrix)
        .with_key_requirements(vec![AdapterKeyRequirementDeclaration {
            requirement_id: "siglus-secondary-key".to_string(),
            engine_family: "siglus".to_string(),
            material_kind: KeyMaterialKind::FixedBytes,
            bytes: Some(16),
            archive_parameters: vec![ArchiveParameterDeclaration {
                parameter_id: "scene-archive".to_string(),
                name: "sceneArchive".to_string(),
                kind: ArchiveParameterKind::ArchiveFormat,
                required: true,
            }],
            validation: AdapterKeyValidationDeclaration {
                method: KeyValidationMethod::DecryptHeaderProof,
                proof_required: true,
            },
            semantic_errors: vec![
                SemanticErrorCode::MissingKeyProfile,
                SemanticErrorCode::MissingKeyMaterial,
                SemanticErrorCode::HelperUnavailable,
                SemanticErrorCode::HelperRequired,
                SemanticErrorCode::KeyValidationFailed,
                SemanticErrorCode::SecretRedacted,
                SemanticErrorCode::ProtectedExecutableUnsupported,
                SemanticErrorCode::UnsupportedLayeredTransform,
                SemanticErrorCode::MissingContainerCapability,
                SemanticErrorCode::MissingCryptoCapability,
                SemanticErrorCode::MissingCodecCapability,
                SemanticErrorCode::MissingPatchBackCapability,
                SemanticErrorCode::UnsupportedVariantEncrypted,
            ],
        }]);

    let value = serde_json::to_value(capabilities).unwrap();

    assert_eq!(
        value["keyRequirements"][0]["semanticErrors"],
        serde_json::json!([
            "kaifuu.missing_capability.key_profile",
            "kaifuu.missing_key_material",
            "kaifuu.helper_unavailable",
            "kaifuu.helper_required",
            "kaifuu.key_validation_failed",
            "kaifuu.secret_redacted",
            "kaifuu.protected_executable_unsupported",
            "kaifuu.unsupported_layered_transform",
            "kaifuu.missing_capability.container",
            "kaifuu.missing_capability.crypto",
            "kaifuu.missing_capability.codec",
            "kaifuu.missing_capability.patch_back",
            "kaifuu.unsupported_variant.encrypted"
        ])
    );
}

#[test]
fn adapter_capabilities_redacts_key_requirement_declaration_strings() {
    let adapter_id = "kaifuu.path=/home/dev/game/private-route-ending.ks";
    let reports = vec![CapabilityReport::requires_user_input(
        Capability::KeyProfile,
        "helper dump source:/home/dev/game/private-route-ending.ks exposed raw key 00112233445566778899aabbccddeeff",
    )];
    // redaction-pipeline fixture — derive explicitly so
    // the matrix matches the (fully unsupported at Identify) reports.
    let matrix = AdapterCapabilityMatrix::derive_from_reports(adapter_id, &reports);
    let capabilities =
        AdapterCapabilities::new(adapter_id, reports, matrix).with_key_requirements(vec![
            AdapterKeyRequirementDeclaration {
                requirement_id:
                    "source:/home/dev/game/private-route-ending.ks:00112233445566778899aabbccddeeff"
                        .to_string(),
                engine_family: "helper dump C:\\Games\\SecretRoute\\engine.exe".to_string(),
                material_kind: KeyMaterialKind::FixedBytes,
                bytes: Some(16),
                archive_parameters: vec![ArchiveParameterDeclaration {
                    parameter_id: "file=C:\\Games\\SecretRoute\\Scene.pck".to_string(),
                    name: "private-route-ending.ks".to_string(),
                    kind: ArchiveParameterKind::ArchiveFormat,
                    required: true,
                }],
                validation: AdapterKeyValidationDeclaration {
                    method: KeyValidationMethod::DecryptHeaderProof,
                    proof_required: true,
                },
                semantic_errors: vec![SemanticErrorCode::SecretRedacted],
            },
        ]);

    let redacted = capabilities.redacted_for_report();
    let serialized = serde_json::to_string(&redacted).unwrap();

    assert!(serialized.contains(SEMANTIC_SECRET_REDACTED));
    assert_eq!(
        redacted.key_requirements[0].material_kind,
        KeyMaterialKind::FixedBytes
    );
    assert_eq!(redacted.key_requirements[0].bytes, Some(16));
    assert_eq!(
        redacted.key_requirements[0].validation.method,
        KeyValidationMethod::DecryptHeaderProof
    );
    assert_eq!(
        redacted.key_requirements[0].semantic_errors,
        vec![SemanticErrorCode::SecretRedacted]
    );
    for forbidden in [
        "/home/dev/game",
        "C:\\Games",
        "helper dump",
        "00112233445566778899aabbccddeeff",
        "private-route-ending.ks",
        "SecretRoute",
    ] {
        assert!(
            !serialized.contains(forbidden),
            "capabilities leaked {forbidden}"
        );
    }
}

#[test]
fn adapter_failure_constructors_use_key_boundary_codes() {
    assert_eq!(
        AdapterFailure::missing_key_profile(
            "kaifuu.siglus",
            "siglus",
            "scene-pck-secondary-key",
            "pure adapters require a key profile before encrypted extraction"
        )
        .error_code,
        SEMANTIC_MISSING_KEY_PROFILE
    );
    assert_eq!(
        AdapterFailure::missing_key_material(
            "kaifuu.siglus",
            "siglus",
            "scene-pck-secondary-key",
            "siglus-secondary-key",
            "local secret storage did not resolve the referenced key"
        )
        .error_code,
        SEMANTIC_MISSING_KEY_MATERIAL
    );
    assert_eq!(
        AdapterFailure::helper_unavailable(
            "kaifuu.siglus",
            "siglus",
            "scene-pck-secondary-key",
            "helper execution is outside the pure adapter"
        )
        .error_code,
        SEMANTIC_HELPER_UNAVAILABLE
    );
    assert_eq!(
        AdapterFailure::key_validation_failed(
            "kaifuu.siglus",
            "siglus",
            "scene-pck-secondary-key",
            "siglus-secondary-key",
            "proof hash did not match local asset validation"
        )
        .error_code,
        SEMANTIC_KEY_VALIDATION_FAILED
    );
    assert_eq!(
        AdapterFailure::protected_executable_unsupported(
            "kaifuu.kirikiri",
            "kirikiri",
            "xp3-protected-executable",
            "protected executable helper cannot analyze this fixture"
        )
        .error_code,
        SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED
    );
    assert_eq!(
        AdapterFailure::secret_redacted(
            "kaifuu.siglus",
            "siglus",
            "scene-pck-secondary-key",
            "helper-evidence",
            "helper output included secret-bearing fields"
        )
        .error_code,
        SEMANTIC_SECRET_REDACTED
    );
}

#[test]
fn layered_access_preflight_reports_stable_redacted_failures() {
    let raw_key = "00112233445566778899aabbccddeeff";
    let report = LayeredAccessPreflightReport::from_requirements(
        "kaifuu.private-adapter",
        "kirikiri",
        "xp3-encrypted-protected",
        vec![
            LayeredAccessPreflightRequirement::missing_capability(
                LayeredAccessStage::Container,
                "private-route-name/ending.ks",
                "missing XP3 container transform for /home/dev/Private Route Spoiler Game/data.xp3",
            ),
            LayeredAccessPreflightRequirement::missing_capability(
                LayeredAccessStage::Crypto,
                "Scene.pck",
                format!("raw key {raw_key} was not resolved"),
            ),
            LayeredAccessPreflightRequirement::missing_capability(
                LayeredAccessStage::Codec,
                "script.bin",
                "codec support has no helper dump or decrypted text evidence",
            ),
            LayeredAccessPreflightRequirement::missing_capability(
                LayeredAccessStage::PatchBack,
                "patch-back-target",
                "patch-back writer is absent for this container",
            ),
            LayeredAccessPreflightRequirement::unsupported_transform(
                LayeredAccessStage::Crypto,
                "helper dump from private executable",
                "Gameexe.dat",
                "requested transform is not in the alpha readiness profile",
            ),
        ],
    );

    assert_eq!(report.status, OperationStatus::Failed);
    let codes = report
        .failures
        .iter()
        .map(|failure| failure.error_code.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        codes,
        vec![
            SEMANTIC_MISSING_CONTAINER_CAPABILITY,
            SEMANTIC_MISSING_CRYPTO_CAPABILITY,
            SEMANTIC_MISSING_CODEC_CAPABILITY,
            SEMANTIC_MISSING_PATCH_BACK_CAPABILITY,
            SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM,
        ]
    );
    assert!(
        report
            .failures
            .iter()
            .all(AdapterFailure::is_preflight_blocking)
    );
    assert!(
        report
            .failures
            .iter()
            .any(|failure| { failure.required_capability == Some(Capability::ContainerAccess) })
    );
    assert!(
        report
            .failures
            .iter()
            .any(|failure| { failure.required_capability == Some(Capability::PatchBack) })
    );

    let serialized = report.stable_json().unwrap();
    assert!(!serialized.contains(raw_key));
    assert!(!serialized.contains("/home/dev"));
    assert!(!serialized.contains("Private Route Spoiler Game"));
    assert!(!serialized.contains("private-route-name"));
    assert!(!serialized.contains("helper dump"));
    assert!(!serialized.contains("decrypted text"));
    assert!(serialized.contains(SEMANTIC_SECRET_REDACTED));
}

#[test]
fn layered_access_profile_represents_plaintext_and_encrypted_surfaces() {
    let mut profile = GameProfile {
        schema_version: PROFILE_SCHEMA_VERSION.to_string(),
        profile_id: deterministic_id("profile", 520),
        game_id: "mv-mz-layered-fixture".to_string(),
        title: "MV MZ Layered Fixture".to_string(),
        source_locale: "ja-JP".to_string(),
        engine: EngineProfile {
            adapter_id: "kaifuu.rpg-maker-mv-mz".to_string(),
            engine_family: "rpg-maker-mv-mz".to_string(),
            engine_version: None,
            detected_variant: "json-text-encrypted-media".to_string(),
        },
        source_fingerprint: None,
        key_requirements: vec![],
        archive_parameters: vec![],
        helper_evidence: None,
        assets: vec![
            AssetProfile {
                asset_id: "data/map001.json".to_string(),
                path: "data/Map001.json".to_string(),
                asset_kind: AssetKind::Script,
                text_surfaces: vec![TextSurface::Dialogue],
                source_hash: Some(content_hash("json text")),
                patching: CapabilityReport::supported(Capability::Patching),
            },
            AssetProfile {
                asset_id: "img/pictures/title.rpgmvp".to_string(),
                path: "img/pictures/title.rpgmvp".to_string(),
                asset_kind: AssetKind::Image,
                text_surfaces: vec![TextSurface::ImageText],
                source_hash: Some(content_hash("encrypted image asset")),
                patching: CapabilityReport::unsupported(
                    Capability::AssetTextPatching,
                    "encrypted media text restoration is not supported by this profile",
                ),
            },
        ],
        layered_access: Some(LayeredAccessProfile {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            surfaces: vec![
                LayeredTextSurfaceAccess {
                    surface_id: "map001-dialogue".to_string(),
                    asset_id: "data/map001.json".to_string(),
                    path: "data/Map001.json".to_string(),
                    text_surface: TextSurface::Dialogue,
                    surface_transform: SurfaceTransform::JsonPointer,
                    surface_selector: "$.events[*].pages[*].list[*].parameters[*]".to_string(),
                    container: ContainerTransform::LooseFile,
                    crypto: CryptoTransform::NullKey,
                    codec: CodecTransform::RpgMakerMvMzJson,
                    patch_back: PatchBackTransform::RewriteJson,
                    key_material_status: LayeredAccessKeyMaterialStatus::NotRequired,
                    helper_status: LayeredAccessHelperStatus::NotRequired,
                    key_requirement_refs: vec![],
                    notes: vec![],
                },
                LayeredTextSurfaceAccess {
                    surface_id: "title-image-text".to_string(),
                    asset_id: "img/pictures/title.rpgmvp".to_string(),
                    path: "img/pictures/title.rpgmvp".to_string(),
                    text_surface: TextSurface::ImageText,
                    surface_transform: SurfaceTransform::OcrRegion,
                    surface_selector: "image:full-frame".to_string(),
                    container: ContainerTransform::LooseFile,
                    crypto: CryptoTransform::RpgMakerAssetKey,
                    codec: CodecTransform::Identity,
                    patch_back: PatchBackTransform::ReplaceAsset,
                    key_material_status: LayeredAccessKeyMaterialStatus::Missing,
                    helper_status: LayeredAccessHelperStatus::NotRequired,
                    key_requirement_refs: vec![],
                    notes: vec![
                        "MV/MZ media can be encrypted while JSON text remains plaintext"
                            .to_string(),
                    ],
                },
            ],
        }),
        capabilities: vec![
            CapabilityReport::supported(Capability::Detection),
            CapabilityReport::supported(Capability::ProfileGeneration),
            CapabilityReport::supported(Capability::Patching),
            CapabilityReport::supported(Capability::ContainerAccess),
            CapabilityReport::supported(Capability::CryptoAccess),
            CapabilityReport::supported(Capability::CodecAccess),
            CapabilityReport::supported(Capability::PatchBack),
            CapabilityReport::unsupported(
                Capability::AssetTextPatching,
                "encrypted media asset text is inventoried but not patched",
            ),
        ],
        requirements: vec![],
        metadata: BTreeMap::new(),
    };

    profile.normalize();

    assert_eq!(profile.validate().status, OperationStatus::Passed);
    let serialized = profile.stable_json().unwrap();
    assert!(serialized.contains("\"crypto\": \"null_key\""));
    assert!(serialized.contains("\"crypto\": \"rpg_maker_asset_key\""));
    assert!(serialized.contains("\"codec\": \"rpg_maker_mv_mz_json\""));
    assert!(serialized.contains("\"surfaceTransform\": \"ocr_region\""));
}

#[test]
fn layered_access_preflight_blocks_transform_key_and_helper_gates() {
    let reports = vec![
        CapabilityReport::supported(Capability::ContainerAccess),
        CapabilityReport::supported(Capability::CryptoAccess),
        CapabilityReport::supported(Capability::CodecAccess),
        CapabilityReport::supported(Capability::PatchBack),
    ];
    let capabilities = AdapterCapabilities::new(
        "kaifuu.layered-test",
        reports.clone(),
        derived_matrix_for("kaifuu.layered-test", &reports),
    )
    .with_access_contract(LayeredAccessCapabilityContract::plaintext_identity());
    let access_profile = LayeredAccessProfile {
        schema_version: PROFILE_SCHEMA_VERSION.to_string(),
        surfaces: vec![
            LayeredTextSurfaceAccess {
                surface_id: "scene-pck-dialogue".to_string(),
                asset_id: "Scene.pck".to_string(),
                path: "Scene.pck".to_string(),
                text_surface: TextSurface::Dialogue,
                surface_transform: SurfaceTransform::ArchiveEntry,
                surface_selector: "scripts/scene001.bin".to_string(),
                container: ContainerTransform::SiglusPck,
                crypto: CryptoTransform::KeyProfile,
                codec: CodecTransform::BytecodeDecompile,
                patch_back: PatchBackTransform::RepackArchive,
                key_material_status: LayeredAccessKeyMaterialStatus::Missing,
                helper_status: LayeredAccessHelperStatus::NotRequired,
                key_requirement_refs: vec!["siglus-secondary-key".to_string()],
                notes: vec![],
            },
            LayeredTextSurfaceAccess {
                surface_id: "protected-helper-route".to_string(),
                asset_id: "data.xp3".to_string(),
                path: "data.xp3".to_string(),
                text_surface: TextSurface::Dialogue,
                surface_transform: SurfaceTransform::ArchiveEntry,
                surface_selector: "scenario/ending.ks".to_string(),
                container: ContainerTransform::Xp3,
                crypto: CryptoTransform::HelperGated,
                codec: CodecTransform::Utf8Text,
                patch_back: PatchBackTransform::RepackArchive,
                key_material_status: LayeredAccessKeyMaterialStatus::HelperGated,
                helper_status: LayeredAccessHelperStatus::Unavailable,
                key_requirement_refs: vec![],
                notes: vec![],
            },
        ],
    };

    let report = LayeredAccessPreflightReport::from_access_profile(
        "kaifuu.layered-test",
        "fixture",
        "layered-transform-test",
        &capabilities,
        &access_profile,
    );

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.failures.iter().any(|failure| {
        failure.error_code == SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM
            && failure.required_capability == Some(Capability::PatchBack)
    }));
    assert!(
        report
            .failures
            .iter()
            .any(|failure| failure.error_code == SEMANTIC_MISSING_KEY_MATERIAL)
    );
    assert!(
        report
            .failures
            .iter()
            .any(|failure| failure.error_code == SEMANTIC_HELPER_UNAVAILABLE)
    );
    assert!(
        report
            .failures
            .iter()
            .all(AdapterFailure::is_preflight_blocking)
    );
}

#[test]
fn layered_access_preflight_allows_plaintext_identity_without_patch_contract() {
    let reports = vec![
        CapabilityReport::supported(Capability::ContainerAccess),
        CapabilityReport::supported(Capability::CryptoAccess),
        CapabilityReport::supported(Capability::CodecAccess),
        CapabilityReport::supported(Capability::PatchBack),
    ];
    let capabilities = AdapterCapabilities::new(
        "kaifuu.layered-test",
        reports.clone(),
        derived_matrix_for("kaifuu.layered-test", &reports),
    );
    let access_profile = LayeredAccessProfile::plaintext_identity_for_asset(
        "source-json",
        "source.json",
        &[TextSurface::Dialogue],
        "$.lines[*]",
    );

    let report = LayeredAccessPreflightReport::from_access_profile(
        "kaifuu.layered-test",
        "fixture",
        "plaintext-identity",
        &capabilities,
        &access_profile,
    );

    assert_eq!(report.status, OperationStatus::Passed);
    assert_eq!(report.failures, Vec::<AdapterFailure>::new());
}

#[test]
fn layered_access_preflight_fails_closed_without_patch_contract_for_non_identity_transforms() {
    let reports = vec![
        CapabilityReport::supported(Capability::ContainerAccess),
        CapabilityReport::supported(Capability::CryptoAccess),
        CapabilityReport::supported(Capability::CodecAccess),
        CapabilityReport::supported(Capability::PatchBack),
    ];
    let capabilities = AdapterCapabilities::new(
        "kaifuu.layered-test",
        reports.clone(),
        derived_matrix_for("kaifuu.layered-test", &reports),
    );
    let access_profile = LayeredAccessProfile {
        schema_version: PROFILE_SCHEMA_VERSION.to_string(),
        surfaces: vec![LayeredTextSurfaceAccess {
            surface_id: "xp3-bytecode-route".to_string(),
            asset_id: "data.xp3".to_string(),
            path: "data.xp3".to_string(),
            text_surface: TextSurface::Dialogue,
            surface_transform: SurfaceTransform::ArchiveEntry,
            surface_selector: "scenario/route.ks".to_string(),
            container: ContainerTransform::Xp3,
            crypto: CryptoTransform::NullKey,
            codec: CodecTransform::BytecodeDecompile,
            patch_back: PatchBackTransform::RepackArchive,
            key_material_status: LayeredAccessKeyMaterialStatus::Resolved,
            helper_status: LayeredAccessHelperStatus::Available,
            key_requirement_refs: vec![],
            notes: vec![],
        }],
    };

    let report = LayeredAccessPreflightReport::from_access_profile(
        "kaifuu.layered-test",
        "kirikiri",
        "xp3-bytecode",
        &capabilities,
        &access_profile,
    );

    assert_eq!(report.status, OperationStatus::Failed);
    for required_capability in [
        Capability::ContainerAccess,
        Capability::CodecAccess,
        Capability::PatchBack,
    ] {
        assert!(
            report.failures.iter().any(|failure| {
                failure.error_code == SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM
                    && failure.required_capability == Some(required_capability.clone())
            }),
            "missing unsupported transform failure for {required_capability:?}: {:#?}",
            report.failures
        );
    }
    assert!(
        report
            .failures
            .iter()
            .all(AdapterFailure::is_preflight_blocking)
    );
}

#[test]
fn layered_access_preflight_blocks_patch_contract_status_before_transform_match_passes() {
    for status in [
        CapabilityStatus::Unsupported,
        CapabilityStatus::RequiresUserInput,
    ] {
        let mut access_contract = LayeredAccessCapabilityContract::plaintext_identity();
        access_contract.patch.status = status.clone();
        access_contract.patch.support_boundary = Some(format!(
            "patch contract status {status:?} requires local evidence before writing"
        ));
        let reports = vec![
            CapabilityReport::supported(Capability::ContainerAccess),
            CapabilityReport::supported(Capability::CryptoAccess),
            CapabilityReport::supported(Capability::CodecAccess),
            CapabilityReport::supported(Capability::PatchBack),
        ];
        let capabilities = AdapterCapabilities::new(
            "kaifuu.layered-test",
            reports.clone(),
            derived_matrix_for("kaifuu.layered-test", &reports),
        )
        .with_access_contract(access_contract);
        let access_profile = LayeredAccessProfile::plaintext_identity_for_asset(
            "source-json",
            "source.json",
            &[TextSurface::Dialogue],
            "$.lines[*]",
        );

        let report = LayeredAccessPreflightReport::from_access_profile(
            "kaifuu.layered-test",
            "fixture",
            "patch-status",
            &capabilities,
            &access_profile,
        );

        assert_eq!(report.status, OperationStatus::Failed);
        assert!(report.failures.iter().any(|failure| {
            failure.error_code == SEMANTIC_MISSING_PATCH_BACK_CAPABILITY
                && failure.required_capability == Some(Capability::PatchBack)
        }));
        assert!(
            report
                .failures
                .iter()
                .all(AdapterFailure::is_preflight_blocking)
        );
    }
}

#[test]
fn asset_inventory_rejects_engine_specific_source_location_fields() {
    let manifest = AssetInventoryManifest {
        schema_version: ASSET_INVENTORY_SCHEMA_VERSION.to_string(),
        manifest_id: deterministic_id("asset-inventory", 1),
        adapter_id: "kaifuu.fixture".to_string(),
        source_locale: "ja-JP".to_string(),
        assets: vec![AssetInventoryAsset {
            asset_id: "asset-image-sign".to_string(),
            asset_key: "image/sign".to_string(),
            asset_kind: AssetInventoryAssetKind::Image,
            path: Some("images/sign.png".to_string()),
            source_hash: Some(content_hash("image/sign")),
            metadata: BTreeMap::new(),
        }],
        surfaces: vec![AssetInventorySurface {
            surface_id: "surface-image-sign-text".to_string(),
            asset_surface_kind: AssetInventorySurfaceKind::ImageText,
            source_asset_ref: AssetInventoryAssetRef {
                asset_id: "asset-image-sign".to_string(),
                asset_key: Some("image/sign".to_string()),
            },
            source_location: Some(serde_json::json!({
                "containerKey": "image/sign",
                "rpgMakerEventId": 12
            })),
            source_text: Some("注意".to_string()),
            source_hash: Some(content_hash("注意")),
            text_source_kind: AssetInventoryTextSourceKind::ManualTranscription,
            patch_mode: AssetInventoryPatchMode::RegionRedrawRequired,
            patching: CapabilityReport::unsupported(
                Capability::AssetTextPatching,
                "test adapter does not patch image assets",
            ),
            patch_payload: None,
            metadata_hash: None,
            notes: vec![],
        }],
        capabilities: vec![CapabilityReport::supported(Capability::AssetInventory)],
        warnings: vec![],
        metadata: BTreeMap::new(),
    };

    let validation = manifest.validate();

    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(validation.failures.iter().any(|failure| {
        failure.code == "engine_specific_source_location"
            && failure.field == "surfaces.0.sourceLocation.rpgMakerEventId"
    }));
}

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

/// P1: an undetected adapter that supplies `detected_variant`
/// without overriding [`EngineAdapter::is_diagnostic_candidate`] must not
/// become a diagnostic candidate, and profile/inventory must never run.
#[test]
fn diagnostic_candidate_requires_adapter_opt_in_not_variant_presence() {
    struct VariantOnlyAdapter {
        profile_calls: Arc<AtomicUsize>,
        inventory_calls: Arc<AtomicUsize>,
    }

    impl EngineAdapter for VariantOnlyAdapter {
        fn id(&self) -> &'static str {
            "kaifuu.test.variant-only-no-opt-in"
        }

        fn name(&self) -> &'static str {
            "Variant-only adapter without diagnostic opt-in"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(self.id(), vec![], derived_matrix_for(self.id(), &[]))
        }

        fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            Ok(DetectionResult {
                adapter_id: self.id().to_string(),
                detected: false,
                engine_family: Some("decoy".to_string()),
                engine_version: None,
                // Descriptive variant alone must NOT grant diagnostic routing.
                detected_variant: Some("looks-like-mine".to_string()),
                evidence: vec![DetectionEvidence {
                    path: "decoy.marker".to_string(),
                    kind: "variant_only_marker".to_string(),
                    status: EvidenceStatus::Matched,
                    detail: "undetected adapter with a variant string".to_string(),
                }],
                requirements: vec![],
                capabilities: vec![],
            })
        }

        // Default is_diagnostic_candidate → false (no opt-in).

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            self.profile_calls.fetch_add(1, Ordering::SeqCst);
            panic!("profile must not run for non-opted-in diagnostic candidates");
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            unreachable!("list_assets must not run")
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            self.inventory_calls.fetch_add(1, Ordering::SeqCst);
            panic!("asset_inventory must not run for non-opted-in diagnostic candidates");
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            unreachable!("extract must not run")
        }

        fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            unreachable!("patch must not run")
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            unreachable!("verify must not run")
        }
    }

    let profile_calls = Arc::new(AtomicUsize::new(0));
    let inventory_calls = Arc::new(AtomicUsize::new(0));
    let mut registry = AdapterRegistry::new();
    registry.register(VariantOnlyAdapter {
        profile_calls: Arc::clone(&profile_calls),
        inventory_calls: Arc::clone(&inventory_calls),
    });

    let detections = registry
        .detect_all(Path::new("/tmp/kaifuu-156-variant-only"))
        .expect("detect_all");
    assert_eq!(detections.len(), 1);
    assert!(!detections[0].detected);
    assert_eq!(
        detections[0].detected_variant.as_deref(),
        Some("looks-like-mine")
    );

    // Selection must refuse: variant presence is not opt-in.
    assert!(
        registry
            .diagnostic_candidate_from_results(&detections)
            .is_none(),
        "undetected adapter with detected_variant but no opt-in must stay off the diagnostic path"
    );
    assert!(
        registry
            .diagnostic_candidate(Path::new("/tmp/kaifuu-156-variant-only"))
            .expect("diagnostic_candidate")
            .is_none()
    );

    // Never invoke profile/inventory just because a variant string appeared.
    assert_eq!(profile_calls.load(Ordering::SeqCst), 0);
    assert_eq!(inventory_calls.load(Ordering::SeqCst), 0);
}

/// adapters that opt in via `is_diagnostic_candidate` are
/// selectable even when `detected` is false.
#[test]
fn diagnostic_candidate_selects_opted_in_adapter() {
    struct OptInDiagnosticAdapter;

    impl EngineAdapter for OptInDiagnosticAdapter {
        fn id(&self) -> &'static str {
            "kaifuu.test.diagnostic-opt-in"
        }

        fn name(&self) -> &'static str {
            "Opted-in diagnostic adapter"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(self.id(), vec![], derived_matrix_for(self.id(), &[]))
        }

        fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            Ok(DetectionResult {
                adapter_id: self.id().to_string(),
                detected: false,
                engine_family: None,
                engine_version: None,
                detected_variant: Some("partial-pair".to_string()),
                evidence: vec![DetectionEvidence {
                    path: "partial.marker".to_string(),
                    kind: "diagnostic_marker".to_string(),
                    status: EvidenceStatus::Matched,
                    detail: "recognized incomplete fixture".to_string(),
                }],
                requirements: vec![],
                capabilities: vec![],
            })
        }

        fn is_diagnostic_candidate(&self, detection: &DetectionResult) -> bool {
            !detection.detected && detection.detected_variant.as_deref() == Some("partial-pair")
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
    registry.register(OptInDiagnosticAdapter);
    let candidate = registry
        .diagnostic_candidate(Path::new("/tmp/kaifuu-156-opt-in"))
        .expect("diagnostic_candidate")
        .expect("opted-in adapter must be selected");
    assert_eq!(candidate.adapter_id, "kaifuu.test.diagnostic-opt-in");
    assert!(!candidate.detected);
    assert_eq!(candidate.detected_variant.as_deref(), Some("partial-pair"));
}

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

#[test]
fn xp3_profile_proof_report_carries_fixture_metadata_and_redacts_secrets() {
    // Acceptance criterion: "The proof report includes fixture id,
    // profile id, archive hash, crypt profile status, helper requirement,
    // and semantic remediation."
    let dir = temp_dir("xp3-profile-proof-metadata");
    write_xp3_archive(&dir, "plain.xp3", &build_plain_xp3_archive_bytes());
    write_xp3_archive(
        &dir,
        "encrypted.xp3",
        &build_encrypted_xp3_marker_archive_bytes(),
    );

    let plain_report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &make_plain_fixture("plain.xp3"),
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(
        plain_report.fixture_id,
        "kaifuu-kirikiri-xp3-plain-profile-proof"
    );
    assert_eq!(
        plain_report.profile_id,
        "019ed000-0000-7000-8000-000000095001"
    );
    assert_eq!(plain_report.archive.archive_id, "kirikiri-xp3-archive");
    assert!(
        plain_report
            .archive
            .archive_hash
            .as_str()
            .starts_with("sha256:")
    );
    assert_eq!(plain_report.semantic_remediation, None);
    assert_eq!(
        plain_report.support_boundary,
        XP3_PROFILE_PROOF_SUPPORT_BOUNDARY
    );
    assert_ne!(
        plain_report.redacted_for_report().support_boundary,
        format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")
    );
    assert_eq!(
        plain_report.redacted_for_report().support_boundary,
        XP3_PROFILE_PROOF_SUPPORT_BOUNDARY
    );
    let plain_json = plain_report.stable_json().unwrap();
    assert!(
        plain_json.contains(XP3_PROFILE_PROOF_SUPPORT_BOUNDARY),
        "supportBoundary must remain readable in proof JSON: {plain_json}"
    );
    assert!(
        !plain_json.contains("\"supportBoundary\":\"[REDACTED:kaifuu.secret_redacted]\""),
        "supportBoundary was over-redacted in proof JSON: {plain_json}"
    );

    let encrypted_report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &make_encrypted_fixture("encrypted.xp3"),
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(
        encrypted_report.crypt_profile.status,
        Xp3CryptProfileStatus::Satisfied
    );
    assert_eq!(
        encrypted_report.crypt_profile.requirement_id.as_deref(),
        Some("kirikiri-xp3-key-profile")
    );
    assert!(encrypted_report.semantic_remediation.is_some());

    // Redaction surface: stable_json round-trips through redaction.
    let json = encrypted_report.stable_json().unwrap();
    // The fixture-only secret-ref label is safe to surface, but raw
    // key material patterns must not appear. Make sure no absolute
    // host paths or hex secrets leaked into the report.
    assert!(
        !json.contains("/home/"),
        "report leaked absolute host path: {json}"
    );
    assert!(!json.contains("C:\\"), "report leaked drive path: {json}");
}

#[test]
fn xp3_profile_proof_rejects_leaked_archive_paths_before_extract_claims() {
    // Acceptance criterion: "Private archive paths, raw keys, and
    // decrypted text cannot appear in the report." plus "Unsupported
    // cases fail before extract or patch claims are made."
    let dir = temp_dir("xp3-profile-proof-leaked-paths");
    write_xp3_archive(&dir, "plain.xp3", &build_plain_xp3_archive_bytes());

    for leaked_path in [
        "/home/local-user/private/data.xp3",
        "C:\\Users\\local-user\\private\\data.xp3",
        "../../../etc/passwd",
        "~/secret/data.xp3",
        "$HOME/secret/data.xp3",
    ] {
        let mut fixture = make_plain_fixture("plain.xp3");
        fixture.archive.path = leaked_path.to_string();
        let report = xp3_profile_proof(Xp3ProfileProofRequest {
            fixture: &fixture,
            fixture_dir: &dir,
        })
        .unwrap();
        assert_eq!(
            report.status,
            OperationStatus::Failed,
            "leaked path {leaked_path} must fail"
        );
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "xp3.archive_path.leaked"),
            "leaked path {leaked_path} must fire xp3.archive_path.leaked"
        );
        // The declared_path field is scrubbed of the leaked text.
        assert!(
            !report.archive.declared_path.contains(leaked_path),
            "leaked path {leaked_path} survived into report: {}",
            report.archive.declared_path
        );
        // Patch capability is never elevated past unsupported when
        // the path was rejected.
        let stable_json = report.stable_json().unwrap();
        assert!(
            !stable_json.contains(leaked_path),
            "leaked path {leaked_path} survived into stable_json: {stable_json}"
        );
    }
}

#[test]
fn xp3_profile_proof_overclaim_diagnostic_names_real_capability_rule() {
    // Non-plain XP3 variants are routing diagnostics only; even a
    // profiled encrypted fixture cannot claim extract or patch_back.
    let dir = temp_dir("xp3-profile-proof-overclaim-message");
    write_xp3_archive(
        &dir,
        "encrypted.xp3",
        &build_encrypted_xp3_marker_archive_bytes(),
    );
    let mut fixture = make_encrypted_fixture("encrypted.xp3");
    fixture.patch_capability_level = Xp3PatchCapabilityLevel::PatchBack;

    let report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();

    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.classification, Xp3ProfileClassification::Encrypted);
    assert_eq!(
        report.patch_capability_level,
        Xp3PatchCapabilityLevel::Unsupported
    );
    assert_eq!(
        report.crypt_profile.status,
        Xp3CryptProfileStatus::Satisfied
    );

    let expected_message = "fixture declared patch_back; XP3 profile proof permits extract and patch_back capability claims only for plain XP3, while encrypted, compressed, helper_required, and unsupported_protected_executable fixtures must set patchCapabilityLevel to unsupported";
    let diagnostic = xp3_profile_diagnostic(&report, "xp3.patch_capability.overclaim");
    assert_eq!(diagnostic.severity, PartialDiagnosticSeverity::P0);
    assert_eq!(diagnostic.field, "patchCapabilityLevel");
    assert_eq!(diagnostic.message, expected_message);
    assert_eq!(
        diagnostic.semantic_code.as_deref(),
        Some(SEMANTIC_MISSING_PATCH_BACK_CAPABILITY)
    );
    assert_eq!(
        diagnostic.remediation.as_deref(),
        Some(
            "set patchCapabilityLevel to \"unsupported\" for encrypted, compressed, helper_required, and unsupported_protected_executable XP3 fixtures"
        )
    );

    let redacted = report.redacted_for_report();
    assert_eq!(
        xp3_profile_diagnostic(&redacted, "xp3.patch_capability.overclaim").message,
        expected_message
    );
    let stable_json = report.stable_json().unwrap();
    assert!(stable_json.contains(expected_message));
    assert!(!stable_json.contains("\"message\":\"[REDACTED:kaifuu.secret_redacted]\""));
}

#[test]
fn xp3_profile_proof_missing_crypt_profile_fails_closed() {
    // Negative fixture: encrypted classification without a
    // crypt_profile entry → P0 missing-crypt-profile diagnostic.
    let dir = temp_dir("xp3-profile-proof-missing-crypt");
    write_xp3_archive(
        &dir,
        "encrypted.xp3",
        &build_encrypted_xp3_marker_archive_bytes(),
    );
    let mut fixture = make_encrypted_fixture("encrypted.xp3");
    fixture.crypt_profile = None;
    let report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.classification, Xp3ProfileClassification::Encrypted);
    assert_eq!(report.crypt_profile.status, Xp3CryptProfileStatus::Missing);
    let expected_message = "encrypted XP3 fixtures must declare cryptProfile with cryptProfileId and keyRefRequirement; the crypt profile records routing metadata only and does not claim decryption, extraction, or patch_back support";
    let diagnostic = xp3_profile_diagnostic(&report, "xp3.crypt_profile.missing");
    assert_eq!(diagnostic.severity, PartialDiagnosticSeverity::P0);
    assert_eq!(diagnostic.field, "cryptProfile");
    assert_eq!(diagnostic.message, expected_message);
    assert_eq!(
        diagnostic.semantic_code.as_deref(),
        Some(SEMANTIC_MISSING_KEY_PROFILE)
    );
    assert_eq!(
        diagnostic.remediation.as_deref(),
        Some(
            "add cryptProfile with cryptProfileId and keyRefRequirement for encrypted or helper_required XP3 fixtures"
        )
    );
    assert_eq!(
        report.patch_capability_level,
        Xp3PatchCapabilityLevel::Unsupported
    );

    let redacted = report.redacted_for_report();
    assert_eq!(
        xp3_profile_diagnostic(&redacted, "xp3.crypt_profile.missing").message,
        expected_message
    );
    let stable_json = report.stable_json().unwrap();
    assert!(stable_json.contains(expected_message));
    assert!(!stable_json.contains("\"message\":\"[REDACTED:kaifuu.secret_redacted]\""));
}

#[test]
fn xp3_profile_proof_unknown_encryption_plugin_fails_closed() {
    // Negative fixture: crypt_profile_id not in
    // XP3_RECOGNIZED_CRYPT_PROFILE_IDS → P0 unknown-plugin diagnostic.
    let dir = temp_dir("xp3-profile-proof-unknown-plugin");
    write_xp3_archive(
        &dir,
        "encrypted.xp3",
        &build_encrypted_xp3_marker_archive_bytes(),
    );
    let mut fixture = make_encrypted_fixture("encrypted.xp3");
    fixture.crypt_profile = Some(Xp3ProfileProofFixtureCryptProfile {
        crypt_profile_id: "kirikiri-xp3-unrecognized-encryption-plugin".to_string(),
        key_ref_requirement: Some(Xp3ProfileProofFixtureKeyRefRequirement {
            requirement_id: "kirikiri-xp3-key-profile".to_string(),
            secret_ref: SecretRef::new(
                "local-secret:fixture/kirikiri/xp3-archive-password".to_string(),
            )
            .unwrap(),
        }),
    });
    let report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(
        report.crypt_profile.status,
        Xp3CryptProfileStatus::UnknownPlugin
    );
    assert!(
        report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "xp3.crypt_profile.unknown_plugin")
    );
}

#[test]
fn xp3_profile_proof_byte_classification_mismatch_routes_by_bytes() {
    // A fixture that *declares* plain but supplies encrypted bytes
    // must be routed by the bytes (encrypted), never trusted into
    // a plain-patch claim. This protects the no-extract-claim
    // invariant against fixture-level under-classification.
    let dir = temp_dir("xp3-profile-proof-mismatch");
    write_xp3_archive(
        &dir,
        "fake-plain.xp3",
        &build_encrypted_xp3_marker_archive_bytes(),
    );
    let fixture = make_plain_fixture("fake-plain.xp3");
    let report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.classification, Xp3ProfileClassification::Encrypted);
    assert_eq!(
        report.patch_capability_level,
        Xp3PatchCapabilityLevel::Unsupported
    );
    assert!(
        report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "xp3.classification.mismatch")
    );
}

fn write_encrypted_media_system_json(
    game_dir: &Path,
    has_encrypted_images: bool,
    has_encrypted_audio: bool,
    key: Option<&str>,
) {
    let data_dir = game_dir.join("data");
    fs::create_dir_all(&data_dir).unwrap();
    let body = match key {
        Some(key) => format!(
            "{{\"hasEncryptedImages\":{has_encrypted_images},\"hasEncryptedAudio\":{has_encrypted_audio},\"encryptionKey\":\"{key}\"}}"
        ),
        None => format!(
            "{{\"hasEncryptedImages\":{has_encrypted_images},\"hasEncryptedAudio\":{has_encrypted_audio}}}"
        ),
    };
    fs::write(data_dir.join("System.json"), body).unwrap();
}

fn write_encrypted_media_asset(game_dir: &Path, relative: &str, bytes: &[u8]) {
    let full = game_dir.join(relative);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(&full, bytes).unwrap();
}

fn encrypted_media_with_rpgmv_header(extra: &[u8]) -> Vec<u8> {
    let mut bytes = RPGMAKER_MV_ENCRYPTED_MEDIA_HEADER.to_vec();
    bytes.extend_from_slice(extra);
    bytes
}

fn happy_path_encrypted_media_fixture() -> EncryptedMediaProofFixture {
    EncryptedMediaProofFixture {
        schema_version: ENCRYPTED_MEDIA_PROOF_SCHEMA_VERSION.to_string(),
        fixture_id: "kaifuu-rpgmaker-encrypted-media-readiness-synthetic".to_string(),
        profile_id: "019ed000-0000-7000-8000-000000039001".to_string(),
        game_dir: "game".to_string(),
        assets: vec![
            EncryptedMediaProofFixtureAsset {
                asset_id: "title-mv".to_string(),
                path: "img/pictures/title.rpgmvp".to_string(),
                expected_kind: EncryptedMediaAssetKind::Image,
                expected_classification: EncryptedMediaClassification::Encrypted,
            },
            EncryptedMediaProofFixtureAsset {
                asset_id: "theme-mv".to_string(),
                path: "audio/bgm/theme.rpgmvm".to_string(),
                expected_kind: EncryptedMediaAssetKind::Audio,
                expected_classification: EncryptedMediaClassification::Encrypted,
            },
            EncryptedMediaProofFixtureAsset {
                asset_id: "cutscene-video-mv".to_string(),
                path: "movies/cutscene.rpgmvu".to_string(),
                expected_kind: EncryptedMediaAssetKind::Video,
                expected_classification: EncryptedMediaClassification::Encrypted,
            },
            EncryptedMediaProofFixtureAsset {
                asset_id: "portrait-mz".to_string(),
                path: "img/pictures/portrait.png_".to_string(),
                expected_kind: EncryptedMediaAssetKind::Image,
                expected_classification: EncryptedMediaClassification::Encrypted,
            },
            EncryptedMediaProofFixtureAsset {
                asset_id: "opening-video-plain".to_string(),
                path: "movies/opening.webm".to_string(),
                expected_kind: EncryptedMediaAssetKind::Video,
                expected_classification: EncryptedMediaClassification::Plaintext,
            },
        ],
        key_profile: Some(EncryptedMediaProofFixtureKeyProfile {
            profile_id: "rpg-maker-mv-mz-asset-key".to_string(),
            expected_system_json_key_hash: Some(
                ProofHash::new(
                    "sha256:5947d7c33d783f94b3b4c1a96ebc8991ed28f1b069b71e03376cba8caa98a720",
                )
                .unwrap(),
            ),
            key_ref_requirement: Some(EncryptedMediaProofFixtureKeyRefRequirement {
                requirement_id: "rpg-maker-mv-mz-asset-key".to_string(),
                secret_ref: SecretRef::new(
                    "local-secret:fixture/rpgmaker/mv-mz-asset-key".to_string(),
                )
                .unwrap(),
            }),
        }),
    }
}

fn stage_happy_path_encrypted_media_tree(dir: &Path) {
    let game = dir.join("game");
    write_encrypted_media_system_json(&game, true, true, Some("00112233445566778899aabbccddeeff"));
    write_encrypted_media_asset(
        &game,
        "img/pictures/title.rpgmvp",
        &encrypted_media_with_rpgmv_header(b"img-payload"),
    );
    write_encrypted_media_asset(
        &game,
        "audio/bgm/theme.rpgmvm",
        &encrypted_media_with_rpgmv_header(b"audio-payload"),
    );
    write_encrypted_media_asset(
        &game,
        "movies/cutscene.rpgmvu",
        &encrypted_media_with_rpgmv_header(b"video-payload"),
    );
    write_encrypted_media_asset(
        &game,
        "img/pictures/portrait.png_",
        &encrypted_media_with_rpgmv_header(b"mz-img"),
    );
    write_encrypted_media_asset(&game, "movies/opening.webm", b"synthetic-webm-bytes");
}

#[test]
fn encrypted_media_proof_routes_each_asset_kind_with_distinct_capability_levels() {
    // Acceptance criterion: "Encrypted image, audio, and video media
    // variants are detected with exact asset-kind capability levels."
    let dir = temp_dir("encrypted-media-distinct-kinds");
    stage_happy_path_encrypted_media_tree(&dir);

    let fixture = happy_path_encrypted_media_fixture();
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.status, OperationStatus::Passed);
    assert_eq!(report.readiness, EncryptedMediaReadiness::Ready);
    // Patch capability never claims `patch_back` or `extract` for any
    // asset — every encrypted asset is `Unsupported`, the aggregate
    // settles at `Unsupported`.
    assert_eq!(
        report.patch_capability_level,
        EncryptedMediaPatchCapability::Unsupported
    );
    // Per-asset kinds + capabilities are distinct.
    let kinds: Vec<EncryptedMediaAssetKind> =
        report.assets.iter().map(|asset| asset.kind).collect();
    assert_eq!(
        kinds,
        vec![
            EncryptedMediaAssetKind::Image,
            EncryptedMediaAssetKind::Audio,
            EncryptedMediaAssetKind::Video,
            EncryptedMediaAssetKind::Image,
            EncryptedMediaAssetKind::Video,
        ]
    );
    let encrypted_assets: Vec<&EncryptedMediaProofAsset> = report
        .assets
        .iter()
        .filter(|asset| asset.classification == EncryptedMediaClassification::Encrypted)
        .collect();
    assert_eq!(encrypted_assets.len(), 4);
    for asset in &encrypted_assets {
        assert_eq!(
            asset.patch_capability_level,
            EncryptedMediaPatchCapability::Unsupported,
            "encrypted asset {} must not claim patch capability",
            asset.asset_id
        );
        assert_eq!(
            asset.decryptability,
            EncryptedMediaDecryptability::KeyProfileSatisfied
        );
        assert_eq!(asset.readiness, EncryptedMediaReadiness::Ready);
    }
    // Plaintext video surfaces as evidence only.
    let video = report
        .assets
        .iter()
        .find(|asset| asset.asset_id == "opening-video-plain")
        .unwrap();
    assert_eq!(
        video.classification,
        EncryptedMediaClassification::Plaintext
    );
    assert_eq!(
        video.patch_capability_level,
        EncryptedMediaPatchCapability::NotClaimed
    );
    assert_eq!(video.readiness, EncryptedMediaReadiness::PlaintextEvidence);
    // Load-bearing claims: media-key detection never implies dialogue
    // extraction or script-patch support, and decrypted bytes are
    // never persisted.
    assert!(!report.script_capability_claimed);
    assert!(!report.decrypted_bytes_persisted);
}

#[test]
fn encrypted_media_proof_carries_metadata_and_redacts_secret_payloads() {
    let dir = temp_dir("encrypted-media-metadata");
    stage_happy_path_encrypted_media_tree(&dir);

    let fixture = happy_path_encrypted_media_fixture();
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(
        report.fixture_id,
        "kaifuu-rpgmaker-encrypted-media-readiness-synthetic"
    );
    assert_eq!(report.profile_id, "019ed000-0000-7000-8000-000000039001");
    // System.json proof hash present + asset evidence hashes present.
    assert!(
        report
            .key_profile
            .system_json_proof_hash
            .as_ref()
            .is_some_and(|hash| hash.as_str().starts_with("sha256:"))
    );
    for asset in &report.assets {
        assert!(asset.asset_evidence_hash.as_str().starts_with("sha256:"));
    }
    // Stable JSON serialization round-trips and never echoes the raw
    // System.json key value (the proof hash is fine; the key bytes
    // are not).
    let json = report.stable_json().unwrap();
    assert!(
        !json.contains("00112233445566778899aabbccddeeff"),
        "raw System.json key must not appear in the report",
    );
    // The system_json_present + key_well_formed flags reflect the
    // happy-path setup.
    assert!(report.key_profile.system_json_present);
    assert!(report.key_profile.system_json_key_present);
    assert!(report.key_profile.system_json_key_well_formed);
    assert_eq!(report.key_profile.has_encrypted_images_flag, Some(true));
    assert_eq!(report.key_profile.has_encrypted_audio_flag, Some(true));
}

#[test]
fn encrypted_media_proof_rejects_leaked_game_dir_before_decryption_claim() {
    // Acceptance criterion: "Public fixtures use synthetic media and
    // public test keys only" + "raw key leakage" negative coverage.
    let dir = temp_dir("encrypted-media-leaked-game-dir");
    let mut fixture = happy_path_encrypted_media_fixture();
    fixture.game_dir = "/home/local-user/private/rpgmaker-mv-mz".to_string();
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.readiness, EncryptedMediaReadiness::Unsupported);
    assert!(report.diagnostics.iter().any(|diagnostic| diagnostic.code
        == "rpgmaker.encrypted_media.game_dir.leaked"
        && diagnostic.semantic_code.as_deref() == Some(SEMANTIC_FORBIDDEN_PUBLIC_SERIALIZATION)));
    // The leaked absolute path is **never** echoed into the report —
    // verify the redacted JSON does not contain the private prefix.
    let json = report.stable_json().unwrap();
    assert!(
        !json.contains("/home/local-user"),
        "leaked absolute path survived into the report: {json}",
    );
}

#[test]
fn encrypted_media_proof_missing_system_json_key_fails_before_decryption_claim() {
    // Acceptance criterion: "Missing or wrong keys return semantic
    // diagnostics before decrypted bytes are persisted."
    let dir = temp_dir("encrypted-media-missing-key");
    let game = dir.join("game");
    write_encrypted_media_system_json(&game, true, true, None);
    write_encrypted_media_asset(
        &game,
        "img/pictures/title.rpgmvp",
        &encrypted_media_with_rpgmv_header(b"img-payload"),
    );

    let mut fixture = happy_path_encrypted_media_fixture();
    fixture.assets.truncate(1);
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.diagnostics.iter().any(|diagnostic| diagnostic.code
        == "rpgmaker.encrypted_media.system_json.key_missing"
        && diagnostic.semantic_code.as_deref() == Some(SEMANTIC_MISSING_KEY_MATERIAL)));
    assert!(!report.decrypted_bytes_persisted);
    assert!(!report.script_capability_claimed);
}

#[test]
fn encrypted_media_proof_malformed_key_fails_before_decryption_claim() {
    // Acceptance criterion: "Missing or wrong keys return semantic
    // diagnostics before decrypted bytes are persisted." A
    // malformed-shape key is the canonical "wrong key" surface.
    let dir = temp_dir("encrypted-media-malformed-key");
    let game = dir.join("game");
    write_encrypted_media_system_json(&game, true, true, Some("not-a-valid-hex-key"));
    write_encrypted_media_asset(
        &game,
        "img/pictures/title.rpgmvp",
        &encrypted_media_with_rpgmv_header(b"img-payload"),
    );

    let mut fixture = happy_path_encrypted_media_fixture();
    fixture.assets.truncate(1);
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.diagnostics.iter().any(|diagnostic| diagnostic.code
        == "rpgmaker.encrypted_media.system_json.key_malformed"
        && diagnostic.semantic_code.as_deref() == Some(SEMANTIC_KEY_VALIDATION_FAILED)));
    assert!(!report.decrypted_bytes_persisted);
}

#[test]
fn encrypted_media_proof_wrong_well_formed_key_fails_before_decryption_claim() {
    // A wrong-but-well-formed 32-hex System.json key must fail as
    // key-validation mismatch, not as malformed input. The proof compares
    // hash-only fixture evidence and still never decrypts.
    let dir = temp_dir("encrypted-media-wrong-key");
    let game = dir.join("game");
    write_encrypted_media_system_json(&game, true, true, Some("ffeeddccbbaa99887766554433221100"));
    write_encrypted_media_asset(
        &game,
        "img/pictures/title.rpgmvp",
        &encrypted_media_with_rpgmv_header(b"img-payload"),
    );

    let mut fixture = happy_path_encrypted_media_fixture();
    fixture.assets.truncate(1);
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.diagnostics.iter().any(|diagnostic| diagnostic.code
        == "rpgmaker.encrypted_media.system_json.key_mismatch"
        && diagnostic.semantic_code.as_deref() == Some(SEMANTIC_KEY_VALIDATION_FAILED)));
    assert_eq!(
        report.assets[0].decryptability,
        EncryptedMediaDecryptability::KeyMismatch
    );
    assert!(!report.decrypted_bytes_persisted);
    assert!(!report.script_capability_claimed);
}

#[test]
fn encrypted_media_proof_malformed_header_routes_to_unsupported_without_overclaim() {
    // Negative coverage: encrypted asset is declared but the bytes do
    // not start with the RPGMV header magic. Must route to
    // `MalformedHeader` + `Unsupported` and never silently upgrade
    // to `Encrypted`.
    let dir = temp_dir("encrypted-media-malformed-header");
    let game = dir.join("game");
    write_encrypted_media_system_json(&game, true, true, Some("00112233445566778899aabbccddeeff"));
    write_encrypted_media_asset(
        &game,
        "img/pictures/malformed.rpgmvp",
        b"NOT-A-RPGMV-HEADER",
    );

    let mut fixture = happy_path_encrypted_media_fixture();
    fixture.assets = vec![EncryptedMediaProofFixtureAsset {
        asset_id: "malformed".to_string(),
        path: "img/pictures/malformed.rpgmvp".to_string(),
        expected_kind: EncryptedMediaAssetKind::Image,
        expected_classification: EncryptedMediaClassification::Encrypted,
    }];
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(
        report.assets[0].classification,
        EncryptedMediaClassification::MalformedHeader
    );
    assert_eq!(
        report.assets[0].patch_capability_level,
        EncryptedMediaPatchCapability::Unsupported
    );
    assert!(
        report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "rpgmaker.encrypted_media.header.malformed")
    );
}

#[test]
fn encrypted_media_proof_unknown_key_profile_fails_closed() {
    // The recognised vocabulary check is routing-only — recognition
    // does not imply decryption capability. Unknown profile id must
    // fire a P0 diagnostic so a fixture-author cannot wedge an
    // arbitrary plugin id into the proof.
    let dir = temp_dir("encrypted-media-unknown-profile");
    stage_happy_path_encrypted_media_tree(&dir);

    let mut fixture = happy_path_encrypted_media_fixture();
    if let Some(profile) = fixture.key_profile.as_mut() {
        profile.profile_id = "not-a-recognised-profile-id".to_string();
    }
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.diagnostics.iter().any(|diagnostic| diagnostic.code
        == "rpgmaker.encrypted_media.key_profile.unknown"
        && diagnostic.semantic_code.as_deref() == Some(SEMANTIC_UNKNOWN_ENGINE_VARIANT)));
}

#[test]
fn encrypted_media_proof_byte_classification_overrides_fixture_declaration() {
    // A fixture that declares plaintext but ships RPGMV-headered bytes
    // must be routed by the bytes (encrypted), not silently trusted
    // as plaintext.
    let dir = temp_dir("encrypted-media-byte-routing");
    let game = dir.join("game");
    write_encrypted_media_system_json(&game, true, true, Some("00112233445566778899aabbccddeeff"));
    // Plaintext-suffix asset with RPGMV bytes — bytes win.
    write_encrypted_media_asset(
        &game,
        "img/pictures/title.png",
        &encrypted_media_with_rpgmv_header(b"sneaky"),
    );

    let mut fixture = happy_path_encrypted_media_fixture();
    fixture.assets = vec![EncryptedMediaProofFixtureAsset {
        asset_id: "sneaky-plain".to_string(),
        path: "img/pictures/title.png".to_string(),
        expected_kind: EncryptedMediaAssetKind::Image,
        expected_classification: EncryptedMediaClassification::Plaintext,
    }];
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    // Suffix is.png (plaintext suffix) so the routing settles at
    // Plaintext — the bytes-classification doesn't override a
    // plaintext-suffix declaration with no encrypted suffix profile;
    // however, since the suffix is plain the resulting classification
    // is still Plaintext but the readiness reports must not assume
    // anything decryptable. This is the "no script capability"
    // separation.
    assert_eq!(
        report.assets[0].classification,
        EncryptedMediaClassification::Plaintext
    );
    assert!(!report.script_capability_claimed);
    assert!(!report.decrypted_bytes_persisted);
    assert_eq!(
        report.assets[0].patch_capability_level,
        EncryptedMediaPatchCapability::NotClaimed
    );
}

#[test]
fn encrypted_media_proof_redacted_view_strips_secret_substrings() {
    let dir = temp_dir("encrypted-media-redacted");
    stage_happy_path_encrypted_media_tree(&dir);

    let fixture = happy_path_encrypted_media_fixture();
    let report = encrypted_media_proof(EncryptedMediaProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    let redacted = report.redacted_for_report();
    // Acceptance criterion: "Public fixtures use synthetic media and
    // public test keys only" — the raw key value must never appear
    // in the redacted JSON either.
    let json = redacted.stable_json().unwrap();
    assert!(!json.contains("00112233445566778899aabbccddeeff"));
    // Load-bearing flags survive redaction.
    assert!(!redacted.script_capability_claimed);
    assert!(!redacted.decrypted_bytes_persisted);
}

// hash-to-exec TOCTOU: validated bytes bound to execution
// through a trusted staging copy.

/// A registry entry whose single allowlist entry pins `registered_hash` for
/// a `helper-bin`-named helper (fixture-any platform, version 0.1.0,
/// FixtureInvocation capability).
fn staging_launch_entry(registered_hash: &str) -> HelperRegistryEntry {
    let mut entry = FixtureHelperStubAdapter::registry_entry();
    let allowlist_entry = &mut entry.binary_allowlist.entries[0];
    allowlist_entry.sha256_hash = registered_hash.to_string();
    allowlist_entry.executable_name = "helper-bin".to_string();
    entry
}

fn launch_request<'a>(
    entry: &'a HelperRegistryEntry,
    source: &'a Path,
    required: &'a [HelperCapability],
) -> HelperBinaryLaunchValidationRequest<'a> {
    HelperBinaryLaunchValidationRequest {
        helper_id: &entry.helper_id,
        allowlist_entry_id: FIXTURE_HELPER_ALLOWLIST_REF_ID,
        executable_path: source,
        platform: "fixture-any",
        helper_version: "0.1.0",
        required_capabilities: required,
    }
}

#[test]
fn helper_launch_binds_validated_bytes_via_trusted_staging_copy_defeats_swap() {
    let src_dir = tempfile::tempdir().unwrap();
    let staging_dir = tempfile::tempdir().unwrap();
    let source = src_dir.path().join("helper-bin");

    let original = b"ORIGINAL-VALIDATED-HELPER-BYTES\n";
    fs::write(&source, original).unwrap();
    let original_hash = sha256_hash_bytes(original);

    let entry = staging_launch_entry(&original_hash);
    let required = [HelperCapability::FixtureInvocation];
    let outcome = entry.stage_and_validate_binary_launch(
        launch_request(&entry, &source, &required),
        staging_dir.path(),
    );

    assert!(
        outcome.passed(),
        "validation should pass: {:?}",
        outcome.validation.diagnostics
    );
    let staged = outcome
        .staged
        .as_ref()
        .expect("passed launch must bind a staged execution reference");
    // The validated hash is of the STAGED bytes and equals the original.
    assert_eq!(staged.staged_hash(), original_hash);
    // The execution target is the trusted staged copy, NOT the source.
    assert_ne!(staged.staged_path(), source.as_path());
    assert!(staged.staged_path().starts_with(staging_dir.path()));

    // Swap the source binary AFTER validation with attacker-chosen bytes.
    let swapped = b"SWAPPED-EVIL-HELPER-BYTES-THAT-MUST-NEVER-RUN\n";
    fs::write(&source, swapped).unwrap();
    let swapped_hash = sha256_hash_bytes(swapped);
    assert_ne!(original_hash, swapped_hash);

    // What would execute (the staged copy) is UNCHANGED by the swap.
    let staged_bytes = fs::read(staged.staged_path()).unwrap();
    assert_eq!(staged_bytes.as_slice(), original);
    assert_eq!(sha256_hash_bytes(&staged_bytes), original_hash);

    // Mutation proof: the OLD hash-then-exec-path approach re-opened the
    // mutable source at launch — which now hashes to the SWAPPED bytes, i.e.
    // it would run the attacker binary. The staging copy defeats exactly
    // this.
    let source_hash_at_launch = sha256_file_ref(&source).unwrap();
    assert_eq!(
        source_hash_at_launch, swapped_hash,
        "re-hashing the mutable source at launch yields the swapped bytes (the TOCTOU the staging copy defeats)"
    );
    assert_ne!(
        source_hash_at_launch, original_hash,
        "the source path no longer holds the validated bytes after the swap"
    );

    // On Unix the held execution descriptor still reads the validated bytes.
    #[cfg(unix)]
    {
        use std::io::Read as _;
        use std::os::fd::AsFd;
        let dup = staged.execution_fd().try_clone_to_owned().unwrap();
        let mut file = std::fs::File::from(dup);
        let _ = file.as_fd();
        let mut via_fd = Vec::new();
        file.read_to_end(&mut via_fd).unwrap();
        assert_eq!(via_fd.as_slice(), original);
    }
}

#[test]
fn helper_launch_detects_staged_hash_tamper_with_typed_error() {
    let src_dir = tempfile::tempdir().unwrap();
    let staging_dir = tempfile::tempdir().unwrap();
    let source = src_dir.path().join("helper-bin");

    // Register the EXPECTED bytes' hash, but the source on disk is tampered.
    let expected_hash = sha256_hash_bytes(b"EXPECTED-HELPER-BYTES\n");
    let tampered = b"TAMPERED-HELPER-BYTES\n";
    fs::write(&source, tampered).unwrap();
    let tampered_hash = sha256_hash_bytes(tampered);

    // (a) Direct stage-time typed error (acceptance #3).
    let error = stage_and_verify_helper_binary(
        &expected_hash,
        &source,
        staging_dir.path(),
        &staged_helper_binary_name(FIXTURE_HELPER_ALLOWLIST_REF_ID),
    )
    .expect_err("tampered staged bytes must be a typed error");
    assert_eq!(
        error,
        HelperBinaryStagingError::StagedHashMismatch {
            expected: expected_hash.clone(),
            observed: tampered_hash.clone(),
        }
    );

    // (b) Through the launch validator: HASH_MISMATCH diagnostic on the
    // STAGED bytes, and NO staged execution reference is handed back.
    let entry = staging_launch_entry(&expected_hash);
    let required = [HelperCapability::FixtureInvocation];
    let outcome = entry.stage_and_validate_binary_launch(
        launch_request(&entry, &source, &required),
        staging_dir.path(),
    );
    assert!(!outcome.passed());
    assert!(
        outcome.staged.is_none(),
        "a failed launch must not bind an executable handle"
    );
    assert_eq!(
        outcome.validation.observed_hash.as_deref(),
        Some(tampered_hash.as_str())
    );
    assert!(
        outcome
            .validation
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == SEMANTIC_HELPER_ALLOWLIST_HASH_MISMATCH),
        "expected hash-mismatch diagnostic: {:?}",
        outcome.validation.diagnostics
    );
}

#[test]
fn helper_launch_refuses_symlinked_source_instead_of_chasing_it() {
    #[cfg(unix)]
    {
        let src_dir = tempfile::tempdir().unwrap();
        let staging_dir = tempfile::tempdir().unwrap();
        let real = src_dir.path().join("real-target");
        let bytes = b"REAL-TARGET-BYTES\n";
        fs::write(&real, bytes).unwrap();
        let link = src_dir.path().join("helper-bin");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        // Direct primitive: a symlink source is a typed refusal.
        let error = stage_helper_binary_no_follow(
            &link,
            staging_dir.path(),
            &staged_helper_binary_name(FIXTURE_HELPER_ALLOWLIST_REF_ID),
        )
        .expect_err("symlink source must be refused");
        assert_eq!(error, HelperBinaryStagingError::SourceSymlink);

        // Through the launch validator: a staging-failed diagnostic, no
        // staged handle.
        let entry = staging_launch_entry(&sha256_hash_bytes(bytes));
        let required = [HelperCapability::FixtureInvocation];
        let outcome = entry.stage_and_validate_binary_launch(
            launch_request(&entry, &link, &required),
            staging_dir.path(),
        );
        assert!(!outcome.passed());
        assert!(outcome.staged.is_none());
        assert!(
            outcome
                .validation
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == SEMANTIC_HELPER_ALLOWLIST_STAGING_FAILED)
        );
    }
}

#[test]
fn staged_helper_copy_is_removed_on_drop() {
    let src_dir = tempfile::tempdir().unwrap();
    let staging_dir = tempfile::tempdir().unwrap();
    let source = src_dir.path().join("helper-bin");
    let bytes = b"HELPER\n";
    fs::write(&source, bytes).unwrap();
    let name = staged_helper_binary_name(FIXTURE_HELPER_ALLOWLIST_REF_ID);
    let staged_path = {
        let staged = stage_and_verify_helper_binary(
            &sha256_hash_bytes(bytes),
            &source,
            staging_dir.path(),
            &name,
        )
        .unwrap();
        let path = staged.staged_path().to_path_buf();
        assert!(path.exists());
        path
    };
    assert!(!staged_path.exists(), "staged copy must be removed on drop");
}
