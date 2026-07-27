//! Env-gated evidence for RealLive's standalone scene-override convention.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_reallive::{
    RealLiveOpcode, SceneHeader, decode_dialogue_textout, decompress_avg32, parse_archive,
    parse_real_bytecode, parse_scene_override_file_name,
};

const SECOND_CORPUS_ENV: &str = "ITOTORI_REAL_GAME_ROOT_2";

#[test]
fn reports_when_effective_scene_bytes_contain_no_extractable_prose() {
    let Some(data_dir) = second_corpus_data_dir() else {
        eprintln!(
            "SKIP override-scene prose evidence: {SECOND_CORPUS_ENV} is unset or has no RealLive data directory"
        );
        return;
    };
    let seen_path = find_child_ci(&data_dir, "seen.txt").expect("SEEN.TXT present");
    let seen = fs::read(seen_path).expect("SEEN.TXT readable");
    let index = parse_archive(&seen).expect("SEEN.TXT archive parses");
    let overrides = scene_overrides(&data_dir);
    let mut placeholder_runs = 0usize;
    let mut prose_units = 0usize;
    let mut kidoku_markers = 0usize;

    for entry in &index.entries {
        let blob = overrides.get(&entry.scene_id).map_or_else(
            || {
                let start = entry.byte_offset as usize;
                &seen[start..start + entry.byte_len as usize]
            },
            Vec::as_slice,
        );
        let bytecode = decompress_scene(blob);
        for opcode in parse_real_bytecode(&bytecode).expect("scene bytecode parses") {
            match opcode {
                RealLiveOpcode::Textout { raw_bytes, .. } => {
                    placeholder_runs += usize::from(raw_bytes == b"\"\"");
                    prose_units += usize::from(decode_dialogue_textout(&raw_bytes).is_some());
                }
                RealLiveOpcode::MetaKidoku { .. } => kidoku_markers += 1,
                _ => {}
            }
        }
    }

    eprintln!(
        "override-scene prose evidence: effective_scenes={} overrides={} placeholders={} prose_units={} kidoku_markers={}",
        index.entries.len(),
        overrides.len(),
        placeholder_runs,
        prose_units,
        kidoku_markers,
    );
    assert!(
        !overrides.is_empty(),
        "the corpus must exercise scene overrides"
    );
    assert!(
        placeholder_runs > 0,
        "the corpus must contain quoted-empty Textouts"
    );
    assert!(
        kidoku_markers > 0,
        "the corpus must retain real kidoku markers"
    );
    assert_eq!(
        prose_units, 0,
        "quoted-empty placeholders must not be fabricated into prose units"
    );
}

fn decompress_scene(blob: &[u8]) -> Vec<u8> {
    let header = SceneHeader::parse(blob).expect("scene header parses");
    let start = header.bytecode_offset as usize;
    let end = start + header.bytecode_compressed_size as usize;
    decompress_avg32(
        &blob[start..end],
        header.bytecode_uncompressed_size as usize,
    )
    .expect("scene bytecode decompresses")
}

fn second_corpus_data_dir() -> Option<PathBuf> {
    let mut current = PathBuf::from(env::var_os(SECOND_CORPUS_ENV)?);
    for _ in 0..=4 {
        if find_child_ci(&current, "seen.txt").is_some() {
            return Some(current);
        }
        if let Some(data) = find_child_ci(&current, "reallivedata")
            && find_child_ci(&data, "seen.txt").is_some()
        {
            return Some(data);
        }
        let children = fs::read_dir(&current)
            .ok()?
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect::<Vec<_>>();
        let data_children = children
            .iter()
            .filter(|path| find_child_ci(path, "seen.txt").is_some())
            .cloned()
            .collect::<Vec<_>>();
        if data_children.len() == 1 {
            return data_children.into_iter().next();
        }
        if children.len() != 1 {
            return None;
        }
        current = children.into_iter().next()?;
    }
    None
}

fn scene_overrides(data_dir: &Path) -> BTreeMap<u16, Vec<u8>> {
    fs::read_dir(data_dir)
        .expect("data directory readable")
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            let scene_id = parse_scene_override_file_name(name)?;
            Some((scene_id, fs::read(path).expect("standalone scene readable")))
        })
        .collect()
}

fn find_child_ci(dir: &Path, expected: &str) -> Option<PathBuf> {
    fs::read_dir(dir).ok()?.flatten().find_map(|entry| {
        let path = entry.path();
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(expected))
            .then_some(path)
    })
}
