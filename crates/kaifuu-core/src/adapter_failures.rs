use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterFailureSemanticParams {
    error_code: SemanticErrorCode,
    adapter: String,
    engine: Option<String>,
    detected_variant: Option<String>,
    asset_ref: Option<String>,
    required_capability: Option<Capability>,
    support_boundary: String,
    remediation: Option<String>,
}

impl AdapterFailureSemanticParams {
    pub fn new(
        error_code: SemanticErrorCode,
        adapter: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self {
            error_code,
            adapter: adapter.into(),
            engine: None,
            detected_variant: None,
            asset_ref: None,
            required_capability: None,
            support_boundary: support_boundary.into(),
            remediation: None,
        }
    }

    pub fn engine(mut self, engine: impl Into<String>) -> Self {
        self.engine = Some(engine.into());
        self
    }

    pub fn detected_variant(mut self, detected_variant: impl Into<String>) -> Self {
        self.detected_variant = Some(detected_variant.into());
        self
    }

    pub fn asset_ref(mut self, asset_ref: impl Into<String>) -> Self {
        self.asset_ref = Some(asset_ref.into());
        self
    }

    pub fn required_capability(mut self, required_capability: Capability) -> Self {
        self.required_capability = Some(required_capability);
        self
    }

    pub fn remediation(mut self, remediation: impl Into<String>) -> Self {
        self.remediation = Some(remediation.into());
        self
    }
}

impl AdapterFailure {
    pub fn semantic(params: AdapterFailureSemanticParams) -> Self {
        Self {
            error_code: params.error_code.to_string(),
            adapter: params.adapter,
            engine: params.engine,
            detected_variant: params.detected_variant,
            asset_ref: params.asset_ref,
            required_capability: params.required_capability,
            support_boundary: params.support_boundary,
            remediation: params.remediation,
        }
        .redacted_for_report()
    }

    pub fn redacted_for_report(&self) -> Self {
        Self {
            error_code: redact_for_log_or_report(&self.error_code),
            adapter: redact_for_log_or_report(&self.adapter),
            engine: self.engine.as_deref().map(redact_for_log_or_report),
            detected_variant: self
                .detected_variant
                .as_deref()
                .map(redact_for_log_or_report),
            asset_ref: self.asset_ref.as_deref().map(redact_asset_ref_for_report),
            required_capability: self.required_capability.clone(),
            support_boundary: redact_for_log_or_report(&self.support_boundary),
            remediation: self.remediation.as_deref().map(redact_for_log_or_report),
        }
    }

    pub fn is_preflight_blocking(&self) -> bool {
        matches!(
            self.error_code.as_str(),
            SEMANTIC_MISSING_KEY_PROFILE
                | SEMANTIC_MISSING_KEY_MATERIAL
                | SEMANTIC_HELPER_UNAVAILABLE
                | SEMANTIC_HELPER_REQUIRED
                | SEMANTIC_KEY_VALIDATION_FAILED
                | SEMANTIC_PROTECTED_EXECUTABLE_UNSUPPORTED
                | SEMANTIC_UNSUPPORTED_LAYERED_TRANSFORM
                | SEMANTIC_MISSING_CONTAINER_CAPABILITY
                | SEMANTIC_MISSING_CRYPTO_CAPABILITY
                | SEMANTIC_MISSING_CODEC_CAPABILITY
                | SEMANTIC_MISSING_PATCH_BACK_CAPABILITY
                | STRING_SLOT_OVERFLOW
                | STRING_SLOT_INVALID_ENCODING
                | STRING_SLOT_TERMINATOR_LOSS
                | STRING_SLOT_PROTECTED_SPAN_MUTATION
                | STRING_RELOCATION_UNRESOLVED_REFERENCE
                | STRING_RELOCATION_OVERLAPPING_WRITES
                | STRING_RELOCATION_UNSUPPORTED_POINTER_FORMAT
                | STRING_RELOCATION_POINTER_PROVENANCE_MISMATCH
        )
    }

    pub fn missing_key_profile(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::MissingKeyProfile,
                adapter,
                support_boundary,
            )
            .engine(engine)
            .detected_variant(detected_variant)
            .required_capability(Capability::KeyProfile)
            .remediation("provide a key profile that references local secret refs"),
        )
    }

    pub fn missing_key_material(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        requirement_id: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::MissingKeyMaterial,
                adapter,
                support_boundary,
            )
            .engine(engine)
            .detected_variant(detected_variant)
            .asset_ref(requirement_id)
            .required_capability(Capability::KeyProfile)
            .remediation(
                "resolve the referenced local secret material before extraction or patching",
            ),
        )
    }

    pub fn helper_unavailable(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::HelperUnavailable,
                adapter,
                support_boundary,
            )
            .engine(engine)
            .detected_variant(detected_variant)
            .required_capability(Capability::KeyProfile)
            .remediation(
                "run an available local helper or provide validated key material manually",
            ),
        )
    }

    pub fn key_validation_failed(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        requirement_id: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::KeyValidationFailed,
                adapter,
                support_boundary,
            )
            .engine(engine)
            .detected_variant(detected_variant)
            .asset_ref(requirement_id)
            .required_capability(Capability::KeyProfile)
            .remediation("replace or revalidate the local key material"),
        )
    }

    pub fn protected_executable_unsupported(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::ProtectedExecutableUnsupported,
                adapter,
                support_boundary,
            )
            .engine(engine)
            .detected_variant(detected_variant)
            .required_capability(Capability::KeyProfile)
            .remediation("use a helper that supports this protected executable boundary"),
        )
    }

    pub fn secret_redacted(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        asset_ref: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self::semantic(
            AdapterFailureSemanticParams::new(
                SemanticErrorCode::SecretRedacted,
                adapter,
                support_boundary,
            )
            .engine(engine)
            .detected_variant(detected_variant)
            .asset_ref(asset_ref)
            .remediation("inspect the redacted local-only evidence on the runner"),
        )
    }

    pub fn encoded_string_slot_preflight(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        asset_ref: impl Into<String>,
        diagnostic: EncodedStringSlotDiagnostic,
    ) -> Self {
        Self {
            error_code: diagnostic.code,
            adapter: adapter.into(),
            engine: Some(engine.into()),
            detected_variant: Some(detected_variant.into()),
            asset_ref: Some(asset_ref.into()),
            required_capability: Some(Capability::PatchBack),
            support_boundary: format!(
                "encoded string slot {} byte range {}..{} failed preflight: {}",
                diagnostic.slot_id,
                diagnostic.byte_range.start(),
                diagnostic.byte_range.end(),
                diagnostic.message
            ),
            remediation: Some(format!(
                "{}: {}",
                diagnostic.remediation_code, diagnostic.remediation
            )),
        }
        .redacted_for_report()
    }

    pub fn string_relocation_preflight(
        adapter: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        asset_ref: impl Into<String>,
        diagnostic: StringRelocationDiagnostic,
    ) -> Self {
        Self {
            error_code: diagnostic.code,
            adapter: adapter.into(),
            engine: Some(engine.into()),
            detected_variant: Some(detected_variant.into()),
            asset_ref: Some(asset_ref.into()),
            required_capability: Some(Capability::PatchBack),
            support_boundary: format!(
                "string relocation reference {} for slot {} failed preflight: {}",
                diagnostic.reference_id.as_deref().unwrap_or("unresolved"),
                diagnostic.slot_id.as_deref().unwrap_or("unresolved"),
                diagnostic.message
            ),
            remediation: Some(format!(
                "{}: {}",
                diagnostic.remediation_code, diagnostic.remediation
            )),
        }
        .redacted_for_report()
    }
}

impl PatchResult {
    pub fn preflight_pass(patch_export: &PatchExport) -> Self {
        Self {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            patch_result_id: deterministic_id("patch-preflight", 0),
            patch_export_id: patch_export.patch_export_id.clone(),
            status: OperationStatus::Passed,
            output_hash: content_hash("patch preflight passed without output"),
            failures: vec![],
        }
    }

    pub fn redacted_for_report(&self) -> Self {
        let mut result = self.clone();
        result.patch_result_id = redact_for_log_or_report(&result.patch_result_id);
        result.patch_export_id = redact_for_log_or_report(&result.patch_export_id);
        result.output_hash = redact_for_log_or_report(&result.output_hash);
        result.failures = result
            .failures
            .iter()
            .map(AdapterFailure::redacted_for_report)
            .collect();
        result
    }

    pub fn has_preflight_blocking_failure(&self) -> bool {
        self.failures
            .iter()
            .any(AdapterFailure::is_preflight_blocking)
    }

    pub fn failure_codes(&self) -> Vec<String> {
        self.failures
            .iter()
            .map(|failure| failure.error_code.clone())
            .collect()
    }
}

impl VerificationResult {
    pub fn redacted_for_report(&self) -> Self {
        let mut result = self.clone();
        result.patch_result_id = redact_for_log_or_report(&result.patch_result_id);
        result.output_hash = redact_for_log_or_report(&result.output_hash);
        result.failures = result
            .failures
            .iter()
            .map(AdapterFailure::redacted_for_report)
            .collect();
        result
    }
}
