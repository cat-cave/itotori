//! Proprietary Siglus LZSS compressor — **skeleton** (siglus-05; real
//! codec lands with patchback in the siglus-2x range).
//! The inverse of [`crate::decompress`]. Patchback re-emits an edited
//! scene by re-compressing the patched bytecode with the same proprietary
//! LZSS the engine expects, so a round-trip
//! (decompress → edit → compress → decompress) reproduces the edit
//! byte-for-byte.
//! Skeleton status: [`compress_siglus_lzss`] returns
//! [`SiglusCompressError::NotImplemented`]. No synthetic "store-only"
//! encoder is provided — that would be a fake-success stub that the
//! engine would reject.

use thiserror::Error;

/// Fatal errors raised by the Siglus LZSS compressor.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SiglusCompressError {
    /// The compressor is not implemented in the skeleton; the real
    /// proprietary-LZSS encode lands with Siglus patchback.
    #[error(
        "kaifuu.siglus.compress.not_implemented: proprietary Siglus LZSS compressor is a \
         siglus-05 skeleton stub; the real encoder (round-trip-exact with the decompressor) \
         lands with Siglus patchback against real bytes"
    )]
    NotImplemented,
}

/// Compress a plaintext scene bytecode blob into the proprietary Siglus
/// LZSS form the engine expects.
/// Skeleton: always returns [`SiglusCompressError::NotImplemented`]. The
/// real implementation must be round-trip-exact with
/// [`crate::decompress::decompress_siglus_lzss`].
pub fn compress_siglus_lzss(_plaintext: &[u8]) -> Result<Vec<u8>, SiglusCompressError> {
    Err(SiglusCompressError::NotImplemented)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skeleton_compress_returns_typed_not_implemented_not_fake_stream() {
        let err = compress_siglus_lzss(b"plaintext")
            .expect_err("skeleton must not fabricate a compressed stream");
        assert!(matches!(err, SiglusCompressError::NotImplemented));
        assert!(
            err.to_string()
                .starts_with(crate::SIGLUS_UNIMPLEMENTED_MARKER)
        );
    }
}
