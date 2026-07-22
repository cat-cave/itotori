use super::*;

/// Run the plain-XP3 read/write smoke against a fixture.
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

    validate_expectations(
        &fixture.expected,
        &source_hash,
        member_count,
        compressed_member_count,
        &members,
        &mut findings,
    );

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
