//! KAIFUU-127 - BGI / Ethornell bytecode parser-surface fixtures.
//!
//! This slice records synthetic extensionless BGI scenario-bytecode profiles,
//! separate from the KAIFUU-126 archive detector fixtures. It covers the two
//! public parser shapes: the `BurikoCompiledScriptVer1.00\0` header variant
//! and the no-header variant. The parser records code-size-relative
//! Shift-JIS string references only; it does not claim opcode execution,
//! archive parsing, encryption, compression, or patch-back.

use std::path::Path;

use encoding_rs::SHIFT_JIS;
use serde::{Deserialize, Serialize};

use crate::{
    KaifuuResult, OperationStatus, PartialDiagnosticSeverity, ProofHash, SurfaceTransform,
    read_json, redact_for_log_or_report, sha256_hash_bytes, stable_json,
};

pub const BGI_BYTECODE_FIXTURE_SCHEMA_VERSION: &str = "0.1.0";
pub const BGI_BYTECODE_REPORT_SCHEMA_VERSION: &str = "0.1.0";
pub const BGI_BYTECODE_SUPPORT_BOUNDARY: &str = "BGI/Ethornell bytecode parser-surface fixtures are synthetic extensionless scenario bytecode only. They record header and no-header profile variants plus Shift-JIS string-reference surfaces. They do not parse BURIKO ARC20 archives, decrypt/compress payloads, execute opcodes, or claim patch-back.";

const BGI_HEADER_MAGIC: &[u8] = b"BurikoCompiledScriptVer1.00\0";
const BGI_HEADER_BASE_SIZE: usize = 0x1c;
const BGI_HEADER_ADDITIONAL_SIZE_OFFSET: usize = 0x1c;
const BGI_CODE_TERMINATOR: [u8; 4] = [0x1b, 0x00, 0x00, 0x00];
const BGI_STRING_TYPE: u32 = 0x03;
const BGI_FILE_TYPE: u32 = 0x7f;
const BGI_TEXT_FUNCTION: u32 = 0x140;
const BGI_BACKLOG_FUNCTION: u32 = 0x143;
const BGI_RUBY_FUNCTION: u32 = 0x14b;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BgiBytecodeProfile {
    HeaderBytecode,
    NoHeaderBytecode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BgiBytecodeVariant {
    Header,
    NoHeader,
}

impl BgiBytecodeVariant {
    fn config(self) -> BgiBytecodeReferenceConfig {
        match self {
            Self::Header => BgiBytecodeReferenceConfig {
                name_probe: 0x0c,
                dialogue_probe: 0x04,
                ruby_kanji_slot: 0x04,
                ruby_furigana_slot: 0x0c,
                backlog_call: 0x0c,
            },
            Self::NoHeader => BgiBytecodeReferenceConfig {
                name_probe: 0x24,
                dialogue_probe: 0x2c,
                ruby_kanji_slot: 0x14,
                ruby_furigana_slot: 0x0c,
                backlog_call: 0x0c,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BgiBytecodeContainer {
    Bytecode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BgiBytecodeCrypto {
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BgiBytecodeCodec {
    ShiftJis,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BgiBytecodeSurface {
    StringReference,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BgiBytecodeTextSurface {
    CharacterName,
    Dialogue,
    Backlog,
    RubyKanji,
    RubyFurigana,
    Other,
    FileReference,
}

impl BgiBytecodeTextSurface {
    fn parser_opcode(self) -> &'static str {
        match self {
            Self::CharacterName => "bgi.string_ref.text_function.name",
            Self::Dialogue => "bgi.string_ref.text_function.dialogue",
            Self::Backlog => "bgi.string_ref.backlog",
            Self::RubyKanji => "bgi.string_ref.ruby.kanji",
            Self::RubyFurigana => "bgi.string_ref.ruby.furigana",
            Self::Other => "bgi.string_ref.other",
            Self::FileReference => "bgi.string_ref.file",
        }
    }

    fn id_fragment(self) -> &'static str {
        match self {
            Self::CharacterName => "name",
            Self::Dialogue => "dialogue",
            Self::Backlog => "backlog",
            Self::RubyKanji => "ruby_kanji",
            Self::RubyFurigana => "ruby_furigana",
            Self::Other => "other",
            Self::FileReference => "file",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BgiBytecodeFixture {
    pub schema_version: String,
    pub profile_set_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub entries: Vec<BgiBytecodeFixtureEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BgiBytecodeFixtureEntry {
    pub fixture_id: String,
    pub variant: BgiBytecodeVariant,
    pub profile: BgiBytecodeProfile,
    pub container: BgiBytecodeContainer,
    pub crypto: BgiBytecodeCrypto,
    pub codec: BgiBytecodeCodec,
    pub surface: BgiBytecodeSurface,
    pub parser_surface: BgiBytecodeParserSurface,
    pub source_bytes_hex: String,
    pub expected_string_references: Vec<BgiBytecodeStringReference>,
    #[serde(default)]
    pub negative_cases: Vec<BgiBytecodeNegativeCase>,
    pub proof_hashes: Vec<ProofHash>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BgiBytecodeParserSurface {
    pub surface_transform: SurfaceTransform,
    pub entry_point_byte: u64,
    #[serde(default)]
    pub header_magic: Option<String>,
    pub header_size_bytes: u64,
    pub code_start_byte: u64,
    pub code_end_sentinel_hex: String,
    pub pointer_base: String,
    pub string_terminator_hex: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BgiBytecodeStringReference {
    pub reference_id: String,
    pub text_surface: BgiBytecodeTextSurface,
    pub parser_opcode: String,
    pub pointer_offset_byte: u64,
    pub pointer_value: u32,
    pub string_start_byte: u64,
    pub string_end_byte: u64,
    pub terminator_byte: u64,
    pub decoded_text: String,
}

impl BgiBytecodeStringReference {
    fn redacted_for_report(&self) -> Self {
        Self {
            reference_id: redact_for_log_or_report(&self.reference_id),
            text_surface: self.text_surface,
            parser_opcode: redact_for_log_or_report(&self.parser_opcode),
            pointer_offset_byte: self.pointer_offset_byte,
            pointer_value: self.pointer_value,
            string_start_byte: self.string_start_byte,
            string_end_byte: self.string_end_byte,
            terminator_byte: self.terminator_byte,
            decoded_text: redact_for_log_or_report(&self.decoded_text),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BgiBytecodeNegativeCase {
    pub case_id: String,
    pub description: String,
    pub source_bytes_hex: String,
    pub expected_diagnostic_code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgiBytecodeDiagnostic {
    pub code: String,
    pub severity: PartialDiagnosticSeverity,
    pub field: String,
    pub message: String,
}

impl BgiBytecodeDiagnostic {
    fn new(code: impl Into<String>, field: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            severity: PartialDiagnosticSeverity::P0,
            field: field.into(),
            message: message.into(),
        }
    }

    fn redacted_for_report(&self) -> Self {
        Self {
            code: redact_for_log_or_report(&self.code),
            severity: self.severity,
            field: redact_for_log_or_report(&self.field),
            message: redact_for_log_or_report(&self.message),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgiBytecodeEntryReport {
    pub fixture_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub variant: BgiBytecodeVariant,
    pub profile: BgiBytecodeProfile,
    pub container: BgiBytecodeContainer,
    pub crypto: BgiBytecodeCrypto,
    pub codec: BgiBytecodeCodec,
    pub surface: BgiBytecodeSurface,
    pub parser_surface: BgiBytecodeParserSurface,
    pub source_hash: ProofHash,
    pub proof_hashes: Vec<ProofHash>,
    pub string_references: Vec<BgiBytecodeStringReference>,
    pub negative_cases: Vec<BgiBytecodeNegativeCaseReport>,
    pub diagnostics: Vec<BgiBytecodeDiagnostic>,
    pub status: OperationStatus,
}

impl BgiBytecodeEntryReport {
    pub fn redacted_for_report(&self) -> Self {
        Self {
            fixture_id: redact_for_log_or_report(&self.fixture_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            variant: self.variant,
            profile: self.profile,
            container: self.container,
            crypto: self.crypto,
            codec: self.codec,
            surface: self.surface,
            parser_surface: self.parser_surface.clone(),
            source_hash: self.source_hash.clone(),
            proof_hashes: self.proof_hashes.clone(),
            string_references: self
                .string_references
                .iter()
                .map(BgiBytecodeStringReference::redacted_for_report)
                .collect(),
            negative_cases: self
                .negative_cases
                .iter()
                .map(BgiBytecodeNegativeCaseReport::redacted_for_report)
                .collect(),
            diagnostics: self
                .diagnostics
                .iter()
                .map(BgiBytecodeDiagnostic::redacted_for_report)
                .collect(),
            status: self.status.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgiBytecodeNegativeCaseReport {
    pub case_id: String,
    pub expected_diagnostic_code: String,
    pub observed_diagnostic_code: Option<String>,
    pub rejected: bool,
}

impl BgiBytecodeNegativeCaseReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            case_id: redact_for_log_or_report(&self.case_id),
            expected_diagnostic_code: redact_for_log_or_report(&self.expected_diagnostic_code),
            observed_diagnostic_code: self
                .observed_diagnostic_code
                .as_deref()
                .map(redact_for_log_or_report),
            rejected: self.rejected,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgiBytecodeReport {
    pub schema_version: String,
    pub profile_set_id: String,
    pub source_node_id: String,
    pub engine_family: String,
    pub support_boundary: String,
    pub status: OperationStatus,
    pub entries: Vec<BgiBytecodeEntryReport>,
}

impl BgiBytecodeReport {
    pub fn entry(&self, fixture_id: &str) -> Option<&BgiBytecodeEntryReport> {
        self.entries
            .iter()
            .find(|entry| entry.fixture_id == fixture_id)
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            schema_version: self.schema_version.clone(),
            profile_set_id: redact_for_log_or_report(&self.profile_set_id),
            source_node_id: redact_for_log_or_report(&self.source_node_id),
            engine_family: redact_for_log_or_report(&self.engine_family),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            status: self.status.clone(),
            entries: self
                .entries
                .iter()
                .map(BgiBytecodeEntryReport::redacted_for_report)
                .collect(),
        }
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }
}

#[derive(Debug, Clone, Copy)]
struct BgiBytecodeReferenceConfig {
    name_probe: usize,
    dialogue_probe: usize,
    ruby_kanji_slot: usize,
    ruby_furigana_slot: usize,
    backlog_call: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BgiBytecodeParseError {
    pub diagnostic: BgiBytecodeDiagnostic,
}

impl std::fmt::Display for BgiBytecodeParseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} at {}: {}",
            self.diagnostic.code, self.diagnostic.field, self.diagnostic.message
        )
    }
}

impl std::error::Error for BgiBytecodeParseError {}

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

fn parse_bgi_bytecode(
    bytes: &[u8],
    variant: BgiBytecodeVariant,
) -> Result<Vec<BgiBytecodeStringReference>, BgiBytecodeParseError> {
    let code_start = code_start_for_variant(bytes, variant)?;
    let code_end = find_code_end(bytes, code_start)?;
    let code = &bytes[code_start..code_end];
    if !code.len().is_multiple_of(4) {
        return Err(parse_error(
            "truncated_code_dword",
            "bytecode",
            "BGI code section length must be a multiple of four bytes",
        ));
    }
    let code_size = code.len();
    let text_start = code_end;
    let text = &bytes[text_start..];
    let config = variant.config();
    let variant_id = match variant {
        BgiBytecodeVariant::Header => "header",
        BgiBytecodeVariant::NoHeader => "no_header",
    };

    let mut references = Vec::new();
    let mut counters = BgiReferenceCounters::default();
    let mut pos = 4usize;
    while pos < code.len() {
        let r#type = read_u32_le(code, pos - 4).ok_or_else(|| {
            parse_error(
                "truncated_code_dword",
                format!("bytecode@0x{:x}", code_start + pos - 4),
                "BGI string-reference type dword is truncated",
            )
        })?;
        if r#type != BGI_STRING_TYPE && r#type != BGI_FILE_TYPE {
            pos += 4;
            continue;
        }

        let pointer = read_u32_le(code, pos).ok_or_else(|| {
            parse_error(
                "truncated_code_dword",
                format!("bytecode@0x{:x}", code_start + pos),
                "BGI string-reference pointer dword is truncated",
            )
        })?;
        let Some(text_relative) = pointer.checked_sub(code_size as u32) else {
            return Err(parse_error(
                "string_pointer_out_of_bounds",
                format!("bytecode@0x{:x}", code_start + pos),
                "BGI string-reference pointer lands before the text section",
            ));
        };
        let text_relative = text_relative as usize;
        if text_relative >= text.len() {
            return Err(parse_error(
                "string_pointer_out_of_bounds",
                format!("bytecode@0x{:x}", code_start + pos),
                "BGI string-reference pointer lands beyond the text section",
            ));
        }

        let string_end_relative = text[text_relative..]
            .iter()
            .position(|byte| *byte == 0)
            .ok_or_else(|| {
                parse_error(
                    "unterminated_string",
                    format!("bytecode@0x{:x}", code_start + pos),
                    "BGI string-reference target is not NUL-terminated",
                )
            })?;
        let string_bytes = &text[text_relative..text_relative + string_end_relative];
        let (decoded, _, had_errors) = SHIFT_JIS.decode(string_bytes);
        if had_errors {
            return Err(parse_error(
                "invalid_shift_jis",
                format!("bytecode@0x{:x}", code_start + pos),
                "BGI string-reference target is not valid Shift-JIS",
            ));
        }

        let text_surface = classify_reference(r#type, code, pos, config);
        let index = counters.next(text_surface);
        let string_start = text_start + text_relative;
        let string_end = string_start + string_end_relative;
        references.push(BgiBytecodeStringReference {
            reference_id: format!("bgi.{variant_id}.{}.{index:03}", text_surface.id_fragment()),
            text_surface,
            parser_opcode: text_surface.parser_opcode().to_string(),
            pointer_offset_byte: (code_start + pos) as u64,
            pointer_value: pointer,
            string_start_byte: string_start as u64,
            string_end_byte: string_end as u64,
            terminator_byte: string_end as u64,
            decoded_text: decoded.into_owned(),
        });

        pos += 4;
    }

    if references.is_empty() {
        return Err(parse_error(
            "missing_string_reference_surface",
            "bytecode",
            "BGI bytecode profile must expose at least one string-reference surface",
        ));
    }

    Ok(references)
}

fn code_start_for_variant(
    bytes: &[u8],
    variant: BgiBytecodeVariant,
) -> Result<usize, BgiBytecodeParseError> {
    match variant {
        BgiBytecodeVariant::Header => {
            if bytes.len() < BGI_HEADER_BASE_SIZE + 4 || !bytes.starts_with(BGI_HEADER_MAGIC) {
                return Err(parse_error(
                    "malformed_header",
                    "header",
                    "BGI header bytecode must start with BurikoCompiledScriptVer1.00 NUL magic and an additional-header-size dword",
                ));
            }
            let additional =
                read_u32_le(bytes, BGI_HEADER_ADDITIONAL_SIZE_OFFSET).ok_or_else(|| {
                    parse_error(
                        "malformed_header",
                        "header.additionalHeaderSize",
                        "BGI header additional-size dword is truncated",
                    )
                })? as usize;
            let Some(code_start) = BGI_HEADER_BASE_SIZE.checked_add(additional) else {
                return Err(parse_error(
                    "malformed_header",
                    "header.additionalHeaderSize",
                    "BGI header additional-size dword overflows code start",
                ));
            };
            if code_start >= bytes.len() {
                return Err(parse_error(
                    "malformed_header",
                    "header.additionalHeaderSize",
                    "BGI header additional-size dword moves code start beyond EOF",
                ));
            }
            Ok(code_start)
        }
        BgiBytecodeVariant::NoHeader => {
            if bytes.starts_with(BGI_HEADER_MAGIC) {
                return Err(parse_error(
                    "malformed_header",
                    "header",
                    "BGI no-header bytecode profile must not carry the header-only magic",
                ));
            }
            Ok(0)
        }
    }
}

fn find_code_end(bytes: &[u8], code_start: usize) -> Result<usize, BgiBytecodeParseError> {
    bytes[code_start..]
        .windows(BGI_CODE_TERMINATOR.len())
        .rposition(|window| window == BGI_CODE_TERMINATOR)
        .map(|index| code_start + index + BGI_CODE_TERMINATOR.len())
        .ok_or_else(|| {
            parse_error(
                "missing_code_terminator",
                "bytecode",
                "BGI bytecode code section must end before the 1b000000 terminal dword",
            )
        })
}

fn classify_reference(
    r#type: u32,
    code: &[u8],
    pos: usize,
    config: BgiBytecodeReferenceConfig,
) -> BgiBytecodeTextSurface {
    if r#type == BGI_FILE_TYPE {
        return BgiBytecodeTextSurface::FileReference;
    }
    if check_code_dword(code, pos, config.name_probe, BGI_TEXT_FUNCTION) {
        BgiBytecodeTextSurface::CharacterName
    } else if check_code_dword(code, pos, config.dialogue_probe, BGI_TEXT_FUNCTION) {
        BgiBytecodeTextSurface::Dialogue
    } else if check_code_dword(code, pos, config.ruby_kanji_slot, BGI_RUBY_FUNCTION) {
        BgiBytecodeTextSurface::RubyKanji
    } else if check_code_dword(code, pos, config.ruby_furigana_slot, BGI_RUBY_FUNCTION) {
        BgiBytecodeTextSurface::RubyFurigana
    } else if check_code_dword(code, pos, config.backlog_call, BGI_BACKLOG_FUNCTION) {
        BgiBytecodeTextSurface::Backlog
    } else {
        BgiBytecodeTextSurface::Other
    }
}

fn check_code_dword(code: &[u8], pos: usize, offset: usize, expected: u32) -> bool {
    pos.checked_add(offset).and_then(|at| read_u32_le(code, at)) == Some(expected)
}

#[derive(Default)]
struct BgiReferenceCounters {
    character_name: u32,
    dialogue: u32,
    backlog: u32,
    ruby_kanji: u32,
    ruby_furigana: u32,
    other: u32,
    file_reference: u32,
}

impl BgiReferenceCounters {
    fn next(&mut self, surface: BgiBytecodeTextSurface) -> u32 {
        let counter = match surface {
            BgiBytecodeTextSurface::CharacterName => &mut self.character_name,
            BgiBytecodeTextSurface::Dialogue => &mut self.dialogue,
            BgiBytecodeTextSurface::Backlog => &mut self.backlog,
            BgiBytecodeTextSurface::RubyKanji => &mut self.ruby_kanji,
            BgiBytecodeTextSurface::RubyFurigana => &mut self.ruby_furigana,
            BgiBytecodeTextSurface::Other => &mut self.other,
            BgiBytecodeTextSurface::FileReference => &mut self.file_reference,
        };
        *counter += 1;
        *counter
    }
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(u32::from_le_bytes(slice.try_into().ok()?))
}

fn decode_hex(hex: &str) -> Result<Vec<u8>, String> {
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

fn proof_hash_for_bytes(bytes: &[u8]) -> ProofHash {
    ProofHash::new(sha256_hash_bytes(bytes)).expect("sha256 hash is canonical")
}

fn parse_error(
    code: impl Into<String>,
    field: impl Into<String>,
    message: impl Into<String>,
) -> BgiBytecodeParseError {
    BgiBytecodeParseError {
        diagnostic: BgiBytecodeDiagnostic::new(code, field, message),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

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
        assert_eq!(report.source_node_id, "KAIFUU-127");
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
            assert_eq!(entry.negative_cases.len(), 3);
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
}
