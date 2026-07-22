use super::*;
use std::path::PathBuf;

fn repo_fixture_path(relative_path: &str) -> PathBuf {
    crate::test_manifest_dir().join("../..").join(relative_path)
}

fn kirikiri_dir() -> PathBuf {
    repo_fixture_path("fixtures/kaifuu/kirikiri")
}

fn load_fixture() -> PlainXp3SmokeFixture {
    let bytes = std::fs::read(kirikiri_dir().join("plain-xp3.json")).unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn run() -> PlainXp3SmokeReport {
    let fixture = load_fixture();
    generate_plain_xp3_smoke(PlainXp3SmokeRequest {
        fixture: &fixture,
        fixture_dir: &kirikiri_dir(),
    })
    .unwrap()
}

// --- In-code reconstruction of the committed negative archives (proves the
// binary fixtures are reproducible byte-for-byte from this source). ---

fn chunk(name: [u8; 4], content: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&name);
    out.extend_from_slice(&(content.len() as u64).to_le_bytes());
    out.extend_from_slice(content);
    out
}

fn build_malformed_table_archive() -> Vec<u8> {
    let payload = b"x";
    let mut bytes = Vec::new();
    bytes.extend_from_slice(XP3_PLAIN_MAGIC);
    bytes.extend_from_slice(&0_u64.to_le_bytes());
    bytes.extend_from_slice(payload);
    let index_offset = bytes.len() as u64;
    bytes.push(0); // index encoding (plain)
    bytes.extend_from_slice(&0xffff_ffff_u64.to_le_bytes()); // overrun index size
    bytes[XP3_PLAIN_MAGIC.len()..XP3_PLAIN_MAGIC.len() + 8]
        .copy_from_slice(&index_offset.to_le_bytes());
    bytes
}

fn build_unsupported_member_flags_archive() -> Vec<u8> {
    let member_id = "scenario/flagged.ks";
    let payload = b"member carries an unsupported segment flag\n";
    let mut bytes = Vec::new();
    bytes.extend_from_slice(XP3_PLAIN_MAGIC);
    bytes.extend_from_slice(&0_u64.to_le_bytes());
    let segment_offset = bytes.len() as u64;
    bytes.extend_from_slice(payload);
    let index_offset = bytes.len() as u64;

    let mut info = Vec::new();
    info.extend_from_slice(&0_u32.to_le_bytes());
    info.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    info.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    let units: Vec<u16> = member_id.encode_utf16().collect();
    info.extend_from_slice(&(units.len() as u16).to_le_bytes());
    for unit in units {
        info.extend_from_slice(&unit.to_le_bytes());
    }
    let mut segm = Vec::new();
    segm.extend_from_slice(&0x04_u32.to_le_bytes()); // unsupported flag bit
    segm.extend_from_slice(&segment_offset.to_le_bytes());
    segm.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    segm.extend_from_slice(&(payload.len() as u64).to_le_bytes());

    let mut file = Vec::new();
    file.extend_from_slice(&chunk(*b"info", &info));
    file.extend_from_slice(&chunk(*b"segm", &segm));
    file.extend_from_slice(&chunk(*b"adlr", &0x1a2b_3c4d_u32.to_le_bytes()));
    let index = chunk(*b"File", &file);

    bytes.push(0);
    bytes.extend_from_slice(&(index.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&index);
    bytes[XP3_PLAIN_MAGIC.len()..XP3_PLAIN_MAGIC.len() + 8]
        .copy_from_slice(&index_offset.to_le_bytes());
    bytes
}

#[test]
fn committed_negative_fixtures_match_in_code_construction() {
    let malformed =
        std::fs::read(kirikiri_dir().join("negative/plain-xp3-malformed-table.xp3")).unwrap();
    assert_eq!(malformed, build_malformed_table_archive());

    let flagged =
        std::fs::read(kirikiri_dir().join("negative/plain-xp3-unsupported-member-flags.xp3"))
            .unwrap();
    assert_eq!(flagged, build_unsupported_member_flags_archive());
}

#[test]
fn smoke_passes_on_public_fixture_with_byte_identical_rebuild() {
    let report = run();
    assert_eq!(report.status, OperationStatus::Passed);
    assert!(report.findings.is_empty());
    assert_eq!(report.archive.member_count, 3);
    assert_eq!(report.archive.compressed_member_count, 1);
    assert_eq!(
        report.rebuild.equivalence,
        PlainXp3SmokeEquivalence::ByteIdentical
    );
    assert!(report.rebuild.byte_identical);
    assert_eq!(
        report.rebuild.output_hash.as_str(),
        report.rebuild.source_hash.as_str()
    );
    // Member hashes, table offsets, and compression state are reported.
    let compressed: Vec<&str> = report
        .members
        .iter()
        .filter(|member| member.compressed)
        .map(|member| member.member_id.as_str())
        .collect();
    assert_eq!(compressed, vec!["scenario/compressed.ks"]);
    let offsets: Vec<u64> = report
        .members
        .iter()
        .map(|member| member.data_offset)
        .collect();
    assert_eq!(offsets, vec![19, 36, 62]);
    assert_eq!(report.archive.index_offset, 80);
}

#[test]
fn negatives_fail_before_writes_and_cite_member_ids() {
    let report = run();
    assert_eq!(report.negatives.len(), 2);
    for negative in &report.negatives {
        assert_eq!(
            negative.status,
            OperationStatus::Passed,
            "negative {} should fail as declared",
            negative.case_id
        );
        assert!(
            negative.failed_before_write,
            "negative {} must be rejected before any rebuild byte",
            negative.case_id
        );
    }

    let malformed = report
        .negatives
        .iter()
        .find(|negative| negative.failure_kind == PlainXp3SmokeNegativeKind::MalformedTable)
        .unwrap();
    assert_eq!(
        malformed.semantic_code.as_deref(),
        Some(SEMANTIC_SMOKE_MALFORMED_TABLE)
    );

    let flagged = report
        .negatives
        .iter()
        .find(|negative| negative.failure_kind == PlainXp3SmokeNegativeKind::UnsupportedMemberFlags)
        .unwrap();
    assert_eq!(
        flagged.semantic_code.as_deref(),
        Some(SEMANTIC_SMOKE_UNSUPPORTED_MEMBER_FLAGS)
    );
    // The rejection cites the in-archive member id, never a local path.
    assert_eq!(flagged.member_id.as_deref(), Some("scenario/flagged.ks"));
}

#[test]
fn report_json_carries_no_local_path_and_keeps_member_ids() {
    let report = run();
    let json = report.stable_json().unwrap();
    // No local / fixture-directory path leaks into the redacted report.
    assert!(!json.contains("/scratch/"));
    assert!(!json.contains(env!("CARGO_MANIFEST_DIR")));
    assert!(!json.contains("plain.xp3"));
    assert!(!json.contains(".xp3"));
    // Member ids survive redaction (they are not secrets / local paths).
    assert!(json.contains("scenario/flagged.ks"));
    assert!(json.contains("scenario/compressed.ks"));
}

#[test]
fn unsupported_flag_detector_ignores_compressed_bit() {
    // The compressed bit (0x1) is supported; an extra bit is not.
    let archive = read_plain_xp3_archive(&build_unsupported_member_flags_archive()).unwrap();
    let hit = first_unsupported_member_flag(&archive).unwrap();
    assert_eq!(hit.0, "scenario/flagged.ks");
    assert_eq!(hit.1, 0x04);
}
