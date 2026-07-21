//! v0.2 wire-format assembly for already-collected Siglus bridge units.

use serde_json::{Value, json};

use kaifuu_core::{BRIDGE_SCHEMA_VERSION_V02, BridgeBundleV02};

use crate::GLOBAL_SELBTN_SYSTEM_FUNCTION_ID;

use super::assembly::{ProtoUnit, SceneParts, SpeakerResolution};
use super::ids::{deterministic_uuid7, scene_namespace, sha256_canonical, speaker_id};
use super::markup::protected_spans;
use super::model::{BridgeOpts, BridgeProduceError, ProducedBundle};

pub(super) fn produce_json_bundle(
    source_bundle_bytes: &[u8],
    bundle_namespace: &str,
    scenes: Vec<SceneParts<'_>>,
    opts: &BridgeOpts<'_>,
) -> Result<ProducedBundle, BridgeProduceError> {
    let source_bundle_hash = sha256_canonical(source_bundle_bytes);
    let bundle_revision_id = deterministic_uuid7(bundle_namespace, "bundle-revision");
    let source_profile_hash = sha256_canonical(opts.source_profile_id.as_bytes());
    let source_profile_revision_id =
        deterministic_uuid7(bundle_namespace, "source-profile-revision");
    let mut assets = Vec::with_capacity(scenes.len());
    let mut units = Vec::new();
    for scene in &scenes {
        let namespace = scene_namespace(opts.game_id, opts.source_profile_id, &scene.scene_name);
        let scene_hash = sha256_canonical(scene.scene_bytes);
        let asset_id = deterministic_uuid7(&namespace, "scene-asset");
        let revision_id = deterministic_uuid7(&namespace, "scene-revision");
        let asset_key = scene_key(&scene.scene_name);
        assets.push(json!({
            "assetId": asset_id,
            "assetKey": asset_key,
            "assetKind": "script",
            "sourceHash": scene_hash,
            "sourceRevision": {
                "revisionId": revision_id,
                "revisionKind": "content_hash",
                "value": scene_hash,
            },
            "path": format!("Scene.pck#{}", scene.scene_name),
        }));
        for unit in &scene.units {
            units.push(build_unit_json(
                scene.scene_id,
                &scene.scene_name,
                &asset_id,
                &asset_key,
                &revision_id,
                &scene_hash,
                &namespace,
                opts,
                unit,
            )?);
        }
    }
    let json = json!({
        "schemaVersion": BRIDGE_SCHEMA_VERSION_V02,
        "bridgeId": deterministic_uuid7(bundle_namespace, "bundle"),
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
        "hashStrategy": hash_strategy(),
        "extractor": { "name": opts.extractor_name, "version": opts.extractor_version },
        "assets": assets,
        "units": units,
        "policyRecords": [],
    });
    let bundle = BridgeBundleV02::validate_json(&json)?;
    Ok(ProducedBundle { bundle, json })
}

fn hash_strategy() -> Value {
    json!({
        "sourceProfile": { "scope": "source_profile", "algorithm": "sha256", "normalization": "utf8-lf-json-stable-v1" },
        "sourceBundle": { "scope": "source_bundle", "algorithm": "sha256", "normalization": "utf8-lf-json-stable-v1" },
        "sourceAsset": { "scope": "source_asset", "algorithm": "sha256", "normalization": "bytes" },
        "sourceUnit": { "scope": "source_unit", "algorithm": "sha256", "normalization": "utf8-lf-json-stable-v1", "fields": ["sourceLocale", "sourceUnitKey", "sourceText", "spans.raw"] },
        "patchExport": { "scope": "patch_export", "algorithm": "sha256", "normalization": "utf8-lf-json-stable-v1" },
        "deltaPackage": { "scope": "delta_package", "algorithm": "sha256", "normalization": "utf8-lf-json-stable-v1" },
    })
}

// reason: a Bridge unit's JSON is assembled from its full set of independent
// source coordinates (scene id/name, byte offset, kind, text, hash, spans);
// bundling them into a struct purely to satisfy the arity lint would add an
// indirection that obscures the flat wire shape this function exists to emit.
#[allow(clippy::too_many_arguments)]
fn build_unit_json(
    scene_id: u32,
    scene_name: &str,
    asset_id: &str,
    asset_key: &str,
    revision_id: &str,
    scene_hash: &str,
    namespace: &str,
    opts: &BridgeOpts<'_>,
    unit: &ProtoUnit,
) -> Result<Value, BridgeProduceError> {
    let source_unit_key = source_unit_key(scene_name, unit.source_key_offset);
    let spans = protected_spans(&unit.source_text)
        .into_iter()
        .enumerate()
        .map(|(index, span)| {
            let raw = unit
                .source_text
                .get(span.start_byte as usize..span.end_byte as usize)
                .ok_or(BridgeProduceError::ProtectedSpanInvalid {
                    scene_id,
                    command_offset: unit.command_offset,
                    span_index: index,
                })?;
            Ok(json!({
                "spanId": deterministic_uuid7(namespace, &format!("span-{}-{index}", unit.ordinal)),
                "spanKind": "control_markup",
                "raw": raw,
                "startByte": span.start_byte,
                "endByte": span.end_byte,
                "preserveMode": "exact",
                "parsedName": span.parsed_name,
            }))
        })
        .collect::<Result<Vec<_>, BridgeProduceError>>()?;
    let source_location = json!({
        "containerKey": scene_key(scene_name),
        "entryPath": ["scene", scene_name, "string-table", unit.string_index.to_string()],
        "range": {
            "startByte": unit.literal_byte_offset,
            "endByte": unit.literal_byte_offset.saturating_add(unit.literal_byte_len),
        },
    });
    let context = context_json(namespace, scene_name, unit);
    Ok(json!({
        "bridgeUnitId": deterministic_uuid7(namespace, &format!("unit-{}", unit.ordinal)),
        "surfaceId": deterministic_uuid7(namespace, &format!("surface-{}", unit.ordinal)),
        "surfaceKind": unit.surface_kind,
        "sourceUnitKey": source_unit_key,
        "occurrenceId": format!("scene-{scene_name}-command-{}-unit-{}", unit.command_offset, unit.ordinal),
        "sourceLocale": opts.source_locale,
        "sourceText": unit.source_text,
        "sourceHash": sha256_canonical(unit.source_text.as_bytes()),
        "sourceRevision": { "revisionId": revision_id, "revisionKind": "content_hash", "value": scene_hash },
        "sourceAssetRef": { "assetId": asset_id, "assetKey": asset_key },
        "sourceLocation": source_location,
        "speaker": speaker_json(namespace, &unit.speaker),
        "context": context,
        "spans": spans,
        "patchRef": {
            "assetId": asset_id,
            "writeMode": "replace",
            "sourceUnitKey": source_unit_key,
            "sourceRevision": { "revisionId": revision_id, "revisionKind": "content_hash", "value": scene_hash },
        },
        "runtimeExpectation": { "expectationKind": "trace_text", "traceKey": format!("siglus:{scene_name}:{}", unit.command_offset) },
    }))
}

fn context_json(namespace: &str, scene_name: &str, unit: &ProtoUnit) -> Value {
    let route = json!({ "sceneKey": scene_key(scene_name), "position": format!("command-{}", unit.command_offset) });
    if let Some(choice) = &unit.choice {
        let mut select_site = json!({ "systemFunctionId": GLOBAL_SELBTN_SYSTEM_FUNCTION_ID, "byteOffset": choice.select_offset });
        if let Some(target) = choice.branch_target_offset {
            select_site["branchTargetByteOffset"] = json!(target);
        }
        json!({
            "choice": {
                "choiceGroupId": deterministic_uuid7(namespace, &format!("choice-group-{}", choice.select_offset)),
                "choiceId": deterministic_uuid7(namespace, &format!("choice-{}-{}", choice.select_offset, choice.result_value)),
                "optionIndex": choice.option_index,
                "routeTargetRef": source_unit_key(scene_name, choice.select_offset),
                "selectSyscallSite": select_site,
            },
            "route": route,
        })
    } else if unit.surface_kind == "speaker_name" {
        let mut speaker_name = json!({ "displayContext": "name_plate" });
        if let SpeakerResolution::Known { canonical_ref, .. } = &unit.speaker {
            speaker_name["canonicalNameRef"] = json!(canonical_ref);
        }
        json!({ "speakerName": speaker_name, "route": route })
    } else {
        json!({ "route": route })
    }
}

fn speaker_json(namespace: &str, speaker: &SpeakerResolution) -> Value {
    match speaker {
        SpeakerResolution::Known {
            display_name,
            canonical_ref,
        } => json!({
            "knowledgeState": "known",
            "speakerId": speaker_id(namespace, canonical_ref),
            "displayName": display_name,
            "canonicalNameRef": canonical_ref,
            "revealState": "revealed",
        }),
        SpeakerResolution::ParserUnknown { raw } => json!({
            "knowledgeState": "parser_unknown", "rawSpeakerText": raw, "evidence": "siglus.set_name",
        }),
        SpeakerResolution::NotApplicable => json!({ "knowledgeState": "not_applicable" }),
    }
}

pub(super) fn scene_key(scene_name: &str) -> String {
    format!("siglus:scene-{scene_name}")
}

pub(super) fn source_unit_key(scene_name: &str, offset: usize) -> String {
    format!("{}#{offset}", scene_key(scene_name))
}
