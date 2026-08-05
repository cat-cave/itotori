//! Shared BridgeBundleV02 JSON assembly for engine extract adapters.
//! Producers supply live source facts; this helper mints deterministic ids,
//! hash strategy, and validates the wire shape before extract returns it.

use serde_json::{Value, json};

use super::{
    BRIDGE_SCHEMA_VERSION_V02, BridgeBundleV02, BridgeContractValidationError, KaifuuResult,
    ProtectedSpan, sha256_hash_bytes,
};

/// Identity knobs every extract adapter must name explicitly.
#[derive(Debug, Clone, Copy)]
pub struct BridgeV02ProduceOpts<'a> {
    pub game_id: &'a str,
    pub game_version: &'a str,
    pub source_profile_id: &'a str,
    pub source_locale: &'a str,
    pub extractor_name: &'a str,
    pub extractor_version: &'a str,
}

/// One source asset the units may reference.
#[derive(Debug, Clone)]
pub struct BridgeV02AssetInput {
    pub asset_key: String,
    pub asset_kind: &'static str,
    pub source_hash: String,
    pub path: Option<String>,
}

/// One localization unit assembled from live source decode.
#[derive(Debug, Clone)]
pub struct BridgeV02UnitInput {
    pub source_unit_key: String,
    pub occurrence_id: String,
    pub source_text: String,
    pub surface_kind: &'static str,
    pub speaker: Option<String>,
    pub scene_id: String,
    pub asset_key: String,
    pub protected_spans: Vec<ProtectedSpan>,
    /// Required for `choice_label` surfaces.
    pub choice_option_index: Option<u64>,
}

/// Assemble and validate a BridgeBundleV02 JSON value from live extract facts.
pub fn produce_bridge_v02_json(
    opts: &BridgeV02ProduceOpts<'_>,
    source_bundle_hash: &str,
    assets: &[BridgeV02AssetInput],
    units: &[BridgeV02UnitInput],
) -> KaifuuResult<Value> {
    let namespace = format!(
        "bridge-v02:game-id={}:source-profile-id={}",
        opts.game_id, opts.source_profile_id
    );
    let bridge_id = produce_uuid7(&namespace, "bundle");
    let bundle_revision_id = produce_uuid7(&namespace, "bundle-revision");
    let source_profile_hash = sha256_hash_bytes(opts.source_profile_id.as_bytes());
    let source_profile_revision_id = produce_uuid7(&namespace, "source-profile-revision");

    let assets_json: Vec<Value> = assets
        .iter()
        .map(|asset| {
            let asset_id = produce_uuid7(&namespace, &format!("asset-{}", asset.asset_key));
            let revision_id =
                produce_uuid7(&namespace, &format!("asset-revision-{}", asset.asset_key));
            let mut object = json!({
                "assetId": asset_id,
                "assetKey": asset.asset_key,
                "assetKind": asset.asset_kind,
                "sourceHash": asset.source_hash,
                "sourceRevision": {
                    "revisionId": revision_id,
                    "revisionKind": "content_hash",
                    "value": asset.source_hash,
                },
            });
            if let Some(path) = &asset.path {
                object["path"] = json!(path);
            }
            object
        })
        .collect();

    let asset_id_for =
        |asset_key: &str| -> String { produce_uuid7(&namespace, &format!("asset-{asset_key}")) };
    let asset_revision_for = |asset_key: &str| -> String {
        produce_uuid7(&namespace, &format!("asset-revision-{asset_key}"))
    };
    let asset_hash_for = |asset_key: &str| -> KaifuuResult<String> {
        assets
            .iter()
            .find(|asset| asset.asset_key == asset_key)
            .map(|asset| asset.source_hash.clone())
            .ok_or_else(|| format!("bridge unit references unknown assetKey {asset_key}").into())
    };

    let mut units_json = Vec::with_capacity(units.len());
    for unit in units {
        let asset_id = asset_id_for(&unit.asset_key);
        let revision_id = asset_revision_for(&unit.asset_key);
        let asset_hash = asset_hash_for(&unit.asset_key)?;
        units_json.push(unit_json(
            &namespace,
            opts,
            &asset_id,
            &unit.asset_key,
            &revision_id,
            &asset_hash,
            unit,
        ));
    }

    let json = json!({
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
        "sourceBundleHash": source_bundle_hash,
        "sourceBundleRevision": {
            "revisionId": bundle_revision_id,
            "revisionKind": "content_hash",
            "value": source_bundle_hash,
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
    });
    BridgeBundleV02::validate_json(&json).map_err(|err: BridgeContractValidationError| {
        Box::<dyn std::error::Error>::from(format!(
            "bridge v0.2 production failed validation: {err}"
        ))
    })?;
    Ok(json)
}

fn unit_json(
    namespace: &str,
    opts: &BridgeV02ProduceOpts<'_>,
    asset_id: &str,
    asset_key: &str,
    revision_id: &str,
    asset_hash: &str,
    unit: &BridgeV02UnitInput,
) -> Value {
    let source_hash = sha256_hash_bytes(unit.source_text.as_bytes());
    let bridge_unit_id = produce_uuid7(namespace, &format!("unit-{}", unit.source_unit_key));
    let surface_id = produce_uuid7(namespace, &format!("surface-{}", unit.source_unit_key));
    let spans: Vec<Value> = unit
        .protected_spans
        .iter()
        .enumerate()
        .map(|(index, span)| {
            let span_id =
                produce_uuid7(namespace, &format!("span-{}-{index}", unit.source_unit_key));
            let span_kind = match span.kind.as_str() {
                "placeholder" | "variable_placeholder" => "variable_placeholder",
                "ruby_annotation" => "ruby_annotation",
                _ => "control_markup",
            };
            let preserve_mode = match span.preserve_mode.as_str() {
                "map" | "transform" | "locale_policy" => span.preserve_mode.as_str(),
                _ => "exact",
            };
            let mut object = json!({
                "spanId": span_id,
                "spanKind": span_kind,
                "raw": span.raw,
                "startByte": span.start,
                "endByte": span.end,
                "preserveMode": preserve_mode,
            });
            if let Some(parsed_name) = &span.parsed_name {
                object["parsedName"] = json!(parsed_name);
            }
            if let Some(variable_name) = &span.variable_name {
                object["variableName"] = json!(variable_name);
            }
            object
        })
        .collect();
    let route = json!({
        "sceneId": unit.scene_id,
        "position": unit.source_unit_key,
    });
    let context = match unit.surface_kind {
        "choice_label" => {
            let option_index = unit.choice_option_index.unwrap_or(0);
            json!({
                "choice": {
                    "choiceGroupId": produce_uuid7(namespace, &format!("choice-group-{}", unit.scene_id)),
                    "choiceId": produce_uuid7(namespace, &format!("choice-{}", unit.source_unit_key)),
                    "optionIndex": option_index,
                    "routeTargetRef": unit.source_unit_key,
                },
                "route": route,
            })
        }
        "speaker_name" => json!({
            "speakerName": { "displayContext": "name_plate" },
            "route": route,
        }),
        "ui_label" => json!({
            "ui": { "uiArea": "menu" },
            "route": route,
        }),
        "tutorial_text" => json!({
            "tutorial": { "tutorialStepRef": unit.source_unit_key },
            "route": route,
        }),
        "database_entry" => json!({
            "database": {
                "databaseKind": "item",
                "entryId": unit.source_unit_key,
                "fieldKey": "name",
            },
            "route": route,
        }),
        "image_text" => json!({
            "imageText": {
                "region": { "x": 0, "y": 0, "width": 1, "height": 1 },
                "editable": true,
                "replacementMode": "overlay_text",
            },
            "route": route,
        }),
        "song_title" => json!({
            "song": { "titleField": "title" },
            "route": route,
        }),
        "metadata_text" => json!({
            "metadata": {
                "metadataScope": "credits",
                "fieldKey": unit.source_unit_key,
                "visibility": "runtime",
            },
            "route": route,
        }),
        _ => json!({ "route": route }),
    };
    let speaker = match &unit.speaker {
        Some(name) if !name.is_empty() => json!({
            "knowledgeState": "parser_unknown",
            "rawSpeakerText": name,
            "evidence": "extract_adapter_speaker",
        }),
        _ => json!({ "knowledgeState": "not_applicable" }),
    };
    json!({
        "bridgeUnitId": bridge_unit_id,
        "surfaceId": surface_id,
        "surfaceKind": unit.surface_kind,
        "sourceUnitKey": unit.source_unit_key,
        "occurrenceId": unit.occurrence_id,
        "sourceLocale": opts.source_locale,
        "sourceText": unit.source_text,
        "sourceHash": source_hash,
        "sourceRevision": {
            "revisionId": revision_id,
            "revisionKind": "content_hash",
            "value": asset_hash,
        },
        "sourceAssetRef": { "assetId": asset_id, "assetKey": asset_key },
        "sourceLocation": {
            "containerKey": asset_key,
            "entryPath": ["unit", unit.source_unit_key],
        },
        "speaker": speaker,
        "context": context,
        "spans": spans,
        "patchRef": {
            "assetId": asset_id,
            "writeMode": "replace",
            "sourceUnitKey": unit.source_unit_key,
            "sourceRevision": {
                "revisionId": revision_id,
                "revisionKind": "content_hash",
                "value": asset_hash,
            },
        },
        "runtimeExpectation": {
            "expectationKind": "trace_text",
            "traceKey": format!("extract:{}", unit.source_unit_key),
        },
    })
}

fn hash_strategy_json() -> Value {
    json!({
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
    })
}

/// Deterministic UUID7-shaped id from SHA-256 of `namespace:role`.
pub fn produce_uuid7(namespace: &str, role: &str) -> String {
    let digest = sha256_hash_bytes(format!("{namespace}:{role}").as_bytes());
    let hex = digest
        .strip_prefix("sha256:")
        .expect("sha256_hash_bytes always yields sha256: prefix");
    let mut bytes = [0_u8; 16];
    for (index, slot) in bytes.iter_mut().enumerate() {
        let start = index * 2;
        *slot = u8::from_str_radix(&hex[start..start + 2], 16)
            .expect("sha256 hex is valid lowercase hex");
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
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

/// Count units in a BridgeBundleV02 JSON value.
#[must_use]
pub fn bridge_v02_unit_count(bridge: &Value) -> usize {
    bridge
        .get("units")
        .and_then(Value::as_array)
        .map_or(0, Vec::len)
}
