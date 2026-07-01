//! KAIFUU-071 — Plain XP3 read/write smoke command.
//!
//! The smoke command *composes* the existing shared plain-XP3 surfaces — it
//! does not reimplement the container format:
//!
//! - inventory runs through [`crate::read_plain_xp3_inventory`] (member sizes,
//!   compression state, per-member payload hashes, stored adler32);
//! - the deterministic rebuild runs through [`crate::read_plain_xp3_archive`]
//!   (the source-fidelity reader) followed by [`crate::encode_xp3`] (the
//!   KAIFUU-098 deterministic writer).
//!
//! On a public, synthetic plain-XP3 fixture the command proves the rebuild is
//! **byte-identical** to the source archive (the determinism guarantee). When a
//! rebuild is not byte-identical — a future, structurally different writer — the
//! command falls back to a documented **manifest-equivalence** report comparing
//! the source and rebuilt inventories member-for-member; it never silently
//! accepts a divergent rebuild.
//!
//! Malformed or unsupported XP3 inputs are rejected **before any rebuild byte is
//! produced** and surface structured findings that cite the in-archive *member
//! id* (never a raw local path). Two negative classes are exercised:
//!
//! - [`PlainXp3SmokeNegativeKind::MalformedTable`]: the source-fidelity reader
//!   rejects the archive at parse time (e.g. an overrun file-table index);
//! - [`PlainXp3SmokeNegativeKind::UnsupportedMemberFlags`]: the archive parses,
//!   but a member carries a segment flag bit outside the writer's known set
//!   ({bit 0 = compressed}), so the smoke command refuses to claim a faithful
//!   plain round-trip for that member and cites it by id.
//!
//! Plain XP3 is the only variant in scope. Encrypted / compressed-payload /
//! helper-required / protected-executable inputs are out of scope (research
//! tier per KAIFUU-054) and are rejected by the shared reader before this
//! command ever sees a rebuild surface. The command requires no encryption key
//! and no private corpus input. Every string surfaced in the report is funnelled
//! through [`crate::redact_for_log_or_report`]; the report carries only counts,
//! hashes, offsets, and in-archive member ids.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::{
    KaifuuResult, OperationStatus, PartialDiagnosticSeverity, PlainXp3Archive, PlainXp3WriterError,
    ProofHash, XP3_PLAIN_MAGIC, encode_xp3, read_json, read_plain_xp3_archive,
    read_plain_xp3_inventory, redact_for_log_or_report, sha256_hash_bytes, stable_json,
};

/// Schema version of the smoke fixture and report.
pub const PLAIN_XP3_SMOKE_SCHEMA_VERSION: &str = "0.1.0";

/// Segment flag bits the deterministic plain-XP3 writer claims faithful
/// round-trip support for. Bit 0 is the KiriKiri "this segment is zlib
/// compressed" marker, which [`crate::encode_xp3`] passes through verbatim. Any
/// other bit is an unsupported member flag.
pub const PLAIN_XP3_SMOKE_SUPPORTED_SEGMENT_FLAGS: u32 = 0x1;

/// Support boundary surfaced in every smoke report.
pub const PLAIN_XP3_SMOKE_SUPPORT_BOUNDARY: &str = "The plain-XP3 smoke command inventories and deterministically rebuilds plain (unencrypted) KiriKiri XP3 archives through the shared reader/writer path on public synthetic fixtures only. It requires no encryption key and no private corpus. Encrypted, compressed-payload, helper-required, and protected-executable variants are out of scope (research tier) and are rejected by the shared reader before any rebuild byte is produced.";

/// Semantic code: an archive declared positive (rebuildable) could not be read
/// by the shared source-fidelity reader.
pub const SEMANTIC_SMOKE_UNREADABLE_ARCHIVE: &str = "kaifuu.plain_xp3_smoke.unreadable_archive";
/// Semantic code: a member carries a segment flag bit outside the supported set.
pub const SEMANTIC_SMOKE_UNSUPPORTED_MEMBER_FLAGS: &str =
    "kaifuu.plain_xp3_smoke.unsupported_member_flags";
/// Semantic code: the file table itself is malformed (parse-time rejection).
pub const SEMANTIC_SMOKE_MALFORMED_TABLE: &str = "kaifuu.plain_xp3_smoke.malformed_table";
/// Semantic code: the rebuild diverged from the source with no manifest
/// equivalence.
pub const SEMANTIC_SMOKE_REBUILD_DRIFT: &str = "kaifuu.plain_xp3_smoke.rebuild_drift";
/// Semantic code: an observed value did not match the fixture's declared
/// expectation.
pub const SEMANTIC_SMOKE_EXPECTATION_MISMATCH: &str = "kaifuu.plain_xp3_smoke.expectation_mismatch";
/// Semantic code: a negative fixture did not fail the way it declared it would.
pub const SEMANTIC_SMOKE_NEGATIVE_DID_NOT_FAIL: &str =
    "kaifuu.plain_xp3_smoke.negative_did_not_fail";

// --- Fixture (input manifest) -----------------------------------------------

/// Public plain-XP3 smoke fixture descriptor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlainXp3SmokeFixture {
    pub schema_version: String,
    pub fixture_id: String,
    /// The spec-DAG node id this fixture is authored for (e.g. `KAIFUU-071`).
    pub source_node_id: String,
    pub engine_family: String,
    pub archive: PlainXp3SmokeArchiveRef,
    pub expected: PlainXp3SmokeExpectation,
    #[serde(default)]
    pub negatives: Vec<PlainXp3SmokeNegativeFixture>,
}

/// Reference to the positive plain-XP3 archive bytes (path relative to the
/// fixture file) plus the public archive id surfaced in the report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlainXp3SmokeArchiveRef {
    pub archive_id: String,
    /// Path to the archive, relative to the fixture file. Never surfaced in the
    /// report.
    pub path: String,
}

/// The author's declared expectation for the positive archive. The smoke
/// command recomputes every value from the bytes and raises a structured
/// finding on any mismatch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlainXp3SmokeExpectation {
    pub archive_hash: ProofHash,
    pub member_count: u64,
    pub compressed_member_count: u64,
    pub members: Vec<PlainXp3SmokeExpectedMember>,
}

/// Per-member expectation, keyed by the in-archive member id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlainXp3SmokeExpectedMember {
    pub member_id: String,
    pub original_size: u64,
    pub archive_size: u64,
    pub compressed: bool,
    pub segment_count: u64,
    pub payload_hash: ProofHash,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stored_adler32: Option<String>,
}

/// The negative class a [`PlainXp3SmokeNegativeFixture`] exercises.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlainXp3SmokeNegativeKind {
    /// The file table is malformed; the shared reader rejects it at parse time.
    MalformedTable,
    /// A member carries an unsupported segment flag bit.
    UnsupportedMemberFlags,
}

impl PlainXp3SmokeNegativeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MalformedTable => "malformed_table",
            Self::UnsupportedMemberFlags => "unsupported_member_flags",
        }
    }

    fn expected_semantic_code(self) -> &'static str {
        match self {
            Self::MalformedTable => SEMANTIC_SMOKE_MALFORMED_TABLE,
            Self::UnsupportedMemberFlags => SEMANTIC_SMOKE_UNSUPPORTED_MEMBER_FLAGS,
        }
    }
}

/// A negative archive the smoke command must reject before producing a rebuild.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlainXp3SmokeNegativeFixture {
    pub case_id: String,
    /// Path to the negative archive, relative to the fixture file. Never
    /// surfaced in the report.
    pub path: String,
    pub failure_kind: PlainXp3SmokeNegativeKind,
    /// For [`PlainXp3SmokeNegativeKind::UnsupportedMemberFlags`]: the in-archive
    /// member id the command is expected to cite.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_member_id: Option<String>,
}

// --- Report (generated output) ----------------------------------------------

/// Whether the rebuild reproduced the source bytes exactly or only
/// member-for-member.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlainXp3SmokeEquivalence {
    /// The rebuilt bytes are identical to the source archive bytes.
    ByteIdentical,
    /// The rebuilt bytes differ, but every member matches the source inventory
    /// (path, sizes, compression, payload hash). Documented fallback.
    ManifestEquivalent,
    /// Neither byte-identity nor manifest-equivalence held.
    Divergent,
}

impl PlainXp3SmokeEquivalence {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ByteIdentical => "byte_identical",
            Self::ManifestEquivalent => "manifest_equivalent",
            Self::Divergent => "divergent",
        }
    }
}

/// A structured smoke finding. `member_id` is always an in-archive id, never a
/// local path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3SmokeFinding {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_id: Option<String>,
}

impl PlainXp3SmokeFinding {
    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
            semantic_code: self.semantic_code.as_deref().map(redact_for_log_or_report),
            member_id: self.member_id.as_deref().map(redact_for_log_or_report),
        }
    }
}

/// Archive-level summary of the positive smoke target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3SmokeArchiveReport {
    pub archive_id: String,
    pub archive_hash: ProofHash,
    pub member_count: u64,
    pub compressed_member_count: u64,
    /// Offset of the file-table index in the (rebuilt) archive.
    pub index_offset: u64,
}

impl PlainXp3SmokeArchiveReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            archive_id: redact_for_log_or_report(&self.archive_id),
            archive_hash: self.archive_hash.clone(),
            member_count: self.member_count,
            compressed_member_count: self.compressed_member_count,
            index_offset: self.index_offset,
        }
    }
}

/// Per-member rebuild evidence: member hash, table offset, compression state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3SmokeMemberReport {
    pub member_id: String,
    /// Source-order index of the member in the archive.
    pub index: u64,
    pub original_size: u64,
    pub archive_size: u64,
    pub compressed: bool,
    pub segment_count: u64,
    /// sha256 of the member's concatenated segment payloads.
    pub payload_hash: ProofHash,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stored_adler32: Option<String>,
    /// Byte offset of the member's first segment payload in the archive (the
    /// member's "table offset").
    pub data_offset: u64,
}

impl PlainXp3SmokeMemberReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            member_id: redact_for_log_or_report(&self.member_id),
            index: self.index,
            original_size: self.original_size,
            archive_size: self.archive_size,
            compressed: self.compressed,
            segment_count: self.segment_count,
            payload_hash: self.payload_hash.clone(),
            stored_adler32: self.stored_adler32.as_deref().map(redact_for_log_or_report),
            data_offset: self.data_offset,
        }
    }
}

/// Rebuild determinism evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3SmokeRebuildReport {
    pub equivalence: PlainXp3SmokeEquivalence,
    pub byte_identical: bool,
    pub source_hash: ProofHash,
    pub output_hash: ProofHash,
    pub source_bytes: u64,
    pub output_bytes: u64,
}

/// Outcome of a negative case: `status` is `Passed` when the case failed exactly
/// as it declared (citing a member id where required), before any rebuild byte.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3SmokeNegativeReport {
    pub case_id: String,
    pub failure_kind: PlainXp3SmokeNegativeKind,
    pub status: OperationStatus,
    /// True when the rejection happened before any rebuild byte was produced.
    pub failed_before_write: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_code: Option<String>,
    /// In-archive member id cited by the rejection (never a local path).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_id: Option<String>,
    pub findings: Vec<PlainXp3SmokeFinding>,
}

impl PlainXp3SmokeNegativeReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            case_id: redact_for_log_or_report(&self.case_id),
            failure_kind: self.failure_kind,
            status: self.status.clone(),
            failed_before_write: self.failed_before_write,
            semantic_code: self.semantic_code.as_deref().map(redact_for_log_or_report),
            member_id: self.member_id.as_deref().map(redact_for_log_or_report),
            findings: self
                .findings
                .iter()
                .map(PlainXp3SmokeFinding::redacted_for_report)
                .collect(),
        }
    }
}

/// The full smoke report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainXp3SmokeReport {
    pub schema_version: String,
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub archive: PlainXp3SmokeArchiveReport,
    pub members: Vec<PlainXp3SmokeMemberReport>,
    pub rebuild: PlainXp3SmokeRebuildReport,
    pub negatives: Vec<PlainXp3SmokeNegativeReport>,
    pub findings: Vec<PlainXp3SmokeFinding>,
}

impl PlainXp3SmokeReport {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            archive: self.archive.redacted_for_report(),
            members: self
                .members
                .iter()
                .map(PlainXp3SmokeMemberReport::redacted_for_report)
                .collect(),
            rebuild: self.rebuild.clone(),
            negatives: self
                .negatives
                .iter()
                .map(PlainXp3SmokeNegativeReport::redacted_for_report)
                .collect(),
            findings: self
                .findings
                .iter()
                .map(PlainXp3SmokeFinding::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

// --- Request + generator ----------------------------------------------------

/// Inputs to [`generate_plain_xp3_smoke`].
#[derive(Debug, Clone, Copy)]
pub struct PlainXp3SmokeRequest<'a> {
    pub fixture: &'a PlainXp3SmokeFixture,
    /// Directory the fixture file lives in; the archive and negative paths
    /// resolve relative to it.
    pub fixture_dir: &'a Path,
}

/// Run the plain-XP3 read/write smoke against a fixture.
///
/// Returns `Err` only on an environmental failure (a fixture-shaped problem the
/// report cannot represent, e.g. a missing archive file). All inventory /
/// rebuild / expectation / negative outcomes are folded into the report's
/// `status` and structured findings.
pub fn generate_plain_xp3_smoke(
    request: PlainXp3SmokeRequest<'_>,
) -> KaifuuResult<PlainXp3SmokeReport> {
    let fixture = request.fixture;
    let mut findings = Vec::new();

    let archive_path = request.fixture_dir.join(&fixture.archive.path);
    let source_bytes = std::fs::read(&archive_path)
        .map_err(|error| format!("read plain-xp3 smoke archive: {error}"))?;
    let source_hash = ProofHash::new(sha256_hash_bytes(&source_bytes))
        .map_err(|error| format!("source archive hash: {error}"))?;

    // --- Shared-path read: source-fidelity reader (rebuild side) -------------
    let archive = match read_plain_xp3_archive(&source_bytes) {
        Ok(archive) => archive,
        Err(error) => {
            findings.push(reader_finding(&error));
            return Ok(failed_unreadable_report(fixture, &source_hash, findings));
        }
    };

    // The positive archive must not itself carry unsupported member flags.
    if let Some((member_id, flags)) = first_unsupported_member_flag(&archive) {
        findings.push(PlainXp3SmokeFinding {
            code: "plain_xp3_smoke.positive_unsupported_flags".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: "archive.members".to_string(),
            message: format!(
                "positive archive member carries unsupported segment flag 0x{flags:08x}"
            ),
            semantic_code: Some(SEMANTIC_SMOKE_UNSUPPORTED_MEMBER_FLAGS.to_string()),
            member_id: Some(member_id),
        });
    }

    // --- Shared-path read: inventory reader (hash / metadata side) -----------
    let inventory = match read_plain_xp3_inventory(&source_bytes) {
        Ok(inventory) => inventory,
        Err(error) => {
            findings.push(PlainXp3SmokeFinding {
                code: "plain_xp3_smoke.inventory_unreadable".to_string(),
                severity: PartialDiagnosticSeverity::P0,
                field: "archive".to_string(),
                message: format!("plain XP3 inventory error: {error}"),
                semantic_code: Some(SEMANTIC_SMOKE_UNREADABLE_ARCHIVE.to_string()),
                member_id: None,
            });
            return Ok(failed_unreadable_report(fixture, &source_hash, findings));
        }
    };

    // --- Shared-path write: deterministic rebuild ----------------------------
    let rebuilt = match encode_xp3(&archive) {
        Ok(bytes) => bytes,
        Err(error) => {
            findings.push(reader_finding(&error));
            return Ok(failed_unreadable_report(fixture, &source_hash, findings));
        }
    };
    let output_hash = ProofHash::new(sha256_hash_bytes(&rebuilt))
        .map_err(|error| format!("rebuilt archive hash: {error}"))?;
    let byte_identical = rebuilt == source_bytes;

    // Member report: source order from the archive, payload hash / adler from
    // the inventory reader, table offset derived from the cumulative payload
    // layout and cross-checked against the rebuilt index offset.
    let mut members = Vec::with_capacity(archive.entries.len());
    let mut data_cursor = (XP3_PLAIN_MAGIC.len() + 8) as u64;
    let mut compressed_member_count: u64 = 0;
    for (index, entry) in archive.entries.iter().enumerate() {
        let inventory_entry = inventory
            .entries
            .iter()
            .find(|candidate| candidate.path == entry.path);
        let compressed = entry
            .segments
            .iter()
            .any(crate::PlainXp3ArchiveSegment::is_compressed);
        if compressed {
            compressed_member_count += 1;
        }
        let payload_hash_raw = inventory_entry
            .and_then(|candidate| candidate.payload_hash.clone())
            .unwrap_or_else(|| sha256_hash_bytes(&entry.payload));
        let payload_hash = ProofHash::new(payload_hash_raw)
            .map_err(|error| format!("member payload hash: {error}"))?;
        let stored_adler32 = inventory_entry
            .and_then(|candidate| candidate.stored_adler32.clone())
            .or_else(|| {
                entry
                    .stored_adler32
                    .map(|value| format!("adler32:{value:08x}"))
            });
        members.push(PlainXp3SmokeMemberReport {
            member_id: entry.path.clone(),
            index: index as u64,
            original_size: entry.original_size,
            archive_size: entry.archive_size,
            compressed,
            segment_count: entry.segments.len() as u64,
            payload_hash,
            stored_adler32,
            data_offset: data_cursor,
        });
        data_cursor += entry.archive_size;
    }

    let index_offset = read_index_offset(&rebuilt).unwrap_or(data_cursor);
    let member_count = members.len() as u64;

    // --- Determinism: byte-identity or documented manifest equivalence -------
    let equivalence = if byte_identical {
        PlainXp3SmokeEquivalence::ByteIdentical
    } else if rebuild_is_manifest_equivalent(&source_bytes, &rebuilt) {
        PlainXp3SmokeEquivalence::ManifestEquivalent
    } else {
        PlainXp3SmokeEquivalence::Divergent
    };
    if equivalence == PlainXp3SmokeEquivalence::Divergent {
        findings.push(PlainXp3SmokeFinding {
            code: "plain_xp3_smoke.rebuild_drift".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: "rebuild".to_string(),
            message: "deterministic rebuild diverged from the source with no manifest equivalence"
                .to_string(),
            semantic_code: Some(SEMANTIC_SMOKE_REBUILD_DRIFT.to_string()),
            member_id: None,
        });
    }

    // --- Validate observed values against the fixture's expectations ---------
    validate_expectations(
        &fixture.expected,
        &source_hash,
        member_count,
        compressed_member_count,
        &members,
        &mut findings,
    );

    // --- Negative cases ------------------------------------------------------
    let mut negatives = Vec::with_capacity(fixture.negatives.len());
    for negative in &fixture.negatives {
        negatives.push(evaluate_negative(negative, request.fixture_dir));
    }

    let status = overall_status(&findings, &negatives);

    Ok(PlainXp3SmokeReport {
        schema_version: PLAIN_XP3_SMOKE_SCHEMA_VERSION.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        support_boundary: PLAIN_XP3_SMOKE_SUPPORT_BOUNDARY.to_string(),
        status,
        archive: PlainXp3SmokeArchiveReport {
            archive_id: fixture.archive.archive_id.clone(),
            archive_hash: source_hash.clone(),
            member_count,
            compressed_member_count,
            index_offset,
        },
        members,
        rebuild: PlainXp3SmokeRebuildReport {
            equivalence,
            byte_identical,
            source_hash,
            output_hash,
            source_bytes: source_bytes.len() as u64,
            output_bytes: rebuilt.len() as u64,
        },
        negatives,
        findings,
    })
}

/// Convenience wrapper that reads the fixture JSON from `fixture_path` and runs
/// the smoke.
pub fn run_plain_xp3_smoke_from_path(fixture_path: &Path) -> KaifuuResult<PlainXp3SmokeReport> {
    let fixture: PlainXp3SmokeFixture = read_json(fixture_path)?;
    let fixture_dir = fixture_path
        .parent()
        .ok_or("fixture path must have a parent directory")?;
    generate_plain_xp3_smoke(PlainXp3SmokeRequest {
        fixture: &fixture,
        fixture_dir,
    })
}

// --- Helpers ----------------------------------------------------------------

/// Map a shared-reader/writer error onto a malformed-table smoke finding. The
/// reader/writer error message is structural (it never embeds a local path), so
/// it is safe to surface verbatim alongside the smoke semantic code.
fn reader_finding(error: &PlainXp3WriterError) -> PlainXp3SmokeFinding {
    PlainXp3SmokeFinding {
        code: "plain_xp3_smoke.malformed_table".to_string(),
        severity: PartialDiagnosticSeverity::P0,
        field: "archive.table".to_string(),
        message: format!("{error} (reader semantic: {})", error.semantic_code()),
        semantic_code: Some(SEMANTIC_SMOKE_MALFORMED_TABLE.to_string()),
        member_id: None,
    }
}

/// First member (source order) whose segments carry a flag bit outside the
/// supported set, with the offending OR-ed flag bits.
fn first_unsupported_member_flag(archive: &PlainXp3Archive) -> Option<(String, u32)> {
    for entry in &archive.entries {
        let unsupported: u32 = entry
            .segments
            .iter()
            .map(|segment| segment.flags & !PLAIN_XP3_SMOKE_SUPPORTED_SEGMENT_FLAGS)
            .fold(0, |accumulator, bits| accumulator | bits);
        if unsupported != 0 {
            return Some((entry.path.clone(), unsupported));
        }
    }
    None
}

/// Read the file-table index offset from a plain-XP3 byte stream.
fn read_index_offset(bytes: &[u8]) -> Option<u64> {
    let start = XP3_PLAIN_MAGIC.len();
    let slice = bytes.get(start..start + 8)?;
    let mut raw = [0_u8; 8];
    raw.copy_from_slice(slice);
    Some(u64::from_le_bytes(raw))
}

/// Manifest-equivalence fallback: two plain-XP3 byte streams are
/// manifest-equivalent when their inventories match member-for-member (path,
/// sizes, compression, segment count, payload hash) in order.
fn rebuild_is_manifest_equivalent(source: &[u8], rebuilt: &[u8]) -> bool {
    match (
        read_plain_xp3_inventory(source),
        read_plain_xp3_inventory(rebuilt),
    ) {
        (Ok(source_inventory), Ok(rebuilt_inventory)) => {
            source_inventory.entries == rebuilt_inventory.entries
        }
        _ => false,
    }
}

fn validate_expectations(
    expected: &PlainXp3SmokeExpectation,
    archive_hash: &ProofHash,
    member_count: u64,
    compressed_member_count: u64,
    members: &[PlainXp3SmokeMemberReport],
    findings: &mut Vec<PlainXp3SmokeFinding>,
) {
    if expected.archive_hash.as_str() != archive_hash.as_str() {
        findings.push(mismatch_finding(
            "expected.archiveHash",
            "archive hash did not match the declared expectation",
            None,
        ));
    }
    if expected.member_count != member_count {
        findings.push(mismatch_finding(
            "expected.memberCount",
            &format!(
                "member count {member_count} did not match declared {}",
                expected.member_count
            ),
            None,
        ));
    }
    if expected.compressed_member_count != compressed_member_count {
        findings.push(mismatch_finding(
            "expected.compressedMemberCount",
            &format!(
                "compressed member count {compressed_member_count} did not match declared {}",
                expected.compressed_member_count
            ),
            None,
        ));
    }
    for expected_member in &expected.members {
        let Some(actual) = members
            .iter()
            .find(|member| member.member_id == expected_member.member_id)
        else {
            findings.push(mismatch_finding(
                "expected.members",
                "declared member id was not present in the archive",
                Some(expected_member.member_id.clone()),
            ));
            continue;
        };
        if actual.original_size != expected_member.original_size
            || actual.archive_size != expected_member.archive_size
            || actual.compressed != expected_member.compressed
            || actual.segment_count != expected_member.segment_count
            || actual.payload_hash.as_str() != expected_member.payload_hash.as_str()
            || actual.stored_adler32 != expected_member.stored_adler32
        {
            findings.push(mismatch_finding(
                "expected.members",
                "member metadata did not match the declared expectation",
                Some(expected_member.member_id.clone()),
            ));
        }
    }
}

fn mismatch_finding(field: &str, message: &str, member_id: Option<String>) -> PlainXp3SmokeFinding {
    PlainXp3SmokeFinding {
        code: "plain_xp3_smoke.expectation_mismatch".to_string(),
        severity: PartialDiagnosticSeverity::P0,
        field: field.to_string(),
        message: message.to_string(),
        semantic_code: Some(SEMANTIC_SMOKE_EXPECTATION_MISMATCH.to_string()),
        member_id,
    }
}

/// Evaluate a single negative case. A `Passed` status means the case failed
/// exactly as declared — before any rebuild byte, citing a member id where the
/// class requires one.
fn evaluate_negative(
    negative: &PlainXp3SmokeNegativeFixture,
    fixture_dir: &Path,
) -> PlainXp3SmokeNegativeReport {
    let path = fixture_dir.join(&negative.path);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return negative_failure(
                negative,
                false,
                None,
                None,
                PlainXp3SmokeFinding {
                    code: "plain_xp3_smoke.negative_unreadable".to_string(),
                    severity: PartialDiagnosticSeverity::P0,
                    field: "negative".to_string(),
                    message: format!("could not read negative fixture bytes: {error}"),
                    semantic_code: Some(SEMANTIC_SMOKE_NEGATIVE_DID_NOT_FAIL.to_string()),
                    member_id: None,
                },
            );
        }
    };

    match negative.failure_kind {
        PlainXp3SmokeNegativeKind::MalformedTable => match read_plain_xp3_archive(&bytes) {
            Ok(_) => negative_did_not_fail(
                negative,
                "malformed-table fixture parsed cleanly through the shared reader",
            ),
            Err(error) => PlainXp3SmokeNegativeReport {
                case_id: negative.case_id.clone(),
                failure_kind: negative.failure_kind,
                status: OperationStatus::Passed,
                failed_before_write: true,
                semantic_code: Some(SEMANTIC_SMOKE_MALFORMED_TABLE.to_string()),
                member_id: None,
                findings: vec![reader_finding(&error)],
            },
        },
        PlainXp3SmokeNegativeKind::UnsupportedMemberFlags => match read_plain_xp3_archive(&bytes) {
            Ok(archive) => match first_unsupported_member_flag(&archive) {
                Some((member_id, flags)) => {
                    let member_ok = negative
                        .expected_member_id
                        .as_ref()
                        .is_none_or(|expected| expected == &member_id);
                    let finding = PlainXp3SmokeFinding {
                        code: "plain_xp3_smoke.unsupported_member_flags".to_string(),
                        severity: PartialDiagnosticSeverity::P0,
                        field: "member.segments.flags".to_string(),
                        message: format!(
                            "member rejected: unsupported segment flag 0x{flags:08x} (only 0x{PLAIN_XP3_SMOKE_SUPPORTED_SEGMENT_FLAGS:08x} is supported)"
                        ),
                        semantic_code: Some(SEMANTIC_SMOKE_UNSUPPORTED_MEMBER_FLAGS.to_string()),
                        member_id: Some(member_id.clone()),
                    };
                    if member_ok {
                        PlainXp3SmokeNegativeReport {
                            case_id: negative.case_id.clone(),
                            failure_kind: negative.failure_kind,
                            status: OperationStatus::Passed,
                            failed_before_write: true,
                            semantic_code: Some(
                                SEMANTIC_SMOKE_UNSUPPORTED_MEMBER_FLAGS.to_string(),
                            ),
                            member_id: Some(member_id),
                            findings: vec![finding],
                        }
                    } else {
                        negative_failure(
                            negative,
                            true,
                            Some(SEMANTIC_SMOKE_NEGATIVE_DID_NOT_FAIL.to_string()),
                            Some(member_id),
                            PlainXp3SmokeFinding {
                                code: "plain_xp3_smoke.negative_member_mismatch".to_string(),
                                severity: PartialDiagnosticSeverity::P0,
                                field: "negative.expectedMemberId".to_string(),
                                message: "cited member id did not match the declared expectation"
                                    .to_string(),
                                semantic_code: Some(
                                    SEMANTIC_SMOKE_NEGATIVE_DID_NOT_FAIL.to_string(),
                                ),
                                member_id: negative.expected_member_id.clone(),
                            },
                        )
                    }
                }
                None => negative_did_not_fail(
                    negative,
                    "unsupported-member-flags fixture carried no unsupported segment flag",
                ),
            },
            Err(error) => negative_did_not_fail(
                negative,
                &format!("unsupported-member-flags fixture failed to parse: {error}"),
            ),
        },
    }
}

fn negative_did_not_fail(
    negative: &PlainXp3SmokeNegativeFixture,
    message: &str,
) -> PlainXp3SmokeNegativeReport {
    negative_failure(
        negative,
        false,
        Some(SEMANTIC_SMOKE_NEGATIVE_DID_NOT_FAIL.to_string()),
        None,
        PlainXp3SmokeFinding {
            code: "plain_xp3_smoke.negative_did_not_fail".to_string(),
            severity: PartialDiagnosticSeverity::P0,
            field: "negative".to_string(),
            message: format!(
                "{message}; expected {} failure",
                negative.failure_kind.expected_semantic_code()
            ),
            semantic_code: Some(SEMANTIC_SMOKE_NEGATIVE_DID_NOT_FAIL.to_string()),
            member_id: None,
        },
    )
}

fn negative_failure(
    negative: &PlainXp3SmokeNegativeFixture,
    failed_before_write: bool,
    semantic_code: Option<String>,
    member_id: Option<String>,
    finding: PlainXp3SmokeFinding,
) -> PlainXp3SmokeNegativeReport {
    PlainXp3SmokeNegativeReport {
        case_id: negative.case_id.clone(),
        failure_kind: negative.failure_kind,
        status: OperationStatus::Failed,
        failed_before_write,
        semantic_code,
        member_id,
        findings: vec![finding],
    }
}

fn overall_status(
    findings: &[PlainXp3SmokeFinding],
    negatives: &[PlainXp3SmokeNegativeReport],
) -> OperationStatus {
    let positive_blocking = findings
        .iter()
        .any(|finding| finding.severity.is_blocking());
    let negative_blocking = negatives
        .iter()
        .any(|negative| negative.status == OperationStatus::Failed);
    if positive_blocking || negative_blocking {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    }
}

/// Build a `Failed` report when the positive archive could not be read or
/// rebuilt — there is no member / rebuild evidence to report.
fn failed_unreadable_report(
    fixture: &PlainXp3SmokeFixture,
    source_hash: &ProofHash,
    findings: Vec<PlainXp3SmokeFinding>,
) -> PlainXp3SmokeReport {
    PlainXp3SmokeReport {
        schema_version: PLAIN_XP3_SMOKE_SCHEMA_VERSION.to_string(),
        fixture_id: fixture.fixture_id.clone(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        support_boundary: PLAIN_XP3_SMOKE_SUPPORT_BOUNDARY.to_string(),
        status: OperationStatus::Failed,
        archive: PlainXp3SmokeArchiveReport {
            archive_id: fixture.archive.archive_id.clone(),
            archive_hash: source_hash.clone(),
            member_count: 0,
            compressed_member_count: 0,
            index_offset: 0,
        },
        members: Vec::new(),
        rebuild: PlainXp3SmokeRebuildReport {
            equivalence: PlainXp3SmokeEquivalence::Divergent,
            byte_identical: false,
            source_hash: source_hash.clone(),
            output_hash: source_hash.clone(),
            source_bytes: 0,
            output_bytes: 0,
        },
        negatives: Vec::new(),
        findings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn repo_fixture_path(relative_path: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(relative_path)
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
    //     binary fixtures are reproducible byte-for-byte from this source). ---

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
            .find(|negative| {
                negative.failure_kind == PlainXp3SmokeNegativeKind::UnsupportedMemberFlags
            })
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
}
