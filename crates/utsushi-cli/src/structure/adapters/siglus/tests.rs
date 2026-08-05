use std::collections::{BTreeMap, BTreeSet};
use std::fs;

use kaifuu_core::BridgeBundleV02;
use serde_json::{Value, json};
use tempfile::TempDir;

use super::*;

#[test]
fn game_root_prefers_a_keyed_triad_over_a_shallow_pair() {
    let root = TempDir::new().expect("temporary game root");
    fs::write(root.path().join("Scene.pck"), []).expect("write incomplete scene container");
    fs::write(root.path().join("Gameexe.dat"), []).expect("write incomplete gameexe container");
    let game_root = root.path().join("staging").join("fixture-root");
    fs::create_dir_all(&game_root).expect("create nested game root");
    let scene = game_root.join("Scene.pck");
    let gameexe = game_root.join("Gameexe.dat");
    fs::write(&scene, []).expect("write scene container");
    fs::write(&gameexe, []).expect("write gameexe container");
    fs::write(game_root.join("SiglusEngine.exe"), []).expect("write engine executable");

    let (resolved_scene, resolved_gameexe) =
        siglus_paths(root.path()).expect("root derives Siglus asset paths");

    assert_eq!(resolved_scene, scene);
    assert_eq!(resolved_gameexe, gameexe);
}

#[test]
fn game_root_reports_the_engine_and_missing_format_asset() {
    let root = TempDir::new().expect("temporary game root");
    let error =
        siglus_paths(root.path()).expect_err("Siglus root without its containers must fail");

    assert_eq!(
        error.to_string(),
        format!(
            "utsushi.structure.siglus.game_root: {} is missing required Scene.pck",
            root.path().display()
        )
    );
}

#[test]
fn bridge_selection_binds_assets_and_source_unit_keys() {
    let selection =
        bridge_selection(&valid_bridge(), &directory()).expect("bridge is Siglus-scoped");

    assert_eq!(selection.scene_ids, BTreeSet::from([1]));
}

#[test]
fn bridge_selection_names_engine_and_invalid_unit_key() {
    let mut wrong_engine = valid_bridge();
    wrong_engine.extractor.name = "other-extractor".to_string();
    let error = bridge_selection(&wrong_engine, &directory()).expect_err("engine must match");
    assert_eq!(
        error.to_string(),
        "utsushi.structure.siglus.bridge.extractor.name: must equal \"kaifuu-siglus-bridge\", got \"other-extractor\""
    );

    let mut wrong_key = valid_bridge();
    wrong_key.units[0].source_unit_key = "siglus:scene-scene-0001#not-a-number".to_string();
    let error = bridge_selection(&wrong_key, &directory()).expect_err("key must be format-scoped");
    assert_eq!(
        error.to_string(),
        "utsushi.structure.siglus.bridge.units[0].sourceUnitKey: must be siglus:scene-<packed-name>#<decimal-offset>"
    );
}

#[test]
fn partial_selection_filters_structure_and_full_selection_is_unchanged() {
    let full = structure(&[0, 1]);
    let partial = BridgeSelection {
        scene_ids: BTreeSet::from([1]),
    };
    let filtered = filter_structure_to_bridge(full.clone(), &partial).expect("filter structure");

    assert_eq!(filtered["entryScene"], "siglus:scene-0001");
    assert_eq!(filtered["sceneDispatchOrder"], json!(["siglus:scene-0001"]));
    assert_eq!(filtered["scenes"].as_array().map(Vec::len), Some(1));
    assert_eq!(filtered["scenes"][0]["sceneId"], "siglus:scene-0001");

    let complete = BridgeSelection {
        scene_ids: BTreeSet::from([0, 1]),
    };
    assert_eq!(
        filter_structure_to_bridge(full.clone(), &complete).expect("full bridge"),
        full
    );
}

fn directory() -> SceneDirectory {
    let mut scene_ids_by_asset_key = BTreeMap::new();
    let mut source_hashes_by_asset_key = BTreeMap::new();
    for (name, id) in [("scene-0000", 0), ("scene-0001", 1)] {
        let key = format!("siglus:scene-{name}");
        scene_ids_by_asset_key.insert(key.clone(), id);
        source_hashes_by_asset_key.insert(key, hash('b'));
    }
    SceneDirectory {
        source_bundle_hash: hash('a'),
        scene_ids_by_asset_key,
        source_hashes_by_asset_key,
    }
}

fn valid_bridge() -> BridgeBundleV02 {
    let bundle_hash = hash('a');
    let asset_hash = hash('b');
    let source_hash = hash('c');
    let asset_id = "019ed012-0000-7000-8000-000000000004";
    let asset_revision_id = "019ed012-0000-7000-8000-000000000005";
    let source_key = "siglus:scene-scene-0001#42";
    let asset_key = "siglus:scene-scene-0001";
    let value = json!({
        "schemaVersion": "0.2.0",
        "bridgeId": "019ed012-0000-7000-8000-000000000001",
        "sourceGame": {
            "gameId": "fixture",
            "gameVersion": "1",
            "sourceProfileId": "fixture-profile",
            "sourceProfileRevision": revision("019ed012-0000-7000-8000-000000000002", &source_hash),
        },
        "sourceBundleHash": bundle_hash,
        "sourceBundleRevision": revision("019ed012-0000-7000-8000-000000000003", &bundle_hash),
        "sourceLocale": "ja-JP",
        "hashStrategy": hash_strategy(),
        "extractor": { "name": "kaifuu-siglus-bridge", "version": "0" },
        "assets": [{
            "assetId": asset_id,
            "assetKey": asset_key,
            "assetKind": "script",
            "sourceHash": asset_hash,
            "sourceRevision": revision(asset_revision_id, &asset_hash),
            "path": "Scene.pck#scene-0001",
        }],
        "units": [{
            "bridgeUnitId": "019ed012-0000-7000-8000-000000000006",
            "surfaceId": "019ed012-0000-7000-8000-000000000007",
            "surfaceKind": "dialogue",
            "sourceUnitKey": source_key,
            "occurrenceId": "occurrence-1",
            "sourceLocale": "ja-JP",
            "sourceText": "sample",
            "sourceHash": source_hash,
            "sourceRevision": revision(asset_revision_id, &asset_hash),
            "sourceAssetRef": { "assetId": asset_id, "assetKey": asset_key },
            "sourceLocation": {
                "containerKey": asset_key,
                "range": { "startByte": 0, "endByte": 6 },
            },
            "context": {
                "route": {
                    "sceneId": "siglus:scene-0001",
                    "sceneKey": asset_key,
                    "position": "command-42",
                },
            },
            "spans": [],
            "patchRef": {
                "assetId": asset_id,
                "writeMode": "replace",
                "sourceUnitKey": source_key,
                "sourceRevision": revision(asset_revision_id, &asset_hash),
            },
            "runtimeExpectation": { "expectationKind": "trace_text", "traceKey": "siglus:scene-0001:42" },
        }],
        "policyRecords": [],
    });
    BridgeBundleV02::validate_json(&value).expect("valid v0.2 bridge")
}

fn structure(ids: &[u32]) -> Value {
    let scene_ids = ids
        .iter()
        .map(|id| format!("siglus:scene-{id:04}"))
        .collect::<Vec<_>>();
    json!({
        "schemaVersion": "utsushi.narrative-structure.v1",
        "engine": "siglus",
        "entryScene": scene_ids[0],
        "sceneDispatchOrder": scene_ids,
        "scenes": ids.iter().map(|id| json!({
            "sceneId": format!("siglus:scene-{id:04}"),
            "messages": [],
            "choices": [],
        })).collect::<Vec<_>>(),
    })
}

fn hash(character: char) -> String {
    format!("sha256:{}", character.to_string().repeat(64))
}

fn revision(id: &str, value: &str) -> Value {
    json!({ "revisionId": id, "revisionKind": "content_hash", "value": value })
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
