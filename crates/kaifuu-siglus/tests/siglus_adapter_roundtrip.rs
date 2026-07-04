//! KAIFUU-022 — pure Siglus extraction + patching adapter round-trip proofs.
//!
//! Drives the pure adapter over TWO profiled synthetic "games" (distinct keys +
//! scene ids), proving: extract, identity byte-identical round-trip, translated
//! round-trip (in-scope correct + out-of-scope byte-identical), FS patch+verify
//! with reject-before-write, reject-before-write on unsupported/protected
//! variants + key-proof mismatch, and reject-on-secret on seeded leak classes.
//!
//! Honest scope: the profiled format is the narrow constant-key-XOR / UTF-16LE /
//! uncompressed-within-profile container, NOT real Siglus Scene.pck/Gameexe.dat.
//! No real Siglus retail bytes exist in the vault/scratch (see the capability
//! doc's real-bytes gap); these fixtures are materialised in-process with
//! clearly-fake keys and text.

use kaifuu_core::{
    KeyMaterialKind, KeyValidationMethod, KeyValidationProof, ProofHash, SecretRef,
    sha256_hash_bytes,
};
use kaifuu_siglus::{
    AdapterError, ResolvedSiglusKey, SiglusContainerKind, SiglusSupportedVariant,
    SiglusTranslatedEdit, adapter,
};
use kaifuu_siglus::{
    apply_gameexe_translation, apply_scene_translation, build_profiled_gameexe_container,
    build_profiled_scene_container, patch_container_file, roundtrip_identity_gameexe,
    roundtrip_identity_scene, scan_for_secret_leak,
};

/// Build a resolved key the adapter will accept: the validation proof commits to
/// sha256(material), so `consume` re-validates it (validate-before-consume).
fn resolved_key(key_bytes: &[u8]) -> ResolvedSiglusKey {
    let proof = KeyValidationProof {
        method: KeyValidationMethod::KnownPlaintextProof,
        proof_hash: ProofHash::new(sha256_hash_bytes(key_bytes)).unwrap(),
    };
    ResolvedSiglusKey::consume(
        SecretRef::new("local-secret:siglus-secondary-key").unwrap(),
        proof,
        KeyMaterialKind::FixedBytes,
        key_bytes.to_vec(),
    )
    .expect("valid resolved key is consumed")
}

struct Game {
    variant: SiglusSupportedVariant,
    key: ResolvedSiglusKey,
    scene_id: u32,
    scene_units: Vec<(u32, &'static str)>,
    gameexe_entries: Vec<(&'static str, &'static str)>,
}

fn game_a() -> Game {
    Game {
        variant: SiglusSupportedVariant::profiled("siglus-adapter-fixture-gameA"),
        key: resolved_key(b"ADAPTER-FIXTURE-KEY-AAAA"),
        scene_id: 1,
        scene_units: vec![
            (0, "[gameA-dialogue-unit-0]"),
            (1, "[gameA-dialogue-unit-1]"),
            (2, "[gameA-choice-label-2]"),
        ],
        gameexe_entries: vec![
            ("#NAMAE.000", "[gameA-speaker-0]"),
            ("#NAMAE.001", "[gameA-speaker-1]"),
        ],
    }
}

fn game_b() -> Game {
    Game {
        variant: SiglusSupportedVariant::profiled("siglus-adapter-fixture-gameB"),
        key: resolved_key(b"ADAPTER-FIXTURE-KEY-BBBBBB"),
        scene_id: 42,
        scene_units: vec![
            (0, "[gameB-narration-0]"),
            (1, "[gameB-narration-1]"),
            (2, "[gameB-narration-2]"),
            (3, "[gameB-choice-3]"),
        ],
        gameexe_entries: vec![
            ("#WINDOW.000.NAME", "[gameB-window-0]"),
            ("#WINDOW.001.NAME", "[gameB-window-1]"),
        ],
    }
}

impl Game {
    fn scene(&self) -> Vec<u8> {
        build_profiled_scene_container(&self.key, self.scene_id, &self.scene_units)
    }
    fn gameexe(&self) -> Vec<u8> {
        build_profiled_gameexe_container(&self.key, &self.gameexe_entries)
    }
    fn scene_unit_key(&self, unit_index: u32) -> String {
        format!("siglus:scene-{:04}#{unit_index:04}", self.scene_id)
    }
}

#[test]
fn extract_and_identity_roundtrip_is_byte_identical_two_games() {
    for game in [game_a(), game_b()] {
        // Scene extract.
        let scene = game.scene();
        let extraction = adapter::extract_scene(&game.variant, &game.key, &scene).unwrap();
        assert_eq!(extraction.scene_id, game.scene_id);
        assert_eq!(extraction.units.len(), game.scene_units.len());
        assert_eq!(extraction.units[0].text, game.scene_units[0].1);

        // Scene identity round-trip: byte-identical re-emit.
        let identity = roundtrip_identity_scene(&game.variant, &game.key, &scene).unwrap();
        assert!(
            identity.byte_identical,
            "scene identity must be byte-identical"
        );
        assert_eq!(identity.input_hash, identity.reemitted_hash);

        // Gameexe extract + identity.
        let gameexe = game.gameexe();
        let gxe = adapter::extract_gameexe(&game.variant, &game.key, &gameexe).unwrap();
        assert_eq!(gxe.entries.len(), game.gameexe_entries.len());
        assert_eq!(gxe.entries[0].key, game.gameexe_entries[0].0);
        assert_eq!(gxe.entries[0].value, game.gameexe_entries[0].1);
        let gxe_identity = roundtrip_identity_gameexe(&game.variant, &game.key, &gameexe).unwrap();
        assert!(
            gxe_identity.byte_identical,
            "gameexe identity byte-identical"
        );
    }
}

#[test]
fn translated_scene_roundtrip_changes_in_scope_and_preserves_out_of_scope() {
    let game = game_a();
    let scene = game.scene();
    let edits = vec![SiglusTranslatedEdit {
        target_key: game.scene_unit_key(1),
        translated_text: "[gameA-dialogue-EN-1]".to_string(),
    }];
    let result = apply_scene_translation(&game.variant, &game.key, &scene, &edits).unwrap();
    assert!(result.verified());
    assert!(result.out_of_scope_byte_identical);
    assert_eq!(result.out_of_scope_record_count, 2);
    assert!(result.in_scope_changes[0].changed);

    // Re-extract confirms exactly the target changed.
    let after = adapter::extract_scene(&game.variant, &game.key, &result.patched_bytes).unwrap();
    assert_eq!(after.units[1].text, "[gameA-dialogue-EN-1]");
    assert_eq!(after.units[0].text, game.scene_units[0].1);
    assert_eq!(after.units[2].text, game.scene_units[2].1);
}

#[test]
fn translated_scene_multi_edit_out_of_scope_bytes_survive() {
    let game = game_b();
    let scene = game.scene();
    let edits = vec![
        SiglusTranslatedEdit {
            target_key: game.scene_unit_key(0),
            translated_text: "[gameB-narration-EN-0]".to_string(),
        },
        SiglusTranslatedEdit {
            target_key: game.scene_unit_key(3),
            translated_text: "[gameB-choice-EN-3]".to_string(),
        },
    ];
    let result = apply_scene_translation(&game.variant, &game.key, &scene, &edits).unwrap();
    assert!(result.verified());
    assert!(result.out_of_scope_byte_identical);
    assert_eq!(result.out_of_scope_record_count, 2); // units 1 and 2 untouched
    assert!(result.in_scope_changes.iter().all(|change| change.changed));
}

#[test]
fn translated_gameexe_roundtrip_changes_value_and_preserves_others() {
    let game = game_a();
    let gameexe = game.gameexe();
    let edits = vec![SiglusTranslatedEdit {
        target_key: "#NAMAE.000".to_string(),
        translated_text: "[gameA-speaker-EN-0]".to_string(),
    }];
    let result = apply_gameexe_translation(&game.variant, &game.key, &gameexe, &edits).unwrap();
    assert!(result.verified());
    assert!(result.out_of_scope_byte_identical);
    assert_eq!(result.out_of_scope_record_count, 1);

    let after = adapter::extract_gameexe(&game.variant, &game.key, &result.patched_bytes).unwrap();
    assert_eq!(after.entries[0].value, "[gameA-speaker-EN-0]");
    assert_eq!(after.entries[1].value, game.gameexe_entries[1].1);
}

#[test]
fn fs_patch_scene_writes_verified_output_and_redacted_report() {
    let game = game_a();
    let tmp = tempfile::tempdir().unwrap();
    let input = tmp.path().join("Scene.pck");
    let output = tmp.path().join("Scene.patched.pck");
    let report = tmp.path().join("report.json");
    std::fs::write(&input, game.scene()).unwrap();

    let edits = vec![SiglusTranslatedEdit {
        target_key: game.scene_unit_key(0),
        translated_text: "[gameA-dialogue-EN-0]".to_string(),
    }];
    let produced = patch_container_file(
        &game.variant,
        &game.key,
        SiglusContainerKind::Scene,
        &input,
        &output,
        Some(&report),
        &edits,
    )
    .unwrap();

    assert_eq!(produced.status, kaifuu_core::OperationStatus::Passed);
    assert!(produced.identity.byte_identical);
    assert!(produced.translation.verified);
    assert!(produced.translation.out_of_scope_byte_identical);
    assert!(!produced.capability.does_key_discovery);
    assert!(produced.capability.consumes_resolved_key);
    assert!(!produced.capability.broad_siglus_support);

    // The output re-reads and re-extracts to the translated text.
    let patched = std::fs::read(&output).unwrap();
    let after = adapter::extract_scene(&game.variant, &game.key, &patched).unwrap();
    assert_eq!(after.units[0].text, "[gameA-dialogue-EN-0]");

    // The redacted report leaks neither the raw key nor any decrypted text.
    let report_text = std::fs::read_to_string(&report).unwrap();
    assert!(
        !report_text.contains("ADAPTER-FIXTURE-KEY-AAAA"),
        "raw key leaked"
    );
    assert!(
        !report_text.contains("[gameA-dialogue-unit-0]"),
        "source text leaked"
    );
    assert!(
        !report_text.contains("[gameA-dialogue-EN-0]"),
        "translated text leaked"
    );
    // Key length disclosed, commitment present.
    assert_eq!(
        produced.key_bytes as usize,
        "ADAPTER-FIXTURE-KEY-AAAA".len()
    );
    assert_eq!(
        produced.key_material_hash.as_str(),
        sha256_hash_bytes(b"ADAPTER-FIXTURE-KEY-AAAA")
    );
}

#[test]
fn fs_patch_gameexe_writes_verified_output() {
    let game = game_b();
    let tmp = tempfile::tempdir().unwrap();
    let input = tmp.path().join("Gameexe.dat");
    let output = tmp.path().join("Gameexe.patched.dat");
    std::fs::write(&input, game.gameexe()).unwrap();

    let edits = vec![SiglusTranslatedEdit {
        target_key: "#WINDOW.001.NAME".to_string(),
        translated_text: "[gameB-window-EN-1]".to_string(),
    }];
    let produced = patch_container_file(
        &game.variant,
        &game.key,
        SiglusContainerKind::Gameexe,
        &input,
        &output,
        None,
        &edits,
    )
    .unwrap();
    assert!(produced.translation.verified);
    let patched = std::fs::read(&output).unwrap();
    let after = adapter::extract_gameexe(&game.variant, &game.key, &patched).unwrap();
    assert_eq!(after.entries[1].value, "[gameB-window-EN-1]");
    assert_eq!(after.entries[0].value, game.gameexe_entries[0].1);
}

#[test]
fn unsupported_variant_rejects_before_write() {
    let game = game_a();
    let tmp = tempfile::tempdir().unwrap();
    let input = tmp.path().join("Scene.pck");
    let output = tmp.path().join("Scene.patched.pck");
    std::fs::write(&input, game.scene()).unwrap();

    // A variant that declares proprietary-LZSS is out of profile.
    let unsupported = SiglusSupportedVariant {
        variant_id: "siglus-adapter-lzss".to_string(),
        encoding: kaifuu_siglus::SiglusKnownKeyEncoding::Utf16Le,
        compression: kaifuu_siglus::SiglusKnownKeyCompression::Lzss,
    };
    let edits = vec![SiglusTranslatedEdit {
        target_key: game.scene_unit_key(0),
        translated_text: "x".to_string(),
    }];
    let err = patch_container_file(
        &unsupported,
        &game.key,
        SiglusContainerKind::Scene,
        &input,
        &output,
        None,
        &edits,
    )
    .expect_err("unsupported variant must reject");
    assert!(matches!(err, AdapterError::UnsupportedVariant { .. }));
    assert!(
        !output.exists(),
        "no output may be written on capability error"
    );
}

#[test]
fn out_of_profile_container_rejects_before_write() {
    let game = game_a();
    let tmp = tempfile::tempdir().unwrap();
    let input = tmp.path().join("Scene.pck");
    let output = tmp.path().join("Scene.patched.pck");
    // A container flagged with the out-of-profile proprietary-LZSS compression.
    std::fs::write(
        &input,
        kaifuu_siglus::build_synthetic_out_of_profile_scene_fixture(),
    )
    .unwrap();

    let edits = vec![SiglusTranslatedEdit {
        target_key: game.scene_unit_key(0),
        translated_text: "x".to_string(),
    }];
    let err = patch_container_file(
        &game.variant,
        &game.key,
        SiglusContainerKind::Scene,
        &input,
        &output,
        None,
        &edits,
    )
    .expect_err("out-of-profile container must reject");
    assert!(matches!(err, AdapterError::UnsupportedVariant { .. }));
    assert!(!output.exists(), "no output on out-of-profile container");
}

#[test]
fn key_proof_mismatch_and_wrong_method_are_refused() {
    // Wrong commitment: proof hashes the wrong bytes.
    let proof = KeyValidationProof {
        method: KeyValidationMethod::KnownPlaintextProof,
        proof_hash: ProofHash::new(sha256_hash_bytes(b"a-different-key")).unwrap(),
    };
    let err = ResolvedSiglusKey::consume(
        SecretRef::new("local-secret:siglus-secondary-key").unwrap(),
        proof,
        KeyMaterialKind::FixedBytes,
        b"ADAPTER-FIXTURE-KEY-AAAA".to_vec(),
    )
    .expect_err("mismatched commitment must be refused");
    assert!(matches!(err, AdapterError::KeyProofMismatch { .. }));

    // A method the adapter cannot re-check is refused.
    let wrong_method = KeyValidationProof {
        method: KeyValidationMethod::ArchiveIndexProof,
        proof_hash: ProofHash::new(sha256_hash_bytes(b"ADAPTER-FIXTURE-KEY-AAAA")).unwrap(),
    };
    let err = ResolvedSiglusKey::consume(
        SecretRef::new("local-secret:siglus-secondary-key").unwrap(),
        wrong_method,
        KeyMaterialKind::FixedBytes,
        b"ADAPTER-FIXTURE-KEY-AAAA".to_vec(),
    )
    .expect_err("un-recheckable method must be refused");
    assert!(matches!(
        err,
        AdapterError::KeyProofMethodUnsupported { .. }
    ));
}

#[test]
fn reject_on_secret_flags_seeded_key_and_plaintext_but_passes_clean_output() {
    let game = game_a();
    let key = &game.key;

    // Clean output (masked ciphertext) + redacted report → no findings.
    let scene = game.scene();
    let clean_report = r#"{"keyMaterialHash":"sha256:00"}"#;
    let clean = scan_for_secret_leak(key, &scene, clean_report, &[]);
    assert!(clean.is_empty(), "clean output must not flag: {clean:?}");

    // Seeded RAW KEY inside the output bytes → flagged, write must be refused.
    let mut leaky = scene.clone();
    leaky.extend_from_slice(b"ADAPTER-FIXTURE-KEY-AAAA");
    let findings = scan_for_secret_leak(key, &leaky, clean_report, &[]);
    assert!(
        findings.iter().any(|f| f.kind == "raw-key"),
        "raw-key leak must be flagged: {findings:?}"
    );

    // Seeded DECRYPTED PLAINTEXT inside the output bytes → flagged.
    let probe = "[gameA-secret-plaintext]".to_string();
    let mut leaky_text = scene.clone();
    leaky_text.extend_from_slice(probe.as_bytes());
    let findings =
        scan_for_secret_leak(key, &leaky_text, clean_report, std::slice::from_ref(&probe));
    assert!(
        findings.iter().any(|f| f.kind == "decrypted-text"),
        "decrypted-text leak must be flagged: {findings:?}"
    );

    // Seeded raw key inside the REPORT text → flagged.
    let leaky_report = r#"{"leak":"ADAPTER-FIXTURE-KEY-AAAA"}"#;
    let findings = scan_for_secret_leak(key, &scene, leaky_report, &[]);
    assert!(
        findings.iter().any(|f| f.location == "report"),
        "report leak must be flagged: {findings:?}"
    );
}

#[test]
fn empty_edit_set_is_refused_not_a_silent_noop() {
    let game = game_a();
    let scene = game.scene();
    let err = apply_scene_translation(&game.variant, &game.key, &scene, &[])
        .expect_err("empty edits must be refused");
    assert!(matches!(err, AdapterError::VerifyFailed { .. }));
}
