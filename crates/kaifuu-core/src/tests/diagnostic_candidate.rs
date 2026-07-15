use super::*;

/// P1: an undetected adapter that supplies `detected_variant`
/// without overriding [`EngineAdapter::is_diagnostic_candidate`] must not
/// become a diagnostic candidate, and profile/inventory must never run.
#[test]
fn diagnostic_candidate_requires_adapter_opt_in_not_variant_presence() {
    struct VariantOnlyAdapter {
        profile_calls: Arc<AtomicUsize>,
        inventory_calls: Arc<AtomicUsize>,
    }

    impl EngineAdapter for VariantOnlyAdapter {
        fn id(&self) -> &'static str {
            "kaifuu.test.variant-only-no-opt-in"
        }

        fn name(&self) -> &'static str {
            "Variant-only adapter without diagnostic opt-in"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(self.id(), vec![], derived_matrix_for(self.id(), &[]))
        }

        fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            Ok(DetectionResult {
                adapter_id: self.id().to_string(),
                detected: false,
                engine_family: Some("decoy".to_string()),
                engine_version: None,
                // Descriptive variant alone must NOT grant diagnostic routing.
                detected_variant: Some("looks-like-mine".to_string()),
                evidence: vec![DetectionEvidence {
                    path: "decoy.marker".to_string(),
                    kind: "variant_only_marker".to_string(),
                    status: EvidenceStatus::Matched,
                    detail: "undetected adapter with a variant string".to_string(),
                }],
                requirements: vec![],
                capabilities: vec![],
            })
        }

        // Default is_diagnostic_candidate → false (no opt-in).

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            self.profile_calls.fetch_add(1, Ordering::SeqCst);
            panic!("profile must not run for non-opted-in diagnostic candidates");
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            unreachable!("list_assets must not run")
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            self.inventory_calls.fetch_add(1, Ordering::SeqCst);
            panic!("asset_inventory must not run for non-opted-in diagnostic candidates");
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            unreachable!("extract must not run")
        }

        fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            unreachable!("patch must not run")
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            unreachable!("verify must not run")
        }
    }

    let profile_calls = Arc::new(AtomicUsize::new(0));
    let inventory_calls = Arc::new(AtomicUsize::new(0));
    let mut registry = AdapterRegistry::new();
    registry.register(VariantOnlyAdapter {
        profile_calls: Arc::clone(&profile_calls),
        inventory_calls: Arc::clone(&inventory_calls),
    });

    let detections = registry
        .detect_all(Path::new("/tmp/variant-only"))
        .expect("detect_all");
    assert_eq!(detections.len(), 1);
    assert!(!detections[0].detected);
    assert_eq!(
        detections[0].detected_variant.as_deref(),
        Some("looks-like-mine")
    );

    // Selection must refuse: variant presence is not opt-in.
    assert!(
        registry
            .diagnostic_candidate_from_results(&detections)
            .is_none(),
        "undetected adapter with detected_variant but no opt-in must stay off the diagnostic path"
    );
    assert!(
        registry
            .diagnostic_candidate(Path::new("/tmp/variant-only"))
            .expect("diagnostic_candidate")
            .is_none()
    );

    // Never invoke profile/inventory just because a variant string appeared.
    assert_eq!(profile_calls.load(Ordering::SeqCst), 0);
    assert_eq!(inventory_calls.load(Ordering::SeqCst), 0);
}

/// adapters that opt in via `is_diagnostic_candidate` are
/// selectable even when `detected` is false.
#[test]
fn diagnostic_candidate_selects_opted_in_adapter() {
    struct OptInDiagnosticAdapter;

    impl EngineAdapter for OptInDiagnosticAdapter {
        fn id(&self) -> &'static str {
            "kaifuu.test.diagnostic-opt-in"
        }

        fn name(&self) -> &'static str {
            "Opted-in diagnostic adapter"
        }

        fn capabilities(&self) -> AdapterCapabilities {
            AdapterCapabilities::new(self.id(), vec![], derived_matrix_for(self.id(), &[]))
        }

        fn detect(&self, _request: DetectRequest<'_>) -> KaifuuResult<DetectionResult> {
            Ok(DetectionResult {
                adapter_id: self.id().to_string(),
                detected: false,
                engine_family: None,
                engine_version: None,
                detected_variant: Some("partial-pair".to_string()),
                evidence: vec![DetectionEvidence {
                    path: "partial.marker".to_string(),
                    kind: "diagnostic_marker".to_string(),
                    status: EvidenceStatus::Matched,
                    detail: "recognized incomplete fixture".to_string(),
                }],
                requirements: vec![],
                capabilities: vec![],
            })
        }

        fn is_diagnostic_candidate(&self, detection: &DetectionResult) -> bool {
            !detection.detected && detection.detected_variant.as_deref() == Some("partial-pair")
        }

        fn profile(&self, _request: ProfileRequest<'_>) -> KaifuuResult<GameProfile> {
            unreachable!()
        }

        fn list_assets(&self, _request: AssetListRequest<'_>) -> KaifuuResult<AssetList> {
            unreachable!()
        }

        fn asset_inventory(
            &self,
            _request: AssetInventoryRequest<'_>,
        ) -> KaifuuResult<AssetInventoryManifest> {
            unreachable!()
        }

        fn extract(&self, _request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult> {
            unreachable!()
        }

        fn patch(&self, _request: PatchRequest<'_>) -> KaifuuResult<PatchResult> {
            unreachable!()
        }

        fn verify(&self, _request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult> {
            unreachable!()
        }
    }

    let mut registry = AdapterRegistry::new();
    registry.register(OptInDiagnosticAdapter);
    let candidate = registry
        .diagnostic_candidate(Path::new("/tmp/opt-in"))
        .expect("diagnostic_candidate")
        .expect("opted-in adapter must be selected");
    assert_eq!(candidate.adapter_id, "kaifuu.test.diagnostic-opt-in");
    assert!(!candidate.detected);
    assert_eq!(candidate.detected_variant.as_deref(), Some("partial-pair"));
}
