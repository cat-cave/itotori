//! Proprietary Siglus LZSS decompressor — **skeleton** (siglus-05; real
//! codec is siglus-06).
//!
//! After the constant-256-XOR + second-layer-key strip ([`crate::decrypt`])
//! a Siglus scene payload is a proprietary-LZSS-compressed bytecode blob.
//! This module owns the decompress direction; [`crate::compress`] owns the
//! inverse used by patchback.
//!
//! Skeleton status: [`decompress_siglus_lzss`] returns
//! [`SiglusDecompressError::NotImplemented`]. The control-bit / literal /
//! back-reference decode lands in siglus-06 against real bytes — there is
//! no synthetic LZSS table here.

use thiserror::Error;

/// Fatal errors raised by the Siglus LZSS decompressor.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SiglusDecompressError {
    /// The decompressor is not implemented in the skeleton; the real
    /// proprietary-LZSS decode lands in siglus-06.
    #[error(
        "kaifuu.siglus.decompress.not_implemented: proprietary Siglus LZSS decompressor is a \
         siglus-05 skeleton stub; the real control-bit/literal/back-reference decode lands in \
         siglus-06 against real bytes"
    )]
    NotImplemented,
    /// The compressed stream was exhausted before producing `dst_len`
    /// bytes.
    #[error(
        "kaifuu.siglus.decompress.truncated_input: compressed stream length {observed_len} \
         exhausted at position {position}, needed {needed} more bytes"
    )]
    TruncatedInput {
        observed_len: usize,
        position: usize,
        needed: usize,
    },
    /// A back-reference instruction targeted bytes outside the current
    /// output window.
    #[error(
        "kaifuu.siglus.decompress.back_reference_out_of_range: back-ref at position {position} \
         targets back={back} but only {emitted} bytes have been emitted"
    )]
    BackReferenceOutOfRange {
        position: usize,
        back: usize,
        emitted: usize,
    },
}

/// Decompress a proprietary-Siglus-LZSS-compressed scene payload.
///
/// `compressed` is the post-decrypt payload; `dst_len` is the declared
/// uncompressed size. Skeleton: always returns
/// [`SiglusDecompressError::NotImplemented`]. There is no `Ok(partial)`
/// path in the real implementation either — a truncated stream,
/// out-of-range back-reference, or emission shortfall is a typed error.
pub fn decompress_siglus_lzss(
    _compressed: &[u8],
    _dst_len: usize,
) -> Result<Vec<u8>, SiglusDecompressError> {
    Err(SiglusDecompressError::NotImplemented)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skeleton_decompress_returns_typed_not_implemented_not_fake_output() {
        let err = decompress_siglus_lzss(&[0u8; 16], 64)
            .expect_err("skeleton must not fabricate decompressed bytes");
        assert!(matches!(err, SiglusDecompressError::NotImplemented));
        assert!(
            err.to_string()
                .starts_with(crate::SIGLUS_UNIMPLEMENTED_MARKER)
        );
    }
}
