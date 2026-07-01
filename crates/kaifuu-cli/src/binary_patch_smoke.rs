//! KAIFUU-011 — Binary patcher composed smoke command.
//!
//! Composes the three patch-back slices end-to-end in one synchronous
//! flow:
//!
//! 1. KAIFUU-211 — `kaifuu_reallive::apply_translated_bundle` (the
//!    canonical `bundle_driven` patchback) consumes a translated v0.2
//!    BridgeBundle over a synthetic real-shape SEEN.TXT envelope and
//!    produces the patched byte buffer. The legacy length-preserving
//!    slot-edit surface has been deleted (no-legacy-compat); the
//!    smoke exercises the same path the alpha `patch --engine reallive`
//!    command uses.
//! 2. KAIFUU-084 — `kaifuu_core::patch_transaction::PatchTransaction`
//!    drives preflight → stage → verify → promote and emits the v0.2
//!    PatchResult shape.
//! 3. KAIFUU-010 — the emitted JSON is validated through
//!    `validate_patch_result_v02` on the Rust side; the TS-side
//!    validator (`packages/localization-bridge-schema`) consumes the
//!    same artifact.
//!
//! The composition is one synchronous function with no I/O outside the
//! caller-supplied `--output` directory.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use kaifuu_core::patch_transaction::{
    PatchTransaction, PatchTransactionConfig, PatchTransactionOutcome, TransactionState,
};
use kaifuu_core::{
    AdapterCapabilities, AdapterCapabilityMatrix, LayeredAccessCapabilityContract,
    sha256_hash_bytes, write_json,
};
use kaifuu_reallive::{
    PATCHBACK_ARCHIVE_PARSE_FAILURE_CODE, PATCHBACK_BUNDLE_SCHEMA_INVALID_CODE,
    PATCHBACK_COMPRESS_FAILURE_CODE, PATCHBACK_DECOMPRESS_FAILURE_CODE,
    PATCHBACK_PROVENANCE_MISMATCH_CODE, PATCHBACK_SCENE_HEADER_INVALID_CODE,
    PATCHBACK_SCENE_PACKING_OVERFLOW_CODE, PATCHBACK_TARGET_ENCODE_FAILURE_CODE, PatchbackError,
    PatchbackOpts, SCENE_HEADER_BYTE_LEN, TranslatedBundleV02, apply_translated_bundle,
    compress_avg32_literal, parse_archive,
};
use serde_json::{Value, json};

/// Test-seam failure injection mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InjectFailure {
    None,
    PreflightByteBudget,
    PreflightSourceHash,
    VerifyHashMismatch,
}

impl InjectFailure {
    // reason: smoke-harness parser kept live for the binary-patch smoke path; unused in some build configs.
    #[allow(dead_code)]
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "none" => Ok(Self::None),
            "preflight-byte-budget" => Ok(Self::PreflightByteBudget),
            "preflight-source-hash" => Ok(Self::PreflightSourceHash),
            "verify-hash-mismatch" => Ok(Self::VerifyHashMismatch),
            other => Err(format!(
                "unknown --inject-failure value {other:?}; expected one of \
                 none|preflight-byte-budget|preflight-source-hash|verify-hash-mismatch"
            )),
        }
    }
}

/// Configuration for the composed smoke command. The CLI dispatch arm
/// translates `--fixture`/`--output`/`--inject-failure`/`--run-id` into
/// this struct.
pub struct BinaryPatchSmokeConfig<'a> {
    /// Optional fixture directory. When supplied, the smoke reads
    /// `SEEN.TXT` from `<fixture>/SEEN.TXT` (overriding the synthetic
    /// fixture builder); otherwise the smoke constructs the deterministic
    /// real-shape SEEN.TXT envelope from [`build_synthetic_seen_txt`] (the
    /// 80,000-byte 10,000-slot directory + one real-framed scene) and
    /// applies a fixed translated v0.2 bundle to its Textout dialogue
    /// unit via the canonical `bundle_driven` patchback.
    pub fixture_dir: Option<&'a Path>,
    pub output_dir: &'a Path,
    pub inject_failure: InjectFailure,
    pub run_id: &'a str,
}

/// Exit-code categorization. `Ok(())` => exit 0; `Err(StatusFailed)` =>
/// exit 1 (v0.2 failed but smoke completed and wrote
/// `patch-result.json`); `Err(StatusAborted)` => exit 2 (smoke could
/// not reach the v0.2 contract emission).
#[derive(Debug)]
// reason: smoke outcome enum retained for the report contract; not every variant is constructed on all paths.
#[allow(dead_code)]
pub enum BinarySmokeOutcome {
    Passed,
    Failed,
    Aborted(String),
}

impl BinarySmokeOutcome {
    /// Exit code mapping: passed=0, failed=1, aborted=2. Mirrors the
    /// CLI dispatch arm's behaviour for callers that want to know the
    /// outcome without rerunning the command.
    // reason: smoke-outcome accessor for callers that inspect status without rerunning the command.
    #[allow(dead_code)]
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Passed => 0,
            Self::Failed => 1,
            Self::Aborted(_) => 2,
        }
    }
}

/// Compiler version stamped in the synthetic scene header. This fixture's
/// bytecode is PLAINTEXT, so it deliberately uses a NON-`xor_2` version:
/// `compiler_version_uses_xor2` triggers on `110002`/`1110002`, and stamping
/// one of those would (correctly) make the patchback try to recover an
/// `xor_2` key from unencrypted bytes and abort. This smoke fixture exercises
/// the patch-pipeline mechanics on a plaintext game; the real `xor_2`
/// encrypt/decrypt round-trip is covered by the real Sweetie HD (110002)
/// `patch_real_sweetie_hd` test. A synthetic *encrypted* fixture is future
/// work under `publishable-synthetic-corpora-differential-validated`.
const SYNTHETIC_COMPILER_VERSION: u32 = 110_001;

/// Canonical v0.2 sourceUnitKey for the synthetic dialogue unit
/// (`reallive:scene-NNNN#OOOO`). Scene 1, occurrence 0 — the first (and
/// only) translatable Textout in the synthetic scene.
const SYNTHETIC_DIALOGUE_SOURCE_UNIT_KEY: &str = "reallive:scene-0001#0000";

/// Shift-JIS sentinel the synthetic bundle translates the dialogue unit
/// to. `"うえ"` (`0x82 0xA4 0x82 0xA6`) encodes to the same 4-byte budget
/// as the `"あい"` source body, so the bundle_driven re-emission keeps the
/// scene's decompressed length — and (because the AVG32 literal encoder's
/// output size depends only on its input size) the recompressed blob and
/// the whole archive stay byte-length-identical. That length-stability is
/// what lets the composed KAIFUU-084 `PatchTransaction` identity
/// relocation invariant (`expected_payload_len == source length`) hold.
/// The leading `0x82` is a Shift-JIS lead byte, so the patched bytes still
/// re-parse as a Textout run.
const SYNTHETIC_TARGET_TEXT: &str = "うえ";

/// Build the synthetic scene's **decompressed** bytecode: the real
/// post-KAIFUU-191 opener-byte shape decoded by
/// `kaifuu_reallive::parse_scene`, exercising every alpha string role
/// through real 8-byte `CommandElement` headers (plus, for the Choice
/// role, the `module_sel` `SelectElement` `{ … }` block framing):
/// - Meta prologue (MetaLine / MetaEntrypoint / MetaKidoku).
/// - `SetSpeaker`   — module_msg (id 3) opcode 3 → `CharacterTextDisplay`.
/// - `Textout`      — inline Shift-JIS run `"あい"` (the editable Dialogue
///   unit at occurrence 0).
/// - `TextDisplay`  — module_msg (id 3) opcode 10 → `TextDisplay`.
/// - `Choice`       — module_sel (module_type 0, id 2) opcode 0 (`select_w`),
///   decoded by `decode_select` as a `{ "あ" \n "い" \n }` select-block (NOT a
///   flat `(...)` arg list): the `{`/`}` braces frame two Shift-JIS option
///   runs, each closed by a `\n`+i16 line marker.
/// - scene terminator — module_sys (id 4) opcode 17 → `End`.
///
/// The whole body decodes with **0 unknown opcodes**; no retail bytecode
/// or text is copied — every byte is authored from the documented shape.
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
    // TextDisplay: module_msg opcode 10 (in 1..=200, != 3) (argc 0).
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
/// faithful to real RealLive bytes (KAIFUU FIX-1 + KAIFUU-211 framing).
///
/// Envelope: the real 10,000-slot fixed-offset directory (KAIFUU-188) —
/// 80,000 bytes of `(u32_le offset, u32_le length)` pairs at file offset
/// 0. One scene is populated at slot 1 (`reallive:scene-0001`); its blob
/// (a real 0x1d0-byte scene header + AVG32-compressed bytecode) sits at
/// file offset `0x0001_3880` (= 80,000, immediately after the directory),
/// mirroring Sweetie HD's first-scene layout. Slot 0 stays zeroed
/// (reserved) so the envelope parser exercises its skip path.
pub fn build_synthetic_seen_txt() -> Vec<u8> {
    let blob = synthetic_scene_blob();
    let directory_byte_len = kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize;
    let payload_offset = directory_byte_len as u32;
    let mut archive = vec![0u8; directory_byte_len + blob.len()];
    // Slot 1: (offset = 0x0001_3880, size = blob.len()). Slot N lives at
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
fn build_synthetic_translated_bundle_json(target_text: &str, source_unit_key: &str) -> Value {
    let bridge_id = "01970000-0000-7000-8000-000000000001";
    let revision_id = "01970000-0000-7000-8000-000000000002";
    let asset_id = "01970000-0000-7000-8000-000000000003";
    let bridge_unit_id = "01970000-0000-7000-8000-000000000004";
    let surface_id = "01970000-0000-7000-8000-000000000005";
    let source_profile_revision_id = "01970000-0000-7000-8000-000000000007";

    let scene_blob_hash = sha256_hash_bytes(b"synthetic-scene-1-placeholder-content");
    let source_hash = sha256_hash_bytes("Synthetic source text".as_bytes());
    let source_profile_hash = sha256_hash_bytes(b"kaifuu-reallive-sweetie-hd");

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
        PatchbackError::ScenePackingOverflow { .. } => {
            ("patch_write_failed", PATCHBACK_SCENE_PACKING_OVERFLOW_CODE)
        }
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
    buf.push_str("kaifuu-011|");
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

const ADAPTER_ID: &str = "kaifuu-reallive";
const PATCH_EXPORT_ID: &str = "019ed011-0000-7000-8000-000000000001";
const BRIDGE_UNIT_ID: &str = "019ed011-0000-7000-8000-000000000020";
const ASSET_ID: &str = "019ed011-0000-7000-8000-000000000010";
const COMMAND: &str = "patch.write_string_slot";
const REQUIRED_TRANSFORMS: &[&str] = &["identity"];

/// Reallive-flavoured capabilities. Uses the
/// `LayeredAccessCapabilityContract::plaintext_identity()` factory
/// because the smoke fixture is a plaintext archive; the patch
/// transform is identity (length-preserving). Engine ports adopting
/// the harness later will supply their own capability matrix; this
/// fixture is the structural defense for the smoke.
fn reallive_capabilities() -> AdapterCapabilities {
    // KAIFUU-053: the binary-patch smoke is a plaintext-identity fixture;
    // it carries no per-Capability reports, so the explicitly-derived
    // matrix declares every rung Unsupported. The registry-side gate
    // must never bubble this smoke up to Identify/Extract/Patch.
    let matrix = AdapterCapabilityMatrix::derive_from_reports(ADAPTER_ID, &[]);
    AdapterCapabilities::new(ADAPTER_ID, vec![], matrix)
        .with_access_contract(LayeredAccessCapabilityContract::plaintext_identity())
}

/// Run the composed smoke. Top-level entry point; the CLI dispatch arm
/// in `main.rs` calls this with parsed config.
pub fn run_binary_patch_smoke(config: BinaryPatchSmokeConfig<'_>) -> BinarySmokeOutcome {
    // ---------------------------------------------------------------
    // Step 0: prepare the output directory.
    // ---------------------------------------------------------------
    if let Err(error) = fs::create_dir_all(config.output_dir) {
        return BinarySmokeOutcome::Aborted(format!("failed to create output directory: {error}"));
    }
    let output_seen_path = config.output_dir.join("SEEN.TXT");
    let patch_result_path = config.output_dir.join("patch-result.json");

    // ---------------------------------------------------------------
    // Step 1: read or synthesize SEEN.TXT.
    // ---------------------------------------------------------------
    let archive_bytes = match config.fixture_dir {
        // A caller that supplied `--fixture` asked to exercise REAL bytes.
        // If the fixture cannot be read, propagate the error as Aborted —
        // silently substituting the synthetic envelope would report a
        // PASS against synthetic bytes while the user believes the real
        // fixture ran, masking a real-byte regression. Only the unset
        // (`None`) case may synthesize.
        Some(dir) => {
            let seen_path = dir.join("SEEN.TXT");
            match fs::read(&seen_path) {
                Ok(bytes) => bytes,
                Err(error) => {
                    return BinarySmokeOutcome::Aborted(format!(
                        "failed to read supplied fixture {}: {error}",
                        seen_path.display()
                    ));
                }
            }
        }
        None => build_synthetic_seen_txt(),
    };

    // ---------------------------------------------------------------
    // Step 2: parse the archive and run the canonical bundle_driven
    // patchback (`apply_translated_bundle`).
    // ---------------------------------------------------------------
    if let Err(diag) = parse_archive(&archive_bytes) {
        return BinarySmokeOutcome::Aborted(format!("synthetic archive failed to parse: {diag:?}"));
    }

    // The PreflightSourceHash injection points the unit's source
    // provenance at an occurrence the scene bytecode cannot resolve,
    // forcing a typed `ProvenanceMismatch` (source-incompatible) out of
    // the bundle_driven driver — the bundle_driven analogue of the old
    // stale-source-hash refusal.
    let source_unit_key = match config.inject_failure {
        InjectFailure::PreflightSourceHash => "reallive:scene-0001#9999",
        _ => SYNTHETIC_DIALOGUE_SOURCE_UNIT_KEY,
    };
    let bundle_value =
        build_synthetic_translated_bundle_json(SYNTHETIC_TARGET_TEXT, source_unit_key);
    let translated = match TranslatedBundleV02::from_json(&bundle_value) {
        Ok(bundle) => bundle,
        Err(error) => {
            return emit_direct_failure(
                &output_seen_path,
                &patch_result_path,
                config.run_id,
                &archive_bytes,
                &error,
            );
        }
    };

    let patched_bytes =
        match apply_translated_bundle(&archive_bytes, &translated, &PatchbackOpts::shift_jis()) {
            Ok(bytes) => bytes,
            Err(error) => {
                // The smoke never reached the transaction harness; emit a
                // v0.2 Failed JSON directly from the mapping table.
                return emit_direct_failure(
                    &output_seen_path,
                    &patch_result_path,
                    config.run_id,
                    &archive_bytes,
                    &error,
                );
            }
        };

    // Stash the source bytes at the output path so the transaction
    // harness reads them back during preflight.
    if let Err(err) = fs::write(&output_seen_path, &archive_bytes) {
        return BinarySmokeOutcome::Aborted(format!(
            "failed to seed output_path with source bytes: {err}"
        ));
    }

    // ---------------------------------------------------------------
    // Step 3: apply --inject-failure that does NOT change the patchback
    // input shape.
    // ---------------------------------------------------------------
    let payload_to_stage = match config.inject_failure {
        InjectFailure::VerifyHashMismatch => {
            // Flip the last byte so verify mismatches.
            let mut mutated = patched_bytes.clone();
            if let Some(last) = mutated.last_mut() {
                *last = last.wrapping_add(1);
            }
            mutated
        }
        _ => patched_bytes.clone(),
    };

    let byte_budget = match config.inject_failure {
        InjectFailure::PreflightByteBudget => 1, // force preflight rejection
        _ => patched_bytes.len() as u64,
    };

    let expected_source_hash = sha256_hash_bytes(&archive_bytes);
    let expected_output_hash = sha256_hash_bytes(&patched_bytes);
    let expected_payload_len = patched_bytes.len() as u64;
    let capabilities = reallive_capabilities();

    // ---------------------------------------------------------------
    // Step 4: drive the PatchTransaction state machine.
    // ---------------------------------------------------------------
    let txn_config = PatchTransactionConfig {
        adapter_id: ADAPTER_ID,
        patch_export_id: PATCH_EXPORT_ID,
        bridge_unit_id: BRIDGE_UNIT_ID,
        asset_id: ASSET_ID,
        output_path: &output_seen_path,
        expected_source_hash: &expected_source_hash,
        expected_output_hash: &expected_output_hash,
        expected_payload_len,
        byte_budget,
        required_transforms: REQUIRED_TRANSFORMS,
        adapter_capabilities: &capabilities,
        command: COMMAND,
        run_id: config.run_id,
    };
    let mut transaction = PatchTransaction::new(txn_config);

    let _ = transaction.run_preflight();
    if !is_terminal(&transaction.state()) {
        let _ = transaction.stage(&payload_to_stage);
        if !is_terminal(&transaction.state()) {
            let _ = transaction.verify();
            if !is_terminal(&transaction.state()) {
                let _ = transaction.promote();
            }
        }
    }
    let final_state = transaction.state();
    let outcome: PatchTransactionOutcome = transaction.into_outcome();

    // ---------------------------------------------------------------
    // Step 5: emit PatchResult v0.2.
    // ---------------------------------------------------------------
    let result_value = outcome.patch_result_v02.clone();
    if let Err(err) = write_json(&patch_result_path, &result_value) {
        return BinarySmokeOutcome::Aborted(format!("failed to write patch-result.json: {err}"));
    }

    // Defense in depth: re-run the Rust validator on the emitted
    // contract. A drift in `build_patch_result_v02` would surface here
    // even when debug_assertions are off.
    if let Err(err) = kaifuu_core::contracts::validate_patch_result_v02(&result_value) {
        return BinarySmokeOutcome::Aborted(format!(
            "patch-result.json failed v0.2 validation: {err:?}"
        ));
    }

    match final_state {
        TransactionState::Promoted => BinarySmokeOutcome::Passed,
        _ => BinarySmokeOutcome::Failed,
    }
}

/// Emit a v0.2 Failed PatchResult directly from a patchback error (used
/// when the bundle_driven driver refuses before the transaction harness
/// runs), preserve the source bytes at the output path, and return
/// `Failed`. Returns `Aborted` only if the JSON / byte writes themselves
/// fail.
fn emit_direct_failure(
    output_seen_path: &Path,
    patch_result_path: &Path,
    run_id: &str,
    archive_bytes: &[u8],
    error: &PatchbackError,
) -> BinarySmokeOutcome {
    let failure = map_patchback_error_to_v02_failure(error);
    let result_value = build_patchback_failure_v02(&failure, run_id);
    if let Err(err) = write_json(patch_result_path, &result_value) {
        return BinarySmokeOutcome::Aborted(format!("failed to write patch-result.json: {err}"));
    }
    // Preserve the source bytes (no promotion happened).
    if let Err(err) = fs::write(output_seen_path, archive_bytes) {
        return BinarySmokeOutcome::Aborted(format!(
            "failed to write source bytes to output: {err}"
        ));
    }
    BinarySmokeOutcome::Failed
}

fn is_terminal(state: &TransactionState) -> bool {
    matches!(
        state,
        TransactionState::Promoted
            | TransactionState::PreflightFailed
            | TransactionState::VerifyFailed
            | TransactionState::PromoteFailed
            | TransactionState::Cancelled
    )
}

/// Build a v0.2 Failed PatchResult JSON directly from a patchback
/// error mapping. Used when the smoke aborts before driving the
/// transaction state machine (e.g. apply_translated_bundle itself failed).
fn build_patchback_failure_v02(failure: &Value, run_id: &str) -> Value {
    json!({
        "schemaVersion": "0.2.0",
        "patchResultId": deterministic_failure_id(run_id, ASSET_ID),
        "patchExportId": PATCH_EXPORT_ID,
        "adapterId": ADAPTER_ID,
        "status": "failed",
        "failures": [failure],
        "failureCategories": [
            failure
                .get("category")
                .and_then(Value::as_str)
                .unwrap_or("patch_write_failed")
        ],
        "partialWrite": {
            "disposition": "rolled_back",
            "writtenAssetIds": [],
            "attemptedAssetIds": [ASSET_ID],
            "skippedAssetIds": [ASSET_ID],
            "rollbackDiagnosticCode": "kaifuu.reallive.patchback_rolled_back",
        },
    })
}

fn deterministic_failure_id(run_id: &str, asset_id: &str) -> String {
    // Stable, deterministic UUID7 derived from (asset_id, run_id,
    // "failed"). UUID7 layout: `xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx`
    // where the third group starts with `7` (version) and the fourth
    // group's first nibble is `8`, `9`, `a`, or `b` (variant). We
    // splice deterministic hex into those fixed positions.
    let mut buf = String::with_capacity(asset_id.len() + run_id.len() + 16);
    buf.push_str(asset_id);
    buf.push('|');
    buf.push_str(run_id);
    buf.push('|');
    buf.push_str("failed");
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

/// Convenience for the CLI dispatch arm: format the smoke outcome's
/// final status into a stdout summary line, ensuring callers see a
/// machine-readable cue even when patch-result.json was written.
// reason: smoke summary writer retained for the stdout-summary contract; unused in some configs.
#[allow(dead_code)]
pub fn write_smoke_summary(writer: &mut impl Write, outcome: &BinarySmokeOutcome) {
    let (label, exit) = match outcome {
        BinarySmokeOutcome::Passed => ("passed", 0),
        BinarySmokeOutcome::Failed => ("failed", 1),
        BinarySmokeOutcome::Aborted(reason) => {
            let _ = writeln!(writer, "binary-patch-smoke aborted: {reason}");
            return;
        }
    };
    let _ = writeln!(writer, "binary-patch-smoke status={label} exit={exit}");
}

// Allow ResultExt usage from main.rs without re-exporting the trait.
// reason: smoke filename accessor used from main.rs without re-exporting the trait.
#[allow(dead_code)]
pub fn patch_result_filename() -> &'static str {
    "patch-result.json"
}

// reason: smoke filename accessor used from main.rs without re-exporting the trait.
#[allow(dead_code)]
pub fn output_seen_filename() -> &'static str {
    "SEEN.TXT"
}

// reason: smoke fixture-path helper used across the smoke module; unused in some configs.
#[allow(dead_code)]
pub fn fixture_path_for(base: &Path, name: &str) -> PathBuf {
    base.join(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_patchback_error_to_v02_failure_is_exhaustive_over_every_variant() {
        // Exact (variant -> category, diagnosticCode) pairs. Pinning the
        // precise mapping per variant — rather than mere set-membership —
        // means a wrong mapping fails the test. Source-side faults
        // (BundleSchemaInvalid, ProvenanceMismatch) map to
        // `source_incompatible`; every other (write-side) variant maps to
        // `patch_write_failed`.
        let table: Vec<(PatchbackError, &str, &str)> = vec![
            (
                PatchbackError::BundleSchemaInvalid {
                    message: "synthetic".into(),
                },
                "source_incompatible",
                PATCHBACK_BUNDLE_SCHEMA_INVALID_CODE,
            ),
            (
                PatchbackError::ArchiveParseFailure {
                    message: "synthetic".into(),
                },
                "patch_write_failed",
                PATCHBACK_ARCHIVE_PARSE_FAILURE_CODE,
            ),
            (
                PatchbackError::ProvenanceMismatch {
                    bridge_unit_id: "u".into(),
                    start_byte: 0,
                    end_byte: 1,
                    reason: "synthetic".into(),
                },
                "source_incompatible",
                PATCHBACK_PROVENANCE_MISMATCH_CODE,
            ),
            (
                PatchbackError::SceneHeaderInvalid {
                    scene_id: 1,
                    message: "synthetic".into(),
                },
                "patch_write_failed",
                PATCHBACK_SCENE_HEADER_INVALID_CODE,
            ),
            (
                PatchbackError::DecompressFailure {
                    scene_id: 1,
                    message: "synthetic".into(),
                },
                "patch_write_failed",
                PATCHBACK_DECOMPRESS_FAILURE_CODE,
            ),
            (
                PatchbackError::CompressFailure {
                    scene_id: 1,
                    message: "synthetic".into(),
                },
                "patch_write_failed",
                PATCHBACK_COMPRESS_FAILURE_CODE,
            ),
            (
                PatchbackError::TargetEncodeFailure {
                    bridge_unit_id: "u".into(),
                    message: "synthetic".into(),
                },
                "patch_write_failed",
                PATCHBACK_TARGET_ENCODE_FAILURE_CODE,
            ),
            (
                PatchbackError::ScenePackingOverflow {
                    observed_size: 0,
                    reason: "synthetic".into(),
                },
                "patch_write_failed",
                PATCHBACK_SCENE_PACKING_OVERFLOW_CODE,
            ),
        ];

        // Guards exhaustiveness: if a PatchbackError variant is added, this
        // count must be updated alongside a new table row. (Mirrors the
        // 8-variant bundle_driven `PatchbackError` enum.)
        assert_eq!(table.len(), 8, "every PatchbackError variant is pinned");

        for (error, expected_category, expected_diagnostic) in &table {
            let value = map_patchback_error_to_v02_failure(error);
            let category = value
                .get("category")
                .and_then(Value::as_str)
                .expect("category present");
            assert_eq!(
                category, *expected_category,
                "category mismatch for {error:?}"
            );
            let diagnostic_code = value
                .get("diagnosticCode")
                .and_then(Value::as_str)
                .expect("diagnosticCode present");
            assert_eq!(
                diagnostic_code, *expected_diagnostic,
                "diagnosticCode mismatch for {error:?}"
            );
        }
    }

    #[test]
    fn build_synthetic_seen_txt_parses_with_one_scene() {
        let archive = build_synthetic_seen_txt();
        let index = parse_archive(&archive).expect("synthetic archive parses");
        assert_eq!(index.entries.len(), 1);
    }

    /// FIX-1 acceptance: the synthetic scene's decompressed bytecode parses
    /// through the CURRENT (post-KAIFUU-191) parser with **0 unknown
    /// opcodes** and exercises the four target roles — Textout, TextDisplay,
    /// SetSpeaker (`CharacterTextDisplay`), and Choice. This is the
    /// non-tautological guard: it asserts real parser-shape facts, not just
    /// "the builder returns bytes".
    #[test]
    fn synthetic_scene_decodes_four_roles_with_zero_unknown_opcodes() {
        use kaifuu_reallive::{RealLiveOpcode, parse_scene};

        let bytecode = synthetic_scene_bytecode();

        // (1) Decode the real bytecode: ZERO unknown opcodes.
        let opcodes = parse_scene(&bytecode).expect("scene bytecode decodes");
        let unknown: Vec<&RealLiveOpcode> = opcodes.iter().filter(|o| !o.is_recognized()).collect();
        assert!(
            unknown.is_empty(),
            "synthetic scene must decode with 0 unknown opcodes; found {unknown:?}"
        );

        // (2) All four target opcode variants are present.
        assert!(
            opcodes
                .iter()
                .any(|o| matches!(o, RealLiveOpcode::Textout { .. })),
            "Textout role present"
        );
        assert!(
            opcodes
                .iter()
                .any(|o| matches!(o, RealLiveOpcode::TextDisplay { .. })),
            "TextDisplay role present"
        );
        assert!(
            opcodes
                .iter()
                .any(|o| matches!(o, RealLiveOpcode::CharacterTextDisplay)),
            "SetSpeaker (CharacterTextDisplay) role present"
        );
        assert!(
            opcodes
                .iter()
                .any(|o| matches!(o, RealLiveOpcode::Choice { .. })),
            "Choice role present"
        );
    }

    /// FIX-1 structural faithfulness: the synthetic scene blob is a real
    /// scene-header + AVG32 LZSS + XOR compressed frame whose payload
    /// round-trips byte-identically back to the authored decompressed
    /// bytecode (the same framing a real Seen.txt scene carries, and the
    /// shape the bundle_driven patchback decompresses / recompresses).
    #[test]
    fn synthetic_scene_blob_round_trips_through_avg32_compression_framing() {
        use kaifuu_reallive::{SceneHeader, decompress_avg32, parse_scene};

        let archive = build_synthetic_seen_txt();
        let index = parse_archive(&archive).expect("envelope parses");
        let entry = &index.entries[0];
        let blob = &archive
            [entry.byte_offset as usize..(entry.byte_offset + u64::from(entry.byte_len)) as usize];

        let header = SceneHeader::parse(blob).expect("synthetic scene header parses");
        let compressed = &blob[header.bytecode_offset as usize
            ..(header.bytecode_offset + header.bytecode_compressed_size) as usize];
        let decompressed = decompress_avg32(compressed, header.bytecode_uncompressed_size as usize)
            .expect("AVG32 decompresses");
        assert_eq!(
            decompressed,
            synthetic_scene_bytecode(),
            "AVG32 LZSS + XOR round-trips byte-identically to the authored bytecode"
        );
        assert!(
            !parse_scene(&decompressed)
                .expect("decompressed decodes")
                .is_empty(),
            "decompressed bytecode decodes to a non-empty opcode stream"
        );
    }
}
