use super::*;

pub trait EngineAdapter {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn capabilities(&self) -> AdapterCapabilities;
    fn detect(&self, request: DetectRequest<'_>) -> KaifuuResult<DetectionResult>;
    /// Whether this adapter wants an otherwise-undetected result routed back
    /// to it solely to produce a structured diagnostic. The default is false:
    /// a variant alone never promotes an adapter into diagnostic selection.
    fn is_diagnostic_candidate(&self, _detection: &DetectionResult) -> bool {
        false
    }
    fn profile(&self, request: ProfileRequest<'_>) -> KaifuuResult<GameProfile>;
    fn list_assets(&self, request: AssetListRequest<'_>) -> KaifuuResult<AssetList>;
    fn asset_inventory(
        &self,
        request: AssetInventoryRequest<'_>,
    ) -> KaifuuResult<AssetInventoryManifest>;
    fn extract(&self, request: ExtractRequest<'_>) -> KaifuuResult<ExtractionResult>;
    fn patch_preflight(&self, request: PatchPreflightRequest<'_>) -> KaifuuResult<PatchResult> {
        Ok(PatchResult::preflight_pass(request.patch_export))
    }
    fn patch(&self, request: PatchRequest<'_>) -> KaifuuResult<PatchResult>;
    fn verify(&self, request: VerifyRequest<'_>) -> KaifuuResult<VerificationResult>;
}

#[derive(Default)]
pub struct AdapterRegistry {
    adapters: Vec<Box<dyn EngineAdapter>>,
}

impl AdapterRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register<A>(&mut self, adapter: A)
    where
        A: EngineAdapter + 'static,
    {
        self.adapters.push(Box::new(adapter));
        self.adapters.sort_by_key(|adapter| adapter.id());
    }

    pub fn adapters(&self) -> &[Box<dyn EngineAdapter>] {
        &self.adapters
    }

    pub fn get(&self, adapter_id: &str) -> Option<&dyn EngineAdapter> {
        self.adapters
            .iter()
            .find(|adapter| adapter.id() == adapter_id)
            .map(Box::as_ref)
    }

    pub fn detect_all(&self, game_dir: &Path) -> KaifuuResult<Vec<DetectionResult>> {
        let mut results = Vec::new();
        for adapter in &self.adapters {
            let mut result = adapter.detect(DetectRequest { game_dir })?;
            result.normalize();
            results.push(result);
        }
        Ok(results)
    }

    pub fn detect(&self, game_dir: &Path) -> KaifuuResult<Option<DetectionResult>> {
        let mut best = None;
        for result in self.detect_all(game_dir)? {
            if result.detected {
                best = Some(result);
                break;
            }
        }
        Ok(best)
    }

    /// Selects the strongest diagnostic-only result from a registry detection
    /// pass. A diagnostic candidate is explicitly *not* a detected adapter:
    /// it is an adapter that **opts in** via
    /// [`EngineAdapter::is_diagnostic_candidate`] for an input it recognizes
    /// well enough to explain why profiling or inventory cannot proceed.
    /// Eligibility is adapter-owned opt-in (default false). The presence of
    /// `detected_variant` alone is never sufficient — variant strings are
    /// descriptive detection data, not a capability or consent marker.
    /// This selection never changes `DetectionResult::detected` or adapter
    /// capability declarations. Callers may use the selected adapter only to
    /// obtain its structured diagnostic; they must not treat it as supported
    /// for profile, extract, inventory, or patch operations.
    pub fn diagnostic_candidate_from_results(
        &self,
        detections: &[DetectionResult],
    ) -> Option<DetectionResult> {
        let mut best: Option<(usize, usize, DetectionResult)> = None;
        for detection in detections {
            if detection.detected
                || !self
                    .get(&detection.adapter_id)
                    .is_some_and(|adapter| adapter.is_diagnostic_candidate(detection))
            {
                continue;
            }

            let matched_evidence = detection
                .evidence
                .iter()
                .filter(|evidence| evidence.status == EvidenceStatus::Matched)
                .count();
            let diagnostic_evidence = detection
                .evidence
                .iter()
                .filter(|evidence| evidence.status != EvidenceStatus::Informational)
                .count();
            let score = (matched_evidence, diagnostic_evidence);

            // Registry detections are ordered by adapter id. Keeping the
            // first equal-scoring result makes the tie break deterministic.
            if best
                .as_ref()
                .is_none_or(|(best_matched, best_diagnostic, _)| {
                    score > (*best_matched, *best_diagnostic)
                })
            {
                best = Some((matched_evidence, diagnostic_evidence, detection.clone()));
            }
        }
        best.map(|(_, _, detection)| detection)
    }

    /// Runs detection and returns the best diagnostic-only candidate, if an
    /// adapter explicitly recognized an otherwise unsupported input.
    pub fn diagnostic_candidate(&self, game_dir: &Path) -> KaifuuResult<Option<DetectionResult>> {
        Ok(self.diagnostic_candidate_from_results(&self.detect_all(game_dir)?))
    }
}

#[derive(Clone, Copy)]
pub struct DetectRequest<'a> {
    pub game_dir: &'a Path,
}

#[derive(Clone, Copy)]
pub struct ProfileRequest<'a> {
    pub game_dir: &'a Path,
}

#[derive(Clone, Copy)]
pub struct AssetListRequest<'a> {
    pub game_dir: &'a Path,
}

#[derive(Clone, Copy)]
pub struct AssetInventoryRequest<'a> {
    pub game_dir: &'a Path,
}

#[derive(Clone, Copy)]
pub struct ExtractRequest<'a> {
    pub game_dir: &'a Path,
}

#[derive(Clone, Copy)]
pub struct PatchRequest<'a> {
    pub game_dir: &'a Path,
    pub patch_export: &'a PatchExport,
    pub output_dir: &'a Path,
}

#[derive(Clone, Copy)]
pub struct PatchPreflightRequest<'a> {
    pub game_dir: &'a Path,
    pub patch_export: &'a PatchExport,
}

#[derive(Clone, Copy)]
pub struct VerifyRequest<'a> {
    pub game_dir: &'a Path,
}
