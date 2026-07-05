//! Byte-preserving patch writer + verification for TyranoScript `.ks` scripts
//! (the patch-back stage of the layered pipeline).
//!
//! A patch replaces **only** the exact `[start_byte, end_byte)` span of a
//! translatable [`TsUnit`] with re-encoded translation bytes; every other
//! byte — tags, labels, jumps, variable embeds, comments, `#`/`@` markers,
//! quote characters around attribute values, newlines — is spliced verbatim
//! from the source. Structure is therefore byte-identical by construction, and
//! an identity patch (translation == source text for every unit) reproduces
//! the source bytes exactly.

use std::collections::BTreeMap;

use thiserror::Error;

use crate::parse::{
    TsDocument, TsEncoding, TsUnit, decode_slice, parse_ks_with_encoding, structural_bytes,
};

/// Fatal errors from [`apply_patch`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PatchError {
    #[error(
        "kaifuu.tyrano.patch.unknown_unit: translation targets unit key {key} which is not in the extraction set"
    )]
    UnknownUnit { key: String },
    #[error(
        "kaifuu.tyrano.patch.stale_source: unit {key} span no longer matches its recorded source text (source drifted since extraction)"
    )]
    StaleSource { key: String },
    #[error(
        "kaifuu.tyrano.patch.out_of_bounds: unit {key} span {start}..{end} exceeds source length {len}"
    )]
    OutOfBounds {
        key: String,
        start: usize,
        end: usize,
        len: usize,
    },
    #[error("kaifuu.tyrano.patch.overlap: unit {a} overlaps unit {b}")]
    Overlap { a: String, b: String },
    #[error(
        "kaifuu.tyrano.patch.newline_in_translation: unit {key} translation contains a line terminator; a TyranoScript message/choice run is single-line (use an [r] tag)"
    )]
    NewlineInTranslation { key: String },
    #[error(
        "kaifuu.tyrano.patch.quote_in_attr_translation: unit {key} is an attribute value but its translation contains the delimiting quote character {quote:?}"
    )]
    QuoteInAttrTranslation { key: String, quote: char },
    #[error(
        "kaifuu.tyrano.patch.encode_failed: unit {key} translation is not representable in the source encoding {encoding:?}"
    )]
    EncodeFailed { key: String, encoding: TsEncoding },
}

/// Re-encode a translation string into the source encoding.
fn encode_translation(key: &str, text: &str, enc: TsEncoding) -> Result<Vec<u8>, PatchError> {
    match enc {
        TsEncoding::Utf8 => Ok(text.as_bytes().to_vec()),
        TsEncoding::ShiftJis => {
            let (cow, _, had_errors) = encoding_rs::SHIFT_JIS.encode(text);
            if had_errors {
                Err(PatchError::EncodeFailed {
                    key: key.to_string(),
                    encoding: enc,
                })
            } else {
                Ok(cow.into_owned())
            }
        }
    }
}

/// The byte immediately before a unit span, if it is an attribute-value quote
/// (`"` or `'`). Attribute-value units (`[glink text="…"]` etc.) are bounded
/// by quotes that live in the structural stream; a translation must not
/// contain that quote or it would desynchronise the tag.
fn attr_quote_char(source: &[u8], unit: &TsUnit) -> Option<char> {
    if unit.start_byte == 0 {
        return None;
    }
    match source[unit.start_byte - 1] {
        b'"' => Some('"'),
        b'\'' => Some('\''),
        _ => None,
    }
}

/// Apply `translations` (unit key → translated text) to `source`, producing a
/// byte-preserving patched buffer.
///
/// Only spans of units named in `translations` change; untranslated units keep
/// their source bytes. Every guard below is a hard error — there is no silent
/// skip:
/// - a translation key with no matching unit ([`PatchError::UnknownUnit`]);
/// - a translation containing a line terminator
///   ([`PatchError::NewlineInTranslation`]);
/// - an attribute-value translation containing its delimiting quote
///   ([`PatchError::QuoteInAttrTranslation`]);
/// - a unit whose recorded span no longer decodes to its `source_text`
///   ([`PatchError::StaleSource`]);
/// - overlapping target spans ([`PatchError::Overlap`]);
/// - a translation unrepresentable in the source encoding
///   ([`PatchError::EncodeFailed`]).
pub fn apply_patch(
    source: &[u8],
    units: &[TsUnit],
    enc: TsEncoding,
    translations: &BTreeMap<String, String>,
) -> Result<Vec<u8>, PatchError> {
    let mut targets: Vec<(&TsUnit, Vec<u8>)> = Vec::with_capacity(translations.len());
    for (key, text) in translations {
        let unit = units
            .iter()
            .find(|u| &u.source_unit_key == key)
            .ok_or_else(|| PatchError::UnknownUnit { key: key.clone() })?;
        if text.bytes().any(|b| b == b'\n' || b == b'\r') {
            return Err(PatchError::NewlineInTranslation { key: key.clone() });
        }
        if unit.end_byte > source.len() {
            return Err(PatchError::OutOfBounds {
                key: key.clone(),
                start: unit.start_byte,
                end: unit.end_byte,
                len: source.len(),
            });
        }
        if let Some(q) = attr_quote_char(source, unit)
            && text.contains(q)
        {
            return Err(PatchError::QuoteInAttrTranslation {
                key: key.clone(),
                quote: q,
            });
        }
        // Stale/tamper guard: the recorded span must still decode to the
        // recorded source text.
        if decode_slice(&source[unit.start_byte..unit.end_byte], enc) != unit.source_text {
            return Err(PatchError::StaleSource { key: key.clone() });
        }
        let bytes = encode_translation(key, text, enc)?;
        targets.push((unit, bytes));
    }

    targets.sort_by_key(|(u, _)| (u.start_byte, u.end_byte));
    for pair in targets.windows(2) {
        let (a, _) = &pair[0];
        let (b, _) = &pair[1];
        if a.end_byte > b.start_byte {
            return Err(PatchError::Overlap {
                a: a.source_unit_key.clone(),
                b: b.source_unit_key.clone(),
            });
        }
    }

    let mut out = Vec::with_capacity(source.len());
    let mut cursor = 0usize;
    for (unit, bytes) in &targets {
        out.extend_from_slice(&source[cursor..unit.start_byte]);
        out.extend_from_slice(bytes);
        cursor = unit.end_byte;
    }
    out.extend_from_slice(&source[cursor..]);
    Ok(out)
}

/// Failure modes surfaced by [`verify_byte_preserving`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum VerifyError {
    #[error(
        "kaifuu.tyrano.verify.unit_set_changed: patched script's translatable-unit set differs from the source (a unit was dropped, added, or its structural position moved)"
    )]
    UnitSetChanged,
    #[error(
        "kaifuu.tyrano.verify.structure_changed: patched script's non-text structure differs from the source at byte {offset} (a tag/label/jump/variable/comment was altered)"
    )]
    StructureChanged { offset: usize },
}

/// Prove that `patched` differs from `source` **only** inside translatable
/// spans — i.e. the patch was byte-preserving.
///
/// Re-parses both buffers and asserts:
/// 1. the ordered set of `source_unit_key`s is identical (nothing dropped,
///    added, or structurally shifted); and
/// 2. the structural (non-text) byte streams are byte-identical (catches any
///    edit that touched a tag/label/jump/variable/comment).
pub fn verify_byte_preserving(
    source: &[u8],
    patched: &[u8],
    source_file: &str,
    enc: TsEncoding,
) -> Result<(), VerifyError> {
    let src_doc = parse_ks_with_encoding(source_file, source, enc);
    let pat_doc = parse_ks_with_encoding(source_file, patched, enc);

    let src_keys: Vec<&str> = src_doc
        .units
        .iter()
        .map(|u| u.source_unit_key.as_str())
        .collect();
    let pat_keys: Vec<&str> = pat_doc
        .units
        .iter()
        .map(|u| u.source_unit_key.as_str())
        .collect();
    if src_keys != pat_keys {
        return Err(VerifyError::UnitSetChanged);
    }

    let src_struct = structural_bytes(source, &src_doc);
    let pat_struct = structural_bytes(patched, &pat_doc);
    if src_struct != pat_struct {
        let offset = src_struct
            .iter()
            .zip(pat_struct.iter())
            .position(|(a, b)| a != b)
            .unwrap_or_else(|| src_struct.len().min(pat_struct.len()));
        return Err(VerifyError::StructureChanged { offset });
    }
    Ok(())
}

/// Convenience: re-parse `source` and return the structural byte stream.
#[must_use]
pub fn source_structural_bytes(source: &[u8], source_file: &str, enc: TsEncoding) -> Vec<u8> {
    let doc: TsDocument = parse_ks_with_encoding(source_file, source, enc);
    structural_bytes(source, &doc)
}
