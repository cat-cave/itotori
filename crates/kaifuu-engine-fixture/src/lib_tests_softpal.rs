use super::*;

#[test]
fn softpal_detects_pal_dll_marker() {
    let dir = temp_dir("softpal-pal-dll");
    fs::create_dir_all(dir.join("dll")).unwrap();
    fs::write(dir.join("dll/Pal.dll"), b"MZ\x90\x00 synthetic pe stub").unwrap();

    let detection = detect_softpal(&dir);
    assert!(detection.detected, "Pal.dll must classify as Softpal");
    assert_eq!(detection.engine_family.as_deref(), Some("softpal"));
    assert_eq!(detection.detected_variant.as_deref(), Some("pal-dll"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn softpal_detects_pac_listing_script_and_text() {
    let dir = temp_dir("softpal-pac-scripts");
    fs::write(dir.join("data.pac"), synthetic_softpal_pac(true)).unwrap();

    let detection = detect_softpal(&dir);
    assert!(detection.detected, "PAC + SCRIPT.SRC/TEXT.DAT must detect");
    assert_eq!(detection.engine_family.as_deref(), Some("softpal"));
    assert_eq!(
        detection.detected_variant.as_deref(),
        Some("pac-script-src-text-dat")
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn softpal_detects_loose_scripts_across_both_enc_flags() {
    // Observed installations differ in the TEXT.DAT enc flag: `$` encrypted
    // and `_` plaintext. The detector must recognise both.
    for (name, enc_flag, want_label) in [
        ("softpal-loose-enc", b'$', "encrypted ($)"),
        ("softpal-loose-plain", b'_', "plaintext (_)"),
    ] {
        let dir = temp_dir(name);
        fs::write(dir.join("SCRIPT.SRC"), b"Sv20\x00\x00\x00\x00synthetic").unwrap();
        let mut text_dat = vec![enc_flag];
        text_dat.extend_from_slice(b"TEXT_LIST__");
        text_dat.extend_from_slice(&[0u8; 16]);
        fs::write(dir.join("TEXT.DAT"), &text_dat).unwrap();

        let detection = detect_softpal(&dir);
        assert!(
            detection.detected,
            "{name}: loose Sv20 SCRIPT.SRC + [$_]TEXT_LIST__ TEXT.DAT must detect"
        );
        assert_eq!(detection.engine_family.as_deref(), Some("softpal"));
        assert_eq!(
            detection.detected_variant.as_deref(),
            Some("loose-script-src-text-dat")
        );
        let text_evidence = detection
            .evidence
            .iter()
            .find(|e| e.kind == "softpal_text_dat_magic")
            .expect("text.dat evidence row");
        assert_eq!(text_evidence.status, EvidenceStatus::Matched);
        assert!(
            text_evidence.detail.contains(want_label),
            "{name}: enc flag `{want_label}` must be reported, got {:?}",
            text_evidence.detail
        );
        let _ = fs::remove_dir_all(&dir);
    }
}

#[test]
fn softpal_rejects_unrelated_directory() {
    let dir = temp_dir("softpal-negative");
    fs::write(dir.join("readme.txt"), b"not a softpal game").unwrap();
    fs::write(dir.join("config.ini"), b"[settings]\nvolume=100\n").unwrap();

    let detection = detect_softpal(&dir);
    assert!(!detection.detected, "unrelated dir must not detect Softpal");
    assert_eq!(detection.engine_family, None);
    assert_eq!(detection.detected_variant, None);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn softpal_bare_pac_magic_without_scripts_is_not_detected() {
    // False-positive guard: a `.pac` with the generic `PAC ` magic but no
    // SCRIPT.SRC/TEXT.DAT entries must NOT claim the Softpal engine.
    let dir = temp_dir("softpal-bare-pac");
    fs::write(dir.join("data.pac"), synthetic_softpal_pac(false)).unwrap();

    let detection = detect_softpal(&dir);
    assert!(
        !detection.detected,
        "bare PAC magic without Softpal scripts must not detect"
    );
    assert_eq!(detection.engine_family, None);
    // Diagnostic-only variant is surfaced, but detection stays false.
    assert_eq!(
        detection.detected_variant.as_deref(),
        Some("unknown-softpal-signature")
    );
    let pac_evidence = detection
        .evidence
        .iter()
        .find(|e| e.kind == "softpal_pac_script_text_entries")
        .expect("pac evidence row");
    assert_eq!(pac_evidence.status, EvidenceStatus::Invalid);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn softpal_adapter_level_matrix_extract_supported_patch_partial() {
    use kaifuu_core::CapabilityLevel;
    let matrix = SoftpalProfileDetectorAdapter.capabilities().level_matrix;
    assert_eq!(matrix.adapter_id, SOFTPAL_DETECTOR_ADAPTER_ID);
    assert!(matrix.supports(CapabilityLevel::Identify));
    assert!(matrix.supports(CapabilityLevel::Inventory));
    // Extract is a first-class Supported surface: the kaifuu-softpal PAC +
    // TEXT.DAT + SCRIPT.SRC reader recovers the dialogue + choice text.
    assert!(matrix.supports(CapabilityLevel::Extract));
    // Patch is Partial: real loose-file dialogue/choice patch-back, but PAC
    // repack + non-text surfaces are not claimed.
    assert!(!matrix.supports(CapabilityLevel::Patch));
    assert!(matrix.patch.is_partial());
}

#[test]
fn softpal_extract_errors_when_no_scripts_resolvable() {
    // Detected (Pal.dll) but no data.pac / loose scripts: extract must fail
    // loudly (no scripts to disassemble), never fabricate an empty bundle.
    // list_assets/asset_inventory still succeed (empty) for a detected title;
    // positive real-bytes extract/inventory coverage is in the live test.
    let dir = temp_dir("softpal-no-scripts");
    fs::create_dir_all(dir.join("dll")).unwrap();
    fs::write(dir.join("dll/Pal.dll"), b"MZ synthetic").unwrap();
    assert!(
        SoftpalProfileDetectorAdapter
            .extract(ExtractRequest { game_dir: &dir })
            .is_err(),
        "extract must error when no SCRIPT.SRC/TEXT.DAT pair is resolvable"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn softpal_profile_classifies_engine_softpal() {
    let dir = temp_dir("softpal-profile");
    fs::write(dir.join("data.pac"), synthetic_softpal_pac(true)).unwrap();
    let profile = SoftpalProfileDetectorAdapter
        .profile(ProfileRequest { game_dir: &dir })
        .unwrap();
    assert_eq!(profile.engine.engine_family, "softpal");
    assert_eq!(profile.engine.adapter_id, SOFTPAL_DETECTOR_ADAPTER_ID);
    assert_eq!(profile.engine.detected_variant, "pac-script-src-text-dat");
    assert_eq!(
        profile.metadata.get("engineFamily").map(String::as_str),
        Some("softpal")
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn softpal_registered_in_engine_registry() {
    assert!(
        registry().get(SOFTPAL_DETECTOR_ADAPTER_ID).is_some(),
        "Softpal detector must be registered in the shared engine registry"
    );
}
