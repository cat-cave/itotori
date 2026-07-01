//! Assemble [`ProtoUnit`]s into a localization-bridge v0.2
//! [`BridgeBundleV02`].
//!
//! This is the RPG Maker MV/MZ analogue of
//! `crates/kaifuu-reallive/src/bridge.rs`: it reuses the **shared**
//! `kaifuu_core::BridgeBundleV02` contract and v0.2 schema (no parallel
//! format), keying each unit by its stable `rpgmaker:<file>#<json-pointer>`
//! surface id so re-extraction is deterministic and patchback targets the
//! same surface.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;

use kaifuu_core::{BRIDGE_SCHEMA_VERSION_V02, BridgeBundleV02, BridgeContractValidationError};

use crate::extract::{ProtoUnit, SurfaceKind};

/// Caller-supplied knobs for [`produce_bundle`]. All fields are required;
/// there are no silent defaults.
#[derive(Debug, Clone)]
pub struct BridgeOpts<'a> {
    pub game_id: &'a str,
    pub game_version: &'a str,
    pub source_profile_id: &'a str,
    pub source_locale: &'a str,
    pub extractor_name: &'a str,
    pub extractor_version: &'a str,
}

/// One source `www/data/*.json` file, as a bridge asset.
#[derive(Debug, Clone)]
pub struct FileAsset {
    /// File name (e.g. `Map001.json`).
    pub file: String,
    /// `sha256:<hex>` of the file's raw bytes.
    pub source_hash: String,
    /// v0.2 asset kind (`script` for event files, `database` otherwise).
    pub asset_kind: &'static str,
}

/// Output of [`produce_bundle`].
#[derive(Debug, Clone)]
pub struct ProducedBundle {
    pub bundle: BridgeBundleV02,
    pub json: Value,
}

/// Fatal errors raised by [`produce_bundle`].
#[derive(Debug, Clone, Error)]
pub enum BridgeProduceError {
    #[error("kaifuu.rpgmaker.bridge.no_units: no translatable units extracted")]
    NoUnits,
    #[error("kaifuu.rpgmaker.bridge.missing_asset: unit references file {file} with no asset")]
    MissingAsset { file: String },
    #[error("kaifuu.rpgmaker.bridge.schema_validation: {0}")]
    SchemaValidation(String),
}

impl From<BridgeContractValidationError> for BridgeProduceError {
    fn from(value: BridgeContractValidationError) -> Self {
        Self::SchemaValidation(value.to_string())
    }
}

/// Assemble `units` (referencing `assets`) into a validated v0.2 bundle.
pub fn produce_bundle(
    units: &[ProtoUnit],
    assets: &[FileAsset],
    opts: &BridgeOpts<'_>,
) -> Result<ProducedBundle, BridgeProduceError> {
    if units.is_empty() {
        return Err(BridgeProduceError::NoUnits);
    }
    let json = build_bundle_json(units, assets, opts)?;
    let bundle = BridgeBundleV02::validate_json(&json)?;
    Ok(ProducedBundle { bundle, json })
}

fn build_bundle_json(
    units: &[ProtoUnit],
    assets: &[FileAsset],
    opts: &BridgeOpts<'_>,
) -> Result<Value, BridgeProduceError> {
    let namespace = format!(
        "rpgmaker-bridge:game-id={}:source-profile-id={}",
        opts.game_id, opts.source_profile_id
    );

    // Bundle hash: deterministic over the sorted (file, hash) manifest.
    let mut manifest: Vec<(&str, &str)> = assets
        .iter()
        .map(|a| (a.file.as_str(), a.source_hash.as_str()))
        .collect();
    manifest.sort_unstable();
    let mut manifest_blob = String::new();
    for (file, hash) in &manifest {
        manifest_blob.push_str(file);
        manifest_blob.push('\t');
        manifest_blob.push_str(hash);
        manifest_blob.push('\n');
    }
    let bundle_hash = sha256_canonical(manifest_blob.as_bytes());
    let revision_id = deterministic_uuid7(&namespace, "bundle-revision");
    let bridge_id = deterministic_uuid7(&namespace, "bundle");
    let source_profile_revision_id = deterministic_uuid7(&namespace, "source-profile-revision");
    let source_profile_hash = sha256_canonical(opts.source_profile_id.as_bytes());

    // One asset per source file. asset_id is derived from the file name so
    // it is stable across re-extraction.
    let assets_json: Vec<Value> = assets
        .iter()
        .map(|asset| {
            let asset_id = deterministic_uuid7(&namespace, &format!("asset-{}", asset.file));
            json!({
                "assetId": asset_id,
                "assetKey": format!("rpgmaker:{}", asset.file),
                "assetKind": asset.asset_kind,
                "sourceHash": asset.source_hash,
                "sourceRevision": {
                    "revisionId": deterministic_uuid7(&namespace, &format!("asset-revision-{}", asset.file)),
                    "revisionKind": "content_hash",
                    "value": asset.source_hash,
                },
                "path": format!("www/data/{}", asset.file),
            })
        })
        .collect();

    let asset_id_for = |file: &str| -> Option<(String, String)> {
        assets.iter().find(|a| a.file == file).map(|a| {
            (
                deterministic_uuid7(&namespace, &format!("asset-{}", a.file)),
                format!("rpgmaker:{}", a.file),
            )
        })
    };

    let mut units_json: Vec<Value> = Vec::with_capacity(units.len());
    for unit in units {
        let (asset_id, asset_key) =
            asset_id_for(&unit.file).ok_or_else(|| BridgeProduceError::MissingAsset {
                file: unit.file.clone(),
            })?;
        units_json.push(build_unit_json(
            &namespace,
            &asset_id,
            &asset_key,
            &revision_id,
            &bundle_hash,
            opts,
            unit,
        ));
    }

    Ok(json!({
        "schemaVersion": BRIDGE_SCHEMA_VERSION_V02,
        "bridgeId": bridge_id,
        "sourceGame": {
            "gameId": opts.game_id,
            "gameVersion": opts.game_version,
            "sourceProfileId": opts.source_profile_id,
            "sourceProfileRevision": {
                "revisionId": source_profile_revision_id,
                "revisionKind": "content_hash",
                "value": source_profile_hash,
            },
        },
        "sourceBundleHash": bundle_hash,
        "sourceBundleRevision": {
            "revisionId": revision_id,
            "revisionKind": "content_hash",
            "value": bundle_hash,
        },
        "sourceLocale": opts.source_locale,
        "hashStrategy": hash_strategy_json(),
        "extractor": {
            "name": opts.extractor_name,
            "version": opts.extractor_version,
        },
        "assets": assets_json,
        "units": units_json,
        "policyRecords": [],
    }))
}

fn hash_strategy_json() -> Value {
    json!({
        "sourceProfile": {"scope": "source_profile", "algorithm": "sha256", "normalization": "utf8-nfc-lf-json-stable-v1"},
        "sourceBundle": {"scope": "source_bundle", "algorithm": "sha256", "normalization": "utf8-nfc-lf-json-stable-v1"},
        "sourceAsset": {"scope": "source_asset", "algorithm": "sha256", "normalization": "bytes"},
        "sourceUnit": {
            "scope": "source_unit", "algorithm": "sha256", "normalization": "utf8-nfc-lf-json-stable-v1",
            "fields": ["sourceLocale", "sourceUnitKey", "sourceText", "spans.raw"],
        },
        "patchExport": {"scope": "patch_export", "algorithm": "sha256", "normalization": "utf8-nfc-lf-json-stable-v1"},
        "deltaPackage": {"scope": "delta_package", "algorithm": "sha256", "normalization": "utf8-nfc-lf-json-stable-v1"},
    })
}

#[allow(clippy::too_many_arguments)]
fn build_unit_json(
    namespace: &str,
    asset_id: &str,
    asset_key: &str,
    revision_id: &str,
    bundle_hash: &str,
    opts: &BridgeOpts<'_>,
    unit: &ProtoUnit,
) -> Value {
    let source_unit_key = unit.source_unit_key();
    let source_text = &unit.text;
    let source_hash = sha256_canonical(source_text.as_bytes());
    let bridge_unit_id = deterministic_uuid7(namespace, &format!("unit-{source_unit_key}"));
    let surface_id = deterministic_uuid7(namespace, &format!("surface-{source_unit_key}"));

    let surface_kind = surface_kind_str(&unit.surface_kind);

    let spans_json: Vec<Value> = unit
        .spans
        .iter()
        .enumerate()
        .map(|(idx, span)| {
            let mut value = json!({
                "spanId": deterministic_uuid7(namespace, &format!("span-{source_unit_key}-{idx}")),
                "spanKind": "control_markup",
                "raw": span.raw,
                "startByte": span.start_byte as u64,
                "endByte": span.end_byte as u64,
                "preserveMode": "exact",
                "parsedName": span.parsed_name,
            });
            if let Some(argument) = &span.argument {
                value["arguments"] = json!([argument]);
            }
            value
        })
        .collect();

    let source_location = json!({
        "containerKey": format!("rpgmaker:{}", unit.file),
        "entryPath": unit.pointer,
    });

    let speaker = match (&unit.surface_kind, &unit.speaker) {
        (SurfaceKind::Dialogue { .. }, Some(speaker)) => json!({
            "knowledgeState": "parser_unknown",
            "rawSpeakerText": speaker,
            "evidence": "show_text_speaker_param",
        }),
        _ => Value::Null,
    };

    let context = surface_context_json(namespace, &source_unit_key, unit);

    let mut unit_value = json!({
        "bridgeUnitId": bridge_unit_id,
        "surfaceId": surface_id,
        "surfaceKind": surface_kind,
        "sourceUnitKey": source_unit_key,
        "occurrenceId": source_unit_key,
        "sourceLocale": opts.source_locale,
        "sourceText": source_text,
        "sourceHash": source_hash,
        "sourceRevision": {
            "revisionId": revision_id,
            "revisionKind": "content_hash",
            "value": bundle_hash,
        },
        "sourceAssetRef": {"assetId": asset_id, "assetKey": asset_key},
        "sourceLocation": source_location,
        "context": context,
        "spans": spans_json,
        "patchRef": {
            "assetId": asset_id,
            "writeMode": "replace",
            "sourceUnitKey": source_unit_key,
            "sourceRevision": {
                "revisionId": revision_id,
                "revisionKind": "content_hash",
                "value": bundle_hash,
            },
        },
        "runtimeExpectation": {
            "expectationKind": "trace_text",
            "traceKey": source_unit_key,
        },
    });
    if !speaker.is_null() {
        unit_value["speaker"] = speaker;
    }
    unit_value
}

fn surface_kind_str(kind: &SurfaceKind) -> &'static str {
    match kind {
        SurfaceKind::Dialogue { .. } => "dialogue",
        // Recognized plugin display text (e.g. D_TEXT) is on-screen,
        // speaker-less display text — the v0.2 `narration` surface, same as
        // plain Narration.
        SurfaceKind::Narration | SurfaceKind::PluginText { .. } => "narration",
        SurfaceKind::ChoiceLabel { .. } => "choice_label",
        SurfaceKind::SpeakerName => "speaker_name",
        SurfaceKind::Database { .. } => "database_entry",
        SurfaceKind::UiLabel { .. } => "ui_label",
        SurfaceKind::MetadataText { .. } => "metadata_text",
    }
}

fn surface_context_json(namespace: &str, source_unit_key: &str, unit: &ProtoUnit) -> Value {
    let scene_key = format!("rpgmaker:{}", unit.file);
    let position = unit.pointer_string();
    match &unit.surface_kind {
        SurfaceKind::Dialogue { message_group } => json!({
            "route": {
                "sceneKey": scene_key,
                "position": format!("{position}#msg-{message_group}"),
            },
        }),
        SurfaceKind::Narration => json!({
            "route": {"sceneKey": scene_key, "position": position},
        }),
        SurfaceKind::PluginText { plugin_command } => json!({
            "route": {
                "sceneKey": scene_key,
                "position": format!("{position}#plugin-{plugin_command}"),
            },
        }),
        SurfaceKind::ChoiceLabel { group, option } => json!({
            "choice": {
                "choiceGroupId": deterministic_uuid7(namespace, &format!("choice-group-{}-{group}", unit.file)),
                "choiceId": deterministic_uuid7(namespace, &format!("choice-{}-{group}-{option}", unit.file)),
                "optionIndex": *option as u64,
            },
            "route": {"sceneKey": scene_key, "position": position},
        }),
        SurfaceKind::SpeakerName => json!({
            "speakerName": {"displayContext": "name_plate"},
        }),
        SurfaceKind::Database {
            database_kind,
            entry_id,
            field_key,
        } => json!({
            "database": {
                "databaseKind": database_kind,
                "entryId": entry_id,
                "fieldKey": field_key,
                "sortKey": source_unit_key,
            },
        }),
        SurfaceKind::UiLabel { ui_area } => json!({
            "ui": {"uiArea": ui_area, "controlRef": position},
        }),
        SurfaceKind::MetadataText {
            scope,
            field_key,
            visibility,
        } => json!({
            "metadata": {"metadataScope": scope, "fieldKey": field_key, "visibility": visibility},
        }),
    }
}

fn sha256_canonical(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in &digest {
        let _ = write!(hex, "{byte:02x}");
    }
    format!("sha256:{hex}")
}

/// Deterministic UUID7-shaped string from `(namespace, role)` — identical
/// construction to the RealLive bridge producer so both extractors share
/// one identifier scheme.
fn deterministic_uuid7(namespace: &str, role: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(namespace.as_bytes());
    hasher.update(b":");
    hasher.update(role.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0F) | 0x70;
    bytes[8] = (bytes[8] & 0x3F) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}
