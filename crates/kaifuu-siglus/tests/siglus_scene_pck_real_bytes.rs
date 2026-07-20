//! Env-gated real-bytes proof for the `Scene.pck` container reader + decode.
//!
//! Copyrighted title bytes stay outside this repository, so the two roots are
//! supplied via environment variables. When either root is absent the test
//! reports a skip and succeeds; when both are present it walks each real
//! `Scene.pck`, proving the container reader recovers the full SceneList (scene
//! count + packed plaintext names) and that the payload decoder applies its
//! semantic gating BEFORE any output.
//!
//! Both target titles set `extra_key_use`: their scene payloads are masked with
//! a per-game 16-byte second-layer key recovered from the packed executable by
//! the key-discovery layer (siglus-04). That key is not available in-process
//! here, so — per the honest "prove or record the expected failure" contract —
//! this test proves the container walk succeeds and the payload decode fails
//! with the typed `second_layer_key_required` diagnostic (never garbage, never
//! a partial output). Set the env var to either the game directory or its
//! `Scene.pck` file.

use std::path::{Path, PathBuf};

use kaifuu_siglus::{SceneDecodeError, decode_scene_chunk, decode_scene_pack, parse_scene_pck};

const FIRST_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS";
const SECOND_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS_2";

fn scene_pck_path(variable: &str) -> Option<PathBuf> {
    let value = std::env::var_os(variable).or_else(|| {
        eprintln!("SKIP siglus Scene.pck real bytes: {variable} is unset");
        None
    })?;
    let path = PathBuf::from(value);
    let candidate = if path.is_dir() {
        path.join("Scene.pck")
    } else {
        path
    };
    if candidate.is_file() {
        Some(candidate)
    } else {
        eprintln!(
            "SKIP siglus Scene.pck real bytes: {variable} has no readable Scene.pck at {}",
            candidate.display()
        );
        None
    }
}

fn exercise_title(path: &Path, label: &str) {
    let bytes = std::fs::read(path).expect("read real Scene.pck");
    let index = parse_scene_pck(&bytes).expect("real Scene.pck envelope parses");

    // Container reader: the full SceneList is recovered from real bytes.
    assert!(
        index.entries.len() >= 100,
        "{label}: expected a populated SceneList, got {}",
        index.entries.len()
    );
    let named = index
        .entries
        .iter()
        .filter(|entry| entry.scene_name.is_some())
        .count();
    assert!(
        named > 0,
        "{label}: expected packed plaintext scene names, found none"
    );
    // Names are plaintext ASCII-ish identifiers (e.g. `__init`, `ev_...`).
    assert!(
        index
            .entries
            .iter()
            .filter_map(|entry| entry.scene_name.as_deref())
            .any(|name| name.chars().all(|c| c.is_ascii_graphic()) && !name.is_empty()),
        "{label}: no clean identifier-shaped scene name recovered"
    );

    eprintln!(
        "REAL {label}: scenes={} named={} extra_key_use={} data_region_off={}",
        index.entries.len(),
        named,
        index.extra_key_use,
        index.scene_data_region_offset
    );

    // These titles are second-layer masked; the per-game key is siglus-04's
    // (blocked) deliverable. The payload decode must gate BEFORE any output.
    assert!(
        index.extra_key_use,
        "{label}: target title is expected to set extra_key_use"
    );

    let report = decode_scene_pack(&bytes, None).expect("decode report builds");
    assert_eq!(report.scene_count, index.entries.len());
    assert!(report.extra_key_use);
    assert_eq!(
        report.decoded_count, 0,
        "{label}: no payload can decode without the second-layer key"
    );
    assert_eq!(report.failed_count, report.scene_count);
    assert!(report.scene_digests.is_empty());
    assert!(report.second_layer_secret_ref.is_none());
    for failure in &report.failures {
        assert!(
            failure
                .diagnostic
                .starts_with("kaifuu.siglus.scene.second_layer_key_required"),
            "{label}: unexpected failure diagnostic {}",
            failure.diagnostic
        );
    }

    // The gate is semantic and per-scene: decoding scene 0's raw chunk directly
    // yields the typed key-required error, not garbage.
    let first = &index.entries[0];
    let start = first.byte_offset as usize;
    let chunk = &bytes[start..start + first.byte_len as usize];
    let err = decode_scene_chunk(first.scene_id, chunk, index.extra_key_use, None)
        .expect_err("second-layer key required");
    assert!(matches!(
        err,
        SceneDecodeError::SecondLayerKeyRequired { .. }
    ));

    eprintln!(
        "REAL {label}: container reader OK; payload decode correctly gated on the \
         siglus-04 second-layer key (blocked in-process)"
    );
}

#[test]
fn two_real_siglus_scene_packs_walk_and_gate() {
    let Some(first) = scene_pck_path(FIRST_TITLE_ENV) else {
        return;
    };
    let Some(second) = scene_pck_path(SECOND_TITLE_ENV) else {
        return;
    };
    exercise_title(&first, "siglus-title-one");
    exercise_title(&second, "siglus-title-two");
}
