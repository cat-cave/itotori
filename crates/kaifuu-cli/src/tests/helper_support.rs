fn temp_game(root: &Path) -> PathBuf {
    let game_dir = root.join("game");
    fs::create_dir_all(&game_dir).unwrap();
    fs::write(
        game_dir.join("source.json"),
        r#"{
  "gameId": "hello-fixture",
  "title": "Hello Fixture",
  "sourceLocale": "ja-JP",
  "units": [
    {
      "sourceUnitKey": "hello.scene.001.line.001",
      "speaker": "Narrator",
      "textSurface": "dialogue",
      "sourceText": "こんにちは、{player}。",
      "protectedSpans": [
        {
          "kind": "placeholder",
          "raw": "{player}",
          "start": 6,
          "end": 14
        }
      ]
    }
  ]
}
"#,
    )
    .unwrap();
    game_dir
}

fn public_fixture_dir() -> PathBuf {
    test_manifest_dir().join("../../fixtures/hello-game")
}

fn native_source_patch_export() -> serde_json::Value {
    let fixture_dir = public_fixture_dir();
    let native_source_hashes: serde_json::Value =
        read_json(&fixture_dir.join("expected/native-source-hashes-v0.2.json")).unwrap();
    let hashes: BTreeMap<_, _> = native_source_hashes["sourceHashes"]
        .as_array()
        .expect("native source hash fixture sourceHashes")
        .iter()
        .map(|entry| {
            (
                entry["sourceUnitKey"]
                    .as_str()
                    .expect("native source hash fixture sourceUnitKey"),
                entry["sourceHash"]
                    .as_str()
                    .expect("native source hash fixture sourceHash"),
            )
        })
        .collect();
    let mut patch_export: serde_json::Value =
        read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
    for entry in patch_export["entries"]
        .as_array_mut()
        .expect("public patch entries")
    {
        let source_unit_key = entry["sourceUnitKey"]
            .as_str()
            .expect("public patch sourceUnitKey");
        entry["sourceHash"] = serde_json::Value::String(
            hashes
                .get(source_unit_key)
                .expect("native source hash for each patch entry")
                .to_string(),
        );
    }
    patch_export
}

fn native_source_hash_mismatch_patch_export() -> serde_json::Value {
    let fixture_dir = public_fixture_dir();
    let mismatch: serde_json::Value =
        read_json(&fixture_dir.join("expected/native-source-hash-mismatch-v0.2.json")).unwrap();
    let source_unit_key = mismatch["sourceUnitKey"]
        .as_str()
        .expect("native source hash mismatch sourceUnitKey");
    let mut patch_export = native_source_patch_export();
    let entry = patch_export["entries"]
        .as_array_mut()
        .expect("public patch entries")
        .iter_mut()
        .find(|entry| entry["sourceUnitKey"].as_str() == Some(source_unit_key))
        .expect("mismatched source unit in public patch");
    entry["sourceHash"] = mismatch["sourceHash"].clone();
    patch_export
}

fn public_fixture_path(relative_path: &str) -> PathBuf {
    test_manifest_dir().join("../..").join(relative_path)
}

fn core_fixture_path(relative_path: &str) -> PathBuf {
    test_manifest_dir()
        .join("../kaifuu-core")
        .join(relative_path)
}

fn write_fixture_file(root: &Path, relative_path: &str, bytes: &[u8]) {
    let path = root.join(relative_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, bytes).unwrap();
}

#[derive(Clone, Copy)]
struct Xp3TestEntry<'a> {
    path: &'a str,
    payload: &'a [u8],
    compressed: bool,
    adler32: u32,
}

fn plain_xp3_fixture(entries: &[Xp3TestEntry<'_>]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(XP3_PLAIN_MAGIC);
    bytes.extend_from_slice(&0_u64.to_le_bytes());

    let mut segment_offsets = Vec::new();
    for entry in entries {
        segment_offsets.push(bytes.len() as u64);
        bytes.extend_from_slice(entry.payload);
    }

    let index_offset = bytes.len() as u64;
    let mut index = Vec::new();
    for (entry, offset) in entries.iter().zip(segment_offsets) {
        let mut file = Vec::new();
        let path_units = entry.path.encode_utf16().collect::<Vec<_>>();
        let mut info = Vec::new();
        info.extend_from_slice(&0_u32.to_le_bytes());
        info.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
        info.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
        info.extend_from_slice(&(path_units.len() as u16).to_le_bytes());
        for unit in path_units {
            info.extend_from_slice(&unit.to_le_bytes());
        }
        append_xp3_chunk(&mut file, b"info", &info);

        let mut segment = Vec::new();
        segment.extend_from_slice(&(u32::from(entry.compressed)).to_le_bytes());
        segment.extend_from_slice(&offset.to_le_bytes());
        segment.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
        segment.extend_from_slice(&(entry.payload.len() as u64).to_le_bytes());
        append_xp3_chunk(&mut file, b"segm", &segment);
        append_xp3_chunk(&mut file, b"adlr", &entry.adler32.to_le_bytes());
        append_xp3_chunk(&mut index, b"File", &file);
    }

    bytes.push(0);
    bytes.extend_from_slice(&(index.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&index);
    bytes[XP3_PLAIN_MAGIC.len()..XP3_PLAIN_MAGIC.len() + 8]
        .copy_from_slice(&index_offset.to_le_bytes());
    bytes
}

fn append_xp3_chunk(output: &mut Vec<u8>, name: &[u8; 4], content: &[u8]) {
    output.extend_from_slice(name);
    output.extend_from_slice(&(content.len() as u64).to_le_bytes());
    output.extend_from_slice(content);
}

fn run_cli(args: &[&str]) {
    run_with_args(args.iter().map(std::string::ToString::to_string).collect()).unwrap();
}

fn run_cli_with_registry(args: &[&str], registry: &AdapterRegistry) {
    run_cli_with_registry_result(args, registry).unwrap();
}

fn run_cli_with_registry_result(
    args: &[&str],
    registry: &AdapterRegistry,
) -> Result<(), Box<dyn std::error::Error>> {
    run_with_args_and_registry(
        args.iter().map(std::string::ToString::to_string).collect(),
        registry,
    )
}
