use super::{
    G00_TYPE2_MAX_TRAILING_PADDING, LzssVariant,
    model::{
        G00_HEADER_PREAMBLE_BYTE_LEN, G00_REGION_RECORD_BYTE_LEN, G00_TYPE0_BGR_BYTES_PER_PIXEL,
        G00Type,
    },
};

/// Count-only proof of framing and LZSS tokens, not pixels, checksums
/// container semantics, or visual interpretation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct G00LzssValidation {
    pub g00_type: G00Type,
    pub region_count: u32,
    pub payload_bytes: usize,
    pub emitted_count: usize,
}

/// Strict failures, separate from the decoder's best-effort errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum G00ContentValidationError {
    TruncatedPreamble,
    UnknownType,
    HeaderBounds {
        g00_type: G00Type,
        required_len: usize,
        observed_len: usize,
    },
    RegionTableOverflow,
    Type2ZeroRegions,
    InvalidCompressedSize,
    OuterLengthMismatch {
        g00_type: G00Type,
        declared_end: usize,
        observed_len: usize,
    },
    DeclaredOutputMismatch {
        g00_type: G00Type,
        declared: usize,
        expected: usize,
    },
    CountOverflow,
    TruncatedLiteral {
        g00_type: G00Type,
        src_offset: usize,
        required: usize,
        remaining: usize,
    },
    TruncatedBackreference {
        g00_type: G00Type,
        src_offset: usize,
        remaining: usize,
    },
    InvalidDistance {
        g00_type: G00Type,
        src_offset: usize,
        distance: usize,
        emitted: usize,
    },
    OutputOverrun {
        g00_type: G00Type,
        emitted: usize,
        token_len: usize,
        expected: usize,
    },
    OutputUnderrun {
        g00_type: G00Type,
        emitted: usize,
        expected: usize,
    },
    UnconsumedPayload {
        g00_type: G00Type,
        src_offset: usize,
        payload_len: usize,
    },
}

impl std::fmt::Display for G00ContentValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("utsushi.reallive.g00.content_validation")
    }
}

impl std::error::Error for G00ContentValidationError {}

/// Strict framing/token validation without allocation; not a pixel or visual proof.
pub fn validate_g00_lzss_content(
    input: &[u8],
) -> Result<G00LzssValidation, G00ContentValidationError> {
    if input.len() < G00_HEADER_PREAMBLE_BYTE_LEN {
        return Err(G00ContentValidationError::TruncatedPreamble);
    }
    let g00_type =
        G00Type::from_lead_byte(input[0]).ok_or(G00ContentValidationError::UnknownType)?;
    let width = u16::from_le_bytes([input[1], input[2]]) as usize;
    let height = u16::from_le_bytes([input[3], input[4]]) as usize;
    let (region_count, section_offset) = match g00_type {
        G00Type::RawBgr | G00Type::PalettedLzss => (0, G00_HEADER_PREAMBLE_BYTE_LEN),
        G00Type::RegionedLzss => {
            const COUNT_END: usize = G00_HEADER_PREAMBLE_BYTE_LEN + 4;
            if input.len() < COUNT_END {
                return Err(G00ContentValidationError::HeaderBounds {
                    g00_type,
                    required_len: COUNT_END,
                    observed_len: input.len(),
                });
            }
            let count = u32::from_le_bytes([input[5], input[6], input[7], input[8]]);
            if count == 0 {
                return Err(G00ContentValidationError::Type2ZeroRegions);
            }
            let region_bytes = (count as usize)
                .checked_mul(G00_REGION_RECORD_BYTE_LEN)
                .ok_or(G00ContentValidationError::RegionTableOverflow)?;
            let offset = COUNT_END
                .checked_add(region_bytes)
                .ok_or(G00ContentValidationError::RegionTableOverflow)?;
            (count, offset)
        }
    };
    let (payload, declared_output) = strict_lzss_section(input, section_offset, g00_type)?;
    // Per type, resolve three walk parameters:
    //   * `expected_output` — the LZSS output size the decoder targets
    //     (the loop's hard upper bound; the walk never emits past it).
    //   * `accept_min` — the real content floor at/above which a payload
    //     that runs out *before* `expected_output` is a clean end-of-stream
    //     rather than a truncation error. This mirrors the xclannad
    //     `G00CONV` `lzExtract` oracle, whose loop terminates on
    //     `while (ldest < ldestend && lsrc < lsrcend)` — a stream exhausted
    //     before the destination fills simply stops, no error.
    //   * `max_trailing` — bounded trailing padding tolerated once the full
    //     output has been emitted.
    let (expected_output, accept_min, max_trailing) = match g00_type {
        G00Type::RawBgr => {
            let pixels = width
                .checked_mul(height)
                .ok_or(G00ContentValidationError::CountOverflow)?;
            let expected_bgr = pixels
                .checked_mul(G00_TYPE0_BGR_BYTES_PER_PIXEL)
                .ok_or(G00ContentValidationError::CountOverflow)?;
            let expected_rgba = pixels
                .checked_mul(4)
                .ok_or(G00ContentValidationError::CountOverflow)?;
            if declared_output != expected_rgba {
                return Err(G00ContentValidationError::DeclaredOutputMismatch {
                    g00_type,
                    declared: declared_output,
                    expected: expected_rgba,
                });
            }
            // Type-0 is byte-exact in both real corpora: the BGR canvas
            // fills exactly and the payload is fully consumed. Keep it
            // strict (floor == target, no trailing slack).
            (expected_bgr, expected_bgr, 0usize)
        }
        G00Type::PalettedLzss => {
            // The AVG2000 type-1 decoder targets `declared_output + 1`
            // (`uncompress_size = read_little_endian_int(data+9) + 1` in the
            // reference `Read_Type1`), but that trailing `+1` byte is a pure
            // over-allocation: the palette + one index-per-pixel occupy at
            // most `declared_output` bytes, and the reference never reads the
            // extra byte. Real Kanon streams therefore stop exactly one byte
            // short of the `+1` target with the payload fully consumed (40
            // files, all landing at `declared_output`). Set the floor at
            // `declared_output` so that legitimate palette+index coverage is
            // accepted while a genuinely short stream (emitting fewer than
            // `declared_output` bytes) is still rejected.
            let expected = declared_output
                .checked_add(1)
                .ok_or(G00ContentValidationError::CountOverflow)?;
            (expected, declared_output, 0usize)
        }
        // Type-2 fills the declared output exactly, then carries a bounded
        // trailing padding byte (see `G00_TYPE2_MAX_TRAILING_PADDING`).
        G00Type::RegionedLzss => (
            declared_output,
            declared_output,
            G00_TYPE2_MAX_TRAILING_PADDING,
        ),
    };
    let emitted_count =
        walk_lzss_counts(payload, expected_output, accept_min, max_trailing, g00_type)?;
    Ok(G00LzssValidation {
        g00_type,
        region_count,
        payload_bytes: payload.len(),
        emitted_count,
    })
}

/// Header and stream-valid pattern metadata only; this neither decodes pixels
/// nor validates palette/region-container semantics or visual correctness.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct G00PatternGeometry {
    pub g00_type: G00Type,
    pub pattern_count: u32,
    pub selected_pattern: u32,
    pub width: u32,
    pub height: u32,
    pub origin_x: i32,
    pub origin_y: i32,
}

/// Metadata failures from [`probe_g00_pattern_geometry`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum G00MetadataError {
    Validator(G00ContentValidationError),
    ZeroRegionTable,
    RegionTableBounds { region_count: u32 },
    InvertedRegion { pattern: u32 },
    RegionDimensionOverflow { pattern: u32 },
}

impl std::fmt::Display for G00MetadataError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("utsushi.reallive.g00.metadata")
    }
}

impl std::error::Error for G00MetadataError {}

/// Probe one g00 pattern's dimensions and origin after strict LZSS validation.
/// Types 0/1 expose one full-header pattern; type-2 out-of-range patterns fall
/// back to zero, matching RLVM's region selection behavior.
pub fn probe_g00_pattern_geometry(
    input: &[u8],
    pattern: u32,
) -> Result<G00PatternGeometry, G00MetadataError> {
    let validation = validate_g00_lzss_content(input).map_err(G00MetadataError::Validator)?;
    let width = u16::from_le_bytes([input[1], input[2]]) as u32;
    let height = u16::from_le_bytes([input[3], input[4]]) as u32;
    if validation.g00_type != G00Type::RegionedLzss {
        return Ok(G00PatternGeometry {
            g00_type: validation.g00_type,
            pattern_count: 1,
            selected_pattern: 0,
            width,
            height,
            origin_x: 0,
            origin_y: 0,
        });
    }
    let region_count = u32::from_le_bytes([input[5], input[6], input[7], input[8]]);
    if region_count == 0 {
        return Err(G00MetadataError::ZeroRegionTable);
    }
    let selected_pattern = if pattern < region_count { pattern } else { 0 };
    let table_start = G00_HEADER_PREAMBLE_BYTE_LEN + 4;
    let record_offset = (selected_pattern as usize)
        .checked_mul(G00_REGION_RECORD_BYTE_LEN)
        .and_then(|offset| table_start.checked_add(offset))
        .ok_or(G00MetadataError::RegionTableBounds { region_count })?;
    let record_end = record_offset
        .checked_add(G00_REGION_RECORD_BYTE_LEN)
        .ok_or(G00MetadataError::RegionTableBounds { region_count })?;
    if record_end > input.len() {
        return Err(G00MetadataError::RegionTableBounds { region_count });
    }
    let x1 = g00_i32(input, record_offset);
    let y1 = g00_i32(input, record_offset + 4);
    let x2 = g00_i32(input, record_offset + 8);
    let y2 = g00_i32(input, record_offset + 12);
    if x2 < x1 || y2 < y1 {
        return Err(G00MetadataError::InvertedRegion {
            pattern: selected_pattern,
        });
    }
    let dimension = |start: i32, end: i32| {
        u32::try_from(i64::from(end) - i64::from(start) + 1).map_err(|_| {
            G00MetadataError::RegionDimensionOverflow {
                pattern: selected_pattern,
            }
        })
    };
    Ok(G00PatternGeometry {
        g00_type: validation.g00_type,
        pattern_count: region_count,
        selected_pattern,
        width: dimension(x1, x2)?,
        height: dimension(y1, y2)?,
        origin_x: g00_i32(input, record_offset + 16),
        origin_y: g00_i32(input, record_offset + 20),
    })
}

fn g00_i32(input: &[u8], offset: usize) -> i32 {
    i32::from_le_bytes(
        input[offset..offset + 4]
            .try_into()
            .expect("checked record bounds"),
    )
}

fn strict_lzss_section(
    input: &[u8],
    section_offset: usize,
    g00_type: G00Type,
) -> Result<(&[u8], usize), G00ContentValidationError> {
    let header_end =
        section_offset
            .checked_add(8)
            .ok_or(G00ContentValidationError::HeaderBounds {
                g00_type,
                required_len: usize::MAX,
                observed_len: input.len(),
            })?;
    if input.len() < header_end {
        return Err(G00ContentValidationError::HeaderBounds {
            g00_type,
            required_len: header_end,
            observed_len: input.len(),
        });
    }
    let compressed_size = u32::from_le_bytes([
        input[section_offset],
        input[section_offset + 1],
        input[section_offset + 2],
        input[section_offset + 3],
    ]) as usize;
    if compressed_size < 8 {
        return Err(G00ContentValidationError::InvalidCompressedSize);
    }
    let declared_end = section_offset.checked_add(compressed_size).ok_or(
        G00ContentValidationError::OuterLengthMismatch {
            g00_type,
            declared_end: usize::MAX,
            observed_len: input.len(),
        },
    )?;
    if declared_end != input.len() {
        return Err(G00ContentValidationError::OuterLengthMismatch {
            g00_type,
            declared_end,
            observed_len: input.len(),
        });
    }
    let declared_output = u32::from_le_bytes([
        input[section_offset + 4],
        input[section_offset + 5],
        input[section_offset + 6],
        input[section_offset + 7],
    ]) as usize;
    Ok((&input[header_end..declared_end], declared_output))
}

/// Strict, allocation-free walk of the LZSS token stream.
///
/// Emits toward `expected` (the decoder's output target). Two real
/// format-legal tolerances — both grounded in the xclannad `G00CONV`
/// `lzExtract` oracle (`file.cc`, loop guard
/// `while (ldest < ldestend && lsrc < lsrcend)`) — are honoured:
///
///  * **Early end-of-stream** (`accept_min`): if the payload runs out at a
///    flag/token boundary *before* `expected` is reached, that is a clean
///    stream end (the oracle's `lsrc < lsrcend` guard failing) rather than
///    a truncation error, provided at least `accept_min` bytes were
///    emitted. Type-1 uses this for the AVG2000 `+1` over-allocation tail;
///    type-0/2 set `accept_min == expected` so a short stream still fails.
///  * **Bounded trailing padding** (`max_trailing`): once the full
///    `expected` output has been emitted, up to `max_trailing` unconsumed
///    payload bytes are tolerated (the oracle stops the moment
///    `ldest == ldestend` and never reads the pad). Type-2 uses this for
///    its single padding byte; type-0/1 set `max_trailing == 0`.
///
/// Genuine corruption — invalid back-distances, mid-token truncation below
/// the content floor, output overruns, oversized trailing residue — is
/// still rejected with a typed error.
fn walk_lzss_counts(
    payload: &[u8],
    expected: usize,
    accept_min: usize,
    max_trailing: usize,
    g00_type: G00Type,
) -> Result<usize, G00ContentValidationError> {
    let variant = match g00_type {
        G00Type::RawBgr => LzssVariant::Type0Bgr,
        G00Type::PalettedLzss | G00Type::RegionedLzss => LzssVariant::Scn2k,
    };
    let mut src_offset = 0;
    let mut emitted_count = 0;
    while emitted_count < expected {
        if src_offset == payload.len() {
            // Payload exhausted at a flag boundary. Clean end-of-stream when
            // the content floor is met (oracle: `lsrc < lsrcend` fails); a
            // genuinely short stream (below `accept_min`) still underruns.
            if emitted_count >= accept_min {
                return Ok(emitted_count);
            }
            return Err(G00ContentValidationError::OutputUnderrun {
                g00_type,
                emitted: emitted_count,
                expected,
            });
        }
        let flag = payload[src_offset];
        src_offset += 1;
        for bit in 0..8 {
            if emitted_count == expected {
                break;
            }
            if (flag >> bit) & 1 != 0 {
                let unit = variant.literal_unit();
                let remaining = payload.len().saturating_sub(src_offset);
                if remaining < unit {
                    // Literal cannot be completed: end-of-stream if the
                    // content floor is met, else a real truncation.
                    if emitted_count >= accept_min {
                        return Ok(emitted_count);
                    }
                    return Err(G00ContentValidationError::TruncatedLiteral {
                        g00_type,
                        src_offset,
                        required: unit,
                        remaining,
                    });
                }
                if expected - emitted_count < unit {
                    return Err(G00ContentValidationError::OutputOverrun {
                        g00_type,
                        emitted: emitted_count,
                        token_len: unit,
                        expected,
                    });
                }
                src_offset += unit;
                emitted_count += unit;
            } else {
                let remaining = payload.len().saturating_sub(src_offset);
                if remaining < 2 {
                    // Back-reference token cannot be completed: end-of-stream
                    // if the content floor is met (this is exactly where the
                    // 40 Kanon type-1 files land — one byte short of the `+1`
                    // AVG2000 target), else a real truncation.
                    if emitted_count >= accept_min {
                        return Ok(emitted_count);
                    }
                    return Err(G00ContentValidationError::TruncatedBackreference {
                        g00_type,
                        src_offset,
                        remaining,
                    });
                }
                let token =
                    (payload[src_offset] as usize) | ((payload[src_offset + 1] as usize) << 8);
                src_offset += 2;
                let (distance, token_len) = variant.split_token(token);
                if distance == 0 || distance > emitted_count {
                    return Err(G00ContentValidationError::InvalidDistance {
                        g00_type,
                        src_offset: src_offset - 2,
                        distance,
                        emitted: emitted_count,
                    });
                }
                if expected - emitted_count < token_len {
                    return Err(G00ContentValidationError::OutputOverrun {
                        g00_type,
                        emitted: emitted_count,
                        token_len,
                        expected,
                    });
                }
                emitted_count += token_len;
            }
        }
    }
    // Full declared output emitted. The payload is normally fully consumed;
    // a bounded trailing pad (type-2's single byte) is legitimate framing
    // anything larger is a genuine unconsumed-payload error.
    let trailing = payload.len().saturating_sub(src_offset);
    if trailing > max_trailing {
        return Err(G00ContentValidationError::UnconsumedPayload {
            g00_type,
            src_offset,
            payload_len: payload.len(),
        });
    }
    Ok(emitted_count)
}
