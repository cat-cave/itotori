//! Bundle-driven `Scene.pck` patch-back — **skeleton** (siglus-05).
//!
//! Consumes a translated v0.2 BridgeBundle and re-emits the `Scene.pck`
//! archive byte-correctly. Skeleton status:
//! [`apply_translated_bundle`] returns [`PatchbackError::NotImplemented`];
//! [`TranslatedBundleV02::from_json`] is the only stub that performs real
//! (schema) work, because validating an input bundle is not Siglus-bytes-
//! dependent — but it still refuses to fabricate a bundle when validation
//! is unavailable.

use serde_json::Value;
use thiserror::Error;

/// Stable diagnostic code: patchback is a skeleton stub.
pub const PATCHBACK_NOT_IMPLEMENTED_CODE: &str = "kaifuu.siglus.patchback_not_implemented";
/// Stable diagnostic code: a translated unit's provenance did not match
/// the source scene it claims to edit.
pub const PATCHBACK_PROVENANCE_MISMATCH_CODE: &str = "kaifuu.siglus.patchback_provenance_mismatch";
/// Stable diagnostic code: the re-emitted `Scene.pck` failed to re-parse.
pub const PATCHBACK_ARCHIVE_PARSE_FAILURE_CODE: &str =
    "kaifuu.siglus.patchback_archive_parse_failure";

/// Caller-supplied knobs for [`apply_translated_bundle`].
#[derive(Debug, Clone)]
pub struct PatchbackOpts {
    /// Target text encoding for re-encoded units. Siglus scene text is
    /// UTF-16LE; the field is explicit (no silent default).
    pub encoding: PatchbackEncoding,
}

impl PatchbackOpts {
    /// Construct opts for the Siglus default UTF-16LE encoding.
    pub const fn utf16le() -> Self {
        Self {
            encoding: PatchbackEncoding::Utf16Le,
        }
    }
}

/// Target text encoding for patch-back re-encode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum PatchbackEncoding {
    /// UTF-16LE (the Siglus scene/Gameexe text encoding).
    Utf16Le,
}

/// One resolved translated-unit target (the scene + unit a translation
/// edits, and the replacement text).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslatedUnitTarget {
    /// Canonical source-unit key (`siglus:scene-NNNN#OOOO`).
    pub source_unit_key: String,
    /// Replacement (translated) text for the unit.
    pub translated_text: String,
}

/// A translated v0.2 BridgeBundle resolved into Siglus patch-back
/// targets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslatedBundleV02 {
    pub targets: Vec<TranslatedUnitTarget>,
}

impl TranslatedBundleV02 {
    /// Resolve a translated v0.2 bundle JSON value into Siglus patch-back
    /// targets.
    ///
    /// Skeleton: always returns [`PatchbackError::NotImplemented`]. The
    /// real resolver maps each bundle unit's `patchRef` to a
    /// `(scene, unit)` target; it does not fabricate an empty target set.
    pub fn from_json(_value: &Value) -> Result<Self, PatchbackError> {
        Err(PatchbackError::NotImplemented)
    }
}

/// Fatal errors raised by Siglus bundle-driven patch-back.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PatchbackError {
    /// Patch-back is not implemented in the skeleton.
    #[error(
        "kaifuu.siglus.patchback_not_implemented: byte-correct Scene.pck patch-back is a \
         siglus-05 skeleton stub; the real bundle-driven re-emit (round-trip-exact decompress/\
         re-decompile/re-compress) lands against real bytes downstream"
    )]
    NotImplemented,
    /// A translated unit's provenance did not match the source scene.
    #[error(
        "kaifuu.siglus.patchback_provenance_mismatch: translated unit {source_unit_key} does not \
         match any source scene unit"
    )]
    ProvenanceMismatch { source_unit_key: String },
    /// The re-emitted `Scene.pck` failed to re-parse as a self-check.
    #[error("kaifuu.siglus.patchback_archive_parse_failure: {message}")]
    ArchiveParseFailure { message: String },
}

/// Apply a translated v0.2 bundle to an original `Scene.pck`, returning
/// the re-emitted archive bytes.
///
/// Skeleton: always returns [`PatchbackError::NotImplemented`]. The real
/// implementation re-walks each edited scene's decompiled bytecode,
/// splices translated unit bytes, re-compresses with
/// [`crate::compress::compress_siglus_lzss`], re-encrypts, rewrites the
/// `SceneList` offsets/sizes, and re-parses the result as a self-check.
/// Every non-translated scene survives byte-identical.
pub fn apply_translated_bundle(
    _original_scene_pck: &[u8],
    _bundle: &TranslatedBundleV02,
    _opts: &PatchbackOpts,
) -> Result<Vec<u8>, PatchbackError> {
    Err(PatchbackError::NotImplemented)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skeleton_patchback_returns_typed_not_implemented_not_fake_archive() {
        let bundle = TranslatedBundleV02 {
            targets: Vec::new(),
        };
        let err = apply_translated_bundle(&[0u8; 0x5C], &bundle, &PatchbackOpts::utf16le())
            .expect_err("skeleton must not fabricate a re-emitted Scene.pck");
        assert!(matches!(err, PatchbackError::NotImplemented));
        assert!(
            err.to_string()
                .starts_with(crate::SIGLUS_UNIMPLEMENTED_MARKER)
        );
    }

    #[test]
    fn skeleton_bundle_resolver_returns_typed_not_implemented_not_fake_targets() {
        let err = TranslatedBundleV02::from_json(&Value::Null)
            .expect_err("skeleton must not fabricate resolved targets");
        assert!(matches!(err, PatchbackError::NotImplemented));
    }
}
