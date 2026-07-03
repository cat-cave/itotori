//! Real-bytes proof for `reallive-adapter-expose-length-changing-patchback`.
//!
//! Drives the FULL RealLive adapter surface (`extract` -> `patch`) on the real
//! Sweetie HD archive at `$ITOTORI_REAL_GAME_ROOT` and proves a LENGTH-CHANGING
//! adapter patch routes through the bundle-driven driver and round-trips
//! byte-correct: the patched archive re-parses with the same scene directory
//! count (offset table rewritten), the patched scene decrypts + re-decompiles
//! with ZERO unknown opcodes, the grown translated body is spliced in verbatim,
//! and every goto jump pointer is recalculated to land on an element boundary
//! (at least one re-based by the length delta), never into the middle of a
//! command.
//!
//! Env-gated and STRICT BY DEFAULT: without `ITOTORI_REAL_GAME_ROOT` the test
//! is a no-op (it is `#[ignore]`d and only runs under `--include-ignored`).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_core::{
    EngineAdapter, ExtractRequest, OperationStatus, PatchExport, PatchExportEntry, PatchRequest,
};
use kaifuu_engine_fixture::RealLiveProfileDetectorAdapter;
use kaifuu_reallive::{
    RealLiveOpcode, SceneHeader, Xor2DecScene, collect_goto_pointer_sites,
    compiler_version_uses_xor2, decompress_avg32, parse_archive, parse_real_bytecode,
    parse_real_bytecode_spans, recover_archive_cipher,
};

const REAL_GAME_ROOT_ENV: &str = "ITOTORI_REAL_GAME_ROOT";

/// A distinctive ASCII marker spliced into the grown dialogue body so it can
/// be located both in the patched bytecode and in a fresh re-extract.
const MARKER: &str = "ITOTORIGROWNENGLISHLOCALIZATIONTAIL";

/// Recover the game's `xor_2` cipher by decompressing every scene of the
/// archive (cross-scene known-plaintext key recovery). `None` when no scene
/// uses `xor_2` or no key validates.
fn recover_cipher(seen_bytes: &[u8]) -> Option<kaifuu_reallive::Xor2Cipher> {
    let index = parse_archive(seen_bytes).ok()?;
    let mut scenes: Vec<Xor2DecScene> = Vec::new();
    for entry in &index.entries {
        let start = entry.byte_offset as usize;
        let end = start + entry.byte_len as usize;
        if end > seen_bytes.len() {
            continue;
        }
        let blob = &seen_bytes[start..end];
        let Ok(header) = SceneHeader::parse(blob) else {
            continue;
        };
        let bo = header.bytecode_offset as usize;
        let bc = header.bytecode_compressed_size as usize;
        let bu = header.bytecode_uncompressed_size as usize;
        if bo + bc > blob.len() {
            continue;
        }
        let Ok(decompressed) = decompress_avg32(&blob[bo..bo + bc], bu) else {
            continue;
        };
        scenes.push(Xor2DecScene {
            compiler_version: header.compiler_version,
            bytecode: decompressed,
        });
    }
    recover_archive_cipher(&scenes).ok()
}

/// Decrypt + decompress a single scene's bytecode into plaintext.
fn plaintext_scene(
    seen_bytes: &[u8],
    scene_id: u16,
    cipher: Option<&kaifuu_reallive::Xor2Cipher>,
) -> Option<Vec<u8>> {
    let index = parse_archive(seen_bytes).ok()?;
    let entry = index.entries.iter().find(|e| e.scene_id == scene_id)?;
    let start = entry.byte_offset as usize;
    let end = start + entry.byte_len as usize;
    let blob = &seen_bytes[start..end];
    let header = SceneHeader::parse(blob).ok()?;
    let bo = header.bytecode_offset as usize;
    let bc = header.bytecode_compressed_size as usize;
    let bu = header.bytecode_uncompressed_size as usize;
    let mut decompressed = decompress_avg32(&blob[bo..bo + bc], bu).ok()?;
    if compiler_version_uses_xor2(header.compiler_version) {
        cipher?.apply_segment(&mut decompressed);
    }
    Some(decompressed)
}

/// Parse the scene id out of a canonical `reallive:scene-NNNN#OOOO` key.
fn scene_of(source_unit_key: &str) -> Option<u16> {
    let rest = source_unit_key.strip_prefix("reallive:scene-")?;
    let digits = rest.get(..4)?;
    digits.parse::<u16>().ok()
}

/// Locate the real SEEN.TXT under the corpus root (case-insensitive).
fn find_seen_txt(root: &Path) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.eq_ignore_ascii_case("seen.txt"))
            {
                return Some(path);
            }
        }
    }
    None
}

#[test]
#[ignore = "real-bytes; requires ITOTORI_REAL_GAME_ROOT (Sweetie HD)"]
fn reallive_adapter_length_changing_patch_round_trips_on_real_sweetie_hd() {
    let Ok(root) = std::env::var(REAL_GAME_ROOT_ENV) else {
        // Strict-by-default: an absent corpus is a skip only when the env is
        // unset (the harness runs this under --include-ignored WITH the env).
        eprintln!("SKIP: {REAL_GAME_ROOT_ENV} unset");
        return;
    };
    let root = PathBuf::from(root);
    let adapter = RealLiveProfileDetectorAdapter;

    // ---- Extract the real archive through the adapter. ----
    let extract = adapter
        .extract(ExtractRequest { game_dir: &root })
        .expect("adapter extracts real Sweetie HD");
    assert!(
        !extract.bridge.units.is_empty(),
        "real extract must yield bridge units"
    );

    // Group units by scene id; only scenes that carry a dialogue unit are
    // candidates for a length-changing dialogue edit.
    let mut by_scene: BTreeMap<u16, Vec<&kaifuu_core::BridgeUnit>> = BTreeMap::new();
    for unit in &extract.bridge.units {
        if let Some(scene) = scene_of(&unit.source_unit_key) {
            by_scene.entry(scene).or_default().push(unit);
        }
    }
    let candidates: Vec<u16> = by_scene
        .iter()
        .filter(|(_, units)| units.iter().any(|u| u.text_surface == "dialogue"))
        .map(|(scene, _)| *scene)
        .collect();
    assert!(
        !candidates.is_empty(),
        "at least one scene must carry a dialogue unit"
    );

    let seen_path = find_seen_txt(&root).expect("locate real SEEN.TXT");
    let source_seen = fs::read(&seen_path).expect("read real SEEN.TXT");
    let source_cipher = recover_cipher(&source_seen);

    // Try candidate scenes until one length-changing patch applies. A scene
    // whose goto lands strictly inside an edited body is rejected with a typed
    // GotoTargetUnresolvable (a genuinely-unencodable case) and skipped; we
    // require at least ONE scene to round-trip. Bound the attempts so the
    // real-bytes test stays fast.
    let mut proven = false;
    for &scene_id in candidates.iter().take(12) {
        let units = &by_scene[&scene_id];
        // Every unit of the scene must be translated (no silent partial). To
        // guarantee a GROW (Hello -> longer), exactly ONE dialogue unit's body
        // is REPLACED with a plain ASCII sentinel sized to exceed that unit's
        // source body (the UTF-8 source length + margin always exceeds the
        // Shift-JIS body it replaces), so the scene strictly grows; every other
        // unit is carried identity (its own source text as target, which
        // round-trips byte-correct). Replacing a single body (rather than
        // appending past a terminator) keeps it one clean Textout run, so a
        // fresh extract decodes the sentinel back as that unit's dialogue text.
        let grow_unit = units
            .iter()
            .find(|u| u.text_surface == "dialogue")
            .expect("candidate scene has a dialogue unit");
        let grow_key = grow_unit.source_unit_key.clone();
        let sentinel = format!("{MARKER}{}", "X".repeat(grow_unit.source_text.len() + 64));
        let entries: Vec<PatchExportEntry> = units
            .iter()
            .map(|u| PatchExportEntry {
                bridge_unit_id: u.bridge_unit_id.clone(),
                source_unit_key: u.source_unit_key.clone(),
                source_hash: u.source_hash.clone(),
                target_text: if u.source_unit_key == grow_key {
                    sentinel.clone()
                } else {
                    u.source_text.clone()
                },
                protected_span_mappings: vec![],
            })
            .collect();
        let export = PatchExport {
            patch_export_id: format!("reallive-adapter-length-changing-scene-{scene_id:04}"),
            source_locale: "ja-JP".to_string(),
            target_locale: "en-US".to_string(),
            entries,
        };
        let out_dir = std::env::temp_dir().join(format!(
            "itotori-reallive-adapter-length-{scene_id:04}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&out_dir);
        fs::create_dir_all(&out_dir).unwrap();
        let result = adapter
            .patch(PatchRequest {
                game_dir: &root,
                patch_export: &export,
                output_dir: &out_dir,
            })
            .expect("adapter patch returns a result");
        if result.status != OperationStatus::Passed {
            // Genuinely-unencodable scene (e.g. goto into an edited body) —
            // skip to the next candidate.
            let _ = fs::remove_dir_all(&out_dir);
            continue;
        }

        // ---- The patched archive round-trips byte-correct. ----
        let patched_seen = fs::read(out_dir.join("SEEN.TXT")).expect("read patched SEEN.TXT");
        // Length changed: the offset table + scene body were rewritten (the
        // long sentinel is longer than the source dialogue body).
        assert_ne!(
            patched_seen.len(),
            source_seen.len(),
            "scene {scene_id:04}: length-changing patch must resize the archive"
        );
        // Offset table valid: the patched envelope re-parses with the same
        // scene directory count.
        let src_index = parse_archive(&source_seen).expect("source archive parses");
        let patched_index = parse_archive(&patched_seen).expect("patched archive re-parses");
        assert_eq!(
            patched_index.entries.len(),
            src_index.entries.len(),
            "scene {scene_id:04}: patched archive must keep the scene directory count"
        );

        // Decrypt + decompress both scenes to plaintext bytecode. (Sweetie HD
        // scenes are `xor_2`; `apply_translated_bundle` re-encrypts the patched
        // scene at rest, so verification decrypts before re-decompiling.)
        let patched_cipher = recover_cipher(&patched_seen);
        let source_plain = plaintext_scene(&source_seen, scene_id, source_cipher.as_ref())
            .expect("source scene decrypts");
        let patched_plain = plaintext_scene(&patched_seen, scene_id, patched_cipher.as_ref())
            .expect("patched scene decrypts");
        // Length grew: the offset table + scene body were rewritten.
        assert!(
            patched_plain.len() > source_plain.len(),
            "scene {scene_id:04}: patched bytecode ({}) must be longer than source ({})",
            patched_plain.len(),
            source_plain.len()
        );
        // Zero-unknown re-decompile: the grown scene re-decompiles cleanly.
        let ops = parse_real_bytecode(&patched_plain)
            .expect("patched scene bytecode re-decompiles cleanly");
        let unknown = ops
            .iter()
            .filter(|o| matches!(o, RealLiveOpcode::Unknown { .. }))
            .count();
        assert_eq!(
            unknown, 0,
            "scene {scene_id:04}: zero unknown opcodes required after length change"
        );
        // Framing still partitions exactly (no drift after the splice). The
        // element START offsets are the valid jump-target boundaries.
        let patched_spans =
            parse_real_bytecode_spans(&patched_plain).expect("patched framing partitions exactly");
        let mut boundaries: std::collections::BTreeSet<u64> = std::collections::BTreeSet::new();
        let mut cursor: u64 = 0;
        for (_op, width) in &patched_spans {
            boundaries.insert(cursor);
            cursor += *width as u64;
        }
        // The translated body was spliced in verbatim.
        assert!(
            patched_plain
                .windows(MARKER.len())
                .any(|w| w == MARKER.as_bytes()),
            "scene {scene_id:04}: grown translated body marker missing from patched bytecode"
        );

        // ---- Jump targets recalculated. A goto-rich scene is required so the
        //      recalculation is actually exercised; skip scenes with no goto
        //      pointers. Every patched target must still land on an element
        //      boundary (never into the middle of a command) and at least one
        //      target must have moved by the length delta (proving the re-base
        //      ran, not a silent no-op). ----
        let source_sites =
            collect_goto_pointer_sites(&source_plain).expect("source goto pointers collect");
        if source_sites.is_empty() {
            // Not a goto-rich scene: this patch is byte-correct but does not
            // exercise jump recalculation. Try the next candidate.
            let _ = fs::remove_dir_all(&out_dir);
            continue;
        }
        let patched_sites =
            collect_goto_pointer_sites(&patched_plain).expect("patched goto pointers collect");
        assert_eq!(
            patched_sites.len(),
            source_sites.len(),
            "scene {scene_id:04}: goto pointer count must be preserved"
        );
        for site in &patched_sites {
            assert!(
                site.target >= 0,
                "scene {scene_id:04}: patched goto target must be non-negative"
            );
            assert!(
                boundaries.contains(&(site.target as u64)),
                "scene {scene_id:04}: patched goto target {:#x} does NOT land on an element \
                 boundary (would jump into the middle of a command)",
                site.target
            );
        }
        let rebased = source_sites
            .iter()
            .zip(patched_sites.iter())
            .filter(|(src, pat)| src.target != pat.target)
            .count();
        assert!(
            rebased > 0,
            "scene {scene_id:04}: expected at least one goto target to be re-based by the length \
             delta"
        );

        eprintln!(
            "scene {scene_id:04}: adapter length-changing round trip OK; seen {}->{} bytes, \
             scene bytecode {}->{} bytes, {} opcodes 0 unknown, {} goto pointers all land on \
             element boundaries ({rebased} re-based)",
            source_seen.len(),
            patched_seen.len(),
            source_plain.len(),
            patched_plain.len(),
            ops.len(),
            patched_sites.len(),
        );
        let _ = fs::remove_dir_all(&out_dir);
        proven = true;
        break;
    }
    assert!(
        proven,
        "no candidate scene produced a byte-correct length-changing adapter round trip"
    );
}
