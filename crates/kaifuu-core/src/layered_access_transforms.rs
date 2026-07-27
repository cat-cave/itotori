use super::*;

impl LayeredTextSurfaceAccess {
    pub(crate) fn requires_patch_access_contract(&self) -> bool {
        !matches!(
            self.surface_transform,
            SurfaceTransform::Identity | SurfaceTransform::JsonPointer
        ) || !matches!(
            self.container,
            ContainerTransform::Identity | ContainerTransform::LooseFile
        ) || !matches!(self.crypto, CryptoTransform::NullKey)
            || !matches!(
                self.codec,
                CodecTransform::Identity | CodecTransform::JsonText
            )
            || !matches!(
                self.patch_back,
                PatchBackTransform::Identity | PatchBackTransform::RewriteJson
            )
            || !matches!(
                self.key_material_status,
                LayeredAccessKeyMaterialStatus::NotRequired
                    | LayeredAccessKeyMaterialStatus::Resolved
            )
            || !matches!(
                self.helper_status,
                LayeredAccessHelperStatus::NotRequired | LayeredAccessHelperStatus::Available
            )
    }

    pub(crate) fn add_missing_patch_contract_failures(
        &self,
        adapter_id: &str,
        engine: &str,
        detected_variant: &str,
        failures: &mut Vec<AdapterFailure>,
    ) {
        let support_boundary =
            "patch access contract is required before patching non-identity layered transforms";
        if !matches!(
            self.surface_transform,
            SurfaceTransform::Identity | SurfaceTransform::JsonPointer
        ) {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::Container,
                format!("{:?}", self.surface_transform),
                support_boundary,
                adapter_id,
                engine,
                detected_variant,
            ));
        }
        if !matches!(
            self.container,
            ContainerTransform::Identity | ContainerTransform::LooseFile
        ) {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::Container,
                format!("{:?}", self.container),
                support_boundary,
                adapter_id,
                engine,
                detected_variant,
            ));
        }
        if !matches!(self.crypto, CryptoTransform::NullKey) {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::Crypto,
                format!("{:?}", self.crypto),
                support_boundary,
                adapter_id,
                engine,
                detected_variant,
            ));
        }
        if !matches!(
            self.codec,
            CodecTransform::Identity | CodecTransform::JsonText
        ) {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::Codec,
                format!("{:?}", self.codec),
                support_boundary,
                adapter_id,
                engine,
                detected_variant,
            ));
        }
        if !matches!(
            self.patch_back,
            PatchBackTransform::Identity | PatchBackTransform::RewriteJson
        ) {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::PatchBack,
                format!("{:?}", self.patch_back),
                support_boundary,
                adapter_id,
                engine,
                detected_variant,
            ));
        }
    }

    pub(crate) fn patch_contract_status_failure(
        &self,
        contract: &LayeredAccessOperationContract,
        adapter_id: &str,
        engine: &str,
        detected_variant: &str,
    ) -> AdapterFailure {
        let support_boundary = contract
            .support_boundary
            .as_deref()
            .unwrap_or("patch access contract status does not permit preparing patched output");
        LayeredAccessPreflightRequirement::missing_capability(
            LayeredAccessStage::PatchBack,
            &self.surface_id,
            format!(
                "{support_boundary}; patch access contract status: {:?}",
                contract.status
            ),
        )
        .to_adapter_failure(adapter_id, engine, detected_variant)
    }

    pub(crate) fn add_unsupported_transform_failures(
        &self,
        contract: &LayeredAccessOperationContract,
        adapter_id: &str,
        engine: &str,
        detected_variant: &str,
        failures: &mut Vec<AdapterFailure>,
    ) {
        if !contract
            .supported_surfaces
            .contains(&self.surface_transform)
        {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::Container,
                format!("{:?}", self.surface_transform),
                "surface transform is not supported by the patch access contract",
                adapter_id,
                engine,
                detected_variant,
            ));
        }
        if !contract.supported_containers.contains(&self.container) {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::Container,
                format!("{:?}", self.container),
                "container transform is not supported by the patch access contract",
                adapter_id,
                engine,
                detected_variant,
            ));
        }
        if !contract.supported_crypto.contains(&self.crypto) {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::Crypto,
                format!("{:?}", self.crypto),
                "crypto transform is not supported by the patch access contract",
                adapter_id,
                engine,
                detected_variant,
            ));
        }
        if !contract.supported_codecs.contains(&self.codec) {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::Codec,
                format!("{:?}", self.codec),
                "codec transform is not supported by the patch access contract",
                adapter_id,
                engine,
                detected_variant,
            ));
        }
        if !contract.supported_patch_back.contains(&self.patch_back) {
            failures.push(self.unsupported_transform_failure(
                LayeredAccessStage::PatchBack,
                format!("{:?}", self.patch_back),
                "patch-back transform is not supported by the patch access contract",
                adapter_id,
                engine,
                detected_variant,
            ));
        }
    }

    pub(crate) fn unsupported_transform_failure(
        &self,
        stage: LayeredAccessStage,
        transform_id: String,
        support_boundary: impl Into<String>,
        adapter_id: &str,
        engine: &str,
        detected_variant: &str,
    ) -> AdapterFailure {
        LayeredAccessPreflightRequirement::unsupported_transform(
            stage,
            transform_id,
            &self.surface_id,
            support_boundary,
        )
        .to_adapter_failure(adapter_id, engine, detected_variant)
    }
}

impl LayeredAccessPreflightRequirement {
    pub(crate) fn to_adapter_failure(
        &self,
        adapter: &str,
        engine: &str,
        detected_variant: &str,
    ) -> AdapterFailure {
        let mut params = AdapterFailureSemanticParams::new(
            match self.failure_kind {
                LayeredAccessPreflightFailureKind::MissingCapability => {
                    self.stage.missing_capability_error()
                }
                LayeredAccessPreflightFailureKind::UnsupportedTransform => {
                    SemanticErrorCode::UnsupportedLayeredTransform
                }
            },
            adapter,
            &self.support_boundary,
        )
        .engine(engine)
        .detected_variant(detected_variant)
        .required_capability(self.stage.required_capability());
        if let Some(asset_ref) = &self.asset_ref {
            params = params.asset_ref(asset_ref);
        }
        if let Some(remediation) = &self.remediation {
            params = params.remediation(remediation);
        }
        if let Some(transform_id) = &self.transform_id {
            params = params.remediation(format!(
                "{}; unsupported transform: {}",
                self.remediation
                    .as_deref()
                    .unwrap_or("add layered access support"),
                redact_for_log_or_report(transform_id)
            ));
        }
        AdapterFailure::semantic(params)
    }
}

pub(crate) fn remediation_for_layered_stage(stage: LayeredAccessStage) -> &'static str {
    match stage {
        LayeredAccessStage::Container => {
            "provide a supported container/archive transform before extraction or patching"
        }
        LayeredAccessStage::Crypto => {
            "provide supported crypto parameters and resolved key material before extraction or patching"
        }
        LayeredAccessStage::Codec => {
            "provide a supported codec/decompile transform before normalizing text"
        }
        LayeredAccessStage::PatchBack => {
            "provide a supported patch-back transform before writing patched output"
        }
    }
}
