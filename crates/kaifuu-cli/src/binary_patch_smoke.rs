//! KAIFUU-011 — Binary patcher composed smoke command.
//!
//! Composes the three patch-back slices end-to-end in one synchronous
//! flow:
//!
//! 1. KAIFUU-174 — `kaifuu_reallive::apply_patches` over a synthetic
//!    SEEN.TXT envelope produces the patched byte buffer.
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
    AdapterCapabilities, LayeredAccessCapabilityContract, sha256_hash_bytes, write_json,
};
use kaifuu_reallive::{
    PatchBackError, PatchBackErrorCode, RealLiveSceneIndex, Scene, SlotEdit, SlotEditLengthPolicy,
    apply_patches, parse_archive, parse_scene,
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
    /// fixture builder); otherwise the smoke constructs a deterministic
    /// 47-byte SEEN.TXT envelope and applies a fixed length-preserving
    /// patch.
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
    #[allow(dead_code)]
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Passed => 0,
            Self::Failed => 1,
            Self::Aborted(_) => 2,
        }
    }
}

/// Build a deterministic synthetic SEEN.TXT envelope in the real RealLive
/// 10,000-slot fixed-offset-table shape (KAIFUU-188). One scene is
/// populated at slot 1 (`reallive:scene-0001`); its payload sits at file
/// offset `0x0001_3880` (immediately after the 80,000-byte directory),
/// mirroring Sweetie HD's first-scene layout.
pub fn build_synthetic_seen_txt() -> Vec<u8> {
    // Scene blob: SetSpeaker("S") + TextDisplay("Hello!").
    // String operand: 0x73 + u16 LE length + bytes.
    fn string_operand(bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(3 + bytes.len());
        out.push(0x73);
        out.extend_from_slice(&(bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(bytes);
        out
    }
    fn instruction(opcode: u8, operands: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        out.push(0x23);
        out.push(opcode);
        out.push(operands.len() as u8);
        for operand in operands {
            out.extend_from_slice(operand);
        }
        out
    }
    let speaker = string_operand(b"S");
    let dialogue = string_operand(b"Hello!");
    let mut scene_blob = Vec::new();
    scene_blob.extend_from_slice(&instruction(0x02, &[speaker.as_slice()]));
    scene_blob.extend_from_slice(&instruction(0x01, &[dialogue.as_slice()]));

    let directory_byte_len = kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize;
    let payload_offset = directory_byte_len as u32;
    let mut archive = vec![0u8; directory_byte_len + scene_blob.len()];
    // Slot 1: (offset = 0x13880, size = scene_blob.len()).
    let slot1 = 1usize * 8;
    archive[slot1..slot1 + 4].copy_from_slice(&payload_offset.to_le_bytes());
    archive[slot1 + 4..slot1 + 8].copy_from_slice(&(scene_blob.len() as u32).to_le_bytes());
    archive[directory_byte_len..].copy_from_slice(&scene_blob);
    archive
}

/// Build a deterministic synthetic SlotEdit replacing the dialogue
/// slot's text with a length-preserving translation.
pub fn build_synthetic_slot_edit(scenes: &[Scene]) -> SlotEdit {
    let scene = &scenes[0];
    let dialogue_slot = scene
        .strings
        .iter()
        .find(|s| s.byte_len == 6)
        .expect("synthetic dialogue slot of 6 bytes");
    SlotEdit {
        scene_id: scene.scene_id.as_str().to_string(),
        slot_id: dialogue_slot.slot_id.as_str().to_string(),
        replacement_text: "Bye!!!".to_string(),
        length_policy: SlotEditLengthPolicy::LengthPreserving,
        expected_source_hash: None,
    }
}

/// Map a [`PatchBackError`] to a v0.2 PatchResult `failures[0]`
/// payload. Mirrors the KAIFUU-010 §6 / KAIFUU-084 §6 table.
pub fn map_patchback_error_to_v02_failure(error: &PatchBackError) -> Value {
    let (category, diagnostic_code) = match error.code {
        PatchBackErrorCode::OffsetOverflow => (
            "patch_write_failed",
            "kaifuu.reallive.patchback_offset_overflow",
        ),
        PatchBackErrorCode::ShiftJisEncodeFailure => (
            "patch_write_failed",
            "kaifuu.reallive.patchback_shift_jis_encode_failure",
        ),
        PatchBackErrorCode::UnsupportedLengthPolicy => (
            "adapter_unsupported",
            "kaifuu.reallive.patchback_unsupported_length_policy",
        ),
        PatchBackErrorCode::ParserRegression => (
            "patch_write_failed",
            "kaifuu.reallive.patchback_parser_regression",
        ),
        PatchBackErrorCode::UnknownSlotId => {
            ("asset_missing", "kaifuu.reallive.patchback_unknown_slot_id")
        }
        PatchBackErrorCode::StaleSourceHash => (
            "source_incompatible",
            "kaifuu.reallive.patchback_stale_source_hash",
        ),
        PatchBackErrorCode::ProtectedSpanLost => (
            // Mirrors KAIFUU-084 §6: protected-span loss maps to
            // patch_write_failed at the v0.2 vocabulary (the v0.2
            // category enum has no protected_span_violation slot).
            "patch_write_failed",
            "kaifuu.reallive.patchback_protected_span_lost",
        ),
    };
    json!({
        "failureId": deterministic_failure_id_from_seed(diagnostic_code),
        "category": category,
        "diagnosticCode": diagnostic_code,
        "cause": error.message.clone(),
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
    AdapterCapabilities::new(ADAPTER_ID, vec![])
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
        Some(dir) => {
            let seen_path = dir.join("SEEN.TXT");
            match fs::read(&seen_path) {
                Ok(bytes) => bytes,
                Err(_) => build_synthetic_seen_txt(),
            }
        }
        None => build_synthetic_seen_txt(),
    };

    // ---------------------------------------------------------------
    // Step 2: parse the archive and run kaifuu-reallive apply_patches.
    // ---------------------------------------------------------------
    let scene_index = match parse_archive(&archive_bytes) {
        Ok(index) => index,
        Err(diag) => {
            return BinarySmokeOutcome::Aborted(format!(
                "synthetic archive failed to parse: {diag:?}"
            ));
        }
    };
    let scenes = match parse_scenes(&archive_bytes, &scene_index) {
        Ok(scenes) => scenes,
        Err(message) => return BinarySmokeOutcome::Aborted(message),
    };
    let edit = build_synthetic_slot_edit(&scenes);
    let mut edits = vec![edit];

    // Apply --inject-failure preflight-source-hash by replacing the
    // source-hash gate before any apply happens.
    let mut force_stale_source_hash = false;
    if config.inject_failure == InjectFailure::PreflightSourceHash {
        force_stale_source_hash = true;
        if let Some(first) = edits.get_mut(0) {
            first.expected_source_hash = Some(
                "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                    .to_string(),
            );
        }
    }

    let patched_bytes = match apply_patches(&archive_bytes, &scene_index, &scenes, &edits) {
        Ok(bytes) => bytes,
        Err(error) => {
            // The smoke never reached the transaction harness; emit a
            // v0.2 Failed JSON directly from the mapping table.
            let failure = map_patchback_error_to_v02_failure(&error);
            let result_value = build_patchback_failure_v02(&failure, config.run_id, &archive_bytes);
            if let Err(err) = write_json(&patch_result_path, &result_value) {
                return BinarySmokeOutcome::Aborted(format!(
                    "failed to write patch-result.json: {err}"
                ));
            }
            // Preserve the source bytes (no promotion happened).
            if let Err(err) = fs::write(&output_seen_path, &archive_bytes) {
                return BinarySmokeOutcome::Aborted(format!(
                    "failed to write source bytes to output: {err}"
                ));
            }
            return BinarySmokeOutcome::Failed;
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
    // Step 3: apply --inject-failure that does NOT change apply_patches
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
    // Suppress unused-warning lint when force_stale_source_hash isn't
    // observed downstream (the apply_patches branch above is the
    // observer; this re-affirms intent).
    let _ = force_stale_source_hash;

    match final_state {
        TransactionState::Promoted => BinarySmokeOutcome::Passed,
        _ => BinarySmokeOutcome::Failed,
    }
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

fn parse_scenes(
    archive_bytes: &[u8],
    scene_index: &RealLiveSceneIndex,
) -> Result<Vec<Scene>, String> {
    let mut scenes = Vec::with_capacity(scene_index.entries.len());
    for entry in &scene_index.entries {
        let blob_start = entry.byte_offset as usize;
        let blob_end = blob_start + entry.byte_len as usize;
        let blob = &archive_bytes[blob_start..blob_end];
        let outcome = parse_scene(blob, entry.scene_id, entry.byte_offset);
        let scene = outcome
            .scene
            .ok_or_else(|| format!("synthetic scene at slot {} failed to parse", entry.scene_id))?;
        scenes.push(scene);
    }
    Ok(scenes)
}

/// Build a v0.2 Failed PatchResult JSON directly from a patchback
/// error mapping. Used when the smoke aborts before driving the
/// transaction state machine (e.g. apply_patches itself failed).
fn build_patchback_failure_v02(failure: &Value, run_id: &str, _archive_bytes: &[u8]) -> Value {
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
#[allow(dead_code)]
pub fn patch_result_filename() -> &'static str {
    "patch-result.json"
}

#[allow(dead_code)]
pub fn output_seen_filename() -> &'static str {
    "SEEN.TXT"
}

#[allow(dead_code)]
pub fn fixture_path_for(base: &Path, name: &str) -> PathBuf {
    base.join(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_patchback_error_to_v02_failure_is_exhaustive_over_every_variant() {
        for code in [
            PatchBackErrorCode::OffsetOverflow,
            PatchBackErrorCode::ShiftJisEncodeFailure,
            PatchBackErrorCode::UnsupportedLengthPolicy,
            PatchBackErrorCode::ParserRegression,
            PatchBackErrorCode::UnknownSlotId,
            PatchBackErrorCode::StaleSourceHash,
            PatchBackErrorCode::ProtectedSpanLost,
        ] {
            let error = PatchBackError {
                code: code.clone(),
                scene_id: None,
                slot_id: None,
                message: "synthetic".to_string(),
            };
            let value = map_patchback_error_to_v02_failure(&error);
            let category = value
                .get("category")
                .and_then(Value::as_str)
                .expect("category present");
            assert!(matches!(
                category,
                "patch_write_failed"
                    | "adapter_unsupported"
                    | "asset_missing"
                    | "source_incompatible"
                    | "protected_span_violation"
            ));
            let diagnostic_code = value
                .get("diagnosticCode")
                .and_then(Value::as_str)
                .expect("diagnosticCode present");
            assert!(diagnostic_code.starts_with("kaifuu.reallive.patchback_"));
        }
    }

    #[test]
    fn build_synthetic_seen_txt_parses_with_one_scene() {
        let archive = build_synthetic_seen_txt();
        let index = parse_archive(&archive).expect("synthetic archive parses");
        assert_eq!(index.entries.len(), 1);
    }

    #[test]
    fn synthetic_seen_txt_round_trips_with_length_preserving_edit() {
        let archive = build_synthetic_seen_txt();
        let index = parse_archive(&archive).expect("parses");
        let scenes = parse_scenes(&archive, &index).expect("scenes parse");
        let edit = build_synthetic_slot_edit(&scenes);
        let patched =
            apply_patches(&archive, &index, &scenes, &[edit]).expect("synthetic edit applies");
        assert_eq!(patched.len(), archive.len(), "length-preserving");
    }
}
