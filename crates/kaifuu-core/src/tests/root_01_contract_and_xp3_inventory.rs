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

pub(super) fn temp_dir(name: &str) -> PathBuf {
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
pub(crate) struct Xp3TestEntry<'a> {
    pub(crate) path: &'a str,
    pub(crate) payload: &'a [u8],
    pub(crate) compressed: bool,
    pub(crate) adler32: u32,
}

pub(crate) fn plain_xp3_fixture(entries: &[Xp3TestEntry<'_>]) -> Vec<u8> {
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
