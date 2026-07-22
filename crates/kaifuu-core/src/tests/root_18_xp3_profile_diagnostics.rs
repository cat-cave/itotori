#[test]
fn xp3_profile_proof_report_carries_fixture_metadata_and_redacts_secrets() {
    // Acceptance criterion: "The proof report includes fixture id,
    // profile id, archive hash, crypt profile status, helper requirement,
    // and semantic remediation."
    let dir = temp_dir("xp3-profile-proof-metadata");
    write_xp3_archive(&dir, "plain.xp3", &build_plain_xp3_archive_bytes());
    write_xp3_archive(
        &dir,
        "encrypted.xp3",
        &build_encrypted_xp3_marker_archive_bytes(),
    );

    let plain_report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &make_plain_fixture("plain.xp3"),
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(
        plain_report.fixture_id,
        "kaifuu-kirikiri-xp3-plain-profile-proof"
    );
    assert_eq!(
        plain_report.profile_id,
        "019ed000-0000-7000-8000-000000095001"
    );
    assert_eq!(plain_report.archive.archive_id, "kirikiri-xp3-archive");
    assert!(
        plain_report
            .archive
            .archive_hash
            .as_str()
            .starts_with("sha256:")
    );
    assert_eq!(plain_report.semantic_remediation, None);
    assert_eq!(
        plain_report.support_boundary,
        XP3_PROFILE_PROOF_SUPPORT_BOUNDARY
    );
    assert_ne!(
        plain_report.redacted_for_report().support_boundary,
        format!("[REDACTED:{SEMANTIC_SECRET_REDACTED}]")
    );
    assert_eq!(
        plain_report.redacted_for_report().support_boundary,
        XP3_PROFILE_PROOF_SUPPORT_BOUNDARY
    );
    let plain_json = plain_report.stable_json().unwrap();
    assert!(
        plain_json.contains(XP3_PROFILE_PROOF_SUPPORT_BOUNDARY),
        "supportBoundary must remain readable in proof JSON: {plain_json}"
    );
    assert!(
        !plain_json.contains("\"supportBoundary\":\"[REDACTED:kaifuu.secret_redacted]\""),
        "supportBoundary was over-redacted in proof JSON: {plain_json}"
    );

    let encrypted_report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &make_encrypted_fixture("encrypted.xp3"),
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(
        encrypted_report.crypt_profile.status,
        Xp3CryptProfileStatus::Satisfied
    );
    assert_eq!(
        encrypted_report.crypt_profile.requirement_id.as_deref(),
        Some("kirikiri-xp3-key-profile")
    );
    assert!(encrypted_report.semantic_remediation.is_some());

    // Redaction surface: stable_json round-trips through redaction.
    let json = encrypted_report.stable_json().unwrap();
    // The fixture-only secret-ref label is safe to surface, but raw
    // key material patterns must not appear. Make sure no absolute
    // host paths or hex secrets leaked into the report.
    assert!(
        !json.contains("/home/"),
        "report leaked absolute host path: {json}"
    );
    assert!(!json.contains("C:\\"), "report leaked drive path: {json}");
}

#[test]
fn xp3_profile_proof_rejects_leaked_archive_paths_before_extract_claims() {
    // Acceptance criterion: "Private archive paths, raw keys, and
    // decrypted text cannot appear in the report." plus "Unsupported
    // cases fail before extract or patch claims are made."
    let dir = temp_dir("xp3-profile-proof-leaked-paths");
    write_xp3_archive(&dir, "plain.xp3", &build_plain_xp3_archive_bytes());

    for leaked_path in [
        "/home/local-user/private/data.xp3",
        "C:\\Users\\local-user\\private\\data.xp3",
        "../../../etc/passwd",
        "~/secret/data.xp3",
        "$HOME/secret/data.xp3",
    ] {
        let mut fixture = make_plain_fixture("plain.xp3");
        fixture.archive.path = leaked_path.to_string();
        let report = xp3_profile_proof(Xp3ProfileProofRequest {
            fixture: &fixture,
            fixture_dir: &dir,
        })
        .unwrap();
        assert_eq!(
            report.status,
            OperationStatus::Failed,
            "leaked path {leaked_path} must fail"
        );
        assert!(
            report
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "xp3.archive_path.leaked"),
            "leaked path {leaked_path} must fire xp3.archive_path.leaked"
        );
        // The declared_path field is scrubbed of the leaked text.
        assert!(
            !report.archive.declared_path.contains(leaked_path),
            "leaked path {leaked_path} survived into report: {}",
            report.archive.declared_path
        );
        // Patch capability is never elevated past unsupported when
        // the path was rejected.
        let stable_json = report.stable_json().unwrap();
        assert!(
            !stable_json.contains(leaked_path),
            "leaked path {leaked_path} survived into stable_json: {stable_json}"
        );
    }
}

#[test]
fn xp3_profile_proof_overclaim_diagnostic_names_real_capability_rule() {
    // Non-plain XP3 variants are routing diagnostics only; even a
    // profiled encrypted fixture cannot claim extract or patch_back.
    let dir = temp_dir("xp3-profile-proof-overclaim-message");
    write_xp3_archive(
        &dir,
        "encrypted.xp3",
        &build_encrypted_xp3_marker_archive_bytes(),
    );
    let mut fixture = make_encrypted_fixture("encrypted.xp3");
    fixture.patch_capability_level = Xp3PatchCapabilityLevel::PatchBack;

    let report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();

    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.classification, Xp3ProfileClassification::Encrypted);
    assert_eq!(
        report.patch_capability_level,
        Xp3PatchCapabilityLevel::Unsupported
    );
    assert_eq!(
        report.crypt_profile.status,
        Xp3CryptProfileStatus::Satisfied
    );

    let expected_message = "fixture declared patch_back; XP3 profile proof permits extract and patch_back capability claims only for plain XP3, while encrypted, compressed, helper_required, and unsupported_protected_executable fixtures must set patchCapabilityLevel to unsupported";
    let diagnostic = xp3_profile_diagnostic(&report, "xp3.patch_capability.overclaim");
    assert_eq!(diagnostic.severity, PartialDiagnosticSeverity::P0);
    assert_eq!(diagnostic.field, "patchCapabilityLevel");
    assert_eq!(diagnostic.message, expected_message);
    assert_eq!(
        diagnostic.semantic_code.as_deref(),
        Some(SEMANTIC_MISSING_PATCH_BACK_CAPABILITY)
    );
    assert_eq!(
        diagnostic.remediation.as_deref(),
        Some(
            "set patchCapabilityLevel to \"unsupported\" for encrypted, compressed, helper_required, and unsupported_protected_executable XP3 fixtures"
        )
    );

    let redacted = report.redacted_for_report();
    assert_eq!(
        xp3_profile_diagnostic(&redacted, "xp3.patch_capability.overclaim").message,
        expected_message
    );
    let stable_json = report.stable_json().unwrap();
    assert!(stable_json.contains(expected_message));
    assert!(!stable_json.contains("\"message\":\"[REDACTED:kaifuu.secret_redacted]\""));
}

#[test]
fn xp3_profile_proof_missing_crypt_profile_fails_closed() {
    // Negative fixture: encrypted classification without a
    // crypt_profile entry → P0 missing-crypt-profile diagnostic.
    let dir = temp_dir("xp3-profile-proof-missing-crypt");
    write_xp3_archive(
        &dir,
        "encrypted.xp3",
        &build_encrypted_xp3_marker_archive_bytes(),
    );
    let mut fixture = make_encrypted_fixture("encrypted.xp3");
    fixture.crypt_profile = None;
    let report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.classification, Xp3ProfileClassification::Encrypted);
    assert_eq!(report.crypt_profile.status, Xp3CryptProfileStatus::Missing);
    let expected_message = "encrypted XP3 fixtures must declare cryptProfile with cryptProfileId and keyRefRequirement; the crypt profile records routing metadata only and does not claim decryption, extraction, or patch_back support";
    let diagnostic = xp3_profile_diagnostic(&report, "xp3.crypt_profile.missing");
    assert_eq!(diagnostic.severity, PartialDiagnosticSeverity::P0);
    assert_eq!(diagnostic.field, "cryptProfile");
    assert_eq!(diagnostic.message, expected_message);
    assert_eq!(
        diagnostic.semantic_code.as_deref(),
        Some(SEMANTIC_MISSING_KEY_PROFILE)
    );
    assert_eq!(
        diagnostic.remediation.as_deref(),
        Some(
            "add cryptProfile with cryptProfileId and keyRefRequirement for encrypted or helper_required XP3 fixtures"
        )
    );
    assert_eq!(
        report.patch_capability_level,
        Xp3PatchCapabilityLevel::Unsupported
    );

    let redacted = report.redacted_for_report();
    assert_eq!(
        xp3_profile_diagnostic(&redacted, "xp3.crypt_profile.missing").message,
        expected_message
    );
    let stable_json = report.stable_json().unwrap();
    assert!(stable_json.contains(expected_message));
    assert!(!stable_json.contains("\"message\":\"[REDACTED:kaifuu.secret_redacted]\""));
}

#[test]
fn xp3_profile_proof_unknown_encryption_plugin_fails_closed() {
    // Negative fixture: crypt_profile_id not in
    // XP3_RECOGNIZED_CRYPT_PROFILE_IDS → P0 unknown-plugin diagnostic.
    let dir = temp_dir("xp3-profile-proof-unknown-plugin");
    write_xp3_archive(
        &dir,
        "encrypted.xp3",
        &build_encrypted_xp3_marker_archive_bytes(),
    );
    let mut fixture = make_encrypted_fixture("encrypted.xp3");
    fixture.crypt_profile = Some(Xp3ProfileProofFixtureCryptProfile {
        crypt_profile_id: "kirikiri-xp3-unrecognized-encryption-plugin".to_string(),
        key_ref_requirement: Some(Xp3ProfileProofFixtureKeyRefRequirement {
            requirement_id: "kirikiri-xp3-key-profile".to_string(),
            secret_ref: SecretRef::new(
                "local-secret:fixture/kirikiri/xp3-archive-password".to_string(),
            )
            .unwrap(),
        }),
    });
    let report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(
        report.crypt_profile.status,
        Xp3CryptProfileStatus::UnknownPlugin
    );
    assert!(
        report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "xp3.crypt_profile.unknown_plugin")
    );
}

#[test]
fn xp3_profile_proof_byte_classification_mismatch_routes_by_bytes() {
    // A fixture that *declares* plain but supplies encrypted bytes
    // must be routed by the bytes (encrypted), never trusted into
    // a plain-patch claim. This protects the no-extract-claim
    // invariant against fixture-level under-classification.
    let dir = temp_dir("xp3-profile-proof-mismatch");
    write_xp3_archive(
        &dir,
        "fake-plain.xp3",
        &build_encrypted_xp3_marker_archive_bytes(),
    );
    let fixture = make_plain_fixture("fake-plain.xp3");
    let report = xp3_profile_proof(Xp3ProfileProofRequest {
        fixture: &fixture,
        fixture_dir: &dir,
    })
    .unwrap();
    assert_eq!(report.classification, Xp3ProfileClassification::Encrypted);
    assert_eq!(
        report.patch_capability_level,
        Xp3PatchCapabilityLevel::Unsupported
    );
    assert!(
        report
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "xp3.classification.mismatch")
    );
}
