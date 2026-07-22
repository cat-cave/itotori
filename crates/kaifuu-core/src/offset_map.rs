use std::fmt;

use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::OperationStatus;

mod encoded_string_slot;
mod string_relocation_encode;
mod string_relocation_plan;
mod string_relocation_types;

pub use encoded_string_slot::{
    EncodedStringSlot, EncodedStringSlotDiagnostic, EncodedStringSlotLayout,
    EncodedStringSlotPreflightReport, EncodedStringSlotProtectedSpan, parse_hex_bytes,
};
// Sibling modules import these helpers via `super::`.
#[cfg(test)]
pub(crate) use encoded_string_slot::encode_shift_jis;
pub(crate) use encoded_string_slot::{
    contains_bytes, count_protected_token_occurrences, encode_string,
    protected_span_source_identity_matches,
};

pub use string_relocation_plan::plan_string_table_rebuild;
pub use string_relocation_types::{
    RelocatedString, RelocatedStringReference, StringReferenceFormat,
    StringReferenceRelocationKind, StringRelocationDiagnostic, StringRelocationPlanReport,
    StringRelocationReference, StringRelocationSlot, StringRelocationTarget,
    StringTableRebuildRequest,
};

#[path = "offset_map/diagnostic_impls.rs"]
mod diagnostic_impls;
#[path = "offset_map/map_impl.rs"]
mod map_impl;
#[path = "offset_map/model_impl.rs"]
mod model_impl;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ByteSpan {
    start: u64,
    end: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SourceEncoding {
    Utf8,
    ShiftJis,
    BinaryTable,
    Binary,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SourceFileId(String);

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SourceRevisionId(String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRange {
    source_file_id: SourceFileId,
    source_revision_id: SourceRevisionId,
    encoding: SourceEncoding,
    bytes: ByteSpan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OffsetMapSegment {
    source_bytes: ByteSpan,
    decoded_text: ByteSpan,
    patched_bytes: ByteSpan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OffsetMap {
    source_file_id: SourceFileId,
    source_revision_id: SourceRevisionId,
    encoding: SourceEncoding,
    source_length: u64,
    decoded_text_length: u64,
    patched_length: u64,
    segments: Vec<OffsetMapSegment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OffsetMapValidationResult {
    pub schema_version: String,
    pub status: OperationStatus,
    pub diagnostics: Vec<OffsetMapDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OffsetMapDiagnostic {
    pub code: String,
    pub field: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OffsetMapError {
    diagnostics: Vec<OffsetMapDiagnostic>,
}

pub fn validate_offset_map_value(value: &Value) -> OffsetMapValidationResult {
    let mut diagnostics = Vec::new();
    let Some(object) = value.as_object() else {
        return OffsetMapValidationResult::from_diagnostics(vec![OffsetMapDiagnostic::new(
            "kaifuu.invalid_offset_map",
            "$",
            "offset map must be a JSON object",
        )]);
    };

    validate_required_identifier_field(
        &mut diagnostics,
        object.get("sourceFileId"),
        "sourceFileId",
    );
    validate_required_identifier_field(
        &mut diagnostics,
        object.get("sourceRevisionId"),
        "sourceRevisionId",
    );
    validate_required_encoding_field(&mut diagnostics, object.get("encoding"), "encoding");
    let source_length =
        validate_required_u64_field(&mut diagnostics, object.get("sourceLength"), "sourceLength");
    let decoded_text_length = validate_required_u64_field(
        &mut diagnostics,
        object.get("decodedTextLength"),
        "decodedTextLength",
    );
    let patched_length = validate_required_u64_field(
        &mut diagnostics,
        object.get("patchedLength"),
        "patchedLength",
    );

    let Some(segments) = object.get("segments").and_then(Value::as_array) else {
        diagnostics.push(OffsetMapDiagnostic::new(
            "kaifuu.missing_offset_segments",
            "segments",
            "segments must be an array",
        ));
        return OffsetMapValidationResult::from_diagnostics(diagnostics);
    };

    let mut typed_segments = Vec::new();
    for (index, segment) in segments.iter().enumerate() {
        let Some(segment_object) = segment.as_object() else {
            diagnostics.push(OffsetMapDiagnostic::new(
                "kaifuu.invalid_offset_segment",
                format!("segments[{index}]"),
                "offset map segment must be an object",
            ));
            continue;
        };
        let source_bytes = read_json_span(
            &mut diagnostics,
            segment_object.get("sourceBytes"),
            index,
            "sourceBytes",
        );
        let decoded_text = read_json_span(
            &mut diagnostics,
            segment_object.get("decodedText"),
            index,
            "decodedText",
        );
        let patched_bytes = read_json_span(
            &mut diagnostics,
            segment_object.get("patchedBytes"),
            index,
            "patchedBytes",
        );
        if let (Some(source_bytes), Some(decoded_text), Some(patched_bytes)) =
            (source_bytes, decoded_text, patched_bytes)
        {
            typed_segments.push(OffsetMapSegment::new_unchecked(
                source_bytes,
                decoded_text,
                patched_bytes,
            ));
        }
    }

    if let (Some(source_length), Some(decoded_text_length), Some(patched_length)) =
        (source_length, decoded_text_length, patched_length)
    {
        let structural_map = OffsetMap {
            source_file_id: SourceFileId("__validated__".to_string()),
            source_revision_id: SourceRevisionId("__validated__".to_string()),
            encoding: SourceEncoding::Binary,
            source_length,
            decoded_text_length,
            patched_length,
            segments: typed_segments,
        };
        diagnostics.extend(structural_map.validate().diagnostics);
    }

    OffsetMapValidationResult::from_diagnostics(diagnostics)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Axis {
    Source,
    Decoded,
    Patched,
}

impl Axis {
    fn span(self, segment: &OffsetMapSegment) -> ByteSpan {
        match self {
            Self::Source => segment.source_bytes,
            Self::Decoded => segment.decoded_text,
            Self::Patched => segment.patched_bytes,
        }
    }

    fn field(self) -> &'static str {
        match self {
            Self::Source => "sourceBytes",
            Self::Decoded => "decodedText",
            Self::Patched => "patchedBytes",
        }
    }

    fn field_prefix(self) -> &'static str {
        match self {
            Self::Source => "source",
            Self::Decoded => "decodedText",
            Self::Patched => "patched",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Source => "source byte",
            Self::Decoded => "decoded text",
            Self::Patched => "patched byte",
        }
    }
}

fn validate_identifier_value(field: &str, value: &str) -> Result<(), OffsetMapError> {
    if value.trim().is_empty() || value.contains('\0') {
        return Err(OffsetMapError::from_diagnostic(OffsetMapDiagnostic::new(
            match field {
                "sourceRevisionId" => "kaifuu.missing_source_revision_id",
                "sourceFileId" => "kaifuu.missing_source_file_id",
                _ => "kaifuu.invalid_identifier",
            },
            field,
            format!("{field} must be a non-empty string without null bytes"),
        )));
    }
    Ok(())
}

fn validate_segment_span(
    diagnostics: &mut Vec<OffsetMapDiagnostic>,
    index: usize,
    field: &str,
    span: ByteSpan,
    upper_bound: u64,
    out_of_range_code: &str,
) {
    if span.end < span.start {
        diagnostics.push(OffsetMapDiagnostic::new(
            "kaifuu.invalid_offset",
            format!("segments[{index}].{field}"),
            format!(
                "span end {} must be greater than or equal to start {}",
                span.end, span.start
            ),
        ));
    }
    if span.end > upper_bound {
        diagnostics.push(OffsetMapDiagnostic::new(
            out_of_range_code,
            format!("segments[{index}].{field}"),
            format!(
                "span {}..{} exceeds declared length {}",
                span.start, span.end, upper_bound
            ),
        ));
    }
}

fn validate_segment_axes_attached(
    diagnostics: &mut Vec<OffsetMapDiagnostic>,
    field: impl Into<String>,
    source_bytes: ByteSpan,
    decoded_text: ByteSpan,
    patched_bytes: ByteSpan,
) {
    let empty_axes = [
        source_bytes.is_empty(),
        decoded_text.is_empty(),
        patched_bytes.is_empty(),
    ]
    .into_iter()
    .filter(|empty| *empty)
    .count();
    if empty_axes != 0 && empty_axes != 3 {
        diagnostics.push(OffsetMapDiagnostic::new(
            "kaifuu.detached_offset_segment",
            field,
            "offset map segment axes must all be empty or all non-empty",
        ));
    }
}

fn validate_non_overlapping_axis(
    diagnostics: &mut Vec<OffsetMapDiagnostic>,
    segments: &[OffsetMapSegment],
    axis: Axis,
) {
    let mut spans = segments
        .iter()
        .enumerate()
        .filter_map(|(index, segment)| {
            let span = axis.span(segment);
            (!span.is_empty()).then_some((index, span))
        })
        .collect::<Vec<_>>();
    spans.sort_by_key(|(_, span)| (span.start, span.end));
    for window in spans.windows(2) {
        let (previous_index, previous) = window[0];
        let (current_index, current) = window[1];
        if previous.overlaps(current) {
            diagnostics.push(OffsetMapDiagnostic::new(
                "kaifuu.overlapping_spans",
                format!("segments[{current_index}].{}", axis.field()),
                format!(
                    "{} span {}..{} overlaps segments[{previous_index}] {}..{}",
                    axis.label(),
                    current.start,
                    current.end,
                    previous.start,
                    previous.end
                ),
            ));
        }
    }
}

fn validate_required_identifier_field(
    diagnostics: &mut Vec<OffsetMapDiagnostic>,
    value: Option<&Value>,
    field: &str,
) {
    match value.and_then(Value::as_str) {
        Some(value) => {
            if let Err(error) = validate_identifier_value(field, value) {
                diagnostics.extend(error.diagnostics);
            }
        }
        None => diagnostics.push(OffsetMapDiagnostic::new(
            match field {
                "sourceRevisionId" => "kaifuu.missing_source_revision_id",
                "sourceFileId" => "kaifuu.missing_source_file_id",
                _ => "kaifuu.missing_identifier",
            },
            field,
            format!("{field} must be a non-empty string"),
        )),
    }
}

fn validate_required_encoding_field(
    diagnostics: &mut Vec<OffsetMapDiagnostic>,
    value: Option<&Value>,
    field: &str,
) {
    match value.and_then(Value::as_str) {
        Some(value) if SourceEncoding::parse(value).is_some() => {}
        Some(value) => diagnostics.push(OffsetMapDiagnostic::new(
            "kaifuu.invalid_encoding",
            field,
            format!("encoding {value} is not supported"),
        )),
        None => diagnostics.push(OffsetMapDiagnostic::new(
            "kaifuu.invalid_encoding",
            field,
            "encoding must be a string",
        )),
    }
}

fn validate_required_u64_field(
    diagnostics: &mut Vec<OffsetMapDiagnostic>,
    value: Option<&Value>,
    field: &str,
) -> Option<u64> {
    if let Some(value) = value.and_then(Value::as_u64) {
        Some(value)
    } else {
        diagnostics.push(OffsetMapDiagnostic::new(
            "kaifuu.invalid_offset",
            field,
            format!("{field} must be a non-negative integer"),
        ));
        None
    }
}

fn read_json_span(
    diagnostics: &mut Vec<OffsetMapDiagnostic>,
    value: Option<&Value>,
    segment_index: usize,
    field: &str,
) -> Option<ByteSpan> {
    let field_path = format!("segments[{segment_index}].{field}");
    let Some(object) = value.and_then(Value::as_object) else {
        diagnostics.push(OffsetMapDiagnostic::new(
            "kaifuu.invalid_offset",
            &field_path,
            format!("{field_path} must be an object"),
        ));
        return None;
    };
    let start = validate_required_u64_field(
        diagnostics,
        object.get("start"),
        &format!("{field_path}.start"),
    );
    let end =
        validate_required_u64_field(diagnostics, object.get("end"), &format!("{field_path}.end"));
    match (start, end) {
        (Some(start), Some(end)) => match ByteSpan::new(start, end) {
            Ok(span) => Some(span),
            Err(error) => {
                diagnostics.extend(error.diagnostics);
                None
            }
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests;
