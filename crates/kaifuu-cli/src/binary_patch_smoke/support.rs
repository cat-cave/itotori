use super::{ADAPTER_ID, ASSET_ID, BRIDGE_UNIT_ID, COMMAND};

use kaifuu_core::sha256_hash_bytes;
use kaifuu_reallive::{
    PATCHBACK_ARCHIVE_PARSE_FAILURE_CODE, PATCHBACK_BUNDLE_SCHEMA_INVALID_CODE,
    PATCHBACK_COMPRESS_FAILURE_CODE, PATCHBACK_CONTROL_MARKUP_ONLY_TARGET_CODE,
    PATCHBACK_DECOMPRESS_FAILURE_CODE, PATCHBACK_GOTO_TARGET_UNRESOLVABLE_CODE,
    PATCHBACK_PROVENANCE_MISMATCH_CODE, PATCHBACK_SCENE_HEADER_INVALID_CODE,
    PATCHBACK_SCENE_PACKING_OVERFLOW_CODE, PATCHBACK_TARGET_ENCODE_FAILURE_CODE, PatchbackError,
    SCENE_HEADER_BYTE_LEN, compress_avg32_literal,
};
use serde_json::{Value, json};

/// Compiler version stamped in the synthetic scene header. This fixture's
/// bytecode is PLAINTEXT, so it deliberately uses a NON-`xor_2` version:
/// `compiler_version_uses_xor2` triggers on `110002`/`1110002`, and stamping
/// one of those would (correctly) make the patchback try to recover an
/// `xor_2` key from unencrypted bytes and abort. This smoke fixture exercises
/// the patch-pipeline mechanics on a plaintext archive; the real `xor_2`
/// encrypt/decrypt round-trip is covered by the real-byte patch test in
/// `tests/` (which runs against a real encrypted corpus). A synthetic
/// *encrypted* fixture is future work under
/// `publishable-synthetic-corpora-differential-validated`.
pub(super) const SYNTHETIC_COMPILER_VERSION: u32 = 110_001;

/// Canonical v0.2 sourceUnitKey for the synthetic dialogue unit
/// (`reallive:scene-NNNN#OOOO`). Scene 1, occurrence 0 — the first (and
/// only) translatable Textout in the synthetic scene.
pub(super) const SYNTHETIC_DIALOGUE_SOURCE_UNIT_KEY: &str = "reallive:scene-0001#0000";

/// Shift-JIS sentinel the synthetic bundle translates the dialogue unit
/// to. `"うえ"` (`0x82 0xA4 0x82 0xA6`) encodes to the same 4-byte budget
/// as the `"あい"` source body, so the bundle_driven re-emission keeps the
/// scene's decompressed length — and (because the AVG32 literal encoder's
/// output size depends only on its input size) the recompressed blob and
/// the whole archive stay byte-length-identical. That length-stability is
/// what lets the composed `PatchTransaction` identity
/// relocation invariant (`expected_payload_len == source length`) hold.
/// The leading `0x82` is a Shift-JIS lead byte, so the patched bytes still
/// re-parse as a Textout run.
pub(super) const SYNTHETIC_TARGET_TEXT: &str = "うえ";

/// Neutral-synthetic engine-format identifier stamped into the smoke
/// bundle's `sourceGame` metadata (`gameId`, `sourceProfileId`, and the
/// seed for the source-profile content hash). The smoke authors a
/// synthetic RealLive envelope from scratch — it is NOT a specific retail
/// game — so the bundle carries a synthetic engine-format id rather than a
/// real game name. A retail game is INPUT to the `kaifuu patch`/`extract`
/// commands (caller-supplied `--game-id`), never baked into this shipped
/// smoke fixture.
pub(super) const SYNTHETIC_GAME_ID: &str = "kaifuu-reallive-synthetic";

/// Build the synthetic scene's **decompressed** bytecode: the real
/// post- opener-byte shape decoded by
/// `kaifuu_reallive::parse_scene`, exercising every alpha string role
/// through real 8-byte `CommandElement` headers (plus, for the Choice
/// role, the `module_sel` `SelectElement` `{ … }` block framing):
/// - Meta prologue (MetaLine / MetaEntrypoint / MetaKidoku).
/// - `SetSpeaker` — module_msg (id 3) opcode 3 → `CharacterTextDisplay`.
/// - `Textout` — inline Shift-JIS run `"あい"` (the editable Dialogue
///   unit at occurrence 0).
/// - `TextDisplay` — module_msg (id 3) opcode 10 → `TextDisplay`.
/// - `Choice` — module_sel (module_type 0, id 2) opcode 0 (`select_w`),
///   decoded by `decode_select` as a `{ "あ" \n "い" \n }` select-block (NOT a
///   flat `(...)` arg list): the `{`/`}` braces frame two Shift-JIS option
///   runs, each closed by a `\n`+i16 line marker.
/// - scene terminator — module_sys (id 4) opcode 17 → `End`.
///   The whole body decodes with **0 unknown opcodes**; no retail bytecode
///   or text is copied — every byte is authored from the documented shape.
pub fn synthetic_scene_bytecode() -> Vec<u8> {
    // An 8-byte real `CommandElement` header (rlvm `bytecode.h:CommandElement`
    // — research anchor only): `0x23`, module_type, module_id,
    // opcode_u16_le (lo, hi), argc, overload, reserved.
    fn command_header(module_type: u8, module_id: u8, opcode: u16, argc: u8) -> [u8; 8] {
        let [op_lo, op_hi] = opcode.to_le_bytes();
        [0x23, module_type, module_id, op_lo, op_hi, argc, 0x00, 0x00]
    }

    // module_type 1 = Kepago RLOperation namespace (msg / sys); module ids
    // per the documented rlvm `module_*.cc` catalogue. The select / Choice
    // family lives in its own module_type 0, module_id 2 (rlvm `module_sel`:
    // `select_w`/`select`/`select_s2`/`select_s` at opcodes 0..=3), and is
    // framed as a `SelectElement` `{ … }` block, NOT a flat `(...)` arg list.
    const MODULE_TYPE_KEPAGO: u8 = 1;
    const MODULE_TYPE_SEL: u8 = 0;
    const MODULE_MSG: u8 = 3;
    const MODULE_SEL: u8 = 2;
    const MODULE_SYS: u8 = 4;
    // SelectElement block braces (`{` `}`) consumed by `decode_select`.
    const SELECT_BLOCK_OPEN: u8 = 0x7B;
    const SELECT_BLOCK_CLOSE: u8 = 0x7D;

    let mut scene = Vec::new();
    // Meta prologue (real scene-1 opens with a MetaLine/MetaEntrypoint run).
    scene.extend_from_slice(&[0x0A, 0x02, 0x00]); // MetaLine(2)
    scene.extend_from_slice(&[0x21, 0x00, 0x00]); // MetaEntrypoint(0)
    scene.extend_from_slice(&[0x40, 0x01, 0x00]); // MetaKidoku(1)
    // SetSpeaker: module_msg opcode 3 → CharacterTextDisplay (argc 0).
    scene.extend_from_slice(&command_header(MODULE_TYPE_KEPAGO, MODULE_MSG, 3, 0));
    // Textout: inline Shift-JIS dialogue run "あい" (82 A0 82 A2). This is
    // the single editable Dialogue unit the bundle translates.
    scene.extend_from_slice(&[0x82, 0xA0, 0x82, 0xA2]);
    // TextDisplay: module_msg opcode 10 (in 1..=200,!= 3) (argc 0).
    scene.extend_from_slice(&command_header(MODULE_TYPE_KEPAGO, MODULE_MSG, 10, 0));
    // Choice: module_sel (module_type 0, id 2) opcode 0 (`select_w`), decoded
    // by `decode_select` as a `{ "あ" \n "い" \n }` block. The 8-byte header is
    // followed by the `{` block open, then per option the Shift-JIS option
    // text plus a `\n`+i16 line marker, then the `}` block close. (argc is
    // unused by the select-block decoder.)
    scene.extend_from_slice(&command_header(MODULE_TYPE_SEL, MODULE_SEL, 0, 0));
    scene.push(SELECT_BLOCK_OPEN); // 0x7B '{' block open
    scene.extend_from_slice(&[0x82, 0xA0]); // option 0 "あ"
    scene.extend_from_slice(&[0x0A, 0x00, 0x00]); // \n+i16 line marker
    scene.extend_from_slice(&[0x82, 0xA2]); // option 1 "い"
    scene.extend_from_slice(&[0x0A, 0x00, 0x00]); // \n+i16 line marker
    scene.push(SELECT_BLOCK_CLOSE); // 0x7D '}' block close
    // Scene terminator: module_sys opcode 17 → End (argc 0).
    scene.extend_from_slice(&command_header(MODULE_TYPE_KEPAGO, MODULE_SYS, 17, 0));
    scene
}

/// Frame the synthetic decompressed bytecode into a real scene blob:
/// a `SCENE_HEADER_BYTE_LEN`-byte (0x1d0) scene header (compiler version
/// at 0x04, bytecode_offset/uncompressed/compressed sizes at 0x20/0x24/
/// 0x28) followed by the AVG32 LZSS literal-compressed bytecode. This is
/// the on-disk shape `kaifuu_reallive::SceneHeader::parse` +
/// `decompress_avg32` consume — the same framing the bundle_driven
/// patchback inverts.
fn synthetic_scene_blob() -> Vec<u8> {
    let bytecode = synthetic_scene_bytecode();
    let compressed = compress_avg32_literal(&bytecode).expect("synthetic bytecode compresses");

    let mut header = vec![0u8; SCENE_HEADER_BYTE_LEN];
    header[0..4].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
    header[4..8].copy_from_slice(&SYNTHETIC_COMPILER_VERSION.to_le_bytes());
    // bytecode_offset at 0x20 (immediately after the header).
    header[0x20..0x24].copy_from_slice(&(SCENE_HEADER_BYTE_LEN as u32).to_le_bytes());
    // bytecode_uncompressed_size at 0x24.
    header[0x24..0x28].copy_from_slice(&(bytecode.len() as u32).to_le_bytes());
    // bytecode_compressed_size at 0x28.
    header[0x28..0x2c].copy_from_slice(&(compressed.len() as u32).to_le_bytes());

    let mut blob = Vec::with_capacity(header.len() + compressed.len());
    blob.extend_from_slice(&header);
    blob.extend_from_slice(&compressed);
    blob
}

/// Build a deterministic synthetic SEEN.TXT envelope that is structurally
/// faithful to the documented RealLive directory framing.
/// Envelope: the real 10,000-slot fixed-offset directory
/// 80,000 bytes of `(u32_le offset, u32_le length)` pairs at file offset
/// 0. One scene is populated at slot 1 (`reallive:scene-0001`); its blob
///    (a real 0x1d0-byte scene header + AVG32-compressed bytecode) sits at
///    file offset `0x0001_3880` (= 80,000, immediately after the directory),
///    mirroring a real RealLive archive's first-scene layout. Slot 0 stays
///    zeroed (reserved) so the envelope parser exercises its skip path.
pub fn build_synthetic_seen_txt() -> Vec<u8> {
    let blob = synthetic_scene_blob();
    let directory_byte_len = kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize;
    let payload_offset = directory_byte_len as u32;
    let mut archive = vec![0u8; directory_byte_len + blob.len()];
    // Slot 1: (offset = 0x0001_3880, size = blob.len). Slot N lives at
    // directory byte offset N × 8; slot 0 stays zeroed (reserved).
    let slot1 = 8usize;
    archive[slot1..slot1 + 4].copy_from_slice(&payload_offset.to_le_bytes());
    archive[slot1 + 4..slot1 + 8].copy_from_slice(&(blob.len() as u32).to_le_bytes());
    archive[directory_byte_len..].copy_from_slice(&blob);
    archive
}

/// Build the synthetic translated v0.2 BridgeBundle JSON for the single
/// dialogue unit. The source side is a canonical v0.2 BridgeBundle (the
/// shape `kaifuu_core::BridgeBundleV02::validate_json` accepts) augmented
/// with a per-unit `target` object. `source_unit_key` is parameterised so
/// the failure-injection seam can point it at an unresolvable occurrence.
pub(crate) fn build_synthetic_translated_bundle_json(
    target_text: &str,
    source_unit_key: &str,
) -> Value {
    let bridge_id = "01970000-0000-7000-8000-000000000001";
    let revision_id = "01970000-0000-7000-8000-000000000002";
    let asset_id = "01970000-0000-7000-8000-000000000003";
    let bridge_unit_id = "01970000-0000-7000-8000-000000000004";
    let surface_id = "01970000-0000-7000-8000-000000000005";
    let source_profile_revision_id = "01970000-0000-7000-8000-000000000007";

    let scene_blob_hash = sha256_hash_bytes(b"synthetic-scene-1-placeholder-content");
    let source_hash = sha256_hash_bytes("Synthetic source text".as_bytes());
    let source_profile_hash = sha256_hash_bytes(SYNTHETIC_GAME_ID.as_bytes());

    // The dialogue body sits at decompressed offset 17 (after the 9-byte
    // Meta prologue + the 8-byte SetSpeaker header) and is 4 bytes wide.
    // bundle_driven only uses this range for a positive-width sanity
    // check; the authoritative key is the occurrence in `source_unit_key`.
    let start_byte = kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN + 17;
    let end_byte = start_byte + 4;

    json!({
        "schemaVersion": "0.2.0",
        "bridgeId": bridge_id,
        "sourceGame": {
            "gameId": SYNTHETIC_GAME_ID,
            "gameVersion": "1.0.0",
            "sourceProfileId": SYNTHETIC_GAME_ID,
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
                "sourceUnitKey": source_unit_key,
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
                    "sourceUnitKey": source_unit_key,
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

/// Map a [`PatchbackError`] (the canonical `bundle_driven` patchback
/// error) to a v0.2 PatchResult `failures[0]` payload. The diagnostic
/// code is the stable `kaifuu.reallive.patchback_*` code the error
/// publishes; the category is the closest v0.2 `PATCH_FAILURE_CATEGORIES_V02`
/// vocabulary slot.
pub fn map_patchback_error_to_v02_failure(error: &PatchbackError) -> Value {
    let (category, diagnostic_code) = match error {
        // A stale / invalid source-side bundle or an unresolved source
        // provenance range is a source-incompatibility, not a write fault.
        PatchbackError::BundleSchemaInvalid { .. } => {
            ("source_incompatible", PATCHBACK_BUNDLE_SCHEMA_INVALID_CODE)
        }
        PatchbackError::ProvenanceMismatch { .. } => {
            ("source_incompatible", PATCHBACK_PROVENANCE_MISMATCH_CODE)
        }
        // Everything else is a write-side fault: the archive/scene bytes
        // could not be parsed, decompressed, encoded, recompressed, or
        // packed back into the directory.
        PatchbackError::ArchiveParseFailure { .. } => {
            ("patch_write_failed", PATCHBACK_ARCHIVE_PARSE_FAILURE_CODE)
        }
        PatchbackError::SceneHeaderInvalid { .. } => {
            ("patch_write_failed", PATCHBACK_SCENE_HEADER_INVALID_CODE)
        }
        PatchbackError::DecompressFailure { .. } => {
            ("patch_write_failed", PATCHBACK_DECOMPRESS_FAILURE_CODE)
        }
        PatchbackError::CompressFailure { .. } => {
            ("patch_write_failed", PATCHBACK_COMPRESS_FAILURE_CODE)
        }
        PatchbackError::TargetEncodeFailure { .. } => {
            ("patch_write_failed", PATCHBACK_TARGET_ENCODE_FAILURE_CODE)
        }
        // A target that carried only out-of-band control markup (no
        // translatable dialogue body) is a malformed edit, not a write fault.
        PatchbackError::ControlMarkupOnlyTarget { .. } => (
            "source_incompatible",
            PATCHBACK_CONTROL_MARKUP_ONLY_TARGET_CODE,
        ),
        PatchbackError::ScenePackingOverflow { .. } => {
            ("patch_write_failed", PATCHBACK_SCENE_PACKING_OVERFLOW_CODE)
        }
        // A jump destination that falls strictly inside an edited text body
        // cannot be re-based: the specific translation edit is structurally
        // incompatible with this scene's control flow, not a write fault.
        PatchbackError::GotoTargetUnresolvable { .. } => (
            "source_incompatible",
            PATCHBACK_GOTO_TARGET_UNRESOLVABLE_CODE,
        ),
    };
    json!({
        "failureId": deterministic_failure_id_from_seed(diagnostic_code),
        "category": category,
        "diagnosticCode": diagnostic_code,
        "cause": error.to_string(),
        "assetId": ASSET_ID,
        "bridgeUnitId": BRIDGE_UNIT_ID,
        "adapterId": ADAPTER_ID,
        "command": COMMAND,
    })
}

fn deterministic_failure_id_from_seed(seed: &str) -> String {
    let mut buf = String::with_capacity(seed.len() + 24);
    buf.push_str("patchback-failure|");
    buf.push_str(seed);
    let hash = sha256_hash_bytes(buf.as_bytes());
    let hex = hash.trim_start_matches("sha256:");
    format!(
        "{}-{}-7{}-8{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..15],
        &hex[15..18],
        &hex[18..30],
    )
}

#[cfg(test)]
#[path = "support/tests.rs"]
mod tests;
