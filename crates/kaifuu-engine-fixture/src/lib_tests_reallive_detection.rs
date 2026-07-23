use super::*;

#[test]
fn detects_reallive_on_complete_synthetic_triple_fixture() {
    let dir = reallive_fixture_dir(
        "reallive-complete-synthetic-triple",
        &[
            (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(2)),
            (REALLIVE_SEEN_GAN_PATH, REALLIVE_SEEN_GAN_MAGIC),
            (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
            ("image.g00", b"\0"),
            ("voice.ovk", b"\0"),
        ],
    );
    let adapter = RealLiveProfileDetectorAdapter;
    let detection = adapter.detect(DetectRequest { game_dir: &dir }).unwrap();
    assert!(detection.detected);
    assert_eq!(detection.engine_family.as_deref(), Some("reallive"));
    assert_eq!(
        detection.detected_variant.as_deref(),
        Some("reallive-synthetic-triple")
    );
    let profile = adapter.profile(ProfileRequest { game_dir: &dir }).unwrap();
    assert_eq!(profile.engine.adapter_id, REALLIVE_DETECTOR_ADAPTER_ID);
    assert_eq!(profile.engine.engine_family, "reallive");
    assert_eq!(profile.profile_id, REALLIVE_PROFILE_ID);
    let inventory = adapter
        .asset_inventory(AssetInventoryRequest { game_dir: &dir })
        .unwrap();
    assert!(
        inventory
            .assets
            .iter()
            .any(|asset| asset.asset_key == REALLIVE_SEEN_TXT_PATH),
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn detects_reallive_on_positive_live_layout_with_gameexe_ini_key_hits() {
    // Generic envelope: no synthetic SEEN.TXT magic; just the real
    // 10,000-slot fixed-offset-table shape with one
    // populated slot at slot 1. Gameexe.ini has #GAMEEXE_VERSION
    // present without the synthetic-magic prefix. Mirrors what a real
    // RealLive title looks like at the SEEN.TXT + Gameexe.ini layer.
    let directory_byte_len = kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize;
    let payload_offset = directory_byte_len as u32;
    let payload: &[u8] = b"generic-shape-payload";
    let mut seen_bytes = vec![0u8; directory_byte_len + payload.len()];
    let slot1 = 8usize;
    seen_bytes[slot1..slot1 + 4].copy_from_slice(&payload_offset.to_le_bytes());
    seen_bytes[slot1 + 4..slot1 + 8].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    seen_bytes[directory_byte_len..].copy_from_slice(payload);
    let dir = reallive_fixture_dir(
        "reallive-positive-live-layout",
        &[
            (REALLIVE_SEEN_TXT_PATH, &seen_bytes),
            (
                REALLIVE_GAMEEXE_INI_PATH,
                b"#GAMEEXE_VERSION=1.0\n#G00BUF=8\n",
            ),
            ("image.g00", b"\0"),
        ],
    );
    let adapter = RealLiveProfileDetectorAdapter;
    let detection = adapter.detect(DetectRequest { game_dir: &dir }).unwrap();
    assert!(detection.detected, "{detection:#?}");
    assert_eq!(
        detection.detected_variant.as_deref(),
        Some("reallive-positive-live-layout")
    );
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn detects_reallive_when_seen_txt_lives_under_nested_reallivedata_subdir() {
    // regression: when SEEN.TXT / Gameexe.ini live under
    // a REALLIVEDATA/ subdirectory at depth 2 (localized-title shape:
    // `<root>/<localized title subdir>/REALLIVEDATA/`), the detector must
    // resolve the data dir and treat the files as engine evidence
    // even though they're not at game-root depth 1.
    let directory_byte_len = kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize;
    let payload_offset = directory_byte_len as u32;
    let payload: &[u8] = b"nested-shape-payload";
    let mut seen_bytes = vec![0u8; directory_byte_len + payload.len()];
    let slot1 = 8usize;
    seen_bytes[slot1..slot1 + 4].copy_from_slice(&payload_offset.to_le_bytes());
    seen_bytes[slot1 + 4..slot1 + 8].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    seen_bytes[directory_byte_len..].copy_from_slice(payload);

    let game_dir = temp_dir("reallive-nested-realivedata");
    let nested_dir = game_dir.join("架空タイトル").join("REALLIVEDATA");
    fs::create_dir_all(&nested_dir).unwrap();
    fs::write(nested_dir.join(REALLIVE_SEEN_TXT_PATH), &seen_bytes).unwrap();
    fs::write(
        nested_dir.join(REALLIVE_GAMEEXE_INI_PATH),
        b"#GAMEEXE_VERSION=1.0\n#REGNAME=KaifuuFixture\\RealLive\n#KOEPAC=koe.ovk\n",
    )
    .unwrap();
    // .g00 /.koe in nested asset subdirs (depth 2 inside REALLIVEDATA,
    // as in `REALLIVEDATA/g00/*.g00`).
    fs::create_dir_all(nested_dir.join("g00")).unwrap();
    fs::write(nested_dir.join("g00/image.g00"), b"\0").unwrap();
    fs::create_dir_all(nested_dir.join("koe")).unwrap();
    fs::write(nested_dir.join("koe/voice.koe"), b"\0").unwrap();

    let adapter = RealLiveProfileDetectorAdapter;
    let detection = adapter
        .detect(DetectRequest {
            game_dir: &game_dir,
        })
        .unwrap();
    assert!(
        detection.detected,
        "depth-N descent must find REALLIVEDATA under JP-named parent; got: {detection:#?}"
    );
    assert_eq!(
        detection.detected_variant.as_deref(),
        Some("reallive-positive-live-layout")
    );
    // The resolved-data-dir evidence row must appear and carry the
    // relative path with forward-slash separators.
    let resolved_row = detection
        .evidence
        .iter()
        .find(|row| row.kind == REALLIVE_NESTED_DATA_DIR_RESOLVED_CODE)
        .expect("resolved REALLIVEDATA evidence row must be emitted");
    assert_eq!(resolved_row.status, EvidenceStatus::Matched);
    assert!(
        resolved_row.path.ends_with("/REALLIVEDATA"),
        "resolved data dir path must end with `/REALLIVEDATA`, got `{}`",
        resolved_row.path
    );
    // SEEN.TXT / Gameexe.ini evidence paths must be reported relative
    // to the game root, prefixed with the resolved data dir.
    let seen_row = detection
        .evidence
        .iter()
        .find(|row| row.kind == "reallive_seen_txt_envelope")
        .expect("SEEN.TXT envelope row must be present");
    assert_eq!(seen_row.status, EvidenceStatus::Matched);
    assert!(
        seen_row.path.ends_with("/REALLIVEDATA/SEEN.TXT"),
        "SEEN.TXT evidence path must include the resolved REALLIVEDATA prefix; got `{}`",
        seen_row.path
    );
    // .g00 /.koe extension counts must reflect the depth-2 walk
    // inside REALLIVEDATA (the asset subdirs).
    let g00_row = detection
        .evidence
        .iter()
        .find(|row| row.kind == "reallive_g00_extension_count")
        .expect("g00 count row must be present");
    assert_eq!(g00_row.status, EvidenceStatus::Matched);
    assert!(
        g00_row.detail.contains("count: 1"),
        "g00 extension count must reflect the file under REALLIVEDATA/g00/ subdir; got `{}`",
        g00_row.detail
    );
    let voice_row = detection
        .evidence
        .iter()
        .find(|row| row.kind == "reallive_voice_archive_count")
        .expect("voice archive count row must be present");
    assert_eq!(voice_row.status, EvidenceStatus::Matched);
    assert!(
        voice_row.detail.contains("count: 1"),
        "voice archive count must reflect the file under REALLIVEDATA/koe/ subdir; got `{}`",
        voice_row.detail
    );
    let _ = fs::remove_dir_all(game_dir);
}

#[test]
fn does_not_emit_resolved_data_dir_evidence_when_no_nested_reallivedata_present() {
    // regression: synthetic fixtures that ship SEEN.TXT
    // at the game root (no nested REALLIVEDATA/ marker) must keep
    // emitting the original bare-marker evidence paths so the
    // public-CI golden fixtures stay byte-stable.
    let dir = reallive_fixture_dir(
        "reallive-no-nested-data-dir",
        &[
            (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(2)),
            (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
            ("image.g00", b"\0"),
            ("voice.ovk", b"\0"),
        ],
    );
    let adapter = RealLiveProfileDetectorAdapter;
    let detection = adapter.detect(DetectRequest { game_dir: &dir }).unwrap();
    assert!(detection.detected);
    let resolved_row = detection
        .evidence
        .iter()
        .find(|row| row.kind == REALLIVE_NESTED_DATA_DIR_RESOLVED_CODE);
    assert!(
        resolved_row.is_none(),
        "no nested REALLIVEDATA/ marker means no resolved-data-dir evidence row; got {resolved_row:?}",
    );
    let seen_row = detection
        .evidence
        .iter()
        .find(|row| row.kind == "reallive_seen_txt_envelope")
        .expect("SEEN.TXT envelope row must be present");
    assert_eq!(seen_row.path, REALLIVE_SEEN_TXT_PATH);
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn rejects_reallive_when_siglus_scene_pck_co_present_with_ambiguous_engine_variant_error() {
    let dir = reallive_fixture_dir(
        "reallive-ambiguous-siglus-scene-pck",
        &[
            (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
            (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
            ("Scene.pck", b"SIGLUS-SCENE-PCK"),
        ],
    );
    let adapter = RealLiveProfileDetectorAdapter;
    let detection = adapter.detect(DetectRequest { game_dir: &dir }).unwrap();
    assert!(!detection.detected);
    assert_eq!(
        detection.detected_variant.as_deref(),
        Some("ambiguous-reallive-siglus-overlap")
    );
    let failure = adapter_failure_from_error(
        adapter
            .profile(ProfileRequest { game_dir: &dir })
            .unwrap_err(),
    );
    assert_eq!(failure.error_code, "kaifuu.ambiguous_engine_variant");
    assert_eq!(failure.engine.as_deref(), Some("reallive"));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn rejects_reallive_when_gameexe_dat_co_present_with_ambiguous_engine_variant_error() {
    let dir = reallive_fixture_dir(
        "reallive-ambiguous-gameexe-dat",
        &[
            (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
            (REALLIVE_GAMEEXE_INI_PATH, &synthetic_gameexe_ini()),
            ("Gameexe.dat", b"SIGLUS-GAMEEXE-DAT"),
        ],
    );
    let adapter = RealLiveProfileDetectorAdapter;
    let failure = adapter_failure_from_error(
        adapter
            .asset_inventory(AssetInventoryRequest { game_dir: &dir })
            .unwrap_err(),
    );
    assert_eq!(failure.error_code, "kaifuu.ambiguous_engine_variant");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn rejects_reallive_on_avg32_pdt_layout_with_unsupported_engine_variant_error() {
    let dir = reallive_fixture_dir(
        "reallive-avg32-pdt-layout",
        &[
            (REALLIVE_SEEN_TXT_PATH, &synthetic_seen_txt(1)),
            ("Gameexe.ini", b"# AVG32 lineage placeholder\n"),
            ("image.PDT", b"\0"),
        ],
    );
    let adapter = RealLiveProfileDetectorAdapter;
    let detection = adapter.detect(DetectRequest { game_dir: &dir }).unwrap();
    assert!(!detection.detected);
    assert_eq!(
        detection.detected_variant.as_deref(),
        Some("avg32-lineage-seen-txt")
    );
    let failure = adapter_failure_from_error(
        adapter
            .profile(ProfileRequest { game_dir: &dir })
            .unwrap_err(),
    );
    assert_eq!(failure.error_code, "kaifuu.unsupported_engine_variant");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn rejects_reallive_on_invalid_seen_txt_envelope_with_unknown_engine_variant_error() {
    let dir = reallive_fixture_dir(
        "reallive-invalid-seen-envelope",
        &[
            (REALLIVE_SEEN_TXT_PATH, &[0u8; 4]),
            (REALLIVE_GAMEEXE_INI_PATH, b""),
        ],
    );
    let adapter = RealLiveProfileDetectorAdapter;
    let detection = adapter.detect(DetectRequest { game_dir: &dir }).unwrap();
    assert!(!detection.detected);
    assert_eq!(
        detection.detected_variant.as_deref(),
        Some("unknown-reallive-named-files")
    );
    let failure = adapter_failure_from_error(
        adapter
            .profile(ProfileRequest { game_dir: &dir })
            .unwrap_err(),
    );
    assert_eq!(failure.error_code, "kaifuu.unknown_engine_variant");
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn does_not_detect_reallive_on_hello_game_fixture_without_emitting_diagnostic() {
    let dir = hello_fixture_dir();
    let detection = RealLiveProfileDetectorAdapter
        .detect(DetectRequest { game_dir: &dir })
        .unwrap();
    assert!(!detection.detected);
    assert!(detection.detected_variant.is_none());
    assert!(detection.engine_family.is_none());
}

#[test]
fn does_not_detect_reallive_on_xp3_fixture_without_misclassifying() {
    let dir = xp3_fixture_dir(
        "reallive-cross-check-xp3",
        b"XP3\r\nfixture-only plain archive",
    );
    let detection = RealLiveProfileDetectorAdapter
        .detect(DetectRequest { game_dir: &dir })
        .unwrap();
    assert!(!detection.detected);
    assert!(detection.detected_variant.is_none());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn does_not_detect_reallive_on_siglus_only_fixture_without_misclassifying() {
    let dir = siglus_fixture_dir(
        "reallive-cross-check-siglus",
        Some(SIGLUS_SCENE_MAGIC),
        Some(SIGLUS_GAMEEXE_MAGIC),
    );
    let detection = RealLiveProfileDetectorAdapter
        .detect(DetectRequest { game_dir: &dir })
        .unwrap();
    assert!(!detection.detected);
    assert!(detection.detected_variant.is_none());
    let _ = fs::remove_dir_all(dir);
}
