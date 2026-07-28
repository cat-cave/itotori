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
    // (e.g. compiler_version 110002), its decompressed bytecode
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

