use super::*;

#[test]
fn reallive_adapter_extract_emits_bridge_bundle_with_scene_dialogue_units() {
    let dir = reallive_adapter_fixture_dir("reallive-adapter-extract-bridge-bundle");
    let seen = fs::read(dir.join(REALLIVE_SEEN_TXT_PATH)).unwrap();
    let result = RealLiveProfileDetectorAdapter
        .extract(ExtractRequest { game_dir: &dir })
        .unwrap();
    assert_eq!(result.adapter_id, REALLIVE_DETECTOR_ADAPTER_ID);
    assert!(!result.bridge.units.is_empty());
    let surfaces: BTreeSet<_> = result
        .bridge
        .units
        .iter()
        .map(|u| u.text_surface.clone())
        .collect();
    // Adapter-unify: extract now shares `patch`'s produce_bundle path, so
    // the emitted surfaces are exactly `produce_bundle`'s v0.2
    // `surfaceKind`s — `dialogue` and `choice_label`. The former
    // `speaker_name` surface is gone: a speaker is embedded on the
    // dialogue unit's `speaker` field (NAMAE-resolved), not minted as a
    // standalone translatable unit.
    assert!(surfaces.contains("dialogue"));
    assert!(surfaces.contains("choice_label"));
    // Deterministic source-unit keys (produce_bundle scheme), NOT the
    // former random-UUID inventory ids — this is what lets a PatchExport
    // keyed on extract's ids resolve during patch.
    let dialogue = result
        .bridge
        .units
        .iter()
        .find(|u| u.text_surface == "dialogue")
        .expect("dialogue unit present");
    assert_eq!(dialogue.source_text, "Hello");
    assert_eq!(dialogue.source_unit_key, "reallive:scene-0001#0000");
    assert_eq!(
        fs::read(dir.join(REALLIVE_SEEN_TXT_PATH)).unwrap(),
        seen,
        "extract must not mutate an archive without xor2 scenes"
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn reallive_adapter_extract_decrypts_xor2_before_producing_scene_bundles() {
    let dir = reallive_xor2_fixture_dir("reallive-adapter-extract-xor2");
    let seen = fs::read(dir.join(REALLIVE_SEEN_TXT_PATH)).unwrap();
    let index = kaifuu_reallive::parse_archive(&seen).expect("xor2 fixture archive parses");
    let first = index
        .entries
        .iter()
        .find(|entry| entry.scene_id == 1)
        .expect("scene 1 present");
    let blob =
        &seen[first.byte_offset as usize..(first.byte_offset + u64::from(first.byte_len)) as usize];
    let header = kaifuu_reallive::SceneHeader::parse(blob).expect("scene header parses");
    let start = header.bytecode_offset as usize;
    let end = start + header.bytecode_compressed_size as usize;
    let stored = kaifuu_reallive::decompress_avg32(
        &blob[start..end],
        header.bytecode_uncompressed_size as usize,
    )
    .expect("stored xor2 bytecode decompresses");
    assert!(
        !stored.windows(5).any(|window| window == b"Hello"),
        "fixture must store the text inside the encrypted xor2 segment"
    );

    let result = RealLiveProfileDetectorAdapter
        .extract(ExtractRequest { game_dir: &dir })
        .unwrap();
    let dialogue = result
        .bridge
        .units
        .iter()
        .find(|unit| unit.source_unit_key == "reallive:scene-0001#0000")
        .expect("xor2-decrypted dialogue unit present");
    assert_eq!(
        dialogue.source_text, "Hello",
        "produce_scene_bundles must decrypt xor2 before bridge production"
    );
    assert_eq!(
        fs::read(dir.join(REALLIVE_SEEN_TXT_PATH)).unwrap(),
        seen,
        "extract must not mutate a validated xor2 source archive"
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn reallive_adapter_refuses_unvalidated_xor2_before_extract_or_patch_writes() {
    let dir = temp_dir("reallive-adapter-xor2-validation-failure");
    fs::write(
        dir.join(REALLIVE_SEEN_TXT_PATH),
        xor2_adapter_seen_txt_with_scene_len(200),
    )
    .unwrap();
    fs::write(dir.join(REALLIVE_GAMEEXE_INI_PATH), synthetic_gameexe_ini()).unwrap();
    let export = PatchExport {
        patch_export_id: "kaifuu-reallive-xor2-validation".to_string(),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![],
    };

    let extract_error = RealLiveProfileDetectorAdapter
        .extract(ExtractRequest { game_dir: &dir })
        .unwrap_err()
        .to_string();
    let expected = json!({
        "errorCode": "kaifuu.key_validation_failed",
        "adapter": REALLIVE_DETECTOR_ADAPTER_ID,
        "engine": "reallive",
        "detectedVariant": null,
        "assetRef": REALLIVE_XOR2_VALIDATION_ASSET_REF,
        "requiredCapability": "crypto_access",
        "supportBoundary": "kaifuu.reallive.xor2.validation_failed",
        "remediation": "retry only after validation",
    });
    assert_eq!(
        serde_json::from_str::<Value>(&extract_error).unwrap(),
        expected
    );
    assert!(
        !extract_error.contains("candidate")
            && !extract_error.contains("Hello")
            && !extract_error.contains(dir.to_string_lossy().as_ref()),
        "validation failure must not expose recovery findings, raw bytes, or game paths"
    );

    let preflight_error = RealLiveProfileDetectorAdapter
        .patch_preflight(PatchPreflightRequest {
            game_dir: &dir,
            patch_export: &export,
        })
        .unwrap_err()
        .to_string();
    assert_eq!(preflight_error, extract_error);

    let output_dir = temp_dir("reallive-adapter-xor2-validation-failure-output");
    let patch_error = RealLiveProfileDetectorAdapter
        .patch(PatchRequest {
            game_dir: &dir,
            patch_export: &export,
            output_dir: &output_dir,
        })
        .unwrap_err()
        .to_string();
    assert_eq!(patch_error, extract_error);
    assert!(
        !output_dir.join(REALLIVE_SEEN_TXT_PATH).exists(),
        "patch must fail before it writes output"
    );
    let _ = fs::remove_dir_all(dir);
    let _ = fs::remove_dir_all(output_dir);
}

#[test]
fn reallive_adapter_patch_round_trips_unchanged_archive_byte_for_byte() {
    let dir = reallive_adapter_fixture_dir("reallive-adapter-patch-identity");
    let export = PatchExport {
        patch_export_id: "kaifuu-reallive-empty-export".to_string(),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![],
    };
    let output_dir = temp_dir("reallive-adapter-patch-identity-out");
    let result = RealLiveProfileDetectorAdapter
        .patch(PatchRequest {
            game_dir: &dir,
            patch_export: &export,
            output_dir: &output_dir,
        })
        .unwrap();
    assert_eq!(result.status, OperationStatus::Passed);
    let patched = fs::read(output_dir.join(REALLIVE_SEEN_TXT_PATH)).unwrap();
    let original = fs::read(dir.join(REALLIVE_SEEN_TXT_PATH)).unwrap();
    assert_eq!(patched, original);
    let _ = fs::remove_dir_all(dir);
    let _ = fs::remove_dir_all(output_dir);
}
