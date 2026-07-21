//! Bundle-driven, byte-correct `Scene.pck` patch-back.
//!
//! The driver validates every bridge literal against the source bytes, changes
//! only non-identity targets, and carries an untouched packed scene verbatim.
//! Edited scenes follow the exact inverse of `decode_scene_chunk`: scene
//! plaintext → LZSS → size header → constant XOR plus optional second-layer
//! XOR. Finally the `SceneList` data directory is rebuilt for the new sizes.

use std::collections::BTreeMap;
use std::fmt;

use thiserror::Error;

use kaifuu_core::BridgeContractValidationError;

use crate::archive::{SiglusSceneIndex, parse_scene_pck};
use crate::decrypt::SiglusSecondLayerMaterial;

mod provenance;
mod scene;
mod sections;
mod strings;
mod translated_bundle;

pub use translated_bundle::{TranslatedBundleV02, TranslatedUnitTarget};

/// Stable diagnostic code for malformed translated-bundle input.
pub const PATCHBACK_BUNDLE_SCHEMA_INVALID_CODE: &str =
    "kaifuu.siglus.patchback_bundle_schema_invalid";
/// Stable diagnostic code for an unresolved bridge provenance coordinate.
pub const PATCHBACK_PROVENANCE_MISMATCH_CODE: &str = "kaifuu.siglus.patchback_provenance_mismatch";
/// Stable diagnostic code for a source-hash freshness failure.
pub const PATCHBACK_STALE_SOURCE_CODE: &str = "kaifuu.siglus.patchback_stale_source";
/// Stable diagnostic code for a failed `Scene.pck` parse or directory rewrite.
pub const PATCHBACK_ARCHIVE_PARSE_FAILURE_CODE: &str =
    "kaifuu.siglus.patchback_archive_parse_failure";
/// Stable diagnostic code for an invalid or failed re-encode.
pub const PATCHBACK_SCENE_REENCODE_CODE: &str = "kaifuu.siglus.patchback_scene_reencode";
/// Stable diagnostic code for a post-patch decompile verification failure.
pub const PATCHBACK_SELF_CHECK_CODE: &str = "kaifuu.siglus.patchback_self_check";

/// Caller-supplied patchback configuration.
#[derive(Debug, Clone, Copy)]
pub struct PatchbackOpts<'a> {
    /// Siglus string-table emission encoding. It is named rather than implied.
    pub encoding: PatchbackEncoding,
    /// Recovered per-game key material. It is required exactly when the archive
    /// marks `extra_key_use`; no key is accepted for an archive without that
    /// flag, matching [`crate::scene_decode::decode_scene_chunk`].
    pub second_layer: Option<&'a SiglusSecondLayerMaterial>,
}

impl PatchbackOpts<'static> {
    /// Use the UTF-16LE string-table encoding for an archive with no second
    /// encryption layer.
    pub const fn utf16le() -> Self {
        Self {
            encoding: PatchbackEncoding::Utf16Le,
            second_layer: None,
        }
    }
}

impl<'a> PatchbackOpts<'a> {
    /// Use UTF-16LE with the recovered per-game scene key.
    pub const fn utf16le_with_second_layer(second_layer: &'a SiglusSecondLayerMaterial) -> Self {
        Self {
            encoding: PatchbackEncoding::Utf16Le,
            second_layer: Some(second_layer),
        }
    }
}

/// Named text encoding for a patched Siglus string table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum PatchbackEncoding {
    /// XOR-obfuscated UTF-16LE code units with a trailing NUL code unit.
    Utf16Le,
}

/// The freshly emitted `Scene.pck` bytes.
pub type PatchedScenePck = Vec<u8>;

/// Fatal errors raised by [`apply_translated_bundle`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PatchbackError {
    /// The translated bundle was not a valid v0.2 bridge plus targets.
    #[error("{PATCHBACK_BUNDLE_SCHEMA_INVALID_CODE}: {message}")]
    BundleSchemaInvalid { message: String },
    /// A unit's key/location did not name a concrete string-table literal.
    #[error("{PATCHBACK_PROVENANCE_MISMATCH_CODE}: unit {source_unit_key:?}: {reason}")]
    ProvenanceMismatch {
        source_unit_key: String,
        reason: String,
    },
    /// The located source literal changed since bridge extraction.
    #[error(
        "{PATCHBACK_STALE_SOURCE_CODE}: unit {source_unit_key:?}: expected source hash {expected_hash}, found {actual_hash}; re-extract before applying"
    )]
    StaleSource {
        source_unit_key: String,
        expected_hash: String,
        actual_hash: String,
    },
    /// A source or patched archive envelope could not be parsed safely.
    #[error("{PATCHBACK_ARCHIVE_PARSE_FAILURE_CODE}: {message}")]
    ArchiveParseFailure { message: String },
    /// A scene could not be decoded, re-encoded, or fit the format's u32 fields.
    #[error("{PATCHBACK_SCENE_REENCODE_CODE}: scene {scene_id}: {message}")]
    SceneReencode { scene_id: u32, message: String },
    /// Two distinct targets attempted to replace the same interned string.
    #[error(
        "{PATCHBACK_PROVENANCE_MISMATCH_CODE}: units {first:?} and {second:?} target the same string-table entry with different text"
    )]
    ConflictingStringTargets { first: String, second: String },
    /// The patched scene did not survive the siglus-08/10 structural check.
    #[error("{PATCHBACK_SELF_CHECK_CODE}: scene {scene_id}: {message}")]
    SelfCheck { scene_id: u32, message: String },
}

impl From<BridgeContractValidationError> for PatchbackError {
    fn from(value: BridgeContractValidationError) -> Self {
        Self::BundleSchemaInvalid {
            message: value.to_string(),
        }
    }
}

/// Apply a translated v0.2 bundle to `original_scene_pck`.
///
/// Identity targets are still freshness-gated, but cause no packed-scene or
/// directory rewrite. Therefore an all-identity bundle returns the source bytes
/// byte-for-byte. Changed text is spliced at descending byte offsets inside the
/// decoded string table; the string index is rebased before the scene is
/// compressed and encrypted again.
pub fn apply_translated_bundle(
    original_scene_pck: &[u8],
    bundle: &TranslatedBundleV02,
    opts: &PatchbackOpts<'_>,
) -> Result<PatchedScenePck, PatchbackError> {
    if bundle.targets.len() != bundle.source.units.len() {
        return Err(PatchbackError::BundleSchemaInvalid {
            message: format!(
                "translated bundle has {} targets for {} source units",
                bundle.targets.len(),
                bundle.source.units.len()
            ),
        });
    }
    let index = parse_scene_pck(original_scene_pck).map_err(|error| {
        PatchbackError::ArchiveParseFailure {
            message: format!("source Scene.pck: {error}"),
        }
    })?;
    let plans = scene::prepare_scene_plans(original_scene_pck, &index, bundle, opts)?;
    if plans.is_empty() {
        return Ok(original_scene_pck.to_vec());
    }

    let changed: BTreeMap<usize, Vec<u8>> = plans
        .iter()
        .map(|plan| (plan.entry_index, plan.packed_chunk.clone()))
        .collect();
    let output = rewrite_scene_list(original_scene_pck, &index, &changed)?;
    let reparsed =
        parse_scene_pck(&output).map_err(|error| PatchbackError::ArchiveParseFailure {
            message: format!("patched Scene.pck: {error}"),
        })?;
    scene::verify_scene_plans(&output, &reparsed, &plans, opts)?;
    Ok(output)
}

fn rewrite_scene_list(
    original: &[u8],
    index: &SiglusSceneIndex,
    changed: &BTreeMap<usize, Vec<u8>>,
) -> Result<Vec<u8>, PatchbackError> {
    let data_start = usize::try_from(index.scene_data_region_offset).map_err(|_| {
        PatchbackError::ArchiveParseFailure {
            message: "SceneList data offset does not fit usize".into(),
        }
    })?;
    let first_data_offset = index
        .entries
        .iter()
        .map(|entry| {
            entry
                .byte_offset
                .saturating_sub(index.scene_data_region_offset)
        })
        .min()
        .unwrap_or(0);
    let prefix_end = data_start
        .checked_add(usize::try_from(first_data_offset).map_err(|_| {
            PatchbackError::ArchiveParseFailure {
                message: "SceneList first data offset does not fit usize".into(),
            }
        })?)
        .filter(|end| *end <= original.len())
        .ok_or_else(|| PatchbackError::ArchiveParseFailure {
            message: "SceneList data prefix runs past source archive".into(),
        })?;
    let data_index_list = scene_data_index_list(original)?;
    let mut output = original[..prefix_end].to_vec();
    let mut relative_offset = first_data_offset;

    for (entry_index, entry) in index.entries.iter().enumerate() {
        let chunk = changed.get(&entry_index).cloned().unwrap_or_else(|| {
            let start = entry.byte_offset as usize;
            let end = start + entry.byte_len as usize;
            original[start..end].to_vec()
        });
        let relative_u32 =
            u32::try_from(relative_offset).map_err(|_| PatchbackError::ArchiveParseFailure {
                message: format!("scene {} data offset exceeds u32", entry.scene_id),
            })?;
        let length_u32 =
            u32::try_from(chunk.len()).map_err(|_| PatchbackError::ArchiveParseFailure {
                message: format!("scene {} packed length exceeds u32", entry.scene_id),
            })?;
        let directory_at = data_index_list
            .checked_add(entry_index.checked_mul(8).ok_or_else(|| {
                PatchbackError::ArchiveParseFailure {
                    message: "SceneList directory offset overflow".into(),
                }
            })?)
            .filter(|at| at.checked_add(8).is_some_and(|end| end <= output.len()))
            .ok_or_else(|| PatchbackError::ArchiveParseFailure {
                message: format!(
                    "scene {} directory entry is outside archive prefix",
                    entry.scene_id
                ),
            })?;
        output[directory_at..directory_at + 4].copy_from_slice(&relative_u32.to_le_bytes());
        output[directory_at + 4..directory_at + 8].copy_from_slice(&length_u32.to_le_bytes());
        output.extend_from_slice(&chunk);
        relative_offset = relative_offset
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| PatchbackError::ArchiveParseFailure {
                message: "SceneList payload size overflow".into(),
            })?;
    }
    Ok(output)
}

fn scene_data_index_list(bytes: &[u8]) -> Result<usize, PatchbackError> {
    let header_base = usize::from(bytes.starts_with(b"pack_scn")) * 8;
    let field_at = header_base + 17 * 4;
    let raw =
        bytes
            .get(field_at..field_at + 4)
            .ok_or_else(|| PatchbackError::ArchiveParseFailure {
                message: "SceneList data-index header field is truncated".into(),
            })?;
    let data_index_list = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
    Ok(data_index_list)
}

impl fmt::Display for PatchbackEncoding {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Utf16Le => formatter.write_str("utf-16le"),
        }
    }
}

#[cfg(test)]
mod tests;
