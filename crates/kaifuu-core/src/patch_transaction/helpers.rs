//! Private helpers for the patch-transaction harness: staging paths,
//! transform-contract checks, canonical hash validation, and v0.2 PatchResult
//! emission.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use sha2::{Digest, Sha256};

use crate::{
    BRIDGE_SCHEMA_VERSION_V02, CapabilityStatus, LayeredAccessOperationContract,
    SEMANTIC_PATCH_TRANSACTION_CANCELLED, SEMANTIC_PATCH_TRANSACTION_PROMOTE_ROLLED_BACK,
    SEMANTIC_PATCH_TRANSACTION_STAGED_VERIFY_ROLLED_BACK,
    SEMANTIC_PATCH_TRANSACTION_STAGED_WRITE_FAILED, sha256_hash_bytes,
};

use super::{PatchTransactionConfig, TransactionDiagnostic, TransactionState};

pub(super) fn staging_path_for(config: &PatchTransactionConfig<'_>) -> PathBuf {
    let parent = config
        .output_path
        .parent()
        .map_or_else(|| PathBuf::from("."), Path::to_path_buf);
    parent
        .join(".staging")
        .join(format!("{}-{}.tmp", config.asset_id, config.run_id))
}

pub(super) fn operation_contract_supports(
    contract: &LayeredAccessOperationContract,
    transform_id: &str,
) -> bool {
    if contract.status != CapabilityStatus::Supported {
        return false;
    }
    let lists = [
        contract
            .supported_surfaces
            .iter()
            .map(serde_json_snake_case)
            .collect::<Vec<_>>(),
        contract
            .supported_containers
            .iter()
            .map(serde_json_snake_case)
            .collect::<Vec<_>>(),
        contract
            .supported_crypto
            .iter()
            .map(serde_json_snake_case)
            .collect::<Vec<_>>(),
        contract
            .supported_codecs
            .iter()
            .map(serde_json_snake_case)
            .collect::<Vec<_>>(),
        contract
            .supported_patch_back
            .iter()
            .map(serde_json_snake_case)
            .collect::<Vec<_>>(),
    ];
    lists
        .iter()
        .any(|list| list.iter().any(|entry| entry == transform_id))
}

fn serde_json_snake_case<T: serde::Serialize>(value: &T) -> String {
    // The transform enums use #[serde(rename_all = "snake_case")], so their
    // JSON serialization is a plain string. We trim the surrounding quotes
    // to recover the snake_case token.
    let raw = serde_json::to_string(value).unwrap_or_default();
    raw.trim_matches('"').to_string()
}

pub(super) fn is_canonical_sha256(value: &str) -> bool {
    if value.len() != 71 || !value.starts_with("sha256:") {
        return false;
    }
    value[7..]
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn build_patch_result_v02(
    config: &PatchTransactionConfig<'_>,
    final_state: TransactionState,
    diagnostics: &[TransactionDiagnostic],
) -> Value {
    let mut result = Map::new();
    result.insert(
        "schemaVersion".to_string(),
        Value::String(BRIDGE_SCHEMA_VERSION_V02.to_string()),
    );
    result.insert(
        "patchResultId".to_string(),
        Value::String(deterministic_uuid7(&[
            "patch-tx-result",
            config.patch_export_id,
            config.asset_id,
            config.run_id,
            &format!("{final_state:?}"),
        ])),
    );
    result.insert(
        "patchExportId".to_string(),
        Value::String(config.patch_export_id.to_string()),
    );
    result.insert(
        "adapterId".to_string(),
        Value::String(config.adapter_id.to_string()),
    );

    let status = match final_state {
        TransactionState::Promoted => "passed",
        // The terminal failure states (PreflightFailed / VerifyFailed /
        // StageFailed / PromoteFailed / Cancelled) and any non-terminal default
        // all map to "failed"; non-terminal states are routed via into_outcome
        // upstream.
        _ => "failed",
    };
    result.insert("status".to_string(), Value::String(status.to_string()));

    if status == "passed" {
        let touched = json!([{
            "assetId": config.asset_id,
            "outputHash": config.expected_output_hash,
            "byteSize": config.expected_payload_len,
        }]);
        let rollup = touched_assets_rollup(config);
        result.insert("touchedAssets".to_string(), touched);
        result.insert("outputHash".to_string(), Value::String(rollup));
        result.insert("failures".to_string(), Value::Array(vec![]));
    } else {
        let failures: Vec<Value> = diagnostics
            .iter()
            .enumerate()
            .map(|(index, diag)| build_failure_v02(config, diag, index))
            .collect();
        let mut categories: Vec<String> = diagnostics
            .iter()
            .map(|diag| diag.category.as_v02_category().to_string())
            .collect();
        categories.sort();
        categories.dedup();
        result.insert("failures".to_string(), Value::Array(failures));
        result.insert(
            "failureCategories".to_string(),
            Value::Array(categories.into_iter().map(Value::String).collect()),
        );
        result.insert(
            "partialWrite".to_string(),
            build_partial_write_v02(config, final_state, diagnostics),
        );
    }

    Value::Object(result)
}

fn build_failure_v02(
    config: &PatchTransactionConfig<'_>,
    diagnostic: &TransactionDiagnostic,
    index: usize,
) -> Value {
    json!({
        "failureId": deterministic_uuid7(&[
            "patch-tx-failure",
            config.patch_export_id,
            config.asset_id,
            config.run_id,
            &diagnostic.diagnostic_code,
            &format!("{index}"),
        ]),
        "category": diagnostic.category.as_v02_category(),
        "diagnosticCode": diagnostic.diagnostic_code,
        "cause": diagnostic.cause,
        "assetId": config.asset_id,
        "bridgeUnitId": config.bridge_unit_id,
        "adapterId": config.adapter_id,
        "command": config.command,
    })
}

fn build_partial_write_v02(
    config: &PatchTransactionConfig<'_>,
    final_state: TransactionState,
    diagnostics: &[TransactionDiagnostic],
) -> Value {
    let disposition = match final_state {
        TransactionState::Cancelled => "cleaned_up",
        _ => "rolled_back",
    };
    let rollback_diagnostic = rollback_diagnostic_code(final_state, diagnostics);
    json!({
        "attemptedAssetIds": [config.asset_id],
        "writtenAssetIds": [],
        "skippedAssetIds": [config.asset_id],
        "disposition": disposition,
        "rollbackDiagnosticCode": rollback_diagnostic,
    })
}

fn rollback_diagnostic_code(
    final_state: TransactionState,
    diagnostics: &[TransactionDiagnostic],
) -> String {
    match final_state {
        TransactionState::VerifyFailed => {
            SEMANTIC_PATCH_TRANSACTION_STAGED_VERIFY_ROLLED_BACK.to_string()
        }
        TransactionState::StageFailed => {
            // Stage-time write failure: no rename was attempted. The precise
            // diagnostic code that fired (staged_write_failed, staged_collision,
            // relocation_unsupported, …) is the most accurate rollback marker.
            diagnostics.first().map_or_else(
                || SEMANTIC_PATCH_TRANSACTION_STAGED_WRITE_FAILED.to_string(),
                |d| d.diagnostic_code.clone(),
            )
        }
        TransactionState::PromoteFailed => {
            // Promote-time rename failure: staging wrote and verified, but the
            // atomic swap failed and was rolled back.
            SEMANTIC_PATCH_TRANSACTION_PROMOTE_ROLLED_BACK.to_string()
        }
        TransactionState::Cancelled => SEMANTIC_PATCH_TRANSACTION_CANCELLED.to_string(),
        _ => diagnostics.first().map_or_else(
            || SEMANTIC_PATCH_TRANSACTION_CANCELLED.to_string(),
            |d| d.diagnostic_code.clone(),
        ),
    }
}

fn touched_assets_rollup(config: &PatchTransactionConfig<'_>) -> String {
    // Single-asset rollup: sha256(format!("{assetId}\n{outputHash}\n")).
    let payload = format!("{}\n{}\n", config.asset_id, config.expected_output_hash);
    sha256_hash_bytes(payload.as_bytes())
}

/// Build a deterministic UUID7-shaped string from the supplied parts.
/// The UUID variant byte (position 19, i.e. the first hex char of the fourth
/// group) is forced into `8..=b` and the version nibble (position 14) is
/// forced to `7`, matching `assert_uuid7` in the contracts validator.
fn deterministic_uuid7(parts: &[&str]) -> String {
    use std::fmt::Write as _;
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    // 8-4-4-4-12 layout. We fix the version (group 3 first hex) to '7' and
    // the variant (group 4 first hex) to '8'.
    let g1 = &hex[0..8];
    let g2 = &hex[8..12];
    let g3 = &hex[12..16];
    let g4 = &hex[16..20];
    let g5 = &hex[20..32];
    // Force version 7 (position 14 in the final string, position 0 of g3).
    let g3 = format!("7{}", &g3[1..]);
    // Force variant 8 (position 19 of the final string, position 0 of g4).
    let g4 = format!("8{}", &g4[1..]);
    format!("{g1}-{g2}-{g3}-{g4}-{g5}")
}
