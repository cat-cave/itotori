//! KAIFUU-211 — Real-bytes patchback driver.
//!
//! Consumes a translated v0.2 BridgeBundle ([`TranslatedBundleV02`])
//! and a writable copy of a RealLive `Seen.txt`, walks each translated
//! unit, locates its source-side Textout body inside the appropriate
//! scene's decompressed bytecode, splices the Shift-JIS-encoded target
//! text into the bytecode, re-compresses the scene via the AVG32 LZSS
//! literal-only encoder ([`crate::compressor::compress_avg32_literal`]),
//! rewrites the scene header's compressed-size field, and rewrites the
//! 10,000-slot directory to accommodate the new scene offsets.
//!
//! Clean-room provenance:
//! - The driver consumes the KAIFUU-210 v0.2 BridgeBundle surface
//!   ([`kaifuu_core::BridgeBundleV02`]) and inverts the offsets the
//!   producer pinned in `sourceLocation.range`. No rlvm source is
//!   vendored; no Wine; no Windows helper; no external compressor.
//! - The re-emission pipeline (decompress → splice → recompress → header
//!   rewrite → directory rewrite) is the literal inverse of the
//!   KAIFUU-188 / KAIFUU-210 read pipeline.
//! - The translated-bundle schema is the source-side v0.2 BridgeBundle
//!   augmented with a per-unit `target` object carrying `{locale, text}`.
//!   The augmentation is local to this crate — itotori populates it via
//!   `apply_translated_bundle` callers.
//!
//! Hard constraints:
//! - The original `seen_txt_bytes` slice is NOT modified. The function
//!   returns a fresh `Vec<u8>` carrying the patched archive.
//! - Every failure mode is a typed [`PatchbackError`] variant. There is
//!   no silent fallback; no `unwrap()` clusters in production code.
//! - Length-changing edits are supported. The compressor emits
//!   variable-length output and the directory is rewritten accordingly.
//!   No length-preserving constraint is imposed on the translated text.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use kaifuu_core::{BridgeBundleV02, BridgeContractValidationError};

use crate::archive::{
    REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, REALLIVE_SEEN_TXT_SLOT_COUNT, RealLiveSceneIndex,
    parse_archive,
};
use crate::compressor::{CompressError, compress_avg32_literal};
use crate::decompressor::decompress_avg32;
use crate::encoding::{ShiftJisEncodeError, encode_shift_jis_slot};
use crate::opcode::{RealLiveOpcode, decode_dialogue_textout, parse_real_bytecode};
use crate::scene_header::{SCENE_HEADER_BYTE_LEN, SceneHeader, SceneHeaderError};

/// Stable error codes published per the KAIFUU-211 acceptance criteria.
pub const PATCHBACK_PROVENANCE_MISMATCH_CODE: &str =
    "kaifuu.reallive.patchback_provenance_mismatch";
pub const PATCHBACK_SCENE_PACKING_OVERFLOW_CODE: &str =
    "kaifuu.reallive.patchback_scene_packing_overflow";
pub const PATCHBACK_TARGET_NONEMPTY_CODE: &str = "kaifuu.reallive.patchback_target_nonempty";
pub const PATCHBACK_BUNDLE_SCHEMA_INVALID_CODE: &str =
    "kaifuu.reallive.patchback_bundle_schema_invalid";
pub const PATCHBACK_TARGET_ENCODE_FAILURE_CODE: &str =
    "kaifuu.reallive.patchback_target_encode_failure";
pub const PATCHBACK_SCENE_HEADER_INVALID_CODE: &str =
    "kaifuu.reallive.patchback_scene_header_invalid";
pub const PATCHBACK_DECOMPRESS_FAILURE_CODE: &str = "kaifuu.reallive.patchback_decompress_failure";
pub const PATCHBACK_COMPRESS_FAILURE_CODE: &str = "kaifuu.reallive.patchback_compress_failure";
pub const PATCHBACK_ARCHIVE_PARSE_FAILURE_CODE: &str =
    "kaifuu.reallive.patchback_archive_parse_failure";

/// Fatal errors raised by [`apply_translated_bundle`].
#[derive(Debug, Clone, Error)]
pub enum PatchbackError {
    /// The translated bundle's source side failed v0.2 schema
    /// validation, OR a unit was missing a `target.text` payload.
    #[error(
        "{PATCHBACK_BUNDLE_SCHEMA_INVALID_CODE}: translated bundle failed v0.2 validation: {message}"
    )]
    BundleSchemaInvalid { message: String },
    /// The source Seen.txt envelope failed to parse.
    #[error(
        "{PATCHBACK_ARCHIVE_PARSE_FAILURE_CODE}: source Seen.txt envelope failed to parse: {message}"
    )]
    ArchiveParseFailure { message: String },
    /// A unit's `sourceLocation.range` did not match any scene in the
    /// source archive, or pointed outside the scene's decompressed
    /// bytecode, or pointed at bytes that aren't a Shift-JIS Textout run.
    #[error(
        "{PATCHBACK_PROVENANCE_MISMATCH_CODE}: unit {bridge_unit_id} byte range {start_byte:#x}..{end_byte:#x} does not resolve to a scene textout body: {reason}"
    )]
    ProvenanceMismatch {
        bridge_unit_id: String,
        start_byte: u64,
        end_byte: u64,
        reason: String,
    },
    /// A scene header failed to parse after decompression.
    #[error(
        "{PATCHBACK_SCENE_HEADER_INVALID_CODE}: scene {scene_id:04} header parse failed: {message}"
    )]
    SceneHeaderInvalid { scene_id: u16, message: String },
    /// AVG32 decompression of an original scene's bytecode failed.
    #[error(
        "{PATCHBACK_DECOMPRESS_FAILURE_CODE}: scene {scene_id:04} bytecode decompression failed: {message}"
    )]
    DecompressFailure { scene_id: u16, message: String },
    /// AVG32 re-compression of a patched scene's bytecode failed.
    #[error(
        "{PATCHBACK_COMPRESS_FAILURE_CODE}: scene {scene_id:04} bytecode re-compression failed: {message}"
    )]
    CompressFailure { scene_id: u16, message: String },
    /// The translated `target.text` could not be encoded as Shift-JIS.
    #[error(
        "{PATCHBACK_TARGET_ENCODE_FAILURE_CODE}: unit {bridge_unit_id} target text could not be encoded as Shift-JIS: {message}"
    )]
    TargetEncodeFailure {
        bridge_unit_id: String,
        message: String,
    },
    /// After re-compression, the patched archive's directory could not
    /// fit the new scene sizes within `u32::MAX` total bytes (or some
    /// slot's `byte_offset + byte_len` would have overflowed).
    #[error(
        "{PATCHBACK_SCENE_PACKING_OVERFLOW_CODE}: patched archive size {observed_size} exceeds the encodable budget; {reason}"
    )]
    ScenePackingOverflow { observed_size: u64, reason: String },
}

impl From<BridgeContractValidationError> for PatchbackError {
    fn from(value: BridgeContractValidationError) -> Self {
        Self::BundleSchemaInvalid {
            message: value.to_string(),
        }
    }
}

/// Caller-supplied knobs for [`apply_translated_bundle`].
///
/// All fields are required; there are no implicit defaults. The
/// encoding choice is named here in code (per the KAIFUU-211 audit-
/// focus row "Encoding choice (UTF-8 vs Shift-JIS) defaulted instead of
/// named in code").
#[derive(Debug, Clone, Copy)]
pub struct PatchbackOpts {
    /// Target text-encoding for the patched bytes. RealLive's runtime
    /// reads Shift-JIS Textout bodies from the bytecode stream; the
    /// canonical patchback emits [`PatchbackEncoding::ShiftJis`].
    pub target_encoding: PatchbackEncoding,
}

impl PatchbackOpts {
    /// The canonical KAIFUU-211 emission mode: Shift-JIS target text.
    pub const fn shift_jis() -> Self {
        Self {
            target_encoding: PatchbackEncoding::ShiftJis,
        }
    }
}

/// Named encoding choice for the patched Textout bodies.
///
/// The KAIFUU-211 spec calls out the choice as audit-focused: the
/// patchback must NOT default the encoding silently. Today the only
/// supported variant is [`PatchbackEncoding::ShiftJis`]; a future UTF-8
/// runtime-decode hook would add a sibling variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatchbackEncoding {
    /// Encode `target.text` as Shift-JIS via
    /// [`crate::encoding::encode_shift_jis_slot`] and splice the
    /// resulting bytes into the bytecode stream verbatim.
    ShiftJis,
}

/// One per-unit translation entry consumed by the patchback driver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslatedUnitTarget {
    /// Matches the source [`kaifuu_core::LocalizationUnitV02::bridge_unit_id`].
    pub bridge_unit_id: String,
    /// Locale tag of the target text (e.g. `"en-US"`).
    pub target_locale: String,
    /// The translated body — UTF-8 string that will be re-encoded to
    /// Shift-JIS at write time.
    pub target_text: String,
}

/// Translated v0.2 BridgeBundle.
///
/// Wraps the source-side [`kaifuu_core::BridgeBundleV02`] (which is
/// validated against the v0.2 schema before being accepted) with one
/// `target_text` per unit.
///
/// JSON shape consumed by [`TranslatedBundleV02::from_json`]:
///
/// ```text
/// {
///   "schemaVersion": "0.2.0",
///   ...   // canonical v0.2 BridgeBundle fields
///   "units": [
///     {
///       "bridgeUnitId": "...",
///       ...   // canonical unit fields
///       "target": { "locale": "en-US", "text": "Hello!" }
///     },
///     ...
///   ]
/// }
/// ```
#[derive(Debug, Clone)]
pub struct TranslatedBundleV02 {
    pub source: BridgeBundleV02,
    pub targets: Vec<TranslatedUnitTarget>,
}

impl TranslatedBundleV02 {
    /// Parse a translated-bundle JSON value: validate the source side
    /// against the v0.2 contract and pull `target.text` per unit.
    pub fn from_json(value: &Value) -> Result<Self, PatchbackError> {
        let source = BridgeBundleV02::validate_json(value)?;
        let units_json = value
            .get("units")
            .and_then(Value::as_array)
            .ok_or_else(|| PatchbackError::BundleSchemaInvalid {
                message: "translated bundle JSON has no `units` array".into(),
            })?;
        if units_json.len() != source.units.len() {
            return Err(PatchbackError::BundleSchemaInvalid {
                message: format!(
                    "translated bundle units array length {observed} does not match validated unit count {expected}",
                    observed = units_json.len(),
                    expected = source.units.len()
                ),
            });
        }
        let mut targets = Vec::with_capacity(source.units.len());
        for (index, unit_json) in units_json.iter().enumerate() {
            let bridge_unit_id = source.units[index].bridge_unit_id.clone();
            let target_obj = unit_json
                .get("target")
                .and_then(Value::as_object)
                .ok_or_else(|| PatchbackError::BundleSchemaInvalid {
                    message: format!(
                        "translated bundle unit[{index}] is missing the `target` object"
                    ),
                })?;
            let target_locale = target_obj
                .get("locale")
                .and_then(Value::as_str)
                .ok_or_else(|| PatchbackError::BundleSchemaInvalid {
                    message: format!(
                        "translated bundle unit[{index}].target.locale must be a string"
                    ),
                })?
                .to_string();
            let target_text = target_obj
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| PatchbackError::BundleSchemaInvalid {
                    message: format!(
                        "translated bundle unit[{index}].target.text must be a string"
                    ),
                })?
                .to_string();
            if target_text.is_empty() {
                return Err(PatchbackError::BundleSchemaInvalid {
                    message: format!(
                        "translated bundle unit[{index}].target.text must be non-empty (got empty string)"
                    ),
                });
            }
            targets.push(TranslatedUnitTarget {
                bridge_unit_id,
                target_locale,
                target_text,
            });
        }
        Ok(Self { source, targets })
    }
}

/// Apply a translated v0.2 BridgeBundle to a writable copy of a
/// RealLive `Seen.txt`. Returns the patched archive bytes.
///
/// Steps (one synchronous pass — no I/O):
///
/// 1. Parse the source Seen.txt envelope via [`parse_archive`].
/// 2. Walk every `bundle.targets[i]` paired with its source `bundle.source.units[i]`.
///    Resolve each unit's `(scene_id, occurrence_index)` from its
///    `sourceUnitKey` (`reallive:scene-NNNN#OOOO`); the scene id selects
///    the owning archive entry. The `sourceLocation.range` is a
///    decompressed-stream interval and is not used for scene
///    attribution.
/// 3. Group edits by scene.
/// 4. For each modified scene:
///    - Decompress its bytecode via [`decompress_avg32`].
///    - Apply edits in **highest-offset-first** order so earlier edits
///      do not shift later ones' offsets.
///    - Re-compress the modified bytecode via
///      [`compress_avg32_literal`].
///    - Rewrite the scene header's `bytecode_compressed_size` field.
///    - Re-emit the scene blob.
/// 5. Re-pack the archive: rewrite the 10,000-slot directory with new
///    `(byte_offset, byte_len)` pairs; scenes after a modified scene
///    shift forward to accommodate length changes. Unmodified scenes
///    keep their bytes verbatim.
/// 6. Re-parse the patched archive as a self-check; mismatched scene
///    count surfaces [`PatchbackError::ArchiveParseFailure`].
pub fn apply_translated_bundle(
    original_seen_txt: &[u8],
    bundle: &TranslatedBundleV02,
    opts: &PatchbackOpts,
) -> Result<Vec<u8>, PatchbackError> {
    let scene_index =
        parse_archive(original_seen_txt).map_err(|diag| PatchbackError::ArchiveParseFailure {
            message: format!("{}: {}", diag.code, diag.message),
        })?;

    // Resolve each translation to a (scene_entry_index, edit) tuple.
    let mut edits_by_scene_index: BTreeMap<usize, Vec<ResolvedEdit>> = BTreeMap::new();
    for (target, unit) in bundle.targets.iter().zip(bundle.source.units.iter()) {
        let resolved = resolve_edit(target, unit, &scene_index, opts)?;
        edits_by_scene_index
            .entry(resolved.scene_entry_index)
            .or_default()
            .push(resolved);
    }

    // For every populated scene, prepare a `(scene_id, scene_bytes)`
    // tuple. Edited scenes get re-emitted; untouched ones keep their
    // original blob bytes verbatim.
    let mut emitted_scene_blobs: Vec<(u16, Vec<u8>)> =
        Vec::with_capacity(scene_index.entries.len());
    for (entry_index, entry) in scene_index.entries.iter().enumerate() {
        let blob_start = entry.byte_offset as usize;
        let blob_end = blob_start + entry.byte_len as usize;
        if blob_end > original_seen_txt.len() {
            return Err(PatchbackError::ArchiveParseFailure {
                message: format!(
                    "scene {scene:04} blob runs past archive length \
                     (offset={blob_start}, len={len}, archive_len={archive_len})",
                    scene = entry.scene_id,
                    len = entry.byte_len,
                    archive_len = original_seen_txt.len()
                ),
            });
        }
        let original_blob = &original_seen_txt[blob_start..blob_end];

        if let Some(edits) = edits_by_scene_index.get(&entry_index) {
            let patched = patch_scene_blob(entry.scene_id, original_blob, edits)?;
            emitted_scene_blobs.push((entry.scene_id, patched));
        } else {
            emitted_scene_blobs.push((entry.scene_id, original_blob.to_vec()));
        }
    }

    // Re-pack the archive: 80,000-byte directory + concatenated scene
    // blobs in slot-index order. Unpopulated slots stay zero.
    let mut directory = vec![0u8; REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize];
    let mut payload_cursor = REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN;
    let mut payload: Vec<u8> = Vec::new();
    for (scene_id, blob) in &emitted_scene_blobs {
        let slot_index = *scene_id as usize;
        if slot_index >= REALLIVE_SEEN_TXT_SLOT_COUNT {
            return Err(PatchbackError::ScenePackingOverflow {
                observed_size: 0,
                reason: format!("scene id {scene_id} is outside the 10,000-slot directory range"),
            });
        }
        if payload_cursor + (blob.len() as u64) > u64::from(u32::MAX) {
            return Err(PatchbackError::ScenePackingOverflow {
                observed_size: payload_cursor + (blob.len() as u64),
                reason: "scene byte_offset would exceed u32::MAX".into(),
            });
        }
        let byte_offset_u32: u32 =
            payload_cursor
                .try_into()
                .map_err(|_| PatchbackError::ScenePackingOverflow {
                    observed_size: payload_cursor,
                    reason: "scene byte_offset would exceed u32::MAX".into(),
                })?;
        let byte_len_u32: u32 =
            blob.len()
                .try_into()
                .map_err(|_| PatchbackError::ScenePackingOverflow {
                    observed_size: blob.len() as u64,
                    reason: format!("scene {scene_id:04} blob length exceeds u32::MAX"),
                })?;
        let slot_byte_start = slot_index * 8;
        directory[slot_byte_start..slot_byte_start + 4]
            .copy_from_slice(&byte_offset_u32.to_le_bytes());
        directory[slot_byte_start + 4..slot_byte_start + 8]
            .copy_from_slice(&byte_len_u32.to_le_bytes());
        payload.extend_from_slice(blob);
        payload_cursor += blob.len() as u64;
    }

    let mut output = Vec::with_capacity(directory.len() + payload.len());
    output.extend_from_slice(&directory);
    output.extend_from_slice(&payload);

    // Self-check: re-parse the patched archive. If the slot count
    // changed or any slot runs past the new file length, surface a
    // typed error rather than a silent corrupt output.
    let reparse = parse_archive(&output).map_err(|diag| PatchbackError::ArchiveParseFailure {
        message: format!(
            "patched Seen.txt failed self-check parse: {}: {}",
            diag.code, diag.message
        ),
    })?;
    if reparse.entries.len() != scene_index.entries.len() {
        return Err(PatchbackError::ArchiveParseFailure {
            message: format!(
                "patched archive has {} populated slots, source had {}",
                reparse.entries.len(),
                scene_index.entries.len()
            ),
        });
    }
    Ok(output)
}

/// Edit resolved against the source archive. Carries the indices and
/// occurrence keys needed to splice the new bytes into the decompressed
/// bytecode of the owning scene.
///
/// The per-unit `decompressed_byte_offset`/`_byte_len` are NOT
/// authoritative — the KAIFUU-210 bridge producer pinned them
/// approximately (Command opcode bodies do not surface their full
/// byte width on the typed variant, so the cursor under-counts).
/// [`patch_scene_blob`] re-walks the bytecode with [`parse_real_bytecode`]
/// and matches edits to opcodes by occurrence index, which is the
/// authoritative key per the v0.2 schema.
#[derive(Debug, Clone)]
struct ResolvedEdit {
    /// Index into `scene_index.entries` (NOT the raw slot id).
    scene_entry_index: usize,
    /// Source-side `bridgeUnitId`. Used for typed error reporting.
    bridge_unit_id: String,
    /// Surface kind (`"dialogue"` or `"choice_label"`). Determines
    /// whether to match a Textout or a Choice option during re-walk.
    surface_kind: String,
    /// Occurrence index within the scene (parsed from
    /// `sourceUnitKey = "reallive:scene-NNNN#OOOO"`). This is the
    /// authoritative key for matching edits to bytecode positions.
    occurrence_index: usize,
    /// New Shift-JIS-encoded bytes to splice in place of the existing
    /// Textout body.
    new_textout_bytes: Vec<u8>,
}

fn resolve_edit(
    target: &TranslatedUnitTarget,
    unit: &kaifuu_core::LocalizationUnitV02,
    scene_index: &RealLiveSceneIndex,
    opts: &PatchbackOpts,
) -> Result<ResolvedEdit, PatchbackError> {
    if target.bridge_unit_id != unit.bridge_unit_id {
        return Err(PatchbackError::BundleSchemaInvalid {
            message: format!(
                "translated bundle target bridgeUnitId {target_id} does not match unit bridgeUnitId {unit_id}",
                target_id = target.bridge_unit_id,
                unit_id = unit.bridge_unit_id,
            ),
        });
    }

    // Pull (startByte, endByte) from the source-location range. Per the
    // KAIFUU-210 producer the range is a DECOMPRESSED-bytecode-stream
    // interval — a single coordinate space. It is NOT used to identify
    // the owning scene (a decompressed offset has no meaning across the
    // compressed file layout); we keep it only for a positive-width
    // sanity check and typed-error context. The exact in-bytecode
    // position is recovered by re-walking [`parse_real_bytecode`] in
    // [`patch_scene_blob`], keyed on `occurrence_index`.
    let range = unit
        .source_location
        .get("range")
        .and_then(Value::as_object)
        .ok_or_else(|| PatchbackError::ProvenanceMismatch {
            bridge_unit_id: target.bridge_unit_id.clone(),
            start_byte: 0,
            end_byte: 0,
            reason: "sourceLocation has no `range` object".into(),
        })?;
    let start_byte = range
        .get("startByte")
        .and_then(Value::as_u64)
        .ok_or_else(|| PatchbackError::ProvenanceMismatch {
            bridge_unit_id: target.bridge_unit_id.clone(),
            start_byte: 0,
            end_byte: 0,
            reason: "sourceLocation.range.startByte must be a u64".into(),
        })?;
    let end_byte = range
        .get("endByte")
        .and_then(Value::as_u64)
        .ok_or_else(|| PatchbackError::ProvenanceMismatch {
            bridge_unit_id: target.bridge_unit_id.clone(),
            start_byte,
            end_byte: 0,
            reason: "sourceLocation.range.endByte must be a u64".into(),
        })?;
    if end_byte <= start_byte {
        return Err(PatchbackError::ProvenanceMismatch {
            bridge_unit_id: target.bridge_unit_id.clone(),
            start_byte,
            end_byte,
            reason: "endByte must be greater than startByte".into(),
        });
    }

    // Identify the owning scene AND the unit's occurrence index from the
    // v0.2 sourceUnitKey shape `reallive:scene-NNNN#OOOO`. The scene id
    // is the only honest scene key: it is invariant under the
    // decompressed/compressed coordinate split, so a unit deep in the
    // decompressed stream always resolves to its true scene (the prior
    // file-offset-containment path mis-resolved such units into a later
    // scene). `occurrence_index` is the authoritative in-scene
    // positioning key.
    let (scene_id, occurrence_index) = parse_scene_and_occurrence(&unit.source_unit_key)
        .ok_or_else(|| PatchbackError::ProvenanceMismatch {
            bridge_unit_id: target.bridge_unit_id.clone(),
            start_byte,
            end_byte,
            reason: format!(
                "sourceUnitKey {key:?} does not match the canonical \
                     `reallive:scene-NNNN#OOOO` shape",
                key = unit.source_unit_key
            ),
        })?;

    // Locate the scene entry whose slot id matches the unit's scene id.
    let (scene_entry_index, _entry) = scene_index
        .entries
        .iter()
        .enumerate()
        .find(|(_, entry)| entry.scene_id == scene_id)
        .ok_or_else(|| PatchbackError::ProvenanceMismatch {
            bridge_unit_id: target.bridge_unit_id.clone(),
            start_byte,
            end_byte,
            reason: format!(
                "no scene {scene_id:04} in archive directory \
                 (archive has {scene_count} populated scenes)",
                scene_count = scene_index.entries.len()
            ),
        })?;

    // Encode the target text per the named PatchbackOpts policy.
    let new_textout_bytes = match opts.target_encoding {
        PatchbackEncoding::ShiftJis => {
            encode_shift_jis_slot(&target.target_text).map_err(|err: ShiftJisEncodeError| {
                PatchbackError::TargetEncodeFailure {
                    bridge_unit_id: target.bridge_unit_id.clone(),
                    message: err.message,
                }
            })?
        }
    };

    Ok(ResolvedEdit {
        scene_entry_index,
        bridge_unit_id: target.bridge_unit_id.clone(),
        surface_kind: unit.surface_kind.clone(),
        occurrence_index,
        new_textout_bytes,
    })
}

/// Parse the `(scene_id, occurrence_index)` pair out of a v0.2
/// `sourceUnitKey`. Returns `None` if the key does not match the
/// canonical `reallive:scene-NNNN#OOOO` shape.
fn parse_scene_and_occurrence(key: &str) -> Option<(u16, usize)> {
    // `reallive:scene-{scene_id:04}#{occ:04}`.
    let rest = key.strip_prefix("reallive:scene-")?;
    let (scene_str, occurrence_str) = rest.split_once('#')?;
    let scene_id = scene_str.parse::<u16>().ok()?;
    let occurrence_index = occurrence_str.parse::<usize>().ok()?;
    Some((scene_id, occurrence_index))
}

/// Re-emit a scene blob with the given edits applied.
///
/// - Parses the existing scene header.
/// - Decompresses the existing bytecode.
/// - Re-walks the decompressed bytecode via [`parse_real_bytecode`] to
///   recover authoritative `(start_byte, end_byte)` ranges for every
///   text-emitting opcode (Textout body + Choice option bytes).
/// - Matches each edit to its opcode by `occurrence_index`.
/// - Applies edits in **descending opcode-offset order** so earlier
///   splices do not shift later ones.
/// - Re-compresses the new bytecode via [`compress_avg32_literal`].
/// - Rewrites the header's `bytecode_compressed_size` field in place.
/// - Returns `[header || compressed_bytecode]` concatenation.
fn patch_scene_blob(
    scene_id: u16,
    original_blob: &[u8],
    edits: &[ResolvedEdit],
) -> Result<Vec<u8>, PatchbackError> {
    let header = SceneHeader::parse(original_blob).map_err(|err| match err {
        SceneHeaderError::TruncatedHeader { .. } => PatchbackError::SceneHeaderInvalid {
            scene_id,
            message: err.to_string(),
        },
    })?;

    let bytecode_start = header.bytecode_offset as usize;
    // The re-emit always writes a full SCENE_HEADER_BYTE_LEN-byte header
    // and preserves bytecode_offset (0x20) verbatim. If the header
    // declares an offset *inside* the header region, the preserved offset
    // would point at header bytes while the compressed payload is written
    // at SCENE_HEADER_BYTE_LEN — any decompressor would then read bytecode
    // from inside the header and corrupt the scene. Reject it up front
    // with a typed error instead of silently emitting a corrupt blob.
    if bytecode_start < SCENE_HEADER_BYTE_LEN {
        return Err(PatchbackError::SceneHeaderInvalid {
            scene_id,
            message: format!(
                "scene header declares bytecode_offset={bytecode_start} inside the {SCENE_HEADER_BYTE_LEN}-byte header region (must be >= {SCENE_HEADER_BYTE_LEN})"
            ),
        });
    }
    let bytecode_end = bytecode_start + header.bytecode_compressed_size as usize;
    if bytecode_end > original_blob.len() {
        return Err(PatchbackError::SceneHeaderInvalid {
            scene_id,
            message: format!(
                "scene header declares bytecode_offset={bytecode_start} + compressed_size={size} past blob length {blob_len}",
                size = header.bytecode_compressed_size,
                blob_len = original_blob.len()
            ),
        });
    }
    let compressed = &original_blob[bytecode_start..bytecode_end];
    let mut decompressed = decompress_avg32(compressed, header.bytecode_uncompressed_size as usize)
        .map_err(|err| PatchbackError::DecompressFailure {
            scene_id,
            message: format!("{err}"),
        })?;

    // Re-walk the bytecode to recover the exact byte range of every
    // text-emitting opcode. The KAIFUU-210 producer cursored
    // approximate offsets that don't survive Command-with-arglist
    // widths; the authoritative key is `occurrence_index`.
    let text_unit_positions = collect_text_unit_positions(scene_id, &decompressed)?;

    // Build occurrence-index -> position lookup. Match each edit to
    // its position; any unmatched edit surfaces a typed provenance
    // mismatch BEFORE we mutate the bytecode.
    let mut planned_splices: Vec<PlannedSplice> = Vec::with_capacity(edits.len());
    for edit in edits {
        let position = text_unit_positions
            .iter()
            .find(|pos| pos.occurrence_index == edit.occurrence_index)
            .ok_or_else(|| PatchbackError::ProvenanceMismatch {
                bridge_unit_id: edit.bridge_unit_id.clone(),
                start_byte: edit.occurrence_index as u64,
                end_byte: 0,
                reason: format!(
                    "occurrence_index {} not found in scene {scene_id:04} after bytecode re-walk \
                     ({} text positions observed)",
                    edit.occurrence_index,
                    text_unit_positions.len()
                ),
            })?;
        if position.surface_kind != edit.surface_kind {
            return Err(PatchbackError::ProvenanceMismatch {
                bridge_unit_id: edit.bridge_unit_id.clone(),
                start_byte: position.start_byte as u64,
                end_byte: position.end_byte as u64,
                reason: format!(
                    "occurrence {} surface_kind mismatch: bundle says {} but bytecode opcode at this position is {}",
                    edit.occurrence_index, edit.surface_kind, position.surface_kind
                ),
            });
        }
        planned_splices.push(PlannedSplice {
            start_byte: position.start_byte,
            end_byte: position.end_byte,
            new_bytes: edit.new_textout_bytes.clone(),
        });
    }

    // Apply splices highest-offset-first so earlier splices don't
    // shift later ones.
    planned_splices.sort_by_key(|splice| std::cmp::Reverse(splice.start_byte));
    for splice in planned_splices {
        decompressed.splice(splice.start_byte..splice.end_byte, splice.new_bytes);
    }

    // Re-compress and re-emit the blob.
    let compressed_new = compress_avg32_literal(&decompressed).map_err(|err| match err {
        CompressError::InputTooLarge { .. } | CompressError::OutputTooLarge { .. } => {
            PatchbackError::CompressFailure {
                scene_id,
                message: err.to_string(),
            }
        }
    })?;

    // Rewrite the header in place:
    //  - bytecode_uncompressed_size at 0x24
    //  - bytecode_compressed_size at 0x28
    let mut new_header_bytes = original_blob[..SCENE_HEADER_BYTE_LEN].to_vec();
    let new_uncompressed: u32 =
        decompressed
            .len()
            .try_into()
            .map_err(|_| PatchbackError::CompressFailure {
                scene_id,
                message: format!(
                    "patched bytecode uncompressed length {} exceeds u32::MAX",
                    decompressed.len()
                ),
            })?;
    let new_compressed: u32 =
        compressed_new
            .len()
            .try_into()
            .map_err(|_| PatchbackError::CompressFailure {
                scene_id,
                message: format!(
                    "patched bytecode compressed length {} exceeds u32::MAX",
                    compressed_new.len()
                ),
            })?;
    new_header_bytes[0x24..0x28].copy_from_slice(&new_uncompressed.to_le_bytes());
    new_header_bytes[0x28..0x2c].copy_from_slice(&new_compressed.to_le_bytes());

    // Re-emit: new header + compressed bytecode. The
    // bytecode_offset stays at its original value (most commonly the
    // immediate post-header offset, but the format allows other layouts
    // where pre-bytecode tables sit between the header and the
    // compressed payload). Preserve the bytes between the header end
    // and `bytecode_offset` verbatim so any pre-bytecode tables
    // (kidoku, etc.) survive unchanged.
    let mut output = Vec::with_capacity(bytecode_start + compressed_new.len());
    output.extend_from_slice(&new_header_bytes);
    if bytecode_start > SCENE_HEADER_BYTE_LEN {
        output.extend_from_slice(&original_blob[SCENE_HEADER_BYTE_LEN..bytecode_start]);
    }
    output.extend_from_slice(&compressed_new);
    Ok(output)
}

/// Authoritative byte-range record for one text-emitting opcode in a
/// scene's decompressed bytecode, recovered by re-walking the bytecode
/// with [`parse_real_bytecode`].
#[derive(Debug, Clone)]
struct TextUnitPosition {
    /// Occurrence sequence within the scene (Textout + Choice options
    /// each consume one occurrence index, in encounter order — matches
    /// the KAIFUU-210 producer's `occurrence_index`).
    occurrence_index: usize,
    /// Surface kind (`"dialogue"` or `"choice_label"`).
    surface_kind: &'static str,
    /// Byte offset (within decompressed bytecode) where the text body
    /// starts.
    start_byte: usize,
    /// Byte offset (within decompressed bytecode) where the text body
    /// ends (exclusive).
    end_byte: usize,
}

/// Splice prepared from a `(ResolvedEdit, TextUnitPosition)` pair.
struct PlannedSplice {
    start_byte: usize,
    end_byte: usize,
    new_bytes: Vec<u8>,
}

/// Walk the decompressed bytecode and record exact byte ranges for
/// every text-emitting opcode. The walker mirrors the lead-byte switch
/// in [`parse_real_bytecode`] but tracks cursor positions so we can
/// pair each Textout / Choice-option with an authoritative byte range.
///
/// The walker is intentionally narrow: it tracks only the lead bytes
/// and element widths needed to advance past non-text opcodes. Any
/// truncation or unrecognised opener surfaces a typed
/// [`PatchbackError::DecompressFailure`] — partial walks would let
/// edits target the wrong bytes.
fn collect_text_unit_positions(
    scene_id: u16,
    decompressed: &[u8],
) -> Result<Vec<TextUnitPosition>, PatchbackError> {
    let opcodes =
        parse_real_bytecode(decompressed).map_err(|err| PatchbackError::DecompressFailure {
            scene_id,
            message: format!("scene bytecode re-walk failed: {err}"),
        })?;

    // We re-derive byte ranges by re-scanning the byte stream in
    // parallel with the opcode list. The opcode list's order matches
    // the stream's element order; we use the same lead-byte switch to
    // advance.
    let mut out: Vec<TextUnitPosition> = Vec::new();
    let mut pos: usize = 0;
    let mut occurrence: usize = 0;
    let mut opcode_iter = opcodes.iter();

    while pos < decompressed.len() {
        // Pull the next opcode for sanity (should mirror the lead-byte
        // switch perfectly). If the opcode iterator runs out before we
        // exhaust the byte stream, surface a typed error.
        let op = opcode_iter
            .next()
            .ok_or_else(|| PatchbackError::DecompressFailure {
                scene_id,
                message: format!(
                    "bytecode re-walk drift: opcode list exhausted at byte {pos} of {len}",
                    len = decompressed.len()
                ),
            })?;
        let lead = decompressed[pos];
        let (new_pos, recorded) = advance_one_element(scene_id, decompressed, pos, op, lead)?;
        if let Some((surface_kind, start_byte, end_byte)) = recorded {
            // A Textout run is only a translatable unit when its bytes are
            // readable Shift-JIS dialogue. Binary / control-byte catch-all
            // runs are NOT surfaced by the KAIFUU-210 producer
            // (`collect_units` applies the same `decode_dialogue_textout`
            // gate) and must NOT consume an occurrence index here either —
            // otherwise every later unit's occurrence_index would drift and
            // edits would splice into the wrong opcode. Skipping in both
            // paths keeps the binary run out of the edit plan, so it
            // survives patchback byte-identical.
            if decode_dialogue_textout(&decompressed[start_byte..end_byte]).is_some() {
                out.push(TextUnitPosition {
                    occurrence_index: occurrence,
                    surface_kind,
                    start_byte,
                    end_byte,
                });
                occurrence += 1;
            }
        }
        if let RealLiveOpcode::Choice { choices } = op {
            // Each non-empty Choice option is one `choice_label` unit,
            // anchored at the option's authoritative scene-relative byte
            // offset captured by the decoder (`parse_arg_list` for the
            // `( … )` form, `decode_select` for the `module_sel`
            // `SelectElement` `{ … }` block form). Sourcing the positions
            // from the typed `choices` keeps this patch-back re-walk
            // identical to the bridge producer (`bridge.rs`) for BOTH
            // framings — the previous `(arg0, arg1, …)` byte re-scan was
            // correct only for the comma form and would mis-anchor every
            // `{ … }` select option.
            for choice in choices {
                // A choice option is a translatable unit only when its bytes
                // decode as readable Shift-JIS dialogue (`decode_dialogue_textout`
                // — valid decode AND no control bytes). `None` covers an empty
                // interior `,,` segment AND a non-dialogue option such as an
                // rlBabel `###PRINT(<expr>)` runtime interpolation (compiled
                // expression bytes, not static text). The bridge producer
                // (`collect_units`) applies the SAME gate, so both paths skip
                // the identical options and the occurrence_index never drifts.
                if decode_dialogue_textout(&choice.bytes).is_none() {
                    continue;
                }
                let start_byte = choice.byte_offset as usize;
                let end_byte = start_byte + choice.bytes.len();
                out.push(TextUnitPosition {
                    occurrence_index: occurrence,
                    surface_kind: "choice_label",
                    start_byte,
                    end_byte,
                });
                occurrence += 1;
            }
        }
        if new_pos <= pos {
            // No forward progress: defensive guard against infinite
            // loops on a malformed stream.
            return Err(PatchbackError::DecompressFailure {
                scene_id,
                message: format!(
                    "bytecode re-walk made no forward progress at byte {pos}; \
                     opcode={label}",
                    label = op.label()
                ),
            });
        }
        pos = new_pos;
    }
    Ok(out)
}

/// Returned by [`advance_one_element`] when the advanced-past element
/// was a Textout — carries the surface-kind tag plus the body byte
/// range. `None` for every other element (Meta, Command, Expression,
/// Unknown).
type AdvancedTextRange = Option<(&'static str, usize, usize)>;

/// Advance one element in the byte stream. Returns the new byte
/// position and (if the element was a Textout) the `(surface_kind,
/// start, end)` of its body bytes.
fn advance_one_element(
    scene_id: u16,
    bytes: &[u8],
    pos: usize,
    op: &RealLiveOpcode,
    _lead: u8,
) -> Result<(usize, AdvancedTextRange), PatchbackError> {
    // Drive off the single source-of-truth element decoder so the re-walk
    // cursor can never drift from `parse_real_bytecode`'s boundaries.
    let (_decoded, consumed) = crate::opcode::decode_element(bytes, pos).map_err(|err| {
        PatchbackError::DecompressFailure {
            scene_id,
            message: format!("bytecode re-walk failed to decode element at byte {pos}: {err}"),
        }
    })?;
    let new_pos = pos + consumed;
    // A Textout carries a dialogue surface; every other element kind does
    // not. The caller's `op` and the freshly decoded element agree
    // because both originate from the same decoder.
    let recorded = match op {
        RealLiveOpcode::Textout { .. } => Some(("dialogue", pos, new_pos)),
        _ => None,
    };
    Ok((new_pos, recorded))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compressor::compress_avg32_literal;
    use crate::encoding::encode_shift_jis_slot;
    use serde_json::json;

    /// Build the smallest viable synthetic Seen.txt with one scene
    /// whose decompressed bytecode starts with one Shift-JIS Textout
    /// run (`ハ` = `0x83 0x6E`) followed by a MetaLine terminator.
    fn build_synthetic_archive() -> SyntheticArchive {
        // Decompressed bytecode: SJIS for "ハ" (0x83 0x6E), then a
        // MetaLine to terminate the textout run.
        let plaintext = vec![0x83u8, 0x6E, 0x0A, 0x05, 0x00];
        let compressed = compress_avg32_literal(&plaintext).expect("compress synthetic");

        // Synthesize a scene header pointing at the compressed payload
        // immediately after the 0x1d0-byte header.
        let mut header = vec![0u8; SCENE_HEADER_BYTE_LEN];
        header[0..4].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
        header[4..8].copy_from_slice(&110_002u32.to_le_bytes()); // compiler version
        // bytecode_offset at 0x20.
        header[0x20..0x24].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
        // bytecode_uncompressed_size at 0x24.
        header[0x24..0x28].copy_from_slice(&(plaintext.len() as u32).to_le_bytes());
        // bytecode_compressed_size at 0x28.
        header[0x28..0x2c].copy_from_slice(&(compressed.len() as u32).to_le_bytes());

        let mut scene_blob = Vec::with_capacity(header.len() + compressed.len());
        scene_blob.extend_from_slice(&header);
        scene_blob.extend_from_slice(&compressed);

        // Build the 80,000-byte directory with scene 1 sitting at file
        // offset 0x13880.
        let scene_offset = REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN;
        let mut archive =
            vec![0u8; REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize + scene_blob.len()];
        // Scene 1's slot is at directory byte offset 1 * 8 == 8.
        let slot_byte_start = 8;
        archive[slot_byte_start..slot_byte_start + 4]
            .copy_from_slice(&(scene_offset as u32).to_le_bytes());
        archive[slot_byte_start + 4..slot_byte_start + 8]
            .copy_from_slice(&(scene_blob.len() as u32).to_le_bytes());
        archive[REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize..].copy_from_slice(&scene_blob);

        // Decompressed-byte-offset of the Textout run inside the
        // decompressed bytecode: position 0 (starts immediately).
        let _ = scene_offset;
        SyntheticArchive { archive }
    }

    struct SyntheticArchive {
        archive: Vec<u8>,
    }

    #[test]
    fn patch_scene_blob_rejects_bytecode_offset_inside_header_region() {
        // 006 regression: patch_scene_blob guarded only the upper bound
        // (bytecode_end > blob.len()); a header declaring bytecode_offset
        // < SCENE_HEADER_BYTE_LEN slipped through and re-emitted a corrupt
        // scene (compressed payload at 0x1d0 while the preserved offset
        // points inside the header). It must now surface a typed
        // SceneHeaderInvalid before any mutation.
        let mut blob = vec![0u8; SCENE_HEADER_BYTE_LEN + 16];
        // bytecode_offset (0x20) = 0x20, well inside the 0x1d0 header.
        blob[0x20..0x24].copy_from_slice(&0x20u32.to_le_bytes());
        // compressed_size (0x28) small enough that bytecode_end is in
        // bounds — proving the NEW lower-bound guard is what fires.
        blob[0x28..0x2c].copy_from_slice(&4u32.to_le_bytes());

        let err = patch_scene_blob(42, &blob, &[])
            .expect_err("bytecode_offset inside the header must be rejected");
        assert!(
            matches!(err, PatchbackError::SceneHeaderInvalid { scene_id: 42, .. }),
            "expected SceneHeaderInvalid, got {err:?}"
        );
    }

    fn make_bundle_json(
        scene_blob_file_offset: u64,
        decompressed_byte_offset: u64,
        decompressed_byte_len: u64,
        target_text: &str,
    ) -> Value {
        let bridge_id = "01970000-0000-7000-8000-000000000001";
        let revision_id = "01970000-0000-7000-8000-000000000002";
        let asset_id = "01970000-0000-7000-8000-000000000003";
        let bridge_unit_id = "01970000-0000-7000-8000-000000000004";
        let surface_id = "01970000-0000-7000-8000-000000000005";
        let span_id_unused = "01970000-0000-7000-8000-000000000006";
        let _ = span_id_unused;
        let source_profile_revision_id = "01970000-0000-7000-8000-000000000007";

        let scene_blob_hash =
            kaifuu_core::sha256_hash_bytes(b"synthetic-scene-1-placeholder-content");
        let source_hash = kaifuu_core::sha256_hash_bytes("Synthetic source text".as_bytes());
        let source_profile_hash = kaifuu_core::sha256_hash_bytes(b"kaifuu-reallive-sweetie-hd");

        let start_byte = scene_blob_file_offset + decompressed_byte_offset;
        let end_byte = start_byte + decompressed_byte_len;

        json!({
            "schemaVersion": "0.2.0",
            "bridgeId": bridge_id,
            "sourceGame": {
                "gameId": "sweetie-hd",
                "gameVersion": "1.0.0",
                "sourceProfileId": "kaifuu-reallive-sweetie-hd",
                "sourceProfileRevision": {
                    "revisionId": source_profile_revision_id,
                    "revisionKind": "content_hash",
                    "value": source_profile_hash,
                },
            },
            "sourceBundleHash": scene_blob_hash,
            "sourceBundleRevision": {
                "revisionId": revision_id,
                "revisionKind": "content_hash",
                "value": scene_blob_hash,
            },
            "sourceLocale": "ja-JP",
            "hashStrategy": {
                "sourceProfile": {
                    "scope": "source_profile",
                    "algorithm": "sha256",
                    "normalization": "utf8-nfc-lf-json-stable-v1",
                },
                "sourceBundle": {
                    "scope": "source_bundle",
                    "algorithm": "sha256",
                    "normalization": "utf8-nfc-lf-json-stable-v1",
                },
                "sourceAsset": {
                    "scope": "source_asset",
                    "algorithm": "sha256",
                    "normalization": "bytes",
                },
                "sourceUnit": {
                    "scope": "source_unit",
                    "algorithm": "sha256",
                    "normalization": "utf8-nfc-lf-json-stable-v1",
                    "fields": ["sourceLocale", "sourceUnitKey", "sourceText", "spans.raw"],
                },
                "patchExport": {
                    "scope": "patch_export",
                    "algorithm": "sha256",
                    "normalization": "utf8-nfc-lf-json-stable-v1",
                },
                "deltaPackage": {
                    "scope": "delta_package",
                    "algorithm": "sha256",
                    "normalization": "utf8-nfc-lf-json-stable-v1",
                },
            },
            "extractor": {
                "name": "kaifuu-reallive-bridge",
                "version": "0.1.0",
            },
            "assets": [
                {
                    "assetId": asset_id,
                    "assetKey": "reallive:scene-0001",
                    "assetKind": "script",
                    "sourceHash": scene_blob_hash,
                    "sourceRevision": {
                        "revisionId": revision_id,
                        "revisionKind": "content_hash",
                        "value": scene_blob_hash,
                    },
                    "path": "REALLIVEDATA/Seen.txt#scene-0001",
                }
            ],
            "units": [
                {
                    "bridgeUnitId": bridge_unit_id,
                    "surfaceId": surface_id,
                    "surfaceKind": "dialogue",
                    "sourceUnitKey": "reallive:scene-0001#0000",
                    "occurrenceId": "scene-0001-occ-0000",
                    "sourceLocale": "ja-JP",
                    "sourceText": "Synthetic source text",
                    "sourceHash": source_hash,
                    "sourceRevision": {
                        "revisionId": revision_id,
                        "revisionKind": "content_hash",
                        "value": scene_blob_hash,
                    },
                    "sourceAssetRef": {
                        "assetId": asset_id,
                        "assetKey": "reallive:scene-0001",
                    },
                    "sourceLocation": {
                        "containerKey": "reallive:scene-0001",
                        "entryPath": ["scene", "0001", "units", "0000"],
                        "range": {
                            "startByte": start_byte,
                            "endByte": end_byte,
                        },
                    },
                    "speaker": {"knowledgeState": "not_applicable"},
                    "context": {
                        "route": {
                            "sceneKey": "scene-0001",
                            "position": "line-0000",
                        },
                    },
                    "spans": [],
                    "patchRef": {
                        "assetId": asset_id,
                        "writeMode": "replace",
                        "sourceUnitKey": "reallive:scene-0001#0000",
                        "sourceRevision": {
                            "revisionId": revision_id,
                            "revisionKind": "content_hash",
                            "value": scene_blob_hash,
                        },
                    },
                    "runtimeExpectation": {
                        "expectationKind": "trace_text",
                        "traceKey": "scene-0001-occ-0000",
                    },
                    "target": {
                        "locale": "en-US",
                        "text": target_text,
                    }
                }
            ],
            "policyRecords": [],
        })
    }

    #[test]
    fn empty_bundle_is_identity_round_trip_through_archive_self_check() {
        let SyntheticArchive { archive, .. } = build_synthetic_archive();
        // A bundle with zero target units is a programming error
        // (validate_json requires `units` to match the source side),
        // but a 1-unit bundle with target_text identical to the source
        // body should still re-emit a parseable archive.
        let bundle_json = make_bundle_json(
            REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
            0, // decompressed_byte_offset: Textout starts at decompressed offset 0
            2,
            "Hi", // 2-byte ASCII fits the source 2-byte SJIS body
        );
        let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");
        let patched = apply_translated_bundle(&archive, &bundle, &PatchbackOpts::shift_jis())
            .expect("apply succeeds");
        // Re-parse must yield a directory with the same number of
        // populated entries.
        let reparsed = parse_archive(&patched).expect("patched archive re-parses");
        assert_eq!(reparsed.entries.len(), 1);
    }

    #[test]
    fn unit_naming_a_scene_absent_from_the_archive_emits_typed_mismatch_error() {
        let SyntheticArchive { archive, .. } = build_synthetic_archive();
        // Scene attribution is by scene id (from sourceUnitKey), not by
        // byte containment. Name a scene the archive does not contain.
        let mut bundle_json = make_bundle_json(REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, 0, 2, "Hi");
        bundle_json["units"][0]["sourceUnitKey"] = serde_json::json!("reallive:scene-9999#0000");
        bundle_json["units"][0]["patchRef"]["sourceUnitKey"] =
            serde_json::json!("reallive:scene-9999#0000");
        let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");
        let err = apply_translated_bundle(&archive, &bundle, &PatchbackOpts::shift_jis())
            .expect_err("must reject a unit naming an absent scene");
        assert!(
            matches!(err, PatchbackError::ProvenanceMismatch { .. }),
            "expected ProvenanceMismatch, got {err:?}"
        );
    }

    /// Assemble a Seen.txt archive from `(scene_id, scene_blob)` pairs,
    /// laid out sequentially after the 80,000-byte directory.
    fn assemble_archive(scenes: &[(u16, Vec<u8>)]) -> Vec<u8> {
        let mut directory = vec![0u8; REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize];
        let mut payload: Vec<u8> = Vec::new();
        let mut cursor = REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN;
        for (scene_id, blob) in scenes {
            let slot = *scene_id as usize * 8;
            directory[slot..slot + 4].copy_from_slice(&(cursor as u32).to_le_bytes());
            directory[slot + 4..slot + 8].copy_from_slice(&(blob.len() as u32).to_le_bytes());
            payload.extend_from_slice(blob);
            cursor += blob.len() as u64;
        }
        let mut archive = directory;
        archive.extend_from_slice(&payload);
        archive
    }

    /// Build one scene blob (`header || compressed-bytecode`) from
    /// decompressed plaintext bytecode.
    fn scene_blob_from_plaintext(plaintext: &[u8]) -> Vec<u8> {
        let compressed = compress_avg32_literal(plaintext).expect("compress scene");
        let mut header = vec![0u8; SCENE_HEADER_BYTE_LEN];
        header[0..4].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
        header[4..8].copy_from_slice(&110_002u32.to_le_bytes());
        header[0x20..0x24].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
        header[0x24..0x28].copy_from_slice(&(plaintext.len() as u32).to_le_bytes());
        header[0x28..0x2c].copy_from_slice(&(compressed.len() as u32).to_le_bytes());
        let mut blob = header;
        blob.extend_from_slice(&compressed);
        blob
    }

    /// Decompress a scene's bytecode out of an assembled archive.
    fn decompress_scene(archive: &[u8], scene_id: u16) -> Vec<u8> {
        let index = parse_archive(archive).expect("archive parses");
        let entry = index
            .entries
            .iter()
            .find(|e| e.scene_id == scene_id)
            .expect("scene present");
        let blob = &archive
            [entry.byte_offset as usize..(entry.byte_offset + u64::from(entry.byte_len)) as usize];
        let header = SceneHeader::parse(blob).expect("header");
        let bc_start = header.bytecode_offset as usize;
        let bc_end = bc_start + header.bytecode_compressed_size as usize;
        decompress_avg32(
            &blob[bc_start..bc_end],
            header.bytecode_uncompressed_size as usize,
        )
        .expect("decompress")
    }

    #[test]
    fn deep_decompressed_offset_resolves_to_owning_scene_not_a_later_scene() {
        // BUG-2 regression: a unit whose decompressed range would land
        // inside a LATER scene's file extent must still resolve to its
        // own scene (by scene id), and patch only that scene.
        //
        // Two identical scenes; scene 1 owns the edited unit but its
        // range startByte is deliberately set inside scene 2's file
        // range (simulating a deep decompressed offset under the old
        // file-offset-mixing bug).
        let plaintext = vec![0x83u8, 0x6E, 0x0A, 0x05, 0x00];
        let blob1 = scene_blob_from_plaintext(&plaintext);
        let blob2 = scene_blob_from_plaintext(&plaintext);
        let scene2_file_offset = REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN + blob1.len() as u64;
        let archive = assemble_archive(&[(1, blob1), (2, blob2)]);

        // Range startByte lands inside scene 2's file extent; under the
        // old containment logic this mis-resolved to scene 2.
        let bundle_json = make_bundle_json(scene2_file_offset, 0, 2, "Hi");
        let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");
        let patched = apply_translated_bundle(&archive, &bundle, &PatchbackOpts::shift_jis())
            .expect("must resolve to owning scene 1 and apply");

        // Scene 1 was patched (now starts with SJIS "Hi"); scene 2 is
        // byte-identical to its original decompressed bytecode.
        let scene1 = decompress_scene(&patched, 1);
        let scene2 = decompress_scene(&patched, 2);
        let hi = encode_shift_jis_slot("Hi").expect("encode");
        assert!(
            scene1.starts_with(&hi),
            "scene 1 must carry the edit; got {scene1:02x?}"
        );
        assert_eq!(
            scene2, plaintext,
            "scene 2 must be untouched (the edit must not bleed into a later scene)"
        );
    }

    #[test]
    fn empty_choice_option_keeps_later_unit_splice_aligned_end_to_end() {
        // BUG-1 regression: a scene with an empty `,,` choice option plus
        // a trailing dialogue unit. The producer and the patchback
        // re-walk must agree on occurrence_index for every unit, so the
        // trailing unit splices correctly with NO ProvenanceMismatch.
        //
        // Bytecode: Textout(ハ), select{ "A", <empty>, "B" }, Textout(ニ),
        // MetaLine. The empty middle option is dropped by `decode_select`.
        let mut plaintext: Vec<u8> = Vec::new();
        plaintext.extend_from_slice(&[0x83, 0x6E]); // occ 0 dialogue
        plaintext.extend_from_slice(&[0x23, 0x00, 0x02, 0x01, 0x00, 0x02, 0x00, 0x00]);
        plaintext.push(b'{');
        plaintext.extend_from_slice(b"A"); // occ 1 "A"
        plaintext.extend_from_slice(&[0x0a, 0x05, 0x00]);
        plaintext.extend_from_slice(&[0x0a, 0x06, 0x00]); // empty option -> dropped
        plaintext.extend_from_slice(b"B"); // occ 2 "B"
        plaintext.extend_from_slice(&[0x0a, 0x07, 0x00]);
        plaintext.push(b'}');
        plaintext.extend_from_slice(&[0x83, 0x70]); // occ 3 dialogue
        plaintext.extend_from_slice(&[0x0a, 0x05, 0x00]);

        let blob = scene_blob_from_plaintext(&plaintext);
        let archive = assemble_archive(&[(1, blob)]);

        let opts = crate::bridge::BridgeOpts {
            game_id: "synthetic",
            game_version: "test",
            source_profile_id: "synthetic-profile",
            source_locale: "ja-JP",
            extractor_name: "kaifuu-reallive-bridge",
            extractor_version: "0.1.0",
            scene_kidoku_count: 0,
        };
        let report = crate::gameexe::parse_gameexe_inventory(b"");
        let produced = crate::produce_bundle(1, &[0u8; 32], &plaintext, &report, &opts)
            .expect("bundle builds");

        // Four units, occurrences 0..3 with no gap (empty option emitted
        // none).
        assert_eq!(produced.bundle.units.len(), 4);

        // Translate each unit to a distinct 1-byte ASCII target.
        let targets = ["a", "b", "c", "d"];
        let mut translated_value = produced.json.clone();
        {
            let units = translated_value["units"].as_array_mut().expect("units");
            for (i, unit) in units.iter_mut().enumerate() {
                unit["target"] = serde_json::json!({"locale": "en-US", "text": targets[i]});
            }
        }
        let translated =
            TranslatedBundleV02::from_json(&translated_value).expect("translated parses");
        let patched = apply_translated_bundle(&archive, &translated, &PatchbackOpts::shift_jis())
            .expect("apply must succeed (no occurrence drift)");

        // Correct-unit splice: every edit landed at its true position.
        let expected: Vec<u8> = vec![
            0x61, // occ0 -> "a"
            0x23, 0x00, 0x02, 0x01, 0x00, 0x02, 0x00, 0x00, // select header
            0x7b, // '{'
            0x62, // occ1 "A" -> "b"
            0x0a, 0x05, 0x00, // \n + line
            0x0a, 0x06, 0x00, // empty option (untouched)
            0x63, // occ2 "B" -> "c"
            0x0a, 0x07, 0x00, // \n + line
            0x7d, // '}'
            0x64, // occ3 -> "d"
            0x0a, 0x05, 0x00, // MetaLine
        ];
        let actual = decompress_scene(&patched, 1);
        assert_eq!(
            actual, expected,
            "trailing dialogue unit must splice at its own position with no drift"
        );
    }

    #[test]
    fn binary_catch_all_textout_survives_patchback_byte_identical_while_dialogue_is_translated() {
        use crate::test_fixtures::{SCENE1_BINARY_BLOCK_214B, SCENE2011_DIALOGUE_SJIS};

        // Scene bytecode: [real dialogue Textout][MetaLine]
        // [214-byte binary Textout][MetaLine]. The producer surfaces only
        // the dialogue unit; the binary run is excluded. A translate+
        // patchback run must (a) rewrite the dialogue to the en-US sentinel
        // and (b) leave the 214-byte binary block byte-identical — proving
        // the excluded data table is never overwritten.
        let mut plaintext: Vec<u8> = Vec::new();
        plaintext.extend_from_slice(SCENE2011_DIALOGUE_SJIS); // occ 0 dialogue
        plaintext.extend_from_slice(&[0x0a, 0x05, 0x00]); // MetaLine
        plaintext.extend_from_slice(SCENE1_BINARY_BLOCK_214B); // binary — excluded
        plaintext.extend_from_slice(&[0x0a, 0x06, 0x00]); // MetaLine

        let blob = scene_blob_from_plaintext(&plaintext);
        let archive = assemble_archive(&[(1, blob)]);

        let opts = crate::bridge::BridgeOpts {
            game_id: "synthetic",
            game_version: "test",
            source_profile_id: "synthetic-profile",
            source_locale: "ja-JP",
            extractor_name: "kaifuu-reallive-bridge",
            extractor_version: "0.1.0",
            scene_kidoku_count: 0,
        };
        let report = crate::gameexe::parse_gameexe_inventory(b"");
        let produced = crate::produce_bundle(1, &[0u8; 32], &plaintext, &report, &opts)
            .expect("bundle builds");

        // Only the dialogue run surfaced (binary excluded).
        assert_eq!(
            produced.bundle.units.len(),
            1,
            "only the dialogue run is surfaced; the binary catch-all run is excluded"
        );

        // Translate the single dialogue unit to an en-US sentinel.
        const SENTINEL: &str = "[EN] sentinel dialogue line";
        let mut translated_value = produced.json.clone();
        {
            let units = translated_value["units"].as_array_mut().expect("units");
            assert_eq!(units.len(), 1);
            units[0]["target"] = json!({"locale": "en-US", "text": SENTINEL});
        }
        let translated =
            TranslatedBundleV02::from_json(&translated_value).expect("translated parses");
        let patched = apply_translated_bundle(&archive, &translated, &PatchbackOpts::shift_jis())
            .expect("apply must succeed");

        let new_decompressed = decompress_scene(&patched, 1);

        // (a) The 214-byte binary data block survives byte-identical.
        let binary_survives = new_decompressed
            .windows(SCENE1_BINARY_BLOCK_214B.len())
            .any(|window| window == SCENE1_BINARY_BLOCK_214B);
        assert!(
            binary_survives,
            "the excluded 214-byte binary data block must survive patchback byte-identical"
        );

        // (b) The dialogue run was rewritten to the sentinel bytes.
        let sentinel_sjis = encode_shift_jis_slot(SENTINEL).expect("sentinel encodes");
        let sentinel_present = new_decompressed
            .windows(sentinel_sjis.len())
            .any(|window| window == sentinel_sjis.as_slice());
        assert!(
            sentinel_present,
            "the translated dialogue must appear as the en-US sentinel bytes in the patched bytecode"
        );

        // (c) The original Japanese dialogue bytes are gone (replaced).
        let original_dialogue_present = new_decompressed
            .windows(SCENE2011_DIALOGUE_SJIS.len())
            .any(|window| window == SCENE2011_DIALOGUE_SJIS);
        assert!(
            !original_dialogue_present,
            "the original ja-JP dialogue bytes must no longer appear verbatim after patchback"
        );
    }

    #[test]
    fn schema_invalid_bundle_emits_typed_error_before_any_write() {
        let SyntheticArchive { archive, .. } = build_synthetic_archive();
        // Drop schemaVersion to force v0.2 validation failure.
        let mut bundle_json = make_bundle_json(
            REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
            0, // decompressed_byte_offset: Textout starts at decompressed offset 0
            2,
            "Hi",
        );
        bundle_json
            .as_object_mut()
            .expect("object")
            .remove("schemaVersion");
        let err = TranslatedBundleV02::from_json(&bundle_json)
            .expect_err("schema-invalid bundle must surface typed error");
        assert!(
            matches!(err, PatchbackError::BundleSchemaInvalid { .. }),
            "expected BundleSchemaInvalid, got {err:?}"
        );
        // Sanity: the archive is unchanged.
        let reparsed = parse_archive(&archive).expect("source still parses");
        assert_eq!(reparsed.entries.len(), 1);
    }

    #[test]
    fn missing_target_text_surfaces_typed_schema_invalid() {
        let mut bundle_json = make_bundle_json(
            REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
            0, // decompressed_byte_offset: Textout starts at decompressed offset 0
            2,
            "Hi",
        );
        bundle_json["units"][0]
            .as_object_mut()
            .expect("object")
            .remove("target");
        let err = TranslatedBundleV02::from_json(&bundle_json)
            .expect_err("missing target object must surface typed error");
        assert!(matches!(err, PatchbackError::BundleSchemaInvalid { .. }));
    }

    #[test]
    fn length_changing_edit_succeeds_and_grows_archive() {
        let SyntheticArchive { archive, .. } = build_synthetic_archive();
        // Replace the 2-byte "ハ" with a 30-character ASCII string —
        // length-changing edit.
        let target = "[EN] hello world from kaifuu";
        let bundle_json = make_bundle_json(
            REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
            0, // decompressed_byte_offset: Textout starts at decompressed offset 0
            2,
            target,
        );
        let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");
        let patched = apply_translated_bundle(&archive, &bundle, &PatchbackOpts::shift_jis())
            .expect("apply succeeds despite length growth");
        let reparsed = parse_archive(&patched).expect("patched archive re-parses");
        assert_eq!(reparsed.entries.len(), 1);
        let new_entry = &reparsed.entries[0];
        assert!(
            new_entry.byte_len > 0,
            "patched scene must have non-zero length"
        );
        // Decompress & confirm the new bytecode starts with the SJIS-
        // encoded target.
        let blob_start = new_entry.byte_offset as usize;
        let blob_end = blob_start + new_entry.byte_len as usize;
        let header = SceneHeader::parse(&patched[blob_start..blob_end]).expect("header");
        let bytecode_start = blob_start + header.bytecode_offset as usize;
        let bytecode_end = bytecode_start + header.bytecode_compressed_size as usize;
        let new_decompressed = decompress_avg32(
            &patched[bytecode_start..bytecode_end],
            header.bytecode_uncompressed_size as usize,
        )
        .expect("re-decompress");
        let target_sjis = encode_shift_jis_slot(target).expect("encode target");
        assert!(
            new_decompressed.starts_with(&target_sjis),
            "patched bytecode must start with the new SJIS-encoded target bytes"
        );
    }
}
