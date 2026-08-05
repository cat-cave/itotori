use super::*;

#[test]
fn reallive_adapter_extract_emits_bridge_bundle_with_scene_dialogue_units() {
    let dir = reallive_adapter_fixture_dir("reallive-adapter-extract-bridge-bundle");
    let seen = fs::read(dir.join(REALLIVE_SEEN_TXT_PATH)).unwrap();
    let result = RealLiveProfileDetectorAdapter
        .extract(ExtractRequest { game_dir: &dir })
        .unwrap();
    assert_eq!(result.adapter_id, REALLIVE_DETECTOR_ADAPTER_ID);
    assert_eq!(
        result.bridge["schemaVersion"].as_str(),
        Some("0.2.0"),
        "adapter extract must emit BridgeBundleV02"
    );
    let units = result.bridge["units"].as_array().expect("units array");
    assert!(!units.is_empty());
    let surfaces: BTreeSet<_> = units
        .iter()
        .filter_map(|u| u["surfaceKind"].as_str())
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
    let dialogue = units
        .iter()
        .find(|u| u["surfaceKind"].as_str() == Some("dialogue"))
        .expect("dialogue unit present");
    assert_eq!(dialogue["sourceText"], "Hello");
    assert_eq!(dialogue["sourceUnitKey"], "reallive:scene-0001#0000");
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
    let dialogue = result.bridge["units"]
        .as_array()
        .expect("units")
        .iter()
        .find(|unit| unit["sourceUnitKey"].as_str() == Some("reallive:scene-0001#0000"))
        .expect("xor2-decrypted dialogue unit present");
    assert_eq!(
        dialogue["sourceText"], "Hello",
        "produce_scene_bundles must decrypt xor2 before bridge production"
    );
    assert_eq!(
        fs::read(dir.join(REALLIVE_SEEN_TXT_PATH)).unwrap(),
        seen,
        "extract must not mutate a validated xor2 source archive"
    );
    let _ = fs::remove_dir_all(dir);
}
