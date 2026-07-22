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
mod patch;

use parser::{code_start_for_variant, find_code_end, parse_bgi_bytecode};
use patch::patch_bgi_bytecode;

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

#[path = "bgi_bytecode_fixture/runner.rs"]
mod runner;
#[cfg(test)]
use runner::decode_hex;
pub use runner::{
    detect_bgi_bytecode_variant, parse_bgi_bytecode_bytes, parse_bgi_bytecode_entry,
    patch_bgi_bytecode_bytes, patch_bgi_bytecode_entry, read_bgi_bytecode_fixture,
    run_bgi_bytecode_fixture,
};
use runner::{encode_shift_jis, parse_error, patch_error, proof_hash_for_bytes};

#[cfg(test)]
#[path = "bgi_bytecode_fixture/tests.rs"]
mod tests;
