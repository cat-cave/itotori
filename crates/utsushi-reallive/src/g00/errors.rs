use serde::{Deserialize, Serialize};

use super::model::{G00_TYPE_PALETTED_LZSS, G00_TYPE_RAW_BGR, G00_TYPE_REGIONED_LZSS, G00Type};

/// Fatal errors raised by [`decode_g00`].
///
/// Every recoverable mismatch is a typed variant — there is no
/// `Ok(empty_image)` fallback for truncated input, an unknown type, or
/// an LZSS regression. The alpha-gate contract forbids silent
/// zero-state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum G00DecodeError {
    /// Input slice is shorter than the 5-byte
    /// `(type, width_u16, height_u16)` preamble. No fields can be
    /// parsed.
    TruncatedPreamble {
        /// Length of the input slice that was offered.
        observed_len: usize,
        /// Required length (== [`G00_HEADER_PREAMBLE_BYTE_LEN`]).
        required_len: usize,
    },
    /// Input slice is shorter than the per-type header demands.
    TruncatedHeader {
        /// Sub-format the partial header carried.
        g00_type: G00Type,
        /// Number of bytes the parser needed from the input.
        required_len: usize,
        /// Number of bytes available in the input.
        observed_len: usize,
    },
    /// The lead byte at offset 0 is not one of the documented values
    /// `{0, 1, 2}`. The unknown byte is preserved on the error so audit
    /// tooling can diagnose the on-disk file.
    UnknownType {
        /// Observed lead byte that did not match any documented type.
        observed: u8,
    },
    /// Type 2 region count was zero (a type-2 file is only well-formed
    /// with at least one region — the rectangle table is what
    /// distinguishes type 2 from type 0).
    Type2ZeroRegions,
    /// Decoded LZSS payload is shorter than the per-type pixel-buffer
    /// requirement (type 0/2: `< width*height*4`; type 1: `< palette
    /// width*height`).
    DecodedBufferTooShort {
        /// Sub-format whose decoded buffer was short.
        g00_type: G00Type,
        /// Bytes required by the per-type pixel layout.
        required_len: usize,
        /// Bytes actually produced by the LZSS decoder.
        observed_len: usize,
    },
    /// LZSS stream ran out of input before producing the declared
    /// `uncompressed_size` bytes.
    UnexpectedEndOfStream {
        /// Sub-format whose LZSS stream ran short.
        g00_type: G00Type,
        /// Bytes declared by the LZSS header.
        declared_uncompressed_size: usize,
        /// Bytes actually emitted before the input was exhausted.
        emitted: usize,
    },
    /// The LZSS section header declared a `compressed_size` smaller than
    /// the mandatory 8-byte preamble it is defined to include. Such a
    /// value is internally inconsistent (the compressed region cannot be
    /// smaller than its own header), so the parser rejects it instead of
    /// clamping the implied payload to an empty slice (which would only
    /// surface downstream as a [`G00Warning::PayloadLengthMismatch`]).
    MalformedCompressedSize {
        /// Sub-format whose LZSS header carried the bad size.
        g00_type: G00Type,
        /// The `compressed_size` field read from the header.
        compressed_size: usize,
        /// Minimum well-formed value (the 8-byte preamble length).
        minimum: usize,
    },
}

impl std::fmt::Display for G00DecodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            G00DecodeError::TruncatedPreamble {
                observed_len,
                required_len,
            } => write!(
                formatter,
                "utsushi.reallive.g00.truncated_preamble: \
                 observed_len={observed_len} required_len={required_len}"
            ),
            G00DecodeError::TruncatedHeader {
                g00_type,
                observed_len,
                required_len,
            } => write!(
                formatter,
                "utsushi.reallive.g00.truncated_header: \
                 type={g00_type:?} observed_len={observed_len} required_len={required_len}"
            ),
            G00DecodeError::UnknownType { observed } => write!(
                formatter,
                "utsushi.reallive.g00.unknown_type: observed lead byte 0x{observed:02x} \
                 not in documented set {{0, 1, 2}}"
            ),
            G00DecodeError::Type2ZeroRegions => write!(
                formatter,
                "utsushi.reallive.g00.type2_zero_regions: \
                 type-2 region_count was zero (type-2 requires at least one region)"
            ),
            G00DecodeError::DecodedBufferTooShort {
                g00_type,
                observed_len,
                required_len,
            } => write!(
                formatter,
                "utsushi.reallive.g00.decoded_buffer_too_short: \
                 type={g00_type:?} observed_len={observed_len} required_len={required_len}"
            ),
            G00DecodeError::UnexpectedEndOfStream {
                g00_type,
                declared_uncompressed_size,
                emitted,
            } => write!(
                formatter,
                "utsushi.reallive.g00.unexpected_end_of_stream: \
                 type={g00_type:?} declared_uncompressed_size={declared_uncompressed_size} \
                 emitted={emitted}"
            ),
            G00DecodeError::MalformedCompressedSize {
                g00_type,
                compressed_size,
                minimum,
            } => write!(
                formatter,
                "utsushi.reallive.g00.malformed_compressed_size: \
                 type={g00_type:?} compressed_size={compressed_size} minimum={minimum}"
            ),
        }
    }
}

impl std::error::Error for G00DecodeError {}

/// Non-fatal observations emitted alongside a successful g00 decode.
///
/// Like the other warning enums in this crate
/// ([`crate::SceneHeaderWarning`], [`crate::DecompressWarning`]), the
/// alpha-gate contract requires non-silent semantics for every
/// documented branch that historically had a different on-disk shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum G00Warning {
    /// The decoded LZSS payload did not exactly match the
    /// `uncompressed_size` declared by the on-disk header *and* the
    /// per-type pixel layout. The decode produced a typed best-effort
    /// pixel buffer (zero-extended or truncated to the
    /// pixel-layout size) so downstream consumers can still surface a
    /// canvas; the warning fires so corpus-level audit can spot the
    /// LZSS-variant mismatch.
    PayloadLengthMismatch {
        /// Sub-format whose LZSS output did not match the header.
        g00_type: G00Type,
        /// `uncompressed_size` field from the header.
        declared_uncompressed_size: u64,
        /// Number of bytes the LZSS decoder produced before stopping.
        observed_payload_size: u64,
    },
    /// The corpus-wide histogram walk observed zero files of this
    /// type. Emitted by
    /// [`G00CorpusHistogram::missing_type_warnings`] for every type
    /// in `{0, 1, 2}` whose count is zero. This is the
    /// `utsushi.reallive.g00_no_type_N_in_corpus` warning the
    /// acceptance criterion calls for.
    NoTypeNInCorpus {
        /// The g00 type that the corpus had zero files of.
        g00_type: G00Type,
    },
}

impl std::fmt::Display for G00Warning {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            G00Warning::PayloadLengthMismatch {
                g00_type,
                declared_uncompressed_size,
                observed_payload_size,
            } => write!(
                formatter,
                "utsushi.reallive.g00.payload_length_mismatch: \
                 type={g00_type:?} declared_uncompressed_size={declared_uncompressed_size} \
                 observed_payload_size={observed_payload_size}"
            ),
            G00Warning::NoTypeNInCorpus { g00_type } => write!(
                formatter,
                "utsushi.reallive.g00_no_type_N_in_corpus: \
                 corpus walk observed zero files of type {} ({g00_type:?})",
                g00_type.lead_byte(),
            ),
        }
    }
}

/// Corpus-wide histogram of g00 lead bytes.
///
/// Produced by directory walks over `$GAME/REALLIVEDATA/g00/`. The
/// `acceptance` criterion of calls for this aggregate to
/// surface the per-type distribution and to emit a typed
/// [`G00Warning::NoTypeNInCorpus`] for every documented type the
/// corpus has zero files of.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct G00CorpusHistogram {
    /// Number of files whose lead byte was 0 (type 0).
    pub type0_count: u64,
    /// Number of files whose lead byte was 1 (type 1).
    pub type1_count: u64,
    /// Number of files whose lead byte was 2 (type 2).
    pub type2_count: u64,
    /// Number of files whose lead byte was outside `{0, 1, 2}`.
    pub unknown_count: u64,
    /// Number of files the walker tried to open but could not read at
    /// all (zero-byte file or I/O error). Surfaced so corpus-level
    /// audit can distinguish "walk skipped" from "walk ran but file
    /// had unknown discriminator".
    pub unreadable_count: u64,
}

impl G00CorpusHistogram {
    /// Total number of files counted across every bucket (including
    /// the unknown and unreadable buckets). Convenience accessor for
    /// the acceptance test, which pins the total at the corpus size.
    pub fn total(&self) -> u64 {
        self.type0_count
            + self.type1_count
            + self.type2_count
            + self.unknown_count
            + self.unreadable_count
    }

    /// Number of files counted in the three *documented* buckets
    /// (excluding unknown / unreadable). Convenience accessor that
    /// mirrors the corpus size for a well-formed g00 directory.
    pub fn documented_total(&self) -> u64 {
        self.type0_count + self.type1_count + self.type2_count
    }

    /// One [`G00Warning::NoTypeNInCorpus`] per documented type
    /// (`{0, 1, 2}`) whose count is zero. The returned vector is
    /// always in `(0, 1, 2)` order so the acceptance test can pin the
    /// shape deterministically.
    pub fn missing_type_warnings(&self) -> Vec<G00Warning> {
        let mut warnings = Vec::new();
        if self.type0_count == 0 {
            warnings.push(G00Warning::NoTypeNInCorpus {
                g00_type: G00Type::RawBgr,
            });
        }
        if self.type1_count == 0 {
            warnings.push(G00Warning::NoTypeNInCorpus {
                g00_type: G00Type::PalettedLzss,
            });
        }
        if self.type2_count == 0 {
            warnings.push(G00Warning::NoTypeNInCorpus {
                g00_type: G00Type::RegionedLzss,
            });
        }
        warnings
    }

    /// Walk a single file's lead byte into the histogram. Files
    /// shorter than 1 byte are routed to [`Self::unreadable_count`];
    /// otherwise the byte is bucketed by the [`G00Type`] discriminator.
    pub fn observe_lead_byte(&mut self, file_bytes: &[u8]) {
        if file_bytes.is_empty() {
            self.unreadable_count += 1;
            return;
        }
        match file_bytes[0] {
            G00_TYPE_RAW_BGR => self.type0_count += 1,
            G00_TYPE_PALETTED_LZSS => self.type1_count += 1,
            G00_TYPE_REGIONED_LZSS => self.type2_count += 1,
            _ => self.unknown_count += 1,
        }
    }
}
