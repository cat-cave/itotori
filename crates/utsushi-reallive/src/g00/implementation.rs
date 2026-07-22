use super::*;

impl G00Image {
    /// Expected pixel-buffer byte length for the *final* decoded canvas:
    /// `width * height * 4`. This is the length `pixels_rgba` is sized
    /// to for type 0 and type 1, and for type 2 *as long as you read
    /// `height` off this struct* — `self.height` is the canvas height
    /// the decoder wrote out, which for type-2 stacked regions is the
    /// on-disk `height` * `regions.len()` (NOT the on-disk `height`
    /// the input bytes carried). For the per-band layout (sum of the
    /// original on-disk region rectangles), use
    /// [`Self::pixels_rgba_byte_len_type2_atlas`] instead.
    pub fn pixels_rgba_byte_len_full_canvas(&self) -> usize {
        (self.width as usize)
            .saturating_mul(self.height as usize)
            .saturating_mul(4)
    }

    /// Expected pixel-buffer byte length for a type-2 atlas by the
    /// per-band sum: `sum(region.width * region.height) * 4`. This
    /// matches the on-disk region rectangles *before* the
    /// "overlaid image" stack-multiplies the canvas height. Returns 0
    /// when the image has no regions (which is the well-formed case
    /// only for types 0/1; a type-2 image with zero regions is a
    /// malformed header surfaced by [`decode_g00`]).
    pub fn pixels_rgba_byte_len_type2_atlas(&self) -> usize {
        self.regions
            .iter()
            .map(|region| {
                (region.rect.width() as usize)
                    .saturating_mul(region.rect.height() as usize)
                    .saturating_mul(4)
            })
            .sum()
    }
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
