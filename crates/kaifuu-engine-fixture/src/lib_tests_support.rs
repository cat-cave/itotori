use super::*;

pub(super) fn repo_root() -> std::path::PathBuf {
    crate::test_manifest_dir().join("../..")
}

pub(super) fn public_fixture_dir() -> std::path::PathBuf {
    repo_root().join("fixtures/hello-game")
}

pub(super) fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "kaifuu-engine-fixture-{name}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

pub(super) fn temp_game(name: &str) -> std::path::PathBuf {
    let dir = temp_dir(name);
    fs::write(
        dir.join("source.json"),
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
    dir
}

pub(super) fn hello_fixture_dir() -> PathBuf {
    crate::test_manifest_dir().join("../../fixtures/hello-game")
}

pub(super) fn expected_asset_inventory_path() -> PathBuf {
    hello_fixture_dir().join("asset-inventory.expected.json")
}

pub(super) fn native_source_hashes_fixture() -> BTreeMap<String, String> {
    let fixture: Value =
        read_json(&public_fixture_dir().join("expected/native-source-hashes-v0.2.json")).unwrap();
    fixture["sourceHashes"]
        .as_array()
        .expect("native source hash fixture sourceHashes")
        .iter()
        .map(|entry| {
            (
                entry["sourceUnitKey"]
                    .as_str()
                    .expect("native source hash fixture sourceUnitKey")
                    .to_string(),
                entry["sourceHash"]
                    .as_str()
                    .expect("native source hash fixture sourceHash")
                    .to_string(),
            )
        })
        .collect()
}

pub(super) fn native_source_patch_fixture() -> Value {
    let fixture_dir = public_fixture_dir();
    let source_hashes = native_source_hashes_fixture();
    let mut patch_export: Value =
        read_json(&fixture_dir.join("expected/patch-export-v0.2.fr-FR.json")).unwrap();
    for entry in patch_export["entries"]
        .as_array_mut()
        .expect("public patch entries")
    {
        let source_unit_key = entry["sourceUnitKey"]
            .as_str()
            .expect("public patch sourceUnitKey");
        entry["sourceHash"] = Value::String(
            source_hashes
                .get(source_unit_key)
                .expect("native source hash for each patch entry")
                .clone(),
        );
    }
    patch_export
}

pub(super) fn native_source_bridge_fixture() -> Value {
    let fixture_dir = public_fixture_dir();
    let source_hashes = native_source_hashes_fixture();
    let mut bridge: Value = read_json(&fixture_dir.join("expected/bridge-v0.2.json")).unwrap();
    for unit in bridge["units"].as_array_mut().expect("public bridge units") {
        let source_unit_key = unit["sourceUnitKey"]
            .as_str()
            .expect("public bridge sourceUnitKey");
        unit["sourceHash"] = Value::String(
            source_hashes
                .get(source_unit_key)
                .expect("native source hash for each bridge unit")
                .clone(),
        );
    }
    bridge
}

pub(super) fn native_source_hash_mismatch_patch_fixture() -> Value {
    let fixture_dir = public_fixture_dir();
    let mismatch: Value =
        read_json(&fixture_dir.join("expected/native-source-hash-mismatch-v0.2.json")).unwrap();
    let source_unit_key = mismatch["sourceUnitKey"]
        .as_str()
        .expect("native source hash mismatch sourceUnitKey");
    let mut patch_export = native_source_patch_fixture();
    let entry = patch_export["entries"]
        .as_array_mut()
        .expect("public patch entries")
        .iter_mut()
        .find(|entry| entry["sourceUnitKey"].as_str() == Some(source_unit_key))
        .expect("mismatched source unit in public patch");
    entry["sourceHash"] = mismatch["sourceHash"].clone();
    patch_export
}

pub(super) fn patch_export_for(extraction: &ExtractionResult) -> PatchExport {
    let target_text = "Hello, {player}.".to_string();
    PatchExport {
        patch_export_id: deterministic_id("patch", 1),
        source_locale: "ja-JP".to_string(),
        target_locale: "en-US".to_string(),
        entries: vec![kaifuu_core::PatchExportEntry {
            bridge_unit_id: extraction.bridge.units[0].bridge_unit_id.clone(),
            source_unit_key: extraction.bridge.units[0].source_unit_key.clone(),
            source_hash: extraction.bridge.units[0].source_hash.clone(),
            protected_span_mappings: protected_span_mappings_for_target(
                &target_text,
                &extraction.bridge.units[0].protected_spans,
            ),
            target_text,
        }],
    }
}

pub(super) fn protected_span_mappings_for_target(
    target_text: &str,
    protected_spans: &[ProtectedSpan],
) -> Vec<ProtectedSpanMapping> {
    let mut search_start = 0;
    protected_spans
        .iter()
        .filter(|span| !span.raw.is_empty())
        .map(|span| {
            let relative_start = target_text[search_start..]
                .find(&span.raw)
                .unwrap_or_else(|| panic!("target text should contain {:?}", span.raw));
            let target_start = search_start + relative_start;
            let target_end = target_start + span.raw.len();
            search_start = target_end;
            ProtectedSpanMapping::new(&span.raw, target_start as u64, target_end as u64)
                .with_source_identity(span.span_id.clone(), span.start, span.end)
        })
        .collect()
}

// Synthetic fixtures carry only the fixed Softpal FORMAT signatures (the
// same magics any Softpal title exposes); no copyrighted content bytes are
// embedded or committed. The real two-title validation lives behind an
// env-gated `#[ignore]` integration test (see
// `tests/live_softpal_detector_test.rs`).

// Build a synthetic Softpal `.pac`: `PAC ` magic, a sane entry count, then
// a header/table region naming `SCRIPT.SRC` and `TEXT.DAT` (as the real
// `data.pac` file table does).
pub(super) fn synthetic_softpal_pac(with_scripts: bool) -> Vec<u8> {
    let mut pac = Vec::new();
    pac.extend_from_slice(b"PAC "); // magic 50 41 43 20
    pac.extend_from_slice(&[0u8; 4]); // reserved
    pac.extend_from_slice(&2u32.to_le_bytes()); // entry count @ offset 8
    pac.extend_from_slice(&[0u8; 32]); // header padding
    if with_scripts {
        pac.extend_from_slice(b"SCRIPT.SRC\0\0\0\0\0\0");
        pac.extend_from_slice(&[0u8; 8]);
        pac.extend_from_slice(b"TEXT.DAT\0\0\0\0\0\0\0\0");
        pac.extend_from_slice(&[0u8; 16]);
    } else {
        // Some other, non-Softpal-script entry names.
        pac.extend_from_slice(b"IMAGE00.PNG\0\0\0\0\0");
        pac.extend_from_slice(&[0u8; 16]);
    }
    pac
}

pub(super) fn detect_softpal(dir: &Path) -> DetectionResult {
    SoftpalProfileDetectorAdapter
        .detect(DetectRequest { game_dir: dir })
        .unwrap()
}

pub(super) fn siglus_fixture_dir(
    name: &str,
    scene: Option<&[u8]>,
    gameexe: Option<&[u8]>,
) -> PathBuf {
    let dir = temp_dir(name);
    if let Some(scene) = scene {
        fs::write(dir.join(SIGLUS_SCENE_PATH), scene).unwrap();
    }
    if let Some(gameexe) = gameexe {
        fs::write(dir.join(SIGLUS_GAMEEXE_PATH), gameexe).unwrap();
    }
    dir
}

// Build a REALISTIC (non-synthetic) Siglus `Scene.pck` bearing the real
// archive-header signature: `header_size` dword `0x5C`, a second dword
// equal to the header size, then `ascending_offsets` `(offset, count)`
// index-section pairs whose offsets ascend and stay in bounds, followed by
// a body large enough to keep every offset valid. Contains NO copyrighted
// bytes — only the structural signature shape observed on real titles.
pub(super) fn realistic_real_scene_pck(ascending_offsets: usize) -> Vec<u8> {
    let header_size: u32 = 0x5C;
    let dword_count = (header_size / 4) as usize; // 23 dwords in the header
    let mut header = vec![0u32; dword_count];
    header[0] = header_size;
    let mut offset = header_size;
    let mut produced = 0usize;
    let mut idx = 1usize;
    while idx + 1 < dword_count && produced < ascending_offsets {
        header[idx] = offset; // ascending index-section offset
        header[idx + 1] = 7; // arbitrary index-section count
        offset += 0x100;
        produced += 1;
        idx += 2;
    }
    let body_len = offset as usize + 0x100;
    let mut bytes = Vec::with_capacity(body_len);
    for value in &header {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes.resize(body_len, 0);
    bytes
}

// Build a REALISTIC (non-synthetic) Siglus `Gameexe.dat`: the plaintext
// 8-byte prefix (zero dword + `1` version dword) then a maximum-entropy
// body standing in for the encrypted payload (every byte value 0..=255
// appears equally → 8.0 bits/byte). No copyrighted bytes.
pub(super) fn realistic_real_gameexe_dat() -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&1u32.to_le_bytes());
    for i in 0..4096usize {
        bytes.push((i % 256) as u8);
    }
    bytes
}

pub(super) fn adapter_failure_from_error(error: Box<dyn std::error::Error>) -> AdapterFailure {
    serde_json::from_str(&error.to_string()).unwrap()
}

pub(super) fn xp3_fixture_dir(name: &str, archive: &[u8]) -> PathBuf {
    let dir = temp_dir(name);
    fs::write(dir.join(XP3_ARCHIVE_PATH), archive).unwrap();
    dir
}

#[derive(Clone, Copy)]
pub(super) struct Xp3TestEntry<'a> {
    pub(super) path: &'a str,
    pub(super) payload: &'a [u8],
    pub(super) compressed: bool,
    pub(super) adler32: u32,
}

pub(super) fn plain_xp3_fixture(entries: &[Xp3TestEntry<'_>]) -> Vec<u8> {
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

pub(super) fn append_xp3_chunk(output: &mut Vec<u8>, name: &[u8; 4], content: &[u8]) {
    output.extend_from_slice(name);
    output.extend_from_slice(&(content.len() as u64).to_le_bytes());
    output.extend_from_slice(content);
}
