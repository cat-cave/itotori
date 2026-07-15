use super::super::*;

// identity/null-key-only capability annotation.

#[test]
fn identity_or_null_key_only_report_carries_explicit_limitation_and_marker() {
    // A container/crypto/codec/patch capability that only works at the
    // identity/null-key rung must be Supported (it works) BUT explicitly
    // annotated so a consumer cannot over-read it as broad transform
    // support.
    for capability in [
        Capability::ContainerAccess,
        Capability::CryptoAccess,
        Capability::CodecAccess,
        Capability::PatchBack,
    ] {
        let report = CapabilityReport::identity_or_null_key_only(capability.clone());
        assert_eq!(report.status, CapabilityStatus::Supported);
        assert!(report.is_identity_or_null_key_only());
        assert_eq!(
            report.limitation.as_deref(),
            Some(IDENTITY_OR_NULL_KEY_ONLY_LIMITATION)
        );
        assert!(capability.is_transform_bearing());
    }
}

#[test]
fn plain_supported_report_does_not_falsely_claim_identity_or_null_key_only() {
    // A report claiming genuine broad support must NOT carry the marker,
    // so a consumer can distinguish it from identity/null-key-only.
    let broad = CapabilityReport::supported(Capability::CryptoAccess);
    assert!(!broad.is_identity_or_null_key_only());
    assert!(broad.limitation.is_none());

    let annotated = CapabilityReport::identity_or_null_key_only(Capability::CryptoAccess);
    assert_ne!(
        broad.is_identity_or_null_key_only(),
        annotated.is_identity_or_null_key_only()
    );
}

#[test]
fn identity_or_null_key_marker_serializes_only_when_true() {
    let plain = CapabilityReport::supported(Capability::ContainerAccess);
    let plain_json = serde_json::to_value(&plain).expect("serialize");
    assert!(
        plain_json.get("identityOrNullKeyOnly").is_none(),
        "false marker must be skipped so existing payloads round-trip unchanged"
    );

    let annotated = CapabilityReport::identity_or_null_key_only(Capability::ContainerAccess);
    let annotated_json = serde_json::to_value(&annotated).expect("serialize");
    assert_eq!(
        annotated_json["identityOrNullKeyOnly"],
        serde_json::json!(true)
    );
    let round: CapabilityReport = serde_json::from_value(annotated_json).expect("deserialize");
    assert_eq!(round, annotated);
}

#[test]
fn into_identity_or_null_key_only_annotates_and_states_boundary() {
    let annotated =
        CapabilityReport::supported(Capability::PatchBack).into_identity_or_null_key_only();
    assert!(annotated.is_identity_or_null_key_only());
    assert_eq!(
        annotated.limitation.as_deref(),
        Some(IDENTITY_OR_NULL_KEY_ONLY_LIMITATION)
    );
}

#[test]
fn plaintext_identity_operation_contract_is_identity_or_null_key_only() {
    let contract = LayeredAccessCapabilityContract::plaintext_identity();
    assert!(
        contract.is_identity_or_null_key_only(),
        "the plaintext-identity contract declares no broader transform support"
    );
}

#[test]
fn contract_with_real_transform_is_not_identity_or_null_key_only() {
    // A real archive container + non-null crypto is a genuine broader
    // transform — distinguishable from the identity/null-key rung.
    let mut op = LayeredAccessOperationContract::supported_identity(vec![Capability::Extraction]);
    assert!(op.is_identity_or_null_key_only());
    op.supported_containers.push(ContainerTransform::Xp3);
    op.supported_crypto.push(CryptoTransform::KeyProfile);
    assert!(!op.is_identity_or_null_key_only());
}

#[test]
fn adapter_overread_detector_flags_unannotated_supported_transform_reports() {
    // No access contract + a plain Supported CryptoAccess report ->
    // over-read risk a consumer can catch.
    let reports = vec![
        CapabilityReport::supported(Capability::Detection),
        CapabilityReport::supported(Capability::CryptoAccess),
    ];
    let matrix = AdapterCapabilityMatrix::identify_only("kaifuu.overread", "detector-only");
    let caps = AdapterCapabilities::new("kaifuu.overread", reports, matrix);
    assert!(!caps.declares_broader_transform_support());
    assert_eq!(
        caps.identity_or_null_key_overreads(),
        vec![Capability::CryptoAccess]
    );
}

#[test]
fn adapter_overread_detector_clears_when_annotated_or_backed_by_broader_support() {
    let matrix = AdapterCapabilityMatrix::identify_only("kaifuu.honest", "detector-only");

    // Annotated identity/null-key-only -> no over-read.
    let annotated = AdapterCapabilities::new(
        "kaifuu.honest",
        vec![
            CapabilityReport::supported(Capability::Detection),
            CapabilityReport::identity_or_null_key_only(Capability::CryptoAccess),
        ],
        matrix.clone(),
    );
    assert!(annotated.identity_or_null_key_overreads().is_empty());

    // Backed by a broader (real-transform) access contract -> no over-read,
    // and the plain Supported report is understood as genuine broad support.
    let mut broad_contract = LayeredAccessCapabilityContract::plaintext_identity();
    broad_contract
        .extract
        .supported_crypto
        .push(CryptoTransform::KeyProfile);
    broad_contract
        .extract
        .supported_containers
        .push(ContainerTransform::Xp3);
    let broad = AdapterCapabilities::new(
        "kaifuu.honest",
        vec![
            CapabilityReport::supported(Capability::Detection),
            CapabilityReport::supported(Capability::CryptoAccess),
        ],
        matrix,
    )
    .with_access_contract(broad_contract);
    assert!(broad.declares_broader_transform_support());
    assert!(broad.identity_or_null_key_overreads().is_empty());
}

#[test]
fn validator_permits_supported_limitation_only_with_identity_marker() {
    // Supported + limitation + marker=true -> valid (the path).
    let ok = serde_json::json!({
        "capability": "crypto_access",
        "status": "supported",
        "limitation": IDENTITY_OR_NULL_KEY_ONLY_LIMITATION,
        "identityOrNullKeyOnly": true,
    });
    let mut failures = Vec::new();
    validate_capability_report(&mut failures, Some(&ok), "capabilities[0]");
    assert!(failures.is_empty(), "unexpected failures: {failures:?}");

    // Supported + limitation but NO marker -> still rejected (over-read
    // guard: a silent free-text limitation on a Supported report).
    let bad = serde_json::json!({
        "capability": "crypto_access",
        "status": "supported",
        "limitation": "reads encrypted archives",
    });
    let mut failures = Vec::new();
    validate_capability_report(&mut failures, Some(&bad), "capabilities[0]");
    assert!(
        failures
            .iter()
            .any(|f| f.code == "unexpected_capability_limitation"),
        "expected unexpected_capability_limitation, got {failures:?}"
    );
}

#[test]
fn validator_requires_marker_to_be_supported_with_a_limitation() {
    // marker=true but status!= supported -> rejected.
    let bad_status = serde_json::json!({
        "capability": "crypto_access",
        "status": "limited",
        "limitation": "x",
        "identityOrNullKeyOnly": true,
    });
    let mut failures = Vec::new();
    validate_capability_report(&mut failures, Some(&bad_status), "c");
    assert!(
        failures
            .iter()
            .any(|f| f.code == "invalid_identity_or_null_key_marker"),
        "got {failures:?}"
    );

    // marker=true but no limitation -> rejected (must state the boundary).
    let bad_missing = serde_json::json!({
        "capability": "crypto_access",
        "status": "supported",
        "identityOrNullKeyOnly": true,
    });
    let mut failures = Vec::new();
    validate_capability_report(&mut failures, Some(&bad_missing), "c");
    assert!(
        failures
            .iter()
            .any(|f| f.code == "missing_identity_or_null_key_limitation"),
        "got {failures:?}"
    );
}
