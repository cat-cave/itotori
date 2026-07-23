//! Real-bytes patchback driver.
//! Consumes a translated v0.2 BridgeBundle ([`TranslatedBundleV02`])
//! and a writable copy of a RealLive `Seen.txt`, walks each translated
//! unit, locates its source-side Textout body inside the appropriate
//! scene's decompressed bytecode, splices the Shift-JIS-encoded target
//! text into the bytecode, re-compresses the scene via the AVG32 LZSS
//! literal-only encoder ([`crate::compressor::compress_avg32_literal`]),
//! rewrites the scene header's compressed-size field, and rewrites the
//! 10,000-slot directory to accommodate the new scene offsets.
//! Clean-room provenance:
//! - The driver consumes the v0.2 BridgeBundle surface
//!   ([`kaifuu_core::BridgeBundleV02`]) and inverts the offsets the
//!   producer pinned in `sourceLocation.range`. No rlvm source is
//!   vendored; no Wine; no Windows helper; no external compressor.
//! - The re-emission pipeline (decompress → splice → recompress → header
//!   rewrite → directory rewrite) is the literal inverse of the
//!   read pipeline.
//! - The translated-bundle schema is the source-side v0.2 BridgeBundle
//!   augmented with a per-unit `target` object carrying `{locale, text}`.
//!   The augmentation is local to this crate — itotori populates it via
//!   `apply_translated_bundle` callers.
//!   Hard constraints:
//! - The original `seen_txt_bytes` slice is NOT modified. The function
//!   returns a fresh `Vec<u8>` carrying the patched archive.
//! - Every failure mode is a typed [`PatchbackError`] variant. There is
//!   no silent fallback; no `unwrap` clusters in production code.
//! - Length-changing edits are supported. The compressor emits
//!   variable-length output and the directory is rewritten accordingly.
//!   No length-preserving constraint is imposed on the translated text.

use std::collections::BTreeMap;
use std::fmt;

use serde_json::Value;
use thiserror::Error;

use kaifuu_core::{BridgeContractValidationError, RedactedContentSummary};

use crate::archive::{
    REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, REALLIVE_SEEN_TXT_SLOT_COUNT, RealLiveSceneIndex,
    parse_archive,
};
use crate::compressor::{CompressError, compress_avg32_literal};
use crate::decompressor::decompress_avg32;
use crate::encoding::{ShiftJisEncodeError, encode_shift_jis_slot};
use crate::opcode::{
    RealLiveOpcode, decode_dialogue_textout, encode_choice_option_next_string_safe,
    parse_real_bytecode,
};
use crate::scene_header::{SCENE_HEADER_BYTE_LEN, SceneHeader, SceneHeaderError};
use crate::xor2::{
    Xor2Cipher, compiler_version_uses_xor2, decompress_archive_scenes, recover_archive_cipher,
};

#[path = "bundle_driven/scene_patch.rs"]
mod scene_patch;
mod translated_bundle;

use scene_patch::patch_scene_blob;
pub use translated_bundle::{
    PatchbackEncoding, PatchbackOpts, TranslatedBundleV02, TranslatedUnitTarget,
};

/// Stable error codes published per the acceptance criteria.
pub const PATCHBACK_PROVENANCE_MISMATCH_CODE: &str =
    "kaifuu.reallive.patchback_provenance_mismatch";
pub const PATCHBACK_SCENE_PACKING_OVERFLOW_CODE: &str =
    "kaifuu.reallive.patchback_scene_packing_overflow";
pub const PATCHBACK_TARGET_NONEMPTY_CODE: &str = "kaifuu.reallive.patchback_target_nonempty";
pub const PATCHBACK_BUNDLE_SCHEMA_INVALID_CODE: &str =
    "kaifuu.reallive.patchback_bundle_schema_invalid";
pub const PATCHBACK_TARGET_ENCODE_FAILURE_CODE: &str =
    "kaifuu.reallive.patchback_target_encode_failure";
pub const PATCHBACK_CONTROL_MARKUP_ONLY_TARGET_CODE: &str =
    "kaifuu.reallive.patchback_control_markup_only_target";

/// Reserved syntactic form of the producer's OUT-OF-BAND
/// control-markup marker: `<reallive.kidoku...>`.
/// RealLive's kidoku (read-flag) state is NOT stored in the Textout body —
/// it is a separate `MetaKidoku` opcode / the scene-header kidoku table. The
/// producer surfaces it as a SYNTHETIC readable marker prepended to
/// `sourceText` (so the v0.2 "span byte range must match sourceText"
/// invariant holds and the read surface is visible to QA), but there is no
/// corresponding byte run inside the Textout body for the patchback to
/// re-emit. The translation prompt reproduces every protected span inline, so
/// a draft — and thus a unit's `target.text` — carries the
/// `<reallive.kidoku N>` literal. Splicing that literal into the Textout body
/// is the control-markup round-trip bug (the retail lexer truncates the run
/// at `<reallive.kidoku `). The patchback therefore STRIPS every out-of-band
/// marker from `target.text` before encoding: those control bytes are
/// re-emitted byte-identical from the untouched `MetaKidoku` opcodes / header
/// table (they are never spliced), and only the translated dialogue body
/// (in-body markup + prose) is written into the Textout run.
pub const REALLIVE_OUT_OF_BAND_MARKER_OPEN: &str = "<reallive.kidoku ";
pub const PATCHBACK_SCENE_HEADER_INVALID_CODE: &str =
    "kaifuu.reallive.patchback_scene_header_invalid";
pub const PATCHBACK_DECOMPRESS_FAILURE_CODE: &str = "kaifuu.reallive.patchback_decompress_failure";
pub const PATCHBACK_COMPRESS_FAILURE_CODE: &str = "kaifuu.reallive.patchback_compress_failure";
pub const PATCHBACK_ARCHIVE_PARSE_FAILURE_CODE: &str =
    "kaifuu.reallive.patchback_archive_parse_failure";
pub const PATCHBACK_GOTO_TARGET_UNRESOLVABLE_CODE: &str =
    "kaifuu.reallive.patchback_goto_target_unresolvable";

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
    /// After stripping the out-of-band control markup (`<reallive.kidoku …>`)
    /// the translated `target.text` carried NO translatable dialogue body.
    /// Splicing an empty body would delete the Textout run and corrupt the
    /// scene framing, so this is surfaced instead of a silent collapse.
    #[error(
        "{PATCHBACK_CONTROL_MARKUP_ONLY_TARGET_CODE}: unit {bridge_unit_id} target text carried only out-of-band control markup ({REALLIVE_OUT_OF_BAND_MARKER_OPEN}…>) and no translatable dialogue body"
    )]
    ControlMarkupOnlyTarget { bridge_unit_id: String },
    /// After re-compression, the patched archive's directory could not
    /// fit the new scene sizes within `u32::MAX` total bytes (or some
    /// slot's `byte_offset + byte_len` would have overflowed).
    #[error(
        "{PATCHBACK_SCENE_PACKING_OVERFLOW_CODE}: patched archive size {observed_size} exceeds the encodable budget; {reason}"
    )]
    ScenePackingOverflow { observed_size: u64, reason: String },
    /// A goto-family jump-target pointer could not be recalculated after a
    /// length-changing splice: its destination fell strictly INSIDE an edited
    /// text body (a jump into the middle of the bytes being replaced), so the
    /// re-based offset would be ambiguous. Reported precisely rather than
    /// silently mis-patched.
    #[error(
        "{PATCHBACK_GOTO_TARGET_UNRESOLVABLE_CODE}: scene {scene_id:04} jump pointer at byte {pointer_offset:#x} targets byte {target} which lies strictly inside an edited text body [{body_start:#x}, {body_end:#x}); cannot re-base"
    )]
    GotoTargetUnresolvable {
        scene_id: u16,
        pointer_offset: usize,
        target: i64,
        body_start: usize,
        body_end: usize,
    },
}

impl From<BridgeContractValidationError> for PatchbackError {
    fn from(value: BridgeContractValidationError) -> Self {
        Self::BundleSchemaInvalid {
            message: value.to_string(),
        }
    }
}

/// Apply a translated v0.2 BridgeBundle to a writable copy of a
/// RealLive `Seen.txt`. Returns the patched archive bytes.
/// Steps (one synchronous pass — no I/O):
/// 1. Parse the source Seen.txt envelope via [`parse_archive`].
/// 2. Walk every `bundle.targets[i]` paired with its source `bundle.source.units[i]`.
///    Resolve each unit's `(scene_id, occurrence_index)` from its
///    `sourceUnitKey` (`reallive:scene-NNNN#OOOO`); the scene id selects
///    the owning archive entry. The `sourceLocation.range` is a
///    decompressed-stream interval and is not used for scene
///    attribution.
/// 3. Group edits by scene.
/// 4. For each modified scene:
/// - Decompress its bytecode via [`decompress_avg32`].
/// - Apply edits in **highest-offset-first** order so earlier edits
///   do not shift later ones' offsets.
/// - Re-compress the modified bytecode via
///   [`compress_avg32_literal`].
/// - Rewrite the scene header's `bytecode_compressed_size` field.
/// - Re-emit the scene blob.
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

    // Resolve each IN-SCOPE translation to a (scene_entry_index, edit)
    // tuple. The byte-fidelity contract is CONFIG-DRIVEN by `opts.scope`:
    // a unit whose `surfaceKind` is OUT of scope has NO edit resolved for
    // it, so its scene bytes — including a whole `module_sel` Choice
    // command and its `NextString` tokens under `DialogueOnly` — are
    // carried byte-identical by the re-packer. This replaces the old
    // hard-coded "only Textout dialogue may change" assumption: which
    // surfaces change is exactly the scope the caller declared.
    let mut edits_by_scene_index: BTreeMap<usize, Vec<ResolvedEdit>> = BTreeMap::new();
    for (target, unit) in bundle.targets.iter().zip(bundle.source.units.iter()) {
        if !opts.scope.includes_surface_kind(&unit.surface_kind) {
            // Out-of-scope surface: carried byte-identical (no splice).
            continue;
        }
        // Source-identical target: the driver emits target.text == sourceText for
        // every undrafted / deferred / out-of-scope / not-in-this-bounded-slice unit
        // as an explicit byte no-op. Skip it so its owning scene is never
        // decompressed/recompressed — the re-packer copies the original scene blob
        // BYTE-IDENTICAL. Only a genuinely-changed (drafted) unit resolves an edit,
        // so only scenes that contain such a unit are re-emitted. The comparison is
        // on the OUT-OF-BAND-STRIPPED forms (the producer prepends a synthetic
        // <reallive.kidoku N> marker to BOTH sourceText and the reproduced target;
        // that marker is re-emitted structurally regardless, so a target that differs
        // ONLY in the marker is still a body no-op).
        if is_source_identical_target(target, unit) {
            continue;
        }
        let resolved = resolve_edit(target, unit, &scene_index, *opts)?;
        edits_by_scene_index
            .entry(resolved.scene_entry_index)
            .or_default()
            .push(resolved);
    }

    // Second-level `xor_2` cipher. If any EDITED scene sets `use_xor_2`
    // (e.g. Sweetie HD, compiler_version 110002), its decompressed bytecode
    // is still ciphertext over the `[256, 513)` segment — the re-walk would
    // read garbage argc and fail with `truncated_command_args`, exactly as
    // the CLI extract did before its own xor_2 fix. Recover + validate the
    // per-game key over the WHOLE archive (a cross-scene known-plaintext
    // attack needs every eligible scene), then hand `patch_scene_blob` a
    // reusable cipher so it can decrypt before the re-walk/splice and
    // re-encrypt before recompression (keeping the patched scene
    // encrypted-at-rest, byte-consistent with the untouched scenes and
    // loadable by the retail interpreter). Gated on `compiler_version_uses_xor2`
    // so non-xor2 titles (Kanon's 10002) are untouched and pay no cost.
    let xor2_cipher =
        recover_xor2_cipher_if_needed(original_seen_txt, &scene_index, &edits_by_scene_index)?;

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
            let patched =
                patch_scene_blob(entry.scene_id, original_blob, edits, xor2_cipher.as_ref())?;
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

/// Decompress the whole archive and recover a validated `xor_2` cipher IFF at
/// least one EDITED scene sets `use_xor_2`. Returns `Ok(None)` when no edited
/// scene needs it (non-xor2 titles decompress nothing and pay no cost). Once a
/// cipher is needed it is required: an un-recoverable / un-validated key is a
/// typed failure, never a silent skip that would leave the re-walk reading
/// ciphertext.
fn recover_xor2_cipher_if_needed(
    original_seen_txt: &[u8],
    scene_index: &RealLiveSceneIndex,
    edits_by_scene_index: &BTreeMap<usize, Vec<ResolvedEdit>>,
) -> Result<Option<Xor2Cipher>, PatchbackError> {
    // Peek each EDITED scene's header: does any set use_xor_2?
    let mut needs_xor2 = false;
    for &entry_index in edits_by_scene_index.keys() {
        let entry = &scene_index.entries[entry_index];
        let blob_start = entry.byte_offset as usize;
        let blob_end = blob_start + entry.byte_len as usize;
        if blob_end > original_seen_txt.len() {
            // The emit loop surfaces the out-of-range error with full context.
            continue;
        }
        let blob = &original_seen_txt[blob_start..blob_end];
        if let Ok(header) = SceneHeader::parse(blob)
            && compiler_version_uses_xor2(header.compiler_version)
        {
            needs_xor2 = true;
            break;
        }
    }
    if !needs_xor2 {
        return Ok(None);
    }

    // Decompress every populated scene for the cross-scene key recovery (the
    // known-plaintext attack samples the `[256, 513)` segment of every eligible
    // scene). This uses the single shared helper so the patchback corpus is
    // built identically to the extract corpus (see `decompress_archive_scenes`)
    // — a divergence would risk recovering a different key on one path.
    let corpus = decompress_archive_scenes(original_seen_txt, scene_index);

    match recover_archive_cipher(&corpus.scenes) {
        Ok(cipher) => Ok(Some(cipher)),
        Err(report) => Err(PatchbackError::DecompressFailure {
            scene_id: 0,
            message: format!(
                "kaifuu.reallive.patchback_xor2_recovery_failed: an edited scene sets \
                 use_xor_2 but no per-game xor_2 key validated over the archive: {}",
                report
                    .finding
                    .as_deref()
                    .unwrap_or("no eligible scene reached the xor_2 segment"),
            ),
        }),
    }
}

/// Edit resolved against the source archive. Carries the indices and
/// occurrence keys needed to splice the new bytes into the decompressed
/// bytecode of the owning scene.
/// The per-unit `decompressed_byte_offset`/`_byte_len` are NOT
/// authoritative — the bridge producer pinned them
/// approximately (Command opcode bodies do not surface their full
/// byte width on the typed variant, so the cursor under-counts).
/// [`patch_scene_blob`] re-walks the bytecode with [`parse_real_bytecode`]
/// and matches edits to opcodes by occurrence index, which is the
/// authoritative key per the v0.2 schema.
#[derive(Clone)]
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

impl fmt::Debug for ResolvedEdit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let new_textout_bytes = RedactedContentSummary::from_bytes(&self.new_textout_bytes);
        formatter
            .debug_struct("ResolvedEdit")
            .field("scene_entry_index", &self.scene_entry_index)
            .field("bridge_unit_id", &self.bridge_unit_id)
            .field("surface_kind", &self.surface_kind)
            .field("occurrence_index", &self.occurrence_index)
            .field("new_textout_bytes", &new_textout_bytes)
            .finish()
    }
}

fn resolve_edit(
    target: &TranslatedUnitTarget,
    unit: &kaifuu_core::LocalizationUnitV02,
    scene_index: &RealLiveSceneIndex,
    opts: PatchbackOpts,
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
    // producer the range is a DECOMPRESSED-bytecode-stream
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

    // Strip the producer's OUT-OF-BAND control markup (`<reallive.kidoku …>`)
    // from the translated body before encoding. That marker is a synthetic
    // readable representation of a read-flag that lives OUTSIDE the Textout
    // body (a `MetaKidoku` opcode / the header kidoku table), which the
    // re-packer carries byte-identical without any splice. Leaving the literal
    // in the spliced body is the control-markup round-trip bug. See
    // [`REALLIVE_OUT_OF_BAND_MARKER_OPEN`]. In-body protected markup (name
    // token, asset ref, font tone) is NOT stripped — it is real Textout body
    // content that re-encodes Shift-JIS byte-identical.
    let body_target_text = strip_out_of_band_control_markup(&target.target_text);
    if body_target_text.is_empty() {
        return Err(PatchbackError::ControlMarkupOnlyTarget {
            bridge_unit_id: target.bridge_unit_id.clone(),
        });
    }

    // Encode the target text per the named PatchbackOpts policy. A
    // `choice_label` (`module_sel` option) MUST be NextString-safe: a raw
    // Shift-JIS splice of a translation carrying `[` / `,` / `.` / `!` /
    // `(` … would truncate the option and let the trailing bytes be
    // misread as select structure, corrupting the command. Dialogue
    // Textout bodies have no such framing and take the plain Shift-JIS
    // slot encoding.
    let new_textout_bytes = match opts.target_encoding {
        PatchbackEncoding::ShiftJis => {
            let encoded = if unit.surface_kind == "choice_label" {
                encode_choice_option_next_string_safe(&body_target_text)
            } else {
                encode_shift_jis_slot(&body_target_text)
            };
            encoded.map_err(
                |err: ShiftJisEncodeError| PatchbackError::TargetEncodeFailure {
                    bridge_unit_id: target.bridge_unit_id.clone(),
                    message: err.message,
                },
            )?
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

/// Remove every OUT-OF-BAND control-markup marker (`<reallive.kidoku …>`)
/// from a translated body string.
/// The markers are the producer's synthetic readable
/// representation of RealLive read-flag (kidoku) state, which is stored as a
/// separate `MetaKidoku` opcode / the scene-header kidoku table — NOT as bytes
/// inside the Textout body. The producer prepends them to `sourceText` and the
/// translation prompt reproduces every protected span inline, so a unit's
/// `target.text` carries the literal. The patchback must NOT splice it into the
/// Textout body (see [`REALLIVE_OUT_OF_BAND_MARKER_OPEN`]); the kidoku control
/// bytes are re-emitted byte-identical from the untouched bytecode instead.
/// The strip keys on the reserved marker SYNTAX rather than a specific unit's
/// `span.raw`, so it is robust to a translated body that carries any kidoku
/// index (or several) — every `<reallive.kidoku …>` run, whatever its
/// argument, is removed. A prose translation never legitimately contains the
/// reserved marker prefix.
pub fn strip_out_of_band_control_markup(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find(REALLIVE_OUT_OF_BAND_MARKER_OPEN) {
        // Everything up to the marker survives verbatim.
        out.push_str(&rest[..open]);
        let after_open = &rest[open + REALLIVE_OUT_OF_BAND_MARKER_OPEN.len()..];
        if let Some(close) = after_open.find('>') {
            // Drop `<reallive.kidoku …>` (open-prefix.. close `>` inclusive).
            rest = &after_open[close + 1..];
        } else {
            // Unterminated marker: nothing more to strip; keep the remainder
            // verbatim so we never silently truncate real content.
            out.push_str(&rest[open..]);
            return out;
        }
    }
    out.push_str(rest);
    out
}

/// True when the translated `target.text` carries NO body change versus the
/// source unit's `sourceText` — i.e. after removing the OUT-OF-BAND control
/// markup (`<reallive.kidoku …>`) from BOTH, the remaining translatable body is
/// byte-equal. Such a unit is a byte no-op: skipping it lets the re-packer carry
/// the owning scene's original blob byte-identical (no decompress/recompress).
fn is_source_identical_target(
    target: &TranslatedUnitTarget,
    unit: &kaifuu_core::LocalizationUnitV02,
) -> bool {
    strip_out_of_band_control_markup(&target.target_text)
        == strip_out_of_band_control_markup(&unit.source_text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compressor::compress_avg32_literal;
    use crate::encoding::encode_shift_jis_slot;
    use crate::scope::TranslationScope;
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
        // Plaintext synthetic scene -> NON-`xor_2` compiler version (110001,
        // not 110002/1110002): an `xor_2` version makes patchback try to
        // recover a key from unencrypted bytes and abort. Real `xor_2` is
        // covered by the real Sweetie HD real-bytes tests.
        header[4..8].copy_from_slice(&110_001u32.to_le_bytes()); // compiler version (non-xor_2)
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
    fn strip_out_of_band_control_markup_removes_kidoku_keeps_name_and_prose() {
        // Inline (single) kidoku marker + in-body name token + prose.
        assert_eq!(
            strip_out_of_band_control_markup("<reallive.kidoku 1>【和人】「hello」"),
            "【和人】「hello」"
        );
        // Synthesised table-form marker.
        assert_eq!(
            strip_out_of_band_control_markup("<reallive.kidoku table:1>narration"),
            "narration"
        );
        // Multiple markers (Kanon double-kidoku) anywhere in the string.
        assert_eq!(
            strip_out_of_band_control_markup("<reallive.kidoku 26><reallive.kidoku 27>「x」"),
            "「x」"
        );
        // No marker: verbatim.
        assert_eq!(strip_out_of_band_control_markup("「plain」"), "「plain」");
        // Unterminated marker: keep the remainder, never silently truncate.
        assert_eq!(
            strip_out_of_band_control_markup("<reallive.kidoku 1"),
            "<reallive.kidoku 1"
        );
    }

    #[test]
    fn patch_scene_blob_rejects_bytecode_offset_inside_header_region() {
        // 006 regression: patch_scene_blob guarded only the upper bound
        // (bytecode_end > blob.len); a header declaring bytecode_offset
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

        let err = patch_scene_blob(42, &blob, &[], None)
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
                    "normalization": "utf8-lf-json-stable-v1",
                },
                "sourceBundle": {
                    "scope": "source_bundle",
                    "algorithm": "sha256",
                    "normalization": "utf8-lf-json-stable-v1",
                },
                "sourceAsset": {
                    "scope": "source_asset",
                    "algorithm": "sha256",
                    "normalization": "bytes",
                },
                "sourceUnit": {
                    "scope": "source_unit",
                    "algorithm": "sha256",
                    "normalization": "utf8-lf-json-stable-v1",
                    "fields": ["sourceLocale", "sourceUnitKey", "sourceText", "spans.raw"],
                },
                "patchExport": {
                    "scope": "patch_export",
                    "algorithm": "sha256",
                    "normalization": "utf8-lf-json-stable-v1",
                },
                "deltaPackage": {
                    "scope": "delta_package",
                    "algorithm": "sha256",
                    "normalization": "utf8-lf-json-stable-v1",
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
        let patched = apply_translated_bundle(
            &archive,
            &bundle,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
        .expect("apply succeeds");
        // Re-parse must yield a directory with the same number of
        // populated entries.
        let reparsed = parse_archive(&patched).expect("patched archive re-parses");
        assert_eq!(reparsed.entries.len(), 1);
    }

    #[test]
    fn source_identical_target_is_a_noop_scene_stays_byte_identical() {
        let SyntheticArchive { archive, .. } = build_synthetic_archive();
        let source_blob = scene_blob(&archive, 1).to_vec();
        let bundle_json = make_bundle_json(
            REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
            0,
            2,
            "Synthetic source text",
        );
        let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");

        let patched = apply_translated_bundle(
            &archive,
            &bundle,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
        .expect("source-identical target must be a no-op");

        assert_eq!(
            scene_blob(&patched, 1),
            source_blob.as_slice(),
            "a source-identical target must carry the original scene blob verbatim"
        );
    }

    #[test]
    fn changed_target_still_re_emits_scene() {
        let SyntheticArchive { archive, .. } = build_synthetic_archive();
        let source_blob = scene_blob(&archive, 1).to_vec();
        let bundle_json = make_bundle_json(REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, 0, 2, "Hi");
        let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");

        let patched = apply_translated_bundle(
            &archive,
            &bundle,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
        .expect("changed target must re-emit the scene");

        assert_ne!(
            scene_blob(&patched, 1),
            source_blob.as_slice(),
            "a changed target must cause its owning scene to be re-emitted"
        );
    }

    #[test]
    fn target_differing_only_in_kidoku_marker_is_noop() {
        let SyntheticArchive { archive, .. } = build_synthetic_archive();
        let source_blob = scene_blob(&archive, 1).to_vec();
        let bundle_json = make_bundle_json(
            REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
            0,
            2,
            "<reallive.kidoku 1>Synthetic source text",
        );
        let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");

        let patched = apply_translated_bundle(
            &archive,
            &bundle,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
        .expect("marker-only difference must be a no-op");

        assert_eq!(
            scene_blob(&patched, 1),
            source_blob.as_slice(),
            "a target differing only by an out-of-band marker must carry the original scene blob verbatim"
        );
    }

    #[test]
    fn apply_strips_out_of_band_kidoku_marker_and_splices_only_the_body() {
        // A target carrying the producer's synthetic `<reallive.kidoku N>`
        // marker (as the translation prompt reproduces it inline) must have
        // that marker STRIPPED before the splice: the literal ASCII bytes of
        // `<reallive.kidoku` must never reach the patched bytecode, and the
        // real body ("Hi") must be spliced.
        let SyntheticArchive { archive, .. } = build_synthetic_archive();
        let bundle_json = make_bundle_json(
            REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
            0,
            2,
            "<reallive.kidoku 1>Hi",
        );
        let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");
        let patched = apply_translated_bundle(
            &archive,
            &bundle,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
        .expect("apply succeeds after stripping the out-of-band marker");
        let decompressed = decompress_scene(&patched, 1);
        let marker_bytes = REALLIVE_OUT_OF_BAND_MARKER_OPEN.as_bytes();
        assert!(
            !decompressed
                .windows(marker_bytes.len())
                .any(|w| w == marker_bytes),
            "the `<reallive.kidoku ` literal must NOT appear in the patched bytecode"
        );
        let hi = encode_shift_jis_slot("Hi").expect("encode Hi");
        assert!(
            decompressed.windows(hi.len()).any(|w| w == hi.as_slice()),
            "the translated body 'Hi' must be spliced into the patched bytecode"
        );
    }

    #[test]
    fn apply_rejects_target_that_is_only_out_of_band_control_markup() {
        let SyntheticArchive { archive, .. } = build_synthetic_archive();
        let bundle_json = make_bundle_json(
            REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN,
            0,
            2,
            "<reallive.kidoku 1>",
        );
        let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");
        let err = apply_translated_bundle(
            &archive,
            &bundle,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
        .expect_err("a control-markup-only target must be rejected");
        assert!(
            matches!(err, PatchbackError::ControlMarkupOnlyTarget { .. }),
            "expected ControlMarkupOnlyTarget, got {err:?}"
        );
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
        let err = apply_translated_bundle(
            &archive,
            &bundle,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
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
        // Plaintext scene -> NON-`xor_2` compiler version (110001, not
        // 110002/1110002): an `xor_2` version would make patchback try to
        // recover a key from unencrypted bytes and abort. The real `xor_2`
        // round-trip is covered by the real Sweetie HD real-bytes tests.
        header[4..8].copy_from_slice(&110_001u32.to_le_bytes());
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

    /// Return a scene blob using the parsed archive directory's offset/length.
    fn scene_blob(archive: &[u8], scene_id: u16) -> &[u8] {
        let index = parse_archive(archive).expect("archive parses");
        let entry = index
            .entries
            .iter()
            .find(|e| e.scene_id == scene_id)
            .expect("scene present");
        &archive
            [entry.byte_offset as usize..(entry.byte_offset + u64::from(entry.byte_len)) as usize]
    }

    #[test]
    fn deep_decompressed_offset_resolves_to_owning_scene_not_a_later_scene() {
        // BUG-2 regression: a unit whose decompressed range would land
        // inside a LATER scene's file extent must still resolve to its
        // own scene (by scene id), and patch only that scene.
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
        let patched = apply_translated_bundle(
            &archive,
            &bundle,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
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
        // scope=dialogue+choices: the two choice options are IN scope and get
        // re-emitted NextString-safe (`"b"` / `"c"`); the two dialogue units
        // take the plain Shift-JIS slot encoding (`a` / `d`).
        let patched = apply_translated_bundle(
            &archive,
            &translated,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueAndChoices),
        )
        .expect("apply must succeed (no occurrence drift)");

        // Correct-unit splice: every edit landed at its true position. The
        // choice options are quoted NextString runs (opening `"` 0x22,
        // body, closing `"` 0x22); the dialogue units are bare Shift-JIS.
        let expected: Vec<u8> = vec![
            0x61, // occ0 dialogue -> "a"
            0x23, 0x00, 0x02, 0x01, 0x00, 0x02, 0x00, 0x00, // select header
            0x7b, // '{'
            0x22, 0x62, 0x22, // occ1 "A" -> NextString-safe "b"
            0x0a, 0x05, 0x00, // \n + line
            0x0a, 0x06, 0x00, // empty option (untouched)
            0x22, 0x63, 0x22, // occ2 "B" -> NextString-safe "c"
            0x0a, 0x07, 0x00, // \n + line
            0x7d, // '}'
            0x64, // occ3 dialogue -> "d"
            0x0a, 0x05, 0x00, // MetaLine
        ];
        let actual = decompress_scene(&patched, 1);
        assert_eq!(
            actual, expected,
            "trailing dialogue unit must splice at its own position with no drift"
        );

        // The patched select command re-parses cleanly with both options
        // recovered as their NextString-safe forms — proving the choice
        // splice did not corrupt the `module_sel` framing.
        let ops = parse_real_bytecode(&actual).expect("patched bytecode must re-parse");
        let choice = ops
            .iter()
            .find_map(|op| match op {
                RealLiveOpcode::Choice { choices } => Some(choices),
                _ => None,
            })
            .expect("patched scene must still carry a Choice command");
        assert_eq!(choice.len(), 2, "both options must survive");
        assert_eq!(choice[0].bytes, b"\"b\"");
        assert_eq!(choice[1].bytes, b"\"c\"");
    }

    #[test]
    fn binary_catch_all_textout_survives_patchback_byte_identical_while_dialogue_is_translated() {
        use crate::test_fixtures::{SCENE1_BINARY_BLOCK_214B, SCENE2011_DIALOGUE_SJIS};
        const SENTINEL: &str = "[EN] sentinel dialogue line";

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
        let mut translated_value = produced.json.clone();
        {
            let units = translated_value["units"].as_array_mut().expect("units");
            assert_eq!(units.len(), 1);
            units[0]["target"] = json!({"locale": "en-US", "text": SENTINEL});
        }
        let translated =
            TranslatedBundleV02::from_json(&translated_value).expect("translated parses");
        let patched = apply_translated_bundle(
            &archive,
            &translated,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
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

    /// Build a synthetic single-scene archive whose bytecode is
    /// `Textout("ハ") · goto(@target) · MetaLine`, where the `goto` pointer
    /// targets the trailing MetaLine (an element boundary AFTER the edited
    /// dialogue). Returns `(archive, goto_target_offset, metaline_offset)`.
    fn build_archive_with_goto() -> (Vec<u8>, i32, usize) {
        let mut plaintext: Vec<u8> = Vec::new();
        // occ0 dialogue "ハ" at decompressed offset 0..2.
        plaintext.extend_from_slice(&[0x83, 0x6E]);
        // `goto` command (command_id 0x0001_0000): 0x23 opener, module_type=0,
        // module_id=1 (JMP), opcode=0, argc=0, overload=0, then one i32 target.
        // Header occupies offset 2..10; the i32 pointer occupies 10..14.
        plaintext.extend_from_slice(&[0x23, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
        let metaline_offset: usize = 14;
        plaintext.extend_from_slice(&(metaline_offset as i32).to_le_bytes());
        // The jump target: the MetaLine at offset 14.
        plaintext.extend_from_slice(&[0x0A, 0x05, 0x00]);
        assert_eq!(plaintext.len(), 17);

        let blob = scene_blob_from_plaintext(&plaintext);
        let archive = assemble_archive(&[(1, blob)]);
        (archive, metaline_offset as i32, metaline_offset)
    }

    /// A length-changing dialogue edit (both longer and shorter) re-bases the
    /// trailing `goto` pointer so it still targets the MetaLine at its NEW
    /// offset — never a stale offset that would land mid-command.
    #[test]
    fn length_changing_edit_recalculates_goto_target() {
        for target_text in ["HELLO WORLD FROM KAIFUU PATCHBACK", "A"] {
            let (archive, orig_target, _orig_metaline) = build_archive_with_goto();
            let new_body = encode_shift_jis_slot(target_text).expect("encode");
            let delta = new_body.len() as i64 - 2; // source "ハ" is 2 bytes.
            assert_ne!(delta, 0, "test needs a genuine length change");

            let bundle_json =
                make_bundle_json(REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN, 0, 2, target_text);
            let bundle = TranslatedBundleV02::from_json(&bundle_json).expect("bundle parses");
            let patched = apply_translated_bundle(
                &archive,
                &bundle,
                &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
            )
            .expect("length-changing patch with a goto must succeed");

            let new_decompressed = decompress_scene(&patched, 1);

            // The goto pointer was re-based by the length delta.
            let sites = crate::opcode::collect_goto_pointer_sites(&new_decompressed)
                .expect("patched scene goto pointers collect");
            assert_eq!(sites.len(), 1, "the synthetic scene has exactly one goto");
            let expected_target = orig_target as i64 + delta;
            assert_eq!(
                sites[0].target as i64, expected_target,
                "goto target must be re-based by {delta} (source {orig_target} -> {expected_target})"
            );

            // The re-based target still lands on an element boundary — the
            // MetaLine that moved with the length change.
            let spans =
                parse_real_bytecode(&new_decompressed).expect("patched bytecode re-decodes");
            let mut cursor = 0usize;
            let mut lands_on_metaline = false;
            for op in &spans {
                if cursor == sites[0].target as usize {
                    assert!(
                        matches!(op, RealLiveOpcode::MetaLine { .. }),
                        "goto must still target the MetaLine, got {}",
                        op.label()
                    );
                    lands_on_metaline = true;
                }
                let (_o, w) = crate::opcode::decode_element(&new_decompressed, cursor)
                    .expect("element decodes");
                cursor += w;
            }
            assert!(
                lands_on_metaline,
                "re-based goto target {} must land on an element boundary",
                sites[0].target
            );
        }
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
        let patched = apply_translated_bundle(
            &archive,
            &bundle,
            &PatchbackOpts::shift_jis(TranslationScope::DialogueOnly),
        )
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
