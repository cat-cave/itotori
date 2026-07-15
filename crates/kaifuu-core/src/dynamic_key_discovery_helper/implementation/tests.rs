#[cfg(test)]
mod tests {
    use super::super::super::{
        HelperRedactionPolicy, KeyMaterialKind, SEMANTIC_DYNAMIC_KEY_HELPER_LAUNCH_FORBIDDEN,
        SEMANTIC_DYNAMIC_KEY_HELPER_SECRET_LEAK,
    };
    use super::super::*;
    use crate::OperationStatus;

    fn request() -> DynamicKeyDiscoveryRequest {
        DynamicKeyDiscoveryRequest {
            schema_version: DYNAMIC_KEY_DISCOVERY_HELPER_SCHEMA_VERSION.to_string(),
            fixture_id: "kaifuu-dynamic-key-discovery".to_string(),
            helper_binary_id: "kaifuu.fixture.remote-dynamic-key-helper".to_string(),
            allowlist_entry_id: "kaifuu-fixture-dynamic-key-allowlist".to_string(),
            requirement_id: "dyn-key-req-065".to_string(),
            scan_target: "process-image:fixture-adv-runtime".to_string(),
            material_kind: KeyMaterialKind::FixedBytes,
            profile_id: "019ed000-0000-7000-8000-profile00065".to_string(),
            redaction_policy: HelperRedactionPolicy::RedactRawLogsAndSecretRefs,
            timeout_ms: 5000,
        }
    }

    #[test]
    fn helper_disabled_by_default() {
        // Default mode is public-fixture, which is disabled.
        assert_eq!(
            HelperInvocationMode::default(),
            HelperInvocationMode::PublicFixture
        );
        assert!(!HelperInvocationMode::default().helper_enabled());
        assert!(!HelperInvocationMode::PublicFixture.helper_enabled());
        assert!(!HelperInvocationMode::Ci.helper_enabled());
        assert!(HelperInvocationMode::LiveOptIn.helper_enabled());
    }

    #[test]
    fn ci_and_public_fixture_modes_refuse_with_typed_diagnostic() {
        for mode in [
            HelperInvocationMode::PublicFixture,
            HelperInvocationMode::Ci,
        ] {
            let outcome = attempt_dynamic_key_discovery(&request(), mode);
            assert!(outcome.is_refused(), "{mode:?} must refuse");
            let refusal = outcome
                .refusal()
                .expect("refused outcome carries a refusal");
            // Typed diagnostic naming the disabled-in-mode semantic code.
            assert_eq!(
                refusal.diagnostic.code,
                SEMANTIC_DYNAMIC_KEY_HELPER_DISABLED
            );
            // No response, no launch.
            assert!(!refusal.launched_untrusted_code);
            // The nested helper result denies authorization and carries no secret.
            assert_eq!(
                refusal.helper_result.diagnostic.code,
                HelperDiagnosticCode::HelperAuthorizationDenied
            );
            assert!(refusal.helper_result.secret_refs.is_empty());
            assert!(refusal.helper_result.proof_hashes.is_empty());
            assert_eq!(refusal.validate().status, OperationStatus::Passed);
        }
    }

    #[test]
    fn live_opt_in_enables_and_resolves_ref_plus_proof() {
        let outcome = attempt_dynamic_key_discovery(&request(), HelperInvocationMode::LiveOptIn);
        assert!(outcome.is_resolved());
        let response = outcome
            .response()
            .expect("resolved outcome carries a response");

        // The response carries a secret REF and a sha256 PROOF hash — never a key.
        assert!(
            response
                .discovered_secret_ref
                .as_str()
                .starts_with("local-secret:")
        );
        assert!(response.proof.proof_hash.as_str().starts_with("sha256:"));
        // No launch, ever.
        assert!(!response.launched_untrusted_code);
        // The nested helper result is a valid remote-helper success.
        assert_eq!(
            response.helper_result.helper.helper_kind,
            HelperKind::RemoteWindowsHelper
        );
        assert_eq!(
            response.helper_result.execution.mode,
            HelperResultExecutionMode::RemoteHelper
        );
        assert_eq!(response.validate().status, OperationStatus::Passed);
    }

    #[test]
    fn request_carries_only_refs_no_raw_key_material() {
        // The request type has no field for a raw key; a valid request passes.
        assert_eq!(request().validate().status, OperationStatus::Passed);

        // Serialized request contains no raw key-like material anywhere.
        let serialized = request().stable_json().unwrap();
        assert!(!serialized.contains("\"rawKey\""));
        assert!(!serialized.contains("\"key\""));

        // Smuggling raw 32-hex key bytes through the scan target is rejected.
        let mut tampered = request();
        tampered.scan_target = "0123456789abcdef0123456789abcdef".to_string();
        let validation = tampered.validate();
        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation
                .failures
                .iter()
                .any(|failure| failure.code == SEMANTIC_DYNAMIC_KEY_HELPER_SECRET_LEAK)
        );
    }

    #[test]
    fn response_carrying_raw_key_material_fails_validation() {
        let outcome = attempt_dynamic_key_discovery(&request(), HelperInvocationMode::LiveOptIn);
        let mut response = outcome.response().unwrap().clone();
        // Inject clearly-fake 32-hex "recovered key" bytes into an innocuous
        // field: the deep-scan must reject it.
        response.requirement_id = "0123456789abcdef0123456789abcdef".to_string();

        let validation = response.validate();
        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation
                .failures
                .iter()
                .any(|failure| failure.code == SEMANTIC_DYNAMIC_KEY_HELPER_SECRET_LEAK)
        );
    }

    #[test]
    fn response_asserting_launch_fails_validation() {
        let outcome = attempt_dynamic_key_discovery(&request(), HelperInvocationMode::LiveOptIn);
        let mut response = outcome.response().unwrap().clone();
        response.launched_untrusted_code = true;

        let validation = response.validate();
        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation
                .failures
                .iter()
                .any(|failure| failure.code == SEMANTIC_DYNAMIC_KEY_HELPER_LAUNCH_FORBIDDEN)
        );
    }

    #[test]
    fn response_serializes_no_launch_command_fields() {
        let outcome = attempt_dynamic_key_discovery(&request(), HelperInvocationMode::LiveOptIn);
        let serialized = outcome.response().unwrap().stable_json().unwrap();
        // The boundary never serializes a launch command / argv / env.
        assert!(!serialized.contains("\"command\""));
        assert!(!serialized.contains("\"argv\""));
        assert!(!serialized.contains("\"env\""));
    }

    #[test]
    fn tier_reference_declares_continuous_and_keeps_pure_adapters_helper_free() {
        let reference = dynamic_key_helper_tier_reference();
        assert_eq!(reference.validate().status, OperationStatus::Passed);

        // Exactly one continuous-tier engine, and it references the helper.
        let continuous: Vec<_> = reference.continuous_adapters().collect();
        assert_eq!(continuous.len(), 1);
        assert!(continuous[0].references_helper());
        assert_eq!(continuous[0].engine_id, "runtime-scanned-key-adv");

        // Every named pure static adapter is present, pure, and helper-free.
        for engine_id in PURE_ADAPTER_ENGINE_IDS {
            let entry = reference
                .entries
                .iter()
                .find(|entry| entry.engine_id == engine_id)
                .unwrap_or_else(|| panic!("{engine_id} must be present"));
            assert_eq!(entry.dependency, AdapterHelperDependency::Pure);
            assert!(
                !entry.references_helper(),
                "{engine_id} must not depend on the helper"
            );
        }
    }

    #[test]
    fn pure_adapter_referencing_helper_fails_validation() {
        let mut reference = dynamic_key_helper_tier_reference();
        // Make a pure adapter depend on the remote helper: the law forbids it.
        let reallive = reference
            .entries
            .iter_mut()
            .find(|entry| entry.engine_id == "reallive")
            .unwrap();
        reallive.helper_binary_id = Some("kaifuu.fixture.remote-dynamic-key-helper".to_string());

        let validation = reference.validate();
        assert_eq!(validation.status, OperationStatus::Failed);
        assert!(
            validation
                .failures
                .iter()
                .any(|failure| failure.code == SEMANTIC_DYNAMIC_KEY_HELPER_PURE_ADAPTER_DEPENDENCY)
        );
    }

    #[test]
    fn artifacts_round_trip_through_stable_json() {
        let outcome = attempt_dynamic_key_discovery(&request(), HelperInvocationMode::LiveOptIn);
        let response = outcome.response().unwrap();
        let serialized = response.stable_json().unwrap();
        let parsed: DynamicKeyDiscoveryResponse = serde_json::from_str(&serialized).unwrap();
        assert_eq!(parsed.requirement_id, response.requirement_id);
        assert_eq!(
            parsed.discovered_secret_ref.as_str(),
            response.discovered_secret_ref.as_str()
        );

        let reference = dynamic_key_helper_tier_reference();
        let reference_json = reference.stable_json().unwrap();
        let parsed_reference: DynamicKeyHelperTierReference =
            serde_json::from_str(&reference_json).unwrap();
        assert_eq!(parsed_reference.entries, reference.entries);
    }
}
