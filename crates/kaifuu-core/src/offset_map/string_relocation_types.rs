use std::fmt;

use serde::{Deserialize, Serialize};

use crate::{OperationStatus, ProtectedSpanMapping, RedactedContentSummary, content_hash};

use super::{
    ByteSpan, EncodedStringSlotDiagnostic, EncodedStringSlotLayout, EncodedStringSlotProtectedSpan,
    SourceEncoding,
};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StringTableRebuildRequest {
    pub fixture_id: String,
    pub source_bytes_hex: String,
    pub slots: Vec<StringRelocationSlot>,
    pub replacements: Vec<StringRelocationTarget>,
    pub references: Vec<StringRelocationReference>,
    #[serde(default)]
    pub string_slot_diagnostics: Vec<EncodedStringSlotDiagnostic>,
}

impl fmt::Debug for StringTableRebuildRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StringTableRebuildRequest")
            .field("fixture_id", &self.fixture_id)
            .field(
                "source_bytes_hex",
                &RedactedContentSummary::from_text(&self.source_bytes_hex),
            )
            .field("slots", &self.slots)
            .field("replacements", &self.replacements)
            .field("references", &self.references)
            .field("string_slot_diagnostics", &self.string_slot_diagnostics)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StringRelocationSlot {
    pub slot_id: String,
    pub encoding: SourceEncoding,
    pub old_byte_range: ByteSpan,
    pub layout: EncodedStringSlotLayout,
    #[serde(default)]
    pub protected_spans: Vec<EncodedStringSlotProtectedSpan>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StringRelocationTarget {
    pub slot_id: String,
    pub target_text: String,
    #[serde(default)]
    pub protected_span_mappings: Vec<ProtectedSpanMapping>,
}

impl fmt::Debug for StringRelocationTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StringRelocationTarget")
            .field("slot_id", &self.slot_id)
            .field(
                "target_text",
                &RedactedContentSummary::from_text(&self.target_text),
            )
            .field("protected_span_mappings", &self.protected_span_mappings)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StringRelocationReference {
    pub reference_id: String,
    pub slot_id: String,
    pub byte_range: ByteSpan,
    pub format: StringReferenceFormat,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StringReferenceFormat {
    #[serde(rename_all = "camelCase")]
    PointerLeU32 {
        base_address: u64,
    },
    IndexLeU16,
    #[serde(rename_all = "camelCase")]
    Unsupported {
        format_id: String,
    },
}

impl StringReferenceFormat {
    pub(crate) fn relocation_kind(&self) -> StringReferenceRelocationKind {
        match self {
            Self::PointerLeU32 { .. } => StringReferenceRelocationKind::PointerTable,
            Self::IndexLeU16 => StringReferenceRelocationKind::IndexTable,
            Self::Unsupported { .. } => StringReferenceRelocationKind::Unsupported,
        }
    }

    pub(crate) fn width(&self) -> u64 {
        match self {
            Self::PointerLeU32 { .. } => 4,
            Self::IndexLeU16 => 2,
            Self::Unsupported { .. } => 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StringReferenceRelocationKind {
    PointerTable,
    IndexTable,
    Unsupported,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StringRelocationPlanReport {
    pub schema_version: String,
    pub status: OperationStatus,
    pub fixture_id: String,
    pub relocated_strings: Vec<RelocatedString>,
    pub relocated_references: Vec<RelocatedStringReference>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub string_slot_diagnostics: Vec<EncodedStringSlotDiagnostic>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relocation_diagnostics: Vec<StringRelocationDiagnostic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_bytes_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_hash: Option<String>,
}

impl fmt::Debug for StringRelocationPlanReport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StringRelocationPlanReport")
            .field("schema_version", &self.schema_version)
            .field("status", &self.status)
            .field("fixture_id", &self.fixture_id)
            .field("relocated_strings", &self.relocated_strings)
            .field("relocated_references", &self.relocated_references)
            .field("string_slot_diagnostics", &self.string_slot_diagnostics)
            .field("relocation_diagnostics", &self.relocation_diagnostics)
            .field(
                "output_bytes_hex",
                &self
                    .output_bytes_hex
                    .as_deref()
                    .map(RedactedContentSummary::from_text),
            )
            .field("output_hash", &self.output_hash)
            .finish()
    }
}

impl StringRelocationPlanReport {
    pub(crate) fn failed(
        fixture_id: String,
        string_slot_diagnostics: Vec<EncodedStringSlotDiagnostic>,
        relocation_diagnostics: Vec<StringRelocationDiagnostic>,
    ) -> Self {
        Self {
            schema_version: "0.1.0".to_string(),
            status: OperationStatus::Failed,
            fixture_id,
            relocated_strings: vec![],
            relocated_references: vec![],
            string_slot_diagnostics,
            relocation_diagnostics,
            output_bytes_hex: None,
            output_hash: None,
        }
    }

    pub(crate) fn passed(
        fixture_id: String,
        relocated_strings: Vec<RelocatedString>,
        relocated_references: Vec<RelocatedStringReference>,
        output_bytes: Vec<u8>,
    ) -> Self {
        let output_bytes_hex = bytes_to_hex(&output_bytes);
        Self {
            schema_version: "0.1.0".to_string(),
            status: OperationStatus::Passed,
            fixture_id,
            relocated_strings,
            relocated_references,
            string_slot_diagnostics: vec![],
            relocation_diagnostics: vec![],
            output_hash: Some(content_hash(&output_bytes_hex)),
            output_bytes_hex: Some(output_bytes_hex),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelocatedString {
    pub slot_id: String,
    pub old_byte_range: ByteSpan,
    pub new_byte_range: ByteSpan,
    pub encoded_hash: String,
    pub output_hash_inputs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelocatedStringReference {
    pub reference_id: String,
    pub slot_id: String,
    pub old_byte_range: ByteSpan,
    pub new_byte_range: ByteSpan,
    pub relocation_kind: StringReferenceRelocationKind,
    pub target_old_byte_range: ByteSpan,
    pub target_new_byte_range: ByteSpan,
    pub output_hash_inputs: Vec<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StringRelocationDiagnostic {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_range: Option<ByteSpan>,
    pub message: String,
    pub remediation_code: String,
    pub remediation: String,
}

impl fmt::Debug for StringRelocationDiagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StringRelocationDiagnostic")
            .field("code", &self.code)
            .field("reference_id", &self.reference_id)
            .field("slot_id", &self.slot_id)
            .field("byte_range", &self.byte_range)
            .field("message", &RedactedContentSummary::from_text(&self.message))
            .field("remediation_code", &self.remediation_code)
            .field(
                "remediation",
                &RedactedContentSummary::from_text(&self.remediation),
            )
            .finish()
    }
}

pub(crate) fn bytes_to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut acc, byte| {
        let _ = write!(acc, "{byte:02x}");
        acc
    })
}
