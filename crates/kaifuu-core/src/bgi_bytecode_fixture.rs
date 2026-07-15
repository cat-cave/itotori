//! - BGI / Ethornell bytecode parser-surface fixtures.
//!   This slice records synthetic extensionless BGI scenario-bytecode profiles,
//!   separate from the archive detector fixtures. It covers the two
//!   public parser shapes: the `BurikoCompiledScriptVer1.00\0` header variant
//!   and the no-header variant. The parser records code-size-relative
//!   Shift-JIS string references and proves length-preserving patch-back over
//!   those references; it does not claim opcode execution, archive parsing,
//!   encryption, compression, or relocated string storage.

use std::path::Path;

use encoding_rs::SHIFT_JIS;
use serde::{Deserialize, Serialize};

use crate::{
    KaifuuResult, OperationStatus, PartialDiagnosticSeverity, PatchBackTransform, ProofHash,
    SurfaceTransform, read_json, redact_for_log_or_report, sha256_hash_bytes, stable_json,
};

pub const BGI_BYTECODE_FIXTURE_SCHEMA_VERSION: &str = "0.1.0";
pub const BGI_BYTECODE_REPORT_SCHEMA_VERSION: &str = "0.1.0";
pub const BGI_BYTECODE_SUPPORT_BOUNDARY: &str = "BGI/Ethornell bytecode parser-surface fixtures are synthetic extensionless scenario bytecode only. They record header and no-header profile variants plus Shift-JIS string-reference surfaces, then prove length-preserving extract-to-patch round-trips over those references. They do not parse BURIKO ARC20 archives, decrypt/compress payloads, execute opcodes, relocate string storage, or claim production adapter coverage.";

const BGI_HEADER_MAGIC: &[u8] = b"BurikoCompiledScriptVer1.00\0";
const BGI_HEADER_BASE_SIZE: usize = 0x1c;
const BGI_HEADER_ADDITIONAL_SIZE_OFFSET: usize = 0x1c;
const BGI_CODE_TERMINATOR: [u8; 4] = [0x1b, 0x00, 0x00, 0x00];
const BGI_STRING_TYPE: u32 = 0x03;
const BGI_FILE_TYPE: u32 = 0x7f;
const BGI_TEXT_FUNCTION: u32 = 0x140;
const BGI_BACKLOG_FUNCTION: u32 = 0x143;
const BGI_RUBY_FUNCTION: u32 = 0x14b;

mod parser;

use parser::{code_start_for_variant, find_code_end, parse_bgi_bytecode};

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
    /// When true, this entry claims extract-to-patch support and empty
    /// [`Self::patch_cases`] is a loud claimed-support failure (not a silent skip).
    /// Parse / negative-only entries leave this false and may omit patch cases.
    #[serde(default)]
    pub claims_patch_support: bool,
    #[serde(default)]
    pub patch_cases: Vec<BgiBytecodePatchCase>,
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
pub struct BgiBytecodePatchCase {
    pub patch_id: String,
    pub reference_id: String,
    pub replacement_text: String,
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
    pub patch_reports: Vec<BgiBytecodePatchReport>,
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
            patch_reports: self
                .patch_reports
                .iter()
                .map(BgiBytecodePatchReport::redacted_for_report)
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
pub struct BgiBytecodePatchReport {
    pub patch_id: String,
    pub reference_id: String,
    pub patch_back: PatchBackTransform,
    pub original_text: String,
    pub replacement_text: String,
    pub original_byte_len: u64,
    pub replacement_byte_len: u64,
    pub source_hash: ProofHash,
    pub patched_hash: ProofHash,
    pub patched_text_verified: bool,
    pub untouched_bytes_identical: bool,
}

impl BgiBytecodePatchReport {
    fn redacted_for_report(&self) -> Self {
        Self {
            patch_id: redact_for_log_or_report(&self.patch_id),
            reference_id: redact_for_log_or_report(&self.reference_id),
            patch_back: self.patch_back,
            original_text: redact_for_log_or_report(&self.original_text),
            replacement_text: redact_for_log_or_report(&self.replacement_text),
            original_byte_len: self.original_byte_len,
            replacement_byte_len: self.replacement_byte_len,
            source_hash: self.source_hash.clone(),
            patched_hash: self.patched_hash.clone(),
            patched_text_verified: self.patched_text_verified,
            untouched_bytes_identical: self.untouched_bytes_identical,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BgiBytecodePatchError {
    pub diagnostic: BgiBytecodeDiagnostic,
}

impl std::fmt::Display for BgiBytecodePatchError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{} at {}: {}",
            self.diagnostic.code, self.diagnostic.field, self.diagnostic.message
        )
    }
}

impl std::error::Error for BgiBytecodePatchError {}

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

fn patch_bgi_bytecode(
    source_bytes: &[u8],
    variant: BgiBytecodeVariant,
    patch_cases: &[BgiBytecodePatchCase],
) -> Result<(Vec<u8>, Vec<BgiBytecodePatchReport>), BgiBytecodePatchError> {
    let references =
        parse_bgi_bytecode(source_bytes, variant).map_err(|error| BgiBytecodePatchError {
            diagnostic: error.diagnostic,
        })?;
    let code_start =
        code_start_for_variant(source_bytes, variant).map_err(|error| BgiBytecodePatchError {
            diagnostic: error.diagnostic,
        })?;
    let code_end =
        find_code_end(source_bytes, code_start).map_err(|error| BgiBytecodePatchError {
            diagnostic: error.diagnostic,
        })?;
    let code_size = code_end - code_start;
    let mut patched_prefix = source_bytes[..code_end].to_vec();
    let mut replacement_by_slot = std::collections::BTreeMap::<(u64, u64, u64), Vec<u8>>::new();
    let mut reports = Vec::with_capacity(patch_cases.len());
    let source_hash = proof_hash_for_bytes(source_bytes);

    for patch in patch_cases {
        let reference = references
            .iter()
            .find(|reference| reference.reference_id == patch.reference_id)
            .ok_or_else(|| {
                patch_error(
                    "patch_reference_not_found",
                    format!("patchCases.{}", patch.patch_id),
                    format!(
                        "patch case referenced unknown BGI string reference {}",
                        patch.reference_id
                    ),
                )
            })?;
        let replacement = encode_shift_jis(&patch.replacement_text).map_err(|message| {
            patch_error(
                "patch_replacement_not_shift_jis",
                format!("patchCases.{}", patch.patch_id),
                message,
            )
        })?;
        if replacement.contains(&0) {
            return Err(patch_error(
                "patch_replacement_contains_nul",
                format!("patchCases.{}", patch.patch_id),
                "BGI replacement strings must not contain embedded NUL bytes",
            ));
        }

        let slot = (
            reference.string_start_byte,
            reference.string_end_byte,
            reference.terminator_byte,
        );
        if let Some(previous) = replacement_by_slot.get(&slot)
            && previous != &replacement
        {
            return Err(patch_error(
                "patch_overlaps_previous_patch",
                format!("patchCases.{}", patch.patch_id),
                "BGI patch cases targeting the same string slot must use the same replacement text",
            ));
        }
        replacement_by_slot.insert(slot, replacement.clone());
        reports.push(BgiBytecodePatchReport {
            patch_id: patch.patch_id.clone(),
            reference_id: patch.reference_id.clone(),
            patch_back: PatchBackTransform::RecompileBytecode,
            original_text: reference.decoded_text.clone(),
            replacement_text: patch.replacement_text.clone(),
            original_byte_len: reference.string_end_byte - reference.string_start_byte,
            replacement_byte_len: replacement.len() as u64,
            source_hash: source_hash.clone(),
            patched_hash: source_hash.clone(),
            patched_text_verified: false,
            untouched_bytes_identical: false,
        });
    }

    let mut slots = references
        .iter()
        .map(|reference| {
            (
                reference.string_start_byte,
                reference.string_end_byte,
                reference.terminator_byte,
            )
        })
        .collect::<Vec<_>>();
    slots.sort_unstable();
    slots.dedup();

    let mut cursor = code_end;
    let mut rebuilt_text = Vec::new();
    for (string_start, string_end, terminator) in slots {
        let start = usize::try_from(string_start).map_err(|_| {
            patch_error(
                "patch_range_out_of_bounds",
                "stringReferences",
                "BGI string start offset does not fit in memory",
            )
        })?;
        let end = usize::try_from(string_end).map_err(|_| {
            patch_error(
                "patch_range_out_of_bounds",
                "stringReferences",
                "BGI string end offset does not fit in memory",
            )
        })?;
        let term = usize::try_from(terminator).map_err(|_| {
            patch_error(
                "patch_range_out_of_bounds",
                "stringReferences",
                "BGI string terminator offset does not fit in memory",
            )
        })?;
        if start < cursor || end > term || term >= source_bytes.len() {
            return Err(patch_error(
                "patch_range_out_of_bounds",
                "stringReferences",
                "BGI string-reference byte range is outside the source buffer or overlaps a previous slot",
            ));
        }

        rebuilt_text.extend_from_slice(&source_bytes[cursor..start]);
        let new_relative = rebuilt_text.len();
        let pointer = u32::try_from(code_size + new_relative).map_err(|_| {
            patch_error(
                "patch_pointer_overflow",
                "stringReferences",
                "rebuilt BGI string table exceeds the 32-bit code-size-relative pointer range",
            )
        })?;
        for reference in references.iter().filter(|reference| {
            reference.string_start_byte == string_start
                && reference.string_end_byte == string_end
                && reference.terminator_byte == terminator
        }) {
            let pointer_offset = usize::try_from(reference.pointer_offset_byte).map_err(|_| {
                patch_error(
                    "patch_range_out_of_bounds",
                    "stringReferences",
                    "BGI pointer offset does not fit in memory",
                )
            })?;
            let pointer_end = pointer_offset.checked_add(4).ok_or_else(|| {
                patch_error(
                    "patch_range_out_of_bounds",
                    "stringReferences",
                    "BGI pointer offset overflows",
                )
            })?;
            let Some(slot) = patched_prefix.get_mut(pointer_offset..pointer_end) else {
                return Err(patch_error(
                    "patch_range_out_of_bounds",
                    "stringReferences",
                    "BGI pointer field is outside the code prefix",
                ));
            };
            slot.copy_from_slice(&pointer.to_le_bytes());
        }

        if let Some(replacement) = replacement_by_slot.get(&(string_start, string_end, terminator))
        {
            rebuilt_text.extend_from_slice(replacement);
        } else {
            rebuilt_text.extend_from_slice(&source_bytes[start..end]);
        }
        rebuilt_text.push(0);
        cursor = term + 1;
    }
    rebuilt_text.extend_from_slice(&source_bytes[cursor..]);

    let mut patched = patched_prefix;
    patched.extend_from_slice(&rebuilt_text);

    let reparsed =
        parse_bgi_bytecode(&patched, variant).map_err(|error| BgiBytecodePatchError {
            diagnostic: error.diagnostic,
        })?;
    let patched_hash = proof_hash_for_bytes(&patched);
    for report in &mut reports {
        let reparsed_reference = reparsed
            .iter()
            .find(|reference| reference.reference_id == report.reference_id)
            .ok_or_else(|| {
                patch_error(
                    "patched_reference_missing_after_reparse",
                    format!("patchCases.{}", report.patch_id),
                    "patched BGI bytecode no longer exposes the target string reference",
                )
            })?;
        report.patched_text_verified = reparsed_reference.decoded_text == report.replacement_text;
        report.untouched_bytes_identical = string_table_gaps_identical(
            source_bytes,
            &patched,
            variant,
            &references,
            &reparsed,
            &replacement_by_slot,
        );
        report.patched_hash = patched_hash.clone();
        if !report.patched_text_verified {
            return Err(patch_error(
                "patched_text_not_verified",
                format!("patchCases.{}", report.patch_id),
                "patched BGI bytecode did not reparse to the requested replacement text",
            ));
        }
        if !report.untouched_bytes_identical {
            return Err(patch_error(
                "patch_untouched_bytes_changed",
                format!("patchCases.{}", report.patch_id),
                "BGI patch changed non-string bytes or unpatched string contents",
            ));
        }
    }

    Ok((patched, reports))
}

fn string_table_gaps_identical(
    source_bytes: &[u8],
    patched_bytes: &[u8],
    variant: BgiBytecodeVariant,
    original: &[BgiBytecodeStringReference],
    reparsed: &[BgiBytecodeStringReference],
    replaced_slots: &std::collections::BTreeMap<(u64, u64, u64), Vec<u8>>,
) -> bool {
    let Ok(code_start) = code_start_for_variant(source_bytes, variant) else {
        return false;
    };
    let Ok(code_end) = find_code_end(source_bytes, code_start) else {
        return false;
    };
    if patched_bytes.len() < code_end || source_bytes[..code_start] != patched_bytes[..code_start] {
        return false;
    }
    let pointer_ranges = original
        .iter()
        .filter_map(|reference| {
            let start = usize::try_from(reference.pointer_offset_byte).ok()?;
            Some(start..start + 4)
        })
        .collect::<Vec<_>>();
    for index in code_start..code_end {
        if pointer_ranges.iter().any(|range| range.contains(&index)) {
            continue;
        }
        if source_bytes.get(index) != patched_bytes.get(index) {
            return false;
        }
    }
    original.iter().all(|reference| {
        let slot = (
            reference.string_start_byte,
            reference.string_end_byte,
            reference.terminator_byte,
        );
        if replaced_slots.contains_key(&slot) {
            return true;
        }
        reparsed
            .iter()
            .find(|candidate| candidate.reference_id == reference.reference_id)
            .is_some_and(|candidate| candidate.decoded_text == reference.decoded_text)
    })
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

fn encode_shift_jis(text: &str) -> Result<Vec<u8>, String> {
    let (encoded, _, had_errors) = SHIFT_JIS.encode(text);
    if had_errors {
        return Err("replacement text is not encodable as Shift-JIS".to_string());
    }
    Ok(encoded.into_owned())
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

fn patch_error(
    code: impl Into<String>,
    field: impl Into<String>,
    message: impl Into<String>,
) -> BgiBytecodePatchError {
    BgiBytecodePatchError {
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
                && case.observed_diagnostic_code.as_deref()
                    == Some("missing_string_reference_surface")
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
            assert!(reports.iter().all(|report| {
                report.patched_text_verified && report.untouched_bytes_identical
            }));
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
}
