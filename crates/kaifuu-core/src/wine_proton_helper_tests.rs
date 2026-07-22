use super::*;

fn request(
    adapter: WineProtonPlatformAdapter,
    availability: PlatformAvailability,
) -> WineProtonDryRunRequest {
    WineProtonDryRunRequest {
        schema_version: WINE_PROTON_HELPER_SCHEMA_VERSION.to_string(),
        fixture_id: "kaifuu-wine-proton-dry-run".to_string(),
        helper_binary_id: "kaifuu.fixture.wine-local-windows".to_string(),
        allowlist_entry_id: "kaifuu-fixture-wine-local-allowlist".to_string(),
        platform_adapter: adapter,
        profile_id: "019ed000-0000-7000-8000-profile00090".to_string(),
        redaction_policy: HelperRedactionPolicy::RedactRawLogsAndSecretRefs,
        platform_availability: availability,
        timeout_ms: 5000,
    }
}

#[test]
fn dry_run_names_five_required_fields_without_launching() {
    let resolution = resolve_wine_proton_dry_run(&request(
        WineProtonPlatformAdapter::WineLocal,
        PlatformAvailability::Available,
    ));

    // (1) helper-binary-id
    assert_eq!(
        resolution.helper_binary_id,
        "kaifuu.fixture.wine-local-windows"
    );
    // (2) platform-adapter
    assert_eq!(
        resolution.platform_adapter,
        WineProtonPlatformAdapter::WineLocal
    );
    // (3) intended-command (resolved shape)
    assert_eq!(resolution.intended_command.program_ref, "wine");
    assert!(
        resolution
            .intended_command
            .argument_template
            .contains(&"--dry-run".to_string())
    );
    // (4) profile-id
    assert_eq!(
        resolution.profile_id,
        "019ed000-0000-7000-8000-profile00090"
    );
    // (5) redaction-policy
    assert_eq!(
        resolution.redaction_policy,
        HelperRedactionPolicy::RedactRawLogsAndSecretRefs
    );

    // No launch.
    assert!(!resolution.launched);
    assert!(!resolution.intended_command.launches_untrusted_code);

    assert_eq!(resolution.validate().status, OperationStatus::Passed);
    assert_eq!(
        resolution.helper_result.diagnostic.code,
        HelperDiagnosticCode::HelperRequired
    );
    assert_eq!(
        resolution.helper_result.execution.mode,
        HelperResultExecutionMode::PlatformHelper
    );
    // Even the "platform helper" path never actually executed.
    assert_eq!(resolution.helper_result.execution.duration_ms, Some(0));
}

#[test]
fn proton_adapter_resolves_to_proton_launcher_ref() {
    let resolution = resolve_wine_proton_dry_run(&request(
        WineProtonPlatformAdapter::ProtonLocal,
        PlatformAvailability::Available,
    ));
    assert_eq!(resolution.intended_command.program_ref, "proton");
    assert_eq!(
        resolution.helper_result.execution.platform,
        "proton-local-windows"
    );
    assert_eq!(resolution.validate().status, OperationStatus::Passed);
}

#[test]
fn unavailable_platform_emits_typed_helper_unavailable_diagnostic() {
    let resolution = resolve_wine_proton_dry_run(&request(
        WineProtonPlatformAdapter::ProtonLocal,
        PlatformAvailability::Unavailable,
    ));

    assert_eq!(
        resolution.helper_result.diagnostic.code,
        HelperDiagnosticCode::HelperUnavailable
    );
    assert_eq!(
        resolution.helper_result.diagnostic.code.semantic_code(),
        SEMANTIC_HELPER_UNAVAILABLE
    );
    assert!(
        resolution
            .helper_result
            .diagnostic
            .message
            .contains(SEMANTIC_HELPER_UNAVAILABLE)
    );
    // Still resolves the intended command, still does not launch.
    assert!(!resolution.launched);
    assert_eq!(resolution.validate().status, OperationStatus::Passed);
}

#[test]
fn helper_result_conforms_to_kaifuu_085_and_carries_no_raw_secret() {
    let resolution = resolve_wine_proton_dry_run(&request(
        WineProtonPlatformAdapter::WineLocal,
        PlatformAvailability::Available,
    ));

    let helper_value = serde_json::to_value(&resolution.helper_result).unwrap();
    assert_eq!(
        validate_helper_result_value(&helper_value).status,
        OperationStatus::Passed
    );

    let serialized = resolution.stable_json().unwrap();
    // The execution object never carries a launch command.
    assert!(!serialized.contains("\"command\""));
    assert!(!serialized.contains("\"argv\""));
    assert!(!serialized.contains("\"env\""));
}

#[test]
fn resolution_carrying_raw_secret_material_fails_validation() {
    let mut resolution = resolve_wine_proton_dry_run(&request(
        WineProtonPlatformAdapter::WineLocal,
        PlatformAvailability::Available,
    ));
    // Inject clearly-fake 32-hex "recovered key" bytes into an otherwise
    // innocuous field: the deep-scan must reject it.
    resolution.helper_binary_id = "0123456789abcdef0123456789abcdef".to_string();

    let validation = resolution.validate();
    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation
            .failures
            .iter()
            .any(|failure| failure.code == SEMANTIC_WINE_PROTON_DRY_RUN_SECRET_LEAK)
    );
}

#[test]
fn resolution_asserting_launch_fails_validation() {
    let mut resolution = resolve_wine_proton_dry_run(&request(
        WineProtonPlatformAdapter::WineLocal,
        PlatformAvailability::Available,
    ));
    resolution.launched = true;

    let validation = resolution.validate();
    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation
            .failures
            .iter()
            .any(|failure| failure.code == SEMANTIC_WINE_PROTON_DRY_RUN_LAUNCH_FORBIDDEN)
    );
}

#[test]
fn resolution_round_trips_through_stable_json() {
    let resolution = resolve_wine_proton_dry_run(&request(
        WineProtonPlatformAdapter::WineLocal,
        PlatformAvailability::Available,
    ));
    let serialized = resolution.stable_json().unwrap();
    let parsed: WineProtonDryRunResolution = serde_json::from_str(&serialized).unwrap();
    assert_eq!(parsed.platform_adapter, resolution.platform_adapter);
    assert_eq!(parsed.helper_binary_id, resolution.helper_binary_id);
}
