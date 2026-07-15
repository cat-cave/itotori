//! Binary patcher composed smoke command.
//! Composes the three patch-back slices end-to-end in one synchronous
//! flow:
//! 1. — `kaifuu_reallive::apply_translated_bundle` (the
//!    canonical `bundle_driven` patchback) consumes a translated v0.2
//!    BridgeBundle over a synthetic real-shape SEEN.TXT envelope and
//!    produces the patched byte buffer. The legacy length-preserving
//!    slot-edit surface has been deleted (no-legacy-compat); the
//!    smoke exercises the same path the alpha `patch --engine reallive`
//!    command uses.
//! 2. — `kaifuu_core::patch_transaction::PatchTransaction`
//!    drives preflight → stage → verify → promote and emits the v0.2
//!    PatchResult shape.
//! 3. — the emitted JSON is validated through
//!    `validate_patch_result_v02` on the Rust side; the TS-side
//!    validator (`packages/localization-bridge-schema`) consumes the
//!    same artifact.
//!    The composition is one synchronous function with no I/O outside the
//!    caller-supplied `--output` directory.

use std::fs;
use std::io::Write;
use std::path::Path;

use kaifuu_core::patch_transaction::{
    PatchTransaction, PatchTransactionConfig, PatchTransactionOutcome, TransactionState,
};
use kaifuu_core::{
    AdapterCapabilities, AdapterCapabilityMatrix, LayeredAccessCapabilityContract,
    sha256_hash_bytes, write_json,
};
use kaifuu_reallive::{
    PatchbackError, PatchbackOpts, TranslatedBundleV02, apply_translated_bundle, parse_archive,
};
use serde_json::{Value, json};

#[path = "binary_patch_smoke/support.rs"]
mod support;

pub(crate) use support::build_synthetic_translated_bundle_json;
use support::{SYNTHETIC_DIALOGUE_SOURCE_UNIT_KEY, SYNTHETIC_TARGET_TEXT};
pub use support::{build_synthetic_seen_txt, map_patchback_error_to_v02_failure};

/// Test-seam failure injection mode.
/// This is a TEST/DEBUG affordance: it lets a caller inject
/// artificial preflight/verify failures to exercise the rollback paths. It
/// MUST NOT be reachable from a shipped release binary, so the whole seam is
/// gated behind `cfg(any(debug_assertions, feature = "failure-injection"))`.
/// A release `--no-default-features` build compiles this out entirely and the
/// CLI rejects `--inject-failure` as an unknown flag.
#[cfg(any(debug_assertions, feature = "failure-injection"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InjectFailure {
    None,
    PreflightByteBudget,
    PreflightSourceHash,
    VerifyHashMismatch,
}

#[cfg(any(debug_assertions, feature = "failure-injection"))]
impl InjectFailure {
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
    /// Test/debug-only failure-injection selector. Gated behind
    /// `cfg(any(debug_assertions, feature = "failure-injection"))` so it is
    /// absent from a release `--no-default-features` build.
    #[cfg(any(debug_assertions, feature = "failure-injection"))]
    pub inject_failure: InjectFailure,
    pub run_id: &'a str,
}

/// Exit-code categorization. `Ok` => exit 0; `Err(StatusFailed)` =>
/// exit 1 (v0.2 failed but smoke completed and wrote
/// `patch-result.json`); `Err(StatusAborted)` => exit 2 (smoke could
/// not reach the v0.2 contract emission).
#[derive(Debug)]
pub enum BinarySmokeOutcome {
    Passed,
    Failed,
    Aborted(String),
}

const ADAPTER_ID: &str = "kaifuu-reallive";
const PATCH_EXPORT_ID: &str = "019ed011-0000-7000-8000-000000000001";
const BRIDGE_UNIT_ID: &str = "019ed011-0000-7000-8000-000000000020";
const ASSET_ID: &str = "019ed011-0000-7000-8000-000000000010";
const COMMAND: &str = "patch.write_string_slot";
const REQUIRED_TRANSFORMS: &[&str] = &["identity"];

/// Reallive-flavoured capabilities. Uses the
/// `LayeredAccessCapabilityContract::plaintext_identity` factory
/// because the smoke fixture is a plaintext archive; the patch
/// transform is identity (length-preserving). Engine ports adopting
/// the harness later will supply their own capability matrix; this
/// fixture is the structural defense for the smoke.
fn reallive_capabilities() -> AdapterCapabilities {
    // the binary-patch smoke is a plaintext-identity fixture
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
    // Step 0: prepare the output directory.
    if let Err(error) = fs::create_dir_all(config.output_dir) {
        return BinarySmokeOutcome::Aborted(format!("failed to create output directory: {error}"));
    }
    let output_seen_path = config.output_dir.join("SEEN.TXT");
    let patch_result_path = config.output_dir.join("patch-result.json");

    // Step 1: read or synthesize SEEN.TXT.
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

    // Step 2: parse the archive and run the canonical bundle_driven
    // patchback (`apply_translated_bundle`).
    if let Err(diag) = parse_archive(&archive_bytes) {
        return BinarySmokeOutcome::Aborted(format!("synthetic archive failed to parse: {diag:?}"));
    }

    // The PreflightSourceHash injection points the unit's source
    // provenance at an occurrence the scene bytecode cannot resolve,
    // forcing a typed `ProvenanceMismatch` (source-incompatible) out of
    // the bundle_driven driver — the bundle_driven analogue of the old
    // stale-source-hash refusal.
    #[cfg(any(debug_assertions, feature = "failure-injection"))]
    let source_unit_key = match config.inject_failure {
        InjectFailure::PreflightSourceHash => "reallive:scene-0001#9999",
        _ => SYNTHETIC_DIALOGUE_SOURCE_UNIT_KEY,
    };
    #[cfg(not(any(debug_assertions, feature = "failure-injection")))]
    let source_unit_key = SYNTHETIC_DIALOGUE_SOURCE_UNIT_KEY;
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

    let patched_bytes = match apply_translated_bundle(
        &archive_bytes,
        &translated,
        &PatchbackOpts::shift_jis(kaifuu_reallive::TranslationScope::DialogueAndChoices),
    ) {
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

    // Step 3: apply --inject-failure that does NOT change the patchback
    // input shape.
    #[cfg(any(debug_assertions, feature = "failure-injection"))]
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
    #[cfg(not(any(debug_assertions, feature = "failure-injection")))]
    let payload_to_stage = patched_bytes.clone();

    #[cfg(any(debug_assertions, feature = "failure-injection"))]
    let byte_budget = match config.inject_failure {
        InjectFailure::PreflightByteBudget => 1, // force preflight rejection
        _ => patched_bytes.len() as u64,
    };
    #[cfg(not(any(debug_assertions, feature = "failure-injection")))]
    let byte_budget = patched_bytes.len() as u64;

    let expected_source_hash = sha256_hash_bytes(&archive_bytes);
    let expected_output_hash = sha256_hash_bytes(&patched_bytes);
    let expected_payload_len = patched_bytes.len() as u64;
    let capabilities = reallive_capabilities();

    // Step 4: drive the PatchTransaction state machine.
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

    // Step 5: emit PatchResult v0.2.
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
            | TransactionState::StageFailed
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
