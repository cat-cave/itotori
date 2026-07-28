use serde::{Deserialize, Serialize};

/// Fatal errors raised by [`super::AvgDecompressor::decompress`].
///
/// Every recoverable mismatch is a typed variant — there is no
/// `Ok(empty_vec)` fallback for truncated input or invalid flag bytes.
/// The alpha-gate contract forbids silent zero-state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecompressError {
    /// The compressed input was shorter than the fixed 8-byte preamble
    /// or ran out mid-token. The decompressor refuses to emit a partial
    /// buffer in this case.
    TruncatedInput {
        /// Total length of the input slice offered.
        observed_len: usize,
        /// Decompressor position at which the shortfall was detected.
        position: usize,
        /// Number of additional input bytes the decoder needed.
        needed: usize,
        /// Human-readable diagnostic.
        message: String,
    },
    /// The LZSS back-reference pointed outside the already-emitted
    /// output (distance 0, or distance greater than emitted length).
    BackReferenceOutOfRange {
        /// Length of `dst` at the moment the back-reference was decoded.
        emitted: usize,
        /// Back-distance the token requested.
        back_distance: usize,
        /// Run length the token requested.
        run_length: usize,
        /// Input position immediately after the token's bytes.
        position: usize,
    },
    /// The decompressor finished consuming input without producing the
    /// declared number of bytes. The partial output is dropped so the
    /// caller cannot accidentally treat a short stream as a full scene.
    UnexpectedEndOfStream {
        /// Declared uncompressed size the caller passed.
        declared_uncompressed_size: usize,
        /// Number of output bytes actually produced before the input
        /// was exhausted.
        emitted: usize,
        /// Final input position.
        position: usize,
    },
}

impl std::fmt::Display for DecompressError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecompressError::TruncatedInput { message, .. } => {
                write!(
                    formatter,
                    "utsushi.reallive.decompress.truncated_input: {message}"
                )
            }
            DecompressError::BackReferenceOutOfRange {
                emitted,
                back_distance,
                run_length,
                position,
            } => write!(
                formatter,
                "utsushi.reallive.decompress.back_reference_out_of_range: \
                 emitted={emitted} back_distance={back_distance} run_length={run_length} \
                 at input position {position}",
            ),
            DecompressError::UnexpectedEndOfStream {
                declared_uncompressed_size,
                emitted,
                position,
            } => write!(
                formatter,
                "utsushi.reallive.decompress.unexpected_end_of_stream: \
                 declared_uncompressed_size={declared_uncompressed_size} emitted={emitted} \
                 at input position {position}",
            ),
        }
    }
}

impl std::error::Error for DecompressError {}

/// Non-fatal observation emitted alongside a successful decompression.
///
/// Like [`crate::SceneHeaderWarning`], these are returned in the success
/// tuple — the alpha-gate contract requires non-silent semantics for
/// every documented branch that historically had a different on-disk
/// shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DecompressWarning {
    /// The caller did not pass an `xor2_key` for a compiler version
    /// that the rlvm `scenario.cc::Header` heuristic historically
    /// requested a second-level XOR pass on (currently: `110002`).
    ///
    /// For compiler-110002 HD remasters this is
    /// the correct call — outcome A in
    /// `RealLive encryption research notes`
    /// proves the rlvm branch is overly pessimistic for these titles.
    /// The warning fires so that downstream code (and audit tooling)
    /// can see the deliberate choice was made; it is never silent.
    Xor2NotApplied {
        /// The compiler version at the scene header that historically
        /// would have requested a second-level XOR.
        compiler_version: u32,
    },
}

impl std::fmt::Display for DecompressWarning {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecompressWarning::Xor2NotApplied { compiler_version } => write!(
                formatter,
                "utsushi.reallive.decompress.xor2_not_applied: compiler_version={compiler_version} \
                 historically requested a second-level XOR pass; xor2_key=None was supplied \
(outcome A for compiler-110002 titles — see \
                 RealLive encryption research notes)",
            ),
        }
    }
}
