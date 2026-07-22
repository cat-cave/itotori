use super::*;

fn request(availability: PlatformAvailability) -> NativeWindowsDryRunRequest {
    NativeWindowsDryRunRequest {
        schema_version: NATIVE_WINDOWS_HELPER_SCHEMA_VERSION.to_string(),
        fixture_id: "kaifuu-native-windows-dry-run".to_string(),
        helper_binary_id: "kaifuu.fixture.native-windows-local".to_string(),
        allowlist_entry_id: "kaifuu-fixture-native-windows-local-allowlist".to_string(),
        platform_adapter: NativeWindowsPlatformAdapter::NativeWindowsLocal,
        profile_id: "019ed000-0000-7000-8000-profile00129".to_string(),
        redaction_policy: HelperRedactionPolicy::RedactRawLogsAndSecretRefs,
        platform_availability: availability,
        timeout_ms: 5000,
    }
}

#[test]
fn dry_run_records_six_required_fields_without_launching() {
    let resolution = resolve_native_windows_dry_run(&request(PlatformAvailability::Available));

    // (1) platform-adapter
    assert_eq!(
        resolution.platform_adapter,
        NativeWindowsPlatformAdapter::NativeWindowsLocal
    );
    assert_eq!(resolution.platform_adapter_id, "native-windows");
    // (2) helper-binary-id
    assert_eq!(
        resolution.helper_binary_id,
        "kaifuu.fixture.native-windows-local"
    );
    // (3) command-argv (+ quoted command line)
    assert_eq!(
        resolution.intended_command.program_ref,
        "native-windows-helper"
    );
    assert!(
        resolution
            .intended_command
            .argument_template
            .contains(&"--dry-run".to_string())
    );
    assert_eq!(
        resolution.intended_command.quoting_rules,
        "CommandLineToArgvW"
    );
    assert!(
        resolution
            .intended_command
            .command_line
            .starts_with("native-windows-helper --platform native-windows-local")
    );
    // (4) working-directory-policy
    assert_eq!(
        resolution.intended_command.working_directory_policy,
        "sandboxed-read-only-game-copy"
    );
    // (5) profile-id
    assert_eq!(
        resolution.profile_id,
        "019ed000-0000-7000-8000-profile00129"
    );
    // (6) redaction-policy
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
fn unavailable_platform_emits_typed_helper_unavailable_diagnostic() {
    let resolution = resolve_native_windows_dry_run(&request(PlatformAvailability::Unavailable));

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
    let resolution = resolve_native_windows_dry_run(&request(PlatformAvailability::Available));

    let helper_value = serde_json::to_value(&resolution.helper_result).unwrap();
    assert_eq!(
        validate_helper_result_value(&helper_value).status,
        OperationStatus::Passed
    );
    // Native local Windows path: WineLocalWindowsHelper + WindowsLocal +
    // PlatformHelper (the native-Windows seam).
    assert_eq!(
        resolution.helper_result.helper.helper_kind,
        HelperKind::WineLocalWindowsHelper
    );
    assert_eq!(
        resolution.helper_result.capability_level,
        HelperCapabilityLevel::WindowsLocal
    );

    let serialized = resolution.stable_json().unwrap();
    // The execution object never carries a launch command; the
    // quoted descriptor lives under `commandLine`, not `command`/`argv`/`env`.
    assert!(!serialized.contains("\"command\""));
    assert!(!serialized.contains("\"argv\""));
    assert!(!serialized.contains("\"env\""));
    assert!(serialized.contains("\"commandLine\""));
}

#[test]
fn resolution_carrying_raw_secret_material_fails_validation() {
    let mut resolution = resolve_native_windows_dry_run(&request(PlatformAvailability::Available));
    // Inject clearly-fake 32-hex "recovered key" bytes into an otherwise
    // innocuous field: the deep-scan must reject it.
    resolution.helper_binary_id = "0123456789abcdef0123456789abcdef".to_string();

    let validation = resolution.validate();
    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation
            .failures
            .iter()
            .any(|failure| failure.code == SEMANTIC_NATIVE_WINDOWS_DRY_RUN_SECRET_LEAK)
    );
}

#[test]
fn resolution_carrying_local_path_fails_validation() {
    let mut resolution = resolve_native_windows_dry_run(&request(PlatformAvailability::Available));
    // A Windows drive-letter absolute path must be rejected by the deep-scan
    // regardless of which field it hides in.
    resolution.intended_command.working_directory_policy =
        "C:\\Games\\Private\\game.exe".to_string();

    let validation = resolution.validate();
    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation
            .failures
            .iter()
            .any(|failure| failure.code == SEMANTIC_NATIVE_WINDOWS_DRY_RUN_SECRET_LEAK)
    );
}

#[test]
fn resolution_asserting_launch_fails_validation() {
    let mut resolution = resolve_native_windows_dry_run(&request(PlatformAvailability::Available));
    resolution.launched = true;

    let validation = resolution.validate();
    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation
            .failures
            .iter()
            .any(|failure| failure.code == SEMANTIC_NATIVE_WINDOWS_DRY_RUN_LAUNCH_FORBIDDEN)
    );
}

#[test]
fn resolution_round_trips_through_stable_json() {
    let resolution = resolve_native_windows_dry_run(&request(PlatformAvailability::Available));
    let serialized = resolution.stable_json().unwrap();
    let parsed: NativeWindowsDryRunResolution = serde_json::from_str(&serialized).unwrap();
    assert_eq!(parsed.platform_adapter, resolution.platform_adapter);
    assert_eq!(parsed.helper_binary_id, resolution.helper_binary_id);
    assert_eq!(
        parsed.intended_command.command_line,
        resolution.intended_command.command_line
    );
}

#[test]
fn windows_quoting_matches_command_line_to_argv_rules() {
    // Canonical CommandLineToArgvW quoting expectations.
    assert_eq!(windows_quote_argument("plain"), "plain");
    assert_eq!(
        windows_quote_argument("arg with spaces"),
        "\"arg with spaces\""
    );
    assert_eq!(windows_quote_argument("say \"hi\""), "\"say \\\"hi\\\"\"");
    assert_eq!(
        windows_quote_argument("share\\folder name"),
        "\"share\\folder name\""
    );
    assert_eq!(
        windows_quote_argument("ends with backslash\\"),
        "\"ends with backslash\\\\\""
    );
    assert_eq!(
        windows_quote_argument("bs before quote\\\""),
        "\"bs before quote\\\\\\\"\""
    );
}

#[test]
fn windows_quoting_fixture_round_trips_every_case() {
    let fixture = resolve_windows_command_line_quoting_fixture();
    assert_eq!(fixture.quoting_rules, "CommandLineToArgvW");
    assert!(!fixture.launches_untrusted_code);
    assert!(!fixture.cases.is_empty());

    // Each case: raw quotes to the recorded form and parses back to raw.
    for case in &fixture.cases {
        assert_eq!(windows_quote_argument(&case.raw), case.quoted);
        assert_eq!(
            windows_command_line_to_argv(&case.quoted),
            vec![case.raw.clone()]
        );
    }
    // The joined command line parses back to every raw argument in order.
    let raw_args: Vec<String> = fixture.cases.iter().map(|case| case.raw.clone()).collect();
    assert_eq!(
        windows_command_line_to_argv(&fixture.command_line),
        raw_args
    );

    assert_eq!(fixture.validate().status, OperationStatus::Passed);
}

#[test]
fn intended_command_line_parses_back_to_argv() {
    let resolution = resolve_native_windows_dry_run(&request(PlatformAvailability::Available));
    let mut expected = vec![resolution.intended_command.program_ref.clone()];
    expected.extend(
        resolution
            .intended_command
            .argument_template
            .iter()
            .cloned(),
    );
    assert_eq!(
        windows_command_line_to_argv(&resolution.intended_command.command_line),
        expected
    );
}

#[test]
fn quoting_fixture_with_tampered_quote_fails_validation() {
    let mut fixture = resolve_windows_command_line_quoting_fixture();
    // Corrupt a quoted form so it no longer matches CommandLineToArgvW.
    fixture.cases[1].quoted = "arg with spaces".to_string();
    let validation = fixture.validate();
    assert_eq!(validation.status, OperationStatus::Failed);
    assert!(
        validation
            .failures
            .iter()
            .any(|failure| failure.code == SEMANTIC_NATIVE_WINDOWS_QUOTING_NOT_REVERSIBLE)
    );
}
