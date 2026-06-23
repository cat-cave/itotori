//! Capability-leveled engine detector registry (KAIFUU-053).
//!
//! The `capability` submodule defines the typed 4-rung ladder
//! (`CapabilityLevel`, `CapabilityLevelStatus`, `AdapterCapabilityMatrix`).
//! This module adds the registry-side query API that layers on top of the
//! existing `AdapterRegistry` defined in the crate root: `level_for`,
//! `adapters_supporting`, `adapters_at_least`, and `matrices`.

pub mod capability;

pub use capability::{AdapterCapabilityMatrix, CapabilityLevel, CapabilityLevelStatus};

use crate::{AdapterRegistry, EngineAdapter};

impl AdapterRegistry {
    /// Returns the typed status for `adapter_id` at `level`. `None` if the
    /// adapter is not registered.
    pub fn level_for(
        &self,
        adapter_id: &str,
        level: CapabilityLevel,
    ) -> Option<CapabilityLevelStatus> {
        let adapter = self.get(adapter_id)?;
        Some(adapter.capabilities().level_matrix.get(level).clone())
    }

    /// Returns all adapters whose status at `level` is **strictly**
    /// `Supported`. Adapters with `Partial` or `Unsupported` at this rung
    /// are excluded — that is the whole point of KAIFUU-053.
    pub fn adapters_supporting(&self, level: CapabilityLevel) -> Vec<&dyn EngineAdapter> {
        self.adapters()
            .iter()
            .map(Box::as_ref)
            .filter(|adapter| adapter.capabilities().level_matrix.supports(level))
            .collect()
    }

    /// Returns all adapters whose status at **every** rung at or below
    /// `level` is `Supported`. Useful for "at least Extract"-style gates.
    pub fn adapters_at_least(&self, level: CapabilityLevel) -> Vec<&dyn EngineAdapter> {
        self.adapters()
            .iter()
            .map(Box::as_ref)
            .filter(|adapter| adapter.capabilities().level_matrix.supports_at_least(level))
            .collect()
    }

    /// Returns the declared matrix for every registered adapter, sorted by
    /// adapter id (the existing `register` implementation already keeps
    /// adapters sorted).
    pub fn matrices(&self) -> Vec<AdapterCapabilityMatrix> {
        self.adapters()
            .iter()
            .map(|adapter| adapter.capabilities().level_matrix)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AdapterCapabilities, AssetInventoryManifest, AssetInventoryRequest, AssetList,
        AssetListRequest, Capability, CapabilityReport, DetectRequest, DetectionResult,
        ExtractRequest, ExtractionResult, GameProfile, KaifuuResult, PatchRequest, PatchResult,
        ProfileRequest, VerificationResult, VerifyRequest,
    };

    struct FakeAdapter {
        id: &'static str,
        matrix: AdapterCapabilityMatrix,
    }

    impl FakeAdapter {
        fn new(id: &'static str, matrix: AdapterCapabilityMatrix) -> Self {
            Self { id, matrix }
        }
    }

    impl EngineAdapter for FakeAdapter {
        fn id(&self) -> &'static str {
            self.id
        }

        fn name(&self) -> &'static str {
            "fake"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(
                self.id,
                vec![
                    CapabilityReport::supported(Capability::Detection),
                    CapabilityReport::supported(Capability::AssetListing),
                    CapabilityReport::supported(Capability::AssetInventory),
                    CapabilityReport::supported(Capability::Extraction),
                    CapabilityReport::supported(Capability::Patching),
                ],
            )
            .with_level_matrix(self.matrix.clone())
        }

        fn detect(&self, _: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            unimplemented!()
        }
        fn profile(&self, _: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            unimplemented!()
        }
        fn list_assets(&self, _: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            unimplemented!()
        }
        fn asset_inventory(
            &self,
            _: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            unimplemented!()
        }
        fn extract(&self, _: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            unimplemented!()
        }
        fn patch(&self, _: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            unimplemented!()
        }
        fn verify(&self, _: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            unimplemented!()
        }
    }

    fn registry_with_three_levels() -> AdapterRegistry {
        let identify_only =
            AdapterCapabilityMatrix::identify_only("kaifuu.identify_only", "detector-only fixture");
        let up_to_inventory = AdapterCapabilityMatrix::up_to(
            "kaifuu.up_to_inventory",
            CapabilityLevel::Inventory,
            "no extract path",
        );
        let full = AdapterCapabilityMatrix::new(
            "kaifuu.full",
            CapabilityLevelStatus::supported(),
            CapabilityLevelStatus::supported(),
            CapabilityLevelStatus::supported(),
            CapabilityLevelStatus::supported(),
        );
        let mut registry = AdapterRegistry::new();
        registry.register(FakeAdapter::new("kaifuu.identify_only", identify_only));
        registry.register(FakeAdapter::new("kaifuu.up_to_inventory", up_to_inventory));
        registry.register(FakeAdapter::new("kaifuu.full", full));
        registry
    }

    #[test]
    fn adapters_supporting_extract_excludes_identify_and_inventory_only_adapters() {
        let registry = registry_with_three_levels();
        let extract = registry.adapters_supporting(CapabilityLevel::Extract);
        let ids: Vec<&str> = extract.iter().map(|a| a.id()).collect();
        assert_eq!(ids, vec!["kaifuu.full"]);
    }

    #[test]
    fn adapters_supporting_identify_includes_identify_only_adapters() {
        let registry = registry_with_three_levels();
        let identify = registry.adapters_supporting(CapabilityLevel::Identify);
        let ids: Vec<&str> = identify.iter().map(|a| a.id()).collect();
        assert_eq!(
            ids,
            vec![
                "kaifuu.full",
                "kaifuu.identify_only",
                "kaifuu.up_to_inventory",
            ]
        );
    }

    #[test]
    fn adapters_supporting_partial_extract_still_excludes_them() {
        // Strict gate: Partial at Extract is NOT counted as Supported.
        let partial = AdapterCapabilityMatrix::new(
            "kaifuu.partial_extract",
            CapabilityLevelStatus::supported(),
            CapabilityLevelStatus::supported(),
            CapabilityLevelStatus::partial(["only some surfaces"]),
            CapabilityLevelStatus::unsupported("no patch"),
        );
        let mut registry = AdapterRegistry::new();
        registry.register(FakeAdapter::new("kaifuu.partial_extract", partial));
        assert!(
            registry
                .adapters_supporting(CapabilityLevel::Extract)
                .is_empty()
        );
        assert_eq!(
            registry
                .adapters_supporting(CapabilityLevel::Inventory)
                .len(),
            1
        );
    }

    #[test]
    fn level_for_returns_typed_status() {
        let registry = registry_with_three_levels();
        let identify = registry
            .level_for("kaifuu.identify_only", CapabilityLevel::Identify)
            .expect("registered adapter");
        assert!(identify.is_supported());
        let patch = registry
            .level_for("kaifuu.identify_only", CapabilityLevel::Patch)
            .expect("registered adapter");
        assert!(patch.is_unsupported());
        assert!(
            registry
                .level_for("kaifuu.unknown", CapabilityLevel::Identify)
                .is_none()
        );
    }

    #[test]
    fn matrices_returns_one_per_adapter_sorted_by_id() {
        let registry = registry_with_three_levels();
        let ids: Vec<String> = registry
            .matrices()
            .into_iter()
            .map(|m| m.adapter_id)
            .collect();
        assert_eq!(
            ids,
            vec![
                "kaifuu.full".to_string(),
                "kaifuu.identify_only".to_string(),
                "kaifuu.up_to_inventory".to_string(),
            ]
        );
    }
}
