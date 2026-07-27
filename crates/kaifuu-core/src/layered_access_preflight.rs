use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayeredAccessStage {
    Container,
    Crypto,
    Codec,
    PatchBack,
}

impl LayeredAccessStage {
    pub fn required_capability(self) -> Capability {
        match self {
            Self::Container => Capability::ContainerAccess,
            Self::Crypto => Capability::CryptoAccess,
            Self::Codec => Capability::CodecAccess,
            Self::PatchBack => Capability::PatchBack,
        }
    }

    pub fn missing_capability_error(self) -> SemanticErrorCode {
        match self {
            Self::Container => SemanticErrorCode::MissingContainerCapability,
            Self::Crypto => SemanticErrorCode::MissingCryptoCapability,
            Self::Codec => SemanticErrorCode::MissingCodecCapability,
            Self::PatchBack => SemanticErrorCode::MissingPatchBackCapability,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayeredAccessPreflightFailureKind {
    MissingCapability,
    UnsupportedTransform,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayeredAccessPreflightRequirement {
    pub stage: LayeredAccessStage,
    pub failure_kind: LayeredAccessPreflightFailureKind,
    pub asset_ref: Option<String>,
    pub transform_id: Option<String>,
    pub support_boundary: String,
    pub remediation: Option<String>,
}

impl LayeredAccessPreflightRequirement {
    pub fn missing_capability(
        stage: LayeredAccessStage,
        asset_ref: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self {
            stage,
            failure_kind: LayeredAccessPreflightFailureKind::MissingCapability,
            asset_ref: Some(asset_ref.into()),
            transform_id: None,
            support_boundary: support_boundary.into(),
            remediation: Some(remediation_for_layered_stage(stage).to_string()),
        }
    }

    pub fn unsupported_transform(
        stage: LayeredAccessStage,
        transform_id: impl Into<String>,
        asset_ref: impl Into<String>,
        support_boundary: impl Into<String>,
    ) -> Self {
        Self {
            stage,
            failure_kind: LayeredAccessPreflightFailureKind::UnsupportedTransform,
            asset_ref: Some(asset_ref.into()),
            transform_id: Some(transform_id.into()),
            support_boundary: support_boundary.into(),
            remediation: Some(
                "choose a supported layered transform or add a readiness profile before patching"
                    .to_string(),
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayeredAccessPreflightReport {
    pub schema_version: String,
    pub adapter_id: String,
    pub engine: String,
    pub detected_variant: String,
    pub status: OperationStatus,
    pub failures: Vec<AdapterFailure>,
}

impl LayeredAccessPreflightReport {
    pub fn from_requirements(
        adapter_id: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        requirements: Vec<LayeredAccessPreflightRequirement>,
    ) -> Self {
        let adapter_id = adapter_id.into();
        let engine = engine.into();
        let detected_variant = detected_variant.into();
        let failures = requirements
            .into_iter()
            .map(|requirement| {
                requirement.to_adapter_failure(&adapter_id, &engine, &detected_variant)
            })
            .collect::<Vec<_>>();
        Self {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            adapter_id,
            engine,
            detected_variant,
            status: if failures.is_empty() {
                OperationStatus::Passed
            } else {
                OperationStatus::Failed
            },
            failures,
        }
        .redacted_for_report()
    }

    pub fn redacted_for_report(&self) -> Self {
        let mut report = self.clone();
        report.adapter_id = redact_for_log_or_report(&report.adapter_id);
        report.engine = redact_for_log_or_report(&report.engine);
        report.detected_variant = redact_for_log_or_report(&report.detected_variant);
        report.failures = report
            .failures
            .iter()
            .map(AdapterFailure::redacted_for_report)
            .collect();
        report
    }

    pub fn stable_json(&self) -> KaifuuResult<String> {
        stable_json(&self.redacted_for_report())
    }

    pub fn from_access_profile(
        adapter_id: impl Into<String>,
        engine: impl Into<String>,
        detected_variant: impl Into<String>,
        capabilities: &AdapterCapabilities,
        access_profile: &LayeredAccessProfile,
    ) -> Self {
        let adapter_id = adapter_id.into();
        let engine = engine.into();
        let detected_variant = detected_variant.into();
        let supported_capabilities = capabilities
            .reports
            .iter()
            .filter(|report| {
                matches!(
                    report.status,
                    CapabilityStatus::Supported | CapabilityStatus::Limited
                )
            })
            .map(|report| report.capability.clone())
            .collect::<Vec<_>>();
        let patch_contract = capabilities
            .access_contract
            .as_ref()
            .map(|contract| &contract.patch);
        let mut failures = Vec::new();

        for surface in &access_profile.surfaces {
            for stage in [
                LayeredAccessStage::Container,
                LayeredAccessStage::Crypto,
                LayeredAccessStage::Codec,
                LayeredAccessStage::PatchBack,
            ] {
                if !supported_capabilities.contains(&stage.required_capability()) {
                    failures.push(
                        LayeredAccessPreflightRequirement::missing_capability(
                            stage,
                            &surface.surface_id,
                            format!(
                                "adapter capability report does not support {:?} for layered surface {}",
                                stage, surface.surface_id
                            ),
                        )
                        .to_adapter_failure(&adapter_id, &engine, &detected_variant),
                    );
                }
            }

            match patch_contract {
                Some(contract) => {
                    if !matches!(
                        contract.status,
                        CapabilityStatus::Supported | CapabilityStatus::Limited
                    ) {
                        failures.push(surface.patch_contract_status_failure(
                            contract,
                            &adapter_id,
                            &engine,
                            &detected_variant,
                        ));
                    }
                    surface.add_unsupported_transform_failures(
                        contract,
                        &adapter_id,
                        &engine,
                        &detected_variant,
                        &mut failures,
                    );
                }
                None if surface.requires_patch_access_contract() => {
                    surface.add_missing_patch_contract_failures(
                        &adapter_id,
                        &engine,
                        &detected_variant,
                        &mut failures,
                    );
                }
                None => {}
            }

            if surface.key_material_status == LayeredAccessKeyMaterialStatus::Missing {
                failures.push(AdapterFailure::missing_key_material(
                    &adapter_id,
                    &engine,
                    &detected_variant,
                    surface
                        .key_requirement_refs
                        .first()
                        .map_or(surface.surface_id.as_str(), String::as_str),
                    format!(
                        "layered surface {} requires crypto key material before patching",
                        surface.surface_id
                    ),
                ));
            }
            if surface.key_material_status == LayeredAccessKeyMaterialStatus::HelperGated
                || surface.helper_status == LayeredAccessHelperStatus::Unavailable
            {
                failures.push(AdapterFailure::helper_unavailable(
                    &adapter_id,
                    &engine,
                    &detected_variant,
                    format!(
                        "layered surface {} is helper-gated before patching",
                        surface.surface_id
                    ),
                ));
            }
        }

        Self {
            schema_version: PROFILE_SCHEMA_VERSION.to_string(),
            adapter_id,
            engine,
            detected_variant,
            status: if failures.is_empty() {
                OperationStatus::Passed
            } else {
                OperationStatus::Failed
            },
            failures,
        }
        .redacted_for_report()
    }
}
