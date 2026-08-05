//! Softpal `extract`: disassemble the resolved `SCRIPT.SRC` + `TEXT.DAT` into a
//! localization BridgeBundleV02 of dialogue + text-bearing-choice units.

use std::collections::BTreeSet;

use kaifuu_core::{AdapterWarning, BRIDGE_SCHEMA_VERSION_V02, BridgeBundleV02, sha256_hash_bytes};
use kaifuu_softpal::{ScriptScan, TextDat};
use serde_json::{Value, json};

use super::*;

/// Validated Softpal bridge production: wire JSON for product extract.
pub(crate) struct SoftpalProducedBridge {
    pub json: Value,
    pub warnings: Vec<AdapterWarning>,
}

/// One collected Softpal text unit before JSON assembly.
struct SoftpalProtoUnit {
    source_unit_key: String,
    pointer: u32,
    source_text: String,
    speaker: String,
    surface_kind: &'static str,
    /// SELECT command index for choice units (drives choice group identity).
    choice_option_index: Option<u64>,
}

impl SoftpalProfileDetectorAdapter {
    /// Disassemble the resolved scripts and assemble a localization
    /// BridgeBundleV02: one unit per unique resolved `TEXT.DAT` record for the
    /// dialogue + text-bearing-choice surfaces, keyed by pointer for patch-back.
    pub(crate) fn build_bridge(scripts: &SoftpalScripts) -> KaifuuResult<SoftpalProducedBridge> {
        let scan =
            ScriptScan::parse(&scripts.script).map_err(|err| -> Box<dyn std::error::Error> {
                format!("kaifuu.softpal.script.parse: {err}").into()
            })?;
        let textdat =
            TextDat::parse(&scripts.textdat).map_err(|err| -> Box<dyn std::error::Error> {
                format!("kaifuu.softpal.textdat.parse: {err}").into()
            })?;
        let disassembly = scan.resolve(&textdat);

        let mut units: Vec<SoftpalProtoUnit> = Vec::new();
        let mut seen: BTreeSet<u32> = BTreeSet::new();
        for dialogue in &disassembly.dialogue {
            let Some(text) = dialogue.text.resolved_text() else {
                continue;
            };
            if !seen.insert(dialogue.text.pointer) {
                continue;
            }
            let speaker = dialogue
                .speaker
                .as_ref()
                .and_then(|s| s.resolved_text())
                .unwrap_or_default()
                .to_string();
            units.push(SoftpalProtoUnit {
                source_unit_key: format!("{DIALOGUE_KEY_PREFIX}{}", dialogue.text.pointer),
                pointer: dialogue.text.pointer,
                source_text: text.to_string(),
                speaker,
                surface_kind: "dialogue",
                choice_option_index: None,
            });
        }
        let mut choice_seen: BTreeSet<u32> = BTreeSet::new();
        let mut choice_option_index = 0_u64;
        for choice in &disassembly.choices {
            let Some(text) = choice.text.resolved_text() else {
                continue;
            };
            if !choice_seen.insert(choice.text.pointer) {
                continue;
            }
            units.push(SoftpalProtoUnit {
                source_unit_key: format!("{CHOICE_KEY_PREFIX}{}", choice.text.pointer),
                pointer: choice.text.pointer,
                source_text: text.to_string(),
                speaker: String::new(),
                surface_kind: "choice_label",
                choice_option_index: Some(choice_option_index),
            });
            choice_option_index += 1;
        }

        // A dangling pointer (inside the pool, off a record boundary) is a
        // decode-integrity failure; on real bytes it is 0. Surface it as a
        // warning rather than silently dropping the affected line.
        let mut warnings = Vec::new();
        let dangling = disassembly.dangling_pointer_count();
        if dangling > 0 {
            warnings.push(AdapterWarning {
                code: "kaifuu.softpal.dangling_pointers".to_string(),
                message: format!(
                    "{dangling} TEXT.DAT pointer(s) fell inside the record pool but missed a \
                     record boundary; those lines were not emitted as units"
                ),
            });
        }

        let json = assemble_softpal_bridge_json(scripts, &units);
        // Refuse to emit unvalidated product wire format.
        BridgeBundleV02::validate_json(&json).map_err(|err| -> Box<dyn std::error::Error> {
            format!("kaifuu.softpal.bridge.schema_validation: {err}").into()
        })?;
        Ok(SoftpalProducedBridge { json, warnings })
    }
}

fn assemble_softpal_bridge_json(scripts: &SoftpalScripts, units: &[SoftpalProtoUnit]) -> Value {
    let namespace =
        format!("softpal-bridge:game-id={SOFTPAL_GAME_ID}:source-profile-id={SOFTPAL_PROFILE_ID}");
    // Bundle hash covers both script surfaces the disassembly walks.
    let mut bundle_bytes = scripts.script.clone();
    bundle_bytes.extend_from_slice(&scripts.textdat);
    let source_bundle_hash = sha256_hash_bytes(&bundle_bytes);
    let bridge_id = softpal_uuid7(&namespace, "bundle");
    let bundle_revision_id = softpal_uuid7(&namespace, "bundle-revision");
    let source_profile_hash = sha256_hash_bytes(SOFTPAL_PROFILE_ID.as_bytes());
    let source_profile_revision_id = softpal_uuid7(&namespace, "source-profile-revision");

    let script_hash = sha256_hash_bytes(&scripts.script);
    let script_asset_id = softpal_uuid7(&namespace, "asset-script-src");
    let script_revision_id = softpal_uuid7(&namespace, "asset-revision-script-src");
    let textdat_hash = sha256_hash_bytes(&scripts.textdat);
    let textdat_asset_id = softpal_uuid7(&namespace, "asset-text-dat");
    let textdat_revision_id = softpal_uuid7(&namespace, "asset-revision-text-dat");

    let assets = json!([
        {
            "assetId": script_asset_id,
            "assetKey": SCRIPT_ASSET_ID,
            "assetKind": "script",
            "sourceHash": script_hash,
            "sourceRevision": {
                "revisionId": script_revision_id,
                "revisionKind": "content_hash",
                "value": script_hash,
            },
            "path": format!("{}#SCRIPT.SRC", scripts.source_ref),
        },
        {
            "assetId": textdat_asset_id,
            "assetKey": "softpal:TEXT.DAT",
            "assetKind": "text",
            "sourceHash": textdat_hash,
            "sourceRevision": {
                "revisionId": textdat_revision_id,
                "revisionKind": "content_hash",
                "value": textdat_hash,
            },
            "path": format!("{}#TEXT.DAT", scripts.source_ref),
        },
    ]);

    let units_json: Vec<Value> = units
        .iter()
        .map(|unit| {
            build_softpal_unit_json(
                &namespace,
                &textdat_asset_id,
                "softpal:TEXT.DAT",
                &textdat_revision_id,
                &textdat_hash,
                unit,
            )
        })
        .collect();

    json!({
        "schemaVersion": BRIDGE_SCHEMA_VERSION_V02,
        "bridgeId": bridge_id,
        "sourceGame": {
            "gameId": SOFTPAL_GAME_ID,
            "gameVersion": "1.0.0",
            "sourceProfileId": SOFTPAL_PROFILE_ID,
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
        "sourceLocale": "ja-JP",
        "hashStrategy": hash_strategy_json(),
        "extractor": {
            "name": "kaifuu-softpal",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "assets": assets,
        "units": units_json,
        "policyRecords": [],
    })
}

fn build_softpal_unit_json(
    namespace: &str,
    asset_id: &str,
    asset_key: &str,
    revision_id: &str,
    asset_hash: &str,
    unit: &SoftpalProtoUnit,
) -> Value {
    let source_hash = sha256_hash_bytes(unit.source_text.as_bytes());
    let bridge_unit_id = softpal_uuid7(namespace, &format!("unit-{}", unit.source_unit_key));
    let surface_id = softpal_uuid7(namespace, &format!("surface-{}", unit.source_unit_key));
    let source_location = json!({
        "containerKey": asset_key,
        "entryPath": ["textdat", "record", unit.pointer.to_string()],
        "range": {
            "startByte": u64::from(unit.pointer),
            "endByte": u64::from(unit.pointer).saturating_add(1),
        },
    });
    let route = json!({
        "sceneId": SCRIPT_SCENE_ID,
        "sceneKey": SCRIPT_ASSET_ID,
        "position": format!("pointer-{}", unit.pointer),
    });
    let context = if unit.surface_kind == "choice_label" {
        let option_index = unit.choice_option_index.unwrap_or(0);
        json!({
            "choice": {
                "choiceGroupId": softpal_uuid7(namespace, "choice-group-script-src"),
                "choiceId": softpal_uuid7(namespace, &format!("choice-{}", unit.source_unit_key)),
                "optionIndex": option_index,
                "routeTargetRef": unit.source_unit_key,
            },
            "route": route,
        })
    } else {
        json!({ "route": route })
    };
    let speaker = if unit.speaker.is_empty() {
        json!({ "knowledgeState": "not_applicable" })
    } else {
        json!({
            "knowledgeState": "parser_unknown",
            "rawSpeakerText": unit.speaker,
            "evidence": "softpal.text_show_speaker",
        })
    };
    json!({
        "bridgeUnitId": bridge_unit_id,
        "surfaceId": surface_id,
        "surfaceKind": unit.surface_kind,
        "sourceUnitKey": unit.source_unit_key,
        "occurrenceId": unit.source_unit_key,
        "sourceLocale": "ja-JP",
        "sourceText": unit.source_text,
        "sourceHash": source_hash,
        "sourceRevision": {
            "revisionId": revision_id,
            "revisionKind": "content_hash",
            "value": asset_hash,
        },
        "sourceAssetRef": { "assetId": asset_id, "assetKey": asset_key },
        "sourceLocation": source_location,
        "speaker": speaker,
        "context": context,
        "spans": [],
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
            "traceKey": format!("softpal:{}", unit.source_unit_key),
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
fn softpal_uuid7(namespace: &str, role: &str) -> String {
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

#[cfg(test)]
mod tests {
    use kaifuu_softpal::{
        SCRIPT_MAGIC_PREFIX, TEXT_SHOW_WORD_HI, TEXTDAT_FLAG_PLAINTEXT, TEXTDAT_MAGIC_TAIL,
    };

    use super::*;

    fn opcode(id: u16) -> [u8; 4] {
        let mut token = [0; 4];
        token[..2].copy_from_slice(&id.to_le_bytes());
        token[2..].copy_from_slice(&1_u16.to_le_bytes());
        token
    }

    fn word(value: u32) -> [u8; 4] {
        value.to_le_bytes()
    }

    fn target(category: u16, function: u16) -> u32 {
        (u32::from(category) << 16) | u32::from(function)
    }

    /// A minimal, decoded Softpal source pair: the script pushes the real
    /// TEXT.DAT record pointer and invokes TEXT-SHOW.  This deliberately
    /// exercises the production decoder before checking the coordinate.
    fn decoded_source_pair() -> SoftpalScripts {
        let mut textdat = vec![TEXTDAT_FLAG_PLAINTEXT];
        textdat.extend_from_slice(TEXTDAT_MAGIC_TAIL);
        textdat.extend_from_slice(&2_u32.to_le_bytes());
        let text_pointer = textdat.len() as u32;
        textdat.extend_from_slice(&0_u32.to_le_bytes());
        textdat.extend_from_slice(b"decoded line\0");
        let speaker_pointer = textdat.len() as u32;
        textdat.extend_from_slice(&1_u32.to_le_bytes());
        textdat.extend_from_slice(b"decoded speaker\0");

        let mut script = Vec::new();
        script.extend_from_slice(SCRIPT_MAGIC_PREFIX);
        script.extend_from_slice(b"20");
        script.extend_from_slice(&[0; 8]);
        for token in [
            opcode(0x1f),
            word(text_pointer),
            opcode(0x1f),
            word(speaker_pointer),
            opcode(0x1f),
            word(0),
            opcode(0x17),
            word(target(TEXT_SHOW_WORD_HI, 2)),
            word(0),
        ] {
            script.extend_from_slice(&token);
        }

        SoftpalScripts {
            script,
            textdat,
            source_ref: "decoded-test-pair".to_string(),
        }
    }

    #[test]
    fn decoded_script_units_declare_the_structure_script_scene() {
        let produced = SoftpalProfileDetectorAdapter::build_bridge(&decoded_source_pair())
            .expect("decoded Softpal fixture extracts");

        assert!(produced.warnings.is_empty());
        assert_eq!(produced.json["schemaVersion"], BRIDGE_SCHEMA_VERSION_V02);
        let units = produced.json["units"].as_array().expect("units array");
        assert_eq!(units.len(), 1);
        let unit = &units[0];
        assert_eq!(unit["sourceText"], "decoded line");
        assert_eq!(unit["sourceUnitKey"], format!("{DIALOGUE_KEY_PREFIX}16"));
        assert_eq!(
            unit["context"]["route"]["sceneId"].as_str(),
            Some(SCRIPT_SCENE_ID),
        );
    }
}
