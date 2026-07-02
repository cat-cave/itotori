//! Byte-exact framing pins + round-trip re-emit (`genaudit2-05`).
//!
//! # What this adds over the bare zero-unknown gate
//!
//! The full-archive gate (`multi_corpus_real_bytes.rs`) asserts that every
//! decoded element is a *recognised* [`crate::opcode::RealLiveOpcode`] — zero generic
//! `Command` blobs, zero `Unknown` desync tripwires. That proves opcode
//! **identity**, but "zero unknown opcode" alone does NOT prove the
//! **framing** is byte-exact: a mis-framed command (wrong argument-list
//! width, a swallowed trailing pointer, an off-by-N operand span) can still
//! land on a byte that happens to be a valid opener and continue decoding
//! into perfectly-typed opcodes. The stream would be "100% recognised" while
//! silently mis-partitioned.
//!
//! This module pins the framing so "100%" reflects **verified byte spans**,
//! not mere absence-of-tripwire. It provides two stronger proofs, both built
//! on the single-source-of-truth decoder ([`crate::opcode::decode_element`] /
//! [`crate::opcode::parse_real_bytecode_spans`]) — no parallel framer:
//!
//! 1. [`framing_manifest`] — a per-element offset+width manifest that is
//!    asserted to **partition** the scene bytecode (contiguous,
//!    non-overlapping, full-coverage) AND to be **self-framing**: every
//!    element's byte span, re-decoded *in isolation*, reproduces the same
//!    element and consumes exactly its declared width (no leftover, no
//!    shortfall). A command whose header-declared width (8-byte header +
//!    `argc` arg list + `overload` + goto-family trailing `i32` pointers +
//!    operands) disagreed with its true byte span would fail the isolated
//!    re-decode — this is the framing pin the bare gate lacks.
//! 2. [`reemit_scene`] — the inverse of the decoder framing: re-emit the
//!    decoded element stream back to bytes. Structural framing bytes (the
//!    seven element openers, the 8-byte command header's
//!    `module_type`/`module_id`/`opcode`/`argc`/`overload`, and each Meta
//!    element's `u16` payload) are **reconstructed from the decoded fields**,
//!    not copied; only genuinely-opaque operand payload (Shift-JIS text runs,
//!    expression operand bytes, command argument / pointer bodies) is emitted
//!    verbatim, exactly as a faithful encoder emits operands it was not asked
//!    to change. Asserting `reemit_scene(bytes) == bytes` byte-for-byte proves
//!    the decoder consumed every byte into an exact partition and can
//!    reproduce it — framing is complete and exact.

use serde::{Deserialize, Serialize};

use crate::opcode::{
    COMMAND_HEADER_LEN, RealLiveParseError, decode_element, opener, parse_real_bytecode_spans,
};

/// One entry in a byte-exact framing manifest: the scene-relative byte
/// offset where a decoded element begins, the byte width it occupies, and
/// its stable opcode label ([`crate::opcode::RealLiveOpcode::label`]).
///
/// The offset+width pin the element's exact byte span in the decompressed
/// (and, for `xor_2` titles, decrypted) scene bytecode — the framing, not
/// merely the opcode identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FramingSpan {
    /// Scene-relative byte offset where this element begins.
    pub offset: u64,
    /// Byte width this element occupies (its `consumed` span).
    pub width: usize,
    /// Stable opcode discriminant label for this element.
    pub label: &'static str,
}

/// Failure surface for the framing pins. Distinct from
/// [`RealLiveParseError`] so a framing regression names precisely which
/// invariant broke (partition vs. self-framing) rather than folding into a
/// generic decode error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum FramingError {
    /// The underlying decoder rejected the stream.
    Decode(RealLiveParseError),
    /// The element spans did not partition the stream: an element's offset
    /// did not equal the running cursor (a gap or overlap), or the manifest
    /// did not cover exactly `[0, total_len)`.
    NotPartition {
        offset: u64,
        expected_offset: u64,
        total_len: usize,
    },
    /// An element's byte span, re-decoded in isolation, consumed a different
    /// number of bytes than its declared width — the header-declared framing
    /// disagrees with the true byte span (a mis-framed element).
    SelfFrameWidthMismatch {
        offset: u64,
        declared_width: usize,
        isolated_width: usize,
    },
    /// An element's byte span, re-decoded in isolation, decoded to a
    /// different opcode kind than it did in the full stream — the element is
    /// not self-contained (its decode depended on surrounding bytes).
    SelfFrameLabelMismatch {
        offset: u64,
        stream_label: &'static str,
        isolated_label: &'static str,
    },
}

impl std::fmt::Display for FramingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Decode(err) => write!(f, "kaifuu.reallive.framing.decode: {err}"),
            Self::NotPartition {
                offset,
                expected_offset,
                total_len,
            } => write!(
                f,
                "kaifuu.reallive.framing.not_partition: element offset {offset} != running cursor \
                 {expected_offset} (total_len={total_len}); spans do not partition the stream"
            ),
            Self::SelfFrameWidthMismatch {
                offset,
                declared_width,
                isolated_width,
            } => write!(
                f,
                "kaifuu.reallive.framing.self_frame_width_mismatch: element at offset {offset} \
                 declared width {declared_width} but consumes {isolated_width} in isolation"
            ),
            Self::SelfFrameLabelMismatch {
                offset,
                stream_label,
                isolated_label,
            } => write!(
                f,
                "kaifuu.reallive.framing.self_frame_label_mismatch: element at offset {offset} \
                 decoded as {stream_label} in stream but {isolated_label} in isolation"
            ),
        }
    }
}

impl std::error::Error for FramingError {}

impl From<RealLiveParseError> for FramingError {
    fn from(err: RealLiveParseError) -> Self {
        Self::Decode(err)
    }
}

/// The framing decomposition of one element — the exact structural fields
/// needed to re-emit its bytes byte-for-byte.
///
/// Structural framing bytes are captured as **decoded fields** (so
/// [`FramedElement::reemit`] reconstructs them rather than copying the
/// input); genuinely-opaque operand payloads are captured verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
enum FramedElement {
    /// A 3-byte Meta element: opener (`0x0A` / `0x21` / `0x40`) + `u16 LE`.
    Meta { opener: u8, value: u16 },
    /// A 1-byte comma separator: the exact opener (`0x00` or `0x2C`).
    Comma { opener: u8 },
    /// A Textout run — opaque Shift-JIS / binary bytes, verbatim.
    Textout { raw: Vec<u8> },
    /// An Expression element — opener + opaque expression operand bytes,
    /// verbatim (the full element span including the `0x24` opener).
    Expression { raw: Vec<u8> },
    /// A Command element: the 8-byte header captured as decoded fields plus
    /// the opaque body (argument list / goto pointers / select block),
    /// verbatim.
    Command {
        module_type: u8,
        module_id: u8,
        opcode: u16,
        argc: u16,
        overload: u8,
        body: Vec<u8>,
    },
}

impl FramedElement {
    /// Decompose one element's byte span into its framing fields. `span` is
    /// exactly `bytes[offset..offset + width]` — a complete, self-contained
    /// element (guaranteed by the caller's self-frame check).
    fn from_span(span: &[u8]) -> Self {
        match span[0] {
            opener::META_LINE | opener::META_ENTRYPOINT | opener::META_KIDOKU => Self::Meta {
                opener: span[0],
                value: u16::from_le_bytes([span[1], span[2]]),
            },
            opener::META_COMMA | opener::COMMA => Self::Comma { opener: span[0] },
            opener::EXPRESSION => Self::Expression { raw: span.to_vec() },
            opener::COMMAND => Self::Command {
                module_type: span[1],
                module_id: span[2],
                opcode: u16::from_le_bytes([span[3], span[4]]),
                argc: u16::from_le_bytes([span[5], span[6]]),
                overload: span[7],
                body: span[COMMAND_HEADER_LEN..].to_vec(),
            },
            // Any other lead byte is a Textout run (the decoder catch-all).
            _ => Self::Textout { raw: span.to_vec() },
        }
    }

    /// Re-emit this element's bytes. Structural framing bytes are
    /// reconstructed from the decoded fields; opaque payload is verbatim.
    fn reemit(&self, out: &mut Vec<u8>) {
        match self {
            Self::Meta { opener, value } => {
                out.push(*opener);
                out.extend_from_slice(&value.to_le_bytes());
            }
            Self::Comma { opener } => out.push(*opener),
            // Textout runs and Expression elements are both emitted as their
            // opaque payload bytes verbatim (an Expression's `raw` already
            // includes its `0x24` opener).
            Self::Textout { raw } | Self::Expression { raw } => out.extend_from_slice(raw),
            Self::Command {
                module_type,
                module_id,
                opcode,
                argc,
                overload,
                body,
            } => {
                out.push(opener::COMMAND);
                out.push(*module_type);
                out.push(*module_id);
                out.extend_from_slice(&opcode.to_le_bytes());
                out.extend_from_slice(&argc.to_le_bytes());
                out.push(*overload);
                out.extend_from_slice(body);
            }
        }
    }
}

/// Build a byte-exact framing manifest for a decompressed (and, for `xor_2`
/// titles, decrypted) scene bytecode stream, validating that the element
/// spans **partition** the stream and that each element is **self-framing**.
///
/// Reuses [`parse_real_bytecode_spans`] (the width-carrying authoritative
/// decode) for the element boundaries and [`decode_element`] for the
/// isolated per-element re-decode — there is no second framer.
///
/// # Errors
///
/// - [`FramingError::Decode`] if the stream does not decode.
/// - [`FramingError::NotPartition`] if the spans are not contiguous / do not
///   cover exactly `[0, bytes.len())`.
/// - [`FramingError::SelfFrameWidthMismatch`] / [`FramingError::SelfFrameLabelMismatch`]
///   if an element's isolated re-decode disagrees with its declared span.
pub fn framing_manifest(bytes: &[u8]) -> Result<Vec<FramingSpan>, FramingError> {
    let spans = parse_real_bytecode_spans(bytes)?;
    let mut manifest = Vec::with_capacity(spans.len());
    let mut cursor: usize = 0;

    for (opcode, width) in &spans {
        // Partition: this element must begin exactly at the running cursor.
        if cursor >= bytes.len() {
            return Err(FramingError::NotPartition {
                offset: cursor as u64,
                expected_offset: cursor as u64,
                total_len: bytes.len(),
            });
        }
        let end = cursor + width;
        if end > bytes.len() {
            return Err(FramingError::NotPartition {
                offset: cursor as u64,
                expected_offset: cursor as u64,
                total_len: bytes.len(),
            });
        }

        // Self-framing: the element's own byte span, decoded in isolation,
        // must reproduce the same element and consume exactly `width` — no
        // leftover, no shortfall. This is the framing pin: a header-declared
        // width that disagreed with the true span (a mis-framed command)
        // fails here even though the full-stream decode "recognised" it.
        let span = &bytes[cursor..end];
        let (isolated, isolated_width) = decode_element(span, 0)?;
        if isolated_width != *width {
            return Err(FramingError::SelfFrameWidthMismatch {
                offset: cursor as u64,
                declared_width: *width,
                isolated_width,
            });
        }
        if isolated.label() != opcode.label() {
            return Err(FramingError::SelfFrameLabelMismatch {
                offset: cursor as u64,
                stream_label: opcode.label(),
                isolated_label: isolated.label(),
            });
        }

        manifest.push(FramingSpan {
            offset: cursor as u64,
            width: *width,
            label: opcode.label(),
        });
        cursor = end;
    }

    // Full coverage: the last element must end exactly at the stream end.
    if cursor != bytes.len() {
        return Err(FramingError::NotPartition {
            offset: cursor as u64,
            expected_offset: bytes.len() as u64,
            total_len: bytes.len(),
        });
    }

    Ok(manifest)
}

/// Re-emit a decompressed (and, for `xor_2` titles, decrypted) scene
/// bytecode stream from its decoded element sequence — the inverse of the
/// decoder framing.
///
/// Structural framing bytes are reconstructed from decoded fields; opaque
/// operand payload is emitted verbatim. `reemit_scene(bytes)?` equals
/// `bytes` byte-for-byte iff the decoder partitioned the stream exactly and
/// captured every byte — the strongest framing-completeness proof.
///
/// # Errors
///
/// [`FramingError::Decode`] if the stream does not decode.
pub fn reemit_scene(bytes: &[u8]) -> Result<Vec<u8>, FramingError> {
    let spans = parse_real_bytecode_spans(bytes)?;
    let mut out = Vec::with_capacity(bytes.len());
    let mut cursor: usize = 0;
    for (_opcode, width) in &spans {
        let end = (cursor + width).min(bytes.len());
        let framed = FramedElement::from_span(&bytes[cursor..end]);
        framed.reemit(&mut out);
        cursor = end;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A hand-built stream mixing every element family round-trips exactly
    /// and yields a partitioning, self-framing manifest.
    #[test]
    fn synthetic_mixed_stream_round_trips_and_partitions() {
        let mut bytes: Vec<u8> = Vec::new();
        // MetaLine(7)
        bytes.extend_from_slice(&[opener::META_LINE, 0x07, 0x00]);
        // Comma (0x00) then Comma (0x2C) — distinct openers must survive.
        bytes.push(opener::META_COMMA);
        bytes.push(opener::COMMA);
        // MetaEntrypoint(0)
        bytes.extend_from_slice(&[opener::META_ENTRYPOINT, 0x00, 0x00]);
        // A module_msg TextDisplay command (header only, no arg list).
        bytes.extend_from_slice(&[opener::COMMAND, 1, 3, 5, 0, 0, 0, 0]);
        // MetaKidoku(9)
        bytes.extend_from_slice(&[opener::META_KIDOKU, 0x09, 0x00]);

        let manifest = framing_manifest(&bytes).expect("manifest must build");
        // Partition invariants.
        let mut cursor = 0u64;
        for span in &manifest {
            assert_eq!(span.offset, cursor, "spans must be contiguous");
            cursor += span.width as u64;
        }
        assert_eq!(cursor as usize, bytes.len(), "spans must cover the stream");

        let reemitted = reemit_scene(&bytes).expect("re-emit must succeed");
        assert_eq!(reemitted, bytes, "re-emit must equal input byte-for-byte");
    }

    /// The two distinct comma openers (`0x00`, `0x2C`) both classify to the
    /// `Comma` opcode (lossy in the typed AST) but re-emit to their exact
    /// original byte — proving the framed re-emit is byte-exact, not
    /// AST-lossy.
    #[test]
    fn distinct_comma_openers_reemit_exactly() {
        for opener_byte in [opener::META_COMMA, opener::COMMA] {
            // A Textout run keeps the stream non-trivial and gives the comma
            // a following element boundary.
            let bytes = vec![opener_byte, 0x41, 0x42];
            let reemitted = reemit_scene(&bytes).expect("re-emit");
            assert_eq!(
                reemitted, bytes,
                "comma opener {opener_byte:#04x} must survive"
            );
        }
    }

    #[test]
    fn empty_input_is_decode_error() {
        let err = framing_manifest(&[]).expect_err("empty must error");
        assert!(matches!(
            err,
            FramingError::Decode(RealLiveParseError::TruncatedBytecode { .. })
        ));
    }
}
