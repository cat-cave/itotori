use super::*;

pub fn read_bgi_bytecode_fixture(path: &Path) -> KaifuuResult<BgiBytecodeFixture> {
    read_json(path)
}

pub fn run_bgi_bytecode_fixture(fixture: &BgiBytecodeFixture) -> BgiBytecodeReport {
    let entries: Vec<BgiBytecodeEntryReport> = fixture
        .entries
        .iter()
        .map(|entry| run_entry(entry, &fixture.source_node_id, &fixture.engine_family))
        .collect();
    let status = if entries
        .iter()
        .all(|entry| matches!(entry.status, OperationStatus::Passed))
    {
        OperationStatus::Passed
    } else {
        OperationStatus::Failed
    };

    BgiBytecodeReport {
        schema_version: BGI_BYTECODE_REPORT_SCHEMA_VERSION.to_string(),
        profile_set_id: fixture.profile_set_id.clone(),
        source_node_id: fixture.source_node_id.clone(),
        engine_family: fixture.engine_family.clone(),
        support_boundary: BGI_BYTECODE_SUPPORT_BOUNDARY.to_string(),
        status,
        entries,
    }
}

pub fn parse_bgi_bytecode_entry(
    entry: &BgiBytecodeFixtureEntry,
) -> Result<Vec<BgiBytecodeStringReference>, BgiBytecodeParseError> {
    let bytes = decode_hex(&entry.source_bytes_hex)
        .map_err(|message| parse_error("invalid_source_bytes_hex", "sourceBytesHex", message))?;
    parse_bgi_bytecode(&bytes, entry.variant)
}

pub fn patch_bgi_bytecode_entry(
    entry: &BgiBytecodeFixtureEntry,
    patch_cases: &[BgiBytecodePatchCase],
) -> Result<(Vec<u8>, Vec<BgiBytecodePatchReport>), BgiBytecodePatchError> {
    let bytes = decode_hex(&entry.source_bytes_hex)
        .map_err(|message| patch_error("invalid_source_bytes_hex", "sourceBytesHex", message))?;
    patch_bgi_bytecode(&bytes, entry.variant, patch_cases)
}

pub fn detect_bgi_bytecode_variant(bytes: &[u8]) -> BgiBytecodeVariant {
    if bytes.starts_with(BGI_HEADER_MAGIC) {
        BgiBytecodeVariant::Header
    } else {
        BgiBytecodeVariant::NoHeader
    }
}

pub fn parse_bgi_bytecode_bytes(
    bytes: &[u8],
) -> Result<(BgiBytecodeVariant, Vec<BgiBytecodeStringReference>), BgiBytecodeParseError> {
    let variant = detect_bgi_bytecode_variant(bytes);
    parse_bgi_bytecode(bytes, variant).map(|references| (variant, references))
}

pub fn patch_bgi_bytecode_bytes(
    source_bytes: &[u8],
    patch_cases: &[BgiBytecodePatchCase],
) -> Result<(BgiBytecodeVariant, Vec<u8>, Vec<BgiBytecodePatchReport>), BgiBytecodePatchError> {
    let variant = detect_bgi_bytecode_variant(source_bytes);
    let (patched, reports) = patch_bgi_bytecode(source_bytes, variant, patch_cases)?;
    Ok((variant, patched, reports))
}

fn run_entry(
    entry: &BgiBytecodeFixtureEntry,
    source_node_id: &str,
    engine_family: &str,
) -> BgiBytecodeEntryReport {
    let mut diagnostics = Vec::new();
    if engine_family != crate::BGI_ENGINE_FAMILY {
        diagnostics.push(BgiBytecodeDiagnostic::new(
            "wrong_engine_family",
            "engineFamily",
            format!("BGI bytecode profiles require engineFamily=bgi, got {engine_family}"),
        ));
    }
    if entry.container != BgiBytecodeContainer::Bytecode {
        diagnostics.push(BgiBytecodeDiagnostic::new(
            "wrong_container",
            "container",
            "BGI bytecode parser profiles require container=bytecode",
        ));
    }
    if entry.crypto != BgiBytecodeCrypto::None {
        diagnostics.push(BgiBytecodeDiagnostic::new(
            "wrong_crypto",
            "crypto",
            "BGI bytecode parser profiles require crypto=none",
        ));
    }
    if entry.codec != BgiBytecodeCodec::ShiftJis {
        diagnostics.push(BgiBytecodeDiagnostic::new(
            "wrong_codec",
            "codec",
            "BGI bytecode parser profiles require codec=shift_jis",
        ));
    }

    let source_bytes = match decode_hex(&entry.source_bytes_hex) {
        Ok(bytes) => bytes,
        Err(message) => {
            diagnostics.push(BgiBytecodeDiagnostic::new(
                "invalid_source_bytes_hex",
                "sourceBytesHex",
                message,
            ));
            Vec::new()
        }
    };
    let source_hash = proof_hash_for_bytes(&source_bytes);
    if entry.proof_hashes != vec![source_hash.clone()] {
        diagnostics.push(BgiBytecodeDiagnostic::new(
            "proof_hash_mismatch",
            "proofHashes",
            format!(
                "record proof hash did not match synthetic source bytes {}",
                source_hash.as_str()
            ),
        ));
    }

    let string_references = if source_bytes.is_empty() {
        Vec::new()
    } else {
        match parse_bgi_bytecode(&source_bytes, entry.variant) {
            Ok(references) => {
                if references != entry.expected_string_references {
                    diagnostics.push(BgiBytecodeDiagnostic::new(
                        "string_reference_surface_mismatch",
                        "expectedStringReferences",
                        "parsed string-reference surfaces do not match fixture expectations",
                    ));
                }
                references
            }
            Err(error) => {
                diagnostics.push(error.diagnostic);
                Vec::new()
            }
        }
    };

    // Claimed-support honesty: an entry that claims patch support with no
    // patchCases must fail loud. A genuine parse/negative-only entry
    // (`claims_patch_support == false`) may omit patch cases without error.
    let patch_reports = if entry.claims_patch_support && entry.patch_cases.is_empty() {
        diagnostics.push(BgiBytecodeDiagnostic::new(
            "claimed_patch_cases_missing",
            "patchCases",
            "entry claims patch support but declares no patchCases (claimed-support failures must fail loud, not silently skip)",
        ));
        Vec::new()
    } else if source_bytes.is_empty() || entry.patch_cases.is_empty() {
        Vec::new()
    } else {
        match patch_bgi_bytecode(&source_bytes, entry.variant, &entry.patch_cases) {
            Ok((_, reports)) => reports,
            Err(error) => {
                diagnostics.push(error.diagnostic);
                Vec::new()
            }
        }
    };

    let negative_cases = entry
        .negative_cases
        .iter()
        .map(|case| run_negative_case(case, entry.variant, &mut diagnostics))
        .collect();

    let status = if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity.is_blocking())
    {
        OperationStatus::Failed
    } else {
        OperationStatus::Passed
    };

    BgiBytecodeEntryReport {
        fixture_id: entry.fixture_id.clone(),
        source_node_id: source_node_id.to_string(),
        engine_family: engine_family.to_string(),
        variant: entry.variant,
        profile: entry.profile,
        container: entry.container,
        crypto: entry.crypto,
        codec: entry.codec,
        surface: entry.surface,
        parser_surface: entry.parser_surface.clone(),
        source_hash,
        proof_hashes: entry.proof_hashes.clone(),
        string_references,
        patch_reports,
        negative_cases,
        diagnostics,
        status,
    }
}

fn run_negative_case(
    case: &BgiBytecodeNegativeCase,
    variant: BgiBytecodeVariant,
    diagnostics: &mut Vec<BgiBytecodeDiagnostic>,
) -> BgiBytecodeNegativeCaseReport {
    let bytes = match decode_hex(&case.source_bytes_hex) {
        Ok(bytes) => bytes,
        Err(message) => {
            diagnostics.push(BgiBytecodeDiagnostic::new(
                "negative_case_invalid_source_bytes_hex",
                format!("negativeCases.{}", case.case_id),
                message,
            ));
            return BgiBytecodeNegativeCaseReport {
                case_id: case.case_id.clone(),
                expected_diagnostic_code: case.expected_diagnostic_code.clone(),
                observed_diagnostic_code: None,
                rejected: false,
            };
        }
    };

    match parse_bgi_bytecode(&bytes, variant) {
        Ok(_) => {
            diagnostics.push(BgiBytecodeDiagnostic::new(
                "negative_case_not_rejected",
                format!("negativeCases.{}", case.case_id),
                "malformed BGI bytecode fixture was accepted",
            ));
            BgiBytecodeNegativeCaseReport {
                case_id: case.case_id.clone(),
                expected_diagnostic_code: case.expected_diagnostic_code.clone(),
                observed_diagnostic_code: None,
                rejected: false,
            }
        }
        Err(error) => {
            let observed = error.diagnostic.code;
            let rejected = observed == case.expected_diagnostic_code;
            if !rejected {
                diagnostics.push(BgiBytecodeDiagnostic::new(
                    "negative_case_diagnostic_mismatch",
                    format!("negativeCases.{}", case.case_id),
                    format!(
                        "malformed BGI bytecode produced {observed}, expected {}",
                        case.expected_diagnostic_code
                    ),
                ));
            }
            BgiBytecodeNegativeCaseReport {
                case_id: case.case_id.clone(),
                expected_diagnostic_code: case.expected_diagnostic_code.clone(),
                observed_diagnostic_code: Some(observed),
                rejected,
            }
        }
    }
}

pub(super) fn decode_hex(hex: &str) -> Result<Vec<u8>, String> {
    let hex = hex.trim();
    if !hex.len().is_multiple_of(2) {
        return Err("hex byte string must have an even number of digits".to_string());
    }
    let mut bytes = Vec::with_capacity(hex.len() / 2);
    let mut index = 0;
    while index < hex.len() {
        let byte = u8::from_str_radix(&hex[index..index + 2], 16)
            .map_err(|_| format!("invalid hex byte at offset {index}"))?;
        bytes.push(byte);
        index += 2;
    }
    Ok(bytes)
}

pub(super) fn encode_shift_jis(text: &str) -> Result<Vec<u8>, String> {
    let (encoded, _, had_errors) = SHIFT_JIS.encode(text);
    if had_errors {
        return Err("replacement text is not encodable as Shift-JIS".to_string());
    }
    Ok(encoded.into_owned())
}

pub(super) fn proof_hash_for_bytes(bytes: &[u8]) -> ProofHash {
    ProofHash::new(sha256_hash_bytes(bytes)).expect("sha256 hash is canonical")
}

pub(super) fn parse_error(
    code: impl Into<String>,
    field: impl Into<String>,
    message: impl Into<String>,
) -> BgiBytecodeParseError {
    BgiBytecodeParseError {
        diagnostic: BgiBytecodeDiagnostic::new(code, field, message),
    }
}

pub(super) fn patch_error(
    code: impl Into<String>,
    field: impl Into<String>,
    message: impl Into<String>,
) -> BgiBytecodePatchError {
    BgiBytecodePatchError {
        diagnostic: BgiBytecodeDiagnostic::new(code, field, message),
    }
}
